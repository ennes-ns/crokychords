import { createSong, serializeSong } from '@crokychords/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SongStorage } from '../src/persist';
import { SAVE_DEBOUNCE_MS, STORAGE_KEY } from '../src/persist';
import { Store, initialState } from '../src/state';
import { MAX_SAVE_TITLE_LENGTH, makeRecord } from '../src/store/record';
import { MemorySaveStore } from '../src/store/saveStore';
import {
  CONFLICT_SUFFIX,
  CURRENT_SAVE_KEY,
  MIGRATED_KEY,
  SaveSession,
  conflictTitle,
} from '../src/store/session';

function memoryStorage(
  initial: Record<string, string> = {},
): SongStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

const NOW = new Date('2026-10-20T12:00:00.000Z');

function setup(storage: SongStorage | null = memoryStorage(), saves = new MemorySaveStore()) {
  let n = 0;
  const app = new Store(initialState());
  const session = new SaveSession(app, {
    saves,
    storage,
    now: () => NOW,
    newId: () => `id${++n}`,
  });
  const changes = vi.fn();
  session.subscribe(changes);
  return { app, session, saves, changes };
}

function seed(saves: MemorySaveStore, id: string, title: string, minute = 0) {
  const now = new Date(Date.UTC(2026, 9, 20, 11, minute));
  return saves.put(makeRecord(createSong({ title }), { id, version: 1, now }));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('SaveSession', () => {
  it('starts on a new unsaved song when nothing is saved', async () => {
    const { app, session, saves, changes } = setup();
    await session.start();
    expect(session.currentId).toBeNull();
    expect(app.state.song.chords).toEqual([]);
    expect(changes).toHaveBeenCalled();
    await session.flush();
    expect(await saves.list()).toEqual([]);
  });

  it('migrates the legacy localStorage song once', async () => {
    const legacy = createSong({ title: 'Old one', chords: [{ token: 'IV', beats: 4 }] });
    const storage = memoryStorage({ [STORAGE_KEY]: serializeSong(legacy) });
    const { app, session, saves } = setup(storage);
    await session.start();
    expect(app.state.song).toEqual(legacy);
    expect(session.currentId).toBe('id1');
    expect(storage.data[MIGRATED_KEY]).toBe('1');
    expect(storage.data[CURRENT_SAVE_KEY]).toBe('id1');
    expect(storage.data[STORAGE_KEY]).toBeDefined(); // kept as a backup

    const again = setup(storage, saves);
    await again.session.start();
    expect(await saves.list()).toHaveLength(1);
  });

  it('opens the remembered record, else the newest', async () => {
    const saves = new MemorySaveStore();
    await seed(saves, 'old', 'Old', 1);
    await seed(saves, 'new', 'New', 2);
    const remembered = setup(
      memoryStorage({ [MIGRATED_KEY]: '1', [CURRENT_SAVE_KEY]: 'old' }),
      saves,
    );
    await remembered.session.start();
    expect(remembered.app.state.song.title).toBe('Old');

    const gone = setup(memoryStorage({ [MIGRATED_KEY]: '1', [CURRENT_SAVE_KEY]: 'gone' }), saves);
    await gone.session.start();
    expect(gone.session.currentId).toBe('new');
    expect(gone.app.state.song.title).toBe('New');
  });

  it('autosaves after the debounce with increasing versions', async () => {
    vi.useFakeTimers();
    const { app, session, saves } = setup();
    await session.start();
    app.commit(createSong({ title: 'A' }));
    app.commit(createSong({ title: 'B' }));
    app.set({ cursor: 2 });
    expect(await saves.list()).toEqual([]);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(await saves.get('id1')).toMatchObject({ version: 1, title: 'B' });
    app.commit(createSong({ title: 'C' }));
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(await saves.get('id1')).toMatchObject({ version: 2, title: 'C' });
    expect(await saves.list()).toHaveLength(1);
  });

  it('continues on a copy when another tab saved first', async () => {
    const { app, session, saves } = setup();
    await session.start();
    app.commit(createSong({ title: 'Mine' }));
    await session.flush();
    // Another tab writes version 2 of the same record.
    await saves.put(
      makeRecord(createSong({ title: 'Theirs' }), { id: 'id1', version: 2, now: NOW }),
    );
    app.commit({ ...app.state.song, tempo: 99 });
    await session.flush();
    expect((await saves.get('id1'))?.title).toBe('Theirs');
    expect(session.currentId).toBe('id2');
    expect(await saves.get('id2')).toMatchObject({ version: 1, title: `Mine${CONFLICT_SUFFIX}` });
    expect(app.state.song).toMatchObject({ title: `Mine${CONFLICT_SUFFIX}`, tempo: 99 });
    // Further edits go to the copy.
    app.commit({ ...app.state.song, tempo: 100 });
    await session.flush();
    expect(await saves.get('id2')).toMatchObject({ version: 2 });
  });

  it('logs a failed autosave and keeps going', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const saves = new MemorySaveStore();
    const { app, session } = setup(memoryStorage(), saves);
    await session.start();
    vi.spyOn(saves, 'put').mockRejectedValueOnce(new Error('disk full'));
    app.commit(createSong({ title: 'A' }));
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(warn).toHaveBeenCalled();
    app.commit(createSong({ title: 'B' }));
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(await saves.get('id2')).toMatchObject({ title: 'B' });
  });

  it('opens a record after saving pending edits, and clears undo', async () => {
    const saves = new MemorySaveStore();
    await seed(saves, 'other', 'Other');
    const { app, session } = setup(memoryStorage({ [MIGRATED_KEY]: '1' }), saves);
    await session.start();
    expect(session.currentId).toBe('other');
    await session.newSong();
    app.commit(createSong({ title: 'Draft' }));
    expect(await session.open('other')).toBe(true);
    expect(app.state.song.title).toBe('Other');
    expect(app.canUndo).toBe(false);
    expect((await saves.list()).map((s) => s.title).sort()).toEqual(['Draft', 'Other']);
    expect(await session.open('missing')).toBe(false);
    expect(session.currentId).toBe('other');
  });

  it('still switches songs when saving the pending edits fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const saves = new MemorySaveStore();
    await seed(saves, 'other', 'Other');
    const { app, session } = setup(memoryStorage({ [MIGRATED_KEY]: '1' }), saves);
    await session.start();
    app.commit({ ...app.state.song, tempo: 80 });
    vi.spyOn(saves, 'put').mockRejectedValueOnce(new Error('disk full'));
    await session.newSong();
    expect(warn).toHaveBeenCalled();
    expect(session.currentId).toBeNull();
  });

  it('does not save a blank new song until it changes', async () => {
    const { app, session, saves } = setup();
    await session.start();
    await session.newSong();
    await session.flush();
    expect(await saves.list()).toEqual([]);
    expect(session.currentId).toBeNull();
    app.commit(createSong({ title: 'X' }));
    await session.flush();
    expect(session.currentId).toBe('id1');
  });

  it('renames the open record through the song, others in the store', async () => {
    const saves = new MemorySaveStore();
    await seed(saves, 'a', 'A', 2);
    await seed(saves, 'b', 'B', 1);
    const { app, session } = setup(memoryStorage({ [MIGRATED_KEY]: '1' }), saves);
    await session.start();
    expect(session.currentId).toBe('a');
    await session.rename('a', 'A2');
    expect(app.state.song.title).toBe('A2');
    expect(app.canUndo).toBe(true);
    expect(await saves.get('a')).toMatchObject({ title: 'A2', version: 2 });
    await session.rename('b', 'B2');
    expect(await saves.get('b')).toMatchObject({ title: 'B2', version: 2 });
    expect((await saves.get('b'))?.song.title).toBe('B2');
    await session.rename('missing', 'X');
    expect(await session.list()).toHaveLength(2);
  });

  it('deletes records; deleting the open one opens the newest or a new song', async () => {
    const saves = new MemorySaveStore();
    await seed(saves, 'a', 'A', 2);
    await seed(saves, 'b', 'B', 1);
    const { app, session } = setup(memoryStorage({ [MIGRATED_KEY]: '1' }), saves);
    await session.start();
    await session.remove('b');
    expect(session.currentId).toBe('a');
    app.commit({ ...app.state.song, tempo: 77 });
    await session.remove('a');
    await session.flush();
    expect(await saves.list()).toEqual([]);
    expect(session.currentId).toBeNull();
    expect(app.state.song.title).toBe(createSong().title);
  });

  it('works without any browser storage', async () => {
    const { app, session, saves } = setup(null);
    await session.start();
    app.commit(createSong({ title: 'A' }));
    await session.flush();
    expect(await saves.list()).toHaveLength(1);
    session.stop();
  });

  it('skips an unreadable remembered record', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const saves = new MemorySaveStore();
    vi.spyOn(saves, 'get').mockRejectedValueOnce(new Error('corrupt'));
    await seed(saves, 'a', 'A');
    const { session } = setup(
      memoryStorage({ [MIGRATED_KEY]: '1', [CURRENT_SAVE_KEY]: 'a' }),
      saves,
    );
    await session.start();
    expect(session.currentId).toBe('a'); // opened on the second try via the list
  });

  it('keeps conflict titles within the limit', () => {
    expect(conflictTitle('x')).toBe(`x${CONFLICT_SUFFIX}`);
    expect(conflictTitle('x'.repeat(500))).toHaveLength(MAX_SAVE_TITLE_LENGTH);
  });
});
