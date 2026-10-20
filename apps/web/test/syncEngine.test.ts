import type { Song } from '@crokychords/core';
import { createSong } from '@crokychords/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store, initialState } from '../src/state';
import type { SaveRecord } from '../src/store/record';
import { makeRecord } from '../src/store/record';
import type { SaveStore } from '../src/store/saveStore';
import { MemorySaveStore } from '../src/store/saveStore';
import { SaveSession } from '../src/store/session';
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  SyncEngine,
  backoffDelay,
  bindSyncEvents,
} from '../src/sync/engine';
import { HttpSyncClient } from '../src/sync/http';
import { MemorySyncState } from '../src/sync/state';
import { syncLabel, syncStatusView } from '../src/sync/statusView';
import { FakeApi } from './fakeApi';

const NOW = new Date('2026-10-20T12:00:00.000Z');

function song(title: string, extra = 0): Song {
  return createSong({ title, tempo: 100 + extra });
}

function rec(id: string, version: number, title = id, extra = 0): SaveRecord {
  return makeRecord(song(title, extra), { id, version, now: NOW });
}

interface DeviceOptions {
  online?: () => boolean;
  focusIntervalMs?: number;
  clock?: () => Date;
}

function device(api: FakeApi, name: string, options: DeviceOptions = {}) {
  const local = new MemorySaveStore();
  const state = new MemorySyncState();
  let n = 0;
  const engine = new SyncEngine({
    client: new HttpSyncClient({ baseUrl: '/api', fetch: api.fetch }),
    local,
    state,
    newId: () => `${name}-copy${++n}`,
    now: options.clock ?? (() => NOW),
    random: () => 0,
    pushDelayMs: 10,
    ...(options.online !== undefined ? { online: options.online } : {}),
    ...(options.focusIntervalMs !== undefined ? { focusIntervalMs: options.focusIntervalMs } : {}),
  });
  const saves = engine.wrap();
  const changes: [string, string | null][] = [];
  engine.onRemoteChange((id, copyId) => {
    changes.push([id, copyId]);
  });
  return { local, state, engine, saves, changes };
}

