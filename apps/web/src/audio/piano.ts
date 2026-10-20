/**
 * Piano v2 voice (docs/specs/web-instruments-v1.md, "Piano v2"): the instrument's detuned
 * oscillators on the fundamental plus inharmonic partials through a velocity-scaled lowpass, a
 * two-stage decay, a short hammer-noise burst, a pan by pitch and a send into the shared room.
 * Pure synthesis on an injected `SynthContext`, like `graph.ts`.
 */
import type { BufferLike, NodeLike, SourceLike, SynthContext, VoiceNodes } from './graph';
import { ROOM } from './graph';
import type { Instrument, PianoSpec } from './instruments';
import {
  midiToFrequency,
  noteCutoff,
  noteDecay,
  notePan,
  notePeak,
  noteTail,
  pianoPartials,
} from './instruments';

/** Partials above this (Hz, or 45 % of the sample rate) are left out: inaudible and aliasing. */
export const PARTIAL_LIMIT_HZ = 16000;
const SILENT = 0.0001;

export interface PianoVoiceOptions {
  /** White-noise buffer for the hammer (shared per context). */
  noise: BufferLike;
  /** Input of the shared room, or null for no room send. */
  room: NodeLike | null;
}

/**
 * One piano note from `start` into `out`:
 * oscillators → level gains → lowpass → envelope ← hammer; envelope → panner → out (+ room send).
 * The caller schedules the release and the stop.
 */
export function buildPianoVoice(
  ctx: SynthContext,
  instrument: Instrument,
  spec: PianoSpec,
  note: number,
  velocity: number,
  start: number,
  out: NodeLike,
  opts: PianoVoiceOptions,
): VoiceNodes {
  const frequency = midiToFrequency(note);
  const v = Math.min(127, Math.max(0, velocity)) / 127;
  const peak = notePeak(instrument, velocity);

  // Envelope: attack, fast first stage towards the tail level, then the long key-tracked tail.
  const gain = ctx.createGain();
  const g = gain.gain;
  g.value = 0;
  g.setValueAtTime(0, start);
  const attackEnd = start + instrument.attack;
  g.linearRampToValueAtTime(peak, attackEnd);
  const decay = noteDecay(instrument, frequency);
  const tail = instrument.tail;
  g.setTargetAtTime(peak * (tail?.level ?? instrument.sustain), attackEnd, decay / 3);
  if (tail !== undefined) g.setTargetAtTime(0, attackEnd + decay, noteTail(tail, frequency) / 3);

  const panner = ctx.createStereoPanner();
  panner.pan.value = notePan(spec, note);
  gain.connect(panner);
  panner.connect(out);
  const wet = ROOM.maxWet * Math.min(1, Math.max(0, instrument.room ?? 0));
  if (opts.room !== null && wet > 0) {
    const send = ctx.createGain();
    send.gain.value = wet;
    panner.connect(send);
    send.connect(opts.room);
  }

  // Lowpass: brightness and velocity scale the cutoff; it starts open and closes (hammer).
  let input: NodeLike = gain;
  const filterSpec = instrument.filter;
  if (filterSpec !== null) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    const velocityScale = spec.velocityCutoff + (1 - spec.velocityCutoff) * v;
    const cutoff = Math.min(
      20000,
      noteCutoff(filterSpec, frequency) * (instrument.brightness ?? 1) * velocityScale,
    );
    filter.frequency.value = cutoff;
    filter.Q.value = filterSpec.q;
    if (filterSpec.env !== undefined) {
      filter.frequency.setValueAtTime(Math.min(20000, cutoff * filterSpec.env.from), start);
      filter.frequency.setTargetAtTime(cutoff, start, filterSpec.env.time);
    }
    filter.connect(gain);
    input = filter;
  }

  const sources: SourceLike[] = [];
  const tone = (type: OscillatorType, hz: number, detune: number, into: NodeLike): void => {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = hz;
    osc.detune.value = detune;
    osc.connect(into);
    osc.start(start);
    sources.push(osc);
  };

  // Fundamental: the detuned unison, each oscillator with its own level.
  for (const o of instrument.oscillators) {
    const level = ctx.createGain();
    level.gain.value = o.level;
    level.connect(input);
    tone(o.type, frequency * 2 ** o.octave, o.detune, level);
  }

  // Inharmonic partials, each with its own level, below the limit.
  const limit = Math.min(PARTIAL_LIMIT_HZ, ctx.sampleRate * 0.45);
  for (const partial of pianoPartials(spec, frequency)) {
    const hz = frequency * partial.ratio;
    if (hz >= limit || partial.level <= 0) continue;
    const level = ctx.createGain();
    level.gain.value = partial.level;
    level.connect(input);
    tone('sine', hz, 0, level);
  }

  // Hammer: a few milliseconds of band-passed noise straight into the envelope gain.
  const hammer = spec.hammer;
  const noise = ctx.createBufferSource();
  noise.buffer = opts.noise;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = Math.min(PARTIAL_LIMIT_HZ, hammer.frequency + frequency);
  band.Q.value = hammer.q;
  const hammerGain = ctx.createGain();
  hammerGain.gain.value = 0;
  hammerGain.gain.setValueAtTime(hammer.level * (0.5 + 0.5 * v), start);
  hammerGain.gain.exponentialRampToValueAtTime(SILENT, start + hammer.duration);
  noise.connect(band);
  band.connect(hammerGain);
  hammerGain.connect(gain);
  noise.start(start);
  noise.stop(start + hammer.duration);

  return { gain, sources, release: instrument.release };
}
