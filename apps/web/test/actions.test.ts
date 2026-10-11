import { createSong } from '@crokychords/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActions } from '../src/actions';
import { AudioEngine } from '../src/audio/synth';
import type { MidiAccessLike } from '../src/midi/webmidi';
import { MidiOut } from '../src/midi/webmidi';
import { Store, initialState } from '../src/state';

function fakeMidi() {
  const sent: number[][] = [];
  const access: MidiAccessLike = {
    outputs: {
      forEach: (fn) => fn({ id: 'port', name: 'Virtual', send: (data) => sent.push(data) }),
    },
    addEventListener: () => undefined,
  };
  return { midi: new MidiOut(() => Promise.resolve(access)), sent };
}

function setup(
  tokens: string[] = [],
  mode: 'major' | 'minor' = 'major',
  midi: MidiOut = new MidiOut(null),
) {
  const song = createSong({
    key: { tonic: 'C', mode },
    chords: tokens.map((token) => ({ token, beats: 4 })),
  });
  const store = new Store(initialState(song));
  // jsdom has no Web Audio (the synth stays silent); Web MIDI is faked where needed.
  const actions = createActions(store, new AudioEngine(), midi);
  const tokensOf = () => store.state.song.chords.map((c) => c.token);
  return { store, actions, tokensOf };
}

