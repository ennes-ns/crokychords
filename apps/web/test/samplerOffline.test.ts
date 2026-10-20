// @vitest-environment node
/**
 * Sampler playback rendered offline with a real OfflineAudioContext (node-web-audio-api, nothing
 * is played), docs/specs/sampler-v1.md §5 and §10. Every fixture sample is generated here in
 * code (sines, a DC level, seeded noise, a WAV file encoded on the fly); no audio file is read.
 */
import { AudioBuffer, OfflineAudioContext } from 'node-web-audio-api';
import { describe, expect, it } from 'vitest';
import type { SamplerBuffer, SamplerPatch } from '../src/audio/sampler';
import {
  SAMPLER_LEVEL,
  SAMPLER_RATE,
  SAMPLER_VOICES,
  SamplerBank,
  Samplers,
  buildSamplerVoice,
  envelopeAt,
  handoffTime,
} from '../src/audio/sampler';
import { SoundSettings } from '../src/audio/sound';
import { Synth } from '../src/audio/synth';

const RATE = SAMPLER_RATE;
const ID = 'sampler-1';
/** Equal-power panner at the centre, mono input: each channel carries cos(π/4). */
const CENTRE = Math.SQRT1_2;

function create(channels: number, length: number, sampleRate: number): SamplerBuffer {
  return new AudioBuffer({ numberOfChannels: channels, length, sampleRate });
}

/** A mono fixture buffer from a function of the frame index. */
function fixture(frames: number, at: (i: number) => number): SamplerBuffer {
  const buffer = create(1, frames, RATE);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = at(i);
  return buffer;
}

const sine =
  (hz: number, amplitude = 0.5) =>
  (i: number) =>
    amplitude * Math.sin((2 * Math.PI * hz * i) / RATE);

/** 16-bit PCM WAV of `samples` (mono), encoded in code for the decode path. */
function wav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(bytes);
  const text = (at: number, s: string) =>
    [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) =>
    v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, s)) * 32767), true),
  );
  return bytes;
}

interface Rig {
  sound: SoundSettings;
  samplers: Samplers;
  ctx: OfflineAudioContext;
  synth: Synth;
  edit(change: Partial<SamplerPatch>): void;
}

/** A slot holding `buffer`, and a synth over an offline context of `seconds`. */
async function rig(buffer: SamplerBuffer, seconds: number, channels = 1): Promise<Rig> {
  const sound = new SoundSettings();
  let stamp = 0;
  const bank = new SamplerBank({
    decode: () => Promise.resolve(buffer),
    create,
    now: () => `t${++stamp}`,
  });
  const samplers = new Samplers(sound, bank);
  await samplers.load(ID, new File([new Uint8Array(16)], 'fixture.wav'));
  const ctx = new OfflineAudioContext({
    numberOfChannels: channels,
    length: Math.round(seconds * RATE),
    sampleRate: RATE,
  });
  const synth = new Synth(ctx, () => sound.preset, undefined, {
    voice: (track, role) => sound.voice(track, role),
    samplers,
  });
  return {
    sound,
    samplers,
    ctx,
    synth,
    edit: (change) => sound.setSampler(ID, { ...sound.sampler(ID), ...change }),
  };
}

function play(r: Rig, note: number, time: number, duration: number, velocity = 127): void {
  r.synth.playNote(note, time, duration, { instrumentId: ID, velocity, track: 't' });
}

async function render(r: Rig): Promise<Float32Array> {
  return (await r.ctx.startRendering()).getChannelData(0);
}

function rms(data: Float32Array, from: number, to: number): number {
  let sum = 0;
  const a = Math.round(from * RATE);
  const b = Math.round(to * RATE);
  for (let i = a; i < b; i++) sum += (data[i] ?? 0) ** 2;
  return Math.sqrt(sum / Math.max(1, b - a));
}

/** Frequency from upward zero crossings between `from` and `to` seconds. */
function pitch(data: Float32Array, from: number, to: number): number {
  const crossings: number[] = [];
  for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) {
    if ((data[i - 1] ?? 0) < 0 && (data[i] ?? 0) >= 0) crossings.push(i);
  }
  const first = crossings[0] ?? 0;
  const last = crossings.at(-1) ?? 0;
  return ((crossings.length - 1) * RATE) / (last - first);
}

