/** Everything the views and the keyboard can do, wired to the store, audio and MIDI. */
import type { Degree, MelodyNote, Song, TrackRole } from '@crokychords/core';
import {
  MELODY_OCTAVE_MAX,
  MELODY_OCTAVE_MIN,
  MELODY_TRACK_ID,
  MELODY_VELOCITY,
  createSong,
  diatonicTriadToken,
  melodyNotePitch,
  songKey,
  totalBeats,
} from '@crokychords/core';
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
import type { LoopRange } from './loop';
import { playStart, withLoopEnd, withLoopStart } from './loop';
import type { MelodyGrid } from './melody';
import {
  noteIndexAt,
  moveNote,
  placeNote,
  removeNote,
  setMelodyChannel,
  setNoteLength,
  setNoteOctave,
  songMelody,
  stepNote,
  toggleAccidental,
  toggleMelodyMute,
} from './melody';
import type { Focus, MelodyKeyAction } from './melodyKeys';
import { downloadMidi } from './midi/download';
import type { MidiOut } from './midi/webmidi';
import type { Store } from './state';
import { clampTrackSelection } from './state';
import { melodyLaneBeats } from './views/melody';
import { computeSuggestions } from './views/suggest';

/** Delay before an audition starts, so its attack is not clipped (seconds). */
const AUDITION_DELAY_S = 0.01;

export interface Actions {
  /** Select a chord, or the "+" slot after the last chord (`null`). */
  select(index: number | null): void;
  /**
   * Pick a chord (docs/specs/web-v1.md §3): replace the selected chord's token, keeping its length
   * and position; on the "+" slot append it (the "+" slot stays selected). `insert` inserts it
   * after the selected chord instead and selects the new chord. One undo step.
   */
  place(token: string, insert?: boolean): void;
  /** `place` the diatonic triad of `degree` and audition it. */
  placeDegree(degree: Degree, insert?: boolean): void;
  /**
   * Explicit add: insert a copy of the selected chord after it (on the "+" slot: of the last
   * chord, or the tonic triad in an empty song) and select the copy.
   */
  insertSlot(): void;
  /** The top suggestion (or the tonic triad) appended at the end (Fire append slot). */
  appendDefault(): void;
  /** Remove the selected chord; on the "+" slot the last chord. */
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
  /**
   * Play from the start (the loop start when looping, else beat 0), or stop. `fromSelection`
   * plays from the selected chord instead.
   */
  togglePlay(fromSelection?: boolean): void;
  stop(): void;
  setLoop(loop: boolean): void;
  toggleLoop(): void;
  /** Set the loop points (null clears them); setting a range turns looping on. */
  setLoopRange(range: LoopRange | null): void;
  /** Play `token` through the selected track (fallback: the first unmuted track). */
  audition(token: string): void;
  enableMidi(): Promise<void>;
  selectMidiOut(id: string | null): void;
  exportMidi(): void;
  /** Create/resume the AudioContext (call from a user gesture). */
  startAudio(): Promise<boolean>;
  key(action: KeyAction): void;
  /** Which lane the editing keys act on. */
  setFocus(focus: Focus): void;
  setMelodyGrid(grid: MelodyGrid): void;
  /** Move the melody cursor (clamped to the lane). */
  setMelodyCursor(beat: number): void;
  setMelodyChannel(channel: number): void;
  toggleMelodyMute(): void;
  /** Play one melody note through the lead instrument (and on the melody's MIDI channel). */
  auditionNote(note: MelodyNote): void;
  melodyKey(action: MelodyKeyAction): void;
}

/** Longest length the keyboard gives new melody notes, in beats. */
const MAX_ENTRY_LENGTH = 16;
/** Longest melody audition, in beats. */
const NOTE_AUDITION_BEATS = 1;

