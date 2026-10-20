/**
 * The community bank's client (docs/specs/community-v1.md §4.1): one method per route of the
 * Worker, every failure a `CommunityError` with a sentence the panel shows as is. Requests carry
 * the Access cookie and never follow redirects, so an expired session reads as "signed out".
 */
import type { SamplerId } from '../audio/instruments';

export type ShareState = 'pending' | 'listed' | 'unlisted' | 'rejected';

export interface Share {
  state: ShareState;
  reason: string | null;
  shared_at: string;
  listed_at: string | null;
  unlisted_at: string | null;
}

export interface OwnSample {
  id: string;
  name: string;
  tags: string[];
  bytes: number;
  type: string;
  duration: number;
  channels: 1 | 2;
  root: number;
  created_at: string;
  share: Share | null;
  refs: number;
}

export interface CommunitySample {
  id: string;
  name: string;
  tags: string[];
  bytes: number;
  duration: number;
  channels: 1 | 2;
  root: number;
  owner: string;
  listed_at: string;
  own: boolean;
}

export interface QueueItem extends Omit<CommunitySample, 'listed_at'> {
  listed_at: string | null;
  state: ShareState;
  shared_at: string;
  owner_id: string;
}

export interface CommunityPage {
  samples: CommunitySample[];
  next: string | null;
}

export interface Me {
  handle: string;
  maintainer: boolean;
}

export interface UploadMeta {
  name: string;
  /** Seconds. */
  duration: number;
  channels: 1 | 2;
  root: number;
  sha256: string;
  /** One of the accepted audio types (`uploadType`). */
  type: string;
}

export type Decision = { action: 'list' } | { action: 'reject'; reason: RejectReason };

/** Rejection categories and what the owner reads (docs/specs/community-v1.md §2). */
export const REJECT_LABELS = {
  speech: 'speech',
  sexual: 'sexual content',
  violence: 'violence or distress',
  hate: 'hate',
  copyright: 'someone else’s recording',
  loudness: 'too loud or clipping',
  quality: 'silent, empty or broken',
  personal: 'personal data',
  other: 'other',
} as const;
export type RejectReason = keyof typeof REJECT_LABELS;
export const REJECT_REASONS = Object.keys(REJECT_LABELS) as RejectReason[];

/** The label of a rejection category (unknown ones as they are). */
export function rejectLabel(reason: string | null): string {
  if (reason === null) return 'not accepted';
  return (REJECT_LABELS as Record<string, string>)[reason] ?? reason;
}

/** What sharing grants, ticked per share (docs/specs/community-v1.md §6, docs/DATA.md). */
export const LICENCE_TEXT =
  'I made this sound or own the rights to it, and I let every user of Croky Chords use it in ' +
  'their songs, also commercially, for ever. I can unshare it; whoever already has it keeps it.';

export type CommunityErrorKind = 'offline' | 'signed-out' | 'rejected' | 'server';

export class CommunityError extends Error {
  readonly kind: CommunityErrorKind;
  readonly code: string | null;

  constructor(kind: CommunityErrorKind, message: string, code: string | null = null) {
    super(message);
    this.name = 'CommunityError';
    this.kind = kind;
    this.code = code;
  }
}

/** What the panel says for an error code of the API. */
const MESSAGES: Record<string, string> = {
  sample_limit_reached: 'You have reached the limit of 50 samples or 100 MB on the server.',
  not_listed: 'This sample is no longer in the community bank.',
  share_rejected: 'This sample was not accepted for the community bank.',
  payload_too_large: 'The file is larger than 10 MB.',
  unsupported_media_type: 'Only wav, ogg, flac and mp3 files can be shared.',
  not_found: 'The sample is not on the server any more.',
  forbidden: 'This is for the maintainer only.',
};

export const SIGNED_OUT_MESSAGE = 'Sign in again to use the community bank (reload the page).';
export const OFFLINE_MESSAGE = 'You are offline; the community bank needs the network.';