/** Save the next local version of `id` through the wrapped store. */
async function edit(saves: SaveStore, id: string, title: string, extra = 0): Promise<SaveRecord> {
  const current = await saves.get(id);
  return saves.put(rec(id, (current?.version ?? 0) + 1, title, extra));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('backoffDelay', () => {
  it('doubles from the base up to the cap, scaled by [0.5, 1)', () => {
    expect(backoffDelay(1, 0)).toBe(BACKOFF_BASE_MS / 2);
    expect(backoffDelay(2, 0)).toBe(BACKOFF_BASE_MS);
    expect(backoffDelay(3, 0.999)).toBeLessThan(BACKOFF_BASE_MS * 4);
    expect(backoffDelay(40, 0)).toBe(BACKOFF_MAX_MS / 2);
  });
});

describe('SyncEngine: happy path', () => {
  it('pushes the newest local version once, mapping local and remote versions', async () => {
    const api = new FakeApi();
    const a = device(api, 'a');
    await edit(a.saves, 's1', 'one');
    await edit(a.saves, 's1', 'two');
    await edit(a.saves, 's1', 'three');
    expect(a.engine.status.pending).toBe(1);
    await a.engine.sync('push');
    expect(api.count('PUT')).toBe(1);
    expect(api.saves.get('s1')).toMatchObject({ version: 1, title: 'three' });
    expect(await a.state.get('s1')).toMatchObject({ remote: 1, local: 3 });
    expect(a.engine.status).toEqual({ state: 'synced', pending: 0, message: null });

    await edit(a.saves, 's1', 'four');
    await a.engine.sync('push');
    expect(api.requests.at(-1)).toMatchObject({ method: 'PUT', ifMatch: '"1"' });
    expect(api.saves.get('s1')).toMatchObject({ version: 2, title: 'four' });
    expect((await a.local.get('s1'))?.version).toBe(4);
  });

  it('pulls new and changed saves to another device and skips unchanged ones', async () => {
    const api = new FakeApi();
    const a = device(api, 'a');
    const b = device(api, 'b');
    await edit(a.saves, 's1', 'one');
    await a.engine.sync();
    await b.engine.sync();
    expect(await b.local.get('s1')).toMatchObject({ version: 1, title: 'one' });
    expect(b.changes).toEqual([['s1', null]]);

    await edit(a.saves, 's1', 'one, edited');
    await a.engine.sync();
    const gets = api.count('GET');
    await b.engine.sync();
    expect(api.count('GET')).toBe(gets + 2); // the list and the one changed save
    expect(await b.local.get('s1')).toMatchObject({ version: 2, title: 'one, edited' });

    await b.engine.sync();
    expect(api.count('GET')).toBe(gets + 3); // only the list
    expect(api.count('PUT')).toBe(2);
  });

  it('pushes after a quiet period when the wrapped store is written', async () => {
    vi.useFakeTimers();
    const api = new FakeApi();
    const a = device(api, 'a');
    await edit(a.saves, 's1', 'one');
    await edit(a.saves, 's1', 'two');
    expect(api.count('PUT')).toBe(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(api.count('PUT')).toBe(1);
    expect(api.saves.get('s1')?.title).toBe('two');
  });

  it('adopts a matching remote record when the sync state was lost', async () => {
    const api = new FakeApi();
    const a = device(api, 'a');
    await edit(a.saves, 's1', 'one');
    await a.engine.sync();
    const fresh = new SyncEngine({
      client: new HttpSyncClient({ baseUrl: '/api', fetch: api.fetch }),
      local: a.local,
      state: new MemorySyncState(),
    });
    await fresh.sync();
    expect(api.count('PUT')).toBe(1);
    expect((await a.local.list()).map((s) => s.id)).toEqual(['s1']);
    expect(fresh.status.state).toBe('synced');
  });
});

describe('SyncEngine: conflicts', () => {
  async function diverged() {
    const api = new FakeApi();
    const a = device(api, 'a');
    const b = device(api, 'b');
    await edit(a.saves, 's1', 'base');
    await a.engine.sync();
    await b.engine.sync();
    await edit(b.saves, 's1', 'theirs', 1);
    await b.engine.sync();
    await edit(a.saves, 's1', 'mine', 2);
    return { api, a, b };
  }

  it('on push: the remote version takes the id, the local one survives as a synced copy', async () => {
    const { api, a } = await diverged();
    await a.engine.sync('push');
    expect(await a.local.get('s1')).toMatchObject({ title: 'theirs', version: 3 });
    const copy = await a.local.get('a-copy1');
    expect(copy).toMatchObject({ version: 1, title: 'mine (copy)' });
    expect(copy?.song.tempo).toBe(102);
    expect(a.changes).toEqual([['s1', 'a-copy1']]);
    expect(api.saves.get('a-copy1')?.title).toBe('mine (copy)');
    expect(api.saves.get('s1')).toMatchObject({ title: 'theirs', version: 2 });
    expect(a.engine.status.state).toBe('synced');
  });

  it('on pull: the same rule applies before anything is pushed', async () => {
    const { api, a } = await diverged();
    const puts = api.count('PUT');
    await a.engine.sync('full');
    expect(await a.local.get('s1')).toMatchObject({ title: 'theirs' });
    expect(await a.local.get('a-copy1')).toMatchObject({ title: 'mine (copy)' });
    expect(api.count('PUT')).toBe(puts + 1); // only the copy
    expect(api.saves.size).toBe(2);
  });

  it('keeps one copy when editor saves win the conflict write twice in a row', async () => {
    const { api, a } = await diverged();
    const put = a.local.put.bind(a.local);
    let races = 0;
    vi.spyOn(a.local, 'put').mockImplementation(async (record) => {
      if (record.id === 's1' && record.title === 'theirs' && races < 2) {
        races++;
        // An autosave lands first, so storing the remote version loses the local race.
        await put(rec('s1', record.version, `mine ${races}`, 2 + races));
      }
      return put(record);
    });
    await a.engine.sync('push');
    await a.engine.sync('push');
    expect(races).toBe(2);
    expect((await a.local.list()).map((r) => r.id).sort()).toEqual(['a-copy1', 's1']);
    expect(await a.local.get('s1')).toMatchObject({ title: 'theirs' });
    const copy = await a.local.get('a-copy1');
    expect(copy).toMatchObject({ title: 'mine 2 (copy)', version: 3 });
    expect(copy?.song.tempo).toBe(104);
    expect(a.changes).toEqual([['s1', 'a-copy1']]);
    expect([...api.saves.keys()].sort()).toEqual(['a-copy1', 's1']);
    expect(api.saves.get('a-copy1')?.title).toBe('mine 2 (copy)');
    expect(a.engine.status.state).toBe('synced');
  });

  it('recreates a save that was deleted elsewhere while it was edited here', async () => {
    const { api, a } = await diverged();
    api.saves.delete('s1');
    await a.engine.sync('push');
    expect(api.saves.get('s1')).toMatchObject({ title: 'mine', version: 1 });
    expect(a.changes).toEqual([]);
  });
});

describe('SyncEngine: tombstones and remote deletes', () => {
  it('sends a delete with If-Match and forgets the tombstone', async () => {
    const api = new FakeApi();
    const a = device(api, 'a');
    await edit(a.saves, 's1', 'one');
    await a.engine.sync();
    await a.saves.delete('s1');
    expect(await a.state.get('s1')).toMatchObject({ deleted: true, remote: 1 });
    expect(a.engine.status.pending).toBe(1);
    await a.engine.sync();
    expect(api.requests.at(-1)).toMatchObject({ method: 'DELETE', ifMatch: '"1"' });
    expect(api.saves.has('s1')).toBe(false);
    expect(await a.state.get('s1')).toBeUndefined();
  });

  it('never sends anything for a save that was created and deleted offline', async () => {
    const api = new FakeApi();
    const a = device(api, 'a');
    await edit(a.saves, 's1', 'one');
    await a.saves.delete('s1');
    await a.engine.sync();
    expect(api.requests.map((r) => r.method)).toEqual(['GET']);
  });

  it('lets an edit made elsewhere win over a local delete (pull and push paths)', async () => {
    for (const kind of ['full', 'push'] as const) {
      const api = new FakeApi();
      const a = device(api, 'a');
      const b = device(api, 'b');
      await edit(a.saves, 's1', 'one');
      await a.engine.sync();
      await b.engine.sync();
      await edit(b.saves, 's1', 'edited elsewhere');
      await b.engine.sync();
      await a.saves.delete('s1');
      await a.engine.sync(kind);
      expect(api.saves.get('s1')?.title).toBe('edited elsewhere');
      expect(await a.local.get('s1')).toMatchObject({ title: 'edited elsewhere', version: 1 });
      expect(await a.state.get('s1')).toMatchObject({ deleted: false, remote: 2, local: 1 });
      expect(a.changes).toEqual([['s1', null]]);
    }
  });

  it('applies a delete from another device to an unchanged local save', async () => {
    const api = new FakeApi();
    const a = device(api, 'a');
    const b = device(api, 'b');
    await edit(a.saves, 's1', 'one');
    await a.engine.sync();
    await b.engine.sync();
    await b.saves.delete('s1');
    await b.engine.sync();
    await a.engine.sync();
    expect(await a.local.get('s1')).toBeNull();
    expect(await a.state.get('s1')).toBeUndefined();
    expect(a.changes).toEqual([['s1', null]]);
  });

  it('downloads a save again when its local copy vanished without a tombstone', async () => {
    const api = new FakeApi();
    const a = device(api, 'a');
    await edit(a.saves, 's1', 'one');
    await a.engine.sync();
    await a.local.delete('s1'); // the inner store: no tombstone
    await a.engine.sync();
    expect(await a.local.get('s1')).toMatchObject({ title: 'one' });
    expect(api.saves.has('s1')).toBe(true);
  });
});

describe('SyncEngine: review fixes', () => {
  it('does not copy when a PUT succeeded but its response was lost', async () => {
    const api = new FakeApi();
    const a = device(api, 'a');
    await edit(a.saves, 's1', 'one');
    api.dropNextResponse = true;
    await a.engine.sync('push');
    expect(a.engine.status.state).toBe('offline');
    expect(api.saves.get('s1')).toMatchObject({ version: 1, title: 'one' });
    // The same content saved again as the next local version (e.g. an undo back to it).
    const first = await a.saves.get('s1');
    await a.saves.put({ ...(first as SaveRecord), version: 2 });
    await a.engine.sync('push');
    expect(api.requests.at(-1)).toMatchObject({ method: 'GET', path: '/saves/s1' }); // the 409
    expect((await a.local.list()).map((s) => s.id)).toEqual(['s1']);
    expect(a.changes).toEqual([]);
    expect(await a.state.get('s1')).toMatchObject({ remote: 1, local: 2 });
    expect(a.engine.status.state).toBe('synced');
  });

  it('keeps a save deleted that was deleted during its first upload', async () => {
    const api = new FakeApi();
    const a = device(api, 'a');
    await edit(a.saves, 's1', 'one');
    api.beforeHandle = async (method) => {
      if (method !== 'PUT') return;
      api.beforeHandle = null;
      await a.saves.delete('s1');
    };
    await a.engine.sync('push');
    await a.engine.sync('full');
    expect(await a.local.get('s1')).toBeNull();
    expect(api.saves.has('s1')).toBe(false);
    expect(await a.state.get('s1')).toBeUndefined();
    expect(api.count('DELETE')).toBe(1);
  });

  it('skips one unreadable remote save and still syncs the rest', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const api = new FakeApi();
    const a = device(api, 'a');
    api.remoteWrite(rec('bad', 1));
    api.remoteWrite(rec('good', 1));
    api.corrupt.add('bad');
    await edit(a.saves, 'mine', 'mine');
    await a.engine.sync();
    expect(await a.local.get('good')).not.toBeNull();
    expect(await a.local.get('bad')).toBeNull();
    expect(api.saves.has('mine')).toBe(true);
    expect(a.engine.status.state).toBe('error');
    expect(a.engine.status.message).toContain('1 save(s)');
    await a.engine.sync();
    expect(console.warn).toHaveBeenCalledOnce();
    api.corrupt.clear();
    await a.engine.sync();
    expect(await a.local.get('bad')).not.toBeNull();
    expect(a.engine.status.state).toBe('synced');
  });
});

describe('SyncEngine: offline, signed out, rejected', () => {
  it('queues while offline and replays with exponential backoff', async () => {
    vi.useFakeTimers();
    const api = new FakeApi();
    const a = device(api, 'a');
    api.mode = 'offline';
    await edit(a.saves, 's1', 'one');
    await edit(a.saves, 's2', 'two');
    await vi.advanceTimersByTimeAsync(10);
    expect(a.engine.status).toMatchObject({ state: 'offline', pending: 2 });
    const tries = () => api.requests.length;
    expect(tries()).toBe(1);
    // Edits while backing off do not cut the wait short.
    await edit(a.saves, 's1', 'one, offline edit');
    await vi.advanceTimersByTimeAsync(20);
    expect(tries()).toBe(1);
    await vi.advanceTimersByTimeAsync(backoffDelay(1, 0) - 20);
    expect(tries()).toBe(2);
    await vi.advanceTimersByTimeAsync(backoffDelay(2, 0) - 1);
    expect(tries()).toBe(2); // the second retry waits twice as long
    api.mode = 'ok';
    const putsBefore = api.count('PUT');
    await vi.advanceTimersByTimeAsync(backoffDelay(2, 0));
    expect(a.engine.status).toEqual({ state: 'synced', pending: 0, message: null });
    expect(api.saves.get('s1')?.title).toBe('one, offline edit');
    expect(api.saves.has('s2')).toBe(true);
    expect(api.count('PUT') - putsBefore).toBe(2); // one per save, offline edits coalesced
  });

  it('retries at once when the browser comes back online', async () => {
    vi.useFakeTimers();
    let online = false;
    const api = new FakeApi();
    const a = device(api, 'a', { online: () => online });
    await edit(a.saves, 's1', 'one');
    await vi.advanceTimersByTimeAsync(10);
    expect(a.engine.status.state).toBe('offline');
    expect(api.requests).toEqual([]);
    online = true;
    a.engine.online();
    await vi.advanceTimersByTimeAsync(0);
    expect(a.engine.status.state).toBe('synced');
  });

  it('stops on signed-out without retrying, and tries again only on focus', async () => {
    vi.useFakeTimers();
    let clock = NOW.getTime();
    const api = new FakeApi();
    const a = device(api, 'a', { clock: () => new Date(clock), focusIntervalMs: 1000 });
    api.mode = 'redirect';
    await edit(a.saves, 's1', 'one');
    await vi.advanceTimersByTimeAsync(10);
    expect(a.engine.status.state).toBe('signed-out');
    await edit(a.saves, 's1', 'two');
    await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS * 3);
    expect(api.requests.length).toBe(1);
    expect(a.engine.status).toMatchObject({ state: 'signed-out', pending: 1 });

    a.engine.focus(); // too soon after the last full cycle? the push cycle was not full
    await vi.advanceTimersByTimeAsync(0);
    expect(api.requests.length).toBe(2);
    a.engine.focus(); // within the interval: ignored
    await vi.advanceTimersByTimeAsync(0);
    expect(api.requests.length).toBe(2);
    api.mode = 'ok';
    clock += 1000;
    a.engine.focus();
    await vi.advanceTimersByTimeAsync(0);
    expect(a.engine.status.state).toBe('synced');
  });

  it('marks a refused save, keeps syncing the others, and retries it after the next edit', async () => {
    const api = new FakeApi();
    const a = device(api, 'a');
    await edit(a.saves, 's1', 'one');
    await a.engine.sync();
    api.maxSaves = 1;
    await edit(a.saves, 's2', 'two');
    await edit(a.saves, 's1', 'one, edited');
    await a.engine.sync();
    expect(a.engine.status.state).toBe('error');
    expect(a.engine.status.message).toContain('"two"');
    expect(api.saves.get('s1')?.title).toBe('one, edited');
    expect(await a.state.get('s2')).toMatchObject({ rejected: 1, remote: 0 });
    const puts = api.count('PUT');
    await a.engine.sync();
    expect(api.count('PUT')).toBe(puts);
    api.maxSaves = 200;
    await edit(a.saves, 's2', 'two, edited');
    await a.engine.sync();
    expect(api.saves.get('s2')?.title).toBe('two, edited');
    expect(a.engine.status.state).toBe('synced');
  });

  it('reports server errors and local failures as error with a retry', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const api = new FakeApi();
    const a = device(api, 'a');
    api.mode = 'error';
    await a.engine.sync();
    expect(a.engine.status.state).toBe('error');
    api.mode = 'ok';
    vi.spyOn(a.local, 'list').mockRejectedValueOnce(new Error('disk on fire'));
    await vi.advanceTimersByTimeAsync(backoffDelay(1, 0));
    expect(a.engine.status).toMatchObject({ state: 'error' });
    await vi.advanceTimersByTimeAsync(backoffDelay(2, 0));
    expect(a.engine.status.state).toBe('synced');
  });

  it('does nothing after stop', async () => {
    vi.useFakeTimers();
    const api = new FakeApi();
    const a = device(api, 'a');
    a.engine.stop();
    await edit(a.saves, 's1', 'one');
    a.engine.focus();
    a.engine.online();
    await a.engine.sync();
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.requests).toEqual([]);
  });

  it('merges requests that arrive while a cycle runs', async () => {
    const api = new FakeApi();
    const a = device(api, 'a');
    await edit(a.saves, 's1', 'one');
    const first = a.engine.sync('push');
    const second = a.engine.sync('push');
    const third = a.engine.sync('full');
    expect(third).toBe(second);
    await Promise.all([first, second, third]);
    expect(api.count('PUT')).toBe(1);
  });

  it('runs cycles inside the given lock', async () => {
    const api = new FakeApi();
    const withLock = vi.fn((run: () => Promise<void>) => run());
    const engine = new SyncEngine({
      client: new HttpSyncClient({ baseUrl: '/api', fetch: api.fetch }),
      local: new MemorySaveStore(),
      state: new MemorySyncState(),
      withLock,
    });
    await engine.start();
    expect(withLock).toHaveBeenCalledTimes(1);
  });
});