export function createActions(store: Store, audio: AudioEngine, midi: MidiOut): Actions {
  const roleOf = (trackId: string): TrackRole =>
    findTrack(store.state.song, trackId)?.role ?? 'chords';
  const synthSink: NoteSink = {
    playNote: (event, time, duration) => {
      const synth = audio.synth;
      if (synth === null) return;
      const voice =
        event.trackId === MELODY_TRACK_ID
          ? { instrument: synth.leadInstrument() }
          : { role: roleOf(event.trackId) };
      synth.playNote(event.note, time, duration, {
        ...voice,
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
    stopAll: () => midi.allNotesOff(playingChannels(store.state.song)),
    loopWrap: (time) =>
      midi.notesOffAt(playingChannels(store.state.song), audio.toPerformanceTime(time)),
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
    if (state.loop !== previous.loop || state.loopRange !== previous.loopRange) {
      scheduler.setLoop(state.loop, state.loopRange);
    }
    if (state.song === previous.song) return;
    scheduler.update(state.song);
    silenceMelody(previous.song, state.song);
    const before = songTracks(previous.song);
    const after = songTracks(state.song);
    if (before === after) return;
    // Tracks muted, removed or moved to another channel: cut what they still hold.
    for (const id of silencedTracks(before, after)) audio.synth?.stopTrack(id);
    for (const channel of channelsToSilence(before, after)) midi.channelOff(channel);
  });

  /** Muted or moved to another channel: cut what the melody still holds. */
  const silenceMelody = (before: Song, after: Song): void => {
    const old = songMelody(before);
    const now = songMelody(after);
    if (old.muted || (!now.muted && now.channel === old.channel)) return;
    audio.synth?.stopTrack(MELODY_TRACK_ID);
    const live = songTracks(after).some((t) => !t.muted && t.channel === old.channel);
    if (!live) midi.channelOff(old.channel);
  };

  const commit = (song: Song, selected: number | null): void => {
    store.commit(song, { selected });
  };

  const clampCursor = (beat: number, song: Song = store.state.song): number => {
    const max = Math.max(0, melodyLaneBeats(song) - store.state.melodyGrid);
    return Math.min(max, Math.max(0, beat));
  };

  /** Audition note `index` of `song` (after an edit), unless the song is playing. */
  const hear = (song: Song, index: number | null): void => {
    const note = index === null ? undefined : songMelody(song).notes[index];
    if (note !== undefined && !store.state.playing) actions.auditionNote(note);
  };

  const actions: Actions = {
    select(index) {
      store.set({ selected: clampSelection(index, store.state.song.chords.length) });
    },

    place(token, insert = false) {
      const { song, selected } = store.state;
      if (selected === null || song.chords[selected] === undefined) {
        commit(insertAfter(song, null, token).song, null);
      } else if (insert) {
        const result = insertAfter(song, selected, token);
        commit(result.song, result.selected);
      } else {
        commit(setChordToken(song, selected, token), selected);
      }
    },

    placeDegree(degree, insert = false) {
      const token = diatonicTriadToken(degree, store.state.song.key.mode);
      actions.place(token, insert);
      actions.audition(token);
    },

    insertSlot() {
      const { song, selected } = store.state;
      const at = selected === null || song.chords[selected] === undefined ? null : selected;
      const source = at === null ? song.chords.at(-1) : song.chords[at];
      const token = source?.token ?? diatonicTriadToken(1, song.key.mode);
      const result = insertAfter(song, at, token);
      commit(result.song, result.selected);
    },

    appendDefault() {
      const { song } = store.state;
      const top = computeSuggestions({ ...store.state, selected: null }).items[0];
      const token = top?.token ?? diatonicTriadToken(1, song.key.mode);
      commit(insertAfter(song, null, token).song, null);
    },

    removeSelected() {
      const { song, selected } = store.state;
      if (selected === null) {
        // The "+" slot: remove the chord before it, like Backspace at the end of a line.
        if (song.chords.length === 0) return;
        commit(removeChord(song, song.chords.length - 1).song, null);
        return;
      }
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
      // The band and the melody's routing carry over; chords and melody notes start empty.
      const song = createSong({
        key: { ...key },
        tempo,
        meter: { ...meter },
        ...(tracks === undefined ? {} : { tracks }),
        melody: { ...songMelody(store.state.song), notes: [] },
      });
      store.commit(song, { selected: null, cursor: 0, melodyCursor: 0 });
    },

    undo() {
      store.undo();
    },

    redo() {
      store.redo();
    },

    togglePlay(fromSelection = false) {
      if (store.state.playing) actions.stop();
      else void play(fromSelection);
    },

    stop() {
      scheduler.stop();
      stopped();
    },

    setLoop(loop) {
      store.set({ loop });
    },

    toggleLoop() {
      actions.setLoop(!store.state.loop);
    },

    setLoopRange(range) {
      store.set(range === null ? { loopRange: null } : { loopRange: range, loop: true });
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

    setFocus(focus) {
      if (store.state.focus !== focus) store.set({ focus });
    },

    setMelodyGrid(grid) {
      if (store.state.melodyGrid !== grid) store.set({ melodyGrid: grid });
    },

    setMelodyCursor(beat) {
      store.set({ melodyCursor: clampCursor(beat) });
    },

    setMelodyChannel(channel) {
      store.commit(setMelodyChannel(store.state.song, channel));
    },

    toggleMelodyMute() {
      store.commit(toggleMelodyMute(store.state.song));
    },

    auditionNote(note) {
      const { song } = store.state;
      const melody = songMelody(song);
      const pitch = melodyNotePitch(note, songKey(song));
      const seconds = (Math.min(note.length, NOTE_AUDITION_BEATS) * 60) / song.tempo;
      const ctx = audio.context;
      const synth = audio.synth;
      if (audio.ready && ctx !== null && synth !== null) {
        synth.playNote(pitch, ctx.currentTime + AUDITION_DELAY_S, seconds, {
          instrument: synth.leadInstrument(),
          velocity: MELODY_VELOCITY,
          track: MELODY_TRACK_ID,
        });
      }
      midi.playNote(melody.channel, pitch, MELODY_VELOCITY, performance.now(), seconds * 1000);
    },

    melodyKey(action) {
      const state = store.state;
      const { song, melodyCursor: cursor, melodyGrid: grid } = state;
      const index = noteIndexAt(song, cursor);
      const note = index === null ? undefined : songMelody(song).notes[index];
      switch (action.type) {
        case 'toggleFocus':
          actions.setFocus(state.focus === 'melody' ? 'chords' : 'melody');
          break;
        case 'leave':
          actions.setFocus('chords');
          break;
        case 'place': {
          const placed = placeNote(song, {
            beat: cursor,
            length: state.melodyLength,
            degree: action.degree,
            octave: state.melodyOctave,
            accidental: 0,
          });
          const next = cursor + state.melodyLength;
          store.commit(placed.song, { melodyCursor: clampCursor(next, placed.song) });
          hear(placed.song, placed.index);
          break;
        }
        case 'cursor': {
          const steps = cursor / grid;
          const target = action.delta > 0 ? Math.floor(steps) + 1 : Math.ceil(steps) - 1;
          actions.setMelodyCursor(target * grid);
          break;
        }
        case 'home':
          actions.setMelodyCursor(0);
          break;
        case 'move': {
          if (index === null) break;
          const moved = moveNote(song, index, action.delta * grid);
          if (moved === song) break;
          store.commit(moved, { melodyCursor: clampCursor(cursor + action.delta * grid, moved) });
          hear(moved, index);
          break;
        }
        case 'step': {
          if (index === null) break;
          const stepped = stepNote(song, index, action.delta);
          store.commit(stepped);
          if (stepped !== song) hear(stepped, index);
          break;
        }
        case 'octave': {
          if (index === null || note === undefined) {
            const octave = state.melodyOctave + action.delta;
            const clamped = Math.min(MELODY_OCTAVE_MAX, Math.max(MELODY_OCTAVE_MIN, octave));
            store.set({ melodyOctave: clamped });
            break;
          }
          const changed = setNoteOctave(song, index, note.octave + action.delta);
          const octave = songMelody(changed).notes[index]?.octave ?? note.octave;
          store.commit(changed, { melodyOctave: octave });
          if (changed !== song) hear(changed, index);
          break;
        }
        case 'length': {
          if (index === null || note === undefined) {
            const length = state.melodyLength + action.delta * grid;
            store.set({ melodyLength: Math.min(MAX_ENTRY_LENGTH, Math.max(grid, length)) });
            break;
          }
          const changed = setNoteLength(song, index, note.length + action.delta * grid);
          const length = songMelody(changed).notes[index]?.length ?? note.length;
          store.commit(changed, { melodyLength: length });
          break;
        }
        case 'accidental': {
          if (index === null) break;
          const changed = toggleAccidental(song, index, action.accidental);
          store.commit(changed);
          hear(changed, index);
          break;
        }
        case 'remove':
          if (index === null || note === undefined) break;
          store.commit(removeNote(song, index), { melodyCursor: note.beat });
          break;
        case 'grid':
          actions.setMelodyGrid(grid === 0.5 ? 0.25 : 0.5);
          break;
      }
    },

    key(action) {
      switch (action.type) {
        case 'degree':
          actions.placeDegree(action.degree, action.insert ?? false);
          break;
        case 'insertSlot':
          actions.insertSlot();
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
          actions.togglePlay(action.fromSelection ?? false);
          break;
        case 'toggleLoop':
          actions.toggleLoop();
          break;
        case 'loopStart':
        case 'loopEnd': {
          // At the selected chord: its start for `[`, its end for `]`.
          const { song, selected, loopRange } = store.state;
          const chord = selected === null ? undefined : song.chords[selected];
          if (selected === null || chord === undefined) break;
          const start = chordStart(song, selected);
          actions.setLoopRange(
            action.type === 'loopStart'
              ? withLoopStart(loopRange, start, totalBeats(song))
              : withLoopEnd(loopRange, start + chord.beats),
          );
          break;
        }
        case 'endSlot':
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

  /** MIDI channels with sound: every track's and the melody's. */
  function playingChannels(song: Song): number[] {
    const channels = new Set(trackChannels(songTracks(song)));
    channels.add(songMelody(song).channel);
    return [...channels].sort((a, b) => a - b);
  }

  async function play(fromSelection: boolean): Promise<void> {
    await actions.startAudio();
    const { song, selected, loop, loopRange } = store.state;
    if (song.chords.length === 0) return;
    const fromBeat =
      fromSelection && selected !== null
        ? chordStart(song, selected)
        : playStart(loop, loopRange, totalBeats(song));
    scheduler.start(song, { fromBeat, loop, range: loopRange });
    if (!scheduler.playing) return;
    store.set({ playing: true, cursor: scheduler.position() ?? fromBeat });
    if (frame === null) frame = requestAnimationFrame(follow);
  }

  return actions;
}
