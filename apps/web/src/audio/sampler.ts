/**
 * The Sampler instrument (docs/specs/sampler-v1.md): the patch model of a sampler slot and its
 * clamping, root detection, waveform peaks, the prepared playback buffers (trim, reverse, baked
 * loop crossfade, ping-pong), the voice, the bank of decoded samples and `Samplers`, the edit API
 * the Sampler panel and the Akai Fire use. No DOM here; Web Audio only through `SynthContext`.
 */
import type {
  BufferLike,
  BufferSourceLike,
  FilterLike,
  GainLike,
  NodeLike,
  SourceLike,
  SynthContext,
} from './graph';
import { dbToGain } from './graph';
import type { SamplerId } from './instruments';
import { SAMPLER_IDS, samplerSlot } from './instruments';
import type { SampleStore, StoredSample } from '../store/samples';
import { MAX_SAMPLER_BYTES, SAMPLE_SCHEMA_VERSION } from '../store/samples';

/** Every sample is decoded at this rate, so frame positions never depend on the AudioContext. */
export const SAMPLER_RATE = 48000;
/** Peak of a full-velocity note of a full-scale sample at 0 dB (about a SoundFont voice). */
export const SAMPLER_LEVEL = 0.26;
/** At most this many sampler voices sound at once; the oldest is stolen. */
export const SAMPLER_VOICES = 32;
/** Decoded length limits (seconds). */
export const SAMPLER_MIN_SECONDS = 0.01;
export const SAMPLER_MAX_SECONDS = 30;
/** Shortest trimmed region and loop (frames). */
export const MIN_TRIM = 64;
export const MIN_LOOP = 32;
/** Default loop crossfade (seconds). */
export const DEFAULT_CROSSFADE = 0.01;
/** Octaves the cutoff moves at envAmount ±100 % and envelope level 1. */
export const ENV_OCTAVES = 6;
/** Octaves darker a velocity-1 note is at velocityToCutoff 100 %. */
export const VELOCITY_CUTOFF_OCTAVES = 4;
/** Resonance 0–100 % maps to a quality factor between these (exponentially). */
export const Q_MIN = 0.707;
export const Q_MAX = 20;
export const NAME_MAX = 24;

export const RANGES = {
  tune: { min: -50, max: 50 },
  keytrack: { min: 0, max: 100 },
  attack: { min: 0.001, max: 10 },
  decay: { min: 0.001, max: 10 },
  sustain: { min: 0, max: 1 },
  release: { min: 0.005, max: 10 },
  cutoff: { min: 20, max: 20000 },
  resonance: { min: 0, max: 100 },
  envAmount: { min: -100, max: 100 },
  gain: { min: -36, max: 12 },
  pan: { min: -1, max: 1 },
  velocity: { min: 0, max: 100 },
} as const;

export type LoopMode = 'forward' | 'pingpong';
export const LOOP_MODES: readonly LoopMode[] = ['forward', 'pingpong'];
export type SamplerFilterType = 'lowpass' | 'highpass' | 'bandpass';
export const FILTER_TYPES: readonly SamplerFilterType[] = ['lowpass', 'highpass', 'bandpass'];

/**
 * The server copy of a slot's sample (docs/specs/community-v1.md §4.2): its id, whether it was
 * taken from the community bank, and then the owner's handle.
 */
export interface SampleRemote {
  id: string;
  community: boolean;
  owner?: string;
}

/** What is stored for a slot; `savedAt` ties the patch to the stored bytes. */
export interface SampleInfo {
  name: string;
  /** Frames at `sampleRate` (SAMPLER_RATE). */
  frames: number;
  sampleRate: number;
  channels: 1 | 2;
  savedAt: string;
  /** Where the bytes also live on the server (only with sync on). */
  remote?: SampleRemote;
}

export interface SamplerLoop {
  enabled: boolean;
  /** Frames of the forward sample, inside the trim. */
  start: number;
  end: number;
  /** Frames, at most half the loop. */
  crossfade: number;
  mode: LoopMode;
}

export interface SamplerEnvelope {
  /** Seconds. */
  attack: number;
  decay: number;
  /** 0–1 of the peak. */
  sustain: number;
  release: number;
}

export interface SamplerFilter {
  type: SamplerFilterType;
  /** Hz. */
  cutoff: number;
  /** 0–100 %. */
  resonance: number;
  /** −100…+100 %. */
  envAmount: number;
}

/** One sampler slot (docs/specs/sampler-v1.md §2). */
export interface SamplerPatch {
  name: string;
  /** General MIDI program 0–127 for the .mid export. */
  program: number;
  sample: SampleInfo | null;
  /** MIDI note the sample sounds at. */
  root: number;
  /** Cents. */
  tune: number;
  /** 0–100 %. */
  keytrack: number;
  /** Trim, frames of the forward sample. */
  start: number;
  end: number;
  reverse: boolean;
  loop: SamplerLoop;
  envelope: SamplerEnvelope;
  filter: SamplerFilter;
  /** dB. */
  gain: number;
  /** −1…+1. */
  pan: number;
  /** 0–100 %. */
  velocityToGain: number;
  velocityToCutoff: number;
}

export function defaultPatch(id: SamplerId): SamplerPatch {
  return {
    name: `Sampler ${samplerSlot(id)}`,
    program: 0,
    sample: null,
    root: 60,
    tune: 0,
    keytrack: 100,
    start: 0,
    end: 0,
    reverse: false,
    loop: {
      enabled: false,
      start: 0,
      end: 0,
      crossfade: Math.round(DEFAULT_CROSSFADE * SAMPLER_RATE),
      mode: 'forward',
    },
    envelope: { attack: 0.002, decay: 0.3, sustain: 1, release: 0.08 },
    filter: { type: 'lowpass', cutoff: 20000, resonance: 0, envAmount: 0 },
    gain: 0,
    pan: 0,
    velocityToGain: 100,
    velocityToCutoff: 0,
  };
}

/** One patch per slot, made by `make`. */
export function samplerRecord(
  make: (id: SamplerId) => SamplerPatch,
): Record<SamplerId, SamplerPatch> {
  return {
    'sampler-1': make('sampler-1'),
    'sampler-2': make('sampler-2'),
    'sampler-3': make('sampler-3'),
    'sampler-4': make('sampler-4'),
    'sampler-5': make('sampler-5'),
    'sampler-6': make('sampler-6'),
    'sampler-7': make('sampler-7'),
    'sampler-8': make('sampler-8'),
  };
}