/** Magnitude of `frequency` in a window (Goertzel). */
function tone(data: Float32Array, frequency: number, from: number, to: number): number {
  const w = (2 * Math.PI * frequency) / RATE;
  let s1 = 0;
  let s2 = 0;
  const a = Math.round(from * RATE);
  const b = Math.round(to * RATE);
  for (let i = a; i < b; i++) {
    const s0 = (data[i] ?? 0) + 2 * Math.cos(w) * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - 2 * Math.cos(w) * s1 * s2) / (b - a);
}

/** Largest step between neighbouring samples in a window. */
function maxStep(data: Float32Array, from: number, to: number): number {
  let max = 0;
  for (let i = Math.round(from * RATE) + 1; i < Math.round(to * RATE); i++) {
    max = Math.max(max, Math.abs((data[i] ?? 0) - (data[i - 1] ?? 0)));
  }
  return max;
}

/** Largest step of a clean sine of `frequency` with the RMS the output has in a window. */
function sineStep(data: Float32Array, frequency: number, from: number, to: number): number {
  return rms(data, from, to) * Math.SQRT2 * ((2 * Math.PI * frequency) / RATE);
}

/** High-frequency share: RMS of the first difference over the RMS (level-independent). */
function brightness(data: Float32Array, from: number, to: number): number {
  let diff = 0;
  let sum = 0;
  for (let i = Math.round(from * RATE) + 1; i < Math.round(to * RATE); i++) {
    diff += ((data[i] ?? 0) - (data[i - 1] ?? 0)) ** 2;
    sum += (data[i] ?? 0) ** 2;
  }
  return Math.sqrt(diff / Math.max(1e-12, sum));
}

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const C4 = 261.63;

