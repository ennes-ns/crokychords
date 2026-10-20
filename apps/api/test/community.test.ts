/**
 * The community bank in the Workers runtime (docs/specs/community-v1.md §8): uploads, quotas,
 * shares and their review, the unshare semantics, the read rule, deletes, the bank's pages,
 * handles and the maintainer check. Every test starts from an empty database.
 */
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { Env } from '../src/app';
import { decodeCursor, encodeCursor, isMaintainer, matchesMagic } from '../src/community';
import { COMMUNITY_LIMITS, sampleKey } from '../src/communityStore';
import { ApiError } from '../src/errors';
import { ORIGIN, authed, makeKey, signToken, staticJwks } from './helpers';
import type { ErrorJson, TestKey } from './helpers';

const MAINTAINER = 'boss@example.test';

let key: TestKey;
let alice: string;
let bob: string;
let carol: string;
let boss: string;

beforeAll(async () => {
  key = await makeKey('community-key');
  alice = await signToken({ key, email: 'alice.smith@example.test' });
  bob = await signToken({ key, email: 'bob@example.test' });
  carol = await signToken({ key, email: 'carol@example.test' });
  boss = await signToken({ key, email: MAINTAINER });
});

function client(vars: Partial<Env> = {}) {
  const app = createApp({ jwks: () => staticJwks([key.jwk]) });
  const bindings = { ...env, ADMIN_EMAILS: MAINTAINER, ...vars };
  return (path: string, init: RequestInit = {}) =>
    Promise.resolve(app.request(`https://api.example.test${path}`, init, bindings));
}

/** A small valid WAV file whose samples depend on `seed` (so the content differs). */
function wav(seed: number, frames = 64): Uint8Array {
  const data = frames * 2;
  const bytes = new Uint8Array(44 + data);
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i);
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + data, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 48000, true);
  view.setUint32(28, 96000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, data, true);
  for (let i = 0; i < frames; i++) view.setInt16(44 + i * 2, (seed * 977 + i * 131) % 30000, true);
  return bytes;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface UploadOptions {
  name?: string;
  type?: string;
  sha?: string;
  query?: Record<string, string>;
}

async function uploadInit(token: string, bytes: Uint8Array, options: UploadOptions = {}) {
  const params = new URLSearchParams({
    name: options.name ?? 'Kick',
    duration: '0.5',
    channels: '1',
    root: '48',
    sha256: options.sha ?? (await sha256(bytes)),
    ...options.query,
  });
  return {
    path: `/api/samples?${params.toString()}`,
    init: authed(token, {
      method: 'POST',
      headers: { 'Content-Type': options.type ?? 'audio/wav' },
      body: bytes,
    }),
  };
}

interface Own {
  id: string;
  name: string;
  tags: string[];
  bytes: number;
  type: string;
  root: number;
  refs: number;
  share: { state: string; reason: string | null } | null;
}

interface Listed {
  id: string;
  name: string;
  owner: string;
  tags: string[];
  own: boolean;
}

