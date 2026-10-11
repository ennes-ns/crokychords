/**
 * Which notes of the voiced chord a pattern step plays.
 *
 * - 'chord': all voiced chord tones (upper voicing, no separate bass note)
 * - 'bass':  the bass note only (chordBassPitchClass; the root for root position)
 * - 'root':  the root only, in the track's octave (ignores the inversion)
 * - 'fifth': the fifth above the bass note (fallback: the root)
 * - 'top':   the highest voiced tone
 * - { index }: the n-th upper tone from the bottom; wraps up an octave (arpeggios)
 */
export type NoteSelector = 'chord' | 'bass' | 'root' | 'fifth' | 'top' | { index: number };

export const NOTE_SELECTOR_NAMES: readonly Exclude<NoteSelector, { index: number }>[] = [
  'chord',
  'bass',
  'root',
  'fifth',
  'top',
];

export interface PatternStep {
  /** Beat offset inside the pattern, 0 <= at < length; multiples of 1/8 beat. */
  at: number;
  /** Note length in beats (> 0). May exceed the pattern length when `sustain` is used. */
  length: number;
  notes: NoteSelector;
  /** 0..1 scaling of the track velocity, default 1. */
  accent?: number;
}

export type PatternTail = 'cut' | 'sustain';

export interface Pattern {
  /** Preset id or 'custom'. */
  id: string;
  name: string;
  /** Pattern length in beats; the pattern loops within each chord and restarts at every chord. */
  length: number;
  steps: PatternStep[];
  /**
   * 'cut': a step that would cross the end of the chord is shortened to the chord boundary
   * (default). 'sustain': the last step of each chord is extended to the chord boundary, and a
   * step at least as long as the pattern is held across repetitions instead of re-triggered
   * (pads).
   */
  tail?: PatternTail;
}

export type TrackRole = 'chords' | 'bass' | 'arp' | 'pad' | 'custom';

export const TRACK_ROLES: readonly TrackRole[] = ['chords', 'bass', 'arp', 'pad', 'custom'];

export type TrackVoicing = 'close' | 'root-only';

export interface Track {
  /** Stable id, 'trk-' + 8 random base36 characters (see newTrackId). */
  id: string;
  name: string;
  /** Only affects defaults and the browser timbre. */
  role: TrackRole;
  /** MIDI channel 0-15 (shown 1-16 in the UI). */
  channel: number;
  /** Octave of the lowest voiced tone (C4 = 4), -1..9. */
  octave: number;
  /** 'close': voiceChord in `octave`; 'root-only': the root in `octave`. */
  voicing: TrackVoicing;
  pattern: Pattern;
  /** 1-127. */
  velocity: number;
  /** 0 < gate <= 1: fraction of each step's length actually sounding. */
  gate: number;
  muted: boolean;
  /** Transpose in semitones (e.g. -12 for a sub bass). */
  transpose: number;
}

const ID_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';
const ID_LENGTH = 8;

/**
 * A new track id: 'trk-' followed by 8 base36 characters. Uses Math.random (core has no
 * crypto dependency); pass `random` (returning values in [0, 1)) for deterministic ids.
 */
export function newTrackId(random: () => number = Math.random): string {
  let id = 'trk-';
  for (let i = 0; i < ID_LENGTH; i++) {
    const r = random();
    const index = Math.min(ID_CHARS.length - 1, Math.max(0, Math.floor(r * ID_CHARS.length)));
    id += ID_CHARS.charAt(index);
  }
  return id;
}

function cloneSelector(notes: NoteSelector): NoteSelector {
  return typeof notes === 'string' ? notes : { index: notes.index };
}

/** Deep copy of a pattern (optional fields are only copied when present). */
export function clonePattern(pattern: Pattern): Pattern {
  const copy: Pattern = {
    id: pattern.id,
    name: pattern.name,
    length: pattern.length,
    steps: pattern.steps.map((s) => {
      const step: PatternStep = { at: s.at, length: s.length, notes: cloneSelector(s.notes) };
      if (s.accent !== undefined) step.accent = s.accent;
      return step;
    }),
  };
  if (pattern.tail !== undefined) copy.tail = pattern.tail;
  return copy;
}

/** Deep copy of a track, fields in canonical order. */
export function cloneTrack(track: Track): Track {
  return {
    id: track.id,
    name: track.name,
    role: track.role,
    channel: track.channel,
    octave: track.octave,
    voicing: track.voicing,
    pattern: clonePattern(track.pattern),
    velocity: track.velocity,
    gate: track.gate,
    muted: track.muted,
    transpose: track.transpose,
  };
}
