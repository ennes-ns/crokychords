import type { Chord } from './chords';
import { chordPitchClasses, chordRootPitchClass, voiceChord } from './chords';
import type { MelodyNote } from './melody';
import { MELODY_GATE, MELODY_TRACK_ID, MELODY_VELOCITY, melodyNotePitch } from './melody';
import type { Song } from './progression';
import { chordAtBeat, songKey, totalBeats } from './progression';
import type { Key } from './theory';
import { midiNote, toPitchClass } from './theory';
import { isRestToken, parseToken } from './token';
import type { NoteSelector, Pattern, PatternStep, Track } from './tracks';

export interface NoteEvent {
  trackId: string;
  /** MIDI channel 0-15. */
  channel: number;
  /** 0-127. */
  note: number;
  /** 1-127. */
  velocity: number;
  /** Beats from song start. */
  start: number;
  /** Beats, > 0. */
  duration: number;
}

export interface RenderOptions {
  /** Render muted tracks too, default false. */
  includeMuted?: boolean;
}

/** One placed step of a pattern inside a chord. */
export interface StepOccurrence {
  /** Beat offset from the chord start, 0 <= at < chord beats. */
  at: number;
  /** Length in beats before the gate, at + length <= chord beats. */
  length: number;
  step: PatternStep;
}

/**
 * Where the steps of `pattern` fall inside a chord of `beats` beats. The pattern restarts at
 * the chord start and loops while it fits; steps starting at or after the chord end are
 * dropped and steps crossing it are cut to the boundary. With `tail: 'sustain'`, the step(s)
 * starting last are extended to the chord end, and a step at least as long as the pattern
 * (a held step, e.g. 'sustain', 'pad', 'bass-whole') is played once and held to the chord
 * end instead of being re-triggered on every repetition. Sorted by `at`, then step order.
 */
export function layoutPattern(pattern: Pattern, beats: number): StepOccurrence[] {
  const out: StepOccurrence[] = [];
  if (!(pattern.length > 0) || !(beats > 0)) return out;
  const sustain = pattern.tail === 'sustain';
  for (let k = 0; k * pattern.length < beats; k++) {
    for (const step of pattern.steps) {
      const at = k * pattern.length + step.at;
      if (at >= beats) continue;
      const held = sustain && step.length >= pattern.length;
      if (held && k > 0) continue; // tied to the previous repetition
      const length = held ? beats - at : Math.min(step.length, beats - at);
      out.push({ at, length, step });
    }
  }
  out.sort((a, b) => a.at - b.at);
  if (sustain && out.length > 0) {
    const last = Math.max(...out.map((o) => o.at));
    for (const o of out) if (o.at === last) o.length = beats - o.at;
  }
  return out;
}

interface Voicing {
  /** Bass note first, then the upper tones (close), or just the root (root-only). */
  notes: number[];
  upper: number[];
}

function voice(chord: Chord, key: Key, track: Track): Voicing {
  if (track.voicing === 'root-only') {
    const root = midiNote(chordRootPitchClass(chord, key), track.octave);
    return { notes: [root], upper: [root] };
  }
  const notes = voiceChord(chord, key, { bassOctave: track.octave, octave: track.octave });
  return { notes, upper: notes.slice(1) };
}

/** Untransposed MIDI notes a selector picks from the voicing. */
function resolveSelector(
  selector: NoteSelector,
  voicing: Voicing,
  chord: Chord,
  key: Key,
  octave: number,
): number[] {
  const bass = voicing.notes[0];
  if (bass === undefined) return [];
  const root = (): number => midiNote(chordRootPitchClass(chord, key), octave);
  if (typeof selector === 'object') {
    const n = voicing.upper.length;
    const tone = voicing.upper[selector.index % n];
    return tone === undefined ? [] : [tone + 12 * Math.floor(selector.index / n)];
  }
  switch (selector) {
    case 'chord':
      return [...voicing.upper];
    case 'bass':
      return [bass];
    case 'root':
      return [root()];
    case 'fifth':
      return chordPitchClasses(chord, key).includes(toPitchClass(bass + 7)) ? [bass + 7] : [root()];
    case 'top': {
      const top = voicing.notes[voicing.notes.length - 1];
      return top === undefined ? [] : [top];
    }
    case 'octave':
      return [bass + 12];
  }
}