export function defaultSamplers(): Record<SamplerId, SamplerPatch> {
  return samplerRecord(defaultPatch);
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function clampInt(value: number, min: number, max: number, fallback = min): number {
  return Math.round(clampNumber(value, min, Math.max(min, max), fallback));
}

function cleanName(name: string, fallback: string): string {
  const trimmed = name.trim().slice(0, NAME_MAX);
  return trimmed === '' ? fallback : trimmed;
}

/**
 * Keep every invariant of §2: trim inside the sample, the loop inside the trim, the crossfade
 * within half the loop, every number in range. The end of a region wins over its start.
 */
export function clampPatch(patch: SamplerPatch, id: SamplerId): SamplerPatch {
  const fallback = defaultPatch(id);
  const frames = patch.sample?.frames ?? 0;
  const end = clampInt(patch.end, Math.min(frames, MIN_TRIM), frames, frames);
  const start = clampInt(patch.start, 0, Math.max(0, end - MIN_TRIM), 0);
  const loopEnd = clampInt(patch.loop.end, Math.min(end, start + MIN_LOOP), end, end);
  const loopStart = clampInt(patch.loop.start, start, Math.max(start, loopEnd - MIN_LOOP), start);
  const crossfadeMax = frames === 0 ? SAMPLER_RATE : Math.floor((loopEnd - loopStart) / 2);
  const r = RANGES;
  const e = patch.envelope;
  const f = patch.filter;
  return {
    name: cleanName(patch.name, fallback.name),
    program: clampInt(patch.program, 0, 127),
    sample: patch.sample,
    root: clampInt(patch.root, 0, 127, 60),
    tune: clampNumber(patch.tune, r.tune.min, r.tune.max, 0),
    keytrack: clampNumber(patch.keytrack, r.keytrack.min, r.keytrack.max, 100),
    start,
    end,
    reverse: patch.reverse,
    loop: {
      enabled: patch.loop.enabled,
      start: loopStart,
      end: loopEnd,
      crossfade: clampInt(patch.loop.crossfade, 0, crossfadeMax, 0),
      mode: patch.loop.mode,
    },
    envelope: {
      attack: clampNumber(e.attack, r.attack.min, r.attack.max, fallback.envelope.attack),
      decay: clampNumber(e.decay, r.decay.min, r.decay.max, fallback.envelope.decay),
      sustain: clampNumber(e.sustain, r.sustain.min, r.sustain.max, fallback.envelope.sustain),
      release: clampNumber(e.release, r.release.min, r.release.max, fallback.envelope.release),
    },
    filter: {
      type: f.type,
      cutoff: clampNumber(f.cutoff, r.cutoff.min, r.cutoff.max, fallback.filter.cutoff),
      resonance: clampNumber(f.resonance, r.resonance.min, r.resonance.max, 0),
      envAmount: clampNumber(f.envAmount, r.envAmount.min, r.envAmount.max, 0),
    },
    gain: clampNumber(patch.gain, r.gain.min, r.gain.max, 0),
    pan: clampNumber(patch.pan, r.pan.min, r.pan.max, 0),
    velocityToGain: clampNumber(patch.velocityToGain, r.velocity.min, r.velocity.max, 100),
    velocityToCutoff: clampNumber(patch.velocityToCutoff, r.velocity.min, r.velocity.max, 0),
  };
}

/** `patch` with a newly loaded sample: the whole sample, the loop on its middle half (off). */
export function withSample(
  patch: SamplerPatch,
  id: SamplerId,
  info: SampleInfo,
  root: number | null,
): SamplerPatch {
  return clampPatch(
    {
      ...patch,
      sample: info,
      root: root ?? 60,
      start: 0,
      end: info.frames,
      loop: {
        ...patch.loop,
        enabled: false,
        start: Math.floor(info.frames / 4),
        end: Math.floor((info.frames * 3) / 4),
        crossfade: Math.round(DEFAULT_CROSSFADE * info.sampleRate),
      },
    },
    id,
  );
}

// ---------------------------------------------------------------------------------------------
// Parsing (sound settings, field by field)

function get(raw: unknown, key: string): unknown {
  return typeof raw === 'object' && raw !== null ? Reflect.get(raw, key) : undefined;
}

function num(raw: unknown, key: string, fallback: number): number {
  const v = get(raw, key);
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function bool(raw: unknown, key: string, fallback: boolean): boolean {
  const v = get(raw, key);
  return typeof v === 'boolean' ? v : fallback;
}

function str(raw: unknown, key: string, fallback: string): string {
  const v = get(raw, key);
  return typeof v === 'string' ? v : fallback;
}

function parseRemote(raw: unknown): SampleRemote | null {
  const id = get(raw, 'id');
  const community = get(raw, 'community');
  const owner = get(raw, 'owner');
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id) || typeof community !== 'boolean') {
    return null;
  }
  return typeof owner === 'string' && owner !== '' ? { id, community, owner } : { id, community };
}

function parseInfo(raw: unknown): SampleInfo | null {
  const frames = get(raw, 'frames');
  const sampleRate = get(raw, 'sampleRate');
  const channels = get(raw, 'channels');
  const name = get(raw, 'name');
  const savedAt = get(raw, 'savedAt');
  if (typeof frames !== 'number' || !Number.isInteger(frames) || frames < MIN_TRIM) return null;
  if (typeof sampleRate !== 'number' || !Number.isInteger(sampleRate) || sampleRate <= 0) {
    return null;
  }
  if (channels !== 1 && channels !== 2) return null;
  if (typeof name !== 'string' || typeof savedAt !== 'string' || savedAt === '') return null;
  const remote = parseRemote(get(raw, 'remote'));
  const info: SampleInfo = { name, frames, sampleRate, channels, savedAt };
  if (remote !== null) info.remote = remote;
  return info;
}

