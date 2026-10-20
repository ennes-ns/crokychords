/**
 * The sampler model, its pure DSP helpers, the bank and the edit API (docs/specs/sampler-v1.md
 * §2–§6), with generated buffers and the fake audio context; nothing is played.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SamplerBuffer, SamplerPatch } from '../src/audio/sampler';
import {
  DEFAULT_CROSSFADE,
  MIN_LOOP,
  MIN_TRIM,
  SAMPLER_LEVEL,
  SAMPLER_RATE,
  SamplerBank,
  Samplers,
  buildSamplerVoice,
  clampPatch,
  cutoffAt,
  defaultPatch,
  detectPitch,
  envelopeAt,
  filterQ,
  handoffTime,
  noteCutoff,
  parsePatch,
  plainLoop,
  prepareSample,
  resonanceQ,
  samplerPeak,
  samplerRate,
  waveformPeaks,
  withSample,
} from '../src/audio/sampler';
import { SoundSettings } from '../src/audio/sound';
import { Synth } from '../src/audio/synth';
import { MAX_SAMPLER_BYTES, MemorySampleStore } from '../src/store/samples';
import { FakeBufferSource, FakeContext, FakeFilter, FakeGain, FakePanner } from './fakeAudio';

const ID = 'sampler-1';
const RATE = SAMPLER_RATE;

/** A plain in-memory buffer (what `create` makes in the app is an AudioBuffer). */
function buffer(channels: number, length: number, sampleRate = RATE): SamplerBuffer {
  const data = Array.from({ length: channels }, () => new Float32Array(length));
  return {
    numberOfChannels: channels,
    length,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: (c) => {
      const d = data[c];
      if (d === undefined) throw new RangeError(`no channel ${c}`);
      return d;
    },
  };
}

function from(values: (i: number) => number, length: number, channels = 1): SamplerBuffer {
  const b = buffer(channels, length);
  for (let c = 0; c < channels; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < length; i++) d[i] = values(i);
  }
  return b;
}

const sine =
  (hz: number, rate = RATE) =>
  (i: number) =>
    0.5 * Math.sin((2 * Math.PI * hz * i) / rate);

function info(frames: number): NonNullable<SamplerPatch['sample']> {
  return { name: 'x.wav', frames, sampleRate: RATE, channels: 1, savedAt: 't1' };
}

function loaded(frames: number, change: Partial<SamplerPatch> = {}): SamplerPatch {
  return clampPatch({ ...withSample(defaultPatch(ID), ID, info(frames), 60), ...change }, ID);
}

describe('patch model', () => {
  it('defaults: no sample, root C4, full keytrack, an open filter', () => {
    const p = defaultPatch('sampler-5');
    expect(p.name).toBe('Sampler 5');
    expect(p.sample).toBeNull();
    expect(p).toMatchObject({ root: 60, keytrack: 100, gain: 0, velocityToGain: 100 });
    expect(p.filter).toEqual({ type: 'lowpass', cutoff: 20000, resonance: 0, envAmount: 0 });
    expect(p.loop.crossfade).toBe(Math.round(DEFAULT_CROSSFADE * RATE));
  });

  it('a loaded sample: whole trim, the loop on its middle half (off)', () => {
    const p = loaded(4000);
    expect([p.start, p.end]).toEqual([0, 4000]);
    expect(p.loop).toMatchObject({ enabled: false, start: 1000, end: 3000 });
  });

  it('clampPatch keeps the trim inside the sample and the loop inside the trim', () => {
    const p = loaded(4000, { start: -5, end: 9000 });
    expect([p.start, p.end]).toEqual([0, 4000]);
    const tight = loaded(4000, { start: 3990, end: 4000 });
    expect(tight.end - tight.start).toBe(MIN_TRIM);
    const shrunk = loaded(4000, { start: 1500, end: 2500 });
    expect(shrunk.loop.start).toBeGreaterThanOrEqual(1500);
    expect(shrunk.loop.end).toBeLessThanOrEqual(2500);
    const loop = clampPatch(
      { ...loaded(4000), loop: { ...loaded(4000).loop, start: 2000, end: 2001, crossfade: 999 } },
      ID,
    ).loop;
    expect(loop.end - loop.start).toBe(MIN_LOOP);
    expect(loop.crossfade).toBe(MIN_LOOP / 2);
  });

  it('clampPatch keeps numbers in range and names short', () => {
    const p = clampPatch(
      {
        ...defaultPatch(ID),
        name: '   ',
        program: 300,
        root: -4,
        tune: 99,
        keytrack: Number.NaN,
        gain: 50,
        pan: -3,
        envelope: { attack: 0, decay: 100, sustain: 2, release: -1 },
        filter: { type: 'bandpass', cutoff: 1, resonance: 500, envAmount: -500 },
      },
      ID,
    );
    expect(p).toMatchObject({ name: 'Sampler 1', program: 127, root: 0, tune: 50, keytrack: 100 });
    expect(p).toMatchObject({ gain: 12, pan: -1 });
    expect(p.envelope).toEqual({ attack: 0.001, decay: 10, sustain: 1, release: 0.005 });
    expect(p.filter).toEqual({ type: 'bandpass', cutoff: 20, resonance: 100, envAmount: -100 });
    expect(clampPatch({ ...p, name: 'x'.repeat(40) }, ID).name).toHaveLength(24);
  });

  it('parsePatch falls back field by field and resets a trim that does not fit', () => {
    const good = loaded(4000, { name: 'Bell', root: 72, reverse: true });
    expect(parsePatch(JSON.parse(JSON.stringify(good)), ID)).toEqual(good);
    const p = parsePatch({ ...good, root: 'x', loop: { mode: 'sideways' }, filter: 3 }, ID);
    expect(p.root).toBe(60);
    expect(p.loop.mode).toBe('forward');
    expect(p.filter).toEqual(defaultPatch(ID).filter);
    expect(p.name).toBe('Bell');
    const wrong = parsePatch({ ...good, end: 99999 }, ID);
    expect([wrong.start, wrong.end]).toEqual([0, 4000]);
    expect(parsePatch({ ...good, sample: { frames: 'many' } }, ID).sample).toBeNull();
    expect(parsePatch(null, ID)).toEqual(defaultPatch(ID));
  });
});

