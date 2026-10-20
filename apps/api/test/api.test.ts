import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp, parseIfMatch, readBounded } from '../src/app';
import { ApiError } from '../src/errors';
import { LIMITS } from '../src/record';
import { saveKey } from '../src/storage';
import {
  ORIGIN,
  authed,
  makeKey,
  putInit,
  record,
  signToken,
  staticJwks,
  testClient,
} from './helpers';
import type { ErrorJson, TestKey } from './helpers';

let key: TestKey;
let client: ReturnType<typeof testClient>;
let alice: string;
let bob: string;

beforeAll(async () => {
  key = await makeKey('api-key');
  client = testClient([key.jwk]);
  alice = await signToken({ key, email: 'alice@example.test' });
  bob = await signToken({ key, email: 'bob@example.test' });
});

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as ErrorJson).error.code;
}

async function userId(token: string): Promise<string> {
  const res = await client.request('/api/me', authed(token));
  return ((await res.json()) as { id: string }).id;
}

describe('authentication', () => {
  const routes: [string, string][] = [
    ['GET', '/api/me'],
    ['GET', '/api/saves'],
    ['GET', '/api/saves/a'],
    ['PUT', '/api/saves/a'],
    ['DELETE', '/api/saves/a'],
  ];

  it.each(routes)('%s %s without a token is 401', async (method, path) => {
    const res = await client.request(path, { method });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('unauthorized');
  });

  it.each(routes)('%s %s with a forged token is 401', async (method, path) => {
    const forger = await makeKey('api-key');
    const token = await signToken({ key: forger, email: 'alice@example.test' });
    const res = await client.request(path, authed(token, { method }));
    expect(res.status).toBe(401);
  });

  it('rejects an expired token, a wrong audience and a malformed header', async () => {
    const expired = await signToken({ key, email: 'a@example.test', expiresIn: -120 });
    const wrongAud = await signToken({ key, email: 'a@example.test', audience: 'other-app' });
    for (const token of [expired, wrongAud, 'garbage', 'a.b.c']) {
      const res = await client.request('/api/me', authed(token));
      expect(res.status).toBe(401);
    }
  });

  it('fails closed when Access is not configured', async () => {
    const app = createApp({ jwks: () => staticJwks([key.jwk]) });
    const res = await app.request('/api/me', authed(alice), { ...env, ACCESS_AUD: '' });
    expect(res.status).toBe(500);
    expect(await errorCode(res)).toBe('server_misconfigured');
    const missing = await app.request('/api/me', authed(alice), {
      ...env,
      ACCESS_TEAM_DOMAIN: undefined,
    });
    expect(missing.status).toBe(500);
    expect(await errorCode(missing)).toBe('server_misconfigured');
  });

  it('creates the user on first request and reuses it afterwards', async () => {
    const res = await client.request('/api/me', authed(alice));
    expect(res.status).toBe(200);
    const me = (await res.json()) as Record<string, unknown>;
    expect(me).toMatchObject({
      email: 'alice@example.test',
      save_count: 0,
      limits: { max_save_bytes: 262144, max_saves: 200 },
    });
    expect(me['id']).toMatch(/^[0-9a-f-]{36}$/);
    const upper = await signToken({ key, email: 'ALICE@example.test' });
    expect(await userId(upper)).toBe(me['id']);
    expect(await userId(bob)).not.toBe(me['id']);
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
    expect(rows?.n).toBe(2);
  });
});