function json(body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function code(res: Response): Promise<string> {
  return ((await res.json()) as ErrorJson).error.code;
}

type Api = ReturnType<typeof client>;

async function upload(api: Api, token: string, seed: number, name = 'Kick'): Promise<Own> {
  const { path, init } = await uploadInit(token, wav(seed), { name });
  const res = await api(path, init);
  expect(res.status).toBe(201);
  return ((await res.json()) as { sample: Own }).sample;
}

async function share(api: Api, token: string, id: string, body: object = {}): Promise<Response> {
  return api(`/api/samples/${id}/share`, authed(token, json({ licence: true, ...body })));
}

async function decide(api: Api, id: string, body: object): Promise<Response> {
  return api(`/api/moderation/${id}`, authed(boss, json(body)));
}

/** Upload, share and list (by the maintainer) one sample of `token`. */
async function listedSample(api: Api, token: string, seed: number, name = 'Kick'): Promise<Own> {
  const sample = await upload(api, token, seed, name);
  expect((await share(api, token, sample.id)).status).toBe(200);
  expect((await decide(api, sample.id, { action: 'list' })).status).toBe(200);
  return sample;
}

async function bank(
  api: Api,
  token: string,
  query = '',
): Promise<{ samples: Listed[]; next: string | null }> {
  const res = await api(`/api/community${query}`, authed(token));
  expect(res.status).toBe(200);
  return (await res.json()) as { samples: Listed[]; next: string | null };
}

async function own(api: Api, token: string, id: string): Promise<Own | undefined> {
  const res = await api('/api/samples', authed(token));
  return ((await res.json()) as { samples: Own[] }).samples.find((s) => s.id === id);
}

async function take(api: Api, token: string, id: string, slot = 'sampler-2'): Promise<Response> {
  return api(`/api/samples/${id}/take`, authed(token, json({ slot })));
}

/** Status of a sample read, with the body consumed (an open R2 stream breaks isolated storage). */
async function readStatus(res: Promise<Response>): Promise<number> {
  const r = await res;
  await r.arrayBuffer();
  return r.status;
}

async function r2Samples(): Promise<number> {
  return (await env.SAVES.list({ prefix: 'samples/' })).objects.length;
}

describe('authentication and origin', () => {
  const routes: [string, string][] = [
    ['GET', '/api/samples'],
    ['POST', '/api/samples'],
    ['GET', '/api/samples/00000000-0000-4000-8000-000000000000'],
    ['DELETE', '/api/samples/00000000-0000-4000-8000-000000000000'],
    ['POST', '/api/samples/00000000-0000-4000-8000-000000000000/share'],
    ['DELETE', '/api/samples/00000000-0000-4000-8000-000000000000/share'],
    ['POST', '/api/samples/00000000-0000-4000-8000-000000000000/take'],
    ['GET', '/api/community'],
    ['PUT', '/api/me/handle'],
    ['GET', '/api/moderation/queue'],
    ['POST', '/api/moderation/00000000-0000-4000-8000-000000000000'],
  ];

  it.each(routes)('%s %s without a token is 401', async (method, path) => {
    const res = await client()(path, { method });
    expect(res.status).toBe(401);
  });

  it('refuses a foreign origin and answers the app origin with CORS', async () => {
    const api = client();
    const foreign = await api(
      '/api/community',
      authed(alice, { headers: { Origin: 'https://evil.test' } }),
    );
    expect(foreign.status).toBe(403);
    const ok = await api('/api/community', authed(alice, { headers: { Origin: ORIGIN } }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(ok.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('upload', () => {
  it('stores a sample once per content and returns it to its owner', async () => {
    const api = client();
    const bytes = wav(1);
    const { path, init } = await uploadInit(alice, bytes, { name: '  Big\u0007  kick ' });
    const res = await api(path, init);
    expect(res.status).toBe(201);
    const { sample } = (await res.json()) as { sample: Own };
    expect(sample).toMatchObject({
      name: 'Big kick',
      tags: [],
      bytes: bytes.byteLength,
      type: 'audio/wav',
      root: 48,
      share: null,
      refs: 0,
    });
    const stored = await env.SAVES.get(sampleKey(await sha256(bytes)));
    expect(new Uint8Array((await stored?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(bytes);

    // The same owner and content: the existing sample, unchanged.
    const again = await uploadInit(alice, bytes, { name: 'Other name' });
    const second = await api(again.path, again.init);
    expect(second.status).toBe(200);
    expect(((await second.json()) as { sample: Own }).sample).toMatchObject({
      id: sample.id,
      name: 'Big kick',
    });

    // Another owner: a sample of their own, the same R2 object.
    const theirs = await uploadInit(bob, bytes);
    const third = await api(theirs.path, theirs.init);
    expect(third.status).toBe(201);
    expect(((await third.json()) as { sample: Own }).sample.id).not.toBe(sample.id);
    expect(await r2Samples()).toBe(1);

    const list = await api('/api/samples', authed(alice));
    const body = (await list.json()) as { samples: Own[]; usage: unknown; limits: unknown };
    expect(body.samples.map((s) => s.id)).toEqual([sample.id]);
    expect(body.usage).toEqual({ samples: 1, bytes: bytes.byteLength });
    expect(body.limits).toEqual({
      max_sample_bytes: 10 * 1024 * 1024,
      max_samples: 50,
      max_total_bytes: 100 * 1024 * 1024,
    });
  });

  it('accepts ogg, flac and mp3 by their first bytes and refuses everything else', async () => {
    const api = client();
    const files: [string, number[], string][] = [
      ['audio/ogg', [0x4f, 0x67, 0x67, 0x53, 0, 2], 'audio/ogg'],
      ['audio/x-flac', [0x66, 0x4c, 0x61, 0x43, 0, 0], 'audio/flac'],
      ['audio/mpeg', [0x49, 0x44, 0x33, 3, 0, 0], 'audio/mpeg'],
      ['audio/mp3', [0xff, 0xfb, 0x90, 0x64, 0, 0], 'audio/mpeg'],
    ];
    for (const [type, head, stored] of files) {
      const bytes = new Uint8Array([...head, ...Array.from({ length: 32 }, (_, i) => i)]);
      const { path, init } = await uploadInit(alice, bytes, { type });
      const res = await api(path, init);
      expect(res.status, type).toBe(201);
      expect(((await res.json()) as { sample: Own }).sample.type).toBe(stored);
    }
    const wrongType = await uploadInit(alice, wav(2), { type: 'audio/x-m4a' });
    expect((await api(wrongType.path, wrongType.init)).status).toBe(415);
    const disguised = await uploadInit(alice, new TextEncoder().encode('<html>hi</html>'), {});
    const res = await api(disguised.path, disguised.init);
    expect(res.status).toBe(400);
    expect(await code(res)).toBe('invalid_request');
    const empty = await uploadInit(alice, new Uint8Array(0));
    expect((await api(empty.path, empty.init)).status).toBe(400);
  });

  it('checks the query', async () => {
    const api = client();
    const bad: Record<string, string>[] = [
      { name: '' },
      { name: 'x'.repeat(65) },
      { duration: '31' },
      { duration: '0' },
      { duration: 'long' },
      { channels: '3' },
      { root: '128' },
      { sha256: 'abc' },
    ];
    for (const query of bad) {
      const { path, init } = await uploadInit(alice, wav(3), { query });
      expect((await api(path, init)).status, JSON.stringify(query)).toBe(400);
    }
    const noRoot = await uploadInit(alice, wav(3));
    const url = noRoot.path.replace('&root=48', '');
    const res = await api(url, noRoot.init);
    expect(((await res.json()) as { sample: Own }).sample.root).toBe(60);
  });

  it('refuses bytes that do not match sha256 and keeps nothing', async () => {
    const api = client();
    const { path, init } = await uploadInit(alice, wav(4), { sha: await sha256(wav(5)) });
    const res = await api(path, init);
    expect(res.status).toBe(400);
    expect(await code(res)).toBe('invalid_request');
    expect(await own(api, alice, '')).toBeUndefined();
    const list = (await (await api('/api/samples', authed(alice))).json()) as { samples: Own[] };
    expect(list.samples).toEqual([]);
    expect(await r2Samples()).toBe(0);
  });

  it('cannot claim or overwrite the content of someone else by its hash', async () => {
    const api = client();
    const real = wav(6);
    await upload(api, alice, 6);
    const forged = await uploadInit(bob, wav(7), { sha: await sha256(real) });
    expect((await api(forged.path, forged.init)).status).toBe(400);
    const object = await env.SAVES.get(sampleKey(await sha256(real)));
    expect(new Uint8Array((await object?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(real);
  });

  it('refuses files above 10 MB', async () => {
    const api = client();
    const { path, init } = await uploadInit(alice, wav(8));
    const headers = new Headers(init.headers);
    headers.set('Content-Length', String(10 * 1024 * 1024 + 1));
    const res = await api(path, { ...init, headers });
    expect(res.status).toBe(413);
    expect(await code(res)).toBe('payload_too_large');
    const big = new Uint8Array(10 * 1024 * 1024 + 16);
    big.set(wav(9).subarray(0, 44));
    const huge = await uploadInit(alice, big);
    expect((await api(huge.path, huge.init)).status).toBe(413);
  });

  it('enforces 50 samples and 100 MB per user', async () => {
    const api = client();
    for (let i = 0; i < COMMUNITY_LIMITS.maxSamples; i++) await upload(api, alice, 100 + i);
    const over = await uploadInit(alice, wav(999));
    const res = await api(over.path, over.init);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('sample_limit_reached');
    // Content the owner already has is still answered.
    const again = await uploadInit(alice, wav(100));
    expect((await api(again.path, again.init)).status).toBe(200);
    // Bytes: one large row brings bob near the limit.
    await upload(api, bob, 1);
    const me = (await (await api('/api/me', authed(bob))).json()) as { id: string };
    await env.DB.prepare(
      "INSERT INTO samples (id, owner_id, sha256, bytes, type, duration, channels, name, tags, root, created_at) VALUES ('big', ?, 'x', ?, 'audio/wav', 1, 1, 'big', ' ', 60, 'now')",
    )
      .bind(me.id, COMMUNITY_LIMITS.maxTotalBytes - 100)
      .run();
    const tooMuch = await uploadInit(bob, wav(2));
    const refused = await api(tooMuch.path, tooMuch.init);
    expect(refused.status).toBe(403);
    expect(await code(refused)).toBe('sample_limit_reached');
  });
});

describe('share, review and unshare', () => {
  it('needs the licence acknowledgement and starts pending, invisible to others', async () => {
    const api = client();
    const sample = await upload(api, alice, 1);
    const noLicence = await api(
      `/api/samples/${sample.id}/share`,
      authed(alice, json({ licence: false })),
    );
    expect(noLicence.status).toBe(400);
    const res = await share(api, alice, sample.id, {
      name: 'Dusty kick',
      tags: ['Drums', 'kick', 'kick'],
    });
    expect(res.status).toBe(200);
    const { sample: shared } = (await res.json()) as { sample: Own };
    expect(shared).toMatchObject({
      name: 'Dusty kick',
      tags: ['drums', 'kick'],
      share: { state: 'pending' },
    });
    const row = await env.DB.prepare('SELECT licence_ack FROM shares WHERE sample_id = ?')
      .bind(sample.id)
      .first<{ licence_ack: string }>();
    expect(row?.licence_ack).toBe('community-v1');
    expect((await bank(api, bob)).samples).toEqual([]);
    expect(await readStatus(api(`/api/samples/${sample.id}`, authed(bob)))).toBe(404);
    expect((await take(api, bob, sample.id)).status).toBe(409);
    // Not the owner: not found.
    expect((await share(api, bob, sample.id)).status).toBe(404);
    // Bad tags.
    expect((await share(api, alice, sample.id, { tags: ['no spaces'] })).status).toBe(400);
    expect(
      (await share(api, alice, sample.id, { tags: ['a', 'b', 'c', 'd', 'e', 'f'] })).status,
    ).toBe(400);
  });

  it('is listed only by the maintainer; the bank shows the handle, never the e-mail', async () => {
    const api = client();
    const sample = await upload(api, alice, 1, 'Snare');
    await share(api, alice, sample.id, { tags: ['drums'] });
    const queue = await api('/api/moderation/queue', authed(boss));
    expect(queue.status).toBe(200);
    const text = await queue.text();
    expect(text).not.toContain('@example.test');
    const { items } = JSON.parse(text) as { items: { id: string; owner: string; state: string }[] };
    expect(items).toMatchObject([{ id: sample.id, owner: 'alice.smith', state: 'pending' }]);
    // The maintainer may audition a pending sample.
    expect(await readStatus(api(`/api/samples/${sample.id}`, authed(boss)))).toBe(200);

    const listed = await decide(api, sample.id, { action: 'list' });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { item: { state: string } }).item.state).toBe('listed');
    expect((await decide(api, sample.id, { action: 'list' })).status).toBe(409);

    const res = await api('/api/community', authed(bob));
    const body = await res.text();
    expect(body).not.toContain('@');
    const page = JSON.parse(body) as { samples: Listed[]; next: string | null };
    expect(page.samples).toMatchObject([
      { id: sample.id, name: 'Snare', owner: 'alice.smith', tags: ['drums'], own: false },
    ]);
    expect(page.next).toBeNull();
    expect((await bank(api, alice)).samples[0]?.own).toBe(true);
    expect((await own(api, alice, sample.id))?.share?.state).toBe('listed');
    expect((await api('/api/moderation/queue', authed(boss))).ok).toBe(true);
  });

  it('take adds a ref while listed; unshare keeps refs working and refuses new takes', async () => {
    const api = client();
    const sample = await listedSample(api, alice, 1);
    const taken = await take(api, bob, sample.id, 'sampler-3');
    expect(taken.status).toBe(200);
    expect(((await taken.json()) as { sample: Listed }).sample).toMatchObject({
      id: sample.id,
      owner: 'alice.smith',
    });
    expect((await own(api, alice, sample.id))?.refs).toBe(1);
    // Taking an own sample adds no ref.
    expect((await take(api, alice, sample.id)).status).toBe(200);
    expect((await own(api, alice, sample.id))?.refs).toBe(1);
    expect((await take(api, bob, sample.id, 'sampler-9')).status).toBe(400);

    const unshared = await api(
      `/api/samples/${sample.id}/share`,
      authed(alice, { method: 'DELETE' }),
    );
    expect(unshared.status).toBe(200);
    expect(((await unshared.json()) as { sample: Own }).sample.share?.state).toBe('unlisted');

    expect((await bank(api, bob)).samples).toEqual([]);
    // Bob keeps it: the bytes still download.
    const bytes = await api(`/api/samples/${sample.id}`, authed(bob));
    expect(bytes.status).toBe(200);
    expect(bytes.headers.get('Content-Type')).toBe('audio/wav');
    expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(wav(1));
    // Nobody can take it anew, also not bob into another slot.
    const refused = await take(api, carol, sample.id);
    expect(refused.status).toBe(409);
    expect(await code(refused)).toBe('not_listed');
    expect((await take(api, bob, sample.id, 'sampler-4')).status).toBe(409);
    expect(await readStatus(api(`/api/samples/${sample.id}`, authed(carol)))).toBe(404);
    // Unsharing twice is harmless.
    const again = await api(`/api/samples/${sample.id}/share`, authed(alice, { method: 'DELETE' }));
    expect(((await again.json()) as { sample: Own }).sample.share?.state).toBe('unlisted');
  });

  it('a slot holds one ref: taking into it again replaces the old one', async () => {
    const api = client();
    const first = await listedSample(api, alice, 1);
    const second = await listedSample(api, alice, 2);
    await take(api, bob, first.id, 'sampler-1');
    await take(api, bob, second.id, 'sampler-1');
    expect((await own(api, alice, first.id))?.refs).toBe(0);
    expect((await own(api, alice, second.id))?.refs).toBe(1);
  });

  it('sharing again: listed stays as is, unlisted goes back to review, rejected is refused', async () => {
    const api = client();
    const sample = await listedSample(api, alice, 1, 'Clap');
    const noop = await share(api, alice, sample.id, { name: 'Renamed' });
    expect(((await noop.json()) as { sample: Own }).sample).toMatchObject({
      name: 'Clap',
      share: { state: 'listed' },
    });
    await api(`/api/samples/${sample.id}/share`, authed(alice, { method: 'DELETE' }));
    const back = await share(api, alice, sample.id, { name: 'Renamed' });
    expect(((await back.json()) as { sample: Own }).sample).toMatchObject({
      name: 'Renamed',
      share: { state: 'pending' },
    });
    // Pending: the name can still change and the share keeps its place.
    const edited = await share(api, alice, sample.id, { tags: ['perc'] });
    expect(((await edited.json()) as { sample: Own }).sample.tags).toEqual(['perc']);

    const reject = await decide(api, sample.id, { action: 'reject', reason: 'speech' });
    expect(reject.status).toBe(200);
    const mine = await own(api, alice, sample.id);
    expect(mine?.share).toMatchObject({ state: 'rejected', reason: 'speech' });
    const refused = await share(api, alice, sample.id);
    expect(refused.status).toBe(409);
    expect(await code(refused)).toBe('share_rejected');
    // Still the owner's: it downloads for them, for nobody else.
    expect(await readStatus(api(`/api/samples/${sample.id}`, authed(alice)))).toBe(200);
    expect(await readStatus(api(`/api/samples/${sample.id}`, authed(bob)))).toBe(404);
  });

  it('the maintainer can take a listed sample down; refs keep working', async () => {
    const api = client();
    const sample = await listedSample(api, alice, 1);
    await take(api, bob, sample.id);
    expect((await decide(api, sample.id, { action: 'reject', reason: 'copyright' })).status).toBe(
      200,
    );
    expect((await bank(api, carol)).samples).toEqual([]);
    expect(await readStatus(api(`/api/samples/${sample.id}`, authed(bob)))).toBe(200);
    expect((await decide(api, sample.id, { action: 'reject', reason: 'other' })).status).toBe(409);
  });
});

describe('maintainer only', () => {
  it('nobody is maintainer while ADMIN_EMAILS is empty', async () => {
    const api = client({ ADMIN_EMAILS: '' });
    const res = await api('/api/moderation/queue', authed(boss));
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('forbidden');
    const me = (await (await api('/api/me', authed(boss))).json()) as { maintainer: boolean };
    expect(me.maintainer).toBe(false);
  });

  it('other users get 403; the maintainer is matched case-insensitively', async () => {
    const api = client({ ADMIN_EMAILS: ' other@example.test, BOSS@example.test ' });
    const sample = await upload(api, alice, 1);
    await share(api, alice, sample.id);
    expect((await api('/api/moderation/queue', authed(alice))).status).toBe(403);
    expect(
      (await api(`/api/moderation/${sample.id}`, authed(alice, json({ action: 'list' })))).status,
    ).toBe(403);
    expect((await api('/api/moderation/queue', authed(boss))).status).toBe(200);
    const me = (await (await api('/api/me', authed(boss))).json()) as { maintainer: boolean };
    expect(me.maintainer).toBe(true);
  });

  it('checks the decision', async () => {
    const api = client();
    const sample = await upload(api, alice, 1);
    expect((await decide(api, sample.id, { action: 'list' })).status).toBe(404);
    await share(api, alice, sample.id);
    expect((await decide(api, sample.id, { action: 'reject' })).status).toBe(400);
    expect((await decide(api, sample.id, { action: 'reject', reason: 'boring' })).status).toBe(400);
    expect((await decide(api, sample.id, { action: 'delete' })).status).toBe(400);
    expect((await decide(api, 'not-a-uuid', { action: 'list' })).status).toBe(404);
    // Unshared while pending: it leaves the queue and cannot be listed.
    await api(`/api/samples/${sample.id}/share`, authed(alice, { method: 'DELETE' }));
    expect((await decide(api, sample.id, { action: 'list' })).status).toBe(409);
    const { items } = (await (await api('/api/moderation/queue', authed(boss))).json()) as {
      items: unknown[];
    };
    expect(items).toEqual([]);
  });

  it('isMaintainer splits on commas and spaces and ignores empty entries', () => {
    expect(isMaintainer('', '')).toBe(false);
    expect(isMaintainer(',,', 'a@b.c')).toBe(false);
    expect(isMaintainer('a@b.c;d@e.f', 'D@E.F')).toBe(true);
    expect(isMaintainer(undefined, 'a@b.c')).toBe(false);
  });
});

describe('read and delete', () => {
  it('reads: unknown and malformed ids are 404', async () => {
    const api = client();
    expect(
      (await api('/api/samples/00000000-0000-4000-8000-000000000000', authed(alice))).status,
    ).toBe(404);
    expect((await api('/api/samples/%2E%2E%2Fsaves', authed(alice))).status).toBe(404);
    expect((await api('/api/samples/abc', authed(alice))).status).toBe(404);
  });

  it('deletes an own sample unless it is shared or referenced; R2 keeps shared content', async () => {
    const api = client();
    const sample = await listedSample(api, alice, 1);
    const del = () => api(`/api/samples/${sample.id}`, authed(alice, { method: 'DELETE' }));
    const pendingOrListed = await del();
    expect(pendingOrListed.status).toBe(409);
    expect(await code(pendingOrListed)).toBe('sample_in_use');
    await take(api, bob, sample.id);
    await api(`/api/samples/${sample.id}/share`, authed(alice, { method: 'DELETE' }));
    expect((await del()).status).toBe(409);
    expect((await api(`/api/samples/${sample.id}`, authed(bob, { method: 'DELETE' }))).status).toBe(
      404,
    );

    // Without refs and unshared it goes; the bytes stay while another row has them.
    const lonely = await upload(api, alice, 2);
    await upload(api, carol, 2);
    const sha = await sha256(wav(2));
    expect(
      (await api(`/api/samples/${lonely.id}`, authed(alice, { method: 'DELETE' }))).status,
    ).toBe(204);
    expect(await own(api, alice, lonely.id)).toBeUndefined();
    expect(await env.SAVES.head(sampleKey(sha))).not.toBeNull();
    const carols = (await (await api('/api/samples', authed(carol))).json()) as { samples: Own[] };
    const last = carols.samples[0]?.id ?? '';
    expect((await api(`/api/samples/${last}`, authed(carol, { method: 'DELETE' }))).status).toBe(
      204,
    );
    expect(await env.SAVES.head(sampleKey(sha))).toBeNull();
    // A rejected sample is the owner's to delete.
    const rejected = await upload(api, alice, 3);
    await share(api, alice, rejected.id);
    await decide(api, rejected.id, { action: 'reject', reason: 'quality' });
    expect(
      (await api(`/api/samples/${rejected.id}`, authed(alice, { method: 'DELETE' }))).status,
    ).toBe(204);
  });
});

describe('the bank', () => {
  it('pages newest first and filters by name and tag', async () => {
    const api = client();
    const names: string[] = [];
    for (let i = 0; i < 26; i++) {
      const name = i % 2 === 0 ? `Pad ${i}` : `Kick_${i}`;
      const sample = await upload(api, alice, i, name);
      await share(api, alice, sample.id, { tags: i % 2 === 0 ? ['pads'] : ['drums'] });
      await decide(api, sample.id, { action: 'list' });
      names.push(name);
    }
    const first = await bank(api, bob);
    expect(first.samples).toHaveLength(24);
    expect(first.next).not.toBeNull();
    const second = await bank(api, bob, `?cursor=${first.next ?? ''}`);
    expect(second.samples).toHaveLength(2);
    expect(second.next).toBeNull();
    const all = [...first.samples, ...second.samples].map((s) => s.name);
    expect(new Set(all).size).toBe(26);
    expect(all.sort()).toEqual([...names].sort());

    const pads = await bank(api, bob, '?tag=pads');
    expect(pads.samples).toHaveLength(13);
    expect(pads.samples.every((s) => s.tags.includes('pads'))).toBe(true);
    const search = await bank(api, bob, '?q=kick_1');
    expect(search.samples.map((s) => s.name).sort()).toEqual([
      'Kick_1',
      'Kick_11',
      'Kick_13',
      'Kick_15',
      'Kick_17',
      'Kick_19',
    ]);
    // `_` and `%` are literal.
    expect((await bank(api, bob, '?q=%25')).samples).toEqual([]);
    expect((await api('/api/community?cursor=nonsense', authed(bob))).status).toBe(400);
    expect((await api('/api/community?tag=Not%20a%20tag', authed(bob))).status).toBe(400);
    expect((await api(`/api/community?q=${'x'.repeat(65)}`, authed(bob))).status).toBe(400);
  });

  it('cursors round-trip and refuse anything else', () => {
    const cursor = encodeCursor(['2026-10-21T10:00:00.000Z', 'abc']);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toEqual(['2026-10-21T10:00:00.000Z', 'abc']);
    expect(() => decodeCursor(btoa('[1,2]'))).toThrow(ApiError);
    expect(() => decodeCursor('***')).toThrow(ApiError);
  });
});

describe('handles', () => {
  it('defaults to the first part of the e-mail, can be chosen and reset', async () => {
    const api = client();
    const me = (await (await api('/api/me', authed(alice))).json()) as { handle: string };
    expect(me.handle).toBe('alice.smith');
    const set = await api('/api/me/handle', authed(alice, json({ handle: 'dusty_loops' }, 'PUT')));
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ handle: 'dusty_loops' });
    await listedSample(api, alice, 1);
    expect((await bank(api, bob)).samples[0]?.owner).toBe('dusty_loops');
    for (const handle of ['x', 'with space', 'a@b.c', 'x'.repeat(25)]) {
      const res = await api('/api/me/handle', authed(alice, json({ handle }, 'PUT')));
      expect(res.status, handle).toBe(400);
    }
    const reset = await api('/api/me/handle', authed(alice, json({ handle: null }, 'PUT')));
    expect(await reset.json()).toEqual({ handle: 'alice.smith' });
    const form = await api('/api/me/handle', authed(alice, { method: 'PUT', body: '{}' }));
    expect(form.status).toBe(415);
  });
});

describe('magic bytes', () => {
  it('recognises the four families', () => {
    const b = (...xs: number[]) => new Uint8Array(xs);
    expect(matchesMagic(wav(1), 'wav')).toBe(true);
    expect(matchesMagic(wav(1), 'ogg')).toBe(false);
    expect(matchesMagic(b(0xff), 'mp3')).toBe(false);
    expect(matchesMagic(b(0xff, 0xf3), 'mp3')).toBe(true);
    expect(matchesMagic(b(0x66, 0x4c, 0x61, 0x43), 'flac')).toBe(true);
  });
});
