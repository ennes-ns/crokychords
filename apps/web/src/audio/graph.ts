/**
 * Builds the Web Audio node graph for instrument voices, drum hits and the master bus. Every
 * builder takes a `SynthContext` (the subset of `BaseAudioContext` used here), so tests can
 * inject a small fake instead of a real AudioContext.
 */
import type { Drum, Instrument } from './instruments';
import { DRUM_PEAK, midiToFrequency, noteCutoff, noteDecay, notePeak } from './instruments';

export interface ParamLike {
  value: number;
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
  exponentialRampToValueAtTime(value: number, time: number): unknown;
  setTargetAtTime(target: number, time: number, timeConstant: number): unknown;
  cancelScheduledValues(time: number): unknown;
}

export interface NodeLike {
  connect(destination: NodeLike): unknown;
  /** Remove every outgoing connection (used to switch the master mode). */
  disconnect(): unknown;
}

export interface GainLike extends NodeLike {
  readonly gain: ParamLike;
}

export interface FilterLike extends NodeLike {
  type: BiquadFilterType;
  readonly frequency: ParamLike;
  readonly Q: ParamLike;
}

export interface SourceLike extends NodeLike {
  start(when?: number): void;
  stop(when?: number): void;
}

export interface OscillatorLike extends SourceLike {
  type: OscillatorType;
  readonly frequency: ParamLike;
  readonly detune: ParamLike;
}

export interface BufferLike {
  getChannelData(channel: number): Float32Array;
}

export interface BufferSourceLike extends SourceLike {
  buffer: BufferLike | null;
}

export interface CompressorLike extends NodeLike {
  readonly threshold: ParamLike;
  readonly knee: ParamLike;
  readonly ratio: ParamLike;
  readonly attack: ParamLike;
  readonly release: ParamLike;
}

export interface WaveShaperLike extends NodeLike {
  curve: Float32Array | null;
  oversample: OverSampleType;
}

/** What the synth needs from an AudioContext; a real `AudioContext` satisfies it. */
export interface SynthContext {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly destination: NodeLike;
  createGain(): GainLike;
  createOscillator(): OscillatorLike;
  createBiquadFilter(): FilterLike;
  createDynamicsCompressor(): CompressorLike;
  createWaveShaper(): WaveShaperLike;
  createBuffer(channels: number, length: number, sampleRate: number): BufferLike;
  createBufferSource(): BufferSourceLike;
}

/** Gain of the mix bus (all tracks and drums) into the compressor. */
export const MIX_GAIN = 0.4;
/** Output gain after the compressor. */
export const MASTER_GAIN = 0.8;
export const COMPRESSOR = {
  threshold: -18,
  knee: 12,
  ratio: 3,
  attack: 0.01,
  release: 0.25,
} as const;

/** Output protection after the master gain: none, a brick-wall-ish limiter or a tanh soft clip. */
export type MasterMode = 'off' | 'limiter' | 'softclip';
export const MASTER_MODES: readonly MasterMode[] = ['off', 'limiter', 'softclip'];
export const MASTER_MODE_LABELS: Readonly<Record<MasterMode, string>> = {
  off: 'Off',
  limiter: 'Limiter',
  softclip: 'Soft clip',
};

export function isMasterMode(value: unknown): value is MasterMode {
  return value === 'off' || value === 'limiter' || value === 'softclip';
}

/** Limiter: a hard `DynamicsCompressorNode` followed by a −0.3 dB ceiling gain. */
export const LIMITER = {
  threshold: -3,
  knee: 0,
  ratio: 20,
  attack: 0.001,
  release: 0.1,
  /** Gain after the compressor (dB). */
  ceiling: -0.3,
} as const;

/** Soft clip: a `WaveShaperNode` with a tanh curve. */
export const SOFTCLIP = { drive: 1, oversample: '2x', points: 2049 } as const satisfies {
  drive: number;
  oversample: OverSampleType;
  points: number;
};

/** Master volume in percent: range and default (80 % plays at unity gain). */
export const VOLUME_DEFAULT = 80;
/** Time constant (seconds) of volume changes, so dragging the slider does not zipper. */
const VOLUME_SMOOTHING = 0.02;

