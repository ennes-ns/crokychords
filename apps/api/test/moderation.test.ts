/**
 * Moderation in the Workers runtime (docs/specs/moderation-v1.md §7): the job's service auth,
 * its view of pending shares, verdicts that never change a state, the text route, the digest,
 * reports, appeals, the hard delete and the log. Every test starts from an empty database.
 */
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { AppDeps, Env } from '../src/app';
import { sampleKey } from '../src/communityStore';
import { bearerMatches, parseGuard } from '../src/moderation';
import { ModerationStore } from '../src/moderationStore';
import { authed, makeKey, signToken, staticJwks } from './helpers';
import type { ErrorJson, TestKey } from './helpers';

const MAINTAINER = 'boss@example.test';
const TOKEN = 'test-moderation-token-0123456789';

let key: TestKey;
let alice: string;
let bob: string;
let boss: string;
/** The JWT Access forwards for a service token: `common_name`, no e-mail. */
let service: string;

beforeAll(async () => {
  key = await makeKey('moderation-key');
  alice = await signToken({ key, email: 'alice@example.test' });
  bob = await signToken({ key, email: 'bob@example.test' });
  boss = await signToken({ key, email: MAINTAINER });
  service = await signToken({ key, extra: { common_name: 'job-client.access' } });
});

const safeGuard: AppDeps['guard'] = () => Promise.resolve({ response: { safe: true } });

function client(vars: Partial<Env> = {}, deps: Partial<AppDeps> = {}) {
  const app = createApp({ jwks: () => staticJwks([key.jwk]), guard: safeGuard, ...deps });
  const bindings = { ...env, ADMIN_EMAILS: MAINTAINER, MODERATION_TOKEN: TOKEN, ...vars };
  return (path: string, init: RequestInit = {}) =>
    Promise.resolve(app.request(`https://api.example.test${path}`, init, bindings));
}

type Api = ReturnType<typeof client>;

