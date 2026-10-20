/**
 * SoundFont instruments against the fake context (docs/specs/soundfonts-v1.md): the note grid
 * and nearest-sample choice, the loader (states, Cache API, decoding after `attach`, errors),
 * the sample voice graph and the synth (stand-in until loaded, routing, release fade, budget).
 */
import { MELODY_TRACK_ID } from '@crokychords/core';
import { describe, expect, it } from 'vitest';
import { noteGrid, noteName } from '../../../tools/soundfonts/lib.mjs';
import { ROOM } from '../src/audio/graph';
import {
  INSTRUMENTS,
  SOUNDFONTS,
  gmProgram,
  instrumentName,
  isInstrumentId,
  presetInstrument,
  soundfont,
  standInOf,
} from '../src/audio/instruments';
import { SoundSettings } from '../src/audio/sound';
import type {
  SampleBuffer,
  SampleCache,
  SampleCacheStorage,
  SampleSet,
  SampleSource,
  SampleState,
} from '../src/audio/soundfont';
import {
  SAMPLE_GRID,
  SAMPLE_RELEASE,
  SAMPLE_ROOM,
  SAMPLE_VOICES,
  SOUNDFONT_CACHE,
  SOUNDFONT_VERSION,
  SoundfontBank,
  buildSampleVoice,
  nearestSample,
  sampleAmplitude,
  sampleGain,
  sampleNoteName,
  sampleNotes,
  sampleUrl,
} from '../src/audio/soundfont';
import { STEAL_RELEASE, Synth } from '../src/audio/synth';
import { FakeBufferSource, FakeContext, FakeGain, FakeOscillator } from './fakeAudio';

const PIANO = SOUNDFONTS[0];
if (PIANO === undefined) throw new Error('no SoundFont instruments');

/** A decoded sample of `seconds`. */
function buffer(seconds = 3): SampleBuffer {
  return { duration: seconds, getChannelData: () => new Float32Array(1) };
}

function sampleSet(notes: readonly number[], seconds = 3): SampleSet {
  return { notes, buffers: new Map(notes.map((n) => [n, buffer(seconds)])) };
}

/** A sample source with fixed sets; records load requests. */
function source(sets: Partial<Record<string, SampleSet>>): SampleSource & { loads: string[] } {
  const loads: string[] = [];
  return {
    loads,
    samples: (id) => sets[id] ?? null,
    load: (id) => loads.push(id),
  };
}

/** A fetch that serves every URL with its own text as the body, recording the URLs. */
function fakeFetch(fail: (url: string) => boolean = () => false) {
  const urls: string[] = [];
  const fn = (url: string): Promise<Response> => {
    urls.push(url);
    return Promise.resolve(
      fail(url) ? new Response('', { status: 404 }) : new Response(new TextEncoder().encode(url)),
    );
  };
  return { fn, urls };
}

function memoryCaches(): SampleCacheStorage & { stores: Map<string, Map<string, Response>> } {
  const stores = new Map<string, Map<string, Response>>([
    ['crokychords-soundfonts-old', new Map()],
  ]);
  return {
    stores,
    open(name) {
      let store = stores.get(name);
      if (store === undefined) {
        store = new Map();
        stores.set(name, store);
      }
      const s = store;
      const cache: SampleCache = {
        match: (url) => Promise.resolve(s.get(url)?.clone()),
        put: (url, response) => {
          s.set(url, response);
          return Promise.resolve();
        },
      };
      return Promise.resolve(cache);
    },
    keys: () => Promise.resolve([...stores.keys()]),
    delete: (name) => Promise.resolve(stores.delete(name)),
  };
}

const decodeText = (bytes: ArrayBuffer): Promise<SampleBuffer> => {
  const text = new TextDecoder().decode(bytes);
  return Promise.resolve({ duration: text.length, getChannelData: () => new Float32Array(1) });
};

describe('catalogue', () => {
  it('lists the fifteen v1 instruments with GM programs and synth stand-ins', () => {
    expect(SOUNDFONTS.map((s) => s.name)).toEqual([
      'Acoustic Grand Piano',
      'Bright Acoustic Piano',
      'Electric Piano 1',
      'Harpsichord',
      'Vibraphone',
      'Church Organ',
      'Acoustic Guitar (nylon)',
      'Acoustic Bass',
      'Electric Bass (finger)',
      'Synth Bass 1',
      'Pizzicato Strings',
      'String Ensemble 1',
      'Choir Aahs',
      'Clarinet',
      'Flute',
    ]);
    expect(new Set(SOUNDFONTS.map((s) => s.program)).size).toBe(15);
    expect(gmProgram('flute')).toBe(73);
    expect(gmProgram('pad')).toBe(89);
    expect(standInOf('acoustic_bass')).toBe('bass');
    expect(standInOf('choir_aahs')).toBe('pad');
    expect(standInOf('lead')).toBe('lead');
    expect(instrumentName('harpsichord')).toBe('Harpsichord');
    expect(instrumentName('piano')).toBe(INSTRUMENTS.piano.name);
    expect(isInstrumentId('flute')).toBe(true);
    expect(isInstrumentId('theremin')).toBe(false);
    // A SoundFont's synth recipe is its stand-in with the preset's tuning.
    expect(presetInstrument('band', 'acoustic_grand_piano')).toBe(
      presetInstrument('band', 'piano'),
    );
    expect(presetInstrument('band', 'acoustic_grand_piano').brightness).toBe(0.8);
  });
});