/** The accepted upload type for a stored sample's type or file name, or null. */
export function uploadType(type: string, name: string): string | null {
  const t = type.toLowerCase();
  if (/^audio\/(x-|vnd\.)?wave?$/.test(t)) return 'audio/wav';
  if (t === 'audio/ogg' || t === 'audio/flac' || t === 'audio/mpeg') return t;
  if (t === 'audio/x-flac') return 'audio/flac';
  if (t === 'audio/mp3') return 'audio/mpeg';
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  const byExt: Record<string, string> = {
    wav: 'audio/wav',
    wave: 'audio/wav',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    flac: 'audio/flac',
    mp3: 'audio/mpeg',
  };
  return ext === undefined ? null : (byExt[ext] ?? null);
}

/** Hex SHA-256 of `bytes` (Web Crypto). */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface CommunityClient {
  me(): Promise<Me>;
  setHandle(handle: string | null): Promise<string>;
  mine(): Promise<OwnSample[]>;
  upload(bytes: ArrayBuffer, meta: UploadMeta): Promise<OwnSample>;
  remove(id: string): Promise<void>;
  /** Needs the licence acknowledgement of docs/specs/community-v1.md §6. */
  share(id: string, options: { licence: true; name?: string; tags?: string[] }): Promise<OwnSample>;
  unshare(id: string): Promise<OwnSample>;
  browse(options: { q?: string; tag?: string; cursor?: string | null }): Promise<CommunityPage>;
  take(id: string, slot: SamplerId): Promise<CommunitySample>;
  bytes(id: string): Promise<ArrayBuffer>;
  queue(): Promise<QueueItem[]>;
  decide(id: string, decision: Decision): Promise<QueueItem>;
  /** URL of a sample's bytes (the review page's player). */
  sampleUrl(id: string): string;
}

export interface CommunityResponse {
  readonly status: number;
  readonly type: string;
  readonly redirected: boolean;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type CommunityFetch = (url: string, init: RequestInit) => Promise<CommunityResponse>;

export interface HttpCommunityOptions {
  /** API base without a trailing slash, e.g. `/api`. */
  baseUrl: string;
  fetch: CommunityFetch;
  online?: () => boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function malformed(what: string): CommunityError {
  return new CommunityError('server', `The server sent a malformed ${what}.`);
}

const str = (v: unknown): v is string => typeof v === 'string';
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const tags = (v: unknown): v is string[] => Array.isArray(v) && v.every(str);
const STATES: readonly ShareState[] = ['pending', 'listed', 'unlisted', 'rejected'];
const state = (v: unknown): v is ShareState => STATES.some((s) => s === v);

function parseShare(v: unknown): Share | null {
  if (v === null) return null;
  if (
    isRecord(v) &&
    state(v['state']) &&
    strOrNull(v['reason']) &&
    str(v['shared_at']) &&
    strOrNull(v['listed_at']) &&
    strOrNull(v['unlisted_at'])
  ) {
    return {
      state: v['state'],
      reason: v['reason'],
      shared_at: v['shared_at'],
      listed_at: v['listed_at'],
      unlisted_at: v['unlisted_at'],
    };
  }
  throw malformed('share');
}

interface SampleCore {
  id: string;
  name: string;
  tags: string[];
  bytes: number;
  duration: number;
  channels: 1 | 2;
  root: number;
}

function parseCore(v: Record<string, unknown>, what: string): SampleCore {
  const { id, name, bytes, duration, root } = v;
  if (str(id) && str(name) && tags(v['tags']) && num(bytes) && num(duration) && num(root)) {
    return {
      id,
      name,
      tags: v['tags'],
      bytes,
      duration,
      channels: v['channels'] === 2 ? 2 : 1,
      root,
    };
  }
  throw malformed(what);
}

export function parseOwnSample(v: unknown): OwnSample {
  if (!isRecord(v)) throw malformed('sample');
  const core = parseCore(v, 'sample');
  const { type, created_at, refs } = v;
  if (!str(type) || !str(created_at) || !num(refs)) throw malformed('sample');
  return { ...core, type, created_at, share: parseShare(v['share']), refs };
}

export function parseCommunitySample(v: unknown): CommunitySample {
  if (!isRecord(v)) throw malformed('sample');
  const core = parseCore(v, 'sample');
  const { owner, listed_at, own } = v;
  if (!str(owner) || !str(listed_at) || typeof own !== 'boolean') throw malformed('sample');
  return { ...core, owner, listed_at, own };
}

export function parseQueueItem(v: unknown): QueueItem {
  if (!isRecord(v)) throw malformed('queue item');
  const core = parseCore(v, 'queue item');
  const { owner, listed_at, own, shared_at, owner_id } = v;
  if (
    !str(owner) ||
    !strOrNull(listed_at) ||
    typeof own !== 'boolean' ||
    !state(v['state']) ||
    !str(shared_at) ||
    !str(owner_id)
  ) {
    throw malformed('queue item');
  }
  return { ...core, owner, listed_at, own, state: v['state'], shared_at, owner_id };
}

function field(body: unknown, key: string): unknown {
  return isRecord(body) ? body[key] : undefined;
}

export class HttpCommunityClient implements CommunityClient {
  readonly #base: string;
  readonly #fetch: CommunityFetch;
  readonly #online: () => boolean;

