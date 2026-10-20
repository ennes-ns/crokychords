import { createSong } from '@crokychords/core';
import { describe, expect, it } from 'vitest';
import type { SaveRecord } from '../src/store/record';
import { VersionConflictError, makeRecord } from '../src/store/record';
import { SyncError } from '../src/store/sync';
import { DEFAULT_SYNC_BASE_URL, syncConfig } from '../src/sync/config';
import type { ResponseLike } from '../src/sync/http';
import { HttpSyncClient, INVALID_RECORD, parseSaveMeta } from '../src/sync/http';
import { FakeApi } from './fakeApi';

function rec(id: string, version: number, title = id): SaveRecord {
  return makeRecord(createSong({ title }), {
    id,
    version,
    now: new Date('2026-10-20T12:00:00.000Z'),
  });
}

function setup(online = true) {
  const api = new FakeApi();
  const client = new HttpSyncClient({ baseUrl: '/api/', fetch: api.fetch, online: () => online });
  return { api, client };
}

describe('syncConfig', () => {
  it('is disabled unless VITE_SYNC is on', () => {
    expect(syncConfig({})).toEqual({ enabled: false, baseUrl: DEFAULT_SYNC_BASE_URL });
    expect(syncConfig({ VITE_SYNC: 'off' }).enabled).toBe(false);
    expect(syncConfig({ VITE_SYNC: true }).enabled).toBe(false);
    for (const on of ['on', 'true', '1', ' ON '])
      expect(syncConfig({ VITE_SYNC: on }).enabled).toBe(true);
  });

  it('uses same-origin /api unless VITE_SYNC_API is set, without a trailing slash', () => {
    expect(syncConfig({ VITE_SYNC: 'on' }).baseUrl).toBe('/api');
    expect(syncConfig({ VITE_SYNC: 'on', VITE_SYNC_API: '  ' }).baseUrl).toBe('/api');
    expect(syncConfig({ VITE_SYNC_API: 'https://api.example.com/v1/' }).baseUrl).toBe(
      'https://api.example.com/v1',
    );
  });
});

