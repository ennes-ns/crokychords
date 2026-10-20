// @vitest-environment node
/**
 * Renders the piano offline with a real OfflineAudioContext (node-web-audio-api, nothing is
 * played) and checks the sound by energy ratios, not exact samples: the listed inharmonic
 * partials, the pitch tilt, the two-stage decay, velocity, pan and the voice budget.
 *
 * With `PIANO_WAV=<path>` it also writes I–V–vi–IV (chords and bass on the piano) as a 16-bit
 * stereo WAV for listening, e.g.
 * `PIANO_WAV=/tmp/piano.wav pnpm --filter @crokychords/web exec vitest run test/pianoOffline.test.ts`.
 */
import { writeFileSync } from 'node:fs';
import { createSong, createTrack } from '@crokychords/core';
import { OfflineAudioContext } from 'node-web-audio-api';
import { describe, expect, it } from 'vitest';
import type { SynthContext } from '../src/audio/graph';
import { noiseBuffer } from '../src/audio/graph';
import type { Instrument, PianoSpec } from '../src/audio/instruments';
import { INSTRUMENTS, instrumentFor, midiToFrequency } from '../src/audio/instruments';
import { buildPianoVoice } from '../src/audio/piano';
import { planSong } from '../src/audio/scheduler';
import { Synth } from '../src/audio/synth';

const RATE = 48000;
const PIANO = INSTRUMENTS.piano;
const SPEC: PianoSpec = (() => {
  if (PIANO.piano === undefined) throw new Error('piano has no piano spec');
  return PIANO.piano;
})();

/**
 * The piano with its unison tuned flat. The detuned unison beats (by design), which smears the
 * fundamental over several close spectral lines and modulates short RMS windows; the spectrum
 * and envelope checks below measure the recipe without that beating.
 */
const FLAT: Instrument = {
  ...PIANO,
  oscillators: PIANO.oscillators.map((o) => ({ ...o, detune: 0 })),
};

function offline(seconds: number, channels = 1): OfflineAudioContext {
  return new OfflineAudioContext({
    numberOfChannels: channels,
    length: Math.round(seconds * RATE),
    sampleRate: RATE,
  });
}

/** One dry piano note (no room, no master bus) rendered to a mono buffer. */
async function renderNote(
  note: number,
  velocity: number,
  seconds: number,
  instrument: Instrument = FLAT,
): Promise<Float32Array> {
  const ctx = offline(seconds);
  const synthCtx: SynthContext = ctx;
  const voice = buildPianoVoice(
    synthCtx,
    instrument,
    instrument.piano ?? SPEC,
    note,
    velocity,
    0,
    ctx.destination,
    { noise: noiseBuffer(synthCtx, seeded(1)), room: null },
  );
  for (const s of voice.sources) s.stop(seconds);
  const buffer = await ctx.startRendering();
  return buffer.getChannelData(0);
}

/** Deterministic noise for repeatable renders. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Energy at `hz` over [from, to) seconds (Hann-windowed Goertzel). */
function energyAt(data: Float32Array, hz: number, from: number, to: number): number {
  const a = Math.round(from * RATE);
  const n = Math.round((to - from) * RATE);
  const w = (2 * Math.PI * hz) / RATE;
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const x = (data[a + i] ?? 0) * win;
    re += x * Math.cos(w * i);
    im -= x * Math.sin(w * i);
  }
  return (re * re + im * im) / n;
}

function rms(data: Float32Array, from: number, to: number): number {
  const a = Math.round(from * RATE);
  const b = Math.round(to * RATE);
  let sum = 0;
  for (let i = a; i < b; i++) sum += (data[i] ?? 0) ** 2;
  return Math.sqrt(sum / Math.max(1, b - a));
}

/** Energy of the top partial (5.08, the first the lowpass reaches) relative to the fundamental. */
function brightness(data: Float32Array, f: number): number {
  return energyAt(data, 5.08 * f, 0.02, 0.5) / energyAt(data, f, 0.02, 0.5);
}

const db = (ratio: number): number => 20 * Math.log10(ratio);