export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

/**
 * Gain of the master volume for `percent` (clamped to 0–100): a squared taper with unity at the
 * default 80 %, so the default keeps the level of the headroom budget and 100 % adds ≈ +3.9 dB.
 */
export function volumeGain(percent: number): number {
  const p = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : VOLUME_DEFAULT));
  return (p / VOLUME_DEFAULT) ** 2;
}

/** The soft-clip transfer curve: `tanh(drive × x)` sampled at `points` over x ∈ [−1, 1]. */
export function softClipCurve(drive: number = SOFTCLIP.drive, points: number = SOFTCLIP.points) {
  const n = Math.max(2, Math.floor(points));
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) curve[i] = Math.tanh(drive * ((i * 2) / (n - 1) - 1));
  return curve;
}

export interface MasterBus {
  /** Where track and drum buses connect. */
  input: GainLike;
  compressor: CompressorLike;
  /** Master gain (MASTER_GAIN): the sum that feeds the protection stage. */
  output: GainLike;
  limiter: CompressorLike;
  /** −0.3 dB ceiling after the limiter. */
  ceiling: GainLike;
  softclip: WaveShaperLike;
  /** User volume, the last node before the destination. */
  volume: GainLike;
  /** Current protection mode. */
  mode: MasterMode;
}

/**
 * mix (MIX_GAIN) → gentle compressor → master (MASTER_GAIN) → [bypass | limiter → ceiling |
 * soft clip] → volume → destination. Starts in `mode` (default off) at `percent` volume.
 */
export function buildMasterBus(
  ctx: SynthContext,
  mode: MasterMode = 'off',
  percent: number = VOLUME_DEFAULT,
): MasterBus {
  const input = ctx.createGain();
  input.gain.value = MIX_GAIN;
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = COMPRESSOR.threshold;
  compressor.knee.value = COMPRESSOR.knee;
  compressor.ratio.value = COMPRESSOR.ratio;
  compressor.attack.value = COMPRESSOR.attack;
  compressor.release.value = COMPRESSOR.release;
  const output = ctx.createGain();
  output.gain.value = MASTER_GAIN;
  input.connect(compressor);
  compressor.connect(output);

  const volume = ctx.createGain();
  volume.gain.value = volumeGain(percent);
  volume.connect(ctx.destination);

  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = LIMITER.threshold;
  limiter.knee.value = LIMITER.knee;
  limiter.ratio.value = LIMITER.ratio;
  limiter.attack.value = LIMITER.attack;
  limiter.release.value = LIMITER.release;
  const ceiling = ctx.createGain();
  ceiling.gain.value = dbToGain(LIMITER.ceiling);
  limiter.connect(ceiling);
  ceiling.connect(volume);

  const softclip = ctx.createWaveShaper();
  softclip.curve = softClipCurve();
  softclip.oversample = SOFTCLIP.oversample;
  softclip.connect(volume);

  const bus: MasterBus = { input, compressor, output, limiter, ceiling, softclip, volume, mode };
  connectMode(bus, mode);
  return bus;
}

function connectMode(bus: MasterBus, mode: MasterMode): void {
  bus.output.connect(
    mode === 'limiter' ? bus.limiter : mode === 'softclip' ? bus.softclip : bus.volume,
  );
  bus.mode = mode;
}

/** Switch the protection stage; `off` connects the master gain straight to the volume. */
export function setMasterMode(bus: MasterBus, mode: MasterMode): void {
  if (mode === bus.mode) return;
  bus.output.disconnect();
  connectMode(bus, mode);
}

/** Glide the master volume to `percent` from `time`. */
export function setMasterVolume(bus: MasterBus, percent: number, time: number): void {
  const g = bus.volume.gain;
  g.cancelScheduledValues(time);
  g.setTargetAtTime(volumeGain(percent), time, VOLUME_SMOOTHING);
}

/** A sounding voice: its envelope gain and the sources to stop. */
export interface VoiceNodes {
  gain: GainLike;
  sources: SourceLike[];
  /** Release time of the instrument (seconds). */
  release: number;
}

/**
 * One instrument note from `start`: oscillators → (lowpass) → envelope gain → `out`. The
 * envelope rises to the peak in `attack`, then decays towards `sustain`. The caller schedules
 * the release and the stop.
 */
