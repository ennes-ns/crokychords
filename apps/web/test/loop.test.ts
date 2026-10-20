import { createSong } from '@crokychords/core';
import { describe, expect, it } from 'vitest';
import type { LoopStorage } from '../src/loop';
import {
  LOOP_KEY_PREFIX,
  barRange,
  bindLoopPersistence,
  extendRange,
  loadLoop,
  loopBounds,
  loopLabel,
  parseLoop,
  playStart,
  saveLoop,
  serializeLoop,
  spanBars,
  withLoopEnd,
  withLoopStart,
} from '../src/loop';
import { Store, initialState } from '../src/state';
import { makeRecord } from '../src/store/record';
import { MemorySaveStore } from '../src/store/saveStore';
import { SaveSession } from '../src/store/session';

function memoryStorage(): LoopStorage & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

describe('loop range helpers', () => {
  it('clips the range to the song, else loops the whole song', () => {
    expect(loopBounds({ start: 4, end: 12 }, 16)).toEqual({ start: 4, end: 12 });
    expect(loopBounds({ start: 4, end: 20 }, 16)).toEqual({ start: 4, end: 16 });
    expect(loopBounds({ start: 16, end: 20 }, 16)).toEqual({ start: 0, end: 16 });
    expect(loopBounds(null, 16)).toEqual({ start: 0, end: 16 });
  });

  it('starts Play at the loop start only when looping', () => {
    expect(playStart(true, { start: 8, end: 12 }, 16)).toBe(8);
    expect(playStart(false, { start: 8, end: 12 }, 16)).toBe(0);
    expect(playStart(true, null, 16)).toBe(0);
  });

  it('builds bar ranges from clicks, drags and Shift+clicks', () => {
    expect(barRange(4, 2)).toEqual({ start: 8, end: 12 });
    expect(spanBars(4, 3, 1)).toEqual({ start: 4, end: 16 });
    expect(extendRange(null, 4, 2)).toEqual({ start: 8, end: 12 });
    expect(extendRange({ start: 8, end: 12 }, 4, 0)).toEqual({ start: 0, end: 12 });
    expect(extendRange({ start: 8, end: 12 }, 4, 4)).toEqual({ start: 8, end: 20 });
    expect(extendRange({ start: 8, end: 20 }, 4, 2)).toEqual({ start: 8, end: 12 });
  });

  it('moves one loop point at a time, keeping the other when it still fits', () => {
    expect(withLoopStart(null, 4, 16)).toEqual({ start: 4, end: 16 });
    expect(withLoopStart({ start: 0, end: 8 }, 4, 16)).toEqual({ start: 4, end: 8 });
    expect(withLoopStart({ start: 0, end: 8 }, 10, 16)).toEqual({ start: 10, end: 16 });
    expect(withLoopEnd(null, 8)).toEqual({ start: 0, end: 8 });
    expect(withLoopEnd({ start: 4, end: 16 }, 8)).toEqual({ start: 4, end: 8 });
    expect(withLoopEnd({ start: 8, end: 16 }, 4)).toEqual({ start: 0, end: 4 });
  });

  it('labels ranges in bars, or bar.beat off the bar lines', () => {
    expect(loopLabel({ start: 4, end: 12 }, 4)).toBe('bars 2–3');
    expect(loopLabel({ start: 0, end: 4 }, 4)).toBe('bar 1');
    expect(loopLabel({ start: 2, end: 7 }, 4)).toBe('1.3–2.4');
  });
});

describe('loop persistence', () => {
  it('round-trips the stored form and rejects invalid entries', () => {
    const state = { loop: true, loopRange: { start: 4, end: 12 } };
    const json = serializeLoop(state);
    expect(JSON.parse(json)).toEqual({
      schema_version: 1,
      enabled: true,
      startBeat: 4,
      endBeat: 12,
    });
    expect(parseLoop(json)).toEqual(state);
    expect(parseLoop(serializeLoop({ loop: false, loopRange: null }))).toEqual({
      loop: false,
      loopRange: null,
    });
    for (const bad of [
      'nope',
      '[]',
      '{"schema_version":2,"enabled":true,"startBeat":0,"endBeat":4}',
      '{"schema_version":1,"enabled":"yes","startBeat":0,"endBeat":4}',
      '{"schema_version":1,"enabled":true,"startBeat":4,"endBeat":4}',
      '{"schema_version":1,"enabled":true,"startBeat":-1,"endBeat":4}',
      '{"schema_version":1,"enabled":true,"startBeat":0,"endBeat":null}',
    ]) {
      expect(parseLoop(bad)).toBeNull();
    }
    const storage = memoryStorage();
    saveLoop(storage, 'a', state);
    expect(Object.keys(storage.data)).toEqual([`${LOOP_KEY_PREFIX}a`]);
    expect(loadLoop(storage, 'a')).toEqual(state);
    expect(loadLoop(storage, 'b')).toBeNull();
    expect(loadLoop(null, 'a')).toBeNull();
  });

  it('keeps a loop per saved progression across switching songs', async () => {
    const saves = new MemorySaveStore();
    const now = new Date('2026-10-20T12:00:00.000Z');
    await saves.put(makeRecord(createSong({ title: 'A' }), { id: 'a', version: 1, now }));
    await saves.put(makeRecord(createSong({ title: 'B' }), { id: 'b', version: 1, now }));
    const storage = memoryStorage();
    const store = new Store(initialState());
    let n = 0;
    const session = new SaveSession(store, {
      saves,
      storage,
      now: () => now,
      newId: () => `n${++n}`,
    });
    await session.start();
    bindLoopPersistence(store, session, storage);
    await session.open('a');

    store.set({ loop: true, loopRange: { start: 4, end: 8 } });
    expect(loadLoop(storage, 'a')).toEqual({ loop: true, loopRange: { start: 4, end: 8 } });

    await session.open('b');
    expect(store.state.loopRange).toBeNull(); // B has no loop points
    store.set({ loopRange: { start: 0, end: 4 } });

    await session.open('a');
    expect(store.state.loopRange).toEqual({ start: 4, end: 8 });
    await session.open('b');
    expect(store.state.loopRange).toEqual({ start: 0, end: 4 });

    // A new song keeps its loop when its first save gives it an id.
    await session.newSong();
    store.set({ loop: true, loopRange: { start: 8, end: 12 } });
    store.commit(createSong({ title: 'C', chords: [{ token: 'I', beats: 4 }] }));
    await session.flush();
    expect(session.currentId).toBe('n1');
    expect(loadLoop(storage, 'n1')).toEqual({ loop: true, loopRange: { start: 8, end: 12 } });
    expect(store.state.loopRange).toEqual({ start: 8, end: 12 });
  });
});
