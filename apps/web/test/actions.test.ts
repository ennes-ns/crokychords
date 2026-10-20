import { createSong, patternPreset } from '@crokychords/core';
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

  it('typing 1 5 6 4 on the "+" slot of an empty song builds four chords', () => {
    const { store, actions, tokensOf } = setup();
    expect(store.state.selected).toBeNull(); // the "+" slot
    for (const degree of [1, 5, 6, 4] as const) actions.key({ type: 'degree', degree });
    expect(tokensOf()).toEqual(['I', 'V', 'vi', 'IV']);
    expect(store.state.selected).toBeNull();
    // Each pick is its own undo step.
    actions.undo();
    expect(tokensOf()).toEqual(['I', 'V', 'vi']);
  });

  it('a pick on a selected chord replaces it, keeping its length and position; undo restores it', () => {
    const { store, actions, tokensOf } = setup(['I', 'V', 'vi']);
    actions.select(1);
    actions.resizeSelected(-1);
    const before = store.state.song;
    actions.place('IV');
    expect(tokensOf()).toEqual(['I', 'IV', 'vi']);
    expect(store.state.song.chords.map((c) => c.beats)).toEqual([4, 3, 4]);
    expect(store.state.selected).toBe(1);
    actions.key({ type: 'degree', degree: 2 });
    expect(tokensOf()).toEqual(['I', 'ii', 'vi']);
    expect(store.state.song.chords).toHaveLength(3);
    actions.undo();
    actions.undo();
    expect(store.state.song).toBe(before);
    actions.redo();
    expect(tokensOf()).toEqual(['I', 'IV', 'vi']);
  });

  it('a pick on the "+" slot appends with the previous length and keeps the "+" slot', () => {
    const { store, actions, tokensOf } = setup(['I', 'V']);
    actions.select(1);
    actions.resizeSelected(-2);
    actions.select(null);
    actions.place('vi');
    expect(tokensOf()).toEqual(['I', 'V', 'vi']);
    expect(store.state.song.chords.map((c) => c.beats)).toEqual([4, 2, 2]);
    expect(store.state.selected).toBeNull();
  });

  it('Shift inserts after the selected chord instead and selects the new chord', () => {
    const { store, actions, tokensOf } = setup(['i', 'iv'], 'minor');
    actions.select(0);
    actions.key({ type: 'degree', degree: 6, insert: true });
    expect(tokensOf()).toEqual(['i', 'VI', 'iv']);
    expect(store.state.selected).toBe(1);
    actions.place('III', true);
    expect(tokensOf()).toEqual(['i', 'VI', 'III', 'iv']);
    expect(store.state.selected).toBe(2);
  });

  it('Insert adds a copy of the selected chord after it and selects it', () => {
    const { store, actions, tokensOf } = setup(['I', 'V']);
    actions.select(0);
    actions.key({ type: 'insertSlot' });
    expect(tokensOf()).toEqual(['I', 'I', 'V']);
    expect(store.state.selected).toBe(1);
    actions.place('IV'); // the next pick replaces the copy
    expect(tokensOf()).toEqual(['I', 'IV', 'V']);
    actions.select(null);
    actions.key({ type: 'insertSlot' }); // on the "+" slot: a copy of the last chord
    expect(tokensOf()).toEqual(['I', 'IV', 'V', 'V']);
    expect(store.state.selected).toBe(3);
  });

  it('Insert in an empty song adds the tonic triad', () => {
    const { store, actions, tokensOf } = setup([], 'minor');
    actions.insertSlot();
    expect(tokensOf()).toEqual(['i']);
    expect(store.state.selected).toBe(0);
  });

  it('arrows and Enter walk the slots, including the "+" slot', () => {
    const { store, actions } = setup(['I', 'V']);
    actions.key({ type: 'move', delta: 1 }); // already on "+"
    expect(store.state.selected).toBeNull();
    actions.key({ type: 'move', delta: -1 });
    expect(store.state.selected).toBe(1);
    actions.key({ type: 'move', delta: -5 });
    expect(store.state.selected).toBe(0);
    actions.key({ type: 'move', delta: 1 });
    actions.key({ type: 'move', delta: 1 }); // past the last chord
    expect(store.state.selected).toBeNull();
    actions.select(0);
    actions.key({ type: 'endSlot' });
    expect(store.state.selected).toBeNull();
  });

  it('removes, resizes, undoes and redoes; Backspace on "+" removes the last chord', () => {
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
    actions.key({ type: 'endSlot' });
    actions.key({ type: 'remove' });
    expect(tokensOf()).toEqual(['I']);
    expect(store.state.selected).toBeNull();
  });

  it('appends the top suggestion (Fire append slot)', () => {
    const { store, actions, tokensOf } = setup(['I', 'V']);
    actions.select(0);
    actions.appendDefault();
    expect(tokensOf()).toEqual(['I', 'V', 'vi']); // seed: I, V → vi
    expect(store.state.selected).toBeNull();
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
    expect(store.state.cursor).toBe(0); // Play starts from the beginning, not the selection
    actions.key({ type: 'togglePlay' });
    expect(store.state.playing).toBe(false);
    actions.key({ type: 'togglePlay', fromSelection: true }); // Shift+Space
    await vi.waitFor(() => expect(store.state.playing).toBe(true));
    expect(store.state.cursor).toBe(4);
    actions.stop();
  });

  it('starts at the loop start when looping a range, else at beat 0', async () => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { store, actions } = setup(['I', 'IV', 'V', 'I']);
    actions.setLoopRange({ start: 4, end: 12 });
    expect(store.state.loop).toBe(true); // setting loop points turns looping on
    actions.togglePlay();
    await vi.waitFor(() => expect(store.state.playing).toBe(true));
    expect(store.state.cursor).toBe(4);
    actions.stop();
    actions.key({ type: 'toggleLoop' });
    expect(store.state.loop).toBe(false);
    actions.togglePlay();
    await vi.waitFor(() => expect(store.state.playing).toBe(true));
    expect(store.state.cursor).toBe(0); // the range is kept but not used while not looping
    actions.stop();
    expect(store.state.loopRange).toEqual({ start: 4, end: 12 });
    actions.setLoopRange(null);
    expect(store.state.loopRange).toBeNull();
  });

  it('sets loop points at the selected chord with Alt+[ and Alt+]', () => {
    const { store, actions } = setup(['I', 'IV', 'V', 'I']);
    actions.key({ type: 'loopStart' }); // nothing selected: no-op
    expect(store.state.loopRange).toBeNull();
    actions.select(1);
    actions.key({ type: 'loopStart' });
    expect(store.state.loopRange).toEqual({ start: 4, end: 16 }); // to the end of the song
    actions.select(2);
    actions.key({ type: 'loopEnd' });
    expect(store.state.loopRange).toEqual({ start: 4, end: 12 });
    actions.select(0);
    actions.key({ type: 'loopEnd' }); // an end before the start resets the start to 0
    expect(store.state.loopRange).toEqual({ start: 0, end: 4 });
    expect(store.state.loop).toBe(true);
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

  it('opens one pattern editor, edits with undo, and closes it when its track is gone', () => {
    const { store, actions } = setup(['I']);
    const tracks = () => store.state.song.tracks ?? [];
    const bass = tracks()[1]?.id ?? '';
    actions.openPatternEditor(bass);
    expect(store.state).toMatchObject({ patternEditor: bass, selectedTrack: bass });
    actions.openPatternEditor('no-such-track');
    expect(store.state.patternEditor).toBeNull();
    actions.openPatternEditor(bass);

    const before = store.state.song;
    const edited = { ...patternPreset('bass-walk-4'), id: 'custom' };
    actions.previewPattern(bass, edited);
    expect(store.canUndo).toBe(false);
    actions.editPattern(bass, edited, before);
    expect(tracks()[1]?.pattern).toEqual(edited);
    actions.undo();
    expect(store.state.song).toBe(before);
    actions.redo();

    expect(actions.savePatternPreset(bass, 'Walk')).toBe(true);
    expect(actions.savePatternPreset(bass, ' ')).toBe(false);
    const presetId = store.state.song.patterns?.[0]?.id ?? '';
    expect(tracks()[1]?.pattern.id).toBe(presetId);
    actions.setTrackPattern(tracks()[0]?.id ?? '', presetId);
    expect(tracks()[0]?.pattern.name).toBe('Walk');
    actions.deletePatternPreset(presetId);
    expect(store.state.song.patterns).toEqual([]);
    expect(tracks()[0]?.pattern.id).toBe('custom');

    actions.removeTrack(bass);
    expect(store.state.patternEditor).toBeNull();
    actions.undo();
    actions.openPatternEditor(bass);
    actions.redo(); // the removal again: the editor's track is gone
    expect(store.state.patternEditor).toBeNull();
    actions.openPatternEditor(null);
    expect(store.state.patternEditor).toBeNull();
  });

  it('keeps the band on New', () => {
    const { store, actions } = setup(['I']);
    actions.addTrack('pad');
    const ids = store.state.song.tracks?.map((t) => t.id);
    actions.savePatternPreset(ids?.[0] ?? '', 'Kept');
    actions.newSong();
    expect(store.state.song.chords).toEqual([]);
    expect(store.state.song.tracks?.map((t) => t.id)).toEqual(ids);
    expect(store.state.song.patterns?.map((p) => p.name)).toEqual(['Kept']);
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
    // Every track channel plus the melody's (channel 4).
    expect(ccs).toEqual([0xb0, 0xb1, 0xb2, 0xb3]);
  });

  it('reports Web MIDI as unsupported', async () => {
    const { store, actions } = setup();
    await actions.enableMidi();
    expect(store.state.midiStatus).toBe('unsupported');
  });
});