describe('saves: happy path', () => {
  it('creates, reads, lists, updates and deletes a save', async () => {
    const created = await client.request('/api/saves/song-1', putInit(alice, record('song-1', 1)));
    expect(created.status).toBe(201);
    expect(created.headers.get('ETag')).toBe('"1"');
    const body = (await created.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ schema_version: 1, id: 'song-1', version: 1, title: 'My save' });
    expect(body['updated_at']).not.toBe('2000-01-01T00:00:00.000Z');

    const uid = await userId(alice);
    const object = await env.SAVES.get(saveKey(uid, 'song-1'));
    expect(object).not.toBeNull();
    expect(await object?.json()).toEqual(body);

    const got = await client.request('/api/saves/song-1', authed(alice));
    expect(got.status).toBe(200);
    expect(got.headers.get('ETag')).toBe('"1"');
    expect(await got.json()).toEqual(body);

    const updated = await client.request(
      '/api/saves/song-1',
      putInit(alice, record('song-1', 2, 'Renamed'), '"1"'),
    );
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as { version: number }).version).toBe(2);

    await client.request('/api/saves/song-2', putInit(alice, record('song-2', 1, 'Second')));
    const list = await client.request('/api/saves', authed(alice));
    const { saves } = (await list.json()) as { saves: { id: string; version: number }[] };
    expect(saves.map((s) => [s.id, s.version]).sort()).toEqual([
      ['song-1', 2],
      ['song-2', 1],
    ]);
    expect(Object.keys(saves[0] ?? {}).sort()).toEqual(['id', 'title', 'updated_at', 'version']);

    const del = await client.request('/api/saves/song-1', authed(alice, { method: 'DELETE' }));
    expect(del.status).toBe(204);
    expect(await env.SAVES.get(saveKey(uid, 'song-1'))).toBeNull();
    const gone = await client.request('/api/saves/song-1', authed(alice));
    expect(gone.status).toBe(404);
    const again = await client.request('/api/saves/song-1', authed(alice, { method: 'DELETE' }));
    expect(again.status).toBe(404);
  });

  it('keeps users apart', async () => {
    await client.request('/api/saves/private', putInit(alice, record('private', 1)));
    const res = await client.request('/api/saves/private', authed(bob));
    expect(res.status).toBe(404);
    const list = await client.request('/api/saves', authed(bob));
    expect(((await list.json()) as { saves: unknown[] }).saves).toEqual([]);
    const del = await client.request('/api/saves/private', authed(bob, { method: 'DELETE' }));
    expect(del.status).toBe(404);
  });

  it('stores the song normalised by validateSong', async () => {
    const input = record('norm', 1);
    input['song'] = { ...(input['song'] as object), extra: 'dropped' };
    const res = await client.request('/api/saves/norm', putInit(alice, input));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { song: Record<string, unknown> };
    expect(body.song['extra']).toBeUndefined();
    expect(body.song['schema']).toBe(2);
  });
});