/** A stored patch; anything invalid falls back to the default field by field. */
export function parsePatch(raw: unknown, id: SamplerId): SamplerPatch {
  const d = defaultPatch(id);
  const sample = parseInfo(get(raw, 'sample'));
  const frames = sample?.frames ?? 0;
  let start = num(raw, 'start', 0);
  let end = num(raw, 'end', frames);
  // A trim that does not fit the sample resets to the whole sample.
  if (start < 0 || end > frames || end - start < Math.min(frames, MIN_TRIM)) {
    start = 0;
    end = frames;
  }
  const loop = get(raw, 'loop');
  const envelope = get(raw, 'envelope');
  const filter = get(raw, 'filter');
  const mode = get(loop, 'mode');
  const type = get(filter, 'type');
  return clampPatch(
    {
      name: str(raw, 'name', d.name),
      program: num(raw, 'program', d.program),
      sample,
      root: num(raw, 'root', d.root),
      tune: num(raw, 'tune', d.tune),
      keytrack: num(raw, 'keytrack', d.keytrack),
      start,
      end,
      reverse: bool(raw, 'reverse', d.reverse),
      loop: {
        enabled: bool(loop, 'enabled', d.loop.enabled),
        start: num(loop, 'start', Math.floor(frames / 4)),
        end: num(loop, 'end', Math.floor((frames * 3) / 4)),
        crossfade: num(loop, 'crossfade', d.loop.crossfade),
        mode: LOOP_MODES.find((m) => m === mode) ?? d.loop.mode,
      },
      envelope: {
        attack: num(envelope, 'attack', d.envelope.attack),
        decay: num(envelope, 'decay', d.envelope.decay),
        sustain: num(envelope, 'sustain', d.envelope.sustain),
        release: num(envelope, 'release', d.envelope.release),
      },
      filter: {
        type: FILTER_TYPES.find((t) => t === type) ?? d.filter.type,
        cutoff: num(filter, 'cutoff', d.filter.cutoff),
        resonance: num(filter, 'resonance', d.filter.resonance),
        envAmount: num(filter, 'envAmount', d.filter.envAmount),
      },
      gain: num(raw, 'gain', d.gain),
      pan: num(raw, 'pan', d.pan),
      velocityToGain: num(raw, 'velocityToGain', d.velocityToGain),
      velocityToCutoff: num(raw, 'velocityToCutoff', d.velocityToCutoff),
    },
    id,
  );
}

/** Every slot of a stored `samplers` object; missing or invalid slots get the default patch. */
export function parseSamplers(raw: unknown): Record<SamplerId, SamplerPatch> {
  return samplerRecord((id) => {
    const value = get(raw, id);
    return value === undefined ? defaultPatch(id) : parsePatch(value, id);
  });
}

// ---------------------------------------------------------------------------------------------
// Playback maths

/** `playbackRate` of `note` (keytrack and tune applied). */
export function samplerRate(patch: SamplerPatch, note: number): number {
  return 2 ** (((note - patch.root) * patch.keytrack) / 100 / 12 + patch.tune / 1200);
}

function velocityFactor(amount: number, velocity: number): number {
  const v = Math.min(127, Math.max(0, velocity)) / 127;
  return 1 - (amount / 100) * (1 - v);
}

/** Envelope peak of a note: the level, the velocity and the sample's own peak (normalised). */
export function samplerPeak(patch: SamplerPatch, velocity: number, samplePeak: number): number {
  const peak = samplePeak > 0 ? samplePeak : 1;
  return (
    ((SAMPLER_LEVEL * dbToGain(patch.gain)) / peak) * velocityFactor(patch.velocityToGain, velocity)
  );
}

/** Quality factor of a resonance (0–100 %). */
export function resonanceQ(resonance: number): number {
  return Q_MIN * (Q_MAX / Q_MIN) ** (Math.min(100, Math.max(0, resonance)) / 100);
}

/** The Biquad Q value: a quality factor for bandpass, dB for lowpass and highpass. */
export function filterQ(filter: SamplerFilter): number {
  const q = resonanceQ(filter.resonance);
  return filter.type === 'bandpass' ? q : 20 * Math.log10(q);
}

/** The note's cutoff before the envelope (soft notes darker by velocityToCutoff). */
export function noteCutoff(patch: SamplerPatch, velocity: number): number {
  const v = Math.min(127, Math.max(0, velocity)) / 127;
  return (
    patch.filter.cutoff * 2 ** (-VELOCITY_CUTOFF_OCTAVES * (patch.velocityToCutoff / 100) * (1 - v))
  );
}

/** Cutoff at envelope level `level` (0–1), clamped to 20 Hz … 0.45 × `sampleRate`. */
export function cutoffAt(
  base: number,
  envAmount: number,
  level: number,
  sampleRate: number,
): number {
  const f = base * 2 ** ((ENV_OCTAVES * envAmount * level) / 100);
  return Math.min(sampleRate * 0.45, RANGES.cutoff.max, Math.max(RANGES.cutoff.min, f));
}

/**
 * Envelope level (0–1) `t` seconds after the note start, released after `held` seconds;
 * mirrors the scheduled automation (linear attack, decay with τ = decay / 3, release with
 * τ = release / 4).
 */
export function envelopeAt(envelope: SamplerEnvelope, t: number, held = Infinity): number {
  const level = (at: number): number => {
    if (at <= 0) return 0;
    if (at < envelope.attack) return at / envelope.attack;
    const s = envelope.sustain;
    return s + (1 - s) * Math.exp(-(at - envelope.attack) / (envelope.decay / 3));
  };
  if (t < held) return level(t);
  return level(held) * Math.exp(-(t - held) / (envelope.release / 4));
}

// ---------------------------------------------------------------------------------------------
// Root detection

export interface DetectedPitch {
  /** Nearest MIDI note. */
  note: number;
  /** Offset from that note, −50…+50 cents. */
  cents: number;
  /** Hz. */
  frequency: number;
}

/**
 * Pitch of periodic material (YIN: difference function, cumulative mean normalisation, the first
 * dip below 0.15 or the global minimum below 0.35, parabolic refinement) between 40 and 2000 Hz.
 * Null for noise, silence or too little material.
 */
export function detectPitch(data: Float32Array, sampleRate: number): DetectedPitch | null {
  const minLag = Math.max(2, Math.floor(sampleRate / 2000));
  const maxLag = Math.ceil(sampleRate / 40);
  const window = Math.min(4096, data.length - maxLag - 1);
  if (window < minLag * 4) return null;
  let energy = 0;
  for (let i = 0; i < window; i++) energy += (data[i] ?? 0) ** 2;
  if (energy / window < 1e-10) return null;
  const d = new Float64Array(maxLag + 2);
  for (let lag = 1; lag <= maxLag + 1; lag++) {
    let sum = 0;
    for (let i = 0; i < window; i++) {
      const diff = (data[i] ?? 0) - (data[i + lag] ?? 0);
      sum += diff * diff;
    }
    d[lag] = sum;
  }
  const cmnd = new Float64Array(maxLag + 2);
  cmnd[0] = 1;
  let running = 0;
  for (let lag = 1; lag <= maxLag + 1; lag++) {
    running += d[lag] ?? 0;
    cmnd[lag] = running > 0 ? ((d[lag] ?? 0) * lag) / running : 1;
  }
  let best = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if ((cmnd[lag] ?? 1) < 0.15) {
      while (lag + 1 <= maxLag && (cmnd[lag + 1] ?? 1) < (cmnd[lag] ?? 1)) lag++;
      best = lag;
      break;
    }
  }
  if (best < 0) {
    let min = Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const v = cmnd[lag] ?? 1;
      if (v < min) {
        min = v;
        best = lag;
      }
    }
    if (min >= 0.35) return null;
  }
  // Refine on the raw difference function, which is smoother around the dip than its normalisation.
  const a = d[best - 1] ?? 0;
  const b = d[best] ?? 0;
  const c = d[best + 1] ?? 0;
  const denominator = a - 2 * b + c;
  const shift = denominator > 0 ? (0.5 * (a - c)) / denominator : 0;
  const period = best + Math.max(-1, Math.min(1, shift));
  const frequency = sampleRate / period;
  const midi = 69 + 12 * Math.log2(frequency / 440);
  const note = Math.round(midi);
  if (note < 0 || note > 127) return null;
  return { note, cents: Math.round((midi - note) * 100), frequency };
}