describe('notes and URLs', () => {
  it('names notes like the MIDI.js soundfonts (and like the fetch script)', () => {
    for (let n = 0; n <= 127; n++) expect(sampleNoteName(n)).toBe(noteName(n));
    expect(sampleNoteName(60)).toBe('C4');
    expect(sampleNoteName(21)).toBe('A0');
    expect(sampleNoteName(70)).toBe('Bb4');
  });

  it('ships every third semitone from A0, up to the instrument top', () => {
    const all = sampleNotes(108);
    expect(all).toHaveLength(30);
    expect(all.slice(0, 5)).toEqual([21, 24, 27, 30, 33]);
    expect(all.at(-1)).toBe(108);
    expect(all.filter((n) => n % 12 === 0)).toHaveLength(8); // every C
    expect(sampleNotes(96).at(-1)).toBe(96);
    expect(sampleNotes(84)).toHaveLength(22);
    expect(sampleNotes(108)).toEqual(noteGrid(SAMPLE_GRID, 108));
  });

  it('plays the nearest sample, ties to the lower one, tuned by playbackRate', () => {
    const notes = sampleNotes(96);
    expect(nearestSample(60, notes)).toEqual({ sample: 60, rate: 1 });
    expect(nearestSample(61, notes).sample).toBe(60);
    expect(nearestSample(61, notes).rate).toBeCloseTo(2 ** (1 / 12));
    expect(nearestSample(62, notes).sample).toBe(63);
    expect(nearestSample(62, notes).rate).toBeCloseTo(2 ** (-1 / 12));
    // Above the top: the top sample, pitched up; below A0: A0 pitched down.
    expect(nearestSample(100, notes)).toEqual({ sample: 96, rate: 2 ** (4 / 12) });
    expect(nearestSample(12, notes).sample).toBe(21);
    expect(() => nearestSample(60, [])).toThrow(RangeError);
  });

  it('versions every sample URL', () => {
    expect(sampleUrl('/soundfonts/', 'flute', 63)).toBe(
      `/soundfonts/flute/Eb4.ogg?v=${SOUNDFONT_VERSION}`,
    );
    expect(SOUNDFONT_CACHE).toBe(`crokychords-soundfonts-${SOUNDFONT_VERSION}`);
  });

  it('scales the gain with velocity and bounds the amplitude by the loudest sample', () => {
    expect(sampleGain(PIANO, 127)).toBeCloseTo(PIANO.gain);
    expect(sampleGain(PIANO, 64)).toBeCloseTo((PIANO.gain * 64) / 127);
    expect(sampleGain(PIANO, 300)).toBeCloseTo(PIANO.gain);
    expect(sampleAmplitude(PIANO, 127)).toBeCloseTo(
      PIANO.gain * PIANO.peak * (1 + ROOM.maxWet * SAMPLE_ROOM),
    );
  });
});