describe('actions', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('adds diatonic triads with 1–7 after the selection', () => {
    const { store, actions, tokensOf } = setup([], 'minor');
    for (const degree of [1, 6, 3, 7] as const) actions.key({ type: 'degree', degree });
    expect(tokensOf()).toEqual(['i', 'VI', 'III', 'VII']);
    expect(store.state.selected).toBe(3);
    actions.key({ type: 'move', delta: -2 });
    actions.key({ type: 'degree', degree: 4 });
    expect(tokensOf()).toEqual(['i', 'VI', 'iv', 'III', 'VII']);
  });

  it('removes, resizes, deselects, undoes and redoes', () => {
    const { store, actions, tokensOf } = setup(['I', 'V', 'vi']);
    actions.select(1);
    actions.key({ type: 'resize', delta: -1 });
    expect(store.state.song.chords[1]?.beats).toBe(3);
    actions.key({ type: 'remove' });
    expect(tokensOf()).toEqual(['I', 'vi']);
    expect(store.state.selected).toBe(0);
    actions.key({ type: 'undo' });
    expect(tokensOf()).toEqual(['I', 'V', 'vi']);
    actions.key({ type: 'redo' });
    expect(tokensOf()).toEqual(['I', 'vi']);
    actions.key({ type: 'deselect' });
    expect(store.state.selected).toBeNull();
  });

  it('appends the top suggestion on empty-space clicks', () => {
    const { actions, tokensOf } = setup(['I', 'V']);
    actions.appendDefault();
    expect(tokensOf()).toEqual(['I', 'V', 'vi']); // seed: I, V → vi
  });

  it('starts a new song in the same key, undoably', () => {
    const { store, actions } = setup(['I']);
    store.commit({ ...store.state.song, tempo: 90, title: 'Old' });
    actions.newSong();
    expect(store.state.song).toMatchObject({ title: 'Untitled', tempo: 90, chords: [] });
    actions.undo();
    expect(store.state.song.title).toBe('Old');
  });

  it('plays and stops without Web Audio (MIDI-only clock)', async () => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { store, actions } = setup(['I', 'V']);
    actions.select(1);
    actions.togglePlay();
    await vi.waitFor(() => expect(store.state.playing).toBe(true));
    expect(store.state.cursor).toBe(4);
    actions.key({ type: 'togglePlay' });
    expect(store.state.playing).toBe(false);
  });

  it('edits the band with undo/redo and keeps track selection valid', () => {
    const { store, actions } = setup(['I']);
    const tracks = () => store.state.song.tracks ?? [];
    expect(tracks().map((t) => t.name)).toEqual(['Chords', 'Bass', 'Arp']);
    actions.addTrack('pad');
    expect(tracks()).toHaveLength(4);
    const pad = tracks()[3];
    expect(pad).toMatchObject({ role: 'pad', channel: 3 });
    expect(store.state.selectedTrack).toBe(pad?.id);

    actions.key({ type: 'toggleMute' });
    expect(tracks()[3]?.muted).toBe(true);
    actions.moveTrack(pad?.id ?? '', -3);
    expect(tracks()[0]?.id).toBe(pad?.id);
    actions.updateTrack(pad?.id ?? '', { name: 'Strings', channel: 9 });
    expect(tracks()[0]).toMatchObject({ name: 'Strings', channel: 9 });

    actions.undo();
    expect(tracks()[0]).toMatchObject({ name: 'Pad', channel: 3 });
    actions.undo();
    actions.undo();
    expect(tracks()[3]?.muted).toBe(false);
    actions.undo(); // the add
    expect(tracks()).toHaveLength(3);
    expect(store.state.selectedTrack).toBeNull(); // the selected track is gone
    actions.redo();
    expect(tracks()).toHaveLength(4);

    const bass = tracks()[1];
    actions.selectTrack(bass?.id ?? null);
    actions.removeTrack(bass?.id ?? '');
    expect(tracks().map((t) => t.name)).toEqual(['Chords', 'Arp', 'Pad']);
    expect(store.state.selectedTrack).toBeNull();
    actions.selectTrack('no-such-track');
    expect(store.state.selectedTrack).toBeNull();
  });

  it('M does nothing without a selected track; role defaults only on request', () => {
    const { store, actions } = setup(['I']);
    const before = store.state.song;
    actions.key({ type: 'toggleMute' });
    expect(store.state.song).toBe(before);
    const chords = store.state.song.tracks?.[0];
    actions.updateTrack(chords?.id ?? '', { role: 'bass' });
    expect(store.state.song.tracks?.[0]).toMatchObject({ role: 'bass', octave: 4 });
    actions.applyRoleDefaults(chords?.id ?? '');
    expect(store.state.song.tracks?.[0]).toMatchObject({ role: 'bass', octave: 2 });
    expect(store.state.song.tracks?.[0]?.pattern.id).toBe('bass-quarters');
  });

  it('keeps the band on New', () => {
    const { store, actions } = setup(['I']);
    actions.addTrack('pad');
    const ids = store.state.song.tracks?.map((t) => t.id);
    actions.newSong();
    expect(store.state.song.chords).toEqual([]);
    expect(store.state.song.tracks?.map((t) => t.id)).toEqual(ids);
  });

  it('auditions through the selected track on its MIDI channel and velocity', async () => {
    const { midi, sent } = fakeMidi();
    const { store, actions } = setup(['I'], 'major', midi);
    await actions.enableMidi();
    actions.selectMidiOut('port');
    sent.length = 0;
    actions.audition('V'); // no selection: the first unmuted track (chords, ch 1)
    expect(sent.filter((m) => (m[0] ?? 0) >> 4 === 9)).toEqual([
      [0x90, 67, 96],
      [0x90, 71, 96],
      [0x90, 74, 96],
    ]);
    sent.length = 0;
    const bass = store.state.song.tracks?.[1];
    actions.selectTrack(bass?.id ?? null);
    actions.audition('V');
    expect(sent.filter((m) => (m[0] ?? 0) >> 4 === 9)).toEqual([
      [0x91, 43, 100],
      [0x91, 43, 100],
    ]);
    sent.length = 0;
    actions.audition('rest');
    expect(sent).toEqual([]);
  });

  it('sends all-notes-off on the old channel when a track changes channel', async () => {
    const { midi, sent } = fakeMidi();
    const { store, actions } = setup(['I'], 'major', midi);
    await actions.enableMidi();
    actions.selectMidiOut('port');
    sent.length = 0;
    const bass = store.state.song.tracks?.[1];
    actions.updateTrack(bass?.id ?? '', { channel: 5 });
    expect(sent).toEqual([
      [0xb1, 120, 0],
      [0xb1, 123, 0],
    ]);
    sent.length = 0;
    actions.updateTrack(bass?.id ?? '', { velocity: 90 });
    expect(sent).toEqual([]);
  });

  it('sends all-notes-off on every track channel on stop', async () => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { midi, sent } = fakeMidi();
    const { store, actions } = setup(['I', 'V'], 'major', midi);
    await actions.enableMidi();
    actions.selectMidiOut('port');
    actions.togglePlay();
    await vi.waitFor(() => expect(store.state.playing).toBe(true));
    // The first notes went out on the chords (ch 1) and bass (ch 2) channels.
    const status = new Set(sent.map((m) => m[0]));
    expect(status.has(0x90)).toBe(true);
    expect(status.has(0x91)).toBe(true);
    expect(status.has(0x92)).toBe(false); // the arp is muted
    sent.length = 0;
    actions.stop();
    const ccs = sent.filter((m) => (m[0] ?? 0) >> 4 === 0xb && m[1] === 123).map((m) => m[0]);
    expect(ccs).toEqual([0xb0, 0xb1, 0xb2]);
  });

  it('reports Web MIDI as unsupported', async () => {
    const { store, actions } = setup();
    await actions.enableMidi();
    expect(store.state.midiStatus).toBe('unsupported');
  });
});