/** Mono mix of `frames` frames from `from` (channels averaged). */
export function monoRegion(buffer: SamplerBuffer, from: number, frames: number): Float32Array {
  const out = new Float32Array(Math.max(0, Math.min(frames, buffer.length - from)));
  const channels = Math.min(2, buffer.numberOfChannels);
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) + (data[from + i] ?? 0) / channels;
  }
  return out;
}

/** Root of the trimmed region: from 10 % into it, at most 8192 frames. */
export function detectRoot(buffer: SamplerBuffer, patch: SamplerPatch): DetectedPitch | null {
  const length = patch.end - patch.start;
  const from = patch.start + Math.floor(length / 10);
  return detectPitch(monoRegion(buffer, from, Math.min(8192, patch.end - from)), buffer.sampleRate);
}

// ---------------------------------------------------------------------------------------------
// Buffers

/** A decoded sample or a prepared copy (a real `AudioBuffer` satisfies it). */
export interface SamplerBuffer extends BufferLike {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  readonly duration: number;
}

export type BufferFactory = (channels: number, length: number, sampleRate: number) => SamplerBuffer;

/** Largest absolute value over every channel. */
export function bufferPeak(buffer: SamplerBuffer): number {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    for (const v of buffer.getChannelData(c)) peak = Math.max(peak, Math.abs(v));
  }
  return peak;
}

export interface WaveformPeaks {
  /** Per column, normalised to ±1 by the sample peak. */
  min: Float32Array;
  max: Float32Array;
}

/** Minimum and maximum per column over every channel of the whole sample. */
export function waveformPeaks(buffer: SamplerBuffer, columns: number, peak = 1): WaveformPeaks {
  const n = Math.max(1, Math.floor(columns));
  const min = new Float32Array(n);
  const max = new Float32Array(n);
  const scale = peak > 0 ? 1 / peak : 1;
  for (let col = 0; col < n; col++) {
    const from = Math.floor((col * buffer.length) / n);
    const to = Math.max(from + 1, Math.floor(((col + 1) * buffer.length) / n));
    let lo = Infinity;
    let hi = -Infinity;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = from; i < to && i < data.length; i++) {
        const v = data[i] ?? 0;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    min[col] = Number.isFinite(lo) ? lo * scale : 0;
    max[col] = Number.isFinite(hi) ? hi * scale : 0;
  }
  return { min, max };
}

/** The buffers a voice plays (docs/specs/sampler-v1.md §5). */
export interface PreparedSample {
  /** The trimmed region, reversed when `reverse` is on; plays unlooped and serves the tail. */
  plain: SamplerBuffer;
  /** The loop buffer with its points in seconds of buffer, or null without a loop. */
  loop: PreparedLoop | null;
  /** Peak of the decoded sample (for normalising). */
  peak: number;
}

export interface PreparedLoop {
  buffer: SamplerBuffer;
  /** `loopStart` / `loopEnd` of the source (seconds of buffer). */
  start: number;
  end: number;
  /** Where the looping source hands over to `plain` after the release (seconds of buffer). */
  handoff: number;
}

/** The loop region in coordinates of the plain (trimmed, maybe reversed) region. */
export function plainLoop(patch: SamplerPatch): { start: number; end: number } {
  const { start, end, reverse, loop } = patch;
  return reverse
    ? { start: end - loop.end, end: end - loop.start }
    : { start: loop.start - start, end: loop.end - start };
}

/**
 * Prepare the buffers of `patch` from the decoded `source`: the plain region and, when the loop
 * is on, the loop buffer (forward: up to the loop end with the crossfade baked in before it;
 * ping-pong: up to the loop end, then the loop region reversed without its end frames).
 */
export function prepareSample(
  source: SamplerBuffer,
  patch: SamplerPatch,
  create: BufferFactory,
  peak = bufferPeak(source),
): PreparedSample {
  const channels = Math.max(1, Math.min(2, source.numberOfChannels));
  const rate = source.sampleRate;
  const length = Math.max(1, Math.min(patch.end, source.length) - patch.start);
  const plain = create(channels, length, rate);
  for (let c = 0; c < channels; c++) {
    const from = source.getChannelData(c);
    const to = plain.getChannelData(c);
    for (let i = 0; i < length; i++) {
      to[i] = from[patch.reverse ? patch.end - 1 - i : patch.start + i] ?? 0;
    }
  }
  if (!patch.loop.enabled) return { plain, loop: null, peak };
  const { start: ls, end: le } = plainLoop(patch);
  const span = le - ls;
  if (patch.loop.mode === 'pingpong' && span >= 3) {
    const buffer = create(channels, le + span - 2, rate);
    for (let c = 0; c < channels; c++) {
      const from = plain.getChannelData(c);
      const to = buffer.getChannelData(c);
      to.set(from.subarray(0, le));
      // le - 2 down to ls + 1: the end frames are not repeated.
      for (let k = 0; k < span - 2; k++) to[le + k] = from[le - 2 - k] ?? 0;
    }
    return {
      plain,
      loop: { buffer, start: ls / rate, end: (le + span - 2) / rate, handoff: le / rate },
      peak,
    };
  }
  const fade = Math.max(0, Math.min(patch.loop.crossfade, ls, Math.floor(span / 2)));
  const buffer = create(channels, le, rate);
  for (let c = 0; c < channels; c++) {
    const from = plain.getChannelData(c);
    const to = buffer.getChannelData(c);
    to.set(from.subarray(0, le));
    // The last `fade` frames blend into the frames before the loop start, so the frame before
    // the jump is plain[ls - 1] and the frame after it plain[ls].
    for (let k = 0; k < fade; k++) {
      const w = (k + 1) / fade;
      const at = le - fade + k;
      to[at] = (from[at] ?? 0) * (1 - w) + (from[ls - fade + k] ?? 0) * w;
    }
  }
  return {
    plain,
    loop: { buffer, start: ls / rate, end: le / rate, handoff: (le - fade) / rate },
    peak,
  };
}

/**
 * The first time at or after `release` that a looping source started at `start` with `rate`
 * reaches `handoff` (seconds of buffer, inside the loop or at its end). The position is
 * deterministic: it passes the hand-off at `handoff + k × (loopEnd − loopStart)` unwrapped.
 */
