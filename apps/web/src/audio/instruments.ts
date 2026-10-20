/**
 * Built-in instruments, the drum kit, drum patterns and sound presets as plain data (no Web
 * Audio here; `graph.ts` turns this data into nodes). See docs/specs/web-instruments-v1.md.
 */
import type { TrackRole } from '@crokychords/core';

export type InstrumentId = 'piano' | 'pad' | 'bass' | 'lead';
export const INSTRUMENT_IDS: readonly InstrumentId[] = ['piano', 'pad', 'bass', 'lead'];

export interface OscillatorSpec {
  type: OscillatorType;
  /** Cents. */
  detune: number;
  level: number;
  /** Octaves relative to the note (-1 = sub oscillator). */
  octave: number;
}

export interface FilterSpec {
  /** Lowpass cutoff: `base + frequency * track` Hz (capped at MAX_CUTOFF). */
  base: number;
  track: number;
  q: number;
  /** Cutoff envelope: starts at `from` × the cutoff and settles with time constant `time` s. */
  env?: { from: number; time: number };
}

export interface Instrument {
  id: InstrumentId;
  name: string;
  oscillators: readonly OscillatorSpec[];
  filter: FilterSpec | null;
  /** Seconds. */
  attack: number;
  /** Time scale of the decay to the sustain level, seconds. */
  decay: number;
  /** 0..1 of the peak. */
  sustain: number;
  /** Seconds. */
  release: number;
  /** Overall level (balances the instruments against each other). */
  level: number;
  /** Decay scaled by (KEY_TRACK_REF / frequency) ^ keyTrack, clamped (low notes ring longer). */
  keyTrack: number;
}

export const MAX_CUTOFF = 12000;
export const KEY_TRACK_REF = 261.63;
/** Peak gain of a full-velocity note at level 1, before the mix bus. */
export const VOICE_PEAK = 0.32;

export const INSTRUMENTS: Readonly<Record<InstrumentId, Instrument>> = {
  piano: {
    id: 'piano',
    name: 'Piano',
    oscillators: [
      { type: 'triangle', detune: 0, level: 0.8, octave: 0 },
      { type: 'sine', detune: 2, level: 0.3, octave: 1 },
      { type: 'sine', detune: -3, level: 0.08, octave: 2 },
    ],
    filter: { base: 700, track: 3, q: 0.6, env: { from: 3, time: 0.25 } },
    attack: 0.004,
    decay: 1.6,
    sustain: 0,
    release: 0.25,
    level: 0.9,
    keyTrack: 0.5,
  },
  pad: {
    id: 'pad',
    name: 'Pad',
    oscillators: [
      { type: 'sawtooth', detune: -12, level: 0.35, octave: 0 },
      { type: 'sawtooth', detune: 12, level: 0.35, octave: 0 },
      { type: 'triangle', detune: 0, level: 0.15, octave: 1 },
    ],
    filter: { base: 450, track: 1.2, q: 0.6, env: { from: 0.4, time: 0.8 } },
    attack: 0.6,
    decay: 1,
    sustain: 0.85,
    release: 1.2,
    level: 0.6,
    keyTrack: 0,
  },
  bass: {
    id: 'bass',
    name: 'Bass',
    oscillators: [
      { type: 'triangle', detune: 0, level: 0.7, octave: 0 },
      { type: 'sawtooth', detune: 0, level: 0.2, octave: 0 },
      { type: 'sine', detune: 0, level: 0.45, octave: -1 },
    ],
    filter: { base: 220, track: 1.5, q: 2, env: { from: 6, time: 0.07 } },
    attack: 0.004,
    decay: 0.35,
    sustain: 0.45,
    release: 0.1,
    level: 1,
    keyTrack: 0,
  },
  /** The melody lane's voice: soft square plus a little saw, quick to speak, held. */
  lead: {
    id: 'lead',
    name: 'Lead',
    oscillators: [
      { type: 'square', detune: 0, level: 0.4, octave: 0 },
      { type: 'sawtooth', detune: 6, level: 0.25, octave: 0 },
      { type: 'sine', detune: 0, level: 0.2, octave: -1 },
    ],
    filter: { base: 900, track: 2.5, q: 1.2, env: { from: 2.5, time: 0.12 } },
    attack: 0.01,
    decay: 0.5,
    sustain: 0.7,
    release: 0.12,
    level: 0.8,
    keyTrack: 0,
  },
};

