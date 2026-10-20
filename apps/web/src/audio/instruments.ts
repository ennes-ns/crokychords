/**
 * Built-in instruments, the SoundFont catalogue, the drum kit, drum patterns and sound presets as
 * plain data (no Web Audio here; `graph.ts`, `piano.ts` and `soundfont.ts` turn this data into
 * nodes). See docs/specs/web-instruments-v1.md and docs/specs/soundfonts-v1.md.
 */
import type { TrackRole } from '@crokychords/core';

/** The synthesised instruments. */
export type SynthId = 'piano' | 'pad' | 'bass' | 'lead';
export const SYNTH_IDS: readonly SynthId[] = ['piano', 'pad', 'bass', 'lead'];

/** SoundFont instruments: the MIDI.js folder names of FluidR3_GM (tools/soundfonts/manifest.json). */
export type SoundfontId =
  | 'acoustic_grand_piano'
  | 'bright_acoustic_piano'
  | 'electric_piano_1'
  | 'harpsichord'
  | 'vibraphone'
  | 'church_organ'
  | 'acoustic_guitar_nylon'
  | 'acoustic_bass'
  | 'electric_bass_finger'
  | 'synth_bass_1'
  | 'pizzicato_strings'
  | 'string_ensemble_1'
  | 'choir_aahs'
  | 'clarinet'
  | 'flute';

/** The user's sampler slots (docs/specs/sampler-v1.md §1). */
export const SAMPLER_IDS = [
  'sampler-1',
  'sampler-2',
  'sampler-3',
  'sampler-4',
  'sampler-5',
  'sampler-6',
  'sampler-7',
  'sampler-8',
] as const;
export type SamplerId = (typeof SAMPLER_IDS)[number];

/** The synth recipe a sampler slot plays while it has no decoded sample. */
export const SAMPLER_STAND_IN: SynthId = 'piano';

export function isSamplerId(value: unknown): value is SamplerId {
  return SAMPLER_IDS.some((id) => id === value);
}

/** Slot number 1–8 of a sampler id. */
export function samplerSlot(id: SamplerId): number {
  return SAMPLER_IDS.indexOf(id) + 1;
}

/** Anything a track can play: a SoundFont instrument, a synth recipe or a sampler slot. */
export type InstrumentId = SynthId | SoundfontId | SamplerId;

export interface SoundfontInstrument {
  id: SoundfontId;
  name: string;
  /** General MIDI program, 0-based (written to the .mid file). */
  program: number;
  /** The synth recipe that plays until the samples are loaded. */
  standIn: SynthId;
  /** Linear gain at velocity 127 that levels the instruments against each other. */
  gain: number;
  /** Largest absolute sample value over the shipped notes (with a small margin). */
  peak: number;
  /** Highest shipped note (MIDI); the notes above it are silent in the source. */
  top: number;
}

/** docs/specs/soundfonts-v1.md §7; `gain` and `peak` from the shipped files (§6). */
export const SOUNDFONTS: readonly SoundfontInstrument[] = [
  {
    id: 'acoustic_grand_piano',
    name: 'Acoustic Grand Piano',
    program: 0,
    standIn: 'piano',
    gain: 2.53,
    peak: 0.105,
    top: 108,
  },
  {
    id: 'bright_acoustic_piano',
    name: 'Bright Acoustic Piano',
    program: 1,
    standIn: 'piano',
    gain: 2.68,
    peak: 0.099,
    top: 108,
  },
  {
    id: 'electric_piano_1',
    name: 'Electric Piano 1',
    program: 4,
    standIn: 'piano',
    gain: 1.94,
    peak: 0.101,
    top: 108,
  },
  {
    id: 'harpsichord',
    name: 'Harpsichord',
    program: 6,
    standIn: 'piano',
    gain: 2.12,
    peak: 0.128,
    top: 108,
  },
  {
    id: 'vibraphone',
    name: 'Vibraphone',
    program: 11,
    standIn: 'piano',
    gain: 2.85,
    peak: 0.103,
    top: 108,
  },
  {
    id: 'church_organ',
    name: 'Church Organ',
    program: 19,
    standIn: 'pad',
    gain: 1.79,
    peak: 0.133,
    top: 96,
  },
  {
    id: 'acoustic_guitar_nylon',
    name: 'Acoustic Guitar (nylon)',
    program: 24,
    standIn: 'piano',
    gain: 2.23,
    peak: 0.134,
    top: 108,
  },
  {
    id: 'acoustic_bass',
    name: 'Acoustic Bass',
    program: 32,
    standIn: 'bass',
    gain: 2.14,
    peak: 0.136,
    top: 108,
  },
  {
    id: 'electric_bass_finger',
    name: 'Electric Bass (finger)',
    program: 33,
    standIn: 'bass',
    gain: 1.78,
    peak: 0.136,
    top: 84,
  },
  {
    id: 'synth_bass_1',
    name: 'Synth Bass 1',
    program: 38,
    standIn: 'bass',
    gain: 2.55,
    peak: 0.109,
    top: 108,
  },
  {
    id: 'pizzicato_strings',
    name: 'Pizzicato Strings',
    program: 45,
    standIn: 'piano',
    gain: 1.82,
    peak: 0.155,
    top: 96,
  },
  {
    id: 'string_ensemble_1',
    name: 'String Ensemble 1',
    program: 48,
    standIn: 'pad',
    gain: 1.77,
    peak: 0.147,
    top: 96,
  },
  {
    id: 'choir_aahs',
    name: 'Choir Aahs',
    program: 52,
    standIn: 'pad',
    gain: 1.83,
    peak: 0.144,
    top: 96,
  },
  {
    id: 'clarinet',
    name: 'Clarinet',
    program: 71,
    standIn: 'lead',
    gain: 1.48,
    peak: 0.131,
    top: 108,
  },
  { id: 'flute', name: 'Flute', program: 73, standIn: 'lead', gain: 1.81, peak: 0.119, top: 108 },
];

