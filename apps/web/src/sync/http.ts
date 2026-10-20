/**
 * HttpSyncClient: the SyncClient against the Worker API (docs/specs/api-v1.md, docs/specs/sync-v1.md,
 * "Failures"). Requests carry the Access cookie and never follow redirects, so an expired session
 * reads as "signed out" instead of a network failure.
 */
import type { SaveRecord } from '../store/record';
import {
  SaveRecordError,
  VersionConflictError,
  isValidSaveId,
  parseSaveRecord,
} from '../store/record';
import type { SaveMeta, SyncClient, SyncResult } from '../store/sync';
import { SyncError } from '../store/sync';

/** `SyncError.code` for one remote record that does not parse; the sync skips just that save. */
export const INVALID_RECORD = 'invalid_record';

/** The slice of `Response` the client reads; a real Response satisfies it. */
export interface ResponseLike {
  readonly status: number;
  readonly type: string;
  readonly redirected: boolean;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<ResponseLike>;

export interface HttpSyncClientOptions {
  /** API base without a trailing slash, e.g. `/api`. */
  baseUrl: string;
  fetch: FetchLike;
  /** `navigator.onLine`; false skips the request and reports offline. */
  online?: () => boolean;
}

interface ApiError {
  code: string | null;
  message: string;
  current: SaveMeta | null | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate one `SaveMeta` from the list; throws a `server` SyncError when malformed. */
export function parseSaveMeta(value: unknown): SaveMeta {
  if (isRecord(value)) {
    const { id, version, updated_at, title } = value;
    if (
      typeof id === 'string' &&
      isValidSaveId(id) &&
      typeof version === 'number' &&
      Number.isSafeInteger(version) &&
      version >= 1 &&
      typeof updated_at === 'string' &&
      typeof title === 'string'
    ) {
      return { id, version, updated_at, title };
    }
  }
  throw new SyncError('server', 'malformed save metadata from the server');
}

function parseApiError(body: unknown): ApiError {
  const error = isRecord(body) ? body['error'] : undefined;
  if (!isRecord(error)) return { code: null, message: 'unexpected response', current: undefined };
  const code = typeof error['code'] === 'string' ? error['code'] : null;
  const message = typeof error['message'] === 'string' ? error['message'] : (code ?? 'error');
  const raw = error['current'];
  const current = raw === undefined ? undefined : raw === null ? null : parseSaveMeta(raw);
  return { code, message, current };
}

function remoteRecord(body: unknown): SaveRecord {
  try {
    return parseSaveRecord(body);
  } catch (e) {
    if (e instanceof SaveRecordError) {
      throw new SyncError('server', `malformed save from the server: ${e.message}`, INVALID_RECORD);
    }
    throw e;
  }
}

/** Statuses an edge or WAF in front of the API may answer for one request (not the session). */
const EDGE_RECORD_STATUSES = new Set([404, 413, 415]);

/**
 * Classify a non-JSON answer (an HTML page from Access, the edge or a WAF) by its status, so only
 * a real session problem reads as "signed out" (docs/specs/sync-v1.md, "Failures").
 */
export function edgeFailure(status: number, method: string, perRecord: boolean): SyncError {
  if (status === 401 || status === 403) {
    return new SyncError('signed-out', `HTTP ${status}: the sign-in session is missing`);
  }
  if (perRecord && EDGE_RECORD_STATUSES.has(status)) {
    const message = `HTTP ${status} from the edge`;
    // A refused write marks just that save; a refused read skips it like an unreadable save.
    return method === 'GET'
      ? new SyncError('server', message, INVALID_RECORD)
      : new SyncError('rejected', message);
  }
  return new SyncError('server', `HTTP ${status}: the API answered with a non-JSON page`);
}

export class HttpSyncClient implements SyncClient {
  readonly #base: string;
  readonly #fetch: FetchLike;
  readonly #online: () => boolean;