describe('SoundfontBank', () => {
  const notes = (): readonly number[] => [60, 63, 66];

  it('fetches every note, waits for a decoder, then decodes', async () => {
    const fetch = fakeFetch();
    const bank = new SoundfontBank({ fetch: fetch.fn, base: '/sf/', notes });
    const states: SampleState[] = [];
    bank.subscribe((id, state) => {
      if (id === 'flute') states.push(state);
    });
    expect(bank.state('flute')).toBe('idle');
    expect(await bank.ensure('flute')).toBe('fetched');
    expect(fetch.urls).toEqual([60, 63, 66].map((n) => sampleUrl('/sf/', 'flute', n)));
    expect(bank.samples('flute')).toBeNull();
    await bank.attach(decodeText);
    expect(bank.state('flute')).toBe('ready');
    expect(states).toEqual(['loading', 'fetched', 'loading', 'ready']);
    const set = bank.samples('flute');
    expect(set?.notes).toEqual([60, 63, 66]);
    expect(set?.buffers.get(63)?.duration).toBe(sampleUrl('/sf/', 'flute', 63).length);
    // Loaded once: asking again fetches nothing.
    bank.load('flute');
    expect(await bank.ensure('flute')).toBe('ready');
    expect(fetch.urls).toHaveLength(3);
  });

  it('decodes at once when the decoder is already there; concurrent loads share one fetch', async () => {
    const fetch = fakeFetch();
    const bank = new SoundfontBank({ fetch: fetch.fn, notes });
    await bank.attach(decodeText);
    const [a, b] = await Promise.all([bank.ensure('harpsichord'), bank.ensure('harpsichord')]);
    expect([a, b]).toEqual(['ready', 'ready']);
    expect(fetch.urls).toHaveLength(3);
    expect(fetch.urls[0]).toBe(sampleUrl('soundfonts/', 'harpsichord', 60));
  });

  it('defaults to the catalogue notes of the instrument', async () => {
    const fetch = fakeFetch();
    const bank = new SoundfontBank({ fetch: fetch.fn });
    await bank.ensure('choir_aahs');
    expect(fetch.urls).toHaveLength(sampleNotes(96).length);
  });

  it('serves a second load from the Cache API and drops older caches', async () => {
    const caches = memoryCaches();
    const first = fakeFetch();
    await new SoundfontBank({ fetch: first.fn, caches, notes }).ensure('flute');
    expect(first.urls).toHaveLength(3);
    expect([...caches.stores.keys()]).toEqual([SOUNDFONT_CACHE]);
    const second = fakeFetch();
    const bank = new SoundfontBank({ fetch: second.fn, caches, notes });
    await bank.attach(decodeText);
    expect(await bank.ensure('flute')).toBe('ready');
    expect(second.urls).toEqual([]);
  });

  it('marks a failed load and retries it on the next request', async () => {
    let broken = true;
    const fetch = fakeFetch(() => broken);
    const bank = new SoundfontBank({ fetch: fetch.fn, notes });
    expect(await bank.ensure('flute')).toBe('error');
    expect(bank.samples('flute')).toBeNull();
    broken = false;
    expect(await bank.ensure('flute')).toBe('fetched');
    const failing = new SoundfontBank({ fetch: fakeFetch().fn, notes });
    await failing.attach(() => Promise.reject(new Error('not audio')));
    expect(await failing.ensure('flute')).toBe('error');
  });

  it('keeps working when the Cache API throws', async () => {
    const caches: SampleCacheStorage = {
      open: () => Promise.reject(new Error('insecure')),
      keys: () => Promise.resolve([]),
      delete: () => Promise.resolve(false),
    };
    const bank = new SoundfontBank({ fetch: fakeFetch().fn, caches, notes });
    expect(await bank.ensure('flute')).toBe('fetched');
  });
});

describe('sample voice (fake context)', () => {
  it('buffer source → envelope gain → out, a room send, tuned to the note', () => {
    const ctx = new FakeContext();
    const out = ctx.createGain();
    const room = ctx.createGain();
    const set = sampleSet([60, 63]);
    const voice = buildSampleVoice(ctx, PIANO, set, 61, 127, 1, out, room);
    const [src] = ctx.of(FakeBufferSource);
    if (src === undefined) throw new Error('no source');
    expect(src.buffer).toBe(set.buffers.get(60));
    expect(src.playbackRate.value).toBeCloseTo(2 ** (1 / 12));
    expect(src.starts).toEqual([1]);
    expect(src.outputs[0]).toBe(voice.gain);
    expect(voice.gain).toBeInstanceOf(FakeGain);
    if (!(voice.gain instanceof FakeGain)) throw new Error('not a fake gain');
    expect(voice.gain.outputs[0]).toBe(out);
    const send = voice.gain.outputs[1];
    expect(send).toBeInstanceOf(FakeGain);
    if (!(send instanceof FakeGain)) throw new Error('no send');
    expect(send.gain.value).toBeCloseTo(ROOM.maxWet * SAMPLE_ROOM);
    expect(send.outputs[0]).toBe(room);
    expect(voice.gain.gain.calls).toEqual([
      { method: 'set', value: 0, time: 1 },
      { method: 'linear', value: sampleGain(PIANO, 127), time: 1.002 },
    ]);
    expect(voice.release).toBe(SAMPLE_RELEASE);
    expect(voice.length).toBeCloseTo(3 / 2 ** (1 / 12));
  });
});

