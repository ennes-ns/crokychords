// @vitest-environment node
/**
 * SoundFont playback rendered offline with a real OfflineAudioContext (node-web-audio-api,
 * nothing is played), docs/specs/soundfonts-v1.md §6 and §10.
 *
 * The fixture instrument (`fixtures/soundfont-mini/`: C4, E♭4 and G♭4) is generated, not taken
 * from any SoundFont: 1 s sines at amplitude 0.5 with 4 ms / 10 ms fades, Ogg Vorbis, made with
 *   ffmpeg -f lavfi -i "aevalsrc=0.5*sin(2*PI*<Hz>*t):s=44100:d=1" \
 *     -af "afade=t=in:d=0.004,afade=t=out:st=0.99:d=0.01" -c:a libvorbis -q:a 0 <Note>.ogg
 * It is served as `acoustic_grand_piano`, so the catalogue's gain applies.
 *
 * When the fetched samples are present (`apps/web/public/soundfonts/`, CI fetches them), every
 * shipped file is decoded and checked against the catalogue. With `SOUNDFONT_WAV=<dir>` a short
 * example per preset is written to `<dir>/<preset>.wav` for listening (real samples when
 * present, stand-ins otherwise), e.g.
 * `SOUNDFONT_WAV=/tmp/sf pnpm --filter @crokychords/web exec vitest run test/soundfontOffline.test.ts`.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Degree, MelodyNote } from '@crokychords/core';
import { createSong, createTrack } from '@crokychords/core';
import { OfflineAudioContext } from 'node-web-audio-api';
import { describe, expect, it } from 'vitest';
import type { SynthContext } from '../src/audio/graph';
import type { SoundfontInstrument } from '../src/audio/instruments';
import { SOUNDFONTS, SOUND_PRESETS, drumHits, soundfont } from '../src/audio/instruments';
import { planSong } from '../src/audio/scheduler';
import { SoundSettings } from '../src/audio/sound';
import type { SampleSet } from '../src/audio/soundfont';
import {
  SAMPLE_RELEASE,
  SAMPLE_VOICES,
  SoundfontBank,
  buildSampleVoice,
  sampleGain,
  sampleNotes,
} from '../src/audio/soundfont';
import { Synth } from '../src/audio/synth';

const RATE = 44100;
const FIXTURE = fileURLToPath(new URL('fixtures/soundfont-mini/', import.meta.url));
const SHIPPED = fileURLToPath(new URL('../public/soundfonts/', import.meta.url));
const PIANO: SoundfontInstrument = (() => {
  const font = soundfont('acoustic_grand_piano');
  if (font === undefined) throw new Error('no piano');
  return font;
})();

function offline(seconds: number, channels = 1): OfflineAudioContext {
  return new OfflineAudioContext({
    numberOfChannels: channels,
    length: Math.round(seconds * RATE),
    sampleRate: RATE,
  });
}

/** Serve `<id>/<Note>.ogg?v=…` from `dir` (the fixture flattens every instrument onto it). */
function fileFetch(dir: string, flat: boolean) {
  return (url: string): Promise<Response> => {
    const path = url.replace(/\?.*$/, '').replace(/^soundfonts\//, '');
    const file = join(dir, flat ? (path.split('/').at(-1) ?? '') : path);
    if (!existsSync(file)) return Promise.resolve(new Response('', { status: 404 }));
    return Promise.resolve(new Response(readFileSync(file)));
  };
}

const decoder = offline(0.1);
const decode = (bytes: ArrayBuffer) => decoder.decodeAudioData(bytes);

/** The fixture as a loaded bank (as `acoustic_grand_piano`). */
async function fixtureBank(): Promise<SoundfontBank> {
  const bank = new SoundfontBank({ fetch: fileFetch(FIXTURE, true), notes: () => [60, 63, 66] });
  await bank.attach(decode);
  expect(await bank.ensure('acoustic_grand_piano')).toBe('ready');
  return bank;
}

async function fixtureSet(): Promise<SampleSet> {
  const set = (await fixtureBank()).samples('acoustic_grand_piano');
  if (set === null) throw new Error('fixture not loaded');
  return set;
}

/** One dry sample note (no bus, no room) into a mono buffer. */
async function renderNote(
  set: SampleSet,
  note: number,
  velocity: number,
  held: number,
  seconds = 1.2,
): Promise<Float32Array> {
  const ctx = offline(seconds);
  const synthCtx: SynthContext = ctx;
  const voice = buildSampleVoice(synthCtx, PIANO, set, note, velocity, 0.05, ctx.destination, null);
  // The synth's release: a SAMPLE_RELEASE fade from the held level at the note end.
  voice.gain.gain.cancelScheduledValues(0.05 + held);
  voice.gain.gain.setValueAtTime(sampleGain(PIANO, velocity), 0.05 + held);
  voice.gain.gain.setTargetAtTime(0, 0.05 + held, SAMPLE_RELEASE / 4);
  for (const s of voice.sources) s.stop(0.05 + held + SAMPLE_RELEASE * 2);
  const buffer = await ctx.startRendering();
  return buffer.getChannelData(0);
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

describe('SoundFont playback offline (fixture)', () => {
  it('loads and decodes the fixture through the bank', async () => {
    const set = await fixtureSet();
    expect(set.notes).toEqual([60, 63, 66]);
    expect(set.buffers.get(60)?.duration).toBeCloseTo(1, 1);
  });

  it('note on: the sample at the velocity gain; note off: silence after the fade', async () => {
    const set = await fixtureSet();
    const data = await renderNote(set, 60, 127, 0.4);
    const expected = (0.5 * sampleGain(PIANO, 127)) / Math.SQRT2;
    expect(rms(data, 0, 0.05)).toBeLessThan(1e-4); // nothing before the start
    expect(rms(data, 0.1, 0.4)).toBeCloseTo(expected, 1);
    expect(pitch(data, 0.1, 0.4)).toBeCloseTo(261.63, 0);
    expect(rms(data, 0.6, 1.2)).toBeLessThan(1e-4);
  });

  it('velocity scales the level linearly', async () => {
    const set = await fixtureSet();
    const loud = rms(await renderNote(set, 63, 127, 0.4), 0.1, 0.4);
    const soft = rms(await renderNote(set, 63, 64, 0.4), 0.1, 0.4);
    expect(soft / loud).toBeCloseTo(64 / 127, 2);
  });

  it('releases with a short fade, not a cut', async () => {
    const set = await fixtureSet();
    const data = await renderNote(set, 66, 127, 0.3);
    const end = 0.05 + 0.3;
    const held = rms(data, end - 0.1, end);
    expect(rms(data, end, end + 0.005) / held).toBeGreaterThan(0.4);
    expect(rms(data, end + 0.005, end + 0.015) / held).toBeLessThan(0.8);
    expect(rms(data, end + 0.04, end + 0.06) / held).toBeLessThan(0.1);
  });

  it('tunes a note between samples from the nearest one', async () => {
    const set = await fixtureSet();
    expect(pitch(await renderNote(set, 61, 127, 0.4), 0.1, 0.4)).toBeCloseTo(277.18, 0);
    expect(pitch(await renderNote(set, 65, 127, 0.4), 0.1, 0.4)).toBeCloseTo(349.23, 0);
  });

  it(`steals the oldest sample voice beyond ${SAMPLE_VOICES}`, async () => {
    const bank = await fixtureBank();
    const ctx = offline(0.8);
    const sound = new SoundSettings();
    const synth = new Synth(ctx, () => sound.preset, undefined, {
      voice: (track, role) => sound.voice(track, role),
      samples: bank,
    });
    // G♭4 first, then 32 quiet C4 voices: the G♭4 must go, the C4s stay.
    synth.playNote(66, 0, 0.7, { role: 'chords', track: 't', velocity: 100 });
    for (let i = 0; i < SAMPLE_VOICES; i++) {
      synth.playNote(60, 0.2 + i * 0.001, 0.5, { role: 'chords', track: 't', velocity: 4 });
    }
    const data = (await ctx.startRendering()).getChannelData(0);
    const before = tone(data, 369.99, 0.05, 0.19);
    expect(before).toBeGreaterThan(0.01);
    expect(tone(data, 369.99, 0.3, 0.6) / before).toBeLessThan(0.02);
    expect(tone(data, 261.63, 0.3, 0.6)).toBeGreaterThan(0.005);
  });

  it('plays the synth stand-in until the samples are loaded', async () => {
    const ctx = offline(0.5);
    const bank = new SoundfontBank({ fetch: fileFetch(FIXTURE, true), notes: () => [60] });
    const synth = new Synth(ctx, () => 'band', undefined, {
      voice: (_t, role) => new SoundSettings().voice('t', role),
      samples: bank,
    });
    synth.playNote(60, 0, 0.3, { role: 'chords', track: 't' });
    expect(bank.state('acoustic_grand_piano')).toBe('loading');
    const data = (await ctx.startRendering()).getChannelData(0);
    expect(rms(data, 0.05, 0.25)).toBeGreaterThan(0.01);
  });
});

describe.skipIf(!existsSync(SHIPPED))('shipped SoundFont files', () => {
  it('decode, are audible and stay at or below the catalogue peak', async () => {
    for (const font of SOUNDFONTS) {
      let peak = 0;
      for (const note of sampleNotes(font.top)) {
        const bank = new SoundfontBank({ fetch: fileFetch(SHIPPED, false), notes: () => [note] });
        await bank.attach(decode);
        expect(await bank.ensure(font.id), `${font.id} ${note}`).toBe('ready');
        const buffer = bank.samples(font.id)?.buffers.get(note);
        if (buffer === undefined) throw new Error(`${font.id} ${note} missing`);
        expect(buffer.duration).toBeGreaterThan(2);
        let notePeak = 0;
        for (let c = 0; c < 2; c++) {
          for (const x of buffer.getChannelData(c)) notePeak = Math.max(notePeak, Math.abs(x));
        }
        expect(notePeak, `${font.id} ${note} is silent`).toBeGreaterThan(0.001);
        peak = Math.max(peak, notePeak);
      }
      expect(peak, font.id).toBeLessThanOrEqual(font.peak);
      expect(peak, font.id).toBeGreaterThan(font.peak * 0.9);
    }
  }, 120_000);
});

/** A simple tune over bars 5–8 (beats 16–31), one note per beat, rests as null. */
const TUNE_DEGREES: readonly (Degree | null)[] = [
  3,
  2,
  1,
  2,
  3,
  3,
  3,
  null,
  2,
  2,
  2,
  null,
  3,
  5,
  5,
];
const TUNE: MelodyNote[] = TUNE_DEGREES.flatMap((degree, i): MelodyNote[] =>
  degree === null ? [] : [{ beat: 16 + i, length: 1, degree, octave: 1, accidental: 0 }],
);

describe.skipIf(process.env.SOUNDFONT_WAV === undefined)('example renders', () => {
  it('writes an 8-bar example per preset', async () => {
    const dir = process.env.SOUNDFONT_WAV ?? '';
    mkdirSync(dir, { recursive: true });
    const song = createSong({
      tempo: 100,
      chords: ['I', 'V', 'vi', 'IV', 'I', 'V', 'vi', 'IV'].map((token) => ({ token, beats: 4 })),
      tracks: [
        createTrack('chords', { id: 'c', channel: 0 }),
        createTrack('bass', { id: 'b', channel: 1 }),
        createTrack('arp', { id: 'a', channel: 2 }),
        createTrack('pad', { id: 'p', channel: 3, velocity: 70 }),
      ],
      melody: { channel: 4, muted: false, notes: TUNE },
    });
    const spb = 60 / song.tempo;
    const roles = new Map((song.tracks ?? []).map((t) => [t.id, t.role]));
    const { events, total } = planSong(song);
    const real = existsSync(SHIPPED);
    for (const preset of SOUND_PRESETS) {
      const ctx = offline(total * spb + 2, 2);
      const sound = new SoundSettings();
      sound.setPreset(preset.id);
      const bank = new SoundfontBank({ fetch: fileFetch(SHIPPED, false) });
      await bank.attach((bytes) => ctx.decodeAudioData(bytes));
      if (real) {
        for (const role of ['chords', 'bass', 'arp', 'pad'] as const) {
          const font = soundfont(sound.trackInstrument({ id: role, role }));
          if (font !== undefined) await bank.ensure(font.id);
        }
        const lead = soundfont(sound.melodyInstrument());
        if (lead !== undefined) await bank.ensure(lead.id);
      }
      const synth = new Synth(ctx, () => sound.preset, undefined, {
        voice: (track, role) => sound.voice(track, role),
        samples: real ? bank : null,
      });
      for (const e of events) {
        synth.playNote(e.note, 0.05 + e.start * spb, e.duration * spb, {
          role: roles.get(e.trackId) ?? 'chords',
          track: e.trackId,
          velocity: e.velocity,
        });
      }
      for (const hit of drumHits(sound.drums, song.meter.beats, 0, total)) {
        synth.playDrum(hit.drum, hit.level, 0.05 + hit.beat * spb);
      }
      const buffer = await ctx.startRendering();
      let peak = 0;
      for (let c = 0; c < 2; c++) {
        for (const x of buffer.getChannelData(c)) peak = Math.max(peak, Math.abs(x));
      }
      expect(peak, preset.id).toBeLessThan(1);
      writeFileSync(join(dir, `${preset.id}.wav`), wav(buffer));
    }
  }, 120_000);
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