  constructor(options: HttpCommunityOptions) {
    this.#base = options.baseUrl.replace(/\/+$/, '');
    this.#fetch = options.fetch;
    this.#online = options.online ?? (() => true);
  }

  async me(): Promise<Me> {
    const body = await this.#json('GET', '/me');
    const handle = field(body, 'handle');
    if (!str(handle)) throw malformed('profile');
    return { handle, maintainer: field(body, 'maintainer') === true };
  }

  async setHandle(handle: string | null): Promise<string> {
    const body = await this.#json('PUT', '/me/handle', { handle });
    const value = field(body, 'handle');
    if (!str(value)) throw malformed('profile');
    return value;
  }

  async mine(): Promise<OwnSample[]> {
    const samples = field(await this.#json('GET', '/samples'), 'samples');
    if (!Array.isArray(samples)) throw malformed('sample list');
    return samples.map(parseOwnSample);
  }

  async upload(bytes: ArrayBuffer, meta: UploadMeta): Promise<OwnSample> {
    const query = new URLSearchParams({
      name: meta.name.slice(0, 64),
      duration: String(Math.round(meta.duration * 1000) / 1000),
      channels: String(meta.channels),
      root: String(meta.root),
      sha256: meta.sha256,
    });
    const body = await this.#json('POST', `/samples?${query.toString()}`, undefined, {
      bytes,
      type: meta.type,
    });
    return parseOwnSample(field(body, 'sample'));
  }

  async remove(id: string): Promise<void> {
    await this.#json('DELETE', this.#sample(id));
  }

  async share(
    id: string,
    options: { licence: true; name?: string; tags?: string[] },
  ): Promise<OwnSample> {
    const body = await this.#json('POST', `${this.#sample(id)}/share`, options);
    return parseOwnSample(field(body, 'sample'));
  }

  async unshare(id: string): Promise<OwnSample> {
    const body = await this.#json('DELETE', `${this.#sample(id)}/share`);
    return parseOwnSample(field(body, 'sample'));
  }

  async browse(options: {
    q?: string;
    tag?: string;
    cursor?: string | null;
  }): Promise<CommunityPage> {
    const query = new URLSearchParams();
    if (options.q !== undefined && options.q.trim() !== '') query.set('q', options.q.trim());
    if (options.tag !== undefined && options.tag.trim() !== '') {
      query.set('tag', options.tag.trim().toLowerCase());
    }
    if (options.cursor !== undefined && options.cursor !== null)
      query.set('cursor', options.cursor);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    const body = await this.#json('GET', `/community${suffix}`);
    const samples = field(body, 'samples');
    const next = field(body, 'next');
    if (!Array.isArray(samples) || !strOrNull(next)) throw malformed('page');
    return { samples: samples.map(parseCommunitySample), next };
  }