export function handoffTime(
  start: number,
  rate: number,
  loop: Pick<PreparedLoop, 'start' | 'end' | 'handoff'>,
  release: number,
): number {
  const cycle = loop.end - loop.start;
  const position = (release - start) * rate;
  const k = cycle > 0 ? Math.max(0, Math.ceil((position - loop.handoff) / cycle - 1e-9)) : 0;
  return start + (loop.handoff + k * cycle) / rate;
}

// ---------------------------------------------------------------------------------------------
// Voice

export interface SamplerVoice {
  gain: GainLike;
  /** The first source (the loop source with a loop). */
  sources: SourceLike[];
  /** The patch's release (seconds). */
  release: number;
  /** Envelope peak and attack (seconds). */
  peak: number;
  attack: number;
  /** How long the unlooped sample plays (seconds); Infinity with a loop. */
  length: number;
  /** The envelope gain at `time` (the release anchors there). */
  levelAt(time: number): number;
  /**
   * Called by the synth's release: the filter follows, the loop hands over to the tail, every
   * source stops at `stopAt`.
   */
  releaseAt(at: number, release: number, stopAt: number): void;
}

function stopSafely(source: SourceLike, time: number): void {
  try {
    source.stop(time);
  } catch {
    // Some engines reject a second stop(); the first one already ends the source.
  }
}

/**
 * One sampler note from `start`: buffer source (plain, or the loop buffer looping) → envelope
 * gain → Biquad filter → panner → `out`. The synth schedules the release through `releaseAt`.
 */
export function buildSamplerVoice(
  ctx: SynthContext,
  prepared: PreparedSample,
  patch: SamplerPatch,
  note: number,
  velocity: number,
  start: number,
  out: NodeLike,
): SamplerVoice {
  const rate = samplerRate(patch, note);
  const env = patch.envelope;
  const peak = samplerPeak(patch, velocity, prepared.peak);

  const gain = ctx.createGain();
  const g = gain.gain;
  g.value = 0;
  g.setValueAtTime(0, start);
  g.linearRampToValueAtTime(peak, start + env.attack);
  g.setTargetAtTime(peak * env.sustain, start + env.attack, env.decay / 3);

  const filter: FilterLike = ctx.createBiquadFilter();
  filter.type = patch.filter.type;
  filter.Q.value = filterQ(patch.filter);
  const base = noteCutoff(patch, velocity);
  const amount = patch.filter.envAmount;
  const at = (level: number): number => cutoffAt(base, amount, level, ctx.sampleRate);
  const f0 = at(0);
  const fPeak = at(1);
  const fSustain = at(env.sustain);
  filter.frequency.value = f0;
  /** The filter frequency the automation holds at `time` (before any release). */
  const frequencyAt = (time: number): number => {
    const t = time - start;
    if (t <= 0) return f0;
    if (t < env.attack) return f0 * (fPeak / f0) ** (t / env.attack);
    return fSustain + (fPeak - fSustain) * Math.exp(-(t - env.attack) / (env.decay / 3));
  };
  if (amount !== 0) {
    const f = filter.frequency;
    f.setValueAtTime(f0, start);
    f.exponentialRampToValueAtTime(fPeak, start + env.attack);
    f.setTargetAtTime(fSustain, start + env.attack, env.decay / 3);
  }

  const panner = ctx.createStereoPanner();
  panner.pan.value = patch.pan;
  gain.connect(filter);
  filter.connect(panner);
  panner.connect(out);

  const loop = prepared.loop;
  const main: BufferSourceLike = ctx.createBufferSource();
  main.buffer = loop?.buffer ?? prepared.plain;
  main.playbackRate.value = rate;
  if (loop !== null) {
    main.loop = true;
    main.loopStart = loop.start;
    main.loopEnd = loop.end;
  }
  main.connect(gain);
  main.start(start);

  let released = false;
  let tail: BufferSourceLike | null = null;
  let handoff = Infinity;
  return {
    gain,
    sources: [main],
    release: env.release,
    peak,
    attack: env.attack,
    length: loop === null ? prepared.plain.duration / rate : Infinity,
    levelAt: (time) => peak * envelopeAt(env, time - start),
    releaseAt(time, release, stopAt) {
      if (amount !== 0) {
        const f = filter.frequency;
        f.cancelScheduledValues(time);
        f.setValueAtTime(frequencyAt(time), time);
        f.setTargetAtTime(f0, time, release / 4);
      }
      if (released) {
        // An earlier release (Stop, a steal): keep a hand-off that already happens before the
        // new stop, else stop everything at the new stop.
        if (tail !== null && handoff < stopAt) stopSafely(tail, stopAt);
        else {
          stopSafely(main, stopAt);
          if (tail !== null) stopSafely(tail, stopAt);
        }
        return;
      }
      released = true;
      if (loop !== null && time > start) {
        const t = handoffTime(start, rate, loop, time);
        if (t < stopAt) {
          stopSafely(main, t);
          tail = ctx.createBufferSource();
          tail.buffer = prepared.plain;
          tail.playbackRate.value = rate;
          tail.connect(gain);
          tail.start(t, loop.handoff);
          stopSafely(tail, stopAt);
          handoff = t;
          return;
        }
      }
      stopSafely(main, stopAt);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Bank: decoded samples per slot

export type SamplerState = 'empty' | 'loading' | 'ready' | 'error';

export type SamplerDecoder = (bytes: ArrayBuffer) => Promise<SamplerBuffer>;

/** Downloads the bytes of a sample's server copy by its id. */
export type RemoteBytes = (remoteId: string) => Promise<ArrayBuffer>;

export interface SamplerBankOptions {
  /** Decodes at SAMPLER_RATE (the app uses an OfflineAudioContext). */
  decode: SamplerDecoder;
  /** Creates the prepared buffers. */
  create: BufferFactory;
  /** ISO timestamp of a new sample (tests pin it). */
  now?: () => string;
}

interface Slot {
  state: SamplerState;
  error: string | null;
  /** `savedAt` of the decoded (or loading) sample. */
  savedAt: string | null;
  buffer: SamplerBuffer | null;
  peak: number;
  waveform: Map<number, WaveformPeaks>;
  prepared: { key: string; value: PreparedSample } | null;
  /** The download of this sample's server copy failed (not retried until a reload). */
  remoteFailed: boolean;
}

/** The bytes of a picked file (FileReader where Blob.arrayBuffer is missing). */
function readBytes(file: Blob): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      reader.result instanceof ArrayBuffer
        ? resolve(reader.result)
        : reject(new Error('the file could not be read'));
    reader.onerror = () => reject(reader.error ?? new Error('the file could not be read'));
    reader.readAsArrayBuffer(file);
  });
}