describe('saves: version conflicts', () => {
  it('rejects a stale write with 409 and the current metadata', async () => {
    await client.request('/api/saves/c1', putInit(alice, record('c1', 1)));
    await client.request('/api/saves/c1', putInit(alice, record('c1', 2)));
    const stale = await client.request('/api/saves/c1', putInit(alice, record('c1', 2), '"1"'));
    expect(stale.status).toBe(409);
    const err = (await stale.json()) as ErrorJson;
    expect(err.error.code).toBe('conflict');
    expect(err.error.current).toMatchObject({ id: 'c1', version: 2 });

    const staleBody = await client.request('/api/saves/c1', putInit(alice, record('c1', 2)));
    expect(staleBody.status).toBe(409);
  });

  it('rejects re-creating an existing save', async () => {
    await client.request('/api/saves/c2', putInit(alice, record('c2', 1)));
    const res = await client.request('/api/saves/c2', putInit(alice, record('c2', 1)));
    expect(res.status).toBe(409);
  });

  it('rejects an update of a save that does not exist', async () => {
    const res = await client.request('/api/saves/c3', putInit(alice, record('c3', 4), '"3"'));
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorJson).error.current).toBeNull();
  });

  it('lets only one of two concurrent writers with the same base win', async () => {
    await client.request('/api/saves/c4', putInit(alice, record('c4', 1)));
    const results = await Promise.all([
      client.request('/api/saves/c4', putInit(alice, record('c4', 2, 'tab A'), '"1"')),
      client.request('/api/saves/c4', putInit(alice, record('c4', 2, 'tab B'), '"1"')),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('requires If-Match + 1 as the new version', async () => {
    await client.request('/api/saves/c5', putInit(alice, record('c5', 1)));
    const res = await client.request('/api/saves/c5', putInit(alice, record('c5', 3), '"1"'));
    expect(res.status).toBe(400);
  });

  it('checks If-Match on delete', async () => {
    await client.request('/api/saves/c6', putInit(alice, record('c6', 1)));
    const stale = await client.request(
      '/api/saves/c6',
      authed(alice, { method: 'DELETE', headers: { 'If-Match': '"7"' } }),
    );
    expect(stale.status).toBe(409);
    const ok = await client.request(
      '/api/saves/c6',
      authed(alice, { method: 'DELETE', headers: { 'If-Match': 'W/"1"' } }),
    );
    expect(ok.status).toBe(204);
  });

  it('parses If-Match strictly', () => {
    expect(parseIfMatch(undefined)).toBeUndefined();
    expect(parseIfMatch('"0"')).toBe(0);
    expect(parseIfMatch(' W/"12" ')).toBe(12);
    for (const bad of ['*', '1', '"a"', '"1", "2"', '"-1"']) {
      expect(() => parseIfMatch(bad)).toThrow(ApiError);
    }
  });
});

describe('saves: validation and limits', () => {
  it('rejects a body over 256 KiB with 413', async () => {
    const big = record('big', 1, 'x'.repeat(10));
    big['padding'] = 'x'.repeat(LIMITS.maxSaveBytes);
    const res = await client.request('/api/saves/big', putInit(alice, big));
    expect(res.status).toBe(413);
    expect(await errorCode(res)).toBe('payload_too_large');
  });

  it('rejects an oversized body even without a Content-Length header', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(64 * 1024));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 5; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const res = await client.request(
      '/api/saves/big2',
      authed(alice, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: stream,
      }),
    );
    expect(res.status).toBe(413);
  });

  it('stops reading a chunked body as soon as it passes the limit', async () => {
    const chunk = new Uint8Array(64 * 1024);
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(chunk);
        if (pulled >= 100) controller.close();
      },
    });
    const req = new Request('https://api.example.test/', {
      method: 'PUT',
      body: stream,
      // @ts-expect-error duplex is required for a streaming body but missing from the types
      duplex: 'half',
    });
    await expect(readBounded(req, LIMITS.maxSaveBytes)).rejects.toMatchObject({
      code: 'payload_too_large',
    });
    expect(pulled).toBeLessThan(10);
  });

  it('reads a body within the limit completely', async () => {
    const req = new Request('https://api.example.test/', { method: 'PUT', body: 'x'.repeat(1000) });
    expect((await readBounded(req, 1000)).byteLength).toBe(1000);
    const empty = new Request('https://api.example.test/', { method: 'PUT' });
    expect((await readBounded(empty, 1000)).byteLength).toBe(0);
  });

  it('accepts a body just under the limit', async () => {
    const input = record('near', 1);
    const base = JSON.stringify(input).length;
    input['padding'] = 'x'.repeat(LIMITS.maxSaveBytes - base - 20);
    const res = await client.request('/api/saves/near', putInit(alice, input));
    expect(res.status).toBe(201);
    expect(((await res.json()) as Record<string, unknown>)['padding']).toBeUndefined();
  });

  it.each([
    ['bad JSON', '{not json'],
    ['wrong schema_version', JSON.stringify({ ...record('v', 1), schema_version: 2 })],
    ['id mismatch', JSON.stringify(record('other', 1))],
    ['version 0', JSON.stringify(record('v', 0))],
    ['fractional version', JSON.stringify(record('v', 1.5))],
    ['missing song', JSON.stringify({ ...record('v', 1), song: undefined })],
    ['invalid song', JSON.stringify({ ...record('v', 1), song: { schema: 2, chords: 'nope' } })],
    ['title too long', JSON.stringify(record('v', 1, 'x'.repeat(201)))],
  ])('rejects %s with 400', async (_name, body) => {
    const res = await client.request(
      '/api/saves/v',
      authed(alice, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body }),
    );
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('invalid_request');
  });

  it('rejects a non-JSON content type with 415', async () => {
    const res = await client.request(
      '/api/saves/v',
      authed(alice, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(record('v', 1)),
      }),
    );
    expect(res.status).toBe(415);
  });

  it('treats invalid save ids as not found', async () => {
    const res = await client.request(`/api/saves/${'x'.repeat(65)}`, authed(alice));
    expect(res.status).toBe(404);
    const dots = await client.request('/api/saves/a.b', authed(alice));
    expect(dots.status).toBe(404);
  });

  it('caps the number of saves per user, but still allows updates', async () => {
    const carol = await signToken({ key, email: 'carol@example.test' });
    const uid = await userId(carol);
    const now = new Date().toISOString();
    const insert = env.DB.prepare(
      'INSERT INTO saves (user_id, id, version, updated_at, title, size) VALUES (?, ?, 1, ?, ?, 1)',
    );
    await env.DB.batch(
      Array.from({ length: LIMITS.maxSaves - 1 }, (_, i) =>
        insert.bind(uid, `s${i}`, now, `S${i}`),
      ),
    );
    const last = await client.request('/api/saves/last', putInit(carol, record('last', 1)));
    expect(last.status).toBe(201);
    const over = await client.request('/api/saves/over', putInit(carol, record('over', 1)));
    expect(over.status).toBe(403);
    expect(await errorCode(over)).toBe('save_limit_reached');
    const update = await client.request('/api/saves/last', putInit(carol, record('last', 2)));
    expect(update.status).toBe(200);
  });

  it('never exceeds the cap when new saves are created concurrently', async () => {
    const dave = await signToken({ key, email: 'dave@example.test' });
    const uid = await userId(dave);
    const now = new Date().toISOString();
    const insert = env.DB.prepare(
      'INSERT INTO saves (user_id, id, version, updated_at, title, size) VALUES (?, ?, 1, ?, ?, 1)',
    );
    await env.DB.batch(
      Array.from({ length: LIMITS.maxSaves - 2 }, (_, i) =>
        insert.bind(uid, `s${i}`, now, `S${i}`),
      ),
    );
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        client.request(`/api/saves/race${i}`, putInit(dave, record(`race${i}`, 1))),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 201, 403, 403, 403, 403]);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM saves WHERE user_id = ?')
      .bind(uid)
      .first<{ n: number }>();
    expect(count?.n).toBe(LIMITS.maxSaves);
  });
});