  async take(id: string, slot: SamplerId): Promise<CommunitySample> {
    const body = await this.#json('POST', `${this.#sample(id)}/take`, { slot });
    return parseCommunitySample(field(body, 'sample'));
  }

  async bytes(id: string): Promise<ArrayBuffer> {
    const response = await this.#request('GET', this.#sample(id));
    if (response.status !== 200) throw await this.#failure(response);
    return response.arrayBuffer();
  }

  async queue(): Promise<QueueItem[]> {
    const items = field(await this.#json('GET', '/moderation/queue'), 'items');
    if (!Array.isArray(items)) throw malformed('queue');
    return items.map(parseQueueItem);
  }

  async decide(id: string, decision: Decision): Promise<QueueItem> {
    const body = await this.#json('POST', `/moderation/${encodeURIComponent(id)}`, decision);
    return parseQueueItem(field(body, 'item'));
  }

  sampleUrl(id: string): string {
    return this.#base + this.#sample(id);
  }

  #sample(id: string): string {
    return `/samples/${encodeURIComponent(id)}`;
  }

  async #json(
    method: string,
    path: string,
    json?: unknown,
    raw?: { bytes: ArrayBuffer; type: string },
  ): Promise<unknown> {
    const response = await this.#request(method, path, json, raw);
    if (response.status === 204) return null;
    if (response.status < 200 || response.status >= 300) throw await this.#failure(response);
    if (!(response.headers.get('Content-Type') ?? '').includes('application/json')) {
      throw new CommunityError('server', 'The server answered with something unexpected.');
    }
    try {
      return await response.json();
    } catch {
      throw new CommunityError('server', 'The server sent invalid JSON.');
    }
  }

  async #request(
    method: string,
    path: string,
    json?: unknown,
    raw?: { bytes: ArrayBuffer; type: string },
  ): Promise<CommunityResponse> {
    if (!this.#online()) throw new CommunityError('offline', OFFLINE_MESSAGE);
    const headers: Record<string, string> = { Accept: 'application/json' };
    let body: BodyInit | undefined;
    if (raw !== undefined) {
      headers['Content-Type'] = raw.type;
      body = raw.bytes;
    } else if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    let response: CommunityResponse;
    try {
      response = await this.#fetch(this.#base + path, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        credentials: 'include',
        redirect: 'manual',
        cache: 'no-store',
      });
    } catch {
      throw new CommunityError('offline', 'The server cannot be reached.');
    }
    const { status } = response;
    if (
      response.type === 'opaqueredirect' ||
      response.redirected ||
      (status >= 300 && status < 400)
    ) {
      throw new CommunityError('signed-out', SIGNED_OUT_MESSAGE);
    }
    return response;
  }

  async #failure(response: CommunityResponse): Promise<CommunityError> {
    const { status } = response;
    let code: string | null = null;
    let message: string | null = null;
    if ((response.headers.get('Content-Type') ?? '').includes('application/json')) {
      try {
        const error = field(await response.json(), 'error');
        const c = field(error, 'code');
        const m = field(error, 'message');
        if (str(c)) code = c;
        if (str(m)) message = m;
      } catch {
        // An unreadable error body: classified by its status below.
      }
    }
    if (
      status === 401 ||
      (status === 403 && code !== 'sample_limit_reached' && code !== 'forbidden')
    ) {
      return new CommunityError('signed-out', SIGNED_OUT_MESSAGE, code);
    }
    if (status >= 500 || status === 429 || code === null) {
      return new CommunityError(
        'server',
        `The server failed (HTTP ${status}); try again later.`,
        code,
      );
    }
    const text = MESSAGES[code] ?? (message === null ? `HTTP ${status}` : capitalise(message));
    return new CommunityError('rejected', text, code);
  }
}

function capitalise(text: string): string {
  const t = text.trim();
  const sentence = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

/** The message of any error, for one status line. */
export function communityMessage(e: unknown): string {
  if (e instanceof CommunityError) return e.message;
  return e instanceof Error ? e.message : String(e);
}
