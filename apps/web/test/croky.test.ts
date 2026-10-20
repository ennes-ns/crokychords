import { COMMAND_OPS, createSong, deserializeSong, serializeSong } from '@crokychords/core';
import { describe, expect, it, vi } from 'vitest';
import type { CrokyHost } from '../src/assistant/croky';
import { base64, createCroky, prepare } from '../src/assistant/croky';
import { Store, initialState } from '../src/state';
import { quietHost, songFrom } from './commandHelpers';

function setup(chords: [string, number][] = [], host: Partial<CrokyHost> = {}) {
  const store = new Store(initialState(songFrom({ chords })));
  const full: CrokyHost = { ...quietHost, ...host };
  return { store, host: full, croky: createCroky(store, full) };
}

describe('window.croky', () => {
  it('getSong returns the song exactly as serializeSong writes it, as plain JSON', async () => {
    const { croky } = setup([['I', 4]]);
    await croky.applyCommands({ op: 'addNote', beat: 0, length: 1, degree: 3 });
    const song = croky.getSong();
    expect(song).toEqual(JSON.parse(serializeSong(deserializeSong(JSON.stringify(song)))));
    expect(song.schema).toBe(4);
    expect(song.melody?.notes).toHaveLength(1);
  });

  it('getState reports selection, loop, history and the table', async () => {
    const { croky } = setup([['I', 4]]);
    expect(croky.getState()).toMatchObject({
      selected: null,
      playing: false,
      loop: { enabled: false, range: null },
      canUndo: false,
      canRedo: false,
      table: { status: 'loading' },
    });
    await croky.applyCommands([
      { op: 'appendChord', token: 'V' },
      { op: 'select', index: 0 },
    ]);
    expect(croky.getState()).toMatchObject({ selected: 0, canUndo: true });
  });

  it('suggestions follow a slot and can be limited, popular or diatonic', () => {
    const { croky } = setup([
      ['I', 4],
      ['V', 4],
    ]);
    const end = croky.suggestions({ limit: 3 });
    expect(end.items).toHaveLength(3);
    expect(end.context).toMatch(/^after /);
    for (const item of end.items) {
      expect(item).toEqual({
        token: expect.any(String),
        name: expect.any(String),
        probability: expect.any(Number),
      });
    }
    expect(croky.suggestions({ at: 0, popular: true }).context).toBe('any position');
    const diatonic = croky.suggestions({ diatonicOnly: true }).items.map((i) => i.token);
    expect(diatonic.every((t) => !t.startsWith('b') && !t.includes('/'))).toBe(true);
  });

  it('commands() lists every op with a summary, a kind, an example and the JSON schema', () => {
    const { croky } = setup();
    const list = croky.commands();
    expect(list.version).toBe(1);
    expect(list.ops.map((o) => o.op)).toEqual(COMMAND_OPS);
    expect(list.ops[0]).toMatchObject({ op: 'appendChord', kind: 'song' });
    expect(JSON.parse(JSON.stringify(list.schema))).toEqual(list.schema);
  });

  it('runs one command object as well as a list', async () => {
    const { croky } = setup();
    const result = await croky.applyCommands({ op: 'appendChord', token: 'ii' });
    expect(result).toEqual({
      ok: true,
      applied: 1,
      results: [{ op: 'appendChord', changed: true, index: 0 }],
    });
  });

  it('refuses invalid input before running anything', async () => {
    const { croky, store } = setup([['I', 4]]);
    const before = store.state.song;
    for (const input of ['play', 42, null, [{ op: 'appendChord', token: 'IV' }, { op: 'nope' }]]) {
      const result = await croky.applyCommands(input);
      expect(result.ok).toBe(false);
      expect(result.applied).toBe(0);
    }
    expect(store.state.song).toBe(before);
  });

  it('exportMidi: the bytes, and as a command the file as base64', async () => {
    const bytes = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6]);
    const midi = vi.fn(() => ({ bytes, fileName: 'Untitled.mid' }));
    const { croky } = setup([['I', 4]], { midi });
    expect(croky.exportMidi()).toBe(bytes);
    const result = await croky.applyCommands({ op: 'exportMidi' });
    expect(result.results[0]).toEqual({
      op: 'exportMidi',
      fileName: 'Untitled.mid',
      bytes: 8,
      base64: 'TVRoZAAAAAY=',
    });
    expect(base64(new Uint8Array(70000).fill(65))).toHaveLength(93336);
  });

  it('transport, sound and save commands reach the host in order', async () => {
    const calls: string[] = [];
    const { croky } = setup([['I', 4]], {
      play: (from) => {
        calls.push(`play ${String(from)}`);
        return Promise.resolve(true);
      },
      stop: () => calls.push('stop'),
      audition: (token) => calls.push(`audition ${token}`),
      setInstrument: (track, role, id) => calls.push(`instrument ${track} ${String(role)} ${id}`),
      save: () => {
        calls.push('save');
        return Promise.resolve();
      },
    });
    const result = await croky.applyCommands([
      { op: 'play', from: 2 },
      { op: 'stop' },
      { op: 'audition', token: 'V7' },
      { op: 'setInstrument', track: 'melody', instrument: 'lead' },
      { op: 'setInstrument', track: 1, instrument: 'piano' },
      { op: 'play' },
      { op: 'save' },
    ]);
    expect(result.ok).toBe(true);
    expect(calls[0]).toBe('play 2');
    expect(calls.slice(1, 5)).toEqual([
      'stop',
      'audition V7',
      'instrument melody null lead',
      expect.stringMatching(/^instrument \S+ bass piano$/),
    ]);
    expect(calls.slice(5)).toEqual(['play undefined', 'save']);
  });

  it('an unknown instrument and an empty song fail in the dry run', async () => {
    const { croky } = setup();
    const bad = await croky.applyCommands({ op: 'setInstrument', track: 0, instrument: 'kazoo' });
    expect(bad).toMatchObject({ ok: false, error: { code: 'invalid', path: 'instrument' } });
    const empty = await croky.applyCommands([{ op: 'stop' }, { op: 'play' }]);
    expect(empty).toMatchObject({ ok: false, applied: 0, error: { code: 'failed', index: 1 } });
  });

  it('a failing effect stops the batch; the commands before it stay applied', async () => {
    const { croky, store } = setup([['I', 4]], { play: () => Promise.resolve(false) });
    const result = await croky.applyCommands([
      { op: 'appendChord', token: 'V' },
      { op: 'play' },
      { op: 'appendChord', token: 'vi' },
    ]);
    expect(result).toMatchObject({
      ok: false,
      applied: 1,
      error: { code: 'failed', index: 1, op: 'play' },
    });
    expect(store.state.song.chords.map((c) => c.token)).toEqual(['I', 'V']);
    const save = setup([], { save: () => Promise.reject(new Error('disk full')) });
    const saved = await save.croky.applyCommands({ op: 'save' });
    expect(saved).toMatchObject({ ok: false, error: { code: 'failed', message: /disk full/ } });
  });

  it('every song edit is one undo step; a batch can be one', async () => {
    const { croky, store } = setup([['I', 4]]);
    await croky.applyCommands([
      { op: 'appendChord', token: 'V' },
      { op: 'setTempo', bpm: 90 },
    ]);
    expect(store.history.past).toHaveLength(2);
    await croky.applyCommands(
      [
        { op: 'appendChord', token: 'vi' },
        { op: 'appendChord', token: 'IV' },
      ],
      { undo: 'batch' },
    );
    expect(store.history.past).toHaveLength(3);
    store.undo();
    expect(store.state.song.chords.map((c) => c.token)).toEqual(['I', 'V']);
  });

  it('view-only commands do not touch the undo history', async () => {
    const { croky, store } = setup([['I', 4]]);
    await croky.applyCommands([
      { op: 'select', index: 0 },
      { op: 'setLoop', range: { start: 0, end: 4 } },
    ]);
    expect(store.canUndo).toBe(false);
    expect(store.state.loop).toBe(true);
  });

  it('calls run one after the other', async () => {
    let release: () => void = () => undefined;
    const { croky, store } = setup([['I', 4]], {
      save: () => new Promise<void>((resolve) => (release = resolve)),
    });
    const first = croky.applyCommands([{ op: 'save' }, { op: 'appendChord', token: 'V' }]);
    const second = croky.applyCommands({ op: 'appendChord', token: 'vi' });
    await Promise.resolve();
    expect(store.state.song.chords).toHaveLength(1);
    release();
    await first;
    await second;
    expect(store.state.song.chords.map((c) => c.token)).toEqual(['I', 'V', 'vi']);
  });

  it('prepare previews a batch without changing the store', () => {
    const store = new Store(initialState(createSong()));
    const prepared = prepare(store, quietHost.env, [
      { op: 'appendChord', token: 'I' },
      { op: 'appendChord', token: 'V' },
    ]);
    expect(prepared.ok && prepared.preview.song.chords.map((c) => c.token)).toEqual(['I', 'V']);
    expect(store.state.song.chords).toEqual([]);
  });
});