describe('HttpSyncClient', () => {
  it('creates and updates with If-Match and the remote version', async () => {
    const { api, client } = setup();
    const created = await client.push(rec('a', 7), 0);
    expect(created.status).toBe('ok');
    expect(created.status === 'ok' && created.record?.version).toBe(1);
    expect(api.requests.at(-1)).toEqual({ method: 'PUT', path: '/saves/a', ifMatch: '"0"' });
    const updated = await client.push(rec('a', 9, 'renamed'), 1);
    expect(updated.status === 'ok' && updated.record?.version).toBe(2);
    expect(api.saves.get('a')?.title).toBe('renamed');
    expect(api.requests.at(-1)?.ifMatch).toBe('"1"');
  });

  it('lists metadata and gets records', async () => {
    const { api, client } = setup();
    api.remoteWrite(rec('a', 1));
    expect(await client.list()).toEqual([api.meta('a')]);
    expect((await client.get('a'))?.id).toBe('a');
    expect(await client.get('missing')).toBeNull();
  });

  it('reports a 409 as a conflict with the current remote record', async () => {
    const { api, client } = setup();
    api.remoteWrite(rec('a', 1, 'theirs'));
    api.remoteWrite(rec('a', 1, 'theirs again'));
    const result = await client.push(rec('a', 4, 'mine'), 1);
    expect(result.status).toBe('conflict');
    if (result.status !== 'conflict') return;
    expect(result.remote?.title).toBe('theirs again');
    expect(result.error).toBeInstanceOf(VersionConflictError);
    expect(result.error).toMatchObject({ id: 'a', expected: 3, actual: 2 });
  });

  it('reports a conflict with a deleted save as remote null', async () => {
    const { api, client } = setup();
    api.remoteWrite(rec('a', 1));
    api.saves.delete('a');
    const result = await client.push(rec('a', 2), 1);
    expect(result).toMatchObject({ status: 'conflict', remote: null });
  });

  it('deletes with If-Match; a missing save counts as deleted; a stale version conflicts', async () => {
    const { api, client } = setup();
    api.remoteWrite(rec('a', 1));
    api.remoteWrite(rec('a', 1));
    const stale = await client.remove('a', 1);
    expect(stale.status === 'conflict' && stale.remote?.version).toBe(2);
    expect(await client.remove('a', 2)).toEqual({ status: 'ok', record: null });
    expect(api.saves.has('a')).toBe(false);
    expect(await client.remove('a', 2)).toEqual({ status: 'ok', record: null });
  });

  it('classifies failures', async () => {
    const { api, client } = setup();
    const kind = async (p: Promise<unknown>) =>
      p.then(
        () => 'resolved',
        (e: unknown) => (e instanceof SyncError ? e.kind : 'other'),
      );
    api.mode = 'offline';
    expect(await kind(client.list())).toBe('offline');
    api.mode = 'unauthorized';
    expect(await kind(client.list())).toBe('signed-out');
    api.mode = 'redirect';
    expect(await kind(client.push(rec('a', 1), 0))).toBe('signed-out');
    api.mode = 'html';
    expect(await kind(client.get('a'))).toBe('server');
    api.mode = 'error';
    expect(await kind(client.list())).toBe('server');
    api.mode = 'ok';
    api.maxBytes = 10;
    expect(await kind(client.push(rec('a', 1), 0))).toBe('rejected');
    api.maxBytes = 262_144;
    api.maxSaves = 0;
    const limit = await client.push(rec('a', 1), 0).catch((e: unknown) => e);
    expect(limit).toMatchObject({ kind: 'rejected', code: 'save_limit_reached' });
  });

  it('classifies non-JSON (edge) answers by status, not as signed out', async () => {
    const { api, client } = setup();
    api.remoteWrite(rec('a', 1));
    let status = 0;
    api.edge = () => status;
    const failure = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: unknown) => (e instanceof SyncError ? { kind: e.kind, code: e.code } : null),
      );
    const signedOut = { kind: 'signed-out', code: null };
    const transient = { kind: 'server', code: null };
    for (status of [401, 403]) {
      expect(await failure(client.list())).toEqual(signedOut);
      expect(await failure(client.get('a'))).toEqual(signedOut);
      expect(await failure(client.push(rec('a', 2), 1))).toEqual(signedOut);
      expect(await failure(client.remove('a', 1))).toEqual(signedOut);
    }
    for (status of [404, 413, 415]) {
      // Per record: a write is refused, a read is skipped like an unreadable save.
      expect(await failure(client.push(rec('a', 2), 1))).toEqual({ kind: 'rejected', code: null });
      expect(await failure(client.remove('a', 1))).toEqual({ kind: 'rejected', code: null });
      expect(await failure(client.get('a'))).toEqual({ kind: 'server', code: INVALID_RECORD });
      // The list is not one record: back off and retry.
      expect(await failure(client.list())).toEqual(transient);
    }
    for (status of [200, 400, 405, 418]) {
      expect(await failure(client.list())).toEqual(transient);
      expect(await failure(client.get('a'))).toEqual(transient);
      expect(await failure(client.push(rec('a', 2), 1))).toEqual(transient);
      expect(await failure(client.remove('a', 1))).toEqual(transient);
    }
    expect(api.saves.get('a')?.version).toBe(1);
  });

  it('does not touch the network while the browser is offline', async () => {
    const { api, client } = setup(false);
    await expect(client.list()).rejects.toMatchObject({ kind: 'offline' });
    expect(api.requests).toEqual([]);
  });

  it('treats 403 forbidden_origin and real 3xx redirects as signed out', async () => {
    const answer = (status: number, body: unknown): ResponseLike => ({
      status,
      type: 'basic',
      redirected: false,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve(body),
    });
    const forbidden = new HttpSyncClient({
      baseUrl: '/api',
      fetch: () =>
        Promise.resolve(answer(403, { error: { code: 'forbidden_origin', message: 'origin' } })),
    });
    await expect(forbidden.list()).rejects.toMatchObject({ kind: 'signed-out' });
    const redirect = new HttpSyncClient({
      baseUrl: '/api',
      fetch: () => Promise.resolve(answer(302, null)),
    });
    await expect(redirect.list()).rejects.toMatchObject({ kind: 'signed-out' });
  });

  it('rejects malformed server answers as server errors', async () => {
    const client = (body: unknown) =>
      new HttpSyncClient({
        baseUrl: '/api',
        fetch: () =>
          Promise.resolve({
            status: 200,
            type: 'basic',
            redirected: false,
            headers: { get: () => 'application/json' },
            json: () => Promise.resolve(body),
          }),
      });
    await expect(client({ nope: true }).list()).rejects.toMatchObject({ kind: 'server' });
    await expect(client({ saves: [{ id: 'a' }] }).list()).rejects.toMatchObject({
      kind: 'server',
    });
    await expect(client({ id: 'a' }).get('a')).rejects.toMatchObject({ kind: 'server' });
    expect(() => parseSaveMeta({ id: 'a b', version: 1, updated_at: 'x', title: '' })).toThrow(
      SyncError,
    );
  });
});