describe('playback maths', () => {
  it('rate follows keytrack and tune', () => {
    const p = loaded(4000, { root: 60 });
    expect(samplerRate(p, 72)).toBeCloseTo(2);
    expect(samplerRate({ ...p, keytrack: 50 }, 72)).toBeCloseTo(Math.SQRT2);
    expect(samplerRate({ ...p, keytrack: 0 }, 30)).toBe(1);
    expect(samplerRate({ ...p, tune: -50 }, 60)).toBeCloseTo(2 ** (-50 / 1200));
  });

  it('peak: normalised by the sample peak, velocity by velocityToGain, gain in dB', () => {
    const p = loaded(4000);
    expect(samplerPeak(p, 127, 0.5)).toBeCloseTo(SAMPLER_LEVEL / 0.5);
    expect(samplerPeak(p, 0, 1)).toBeCloseTo(0);
    expect(samplerPeak({ ...p, velocityToGain: 0 }, 1, 1)).toBeCloseTo(SAMPLER_LEVEL);
    expect(samplerPeak({ ...p, gain: -6 }, 127, 1)).toBeCloseTo(SAMPLER_LEVEL * 10 ** (-6 / 20));
  });

  it('filter: resonance to Q (dB for low/highpass), velocity and envelope move the cutoff', () => {
    expect(resonanceQ(0)).toBeCloseTo(0.707);
    expect(resonanceQ(100)).toBeCloseTo(20);
    const p = loaded(4000);
    expect(filterQ({ ...p.filter, type: 'bandpass', resonance: 100 })).toBeCloseTo(20);
    expect(filterQ({ ...p.filter, resonance: 0 })).toBeCloseTo(-3, 0);
    const dark = { ...p, filter: { ...p.filter, cutoff: 8000 }, velocityToCutoff: 100 };
    expect(noteCutoff(dark, 127)).toBeCloseTo(8000);
    expect(noteCutoff(dark, 0)).toBeCloseTo(500);
    expect(cutoffAt(500, 100, 1, RATE)).toBe(20000);
    expect(cutoffAt(500, 50, 1, RATE)).toBeCloseTo(4000);
    expect(cutoffAt(500, -100, 1, RATE)).toBe(20);
    expect(cutoffAt(16000, 0, 1, 22050)).toBeCloseTo(22050 * 0.45);
  });

  it('envelopeAt: linear attack, decay towards sustain, release from the held level', () => {
    const e = { attack: 0.1, decay: 0.3, sustain: 0.5, release: 0.2 };
    expect(envelopeAt(e, 0)).toBe(0);
    expect(envelopeAt(e, 0.05)).toBeCloseTo(0.5);
    expect(envelopeAt(e, 0.1)).toBeCloseTo(1);
    expect(envelopeAt(e, 0.4)).toBeCloseTo(0.5 + 0.5 * Math.exp(-3));
    expect(envelopeAt(e, 0.05, 0.05)).toBeCloseTo(0.5);
    expect(envelopeAt(e, 0.1, 0.05)).toBeCloseTo(0.5 * Math.exp(-0.05 / 0.05));
  });
});