/** A request of the job: the service token's JWT plus the bearer token. */
function job(init: RequestInit = {}, bearer = TOKEN, jwt?: string): RequestInit {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${bearer}`);
  return authed(jwt ?? service, { ...init, headers });
}

function json(body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function code(res: Response): Promise<string> {
  return ((await res.json()) as ErrorJson).error.code;
}

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

async function upload(api: Api, token: string, seed: number, name = 'Vocal ah'): Promise<string> {
  const bytes = wav(seed);
  const params = new URLSearchParams({
    name,
    duration: '0.5',
    channels: '1',
    sha256: await sha256(bytes),
  });
  const res = await api(
    `/api/samples?${params.toString()}`,
    authed(token, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: bytes }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { sample: { id: string } }).sample.id;
}

async function share(api: Api, token: string, id: string, body: object = {}): Promise<void> {
  const res = await api(
    `/api/samples/${id}/share`,
    authed(token, json({ licence: true, tags: ['vocal'], ...body })),
  );
  expect(res.status).toBe(200);
}

async function revision(id: string): Promise<number> {
  const row = await env.DB.prepare('SELECT revision FROM shares WHERE sample_id = ?')
    .bind(id)
    .first<{ revision: number }>();
  return row?.revision ?? 1;
}

async function decide(api: Api, id: string, body: object): Promise<Response> {
  return api(
    `/api/moderation/${id}`,
    authed(boss, json({ revision: await revision(id), ...body })),
  );
}

async function pendingSample(api: Api, seed = 1, token = alice): Promise<string> {
  const id = await upload(api, token, seed);
  await share(api, token, id);
  return id;
}

async function listedSample(api: Api, seed = 1, token = alice): Promise<string> {
  const id = await pendingSample(api, seed, token);
  expect((await decide(api, id, { action: 'list' })).status).toBe(200);
  return id;
}

function verdict(rev: number, overrides: object = {}): object {
  return {
    revision: rev,
    verdict: 'flag',
    category: 'speech',
    scores: { Speech: 0.97, vad_ratio: 0.9 },
    reasons: ['speech: words heard: “call me back”'],
    notes: ['loudness: very loud: -7.0 LUFS'],
    peaks: [0, 0.5, 1],
    models: { asr: 'faster-whisper whisper-small int8', events: 'yamnet' },
    policy: 'moderation-v1/1',
    ...overrides,
  };
}

async function postVerdict(api: Api, id: string, body: object): Promise<Response> {
  return api(`/api/moderation/job/samples/${id}/verdict`, job(json(body)));
}

interface QueueItem {
  id: string;
  state: string;
  revision: number;
  auto: {
    verdict: string;
    current: boolean;
    reasons: string[];
    notes: string[];
    peaks: number[];
    scores: Record<string, number>;
    models: Record<string, string>;
    policy: string;
  } | null;
  reports: { open: number; reasons: Record<string, number> };
  appeal: { at: string; of: string | null } | null;
}

async function queue(api: Api, state = 'pending'): Promise<QueueItem[]> {
  const res = await api(`/api/moderation/queue?state=${state}`, authed(boss));
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: QueueItem[] }).items;
}

async function pendingForJob(api: Api, query = ''): Promise<{ id: string; revision: number }[]> {
  const res = await api(`/api/moderation/job/pending${query}`, job());
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: { id: string; revision: number }[] }).items;
}

describe('job auth', () => {
  it('needs the Access JWT and the bearer token, compared in constant time', async () => {
    const api = client();
    expect((await api('/api/moderation/job/digest')).status).toBe(401);
    expect((await api('/api/moderation/job/digest', authed(service))).status).toBe(401);
    expect((await api('/api/moderation/job/digest', job({}, 'wrong-token'))).status).toBe(401);
    expect((await api('/api/moderation/job/digest', job({}, ''))).status).toBe(401);
    const bare = new Headers({ Authorization: `Bearer ${TOKEN}` });
    expect((await api('/api/moderation/job/digest', { headers: bare })).status).toBe(401);
    expect((await api('/api/moderation/job/digest', job())).status).toBe(200);
  });

  it('accepts a service token without an e-mail and creates no user', async () => {
    const api = client();
    expect((await api('/api/moderation/job/pending', job())).status).toBe(200);
    const users = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
    expect(users?.n).toBe(0);
  });

  it('fails closed without the secret', async () => {
    const api = client({ MODERATION_TOKEN: '' });
    const res = await api('/api/moderation/job/digest', job());
    expect(res.status).toBe(500);
    expect(await code(res)).toBe('server_misconfigured');
  });

  it('a user session alone is not enough, and user routes ignore the bearer token', async () => {
    const api = client();
    expect((await api('/api/moderation/job/digest', authed(boss))).status).toBe(401);
    // A service token cannot use user routes (no e-mail), bearer or not.
    expect((await api('/api/me', job())).status).toBe(401);
  });

  it('compares bearer tokens exactly', async () => {
    expect(await bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(await bearerMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(await bearerMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(await bearerMatches(TOKEN, TOKEN)).toBe(false);
    expect(await bearerMatches(undefined, TOKEN)).toBe(false);
    expect(await bearerMatches('Bearer ', '')).toBe(false);
  });
});

describe('pending list and bytes', () => {
  it('lists pending shares without a current verdict, oldest first, without the owner', async () => {
    const api = client();
    const a = await pendingSample(api, 1);
    const b = await pendingSample(api, 2, bob);
    const listed = await listedSample(api, 3);
    const res = await api('/api/moderation/job/pending', job());
    const body = (await res.json()) as { items: Record<string, unknown>[] };
    expect(body.items.map((i) => i['id'])).toEqual([a, b]);
    const item = body.items[0] ?? {};
    expect(item).toMatchObject({
      name: 'Vocal ah',
      tags: ['vocal'],
      type: 'audio/wav',
      channels: 1,
    });
    expect(Object.keys(item).sort()).toEqual(
      [
        'bytes',
        'channels',
        'duration',
        'id',
        'name',
        'revision',
        'shared_at',
        'tags',
        'type',
      ].sort(),
    );
    expect(JSON.stringify(body)).not.toContain('example.test');
    expect(body.items.map((i) => i['id'])).not.toContain(listed);

    expect((await postVerdict(api, a, verdict(await revision(a)))).status).toBe(200);
    expect((await pendingForJob(api)).map((i) => i.id)).toEqual([b]);
    // A rename bumps the revision: the verdict is outdated and the job checks it again.
    await share(api, alice, a, { name: 'Vocal oh' });
    expect((await pendingForJob(api)).map((i) => i.id)).toEqual([a, b]);
    expect((await pendingForJob(api, '?limit=1')).length).toBe(1);
    for (const bad of ['0', '51', 'x', '1.5']) {
      expect((await api(`/api/moderation/job/pending?limit=${bad}`, job())).status).toBe(400);
    }
  });

  it('serves the bytes only while pending', async () => {
    const api = client();
    const id = await pendingSample(api, 4);
    const res = await api(`/api/moderation/job/samples/${id}`, job());
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(wav(4));
    expect((await decide(api, id, { action: 'list' })).status).toBe(200);
    const after = await api(`/api/moderation/job/samples/${id}`, job());
    await after.arrayBuffer();
    expect(after.status).toBe(404);
    const unknown = await api('/api/moderation/job/samples/not-a-uuid', job());
    expect(unknown.status).toBe(404);
  });
});

describe('verdicts', () => {
  it('stores the recommendation and logs it, without changing the state', async () => {
    const api = client();
    const id = await pendingSample(api, 5);
    const rev = await revision(id);
    expect((await postVerdict(api, id, verdict(rev))).status).toBe(200);
    const [item] = await queue(api);
    expect(item?.state).toBe('pending');
    expect(item?.auto).toMatchObject({
      verdict: 'flag:speech',
      current: true,
      reasons: ['speech: words heard: “call me back”'],
      notes: ['loudness: very loud: -7.0 LUFS'],
      peaks: [0, 0.5, 1],
      scores: { Speech: 0.97, vad_ratio: 0.9 },
      models: { asr: 'faster-whisper whisper-small int8', events: 'yamnet' },
      policy: 'moderation-v1/1',
    });
    const row = await env.DB.prepare(
      'SELECT state, reason, listed_at FROM shares WHERE sample_id = ?',
    )
      .bind(id)
      .first();
    expect(row).toEqual({ state: 'pending', reason: null, listed_at: null });
    const log = await new ModerationStore(env.DB).log(id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      actor: 'auto',
      action: 'verdict',
      verdict: 'flag:speech',
      revision: rev,
    });
    expect(JSON.parse(log[0]?.detail ?? '{}')).toMatchObject({
      models: { events: 'yamnet' },
      policy: 'moderation-v1/1',
    });

    // The owner never sees the recommendation.
    const mine = await api('/api/samples', authed(alice));
    expect(JSON.stringify(await mine.json())).not.toContain('flag:speech');

    // ok replaces the earlier verdict.
    expect(
      (await postVerdict(api, id, verdict(rev, { verdict: 'ok', category: undefined }))).status,
    ).toBe(200);
    expect((await queue(api))[0]?.auto?.verdict).toBe('ok');
  });

  it('marks a verdict outdated after a rename and refuses a stale one', async () => {
    const api = client();
    const id = await pendingSample(api, 6);
    const rev = await revision(id);
    expect((await postVerdict(api, id, verdict(rev))).status).toBe(200);
    await share(api, alice, id, { name: 'Renamed' });
    expect((await queue(api))[0]?.auto?.current).toBe(false);
    const stale = await postVerdict(api, id, verdict(rev));
    expect(stale.status).toBe(409);
    expect(await code(stale)).toBe('conflict');
    expect(await new ModerationStore(env.DB).log(id)).toHaveLength(1);
  });

  it('refuses a verdict on a share that is not pending', async () => {
    const api = client();
    const id = await listedSample(api, 7);
    expect((await postVerdict(api, id, verdict(await revision(id)))).status).toBe(409);
    const unknown = await postVerdict(api, '00000000-0000-4000-8000-000000000000', verdict(1));
    expect(unknown.status).toBe(409);
  });

  it('validates the body', async () => {
    const api = client();
    const id = await pendingSample(api, 8);
    const rev = await revision(id);
    const bad: object[] = [
      { category: undefined },
      { verdict: 'ok' },
      { category: 'nonsense' },
      { peaks: [1.5] },
      { peaks: Array.from({ length: 65 }, () => 0) },
      { reasons: ['x'.repeat(201)] },
      { scores: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`s${i}`, 0])) },
      { revision: 0 },
      { verdict: 'list' },
    ];
    for (const overrides of bad) {
      const res = await postVerdict(api, id, verdict(rev, overrides));
      expect(res.status, JSON.stringify(overrides).slice(0, 80)).toBe(400);
    }
    const text = await api(
      `/api/moderation/job/samples/${id}/verdict`,
      job({ method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' }),
    );
    expect(text.status).toBe(415);
  });
});

describe('text route', () => {
  it('runs the text model per text', async () => {
    const seen: string[] = [];
    const api = client(
      {},
      {
        guard: (input) => {
          const content = input.messages[0]?.content ?? '';
          seen.push(content);
          return Promise.resolve(
            content.includes('bad')
              ? { response: 'unsafe\nS10,S12' }
              : { response: { safe: true } },
          );
        },
      },
    );
    const res = await api('/api/moderation/job/text', job(json({ texts: ['fine', 'bad name'] })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      available: true,
      model: '@cf/meta/llama-guard-3-8b',
      results: [
        { safe: true, categories: [] },
        { safe: false, categories: ['S10', 'S12'] },
      ],
    });
    expect(seen).toEqual(['fine', 'bad name']);
  });

  it('says unavailable without a model or with an unreadable answer', async () => {
    const none = client({ AI: undefined }, { guard: undefined });
    const res = await none('/api/moderation/job/text', job(json({ texts: ['x'] })));
    expect(await res.json()).toMatchObject({ available: false, results: [] });
    const broken = client({}, { guard: () => Promise.reject(new Error('down')) });
    const res2 = await broken('/api/moderation/job/text', job(json({ texts: ['x'] })));
    expect(await res2.json()).toMatchObject({ available: false });
    const odd = client({}, { guard: () => Promise.resolve({ response: 42 }) });
    const res3 = await odd('/api/moderation/job/text', job(json({ texts: ['x'] })));
    expect(await res3.json()).toMatchObject({ available: false });
  });

  it('validates the texts', async () => {
    const api = client();
    for (const texts of [[], ['x'.repeat(301)], Array.from({ length: 21 }, () => 'x')]) {
      expect((await api('/api/moderation/job/text', job(json({ texts })))).status).toBe(400);
    }
  });

  it('parses both answer formats', () => {
    expect(parseGuard({ response: 'safe' })).toEqual({ safe: true, categories: [] });
    expect(parseGuard({ response: 'unsafe\nS1, s1, S11' })).toEqual({
      safe: false,
      categories: ['S1', 'S11'],
    });
    expect(parseGuard({ response: { safe: false, categories: ['s7'] } })).toEqual({
      safe: false,
      categories: ['S7'],
    });
    expect(parseGuard({ response: 'maybe' })).toBeNull();
    expect(parseGuard(null)).toBeNull();
  });
});

describe('digest', () => {
  it('counts what waits', async () => {
    const api = client();
    const empty = await api('/api/moderation/job/digest', job());
    expect(await empty.json()).toEqual({
      pending: 0,
      unchecked: 0,
      flagged: 0,
      reported: 0,
      appeals: 0,
      oldest_pending_at: null,
    });
    const a = await pendingSample(api, 10);
    await pendingSample(api, 11);
    await postVerdict(api, a, verdict(await revision(a)));
    const listed = await listedSample(api, 12);
    await api(`/api/samples/${listed}/report`, authed(bob, json({ reason: 'speech' })));
    const res = await api('/api/moderation/job/digest', job());
    expect(await res.json()).toMatchObject({
      pending: 2,
      unchecked: 1,
      flagged: 1,
      reported: 1,
      appeals: 0,
    });
  });
});

describe('reports', () => {
  it('puts a listed sample into the Reported view without unlisting it', async () => {
    const api = client();
    const id = await listedSample(api, 20);
    const res = await api(`/api/samples/${id}/report`, authed(bob, json({ reason: 'speech' })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reported: true });
    // A second report of the same user replaces the reason.
    await api(`/api/samples/${id}/report`, authed(bob, json({ reason: 'violence' })));
    const carol = await signToken({ key, email: 'carol@example.test' });
    await api(`/api/samples/${id}/report`, authed(carol, json({ reason: 'violence' })));
    const [item] = await queue(api, 'reported');
    expect(item?.id).toBe(id);
    expect(item?.state).toBe('listed');
    expect(item?.reports).toEqual({ open: 2, reasons: { violence: 2 } });
    const bank = await api('/api/community', authed(bob));
    expect(JSON.stringify(await bank.json())).toContain(id);
    const log = await new ModerationStore(env.DB).log(id);
    expect(log.filter((l) => l.action === 'report').map((l) => l.reason)).toEqual([
      'speech',
      'violence',
      'violence',
    ]);
    expect(JSON.stringify(log)).not.toContain('example.test');
  });

  it('refuses unlisted, own and quality reports', async () => {
    const api = client();
    const pending = await pendingSample(api, 21);
    const own = await listedSample(api, 22);
    const notListed = await api(
      `/api/samples/${pending}/report`,
      authed(bob, json({ reason: 'speech' })),
    );
    expect(notListed.status).toBe(409);
    expect(await code(notListed)).toBe('not_listed');
    const mine = await api(`/api/samples/${own}/report`, authed(alice, json({ reason: 'speech' })));
    expect(mine.status).toBe(409);
    expect(await code(mine)).toBe('conflict');
    const quality = await api(
      `/api/samples/${own}/report`,
      authed(bob, json({ reason: 'quality' })),
    );
    expect(quality.status).toBe(400);
  });

  it('caps reports per user and day', async () => {
    const api = client();
    const id = await listedSample(api, 23);
    await api('/api/me', authed(bob));
    const user = await env.DB.prepare(
      "SELECT id FROM users WHERE email = 'bob@example.test'",
    ).first<{
      id: string;
    }>();
    const now = new Date().toISOString();
    for (let i = 0; i < 20; i++) {
      await env.DB.prepare(
        "INSERT INTO reports (sample_id, user_id, reason, created_at) VALUES (?, ?, 'other', ?)",
      )
        .bind(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, user?.id, now)
        .run();
    }
    const res = await api(`/api/samples/${id}/report`, authed(bob, json({ reason: 'speech' })));
    expect(res.status).toBe(429);
    expect(await code(res)).toBe('rate_limited');
  });

  it('dismiss resolves the reports and keeps the sample listed; a take-down resolves them too', async () => {
    const api = client();
    const id = await listedSample(api, 24);
    await api(`/api/samples/${id}/report`, authed(bob, json({ reason: 'hate' })));
    expect((await decide(api, id, { action: 'dismiss' })).status).toBe(200);
    expect(await queue(api, 'reported')).toEqual([]);
    expect((await queue(api, 'listed'))[0]?.id).toBe(id);
    // Nothing left to dismiss.
    expect((await decide(api, id, { action: 'dismiss' })).status).toBe(409);
    // A new report reopens it; a take-down resolves it.
    await api(`/api/samples/${id}/report`, authed(bob, json({ reason: 'hate' })));
    expect((await queue(api, 'reported')).length).toBe(1);
    expect((await decide(api, id, { action: 'reject', reason: 'hate' })).status).toBe(200);
    const open = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM reports WHERE sample_id = ? AND resolved_at IS NULL',
    )
      .bind(id)
      .first<{ n: number }>();
    expect(open?.n).toBe(0);
    const actions = (await new ModerationStore(env.DB).log(id))
      .filter((l) => l.actor === 'maintainer')
      .map((l) => [l.action, l.reason]);
    expect(actions).toEqual([
      ['list', null],
      ['dismiss', null],
      ['reject', 'hate'],
    ]);
  });
});

describe('appeals', () => {
  it('sends a rejected share back to the queue once', async () => {
    const api = client();
    const id = await pendingSample(api, 30);
    const early = await api(`/api/samples/${id}/appeal`, authed(alice, { method: 'POST' }));
    expect(early.status).toBe(409);
    expect((await decide(api, id, { action: 'reject', reason: 'speech' })).status).toBe(200);
    const before = await revision(id);
    expect((await api(`/api/samples/${id}/appeal`, authed(bob, { method: 'POST' }))).status).toBe(
      404,
    );
    const res = await api(`/api/samples/${id}/appeal`, authed(alice, { method: 'POST' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sample: { share: { state: string; reason: string | null; appealed_at: string | null } };
    };
    expect(body.sample.share.state).toBe('pending');
    expect(body.sample.share.reason).toBeNull();
    expect(body.sample.share.appealed_at).not.toBeNull();
    expect(await revision(id)).toBe(before + 1);
    const [item] = await queue(api);
    expect(item?.appeal?.of).toBe('speech');
    // The job checks it again.
    expect((await pendingForJob(api)).map((i) => i.id)).toEqual([id]);
    expect((await decide(api, id, { action: 'reject', reason: 'speech' })).status).toBe(200);
    const again = await api(`/api/samples/${id}/appeal`, authed(alice, { method: 'POST' }));
    expect(again.status).toBe(409);
    expect(((await again.json()) as ErrorJson).error.message).toContain('only once');
    const log = await new ModerationStore(env.DB).log(id);
    expect(log.filter((l) => l.action === 'appeal')).toHaveLength(1);
  });

  it('a listed appeal goes back into the bank', async () => {
    const api = client();
    const id = await pendingSample(api, 31);
    await decide(api, id, { action: 'reject', reason: 'other' });
    await api(`/api/samples/${id}/appeal`, authed(alice, { method: 'POST' }));
    expect((await decide(api, id, { action: 'list' })).status).toBe(200);
    const row = await env.DB.prepare('SELECT state, reason FROM shares WHERE sample_id = ?')
      .bind(id)
      .first();
    expect(row).toEqual({ state: 'listed', reason: null });
  });
});

describe('hard delete', () => {
  async function del(api: Api, token: string, id: string, confirm = id): Promise<Response> {
    return api(`/api/moderation/${id}/delete`, authed(token, json({ confirm })));
  }

  it('is for the maintainer, needs the confirmation and removes everything', async () => {
    const api = client();
    const id = await listedSample(api, 40);
    await api(`/api/samples/${id}/report`, authed(bob, json({ reason: 'hate' })));
    expect((await del(api, alice, id)).status).toBe(403);
    expect((await del(api, boss, id, 'yes')).status).toBe(400);
    expect((await env.SAVES.list({ prefix: 'samples/' })).objects.length).toBe(1);
    const res = await del(api, boss, id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    for (const table of ['samples', 'shares', 'reports']) {
      const column = table === 'samples' ? 'id' : 'sample_id';
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
        .bind(id)
        .first<{ n: number }>();
      expect(row?.n, table).toBe(0);
    }
    expect((await env.SAVES.list({ prefix: 'samples/' })).objects.length).toBe(0);
    const log = await new ModerationStore(env.DB).log(id);
    expect(log.at(-1)).toMatchObject({ actor: 'maintainer', action: 'delete' });
    expect((await del(api, boss, id)).status).toBe(404);
  });

  it('is refused while another user has the sample in a slot', async () => {
    const api = client();
    const id = await listedSample(api, 41);
    const take = await api(`/api/samples/${id}/take`, authed(bob, json({ slot: 'sampler-1' })));
    expect(take.status).toBe(200);
    const res = await del(api, boss, id);
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('sample_in_use');
  });

  it('keeps the R2 object while another owner has the same content', async () => {
    const api = client();
    const id = await pendingSample(api, 42);
    const same = await upload(api, bob, 42);
    expect((await del(api, boss, id)).status).toBe(200);
    const object = await env.SAVES.get(sampleKey(await sha256(wav(42))));
    expect(object).not.toBeNull();
    await object?.arrayBuffer();
    expect(same).not.toBe(id);
  });
});

describe('queue', () => {
  it('shows not-checked items with auto null and no reports', async () => {
    const api = client();
    await pendingSample(api, 50);
    const [item] = await queue(api);
    expect(item?.auto).toBeNull();
    expect(item?.reports).toEqual({ open: 0, reasons: {} });
    expect(item?.appeal).toBeNull();
    expect((await api('/api/moderation/queue?state=nope', authed(boss))).status).toBe(400);
  });
});