describe('Synth with SoundFont instruments (fake context)', () => {
  const settings = (): SoundSettings => new SoundSettings();

  function synthWith(samples: SampleSource, sound = settings()) {
    const ctx = new FakeContext();
    const synth = new Synth(ctx, () => sound.preset, undefined, {
      voice: (track, role) => sound.voice(track, role),
      samples,
    });
    return { ctx, synth, sound };
  }

  it('plays the stand-in and asks for the samples until they are loaded', () => {
    const samples = source({});
    const { ctx, synth } = synthWith(samples);
    synth.playNote(60, 0, 1, { role: 'chords', track: 't1' });
    expect(samples.loads).toEqual(['acoustic_grand_piano']);
    expect(
      ctx.of(FakeBufferSource).filter((s) => s.buffer !== null && s.starts.length > 0),
    ).toHaveLength(1); // the piano stand-in's hammer noise only
    expect(ctx.of(FakeOscillator).length).toBeGreaterThan(0);
  });

  it('plays the samples once loaded, through the track bus and the master chain', () => {
    const samples = source({ acoustic_grand_piano: sampleSet(sampleNotes(108)) });
    const { ctx, synth } = synthWith(samples);
    synth.playNote(64, 0, 1, { role: 'chords', track: 't1', velocity: 100 });
    expect(samples.loads).toEqual([]);
    expect(ctx.of(FakeOscillator)).toHaveLength(0);
    const [src] = ctx.of(FakeBufferSource);
    if (src === undefined) throw new Error('no sample');
    expect(src.playbackRate.value).toBeCloseTo(2 ** (1 / 12)); // E4 from the Eb4 sample
    expect(ctx.route(src)).toEqual([
      'buffer-source',
      'gain', // envelope
      'gain', // track bus
      'gain', // mix
      'compressor',
      'gain', // master
      'gain', // volume
      'destination',
    ]);
    expect(synth.voiceCount).toBe(1);
  });

  it('fades out at the note end and stops shortly after', () => {
    const samples = source({ acoustic_grand_piano: sampleSet(sampleNotes(108)) });
    const { ctx, synth } = synthWith(samples);
    synth.playNote(60, 1, 0.5, { role: 'chords', track: 't1' });
    const [src] = ctx.of(FakeBufferSource);
    const env = ctx.of(FakeGain).find((g) => src?.outputs[0] === g);
    expect(env?.gain.calls.at(-1)).toEqual({
      method: 'target',
      value: 0,
      time: 1.5,
      constant: SAMPLE_RELEASE / 4,
    });
    expect(src?.stops.at(-1)).toBeCloseTo(1.5 + SAMPLE_RELEASE * 2);
  });

  it('a sample shorter than its note ends on its own', () => {
    const samples = source({ acoustic_grand_piano: sampleSet([60], 0.5) });
    const { ctx, synth } = synthWith(samples);
    synth.playNote(60, 0, 4, { role: 'chords', track: 't1' });
    ctx.currentTime = 1;
    expect(synth.voiceCount).toBe(0);
  });

  it(`keeps at most ${SAMPLE_VOICES} sample voices, stealing the oldest`, () => {
    const samples = source({ acoustic_grand_piano: sampleSet(sampleNotes(108)) });
    const { ctx, synth } = synthWith(samples);
    for (let i = 0; i < SAMPLE_VOICES + 2; i++) {
      synth.playNote(40 + i, i * 0.01, 10, { role: 'chords', track: 't1' });
    }
    const envelopes = ctx.of(FakeBufferSource).map((src) => src.outputs[0]);
    const stolen = envelopes.filter(
      (g) => g instanceof FakeGain && g.gain.calls.some((c) => c.constant === STEAL_RELEASE / 4),
    );
    expect(stolen).toEqual(envelopes.slice(0, 2));
    expect(synth.voiceCount).toBe(SAMPLE_VOICES + 2); // stolen voices are still fading out
    ctx.currentTime = 1;
    expect(synth.voiceCount).toBe(SAMPLE_VOICES);
  });

  it('uses the per-track choice, and the melody octave shift and velocity', () => {
    const samples = source({ flute: sampleSet(sampleNotes(108)) });
    const sound = settings();
    sound.setInstrument(MELODY_TRACK_ID, null, 'flute');
    sound.setMelodyOctave(1);
    sound.setMelodyVelocity(64);
    const { ctx, synth } = synthWith(samples, sound);
    synth.playNote(60, 0, 1, { track: MELODY_TRACK_ID, velocity: 100 });
    const [src] = ctx.of(FakeBufferSource);
    expect(src?.buffer).toBe(samples.samples('flute')?.buffers.get(72));
    const env = src?.outputs[0];
    if (!(env instanceof FakeGain)) throw new Error('no envelope');
    const flute = soundfont('flute');
    if (flute === undefined) throw new Error('no flute');
    expect(env.gain.max).toBeCloseTo(sampleGain(flute, 64));
    // A synth choice plays the synth, with the preset's tuning.
    sound.setInstrument('t2', 'bass', 'pad');
    synth.playNote(40, 0, 1, { role: 'bass', track: 't2' });
    expect(ctx.of(FakeOscillator).map((o) => o.type)).toEqual(
      INSTRUMENTS.pad.oscillators.map((o) => o.type),
    );
    expect(synth.leadInstrument()).toBe(INSTRUMENTS.lead); // the flute's stand-in
  });
});