describe('detectPitch', () => {
  it.each([55, 110, 261.63, 440, 880, 1500])('finds %f Hz', (hz) => {
    const data = new Float32Array(8192).map((_, i) => sine(hz)(i));
    const found = detectPitch(data, RATE);
    expect(found?.note).toBe(Math.round(69 + 12 * Math.log2(hz / 440)));
    expect(found?.frequency ?? 0).toBeCloseTo(hz, 0);
  });

  it('finds the fundamental of a harmonic-rich wave', () => {
    const saw = (i: number) => {
      let v = 0;
      for (let k = 1; k <= 12; k++) v += Math.sin((2 * Math.PI * 196 * k * i) / RATE) / k;
      return v * 0.3;
    };
    expect(
      detectPitch(
        new Float32Array(8192).map((_, i) => saw(i)),
        RATE,
      )?.note,
    ).toBe(55);
  });

  it('returns null for noise, silence and too little material', () => {
    let s = 1;
    const random = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
    expect(
      detectPitch(
        new Float32Array(8192).map(() => random()),
        RATE,
      ),
    ).toBeNull();
    expect(detectPitch(new Float32Array(8192), RATE)).toBeNull();
    expect(
      detectPitch(
        new Float32Array(500).map((_, i) => sine(440)(i)),
        RATE,
      ),
    ).toBeNull();
  });
});

describe('buffers', () => {
  it('waveformPeaks: min and max per column, normalised', () => {
    const b = from((i) => (i < 50 ? 0.25 : -0.5), 100);
    const peaks = waveformPeaks(b, 4, 0.5);
    expect([...peaks.max]).toEqual([0.5, 0.5, -1, -1]);
    expect([...peaks.min]).toEqual([0.5, 0.5, -1, -1]);
    expect(waveformPeaks(b, 1).min[0]).toBe(-0.5);
  });

  it('prepareSample: the trimmed region, reversed when asked', () => {
    const source = from((i) => i, 1000, 2);
    const p = loaded(1000, { start: 100, end: 300 });
    const plain = prepareSample(source, p, buffer).plain;
    expect(plain.length).toBe(200);
    expect(plain.numberOfChannels).toBe(2);
    expect([plain.getChannelData(1)[0], plain.getChannelData(1)[199]]).toEqual([100, 299]);
    const reversed = prepareSample(source, { ...p, reverse: true }, buffer).plain;
    expect([reversed.getChannelData(0)[0], reversed.getChannelData(0)[199]]).toEqual([299, 100]);
    expect(prepareSample(source, p, buffer).loop).toBeNull();
  });

  it('a reversed patch loops the same audio (mirrored loop points)', () => {
    const p = loaded(1000, { start: 100, end: 900 });
    const looped = { ...p, loop: { ...p.loop, start: 200, end: 500 } };
    expect(plainLoop(looped)).toEqual({ start: 100, end: 400 });
    expect(plainLoop({ ...looped, reverse: true })).toEqual({ start: 400, end: 700 });
  });

  it('forward loop: the crossfade is baked in before the loop end, ending on the frame before the start', () => {
    const source = from((i) => i, 1000);
    const p = loaded(1000);
    const looped = {
      ...p,
      loop: { enabled: true, start: 400, end: 800, crossfade: 100, mode: 'forward' as const },
    };
    const prepared = prepareSample(source, looped, buffer);
    const loop = prepared.loop;
    if (loop === null) throw new Error('no loop');
    const data = loop.buffer.getChannelData(0);
    expect(loop.buffer.length).toBe(800);
    expect([loop.start * RATE, loop.end * RATE, loop.handoff * RATE]).toEqual([400, 800, 700]);
    expect(data[699]).toBe(699); // untouched before the crossfade
    expect(data[799]).toBeCloseTo(399); // = plain[loop start - 1]: the jump to 400 is continuous
    expect(data[749]).toBeCloseTo(749 * 0.5 + 349 * 0.5);
    // The crossfade cannot reach before the trim start.
    const early = { ...looped, loop: { ...looped.loop, start: 40, end: 400 } };
    expect((prepareSample(source, early, buffer).loop?.handoff ?? 0) * RATE).toBe(360);
  });

  it('ping-pong loop: the region forwards, then backwards without its end frames', () => {
    const source = from((i) => i, 1000);
    const p = loaded(1000);
    const looped = {
      ...p,
      loop: { enabled: true, start: 100, end: 110, crossfade: 0, mode: 'pingpong' as const },
    };
    const loop = prepareSample(source, looped, buffer).loop;
    if (loop === null) throw new Error('no loop');
    const data = [...loop.buffer.getChannelData(0).slice(100)];
    expect(data).toEqual([
      100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 108, 107, 106, 105, 104, 103, 102, 101,
    ]);
    expect([loop.start * RATE, loop.end * RATE, loop.handoff * RATE]).toEqual([100, 118, 110]);
  });

  it('handoffTime: the next pass over the hand-off point at or after the release', () => {
    const loop = { start: 1, end: 2, handoff: 1.5 };
    expect(handoffTime(0, 1, loop, 0.2)).toBeCloseTo(1.5); // before the first pass
    expect(handoffTime(0, 1, loop, 1.6)).toBeCloseTo(2.5); // the next cycle
    // Twice as fast: the hand-off at 1.5, 2.5, 3.5 s of buffer = 0.75, 1.25, 1.75 s.
    expect(handoffTime(0, 2, loop, 1.6)).toBeCloseTo(1.75);
    expect(handoffTime(10, 1, loop, 11.5)).toBeCloseTo(11.5);
  });
});

