import { createSong, serializeSong } from '@crokychords/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { midiBlob, midiFileName } from '../src/midi/download';
import type { MidiAccessLike, MidiOutputLike } from '../src/midi/webmidi';
import { MidiOut } from '../src/midi/webmidi';
import type { SongStorage } from '../src/persist';
import { SAVE_DEBOUNCE_MS, STORAGE_KEY, loadSong, persistSongs, saveSong } from '../src/persist';
import { Store, initialState } from '../src/state';

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

describe('persistence', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('loads a saved song and ignores invalid ones', () => {
    const song = createSong({ title: 'Saved', chords: [{ token: 'IV', beats: 2 }] });
    expect(loadSong(memoryStorage({ [STORAGE_KEY]: serializeSong(song) }))).toEqual(song);
    expect(loadSong(memoryStorage())).toBeNull();
    expect(loadSong(null)).toBeNull();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(loadSong(memoryStorage({ [STORAGE_KEY]: '{"schema":2}' }))).toBeNull();
  });

  it('saves on change, debounced', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const store = new Store(initialState());
    persistSongs(store, storage);
    store.commit(createSong({ title: 'A' }));
    store.commit(createSong({ title: 'B' }));
    store.set({ cursor: 3 });
    expect(storage.data[STORAGE_KEY]).toBeUndefined();
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    expect(JSON.parse(storage.data[STORAGE_KEY] ?? '{}')).toMatchObject({ title: 'B' });
  });

  it('survives a storage that throws', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken: SongStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(loadSong(broken)).toBeNull();
    expect(() => saveSong(broken, createSong())).not.toThrow();
  });
});

describe('MIDI file download', () => {
  it('names the file after the title', () => {
    expect(midiFileName('My Song')).toBe('My Song.mid');
    expect(midiFileName('a/b:c?')).toBe('a-b-c-.mid');
    expect(midiFileName('  ')).toBe('Untitled.mid');
    expect(midiFileName('..hidden')).toBe('hidden.mid');
  });

  it('wraps songToMidi in an audio/midi blob', async () => {
    const blob = midiBlob(createSong({ chords: [{ token: 'I', beats: 4 }] }));
    expect(blob.type).toBe('audio/midi');
    const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () =>
        reader.result instanceof ArrayBuffer
          ? resolve(reader.result)
          : reject(new Error('no data'));
      reader.onerror = () => reject(reader.error ?? new Error('read failed'));
      reader.readAsArrayBuffer(blob);
    });
    const bytes = new Uint8Array(buffer);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('MThd');
  });
});

function fakeAccess(ports: { id: string; name: string; state?: string }[]) {
  const sent: { id: string; data: number[]; time: number | undefined }[] = [];
  const outputs: MidiOutputLike[] = ports.map((p) => ({
    ...p,
    send: (data, time) => sent.push({ id: p.id, data, time }),
    clear: vi.fn(),
  }));
  const listeners: (() => void)[] = [];
  const access: MidiAccessLike = {
    outputs: { forEach: (fn) => outputs.forEach(fn) },
    addEventListener: (_type, listener) => listeners.push(listener),
  };
  const stateChange = () => listeners.forEach((l) => l());
  return { access, sent, outputs, stateChange };
}

describe('MidiOut', () => {
  it('reports unsupported and denied access', async () => {
    expect(await new MidiOut(null).enable()).toBe('unsupported');
    expect(await new MidiOut(() => Promise.reject(new Error('no'))).enable()).toBe('denied');
  });

  it('lists outputs and sends timed note on/off to the selected one', async () => {
    const { access, sent } = fakeAccess([
      { id: 'a', name: 'loopMIDI Port' },
      { id: 'b', name: 'Gone', state: 'disconnected' },
    ]);
    const midi = new MidiOut(() => Promise.resolve(access));
    expect(await midi.enable()).toBe('ready');
    expect(midi.outputs()).toEqual([{ id: 'a', name: 'loopMIDI Port' }]);

    midi.playChord([60, 64], 1000, 500); // no output selected: nothing sent
    expect(sent).toHaveLength(0);

    midi.select('a');
    expect(midi.selected).toBe('a');
    midi.playChord([60, 64], 1000, 500);
    expect(sent.map((s) => [s.data, s.time])).toEqual([
      [[0x90, 60, 96], 1000],
      [[0x90, 64, 96], 1000],
      [[0x80, 60, 0], 1500],
      [[0x80, 64, 0], 1500],
    ]);
  });

  it('sends note offs and All Notes Off (CC 123) on stop', async () => {
    const { access, sent, outputs } = fakeAccess([{ id: 'a', name: 'IAC Bus 1' }]);
    const midi = new MidiOut(() => Promise.resolve(access));
    await midi.enable();
    midi.select('a');
    midi.playChord([48], 0, 100);
    sent.length = 0;
    midi.allNotesOff();
    expect(outputs[0]?.clear).toHaveBeenCalled();
    expect(sent.map((s) => s.data)).toEqual([
      [0x80, 48, 0],
      [0xb0, 120, 0],
      [0xb0, 123, 0],
    ]);
  });

  it('reports device changes', async () => {
    const { access, stateChange } = fakeAccess([{ id: 'a', name: 'A' }]);
    const midi = new MidiOut(() => Promise.resolve(access));
    const seen: unknown[] = [];
    midi.onOutputsChange = (outputs) => seen.push(outputs);
    await midi.enable();
    stateChange();
    expect(seen).toEqual([[{ id: 'a', name: 'A' }]]);
  });
});