export function midiToFrequency(note: number): number {
  return 440 * 2 ** ((note - 69) / 12);
}

/** Peak gain of one note: velocity/127 scaled by the instrument level. */
export function notePeak(instrument: Instrument, velocity: number): number {
  const v = Math.min(127, Math.max(0, velocity)) / 127;
  return VOICE_PEAK * instrument.level * v;
}

/** Upper bound of a note's amplitude: its peak times the summed oscillator levels. */
export function noteAmplitude(instrument: Instrument, velocity: number): number {
  return notePeak(instrument, velocity) * instrument.oscillators.reduce((s, o) => s + o.level, 0);
}

/** Decay time of a note after key tracking (0.5×–2× of the instrument's decay). */
export function noteDecay(instrument: Instrument, frequency: number): number {
  if (instrument.keyTrack === 0 || frequency <= 0) return instrument.decay;
  const scale = (KEY_TRACK_REF / frequency) ** instrument.keyTrack;
  return instrument.decay * Math.min(2, Math.max(0.5, scale));
}

/** Lowpass cutoff for a note (Hz), before the filter envelope. */
export function noteCutoff(filter: FilterSpec, frequency: number): number {
  return Math.min(MAX_CUTOFF, filter.base + frequency * filter.track);
}

// ---------------------------------------------------------------------------------------------
// Drums

export type Drum = 'kick' | 'snare' | 'hat';
export const DRUMS: readonly Drum[] = ['kick', 'snare', 'hat'];

/** Peak gain of each drum at level 1 (before the mix bus). */
export const DRUM_PEAK: Readonly<Record<Drum, number>> = { kick: 0.55, snare: 0.3, hat: 0.12 };

export interface DrumHit {
  drum: Drum;
  /** Song beat. */
  beat: number;
  /** 0..1, scales the drum's peak. */
  level: number;
}

export type DrumPatternId = 'none' | 'straight' | 'half-time' | 'ballad';
export const DRUM_PATTERNS: readonly { id: DrumPatternId; name: string }[] = [
  { id: 'none', name: 'None' },
  { id: 'straight', name: 'Straight' },
  { id: 'half-time', name: 'Half-time' },
  { id: 'ballad', name: 'Ballad' },
];

export function isDrumPatternId(value: unknown): value is DrumPatternId {
  return DRUM_PATTERNS.some((p) => p.id === value);
}

const DRUM_ORDER: Readonly<Record<Drum, number>> = { kick: 0, snare: 1, hat: 2 };

function byBeatThenDrum(a: DrumHit, b: DrumHit): number {
  return a.beat - b.beat || DRUM_ORDER[a.drum] - DRUM_ORDER[b.drum];
}

/** Hits of one bar of `n` beats, `beat` relative to the bar start, sorted. */
export function barHits(pattern: DrumPatternId, n: number): DrumHit[] {
  const hits: DrumHit[] = [];
  const add = (drum: Drum, beat: number, level: number): void => {
    if (beat < n) hits.push({ drum, beat, level });
  };
  switch (pattern) {
    case 'none':
      break;
    case 'straight':
      for (let b = 0; b < n; b++) {
        add(b % 2 === 0 ? 'kick' : 'snare', b, 1);
        add('hat', b, 0.6);
        add('hat', b + 0.5, 0.4);
      }
      break;
    case 'half-time':
      add('kick', 0, 1);
      if (n >= 2) add('snare', Math.floor(n / 2), 1);
      for (let b = 0; b < n; b++) add('hat', b, 0.5);
      break;
    case 'ballad':
      add('kick', 0, 0.9);
      if (n >= 4) add('kick', 2.5, 0.7);
      for (let b = 0; b < n; b++) {
        if (b % 2 === 1) add('snare', b, 0.55);
        add('hat', b, 0.35);
        add('hat', b + 0.5, 0.25);
      }
      break;
  }
  return hits.sort(byBeatThenDrum);
}

