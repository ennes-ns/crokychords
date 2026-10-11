import { createSong, serializeSong } from '@crokychords/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { midiBlob, midiFileName } from '../src/midi/download';
import type { MidiAccessLike, MidiOutputLike } from '../src/midi/webmidi';
import { MidiOut } from '../src/midi/webmidi';
import type { SongStorage } from '../src/persist';
import {
  BAND_OPEN_KEY,
  SAVE_DEBOUNCE_MS,
  STORAGE_KEY,
  loadBandOpen,
  loadSong,
  persistSongs,
  saveBandOpen,
  saveSong,
} from '../src/persist';
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

  it('migrates a schema-1 song from localStorage to schema 2 with the default band', () => {
    const legacy = JSON.stringify({
      schema: 1,
      title: 'Old',
      key: { tonic: 'A', mode: 'minor' },
      tempo: 90,
      meter: { beats: 4, unit: 4 },
      chords: [{ token: 'i', beats: 4 }],
    });
    const first = loadSong(memoryStorage({ [STORAGE_KEY]: legacy }));
    const second = loadSong(memoryStorage({ [STORAGE_KEY]: legacy }));
    expect(first).toMatchObject({ schema: 2, title: 'Old', chords: [{ token: 'i', beats: 4 }] });
    const tracks = first?.tracks ?? [];
    expect(tracks.map((t) => [t.name, t.channel, t.muted])).toEqual([
      ['Chords', 0, false],
      ['Bass', 1, false],
      ['Arp', 2, true],
    ]);
    expect(tracks.every((t) => /^trk-[0-9a-z]{8}$/.test(t.id))).toBe(true);
    // Fresh random ids on every migration.
    expect(second?.tracks?.[0]?.id).not.toBe(tracks[0]?.id);
    // Saved back as schema 2 with the same tracks.
    const storage = memoryStorage();
    if (first !== null) saveSong(storage, first);
    expect(loadSong(storage)).toEqual(first);
  });

  it('remembers whether the Band panel is open', () => {
    const storage = memoryStorage();
    expect(loadBandOpen(storage)).toBe(true);
    saveBandOpen(storage, false);
    expect(storage.data[BAND_OPEN_KEY]).toBe('false');
    expect(loadBandOpen(storage)).toBe(false);
    saveBandOpen(storage, true);
    expect(loadBandOpen(storage)).toBe(true);
    expect(loadBandOpen(null)).toBe(true);
    expect(() => saveBandOpen(null, false)).not.toThrow();
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
    // Format 1: conductor + one track per unmuted layer (default band: chords and bass).
    expect((bytes[8] ?? 0) * 256 + (bytes[9] ?? 0)).toBe(1);
    expect((bytes[10] ?? 0) * 256 + (bytes[11] ?? 0)).toBe(3);
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

  it('lists outputs and sends timed note on/off on the event channel and velocity', async () => {
    const { access, sent } = fakeAccess([
      { id: 'a', name: 'loopMIDI Port' },
      { id: 'b', name: 'Gone', state: 'disconnected' },
    ]);
    const midi = new MidiOut(() => Promise.resolve(access));
    expect(await midi.enable()).toBe('ready');
    expect(midi.outputs()).toEqual([{ id: 'a', name: 'loopMIDI Port' }]);

    midi.playNote(0, 60, 96, 1000, 500); // no output selected: nothing sent
    expect(sent).toHaveLength(0);

    midi.select('a');
    expect(midi.selected).toBe('a');
    midi.playNote(0, 60, 96, 1000, 500);
    midi.playNote(1, 36, 100, 1000, 450);
    midi.playNote(15, 72, 300, 1250, 100); // velocity clamped to 127
    expect(sent.map((s) => [s.data, s.time])).toEqual([
      [[0x90, 60, 96], 1000],
      [[0x80, 60, 0], 1500],
      [[0x91, 36, 100], 1000],
      [[0x81, 36, 0], 1450],
      [[0x9f, 72, 127], 1250],
      [[0x8f, 72, 0], 1350],
    ]);
    expect(midi.usedChannels).toEqual([0, 1, 15]);
  });

  it('sends note offs, CC 120 and CC 123 on every used channel on stop', async () => {
    const { access, sent, outputs } = fakeAccess([{ id: 'a', name: 'IAC Bus 1' }]);
    const midi = new MidiOut(() => Promise.resolve(access));
    await midi.enable();
    midi.select('a');
    midi.playNote(1, 48, 100, 0, 100);
    midi.playNote(0, 60, 96, 0, 100);
    sent.length = 0;
    midi.allNotesOff([2]); // channel 2 belongs to a track that has not played yet
    expect(outputs[0]?.clear).toHaveBeenCalled();
    expect(sent.map((s) => s.data)).toEqual([
      [0x80, 60, 0],
      [0xb0, 120, 0],
      [0xb0, 123, 0],
      [0x81, 48, 0],
      [0xb1, 120, 0],
      [0xb1, 123, 0],
      [0xb2, 120, 0],
      [0xb2, 123, 0],
    ]);
    expect(midi.usedChannels).toEqual([]);
  });

  it('silences a single channel without dropping pending messages', async () => {
    const { access, sent, outputs } = fakeAccess([{ id: 'a', name: 'IAC Bus 1' }]);
    const midi = new MidiOut(() => Promise.resolve(access));
    await midi.enable();
    midi.channelOff(3); // no port selected: nothing
    expect(sent).toHaveLength(0);
    midi.select('a');
    midi.playNote(3, 50, 90, 0, 100);
    midi.playNote(4, 52, 90, 0, 100);
    sent.length = 0;
    midi.channelOff(3);
    expect(outputs[0]?.clear).not.toHaveBeenCalled();
    expect(sent.map((s) => s.data)).toEqual([
      [0x83, 50, 0],
      [0xb3, 120, 0],
      [0xb3, 123, 0],
    ]);
    expect(midi.usedChannels).toEqual([4]);
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