/** A short, user-facing reason for a failed load. */
export function loadError(e: unknown): string {
  if (e instanceof RangeError) return e.message;
  if (e instanceof Error && e.name === 'EncodingError') return 'the file could not be decoded';
  return e instanceof Error ? e.message : String(e);
}

/** Throws a RangeError when a decoded sample breaks a limit of §3. */
export function checkDecoded(buffer: SamplerBuffer): number {
  const seconds = buffer.length / buffer.sampleRate;
  if (seconds < SAMPLER_MIN_SECONDS) throw new RangeError('the sample is shorter than 10 ms');
  if (seconds > SAMPLER_MAX_SECONDS) {
    throw new RangeError(`the sample is longer than ${SAMPLER_MAX_SECONDS} s`);
  }
  const peak = bufferPeak(buffer);
  if (peak < 1e-6) throw new RangeError('the sample is silent');
  return peak;
}

/**
 * The decoded samples of the eight slots: read from the sample store when a patch names one,
 * decoded once, with cached waveform peaks and prepared buffers.
 */
export class SamplerBank {
  readonly #decode: SamplerDecoder;
  readonly #create: BufferFactory;
  readonly #now: () => string;
  readonly #slots = new Map<SamplerId, Slot>();
  readonly #listeners = new Set<(id: SamplerId) => void>();
  #store: SampleStore | null = null;
  #remote: RemoteBytes | null = null;
  /** Bumped per load, so a stale decode never lands. */
  #tokens = new Map<SamplerId, number>();

  constructor(options: SamplerBankOptions) {
    this.#decode = options.decode;
    this.#create = options.create;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  get store(): SampleStore | null {
    return this.#store;
  }

  /** Use `store` from now on (the app opens it after start-up). */
  setStore(store: SampleStore): void {
    this.#store = store;
  }

  /**
   * Download the bytes of a sample with a server copy when the local store lacks them
   * (docs/specs/community-v1.md §4.2); they are stored locally again.
   */
  setRemote(remote: RemoteBytes | null): void {
    this.#remote = remote;
  }

  state(id: SamplerId): SamplerState {
    return this.#slots.get(id)?.state ?? 'empty';
  }

  error(id: SamplerId): string | null {
    return this.#slots.get(id)?.error ?? null;
  }

  buffer(id: SamplerId): SamplerBuffer | null {
    return this.#slots.get(id)?.buffer ?? null;
  }