/** General MIDI programs of the synth instruments, for the .mid export. */
export const SYNTH_PROGRAMS: Readonly<Record<SynthId, number>> = {
  piano: 0,
  pad: 89,
  bass: 38,
  lead: 80,
};

export const INSTRUMENT_IDS: readonly InstrumentId[] = [
  ...SOUNDFONTS.map((s) => s.id),
  ...SYNTH_IDS,
  ...SAMPLER_IDS,
];

export function isSynthId(value: unknown): value is SynthId {
  return SYNTH_IDS.some((id) => id === value);
}

export function isInstrumentId(value: unknown): value is InstrumentId {
  return INSTRUMENT_IDS.some((id) => id === value);
}

/** The SoundFont instrument `id`, or undefined for a synth id. */
export function soundfont(id: InstrumentId): SoundfontInstrument | undefined {
  return SOUNDFONTS.find((s) => s.id === id);
}

/** The synth recipe that plays `id`: itself, or a SoundFont's or sampler slot's stand-in. */
export function standInOf(id: InstrumentId): SynthId {
  if (isSynthId(id)) return id;
  if (isSamplerId(id)) return SAMPLER_STAND_IN;
  return soundfont(id)?.standIn ?? 'piano';
}

/**
 * General MIDI program (0-based) of any instrument. A sampler slot's program is part of its patch
 * (sound settings); without it this is 0.
 */
export function gmProgram(id: InstrumentId): number {
  if (isSynthId(id)) return SYNTH_PROGRAMS[id];
  if (isSamplerId(id)) return 0;
  return soundfont(id)?.program ?? 0;
}

/** Display name of any instrument (a sampler slot's default name; its patch may rename it). */
export function instrumentName(id: InstrumentId): string {
  if (isSynthId(id)) return INSTRUMENTS[id].name;
  if (isSamplerId(id)) return `Sampler ${samplerSlot(id)}`;
  return soundfont(id)?.name ?? id;
}

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
  id: SynthId;
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
  /**
   * Two-stage decay: the first stage falls towards `level` × the peak within `decay`, then a
   * long tail falls to silence with time constant `tailTime(f) / 3` (see `noteTail`). Replaces
   * the sustain level when present.
   */
  tail?: TailSpec;
  /** Voice recipe of the piano (replaces `oscillators` → lowpass when present). */
  piano?: PianoSpec;
  /** At most this many voices of this instrument sound at once; the oldest is stolen. */
  voices?: number;
  /** Cutoff multiplier, 1 = as designed (presets tune it; read by the piano voice). */
  brightness?: number;
  /** Room send, 0..1 of `ROOM.maxWet` in graph.ts (presets tune it; read by the piano voice). */
  room?: number;
}

export interface TailSpec {
  /** Level (0..1 of the peak) the first stage falls towards. */
  level: number;
  /** Tail length at KEY_TRACK_REF, seconds; scaled by (KEY_TRACK_REF / f) ^ keyTrack. */
  time: number;
  keyTrack: number;
  /** Clamp of the key-tracked tail length, seconds. */
  min: number;
  max: number;
}

export interface PartialSpec {
  /** Frequency ratio to the fundamental (slightly stretched: inharmonic). */
  ratio: number;
  /** Level at KEY_TRACK_REF, relative to the summed fundamental. */
  level: number;
}

/**
 * The piano's own recipe. Its `Instrument.oscillators` are the unison on the fundamental (sines
 * a few cents apart, unequal detune so they never cancel completely); the partials sit on top.
 */