/** Drum hits with `from <= beat < to` (song beats), bars of `beatsPerBar` from beat 0. */
export function drumHits(
  pattern: DrumPatternId,
  beatsPerBar: number,
  from: number,
  to: number,
): DrumHit[] {
  if (pattern === 'none' || beatsPerBar <= 0 || to <= from) return [];
  const bar = barHits(pattern, beatsPerBar);
  const out: DrumHit[] = [];
  for (let start = Math.floor(from / beatsPerBar) * beatsPerBar; start < to; start += beatsPerBar) {
    for (const hit of bar) {
      const beat = start + hit.beat;
      if (beat >= from && beat < to) out.push({ ...hit, beat });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Sound presets

export type SoundPresetId = 'piano' | 'band' | 'pad';

export interface SoundPreset {
  id: SoundPresetId;
  name: string;
  instruments: Readonly<Record<TrackRole, InstrumentId>>;
  /** The instrument of the melody lane. */
  lead: InstrumentId;
  drums: DrumPatternId;
}

export const SOUND_PRESETS: readonly SoundPreset[] = [
  {
    id: 'piano',
    name: 'Piano',
    instruments: { chords: 'piano', bass: 'piano', arp: 'piano', pad: 'piano', custom: 'piano' },
    lead: 'lead',
    drums: 'none',
  },
  {
    id: 'band',
    name: 'Band',
    instruments: { chords: 'piano', bass: 'bass', arp: 'piano', pad: 'pad', custom: 'piano' },
    lead: 'lead',
    drums: 'straight',
  },
  {
    id: 'pad',
    name: 'Pad',
    instruments: { chords: 'pad', bass: 'bass', arp: 'piano', pad: 'pad', custom: 'pad' },
    lead: 'lead',
    drums: 'none',
  },
];

export const DEFAULT_SOUND_PRESET: SoundPresetId = 'band';

export function isSoundPresetId(value: unknown): value is SoundPresetId {
  return SOUND_PRESETS.some((p) => p.id === value);
}

export function soundPreset(id: SoundPresetId): SoundPreset {
  const preset = SOUND_PRESETS.find((p) => p.id === id);
  if (preset === undefined) throw new RangeError(`unknown sound preset: ${id}`);
  return preset;
}

/** The instrument that plays a track of `role` under `preset`. */
export function instrumentFor(preset: SoundPresetId, role: TrackRole): Instrument {
  return INSTRUMENTS[soundPreset(preset).instruments[role]];
}

/** The instrument that plays the melody lane under `preset`. */
export function leadFor(preset: SoundPresetId): Instrument {
  return INSTRUMENTS[soundPreset(preset).lead];
}

/**
 * Envelope level (0..1 of the peak) of a note `t` seconds after its start, released after
 * `held` seconds; mirrors the automation `graph.ts` schedules. Used to check headroom.
 */
export function envelopeAt(
  instrument: Instrument,
  frequency: number,
  t: number,
  held: number,
): number {
  const level = (at: number): number => {
    if (at <= 0) return 0;
    if (at < instrument.attack) return at / instrument.attack;
    const tau = noteDecay(instrument, frequency) / 3;
    const s = instrument.sustain;
    return s + (1 - s) * Math.exp(-(at - instrument.attack) / tau);
  };
  const end = Math.max(held, instrument.attack);
  if (t < end) return level(t);
  return level(end) * Math.exp(-(t - end) / (instrument.release / 4));
}