describe('SyncEngine with a SaveSession', () => {
  async function editor(api: FakeApi, name: string) {
    const d = device(api, name);
    const app = new Store(initialState());
    let n = 0;
    const session = new SaveSession(app, {
      saves: d.saves,
      storage: null,
      now: () => NOW,
      newId: () => `${name}-id${++n}`,
      debounceMs: 5,
    });
    d.engine.onRemoteChange((id, copyId) => session.remoteChanged(id, copyId));
    await session.start();
    return { ...d, app, session };
  }

  it('reloads the open record when it changed remotely and was not edited here', async () => {
    const api = new FakeApi();
    const a = await editor(api, 'a');
    a.app.commit(song('first'));
    await a.session.flush();
    await a.engine.sync();
    const id = a.session.currentId ?? '';
    const remote = await a.local.get(id);
    api.remoteWrite({
      ...(remote as SaveRecord),
      title: 'from elsewhere',
      song: song('from elsewhere'),
    });
    await a.engine.sync();
    expect(a.app.state.song.title).toBe('from elsewhere');
    expect(a.session.currentId).toBe(id);
  });

  it('continues on the copy after a conflict on the open record', async () => {
    const api = new FakeApi();
    const a = await editor(api, 'a');
    a.app.commit(song('first'));
    await a.session.flush();
    await a.engine.sync();
    const id = a.session.currentId ?? '';
    const remote = await a.local.get(id);
    api.remoteWrite({ ...(remote as SaveRecord), title: 'theirs', song: song('theirs') });
    a.app.commit(song('mine'));
    await a.session.flush();
    await a.engine.sync();
    expect(a.session.currentId).toBe('a-copy1');
    expect(a.app.state.song.title).toBe('mine (copy)');
    expect(a.app.undo()).toBe(true); // undo history survives
    expect((await a.local.get(id))?.title).toBe('theirs');
    expect(api.saves.get('a-copy1')?.title).toBe('mine (copy)');
  });

  it('keeps unsaved edits when the open record changes remotely', async () => {
    vi.useFakeTimers();
    const api = new FakeApi();
    const a = await editor(api, 'a');
    a.app.commit(song('first'));
    await a.session.flush();
    await a.engine.sync();
    const id = a.session.currentId ?? '';
    const remote = await a.local.get(id);
    api.remoteWrite({ ...(remote as SaveRecord), title: 'theirs', song: song('theirs') });
    a.app.commit(song('typing'));
    await a.engine.sync(); // pulls while the autosave is pending
    expect(a.app.state.song.title).toBe('typing');
    await vi.advanceTimersByTimeAsync(5); // the autosave conflicts and saves a copy
    expect(a.app.state.song.title).toBe('typing (copy)');
    expect(a.session.currentId).not.toBe(id);
    expect((await a.local.get(id))?.title).toBe('theirs');
  });

  it('opens the newest remaining record when the open one is deleted elsewhere', async () => {
    const api = new FakeApi();
    const a = await editor(api, 'a');
    await a.saves.put(rec('older', 1, 'older'));
    a.app.commit(song('first'));
    await a.session.flush();
    await a.engine.sync();
    const id = a.session.currentId ?? '';
    api.saves.delete(id);
    await a.engine.sync();
    expect(a.session.currentId).toBe('older');
    expect(a.app.state.song.title).toBe('older');
  });
});