export interface PianoSpec {
  partials: readonly PartialSpec[];
  /**
   * Pitch tilt: partial n (1-based) is scaled by `s ^ n` with
   * `s = clamp((KEY_TRACK_REF / f) ^ tilt, tiltMin, tiltMax)`: bright low notes, dull high ones.
   */
  tilt: number;
  tiltMin: number;
  tiltMax: number;
  /** Lowpass cutoff scale at velocity 0; it rises linearly to 1 at velocity 127. */
  velocityCutoff: number;
  /** Hammer noise: band-passed burst at `level` (× note peak) lasting `duration` seconds. */
  hammer: { frequency: number; q: number; level: number; duration: number };
  /** Pan by pitch: −spread at PAN_LOW, +spread at PAN_HIGH (MIDI notes), linear between. */
  spread: number;
}

/** Instrument parameters a sound preset may tune. */
export interface InstrumentParams {
  brightness?: number;
  room?: number;
}

export const MAX_CUTOFF = 12000;
/** MIDI notes panned fully to −spread / +spread by the piano. */
export const PAN_LOW = 36;
export const PAN_HIGH = 84;
export const KEY_TRACK_REF = 261.63;
/** Peak gain of a full-velocity note at level 1, before the mix bus. */
export const VOICE_PEAK = 0.32;