describe('piano v2, rendered offline', () => {
  it('has the inharmonic partials 2.0, 3.01, 4.03, 5.08, falling with partial number', async () => {
    const note = 57; // A3, 220 Hz
    const f = midiToFrequency(note);
    const data = await renderNote(note, 110, 1.6);
    const at = (ratio: number): number => energyAt(data, f * ratio, 0.05, 1.55);
    const partials = SPEC.partials.map((p) => at(p.ratio));
    // Each listed partial stands far above the spectrum between partials ...
    for (const [i, p] of SPEC.partials.entries()) {
      const energy = partials[i] ?? 0;
      expect(energy, `partial ${p.ratio}`).toBeGreaterThan(50 * at(p.ratio + 0.5));
    }
    // ... sits on the stretched ratio rather than the harmonic one ...
    expect(at(4.03)).toBeGreaterThan(10 * at(4));
    expect(at(5.08)).toBeGreaterThan(10 * at(5));
    // ... and the levels fall with the partial number, below the fundamental.
    const fundamental = at(1);
    expect(partials[0]).toBeLessThan(fundamental);
    for (let i = 1; i < partials.length; i++) {
      expect(partials[i]).toBeLessThan(partials[i - 1] ?? 0);
    }
  });

  it('is brighter low and duller high (partial 2 relative to the fundamental)', async () => {
    const ratio = async (note: number): Promise<number> => {
      const f = midiToFrequency(note);
      const data = await renderNote(note, 110, 0.8);
      return energyAt(data, 2 * f, 0.05, 0.75) / energyAt(data, f, 0.05, 0.75);
    };
    expect(await ratio(40)).toBeGreaterThan(4 * (await ratio(84)));
  });

  it('decays in two stages: a fast first drop, then a long key-tracked tail', async () => {
    const data = await renderNote(60, 110, 4);
    const early = rms(data, 0.01, 0.03);
    const knee = rms(data, 0.29, 0.31);
    // dB per second in the first stage and in the tail.
    const fast = db(early / knee) / 0.28;
    const slow = db(rms(data, 0.6, 0.7) / rms(data, 1.6, 1.7)) / 1.0;
    expect(db(early / knee)).toBeGreaterThan(6);
    expect(fast).toBeGreaterThan(3 * slow);
    expect(slow).toBeGreaterThan(0);
    // Still clearly audible after two seconds: the tail is long.
    expect(rms(data, 2, 2.1)).toBeGreaterThan(early / 100);

    const tailDrop = async (note: number): Promise<number> => {
      const d = await renderNote(note, 110, 2.2);
      return db(rms(d, 0.5, 0.6) / rms(d, 2.0, 2.1));
    };
    // Low notes ring longer than high notes.
    expect(await tailDrop(36)).toBeLessThan(await tailDrop(84));
  });

  it('velocity scales level and brightness', async () => {
    const f = midiToFrequency(60);
    const soft = await renderNote(60, 40, 0.6);
    const hard = await renderNote(60, 120, 0.6);
    expect(rms(hard, 0.01, 0.3)).toBeGreaterThan(2 * rms(soft, 0.01, 0.3));
    expect(brightness(hard, f)).toBeGreaterThan(1.5 * brightness(soft, f));
  });

  it('brightness darkens the band piano', async () => {
    const f = midiToFrequency(60);
    const band = instrumentFor('band', 'chords');
    expect(band.brightness).toBeLessThan(1);
    const flatBand = { ...band, oscillators: FLAT.oscillators };
    expect(brightness(await renderNote(60, 110, 0.6, flatBand), f)).toBeLessThan(
      brightness(await renderNote(60, 110, 0.6), f),
    );
  });

  it('pans low notes left and high notes right, with a short room behind them', async () => {
    const side = async (note: number): Promise<number> => {
      const ctx = offline(1, 2);
      const synth = new Synth(ctx, () => 'piano');
      synth.playNote(note, 0, 0.3, { role: 'chords', velocity: 100 });
      const buffer = await ctx.startRendering();
      return rms(buffer.getChannelData(1), 0, 1) / rms(buffer.getChannelData(0), 0, 1);
    };
    expect(await side(36)).toBeLessThan(0.9);
    expect(await side(84)).toBeGreaterThan(1.1);

    // After the damper (released at 0.3 s) the room still rings for a moment.
    const ctx = offline(1, 2);
    const synth = new Synth(ctx, () => 'piano');
    synth.playNote(60, 0, 0.3, { role: 'chords', velocity: 100 });
    const buffer = await ctx.startRendering();
    const left = buffer.getChannelData(0);
    const ring = rms(left, 0.5, 0.55);
    expect(ring).toBeGreaterThan(0);
    expect(ring).toBeLessThan(rms(left, 0.05, 0.25) / 10);
  });

  it('steals the oldest voice beyond 24 voices', async () => {
    const ctx = offline(0.5);
    const synth = new Synth(ctx, () => 'piano');
    for (let i = 0; i < 30; i++) synth.playNote(40 + i, i * 0.005, 5, { role: 'chords' });
    expect(synth.voiceCount).toBe(30);
    // Rendering must not fail; the stolen voices only shorten.
    const buffer = await ctx.startRendering();
    expect(rms(buffer.getChannelData(0), 0.2, 0.3)).toBeGreaterThan(0);
  });

  it.runIf(process.env.PIANO_WAV !== undefined)('writes I–V–vi–IV to PIANO_WAV', async () => {
    const song = createSong({
      tempo: 96,
      chords: ['I', 'V', 'vi', 'IV'].map((token) => ({ token, beats: 4 })),
      tracks: [
        createTrack('chords', { id: 'c', channel: 0 }),
        createTrack('bass', { id: 'b', channel: 1 }),
      ],
    });
    const spb = 60 / song.tempo;
    const roles = new Map((song.tracks ?? []).map((t) => [t.id, t.role]));
    const { events, total } = planSong(song);
    const seconds = total * spb + 2.5;
    const ctx = offline(seconds, 2);
    const synth = new Synth(ctx, () => 'piano');
    for (const e of events) {
      synth.playNote(e.note, 0.05 + e.start * spb, e.duration * spb, {
        role: roles.get(e.trackId) ?? 'chords',
        track: e.trackId,
        velocity: e.velocity,
      });
    }
    const buffer = await ctx.startRendering();
    writeFileSync(process.env.PIANO_WAV ?? '', wav(buffer));
  });
});

/** 16-bit PCM WAV of a rendered buffer. */
function wav(buffer: AudioBuffer): Uint8Array {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const out = new DataView(new ArrayBuffer(44 + frames * channels * 2));
  const text = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) out.setUint8(offset + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  out.setUint32(4, 36 + frames * channels * 2, true);
  text(8, 'WAVEfmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, channels, true);
  out.setUint32(24, buffer.sampleRate, true);
  out.setUint32(28, buffer.sampleRate * channels * 2, true);
  out.setUint16(32, channels * 2, true);
  out.setUint16(34, 16, true);
  text(36, 'data');
  out.setUint32(40, frames * channels * 2, true);
  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const x = Math.max(-1, Math.min(1, data[c]?.[i] ?? 0));
      out.setInt16(44 + (i * channels + c) * 2, Math.round(x * 32767), true);
    }
  }
  return new Uint8Array(out.buffer);
}
