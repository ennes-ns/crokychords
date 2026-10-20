/** Everything the views and the keyboard can do, wired to the store, audio and MIDI. */
import type { Degree, Song, TrackRole } from '@crokychords/core';
import { createSong, diatonicTriadToken } from '@crokychords/core';
import type { NoteSink } from './audio/scheduler';
import { Scheduler } from './audio/scheduler';
import type { AudioEngine, NoteHandle } from './audio/synth';
import type { TrackPatch } from './band';
import {
  addTrack,
  applyRoleDefaults,
  auditionEvents,
  auditionTrack,
  channelsToSilence,
  findTrack,
  moveTrack,
  removeTrack,
  silencedTracks,
  songTracks,
  toggleMute,
  trackChannels,
  updateTrack,
} from './band';
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
import type { Store } from './state';
import { clampTrackSelection } from './state';
import { computeSuggestions } from './views/suggest';

/** Delay before an audition starts, so its attack is not clipped (seconds). */
const AUDITION_DELAY_S = 0.01;

export interface Actions {
  select(index: number | null): void;
  insert(token: string): void;
  /** Click on empty grid space: the top suggestion (or the tonic triad) at the end. */
  appendDefault(): void;
  addDegree(degree: Degree): void;
  removeSelected(): void;
  resizeSelected(delta: number): void;
  setSelectedToken(token: string): void;
  /** Commit an edited song; `base` is the song to undo to (after previews). */
  updateSong(song: Song, base?: Song): void;
  /** Show and play an edited song without recording history (range drags). */
  previewSong(song: Song): void;
  selectTrack(id: string | null): void;
  addTrack(role: TrackRole): void;
  removeTrack(id: string): void;
  moveTrack(id: string, delta: number): void;
  updateTrack(id: string, patch: TrackPatch): void;
  toggleMute(id: string): void;
  /** Apply ROLE_DEFAULTS of the track's role (octave, pattern, velocity). */
  applyRoleDefaults(id: string): void;
  newSong(): void;
  undo(): void;
  redo(): void;
  togglePlay(): void;
  stop(): void;
  setLoop(loop: boolean): void;
  /** Play `token` through the selected track (fallback: the first unmuted track). */
  audition(token: string): void;
  enableMidi(): Promise<void>;
  selectMidiOut(id: string | null): void;
  exportMidi(): void;
  /** Create/resume the AudioContext (call from a user gesture). */
  startAudio(): Promise<boolean>;
  key(action: KeyAction): void;
}

export function createActions(store: Store, audio: AudioEngine, midi: MidiOut): Actions {
  const roleOf = (trackId: string): TrackRole =>
    findTrack(store.state.song, trackId)?.role ?? 'chords';
  const synthSink: NoteSink = {
    playNote: (event, time, duration) => {
      audio.synth?.playNote(event.note, time, duration, {
        role: roleOf(event.trackId),
        velocity: event.velocity,
        track: event.trackId,
      });
    },
    stopAll: () => audio.synth?.stopAll(),
    playDrum: (hit, time) => audio.synth?.playDrum(hit.drum, hit.level, time),
  };
  const midiSink: NoteSink = {
    playNote: (event, time, duration) =>
      midi.playNote(
        event.channel,
        event.note,
        event.velocity,
        audio.toPerformanceTime(time),
        duration * 1000,
      ),
    stopAll: () => midi.allNotesOff(trackChannels(songTracks(store.state.song))),
  };
  const scheduler = new Scheduler(
    { now: () => audio.context?.currentTime ?? performance.now() / 1000 },
    () => [synthSink, midiSink],
    undefined,
    () => audio.sound.drums,
  );
  let frame: number | null = null;
  let auditionHandle: NoteHandle | null = null;

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
    if (state.song === previous.song) return;
    scheduler.update(state.song);
    const before = songTracks(previous.song);
    const after = songTracks(state.song);
    if (before === after) return;
    // Tracks muted, removed or moved to another channel: cut what they still hold.
    for (const id of silencedTracks(before, after)) audio.synth?.stopTrack(id);
    for (const channel of channelsToSilence(before, after)) midi.channelOff(channel);
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
      const token = top?.token ?? diatonicTriadToken(1, song.key.mode);
      const result = insertAfter(song, null, token);
      commit(result.song, result.selected);
    },

    addDegree(degree) {
      const token = diatonicTriadToken(degree, store.state.song.key.mode);
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

    updateSong(song, base) {
      store.commit(song, {}, base === undefined ? {} : { base });
    },

    previewSong(song) {
      store.preview(song);
    },

    selectTrack(id) {
      store.set({ selectedTrack: clampTrackSelection(id, store.state.song) });
    },

    addTrack(role) {
      const result = addTrack(store.state.song, role);
      store.commit(result.song, { selectedTrack: result.trackId });
    },

    removeTrack(id) {
      const song = removeTrack(store.state.song, id);
      store.commit(song, { selectedTrack: clampTrackSelection(store.state.selectedTrack, song) });
    },

    moveTrack(id, delta) {
      store.commit(moveTrack(store.state.song, id, delta));
    },

    updateTrack(id, patch) {
      store.commit(updateTrack(store.state.song, id, patch));
    },

    toggleMute(id) {
      store.commit(toggleMute(store.state.song, id));
    },

    applyRoleDefaults(id) {
      store.commit(applyRoleDefaults(store.state.song, id));
    },

    newSong() {
      actions.stop();
      const { key, tempo, meter, tracks } = store.state.song;
      // The band (and its DAW routing) carries over; only the chords start empty.
      const song = createSong({
        key: { ...key },
        tempo,
        meter: { ...meter },
        ...(tracks === undefined ? {} : { tracks }),
      });
      store.commit(song, { selected: null, cursor: 0 });
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
      const { song, selectedTrack } = store.state;
      const track = auditionTrack(song, selectedTrack);
      const events = auditionEvents(song, token, track);
      if (events.length === 0) return;
      auditionHandle?.release();
      auditionHandle = null;
      const secondsPerBeat = 60 / song.tempo;
      const ctx = audio.context;
      const synth = audio.synth;
      if (audio.ready && ctx !== null && synth !== null) {
        const t0 = ctx.currentTime + AUDITION_DELAY_S;
        const handles = events.map((e) =>
          synth.playNote(e.note, t0 + e.start * secondsPerBeat, e.duration * secondsPerBeat, {
            role: track.role,
            velocity: e.velocity,
            track: track.id,
          }),
        );
        auditionHandle = { release: (at) => handles.forEach((h) => h.release(at)) };
      }
      const now = performance.now();
      for (const e of events) {
        const start = now + e.start * secondsPerBeat * 1000;
        midi.playNote(e.channel, e.note, e.velocity, start, e.duration * secondsPerBeat * 1000);
      }
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
        case 'toggleMute': {
          const id = store.state.selectedTrack;
          if (id !== null) actions.toggleMute(id);
          break;
        }
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