export const INSTRUMENTS: Readonly<Record<SynthId, Instrument>> = {
  /** Piano v2: detuned unison plus inharmonic partials, two-stage decay, hammer noise. */
  piano: {
    id: 'piano',
    name: 'Piano',
    // The unison on the fundamental (the partials are in `piano`).
    oscillators: [
      { type: 'sine', detune: -3, level: 0.25, octave: 0 },
      { type: 'sine', detune: 0, level: 0.5, octave: 0 },
      { type: 'sine', detune: 2, level: 0.25, octave: 0 },
    ],
    // Q in dB: -3 is a lowpass without a resonance peak.
    filter: { base: 500, track: 5, q: -3, env: { from: 2.5, time: 0.3 } },
    attack: 0.003,
    decay: 0.3,
    sustain: 0,
    release: 0.08,
    level: 0.58,
    keyTrack: 0,
    tail: { level: 0.35, time: 4, keyTrack: 0.6, min: 2, max: 6 },
    piano: {
      partials: [
        { ratio: 2.0, level: 0.5 },
        { ratio: 3.01, level: 0.28 },
        { ratio: 4.03, level: 0.16 },
        { ratio: 5.08, level: 0.09 },
      ],
      tilt: 0.35,
      tiltMin: 0.55,
      tiltMax: 1.4,
      velocityCutoff: 0.25,
      hammer: { frequency: 2500, q: 0.9, level: 0.18, duration: 0.008 },
      spread: 0.3,
    },
    voices: 24,
    brightness: 1,
    room: 0.8,
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

/**
 * Upper bound of a note's amplitude (per output channel): its peak times the summed oscillator
 * levels. For the piano: fundamental plus the pitch-tilted partials plus the hammer, times the
 * louder channel of its pan; without `frequency` the brightest tilt and no pan are assumed.
 */
export function noteAmplitude(
  instrument: Instrument,
  velocity: number,
  frequency?: number,
): number {
  const peak = notePeak(instrument, velocity);
  const spec = instrument.piano;
  if (spec === undefined) return peak * instrument.oscillators.reduce((s, o) => s + o.level, 0);
  const partials = pianoPartials(spec, frequency ?? 0).reduce((s, p) => s + p.level, 0);
  const pan = frequency === undefined ? 1 : panGain(notePan(spec, frequencyToMidi(frequency)));
  const fundamental = instrument.oscillators.reduce((s, o) => s + o.level, 0);
  return peak * (fundamental + partials + spec.hammer.level) * pan;
}

export function frequencyToMidi(frequency: number): number {
  return 69 + 12 * Math.log2(frequency / 440);
}

/** Partials of a piano note at `frequency` with the pitch tilt applied (f <= 0: brightest). */
export function pianoPartials(spec: PianoSpec, frequency: number): PartialSpec[] {
  const raw = frequency > 0 ? (KEY_TRACK_REF / frequency) ** spec.tilt : Infinity;
  const s = Math.min(spec.tiltMax, Math.max(spec.tiltMin, raw));
  return spec.partials.map((p, i) => ({ ratio: p.ratio, level: p.level * s ** (i + 1) }));
}

/** Pan position of a piano note: −spread at PAN_LOW to +spread at PAN_HIGH. */
export function notePan(spec: PianoSpec, note: number): number {
  const x = (note - (PAN_LOW + PAN_HIGH) / 2) / ((PAN_HIGH - PAN_LOW) / 2);
  return spec.spread * Math.min(1, Math.max(-1, x));
}

/** Gain of the louder channel of an equal-power stereo panner (mono input) at `pan`. */
export function panGain(pan: number): number {
  const x = ((Math.min(1, Math.max(-1, pan)) + 1) / 2) * (Math.PI / 2);
  return Math.max(Math.cos(x), Math.sin(x));
}

/** Length (seconds) of the long tail of a two-stage decay, key-tracked and clamped. */
export function noteTail(tail: TailSpec, frequency: number): number {
  const scale = frequency > 0 ? (KEY_TRACK_REF / frequency) ** tail.keyTrack : 1;
  return Math.min(tail.max, Math.max(tail.min, tail.time * scale));
}

/** Instrument with preset parameters applied (unknown or absent parameters keep the default). */
export function withParams(
  instrument: Instrument,
  params: InstrumentParams | undefined,
): Instrument {
  if (params === undefined) return instrument;
  return { ...instrument, ...params };
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

export type SoundPresetId = 'piano' | 'band' | 'pad' | 'chamber' | 'electric';

export interface SoundPreset {
  id: SoundPresetId;
  name: string;
  instruments: Readonly<Record<TrackRole, InstrumentId>>;
  /** The instrument of the melody lane. */
  lead: InstrumentId;
  drums: DrumPatternId;
  /** Per-instrument parameter overrides (brightness, room) of the synth recipes. */
  params?: Partial<Record<SynthId, InstrumentParams>>;
}

/** docs/specs/soundfonts-v1.md §8: Piano and Pad stay all-synth, the others use SoundFonts. */
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
    instruments: {
      chords: 'acoustic_grand_piano',
      bass: 'acoustic_bass',
      arp: 'electric_piano_1',
      pad: 'string_ensemble_1',
      custom: 'acoustic_grand_piano',
    },
    lead: 'lead',
    drums: 'straight',
    // A little darker and drier so the piano (stand-in) sits behind the drums and the pad.
    params: { piano: { brightness: 0.8, room: 0.6 } },
  },
  {
    id: 'pad',
    name: 'Pad',
    instruments: { chords: 'pad', bass: 'bass', arp: 'piano', pad: 'pad', custom: 'pad' },
    lead: 'lead',
    drums: 'none',
  },
  {
    id: 'chamber',
    name: 'Chamber',
    instruments: {
      chords: 'harpsichord',
      bass: 'pizzicato_strings',
      arp: 'flute',
      pad: 'string_ensemble_1',
      custom: 'harpsichord',
    },
    lead: 'clarinet',
    drums: 'none',
  },
  {
    id: 'electric',
    name: 'Electric',
    instruments: {
      chords: 'electric_piano_1',
      bass: 'synth_bass_1',
      arp: 'acoustic_guitar_nylon',
      pad: 'church_organ',
      custom: 'electric_piano_1',
    },
    lead: 'lead',
    drums: 'half-time',
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

/** The instrument `preset` gives a track of `role`, or the melody lane (`role` null). */
export function presetChoice(preset: SoundPresetId, role: TrackRole | null): InstrumentId {
  const p = soundPreset(preset);
  return role === null ? p.lead : p.instruments[role];
}

const tuned = new Map<string, Instrument>();

/**
 * The synth recipe of `id` (a SoundFont's stand-in) with the parameters of `preset` applied;
 * the same object for the same pair.
 */
export function presetInstrument(preset: SoundPresetId, id: InstrumentId): Instrument {
  const synth = standInOf(id);
  const key = `${preset}:${synth}`;
  let instrument = tuned.get(key);
  if (instrument === undefined) {
    instrument = withParams(INSTRUMENTS[synth], soundPreset(preset).params?.[synth]);
    tuned.set(key, instrument);
  }
  return instrument;
}

/** The synth recipe that plays (or stands in for) a track of `role` under `preset`. */
export function instrumentFor(preset: SoundPresetId, role: TrackRole): Instrument {
  return presetInstrument(preset, presetChoice(preset, role));
}

/** The synth recipe that plays (or stands in for) the melody lane under `preset`. */
export function leadFor(preset: SoundPresetId): Instrument {
  return presetInstrument(preset, presetChoice(preset, null));
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
  const tail = instrument.tail;
  const level = (at: number): number => {
    if (at <= 0) return 0;
    if (at < instrument.attack) return at / instrument.attack;
    const decay = noteDecay(instrument, frequency);
    const s = tail === undefined ? instrument.sustain : tail.level;
    const first = (x: number): number => s + (1 - s) * Math.exp(-x / (decay / 3));
    const since = at - instrument.attack;
    if (tail === undefined || since < decay) return first(since);
    return first(decay) * Math.exp(-(since - decay) / (noteTail(tail, frequency) / 3));
  };
  const end = Math.max(held, instrument.attack);
  if (t < end) return level(t);
  return level(end) * Math.exp(-(t - end) / (instrument.release / 4));
}
