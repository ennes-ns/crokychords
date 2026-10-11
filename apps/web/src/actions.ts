/** Everything the views and the keyboard can do, wired to the store, audio and MIDI. */
import type { Degree, Song } from '@crokychords/core';
import { createSong, isRestToken, songKey, tryParseToken, voiceChord } from '@crokychords/core';
import type { AudioEngine, ChordHandle } from './audio/synth';
import type { ChordSink } from './audio/scheduler';
import { Scheduler } from './audio/scheduler';
import {
  chordStart,
  clampSelection,
  insertAfter,
  moveSelection,
  removeChord,
  resizeChord,
  setChordToken,
} from './edit';
import type { KeyAction } from './keyboard';
import { downloadMidi } from './midi/download';
import type { MidiOut } from './midi/webmidi';
import { diatonicTriadToken } from './music';
import type { Store } from './state';
import { computeSuggestions } from './views/suggest';

export const AUDITION_MS = 600;

export interface Actions {
  select(index: number | null): void;
  insert(token: string): void;
  /** Click on empty grid space: the top suggestion (or the tonic triad) at the end. */
  appendDefault(): void;
  addDegree(degree: Degree): void;
  removeSelected(): void;
  resizeSelected(delta: number): void;
  setSelectedToken(token: string): void;
  updateSong(song: Song): void;
  newSong(): void;
  undo(): void;
  redo(): void;
  togglePlay(): void;
  stop(): void;
  setLoop(loop: boolean): void;
  audition(token: string): void;
  enableMidi(): Promise<void>;
  selectMidiOut(id: string | null): void;
  exportMidi(): void;
  /** Create/resume the AudioContext (call from a user gesture). */
  startAudio(): Promise<boolean>;
  key(action: KeyAction): void;
}

export function createActions(store: Store, audio: AudioEngine, midi: MidiOut): Actions {
  const synthSink: ChordSink = {
    playChord: (notes, time, duration) => audio.synth?.playChord(notes, time, duration),
    stopAll: () => audio.synth?.stopAll(),
  };
  const midiSink: ChordSink = {
    playChord: (notes, time, duration) =>
      midi.playChord(notes, audio.toPerformanceTime(time), duration * 1000),
    stopAll: () => midi.allNotesOff(),
  };
  const scheduler = new Scheduler(
    { now: () => audio.context?.currentTime ?? performance.now() / 1000 },
    () => [synthSink, midiSink],
  );
  let frame: number | null = null;
  let auditionHandle: ChordHandle | null = null;

  const follow = (): void => {
    const position = scheduler.position();
    if (position === null) {
      frame = null;
      return;
    }
    store.set({ cursor: position });
    frame = requestAnimationFrame(follow);
  };

  const stopped = (): void => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    store.set({ playing: false });
  };
  scheduler.onEnd = stopped;

  store.subscribe((state, previous) => {
    if (state.song !== previous.song) scheduler.update(state.song);
  });

  const commit = (song: Song, selected: number | null): void => {
    store.commit(song, { selected });
  };

  const actions: Actions = {
    select(index) {
      store.set({ selected: clampSelection(index, store.state.song.chords.length) });
    },

    insert(token) {
      const { song, selected } = store.state;
      const result = insertAfter(song, selected, token);
      commit(result.song, result.selected);
    },

    appendDefault() {
      const { song } = store.state;
      const top = computeSuggestions({ ...store.state, selected: null }).items[0];
      const token = top?.token ?? diatonicTriadToken(song.key.mode, 1);
      const result = insertAfter(song, null, token);
      commit(result.song, result.selected);
    },

    addDegree(degree) {
      const token = diatonicTriadToken(store.state.song.key.mode, degree);
      actions.insert(token);
      actions.audition(token);
    },

    removeSelected() {
      const { song, selected } = store.state;
      if (selected === null) return;
      const result = removeChord(song, selected);
      commit(result.song, result.selected);
    },

    resizeSelected(delta) {
      const { song, selected } = store.state;
      if (selected === null) return;
      commit(resizeChord(song, selected, delta), selected);
    },

    setSelectedToken(token) {
      const { song, selected } = store.state;
      if (selected === null) return;
      commit(setChordToken(song, selected, token), selected);
    },

    updateSong(song) {
      store.commit(song);
    },

    newSong() {
      actions.stop();
      const { key, tempo, meter } = store.state.song;
      store.commit(createSong({ key: { ...key }, tempo, meter: { ...meter } }), {
        selected: null,
        cursor: 0,
      });
    },

    undo() {
      store.undo();
    },

    redo() {
      store.redo();
    },

    togglePlay() {
      if (store.state.playing) actions.stop();
      else void play();
    },

    stop() {
      scheduler.stop();
      stopped();
    },

    setLoop(loop) {
      scheduler.setLoop(loop);
      store.set({ loop });
    },

    audition(token) {
      if (isRestToken(token)) return;
      const chord = tryParseToken(token);
      if (chord === undefined) return;
      const notes = voiceChord(chord, songKey(store.state.song));
      auditionHandle?.release();
      auditionHandle = null;
      const ctx = audio.context;
      const synth = audio.synth;
      if (audio.ready && ctx !== null && synth !== null) {
        auditionHandle = synth.playChord(notes, ctx.currentTime + 0.01, AUDITION_MS / 1000);
      }
      midi.playChord(notes, performance.now(), AUDITION_MS);
    },

    async enableMidi() {
      store.set({ midiStatus: 'pending' });
      const result = await midi.enable();
      midi.onOutputsChange = (outputs) => {
        const current = store.state.midiOut;
        const midiOut = outputs.some((o) => o.id === current) ? current : null;
        midi.select(midiOut);
        store.set({ midiOutputs: outputs, midiOut });
      };
      store.set({ midiStatus: result, midiOutputs: midi.outputs() });
    },

    selectMidiOut(id) {
      midi.select(id);
      store.set({ midiOut: midi.selected });
    },

    exportMidi() {
      downloadMidi(store.state.song);
    },

    async startAudio() {
      const ok = await audio.start();
      if (ok !== store.state.audioReady) store.set({ audioReady: ok });
      return ok;
    },

    key(action) {
      switch (action.type) {
        case 'degree':
          actions.addDegree(action.degree);
          break;
        case 'remove':
          actions.removeSelected();
          break;
        case 'resize':
          actions.resizeSelected(action.delta);
          break;
        case 'move': {
          const { selected, song } = store.state;
          const next = moveSelection(selected, action.delta, song.chords.length);
          actions.select(next);
          const chord = next === null ? undefined : song.chords[next];
          if (chord !== undefined && !store.state.playing) actions.audition(chord.token);
          break;
        }
        case 'togglePlay':
          actions.togglePlay();
          break;
        case 'deselect':
          actions.select(null);
          break;
        case 'undo':
          actions.undo();
          break;
        case 'redo':
          actions.redo();
          break;
      }
    },
  };

  async function play(): Promise<void> {
    await actions.startAudio();
    const { song, selected, loop } = store.state;
    if (song.chords.length === 0) return;
    const fromBeat = selected === null ? 0 : chordStart(song, selected);
    scheduler.start(song, { fromBeat, loop });
    if (!scheduler.playing) return;
    store.set({ playing: true, cursor: fromBeat });
    if (frame === null) frame = requestAnimationFrame(follow);
  }

  return actions;
}