function byStartChannelNote(a: NoteEvent, b: NoteEvent): number {
  return a.start - b.start || a.channel - b.channel || a.note - b.note;
}

/**
 * Note events of one track over the whole song (rests produce nothing). Muted tracks render
 * nothing unless `opts.includeMuted`. Notes moved outside 0..127 by octave or transpose are
 * skipped. Sorted by start, then note.
 */
export function renderTrack(song: Song, track: Track, opts: RenderOptions = {}): NoteEvent[] {
  if (track.muted && opts.includeMuted !== true) return [];
  const key = songKey(song);
  const events: NoteEvent[] = [];
  let start = 0;
  for (const songChord of song.chords) {
    const chordStart = start;
    start += songChord.beats;
    if (isRestToken(songChord.token)) continue;
    const chord = parseToken(songChord.token);
    const voicing = voice(chord, key, track);
    for (const o of layoutPattern(track.pattern, songChord.beats)) {
      const velocity = Math.min(
        127,
        Math.max(1, Math.round(track.velocity * (o.step.accent ?? 1))),
      );
      for (const raw of resolveSelector(o.step.notes, voicing, chord, key, track.octave)) {
        const note = raw + track.transpose;
        if (note < 0 || note > 127) continue;
        events.push({
          trackId: track.id,
          channel: track.channel,
          note,
          velocity,
          start: chordStart + o.at,
          duration: o.length * track.gate,
        });
      }
    }
  }
  return events.sort(byStartChannelNote);
}

/** Note events of all tracks, sorted by start, then channel, then note (stable otherwise). */
export function renderSong(
  song: Song,
  tracks: readonly Track[],
  opts: RenderOptions = {},
): NoteEvent[] {
  return tracks.flatMap((t) => renderTrack(song, t, opts)).sort(byStartChannelNote);
}

/**
 * How a melody note relates to the chord under it (the chord sounding at `note.beat`):
 * 'chord' when its pitch class is a chord tone, else 'scale' when it has no accidental, else
 * 'outside'. Rests and beats after the last chord have no chord tones.
 */
export type MelodyHarmony = 'chord' | 'scale' | 'outside';

export function melodyNoteHarmony(song: Song, note: MelodyNote): MelodyHarmony {
  const key = songKey(song);
  const token = chordAtBeat(song, note.beat)?.chord.token;
  if (token !== undefined && !isRestToken(token)) {
    const pc = toPitchClass(melodyNotePitch(note, key));
    if (chordPitchClasses(parseToken(token), key).includes(pc)) return 'chord';
  }
  return note.accidental === 0 ? 'scale' : 'outside';
}

/**
 * Note events of the melody (track id MELODY_TRACK_ID, the melody channel, MELODY_VELOCITY,
 * `length * MELODY_GATE`). A muted melody renders nothing unless `opts.includeMuted`. Notes
 * starting at or after the end of the chords are dropped and a note crossing it is cut, so the
 * melody ends with the song. Sorted by start.
 */
export function renderMelody(song: Song, opts: RenderOptions = {}): NoteEvent[] {
  const melody = song.melody;
  if (melody === undefined || (melody.muted && opts.includeMuted !== true)) return [];
  const key = songKey(song);
  const end = totalBeats(song);
  const events: NoteEvent[] = [];
  for (const note of melody.notes) {
    if (note.beat >= end) continue;
    const pitch = melodyNotePitch(note, key);
    if (pitch < 0 || pitch > 127) continue;
    events.push({
      trackId: MELODY_TRACK_ID,
      channel: melody.channel,
      note: pitch,
      velocity: MELODY_VELOCITY,
      start: note.beat,
      duration: (Math.min(note.beat + note.length, end) - note.beat) * MELODY_GATE,
    });
  }
  return events.sort(byStartChannelNote);
}