  subscribe(listener: (id: SamplerId) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Make the slot hold the sample `info` names: load it from the store when needed. */
  sync(id: SamplerId, info: SampleInfo | null): Promise<void> {
    const slot = this.#slot(id);
    if (info === null) {
      if (slot.state !== 'empty' || slot.buffer !== null) {
        this.#tokens.set(id, (this.#tokens.get(id) ?? 0) + 1);
        this.#reset(slot, null);
        slot.state = 'empty';
        this.#emit(id);
      }
      return Promise.resolve();
    }
    if (slot.savedAt === info.savedAt && slot.state !== 'error') return Promise.resolve();
    // A failed download is not retried on every edit of the patch (only after a reload).
    if (slot.savedAt === info.savedAt && slot.remoteFailed) return Promise.resolve();
    const store = this.#store;
    if (store === null) return Promise.resolve();
    return this.#load(id, info.savedAt, async () => {
      const stored = await store.get(id);
      if (stored !== null && stored.saved_at === info.savedAt) return stored.bytes;
      const remote = this.#remote;
      if (info.remote === undefined || remote === null) {
        throw new Error('the sample is no longer stored');
      }
      let bytes: ArrayBuffer;
      try {
        bytes = await remote(info.remote.id);
      } catch (e) {
        if (slot.savedAt === info.savedAt) slot.remoteFailed = true;
        throw e;
      }
      await store.put({
        schema_version: SAMPLE_SCHEMA_VERSION,
        id,
        name: info.name,
        type: '',
        bytes: bytes.slice(0),
        saved_at: info.savedAt,
      });
      return bytes;
    });
  }

  /**
   * Check and decode `file`, store its bytes for `id` and keep it decoded. Rejects (the slot
   * keeps its sample) when the file is too large, does not decode, or breaks a limit.
   */
  async importFile(id: SamplerId, file: Blob & { name: string }): Promise<SampleInfo> {
    if (file.size > MAX_SAMPLER_BYTES) {
      throw new RangeError(`the file is larger than ${MAX_SAMPLER_BYTES / 1024 / 1024} MB`);
    }
    return this.importBytes(id, await readBytes(file), file.name, file.type);
  }

  /** `importFile` for bytes already in hand (a sample from the community bank). */
  async importBytes(
    id: SamplerId,
    bytes: ArrayBuffer,
    name: string,
    type: string,
  ): Promise<SampleInfo> {
    if (bytes.byteLength > MAX_SAMPLER_BYTES) {
      throw new RangeError(`the file is larger than ${MAX_SAMPLER_BYTES / 1024 / 1024} MB`);
    }
    // Decode a copy: decodeAudioData detaches the buffer it is given.
    const buffer = await this.#decode(bytes.slice(0));
    const peak = checkDecoded(buffer);
    const savedAt = this.#now();
    await this.#store?.put({
      schema_version: SAMPLE_SCHEMA_VERSION,
      id,
      name,
      type,
      bytes,
      saved_at: savedAt,
    });
    this.#tokens.set(id, (this.#tokens.get(id) ?? 0) + 1);
    const slot = this.#slot(id);
    this.#reset(slot, savedAt);
    slot.buffer = buffer;
    slot.peak = peak;
    slot.state = 'ready';
    this.#emit(id);
    return {
      name,
      frames: buffer.length,
      sampleRate: buffer.sampleRate,
      channels: buffer.numberOfChannels >= 2 ? 2 : 1,
      savedAt,
    };
  }

  /** Decode and check bytes that are not stored in a slot (a preview); the slot is untouched. */
  async decodeLoose(bytes: ArrayBuffer): Promise<{ buffer: SamplerBuffer; peak: number }> {
    const buffer = await this.#decode(bytes.slice(0));
    return { buffer, peak: checkDecoded(buffer) };
  }

  /** Prepared buffers of a loose (preview) sample. */
  prepareLoose(buffer: SamplerBuffer, patch: SamplerPatch, peak: number): PreparedSample {
    return prepareSample(buffer, patch, this.#create, peak);
  }

  /** Forget and delete the slot's sample. */
  async remove(id: SamplerId): Promise<void> {
    await this.#store?.delete(id);
    await this.sync(id, null);
  }

  /** Waveform peaks of the slot's sample, cached per column count. */
  waveform(id: SamplerId, columns: number): WaveformPeaks | null {
    const slot = this.#slots.get(id);
    if (slot?.buffer == null) return null;
    let peaks = slot.waveform.get(columns);
    if (peaks === undefined) {
      peaks = waveformPeaks(slot.buffer, columns, slot.peak);
      slot.waveform.set(columns, peaks);
    }
    return peaks;
  }

  /** The prepared buffers of `patch` (cached until the geometry changes), or null. */
  prepared(id: SamplerId, patch: SamplerPatch): PreparedSample | null {
    const slot = this.#slots.get(id);
    const buffer = slot?.buffer ?? null;
    if (slot === undefined || buffer === null || slot.state !== 'ready') return null;
    if (patch.sample?.savedAt !== slot.savedAt) return null;
    const { start, end, reverse, loop } = patch;
    const key = JSON.stringify([start, end, reverse, loop]);
    if (slot.prepared?.key !== key) {
      slot.prepared = { key, value: prepareSample(buffer, patch, this.#create, slot.peak) };
    }
    return slot.prepared.value;
  }

  async #load(id: SamplerId, savedAt: string, bytes: () => Promise<ArrayBuffer>): Promise<void> {
    const token = (this.#tokens.get(id) ?? 0) + 1;
    this.#tokens.set(id, token);
    const slot = this.#slot(id);
    this.#reset(slot, savedAt);
    slot.state = 'loading';
    this.#emit(id);
    try {
      const buffer = await this.#decode(await bytes());
      const peak = checkDecoded(buffer);
      if (this.#tokens.get(id) !== token) return;
      slot.buffer = buffer;
      slot.peak = peak;
      slot.state = 'ready';
    } catch (e) {
      if (this.#tokens.get(id) !== token) return;
      slot.state = 'error';
      slot.error = loadError(e);
    }
    this.#emit(id);
  }

  #slot(id: SamplerId): Slot {
    let slot = this.#slots.get(id);
    if (slot === undefined) {
      slot = {
        state: 'empty',
        error: null,
        savedAt: null,
        buffer: null,
        peak: 0,
        waveform: new Map(),
        prepared: null,
        remoteFailed: false,
      };
      this.#slots.set(id, slot);
    }
    return slot;
  }

  #reset(slot: Slot, savedAt: string | null): void {
    if (slot.savedAt !== savedAt) slot.remoteFailed = false;
    slot.savedAt = savedAt;
    slot.buffer = null;
    slot.peak = 0;
    slot.error = null;
    slot.waveform.clear();
    slot.prepared = null;
  }

  #emit(id: SamplerId): void {
    for (const listener of [...this.#listeners]) listener(id);
  }
}

// ---------------------------------------------------------------------------------------------
// Edit API

/** Where the patches live (the sound settings implement it). */
export interface SamplerPatches {
  sampler(id: SamplerId): SamplerPatch;
  setSampler(id: SamplerId, patch: SamplerPatch): void;
  subscribe(listener: () => void): () => void;
}

/** A sounding audition note. */
export interface AuditionHandle {
  release(time?: number): void;
}

/** Plays one note of a slot now (the audio engine provides it); null while audio is off. */
export type SamplerAudition = (
  id: SamplerId,
  note: number,
  velocity: number,
  track?: string,
) => AuditionHandle | null;

/** Plays one note of prepared buffers now (a preview); null while audio is off. */
export type SamplerPlay = (
  ready: { patch: SamplerPatch; prepared: PreparedSample },
  note: number,
  velocity: number,
) => AuditionHandle | null;

/** How many decoded previews `Samplers.preview` keeps. */
export const PREVIEW_CACHE = 8;

/** What the synth needs to play a slot. */
export interface SamplerSource {
  /** The patch and prepared buffers of a slot with a decoded sample, else null. */
  playable(id: SamplerId): { patch: SamplerPatch; prepared: PreparedSample } | null;
}

/**
 * The sampler edit API (docs/specs/sampler-v1.md §6): reads and writes the patches in the sound
 * settings, keeps the bank in step with them, plays auditions. UI-independent; the Sampler panel
 * and the Akai Fire's SAMPLE mode both drive it.
 */
export class Samplers implements SamplerSource {
  readonly #patches: SamplerPatches;
  readonly #bank: SamplerBank;
  readonly #audition: SamplerAudition | null;
  readonly #play: SamplerPlay | null;
  readonly #listeners = new Set<(id: SamplerId) => void>();
  /** Decoded previews by key, oldest first. */
  readonly #previews = new Map<
    string,
    Promise<{ patch: SamplerPatch; prepared: PreparedSample }>
  >();
  #last: Map<SamplerId, SamplerPatch>;

  constructor(
    patches: SamplerPatches,
    bank: SamplerBank,
    audition: SamplerAudition | null = null,
    play: SamplerPlay | null = null,
  ) {
    this.#patches = patches;
    this.#bank = bank;
    this.#audition = audition;
    this.#play = play;
    this.#last = this.#snapshot();
    patches.subscribe(() => {
      const next = this.#snapshot();
      for (const id of SAMPLER_IDS) {
        if (next.get(id) === this.#last.get(id)) continue;
        void this.#bank.sync(id, next.get(id)?.sample ?? null);
        this.#emit(id);
      }
      this.#last = next;
    });
    bank.subscribe((id) => this.#emit(id));
  }

  /** Use the sample store and load every stored sample the patches name. */
  attach(store: SampleStore): Promise<void> {
    this.#bank.setStore(store);
    return Promise.all(SAMPLER_IDS.map((id) => this.#bank.sync(id, this.patch(id).sample))).then(
      () => undefined,
    );
  }

  patch(id: SamplerId): SamplerPatch {
    return this.#patches.sampler(id);
  }

  state(id: SamplerId): SamplerState {
    if (this.patch(id).sample === null) return 'empty';
    const state = this.#bank.state(id);
    return state === 'empty' ? 'loading' : state;
  }

  error(id: SamplerId): string | null {
    return this.#bank.error(id);
  }

  waveform(id: SamplerId, columns: number): WaveformPeaks | null {
    return this.#bank.waveform(id, columns);
  }

  playable(id: SamplerId): { patch: SamplerPatch; prepared: PreparedSample } | null {
    const patch = this.patch(id);
    const prepared = this.#bank.prepared(id, patch);
    return prepared === null ? null : { patch, prepared };
  }

  /** Load `file` into the slot: the sample, the whole-sample trim, the loop, the detected root. */
  async load(id: SamplerId, file: Blob & { name: string }): Promise<void> {
    const info = await this.#bank.importFile(id, file);
    const buffer = this.#bank.buffer(id);
    const fresh = withSample(this.patch(id), id, info, null);
    const pitch = buffer === null ? null : detectRoot(buffer, fresh);
    this.#set(id, { ...fresh, root: pitch?.note ?? 60 });
  }

  /**
   * Load bytes already in hand into the slot, like `load` (a sample taken from the community
   * bank: its root comes with it, `remote` names the server copy).
   */
  async loadBytes(
    id: SamplerId,
    bytes: ArrayBuffer,
    meta: { name: string; type: string; root?: number; remote?: SampleRemote },
  ): Promise<void> {
    const info = await this.#bank.importBytes(id, bytes, meta.name, meta.type);
    if (meta.remote !== undefined) info.remote = meta.remote;
    const buffer = this.#bank.buffer(id);
    const fresh = withSample(this.patch(id), id, info, null);
    const root = meta.root ?? (buffer === null ? null : detectRoot(buffer, fresh)?.note) ?? 60;
    this.#set(id, { ...fresh, root });
  }

  /**
   * Record (or forget, with null) the server copy of the slot's sample, provided the slot still
   * holds the sample saved at `savedAt`. Returns whether it was written.
   */
  setRemote(id: SamplerId, savedAt: string, remote: SampleRemote | null): boolean {
    const p = this.patch(id);
    if (p.sample?.savedAt !== savedAt) return false;
    const sample: SampleInfo = { ...p.sample };
    if (remote === null) delete sample.remote;
    else sample.remote = remote;
    this.#set(id, { ...p, sample });
    return true;
  }

  /** The stored bytes of the slot's sample (for the upload), or null. */
  async stored(id: SamplerId): Promise<StoredSample | null> {
    const stored = (await this.#bank.store?.get(id)) ?? null;
    return stored !== null && stored.saved_at === this.patch(id).sample?.savedAt ? stored : null;
  }

  /**
   * Play a sample that is in no slot at its root note through the sampler voice (the Community
   * tab's audition): `load` fetches its bytes the first time, the decoded sample is kept under
   * `key`. Resolves to a handle to release, or null while audio is off; rejects when the bytes
   * cannot be fetched or decoded.
   */
  async preview(
    key: string,
    load: () => Promise<ArrayBuffer>,
    root: number,
    velocity = 100,
  ): Promise<AuditionHandle | null> {
    if (this.#play === null) return null;
    let ready = this.#previews.get(key);
    if (ready === undefined) {
      ready = load().then(async (bytes) => {
        const { buffer, peak } = await this.#bank.decodeLoose(bytes);
        const info: SampleInfo = {
          name: key,
          frames: buffer.length,
          sampleRate: buffer.sampleRate,
          channels: buffer.numberOfChannels >= 2 ? 2 : 1,
          savedAt: key,
        };
        const patch = withSample(defaultPatch('sampler-1'), 'sampler-1', info, root);
        return { patch, prepared: this.#bank.prepareLoose(buffer, patch, peak) };
      });
      this.#previews.set(key, ready);
      ready.catch(() => this.#previews.delete(key));
      for (const old of this.#previews.keys()) {
        if (this.#previews.size <= PREVIEW_CACHE) break;
        this.#previews.delete(old);
      }
    }
    const playable = await ready;
    return this.#play(playable, playable.patch.root, velocity);
  }

  /** Remove the slot's sample (the rest of the patch stays). */
  async clear(id: SamplerId): Promise<void> {
    await this.#bank.remove(id);
    this.#set(id, { ...this.patch(id), sample: null });
  }

  setRoot(id: SamplerId, note: number): void {
    this.#edit(id, { root: note });
  }

  /** Detect the root of the current trim and set it; returns the note or null. */
  detectRoot(id: SamplerId): number | null {
    const buffer = this.#bank.buffer(id);
    if (buffer === null) return null;
    const pitch = detectRoot(buffer, this.patch(id));
    if (pitch !== null) this.setRoot(id, pitch.note);
    return pitch?.note ?? null;
  }

  setTune(id: SamplerId, cents: number): void {
    this.#edit(id, { tune: cents });
  }

  setKeytrack(id: SamplerId, percent: number): void {
    this.#edit(id, { keytrack: percent });
  }

  /** Trim to frames `start`…`end` (the end wins when they cross). */
  trim(id: SamplerId, start: number, end: number): void {
    this.#edit(id, { start, end });
  }

  setReverse(id: SamplerId, reverse: boolean): void {
    this.#edit(id, { reverse });
  }

  setLoop(id: SamplerId, loop: Partial<SamplerLoop>): void {
    this.#edit(id, { loop: { ...this.patch(id).loop, ...loop } });
  }

  setEnvelope(id: SamplerId, envelope: Partial<SamplerEnvelope>): void {
    this.#edit(id, { envelope: { ...this.patch(id).envelope, ...envelope } });
  }

  setFilter(id: SamplerId, filter: Partial<SamplerFilter>): void {
    this.#edit(id, { filter: { ...this.patch(id).filter, ...filter } });
  }

  setLevels(
    id: SamplerId,
    levels: Partial<Pick<SamplerPatch, 'gain' | 'pan' | 'velocityToGain' | 'velocityToCutoff'>>,
  ): void {
    this.#edit(id, levels);
  }

  /**
   * Replace the slot's settings with `patch` (clamped) in one change; the sample stays the one
   * the slot holds now, whatever `patch.sample` says (the Fire's knob edits and their undo).
   */
  setPatch(id: SamplerId, patch: SamplerPatch): void {
    this.#set(id, { ...patch, sample: this.patch(id).sample });
  }

  rename(id: SamplerId, name: string): void {
    this.#edit(id, { name });
  }

  setProgram(id: SamplerId, program: number): void {
    this.#edit(id, { program });
  }

  /** Play `note` through the slot now (never called on load); null while audio is off. */
  audition(id: SamplerId, note: number, velocity = 100, track?: string): AuditionHandle | null {
    return this.#audition?.(id, note, velocity, track) ?? null;
  }

  /** Called with the slot id after every change of a patch or of its sample. */
  subscribe(listener: (id: SamplerId) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #edit(id: SamplerId, change: Partial<SamplerPatch>): void {
    this.#set(id, { ...this.patch(id), ...change });
  }

  #set(id: SamplerId, patch: SamplerPatch): void {
    const next = clampPatch(patch, id);
    if (JSON.stringify(next) === JSON.stringify(this.patch(id))) return;
    this.#patches.setSampler(id, next);
  }

  #snapshot(): Map<SamplerId, SamplerPatch> {
    return new Map(SAMPLER_IDS.map((id) => [id, this.#patches.sampler(id)] as const));
  }

  #emit(id: SamplerId): void {
    for (const listener of [...this.#listeners]) listener(id);
  }
}