  constructor(options: HttpSyncClientOptions) {
    this.#base = options.baseUrl.replace(/\/+$/, '');
    this.#fetch = options.fetch;
    this.#online = options.online ?? (() => true);
  }

  async list(): Promise<SaveMeta[]> {
    const { status, body } = await this.#request('GET', '/saves');
    if (status !== 200) throw this.#failure(status, body);
    const saves = isRecord(body) ? body['saves'] : undefined;
    if (!Array.isArray(saves)) throw new SyncError('server', 'malformed save list from the server');
    return saves.map(parseSaveMeta);
  }

  async get(id: string): Promise<SaveRecord | null> {
    const { status, body } = await this.#request('GET', this.#path(id));
    if (status === 404) return null;
    if (status !== 200) throw this.#failure(status, body);
    return remoteRecord(body);
  }

  async push(record: SaveRecord, base: number): Promise<SyncResult> {
    const sent = { ...record, version: base + 1 };
    const { status, body } = await this.#request('PUT', this.#path(record.id), {
      ifMatch: base,
      body: JSON.stringify(sent),
    });
    if (status === 200 || status === 201) return { status: 'ok', record: remoteRecord(body) };
    if (status === 409) return this.#conflict(record.id, sent.version, body);
    throw this.#failure(status, body, true);
  }

  async remove(id: string, base: number): Promise<SyncResult> {
    const { status, body } = await this.#request('DELETE', this.#path(id), { ifMatch: base });
    if (status === 204 || status === 404) return { status: 'ok', record: null };
    if (status === 409) return this.#conflict(id, base, body);
    throw this.#failure(status, body);
  }

  #path(id: string): string {
    return `/saves/${encodeURIComponent(id)}`;
  }

  async #conflict(id: string, offered: number, body: unknown): Promise<SyncResult> {
    const { current } = parseApiError(body);
    const remote = current === null ? null : await this.get(id);
    const expected = (remote?.version ?? 0) + 1;
    return { status: 'conflict', remote, error: new VersionConflictError(id, expected, offered) };
  }

  #failure(status: number, body: unknown, write = false): SyncError {
    const { code, message } = parseApiError(body);
    if (status === 401) return new SyncError('signed-out', 'not signed in', code);
    if (status === 403 && code !== 'save_limit_reached') {
      return new SyncError('signed-out', message, code);
    }
    if (write && (status === 400 || status === 403 || status === 413)) {
      return new SyncError('rejected', message, code);
    }
    return new SyncError('server', `HTTP ${status}: ${message}`, code);
  }

  async #request(
    method: 'GET' | 'PUT' | 'DELETE',
    path: string,
    options: { ifMatch?: number; body?: string } = {},
  ): Promise<{ status: number; body: unknown }> {
    const perRecord = path !== '/saves';
    if (!this.#online()) throw new SyncError('offline', 'the browser is offline');
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.ifMatch !== undefined) headers['If-Match'] = `"${options.ifMatch}"`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    let response: ResponseLike;
    try {
      response = await this.#fetch(this.#base + path, {
        method,
        headers,
        ...(options.body !== undefined ? { body: options.body } : {}),
        credentials: 'include',
        redirect: 'manual',
        cache: 'no-store',
      });
    } catch {
      throw new SyncError('offline', 'the API cannot be reached');
    }
    const { status } = response;
    // Access answers an expired session with a redirect to its login page (opaque with 'manual').
    if (
      response.type === 'opaqueredirect' ||
      response.redirected ||
      (status >= 300 && status < 400)
    ) {
      throw new SyncError('signed-out', 'the sign-in session has expired');
    }
    if (status >= 500 || status === 429) throw new SyncError('server', `HTTP ${status}`);
    if (status === 204) return { status, body: null };
    const type = response.headers.get('Content-Type') ?? '';
    if (!type.toLowerCase().includes('application/json')) {
      throw edgeFailure(status, method, perRecord);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new SyncError('server', 'the API sent invalid JSON');
    }
    return { status, body };
  }
}