export function buildVoice(
  ctx: SynthContext,
  instrument: Instrument,
  note: number,
  velocity: number,
  start: number,
  out: NodeLike,
): VoiceNodes {
  const frequency = midiToFrequency(note);
  const gain = ctx.createGain();
  const peak = notePeak(instrument, velocity);
  const g = gain.gain;
  g.value = 0;
  g.setValueAtTime(0, start);
  g.linearRampToValueAtTime(peak, start + instrument.attack);
  g.setTargetAtTime(
    peak * instrument.sustain,
    start + instrument.attack,
    noteDecay(instrument, frequency) / 3,
  );
  gain.connect(out);

  let input: NodeLike = gain;
  const spec = instrument.filter;
  if (spec !== null) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    const cutoff = noteCutoff(spec, frequency);
    filter.frequency.value = cutoff;
    filter.Q.value = spec.q;
    if (spec.env !== undefined) {
      filter.frequency.setValueAtTime(Math.min(20000, cutoff * spec.env.from), start);
      filter.frequency.setTargetAtTime(cutoff, start, spec.env.time);
    }
    filter.connect(gain);
    input = filter;
  }

  const sources = instrument.oscillators.map((o) => {
    const osc = ctx.createOscillator();
    osc.type = o.type;
    osc.frequency.value = frequency * 2 ** o.octave;
    osc.detune.value = o.detune;
    const mix = ctx.createGain();
    mix.gain.value = o.level;
    osc.connect(mix);
    mix.connect(input);
    osc.start(start);
    return osc;
  });
  return { gain, sources, release: instrument.release };
}

/** One second of white noise for snare and hat (generated once per context). */
export function noiseBuffer(ctx: SynthContext, random: () => number = Math.random): BufferLike {
  const length = Math.max(1, Math.round(ctx.sampleRate));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = random() * 2 - 1;
  return buffer;
}

/** Decay (seconds until ~silent) of each drum. */
export const DRUM_DECAY: Readonly<Record<Drum, number>> = { kick: 0.35, snare: 0.18, hat: 0.05 };
const SILENT = 0.0001;

/**
 * One drum hit at `time` into `out`; the sources stop on their own after the decay.
 * kick: sine sweep 150 → 45 Hz; snare: band-passed noise plus a triangle body; hat: high-passed
 * noise.
 */
export function buildDrum(
  ctx: SynthContext,
  drum: Drum,
  level: number,
  time: number,
  noise: BufferLike,
  out: NodeLike,
): VoiceNodes {
  const decay = DRUM_DECAY[drum];
  const peak = Math.max(SILENT * 2, DRUM_PEAK[drum] * Math.min(1, Math.max(0, level)));
  const end = time + decay;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.gain.setValueAtTime(peak, time);
  gain.gain.exponentialRampToValueAtTime(SILENT, end);
  gain.connect(out);
  const sources: SourceLike[] = [];

  const noiseThrough = (type: BiquadFilterType, frequency: number, q: number): void => {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    src.connect(filter);
    filter.connect(gain);
    src.start(time);
    src.stop(end);
    sources.push(src);
  };

  if (drum === 'kick') {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 150;
    osc.frequency.setValueAtTime(150, time);
    osc.frequency.exponentialRampToValueAtTime(45, time + 0.12);
    osc.connect(gain);
    osc.start(time);
    osc.stop(end);
    sources.push(osc);
  } else if (drum === 'snare') {
    noiseThrough('bandpass', 1800, 0.8);
    const body = ctx.createOscillator();
    body.type = 'triangle';
    body.frequency.value = 185;
    const bodyGain = ctx.createGain();
    bodyGain.gain.value = 0;
    bodyGain.gain.setValueAtTime(0.6, time);
    bodyGain.gain.exponentialRampToValueAtTime(SILENT, time + 0.08);
    body.connect(bodyGain);
    bodyGain.connect(gain);
    body.start(time);
    body.stop(time + 0.08);
    sources.push(body);
  } else {
    noiseThrough('highpass', 7000, 0.7);
  }
  return { gain, sources, release: decay };
}