describe('CORS and headers', () => {
  it('answers a preflight from the allowed origin', async () => {
    const res = await client.request('/api/saves/a', {
      method: 'OPTIONS',
      headers: {
        Origin: ORIGIN,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type, if-match',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
  });

  it('refuses any other origin, before authentication', async () => {
    const pre = await client.request('/api/saves', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example.test', 'Access-Control-Request-Method': 'GET' },
    });
    expect(pre.status).toBe(403);
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const res = await client.request(
      '/api/me',
      authed(alice, { headers: { Origin: 'https://evil.example.test' } }),
    );
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('forbidden_origin');
  });

  it("refuses the request's own origin unless it is ALLOWED_ORIGIN (no previews)", async () => {
    const self = 'https://api.example.test';
    const put = await client.request(
      '/api/saves/same-origin',
      putInit(alice, record('same-origin', 1)),
    );
    expect(put.status).toBe(201);
    const del = await client.request(
      '/api/saves/same-origin',
      authed(alice, { method: 'DELETE', headers: { Origin: self, 'If-Match': '"1"' } }),
    );
    expect(del.status).toBe(403);
    expect(await errorCode(del)).toBe('forbidden_origin');
    const allowed = await client.request(
      '/api/saves/same-origin',
      authed(alice, { method: 'DELETE', headers: { Origin: ORIGIN, 'If-Match': '"1"' } }),
    );
    expect(allowed.status).toBe(204);
  });

  it('refuses a foreign origin that only shares the host name', async () => {
    const res = await client.request(
      '/api/me',
      authed(alice, { headers: { Origin: 'http://api.example.test' } }),
    );
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('forbidden_origin');
  });

  it('sets CORS and security headers on success and error responses', async () => {
    for (const init of [
      authed(alice, { headers: { Origin: ORIGIN } }),
      { headers: { Origin: ORIGIN } },
    ]) {
      const res = await client.request('/api/me', init);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
      expect(res.headers.get('Content-Security-Policy')).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    }
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const res = await client.request('/nope', authed(alice));
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('not_found');
  });
});

describe('storage failures', () => {
  it('rolls the version claim back when the R2 write fails', async () => {
    const failing: R2Bucket = Object.create(env.SAVES, {
      put: { value: () => Promise.reject(new Error('r2 down')) },
    });
    const app = createApp({ jwks: () => staticJwks([key.jwk]) });
    const res = await app.request(
      'https://api.example.test/api/saves/r1',
      putInit(alice, record('r1', 1)),
      { ...env, SAVES: failing },
    );
    expect(res.status).toBe(500);
    expect(await errorCode(res)).toBe('internal');
    const list = await client.request('/api/saves', authed(alice));
    const { saves } = (await list.json()) as { saves: { id: string }[] };
    expect(saves.find((s) => s.id === 'r1')).toBeUndefined();
    const retry = await client.request('/api/saves/r1', putInit(alice, record('r1', 1)));
    expect(retry.status).toBe(201);
  });
});