describe('Sampler playback offline', () => {
  it('loads a WAV generated in code through the real decoder and plays it at the root', async () => {
    const samples = new Float32Array(22050);
    for (let i = 0; i < samples.length; i++)
      samples[i] = 0.6 * Math.sin((2 * Math.PI * 440 * i) / 44100);
    const decoder = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: RATE });
    const sound = new SoundSettings();
    const bank = new SamplerBank({ decode: (b) => decoder.decodeAudioData(b), create });
    const samplers = new Samplers(sound, bank);
    await samplers.load(ID, new File([wav(samples, 44100)], 'a4.wav', { type: 'audio/wav' }));
    const patch = samplers.patch(ID);
    // Decoded at the sampler's fixed rate; the detected root is A4.
    expect(patch.sample?.sampleRate).toBe(RATE);
    expect(patch.sample?.frames).toBeGreaterThan(RATE * 0.49);
    expect(patch.root).toBe(69);
    expect(samplers.state(ID)).toBe('ready');
  });

  it('key tracking: the pitch ratio follows keytrack (100 %, 50 %, 0 %)', async () => {
    const measured: number[] = [];
    for (const keytrack of [100, 50, 0]) {
      const r = await rig(fixture(RATE, sine(C4)), 0.5);
      r.edit({ root: 60, keytrack });
      play(r, 72, 0.01, 0.4);
      measured.push(pitch(await render(r), 0.05, 0.4));
    }
    expect(measured[0]).toBeCloseTo(C4 * 2, 0);
    expect(measured[1]).toBeCloseTo(C4 * Math.SQRT2, 0);
    expect(measured[2]).toBeCloseTo(C4, 0);
  });

  it('tune shifts by cents on top of the root', async () => {
    const r = await rig(fixture(RATE, sine(C4)), 0.5);
    r.edit({ tune: 50 });
    play(r, 60, 0.01, 0.4);
    expect(pitch(await render(r), 0.05, 0.4)).toBeCloseTo(C4 * 2 ** (50 / 1200), 0);
  });

  it('loops without a click at the loop point with the crossfade, and clicks without it', async () => {
    const source = fixture(RATE, sine(C4));
    const data = source.getChannelData(0);
    // Loop end where the jump to the loop start is largest (phases far apart).
    const loopStart = 12000;
    let loopEnd = loopStart + 5000;
    for (let e = loopStart + 5000; e < loopStart + 5200; e++) {
      const jump = (k: number) => Math.abs((data[k - 1] ?? 0) - (data[loopStart] ?? 0));
      if (jump(e) > jump(loopEnd)) loopEnd = e;
    }
    const steps: number[] = [];
    for (const crossfade of [480, 0]) {
      const r = await rig(source, 1.2);
      r.edit({
        loop: { enabled: true, start: loopStart, end: loopEnd, crossfade, mode: 'forward' },
      });
      play(r, 60, 0.01, 1.1);
      const out = await render(r);
      // Several passes over the loop point happen between 0.4 s and 1.1 s; compared with the
      // largest step of a clean sine at the output's level.
      steps.push(maxStep(out, 0.3, 1.1) / sineStep(out, C4, 0.3, 0.35));
      expect(rms(out, 0.9, 1.1)).toBeGreaterThan(0.02);
    }
    expect(steps[0]).toBeLessThan(1.3);
    expect(steps[1]).toBeGreaterThan(5);
  });

  it('ping-pong loops back and forth without a jump', async () => {
    const r = await rig(fixture(RATE, sine(C4)), 1);
    r.edit({ loop: { enabled: true, start: 10000, end: 14321, crossfade: 0, mode: 'pingpong' } });
    play(r, 60, 0.01, 0.95);
    const out = await render(r);
    // The turnarounds are kinks (the slope flips), not jumps: no step near the 5× of a cut.
    expect(maxStep(out, 0.3, 0.95) / sineStep(out, C4, 0.3, 0.35)).toBeLessThan(2);
    expect(rms(out, 0.6, 0.9)).toBeGreaterThan(0.02);
  });

  it('a sustain loop plays on after the release: the rest of the sample under the fade', async () => {
    // C4 for the first 30 000 frames, then G4 (phase-continuous): the G4 part lies after the loop.
    let phase = 0;
    const source = fixture(RATE, (i) => {
      const value = 0.5 * Math.sin(phase);
      phase += (2 * Math.PI * (i < 30000 ? C4 : 392)) / RATE;
      return value;
    });
    const r = await rig(source, 2.2);
    r.edit({
      loop: { enabled: true, start: 8000, end: 20000, crossfade: 480, mode: 'forward' },
      envelope: { attack: 0.002, decay: 0.3, sustain: 1, release: 1.5 },
    });
    const releaseAt = 0.01 + 1;
    play(r, 60, 0.01, 1);
    const out = await render(r);
    // While held only the loop (C4) sounds; after the release the tail reaches G4.
    expect(tone(out, 392, 0.4, 1.0)).toBeLessThan(0.002);
    const prepared = r.samplers.playable(ID)?.prepared;
    const loop = prepared?.loop;
    if (loop == null) throw new Error('no loop');
    const handoff = handoffTime(0.01, 1, loop, releaseAt);
    expect(handoff).toBeGreaterThanOrEqual(releaseAt);
    const g4 = handoff + (30000 - loop.handoff * RATE) / RATE;
    expect(tone(out, 392, g4 + 0.02, g4 + 0.12)).toBeGreaterThan(0.01);
    // The hand-off itself is continuous: no step larger than the sine's own.
    expect(
      maxStep(out, handoff - 0.01, handoff + 0.01) / sineStep(out, C4, handoff - 0.03, handoff),
    ).toBeLessThan(1.3);
  });

  it('envelope: attack ramp, decay to the sustain level, release fade (as modelled)', async () => {
    // Dry (no master chain, whose compressor would shape the level): the voice and the synth's
    // release steps (anchor at the envelope level, fade with τ = release / 4).
    const r = await rig(
      fixture(RATE, () => 0.5),
      1.2,
    );
    const envelope = { attack: 0.1, decay: 0.15, sustain: 0.5, release: 0.2 };
    r.edit({ envelope });
    const ready = r.samplers.playable(ID);
    if (ready === null) throw new Error('not playable');
    const voice = buildSamplerVoice(
      r.ctx,
      ready.prepared,
      ready.patch,
      60,
      127,
      0,
      r.ctx.destination,
    );
    const held = 0.6;
    const g = voice.gain.gain;
    g.cancelScheduledValues(held);
    g.setValueAtTime(voice.levelAt(held), held);
    g.setTargetAtTime(0, held, envelope.release / 4);
    voice.releaseAt(held, envelope.release, held + envelope.release * 1.2);
    const out = await render(r);
    const peak = SAMPLER_LEVEL * CENTRE;
    for (const t of [0.05, 0.1, 0.2, 0.4, 0.55, 0.65, 0.75]) {
      const at = Math.round(t * RATE);
      expect(out[at] ?? 0).toBeCloseTo(peak * envelopeAt(envelope, t, 0.6), 2);
    }
    expect(Math.abs(out[Math.round(1.1 * RATE)] ?? 1)).toBeLessThan(1e-4);
  });

  it('velocity scales the level by velocityToGain', async () => {
    const levels: number[] = [];
    for (const [amount, velocity] of [
      [100, 127],
      [100, 64],
      [0, 64],
    ] as const) {
      const r = await rig(fixture(RATE, sine(C4)), 0.4);
      r.edit({ velocityToGain: amount });
      play(r, 60, 0.01, 0.35, velocity);
      levels.push(rms(await render(r), 0.1, 0.3));
    }
    expect((levels[1] ?? 0) / (levels[0] ?? 1)).toBeCloseTo(64 / 127, 2);
    expect((levels[2] ?? 0) / (levels[0] ?? 1)).toBeCloseTo(1, 2);
  });

  it('filter env amount: the cutoff follows the envelope (bright early, dark late)', async () => {
    const random = seeded(7);
    const noise = fixture(RATE, () => random() * 2 - 1);
    const ratios: number[] = [];
    for (const envAmount of [100, 0]) {
      const r = await rig(noise, 0.8);
      r.edit({
        envelope: { attack: 0.002, decay: 0.1, sustain: 0.2, release: 0.05 },
        filter: { type: 'lowpass', cutoff: 300, resonance: 0, envAmount },
      });
      play(r, 60, 0.01, 0.75);
      const out = await render(r);
      ratios.push(brightness(out, 0.015, 0.04) / brightness(out, 0.5, 0.7));
    }
    expect(ratios[0]).toBeGreaterThan(3);
    expect(ratios[1]).toBeCloseTo(1, 0);
  });

  it('reverse plays the trimmed region backwards', async () => {
    // A sine whose amplitude rises over the sample: forwards it swells, backwards it fades.
    const frames = RATE / 2;
    const swell = fixture(frames, (i) => (i / frames) * sine(C4, 1)(i));
    const levels: number[][] = [];
    for (const reverse of [false, true]) {
      const r = await rig(swell, 0.6);
      r.edit({ reverse });
      play(r, 60, 0.01, 0.55);
      const out = await render(r);
      levels.push([rms(out, 0.02, 0.1), rms(out, 0.4, 0.48)]);
    }
    const [forward, backward] = levels;
    expect((forward?.[1] ?? 0) / (forward?.[0] ?? 1)).toBeGreaterThan(3);
    expect((backward?.[0] ?? 0) / (backward?.[1] ?? 1)).toBeGreaterThan(3);
  });

  it('a trimmed region plays only between start and end', async () => {
    const r = await rig(fixture(RATE, sine(C4)), 0.6);
    r.edit({ start: 0, end: RATE / 10 });
    play(r, 60, 0.01, 0.5);
    const out = await render(r);
    expect(rms(out, 0.03, 0.09)).toBeGreaterThan(0.05);
    expect(rms(out, 0.15, 0.5)).toBeLessThan(1e-4);
  });

  it(`steals the oldest sampler voice beyond ${SAMPLER_VOICES}`, async () => {
    const r = await rig(fixture(RATE, sine(C4)), 0.8);
    // G4 first, then 32 quiet C4 voices: the G4 must go, the C4s stay.
    play(r, 67, 0, 0.7, 100);
    for (let i = 0; i < SAMPLER_VOICES; i++) play(r, 60, 0.2 + i * 0.001, 0.5, 4);
    const out = await render(r);
    const g4 = C4 * 2 ** (7 / 12);
    const before = tone(out, g4, 0.05, 0.19);
    expect(before).toBeGreaterThan(0.01);
    expect(tone(out, g4, 0.3, 0.6) / before).toBeLessThan(0.02);
    expect(tone(out, C4, 0.3, 0.6)).toBeGreaterThan(0.002);
  });
});