describe('sampler voice on the fake context', () => {
  function voice(change: Partial<SamplerPatch> = {}, note = 60) {
    const ctx = new FakeContext(RATE);
    const source = from(sine(261.63), 4000);
    const patch = loaded(4000, change);
    const prepared = prepareSample(source, patch, buffer);
    const out = ctx.createGain();
    const v = buildSamplerVoice(ctx, prepared, patch, note, 127, 1, out);
    return { ctx, v, out, prepared };
  }

  it('routes source → envelope → filter → panner → out', () => {
    const { ctx, v, out } = voice({
      pan: -0.5,
      filter: { ...defaultPatch(ID).filter, type: 'highpass' },
    });
    const [source] = ctx.of(FakeBufferSource);
    expect(source && ctx.route(source)).toEqual([
      'buffer-source',
      'gain',
      'filter',
      'panner',
      'gain',
    ]);
    expect(ctx.of(FakeGain)).toContain(out);
    expect(ctx.of(FakeFilter)[0]?.type).toBe('highpass');
    expect(ctx.of(FakePanner)[0]?.pan.value).toBe(-0.5);
    expect(v.length).toBeCloseTo(4000 / RATE);
  });

  it('a loop sets the native loop points and hands over to a tail source at the release', () => {
    const { ctx, v, prepared } = voice({
      loop: { enabled: true, start: 1000, end: 3000, crossfade: 200, mode: 'forward' },
    });
    const [main] = ctx.of(FakeBufferSource);
    expect(main?.loop).toBe(true);
    expect((main?.loopEnd ?? 0) * RATE).toBeCloseTo(3000);
    expect(v.length).toBe(Infinity);
    // The next hand-off (frame 2800 of a loop cycle) comes after the fade is over: no tail.
    const loop = { start: 1000 / RATE, end: 3000 / RATE, handoff: 2800 / RATE };
    const next = handoffTime(1, 1, loop, 1.5);
    v.releaseAt(1.5, 0.001, next - 0.0001);
    expect(ctx.of(FakeBufferSource)).toHaveLength(1);
    expect(main?.stops).toEqual([next - 0.0001]);
    const long = voice({
      loop: { enabled: true, start: 1000, end: 3000, crossfade: 200, mode: 'forward' },
    });
    long.v.releaseAt(1.01, 2, 3.4);
    const [loopSource, tail] = long.ctx.of(FakeBufferSource);
    const at = 1 + 2800 / RATE;
    expect(loopSource?.stops[0]).toBeCloseTo(at);
    expect(tail?.buffer).toBe(long.prepared.plain);
    expect(tail?.startArgs[0]?.when).toBeCloseTo(at);
    expect((tail?.startArgs[0]?.offset ?? 0) * RATE).toBeCloseTo(2800);
    expect(tail?.stops).toEqual([3.4]);
    expect(prepared.plain).not.toBe(long.prepared.plain);
  });

  it('an earlier second release stops everything at the new stop', () => {
    const { ctx, v } = voice({
      loop: { enabled: true, start: 1000, end: 3000, crossfade: 200, mode: 'forward' },
    });
    v.releaseAt(1.01, 2, 3.4);
    v.releaseAt(1.0, 0.02, 1.024);
    const [main, tail] = ctx.of(FakeBufferSource);
    expect(main?.stops.at(-1)).toBeCloseTo(1.024);
    expect(tail?.stops.at(-1)).toBeCloseTo(1.024);
  });

  it('the filter follows the envelope and releases back to the note cutoff', () => {
    const { ctx, v } = voice({
      filter: { type: 'lowpass', cutoff: 500, resonance: 0, envAmount: 50 },
      envelope: { attack: 0.01, decay: 0.2, sustain: 0.5, release: 0.1 },
    });
    const f = ctx.of(FakeFilter)[0]?.frequency;
    expect(f?.calls.map((c) => c.method)).toEqual(['set', 'exp', 'target']);
    expect(f?.calls[1]?.value).toBeCloseTo(4000);
    expect(f?.calls[2]?.value).toBeCloseTo(500 * 2 ** 1.5);
    v.releaseAt(2, 0.1, 2.12);
    expect(f?.calls.slice(3).map((c) => [c.method, Math.round(c.value)])).toEqual([
      ['cancel', 0],
      ['set', Math.round(500 * 2 ** 1.5 + (4000 - 500 * 2 ** 1.5) * Math.exp(-0.99 / (0.2 / 3)))],
      ['target', 500],
    ]);
  });
});