describe('sync status view and browser events', () => {
  it('labels every state', () => {
    const s = (state: Parameters<typeof syncLabel>[0]['state'], pending = 0) =>
      syncLabel({ state, pending, message: null });
    expect([s('synced'), s('pending'), s('pending', 2), s('offline'), s('offline', 3)]).toEqual([
      'Synced',
      'Syncing…',
      'Syncing… (2)',
      'Offline',
      'Offline (3)',
    ]);
    expect([s('error'), s('signed-out')]).toEqual(['Sync error', 'Sign in']);
  });

  it('follows the engine and offers sign in', async () => {
    const api = new FakeApi();
    const a = device(api, 'a');
    const signIn = vi.fn();
    const el = syncStatusView(a.engine, { signIn });
    await a.engine.sync();
    expect(el.className).toBe('sync-status sync-synced');
    expect(el.textContent).toBe('Synced');
    api.mode = 'unauthorized';
    await a.engine.sync();
    expect(el.className).toContain('sync-signed-out');
    el.querySelector('button')?.click();
    expect(signIn).toHaveBeenCalledOnce();
    api.mode = 'error';
    await a.engine.sync();
    expect(el.textContent).toBe('Sync error');
    expect(el.title).toContain('503');
  });

  it('turns focus, visibility and online events into cycles', () => {
    const api = new FakeApi();
    const a = device(api, 'a');
    const focus = vi.spyOn(a.engine, 'focus').mockImplementation(() => undefined);
    const online = vi.spyOn(a.engine, 'online').mockImplementation(() => undefined);
    const sync = vi.spyOn(a.engine, 'sync').mockResolvedValue(undefined);
    const unbind = bindSyncEvents(a.engine, window);
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('offline'));
    expect(focus).toHaveBeenCalledTimes(2);
    expect(online).toHaveBeenCalledOnce();
    expect(sync).toHaveBeenCalledWith('push');
    unbind();
    window.dispatchEvent(new Event('focus'));
    expect(focus).toHaveBeenCalledTimes(2);
  });
});
