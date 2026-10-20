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

/** What the synth needs from an AudioContext; a real `AudioContext` satisfies it. */
export interface SynthContext {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly destination: NodeLike;
  createGain(): GainLike;
  createOscillator(): OscillatorLike;
  createBiquadFilter(): FilterLike;
  createDynamicsCompressor(): CompressorLike;
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

export interface MasterBus {
  /** Where track and drum buses connect. */
  input: GainLike;
  compressor: CompressorLike;
  output: GainLike;
}

/** mix (MIX_GAIN) → gentle compressor → master (MASTER_GAIN) → destination. */
export function buildMasterBus(ctx: SynthContext): MasterBus {
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
  output.connect(ctx.destination);
  return { input, compressor, output };
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