describe('SamplerBank and Samplers', () => {
  function setup(decoded: SamplerBuffer = from(sine(440), RATE / 2)) {
    const store = new MemorySampleStore();
    let stamp = 0;
    const decode = vi.fn(() => Promise.resolve(decoded));
    const bank = new SamplerBank({ decode, create: buffer, now: () => `t${++stamp}` });
    const sound = new SoundSettings();
    const audition = vi.fn(() => ({ release: vi.fn() }));
    const samplers = new Samplers(sound, bank, audition);
    void samplers.attach(store);
    const file = (size = 32) => new File([new Uint8Array(size)], 'take.wav', { type: 'audio/wav' });
    return { store, bank, decode, sound, samplers, audition, file };
  }

  it('load: stores the bytes, sets the sample, the trim, the loop and the detected root', async () => {
    const { store, samplers, file } = setup();
    expect(samplers.state(ID)).toBe('empty');
    await samplers.load(ID, file());
    const p = samplers.patch(ID);
    expect(p.sample).toMatchObject({
      name: 'take.wav',
      frames: RATE / 2,
      channels: 1,
      savedAt: 't1',
    });
    expect([p.start, p.end, p.root]).toEqual([0, RATE / 2, 69]);
    expect(samplers.state(ID)).toBe('ready');
    expect((await store.get(ID))?.saved_at).toBe('t1');
    expect(samplers.playable(ID)?.prepared.plain.length).toBe(RATE / 2);
    expect(samplers.waveform(ID, 10)?.max.length).toBe(10);
  });

  it('rejects too large, too short, too long and silent files and keeps the slot as it was', async () => {
    const big = setup();
    await expect(big.samplers.load(ID, big.file(MAX_SAMPLER_BYTES + 1))).rejects.toThrow(/10 MB/);
    for (const [decoded, reason] of [
      [from(sine(440), 100), /shorter/],
      [buffer(1, RATE * 31), /longer/],
      [buffer(1, RATE), /silent/],
    ] as const) {
      const s = setup(decoded);
      await expect(s.samplers.load(ID, s.file())).rejects.toThrow(reason);
      expect(s.samplers.patch(ID).sample).toBeNull();
      expect(await s.store.get(ID)).toBeNull();
    }
  });

  it('reloads a stored sample for a patch that names it (a new page)', async () => {
    const first = setup();
    await first.samplers.load(ID, first.file());
    const sound = new SoundSettings();
    sound.setSampler(ID, first.samplers.patch(ID));
    const decode = vi.fn(() => Promise.resolve(from(sine(440), RATE / 2)));
    const samplers = new Samplers(sound, new SamplerBank({ decode, create: buffer }));
    expect(samplers.state(ID)).toBe('loading');
    await samplers.attach(first.store);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(samplers.state(ID)).toBe('ready');
    // Bytes that are gone (another tab removed them) leave the slot in an error state.
    const other = new Samplers(sound, new SamplerBank({ decode, create: buffer }));
    await other.attach(new MemorySampleStore());
    expect(other.state(ID)).toBe('error');
    expect(other.error(ID)).toMatch(/no longer stored/);
  });

  it('clear removes the bytes and the sample, keeps the rest of the patch', async () => {
    const { store, samplers, file } = setup();
    await samplers.load(ID, file());
    samplers.rename(ID, 'Bell');
    await samplers.clear(ID);
    expect(samplers.patch(ID).sample).toBeNull();
    expect(samplers.patch(ID).name).toBe('Bell');
    expect(await store.get(ID)).toBeNull();
    expect(samplers.state(ID)).toBe('empty');
    expect(samplers.playable(ID)).toBeNull();
  });

  it('setters clamp, notify with the slot id and do nothing when unchanged', async () => {
    const { samplers, file } = setup();
    await samplers.load(ID, file());
    const seen: string[] = [];
    samplers.subscribe((id) => seen.push(id));
    samplers.setRoot(ID, 200);
    expect(samplers.patch(ID).root).toBe(127);
    samplers.setRoot(ID, 127);
    expect(seen).toEqual([ID]);
    samplers.trim(ID, 100, 200);
    expect([samplers.patch(ID).start, samplers.patch(ID).end]).toEqual([100, 200]);
    samplers.setLoop(ID, { enabled: true, mode: 'pingpong' });
    // The loop moved inside the new trim.
    expect(samplers.patch(ID).loop).toMatchObject({ enabled: true, mode: 'pingpong', end: 200 });
    samplers.setEnvelope(ID, { release: 2 });
    samplers.setFilter(ID, { type: 'highpass', cutoff: 1000 });
    samplers.setLevels(ID, { pan: 0.3, gain: -3 });
    samplers.setTune(ID, -20);
    samplers.setKeytrack(ID, 0);
    samplers.setReverse(ID, true);
    samplers.setProgram(ID, 33);
    const p = samplers.patch(ID);
    expect(p).toMatchObject({
      pan: 0.3,
      gain: -3,
      tune: -20,
      keytrack: 0,
      reverse: true,
      program: 33,
    });
    expect(p.envelope.release).toBe(2);
    expect(p.filter).toMatchObject({ type: 'highpass', cutoff: 1000 });
    expect(new Set(seen)).toEqual(new Set([ID]));
  });

  it('detectRoot runs on the current trim', async () => {
    let phase = 0;
    const twoTones = from((i) => {
      const v = 0.5 * Math.sin(phase);
      phase += (2 * Math.PI * (i < RATE / 2 ? 440 : 220)) / RATE;
      return v;
    }, RATE);
    const { samplers, file } = setup(twoTones);
    await samplers.load(ID, file());
    expect(samplers.patch(ID).root).toBe(69);
    samplers.trim(ID, RATE / 2, RATE);
    expect(samplers.detectRoot(ID)).toBe(57);
    expect(samplers.patch(ID).root).toBe(57);
  });

  it('audition goes to the injected hook; loading never auditions', async () => {
    const { samplers, audition, file } = setup();
    await samplers.load(ID, file());
    expect(audition).not.toHaveBeenCalled();
    expect(samplers.audition(ID, 64, 90)).not.toBeNull();
    expect(audition).toHaveBeenCalledWith(ID, 64, 90, undefined);
  });

  it('the synth plays the piano stand-in until the slot has a sample', async () => {
    const { sound, samplers, file } = setup();
    const ctx = new FakeContext(RATE);
    const synth = new Synth(ctx, () => sound.preset, undefined, {
      voice: (track, role) => sound.voice(track, role),
      samplers,
    });
    sound.setInstrument('trk', 'chords', ID);
    synth.playNote(60, 0, 0.5, { track: 'trk' });
    expect(ctx.of(FakeBufferSource).filter((s) => s.loop)).toHaveLength(0);
    expect(ctx.nodes.some((n) => n.kind === 'oscillator')).toBe(true);
    await samplers.load(ID, file());
    const before = ctx.of(FakeBufferSource).length;
    synth.playNote(60, 0, 0.5, { track: 'trk' });
    const played = ctx.of(FakeBufferSource).slice(before);
    expect(played.map((s) => s.buffer)).toEqual([samplers.playable(ID)?.prepared.plain]);
  });
});
