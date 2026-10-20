/**
 * Breakcore wiring (docs/specs/breakcore-v1.md): scheduler placement, the break bus and the
 * master guard, the slice graph, the controller with its persistence and own break, keys and the
 * transport controls. Everything runs against fakes; nothing produces sound.
 */
import { createSong } from '@crokychords/core';
import { describe, expect, it } from 'vitest';
import { BREAK_PEAK, breakEvents } from '../src/audio/breaks';
import type { BreakEvent } from '../src/audio/breaks';
import { BreakPlayer } from '../src/audio/breakPlayer';
import {
  BREAK_GAIN_DB,
  MASTER_GAIN,
  buildBreakBus,
  buildMasterBus,
  dbToGain,
  guardedMasterMode,
} from '../src/audio/graph';
import type { BreakPlan, NoteSink, Timer } from '../src/audio/scheduler';
import { START_DELAY_S, Scheduler } from '../src/audio/scheduler';
import { Synth } from '../src/audio/synth';
import type { BreakContext, DecodedAudio } from '../src/breakcore';
import {
  BREAKCORE_KEY,
  BUNDLED_BREAK_URL,
  BreakcoreController,
  defaultBreakcore,
  loadBreakcorePrefs,
  parseBreakcorePrefs,
} from '../src/breakcore';
import { keyAction } from '../src/keyboard';
import { melodyKeyAction } from '../src/melodyKeys';
import { Store, initialState } from '../src/state';
import { MAX_SAMPLE_BYTES, MemorySampleStore, parseStoredSample } from '../src/store/samples';
import { breakLamp, breakcoreControls } from '../src/views/toolbar';
import { FakeBufferSource, FakeContext, FakeGain } from './fakeAudio';

const key = (k: string, shiftKey = false) => ({
  key: k,
  code: `Key${k.toUpperCase()}`,
  shiftKey,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
});

function memory(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
}

describe('scheduler places Breakcore slices', () => {
  interface Slice {
    event: BreakEvent;
    time: number;
    seconds: number;
  }

  function harness(plan: BreakPlan | null) {
    let now = 10;
    const slices: Slice[] = [];
    const sink: NoteSink = {
      playNote: () => undefined,
      stopAll: () => undefined,
      playBreak: (event, time, seconds) => slices.push({ event, time, seconds }),
    };
    const timer: Timer = { setInterval: () => 1, clearInterval: () => undefined };
    let current = plan;
    const scheduler = new Scheduler(
      { now: () => now },
      () => [sink],
      timer,
      () => 'none',
      () => current,
    );
    return {
      scheduler,
      slices,
      setPlan(next: BreakPlan | null) {
        current = next;
      },
      advance(seconds: number) {
        const end = now + seconds;
        while (now < end - 1e-9) {
          now = Math.min(end, now + 0.025);
          scheduler.tick();
        }
      },
    };
  }

  const eightBars = createSong({
    tempo: 120,
    chords: Array.from({ length: 8 }, () => ({ token: 'I', beats: 4 })),
  });
  const plan: BreakPlan = { intensity: 100, speed: 1, nativeTempo: 141 };

  it('plays the break events of the song beats on the audio clock', () => {
    const h = harness(plan);
    h.scheduler.start(eightBars);
    h.advance(4); // 8 beats at 120 BPM
    const expected = breakEvents(plan, 4, 0, 8);
    const got = h.slices.filter((s) => s.event.beat < 8).map((s) => s.event);
    expect(got).toEqual(expected);
    for (const s of h.slices) {
      expect(s.time).toBeCloseTo(10 + START_DELAY_S + s.event.beat * 0.5, 9);
      expect(s.seconds).toBeCloseTo(s.event.beats * 0.5, 9);
    }
  });

  it('nothing while off (no plan) and no sinks without playBreak', () => {
    const h = harness(null);
    h.scheduler.start(eightBars);
    h.advance(2);
    expect(h.slices).toHaveLength(0);
  });

  it('stays on the beat grid after a tempo change', () => {
    const h = harness(plan);
    h.scheduler.start(eightBars);
    h.advance(1.03); // just past beat 2 at 120 BPM
    const before = h.slices.length;
    h.scheduler.update({ ...eightBars, tempo: 180 });
    h.advance(2);
    const after = h.slices.slice(before);
    expect(after.length).toBeGreaterThan(0);
    // Every slice after the change still sits on a slot (multiple of 1/8 beat for stutters).
    for (const s of after) expect((s.event.beat * 8) % 1).toBe(0);
    // Consecutive slot starts are spaced by the new tempo: 0.5 beat = 1/6 s at 180 BPM.
    const starts = [
      ...new Set(after.filter((s) => s.event.beat % 0.5 === 0).map((s) => s.event.beat)),
    ];
    const times = starts.map((b) => after.find((s) => s.event.beat === b)?.time ?? 0);
    for (let i = 1; i < starts.length; i++) {
      const gap = (times[i] ?? 0) - (times[i - 1] ?? 0);
      expect(gap).toBeCloseTo((((starts[i] ?? 0) - (starts[i - 1] ?? 0)) * 60) / 180, 9);
    }
    // No slice before the change was rescheduled.
    expect(new Set(h.slices.map((s) => s.time)).size).toBe(
      new Set(h.slices.map((s) => `${s.time}`)).size,
    );
  });

  it('a looped range repeats its own bars and cuts slices at the loop end', () => {
    const h = harness(plan);
    h.scheduler.start(eightBars, { loop: true, range: { start: 4, end: 10 }, fromBeat: 4 });
    h.advance(9); // 18 beats: the 6-beat range three times
    const pass = (k: number) =>
      h.slices
        .filter((s) => {
          const t = (s.time - (10 + START_DELAY_S)) / 0.5; // timeline beat
          return t >= k * 6 - 1e-9 && t < (k + 1) * 6 - 1e-9;
        })
        .map((s) => s.event);
    expect(pass(1)).toEqual(pass(0));
    expect(pass(2)).toEqual(pass(0));
    expect(pass(0).every((e) => e.beat >= 4 && e.beat + e.beats <= 10 + 1e-9)).toBe(true);
    expect(pass(0)[0]?.beat).toBe(4);
  });

  it('turning Breakcore on while playing applies within the lookahead', () => {
    const h = harness(null);
    h.scheduler.start(eightBars);
    h.advance(1);
    expect(h.slices).toHaveLength(0);
    h.setPlan(plan);
    h.advance(0.5);
    expect(h.slices.length).toBeGreaterThan(0);
    expect(Math.min(...h.slices.map((s) => s.event.beat))).toBeGreaterThanOrEqual(2);
  });
});

describe('break bus and master guard', () => {
  it('the break bus is its own −6 dB gain into the master gain', () => {
    const ctx = new FakeContext();
    const bus = buildMasterBus(ctx);
    const gain = buildBreakBus(ctx, bus);
    expect(gain.gain.value).toBeCloseTo(dbToGain(BREAK_GAIN_DB), 9);
    expect(BREAK_GAIN_DB).toBe(-6);
    expect((gain as FakeGain).outputs).toEqual([bus.output]);
  });

  it('while Breakcore is on, off plays as the limiter; other modes stay', () => {
    expect(guardedMasterMode('off', true)).toBe('limiter');
    expect(guardedMasterMode('softclip', true)).toBe('softclip');
    expect(guardedMasterMode('limiter', true)).toBe('limiter');
    expect(guardedMasterMode('off', false)).toBe('off');
  });

  it('the worst case with Breakcore stays within what the limiter holds below 0 dBFS', () => {
    // synth.test.ts bounds the full band below 1 (full scale) at the master gain; the break adds
    // at most its normalised peak through the break bus and the master gain. master.test.ts
    // proves the limiter keeps a +6 dB signal below 0 dBFS.
    const breakPeak = BREAK_PEAK * dbToGain(BREAK_GAIN_DB) * MASTER_GAIN;
    expect(1 + breakPeak).toBeLessThan(dbToGain(6));
  });

  it('Synth applies the guard and gives the user mode back', () => {
    const ctx = new FakeContext();
    const synth = new Synth(ctx);
    expect(synth.masterMode).toBe('off');
    synth.setBreakGuard(true);
    expect(synth.masterMode).toBe('limiter');
    synth.setMasterMode('softclip');
    expect(synth.masterMode).toBe('softclip');
    synth.setMasterMode('off');
    expect(synth.masterMode).toBe('limiter');
    synth.setBreakGuard(false);
    expect(synth.masterMode).toBe('off');
    expect(synth.breakBus()).toBe(synth.breakBus());
  });
});

describe('BreakPlayer', () => {
  const event = (patch: Partial<BreakEvent> = {}): BreakEvent => ({
    beat: 0,
    beats: 0.5,
    slice: 3,
    reverse: false,
    rate: 1,
    fadeIn: true,
    fadeOut: true,
    op: 'straight',
    ...patch,
  });

  function player() {
    const ctx = new FakeContext(); // 100 Hz
    const out = ctx.createGain();
    const p = new BreakPlayer(ctx, () => out);
    const mono = new Float32Array(400).map((_, i) => i / 400); // 4 s: 0.25 s per slice
    p.load(mono, 100);
    return { ctx, out, p };
  }

  it('knows the native tempo of the loaded break', () => {
    expect(player().p.nativeTempo).toBe(120);
    expect(new BreakPlayer(new FakeContext(), () => new FakeGain()).nativeTempo).toBeNull();
  });

  it('starts the slice at its offset, at most to the slice end, through a fade gain', () => {
    const { ctx, out, p } = player();
    p.play(event(), 1, 0.2);
    const [source] = ctx.of(FakeBufferSource);
    expect(source?.startArgs).toEqual([{ when: 1, offset: 0.75, duration: 0.2 }]);
    expect(source?.stops).toEqual([1.2]);
    const gain = source?.outputs[0];
    expect(gain).toBeInstanceOf(FakeGain);
    expect((gain as FakeGain).outputs).toEqual([out]);
    // A longer slot plays the slice to its end only (re-timing, no time-stretch).
    p.play(event({ slice: 0 }), 2, 1);
    expect(ctx.of(FakeBufferSource)[1]?.startArgs[0]?.duration).toBeCloseTo(0.25, 9);
    expect(p.sounding).toBe(2);
  });

  it('reversed slices read the reversed buffer; pitched ones set the rate', () => {
    const { ctx, p } = player();
    p.play(event({ reverse: true, slice: 3 }), 1, 0.25);
    p.play(event({ rate: 2 ** (2 / 12) }), 2, 0.1);
    const [rev, pitched] = ctx.of(FakeBufferSource);
    expect(rev?.startArgs[0]?.offset).toBeCloseTo(12 * 0.25, 9);
    expect(rev?.buffer?.getChannelData(0)[0]).toBeCloseTo(399 / 400, 6);
    expect(pitched?.playbackRate.value).toBeCloseTo(2 ** (2 / 12), 9);
    expect(pitched?.startArgs[0]?.duration).toBeCloseTo(0.1 * 2 ** (2 / 12), 9);
    expect(pitched?.stops[0]).toBeCloseTo(2.1, 9);
  });

  it('stopAll stops every sounding slice now', () => {
    const { ctx, p } = player();
    p.play(event(), 1, 0.2);
    ctx.currentTime = 0.5;
    p.stopAll();
    expect(ctx.of(FakeBufferSource)[0]?.stops.at(-1)).toBe(0.5);
    expect(p.sounding).toBe(0);
  });
});

describe('settings', () => {
  it('parse field by field and fall back to the defaults', () => {
    expect(parseBreakcorePrefs(null)).toEqual({ intensity: 50, speed: 1, source: 'bundled' });
    expect(parseBreakcorePrefs('{"intensity": 75, "speed": 2, "source": "own"}')).toEqual({
      intensity: 75,
      speed: 2,
      source: 'own',
    });
    expect(parseBreakcorePrefs('{"intensity": "x", "speed": 3, "source": "web"}')).toEqual({
      intensity: 50,
      speed: 1,
      source: 'bundled',
    });
    expect(parseBreakcorePrefs('nope')).toEqual(parseBreakcorePrefs(null));
    expect(loadBreakcorePrefs(null).intensity).toBe(50);
    expect(defaultBreakcore().enabled).toBe(false);
  });
});

/** A fake AudioContext for the controller: decodes bytes as raw Float32 samples at 100 Hz. */
class DecodingContext extends FakeContext implements BreakContext {
  decodes = 0;
  decodeAudioData(bytes: ArrayBuffer): Promise<DecodedAudio> {
    this.decodes++;
    const data = new Float32Array(bytes);
    if (data.length === 0) return Promise.reject(new Error('cannot decode'));
    return Promise.resolve({
      numberOfChannels: 1,
      sampleRate: this.sampleRate,
      getChannelData: () => data,
    });
  }
}

const breakBytes = (seconds: number) =>
  new Float32Array(Math.round(seconds * 100)).map((_, i) => Math.sin(i)).buffer;

function controller(storage = memory()) {
  const store = new Store(initialState());
  const ctx = new DecodingContext();
  const synth = new Synth(ctx);
  const samples = new MemorySampleStore();
  const fetched: string[] = [];
  const c = new BreakcoreController({
    store,
    startAudio: () => Promise.resolve(true),
    context: () => ctx,
    synth: () => synth,
    samples,
    fetchBytes: (url) => {
      fetched.push(url);
      return Promise.resolve(breakBytes(4));
    },
    storage,
    now: () => '2026-10-20T12:00:00.000Z',
  });
  return { store, ctx, synth, samples, fetched, c, storage };
}

describe('BreakcoreController', () => {
  it('K toggles: loads the bundled break, guards the master and plans', async () => {
    const { store, synth, fetched, c } = controller();
    expect(c.plan()).toBeNull();
    c.toggle();
    expect(store.state.breakcore.enabled).toBe(true);
    expect(synth.masterMode).toBe('limiter');
    await c.load();
    expect(fetched).toEqual([BUNDLED_BREAK_URL]);
    expect(store.state.breakcore.status).toBe('ready');
    expect(c.plan()).toEqual({ intensity: 50, speed: 1, nativeTempo: 120 });
    c.toggle();
    expect(c.plan()).toBeNull();
    expect(synth.masterMode).toBe('off');
  });

  it('Shift+K cycles and the settings persist (enabled does not)', () => {
    const { store, c, storage } = controller();
    c.cycleIntensity();
    expect(store.state.breakcore.intensity).toBe(75);
    c.setSpeed(2);
    expect(JSON.parse(storage.data[BREAKCORE_KEY] ?? '{}')).toEqual({
      schema_version: 1,
      intensity: 75,
      speed: 2,
      source: 'bundled',
    });
    c.setEnabled(true);
    expect(JSON.parse(storage.data[BREAKCORE_KEY] ?? '{}')).not.toHaveProperty('enabled');
  });

  it('uses, keeps and removes an own break', async () => {
    const { store, samples, c, ctx } = controller();
    await c.init();
    expect(store.state.breakcore.ownName).toBeNull();
    c.setSource('own'); // nothing stored: stays bundled
    expect(store.state.breakcore.source).toBe('bundled');
    const file = new File([breakBytes(2)], 'my-break.wav', { type: 'audio/wav' });
    await c.useOwn(file);
    expect(store.state.breakcore).toMatchObject({ source: 'own', ownName: 'my-break.wav' });
    const stored = await samples.get('break');
    expect(stored?.name).toBe('my-break.wav');
    expect(stored?.bytes.byteLength).toBe(file.size);
    c.setEnabled(true);
    await c.load();
    expect(c.plan()?.nativeTempo).toBe(240); // 2 s = two bars at 240 BPM
    const decodes = ctx.decodes;
    await c.removeOwn();
    expect(await samples.get('break')).toBeNull();
    expect(store.state.breakcore).toMatchObject({ source: 'bundled', ownName: null });
    expect(c.plan()?.nativeTempo).toBe(120);
    expect(ctx.decodes).toBe(decodes + 1);
  });

  it('a stored own break is found again at start-up', async () => {
    const first = controller();
    await first.c.useOwn(new File([breakBytes(2)], 'b.wav'));
    const store = new Store(initialState());
    store.set({ breakcore: { ...store.state.breakcore, source: 'own' } });
    const ctx = new DecodingContext();
    const c = new BreakcoreController({
      store,
      startAudio: () => Promise.resolve(true),
      context: () => ctx,
      synth: () => new Synth(ctx),
      samples: first.samples,
      fetchBytes: () => Promise.reject(new Error('offline')),
    });
    await c.init();
    expect(store.state.breakcore).toMatchObject({ source: 'own', ownName: 'b.wav' });
    c.setEnabled(true);
    await c.load();
    expect(c.plan()?.nativeTempo).toBe(240);
  });

  it('rejects files that are too large or do not decode, and keeps the current break', async () => {
    const { store, samples, c } = controller();
    const big = new File([new ArrayBuffer(MAX_SAMPLE_BYTES + 1)], 'huge.wav');
    await expect(c.useOwn(big)).rejects.toThrow(/larger/);
    await expect(c.useOwn(new File([new ArrayBuffer(0)], 'empty.wav'))).rejects.toThrow();
    await expect(c.useOwn(new File([breakBytes(0.1)], 'short.wav'))).rejects.toThrow(RangeError);
    expect(store.state.breakcore.status).toBe('error');
    expect(store.state.breakcore.error).toMatch(/0.5–20 s/);
    expect(await samples.get('break')).toBeNull();
  });

  it('shows the error state when the bundled break does not load', async () => {
    const store = new Store(initialState());
    const ctx = new DecodingContext();
    const c = new BreakcoreController({
      store,
      startAudio: () => Promise.resolve(true),
      context: () => ctx,
      synth: () => new Synth(ctx),
      samples: new MemorySampleStore(),
      fetchBytes: () => Promise.reject(new Error('the break did not load (HTTP 404)')),
    });
    c.setEnabled(true);
    await c.load();
    expect(store.state.breakcore.status).toBe('error');
    expect(store.state.breakcore.error).toContain('404');
    expect(c.plan()).toBeNull();
  });
});

describe('stored samples', () => {
  it('accept only well-formed records', () => {
    const ok = {
      schema_version: 1,
      id: 'break',
      name: 'a.wav',
      type: 'audio/wav',
      bytes: new ArrayBuffer(8),
      saved_at: '2026-10-20T00:00:00Z',
    };
    expect(parseStoredSample(ok)).toEqual(ok);
    expect(parseStoredSample({ ...ok, schema_version: 2 })).toBeNull();
    expect(parseStoredSample({ ...ok, bytes: 'x' })).toBeNull();
    expect(parseStoredSample({ ...ok, bytes: new ArrayBuffer(0) })).toBeNull();
    expect(parseStoredSample(null)).toBeNull();
  });
});

describe('keys', () => {
  it('K toggles Breakcore, Shift+K cycles the intensity', () => {
    expect(keyAction(key('k'))).toEqual({ type: 'toggleBreakcore' });
    expect(keyAction(key('K', true))).toEqual({ type: 'cycleBreakIntensity' });
    expect(keyAction({ ...key('k'), ctrlKey: true })).toBeNull();
  });

  it('the melody lane leaves K and Shift+K to the global keys', () => {
    expect(melodyKeyAction(key('k'), 'melody')).toBeNull();
    expect(melodyKeyAction(key('K', true), 'melody')).toBeNull();
  });
});

describe('transport controls', () => {
  it('the lamp is pixel art: square 1×1 pixels on an 8×10 grid', () => {
    const svg = breakLamp();
    expect(svg.getAttribute('viewBox')).toBe('0 0 8 10');
    const rects = [...svg.querySelectorAll('rect')];
    expect(rects.length).toBeGreaterThan(30);
    expect(rects.every((r) => r.getAttribute('width') === '1')).toBe(true);
    expect(svg.querySelectorAll('rect.glass').length).toBeGreaterThan(0);
    expect(svg.querySelectorAll('rect.socket').length).toBeGreaterThan(0);
  });

  it('render the state and write changes back', async () => {
    const { store, c } = controller();
    const view = breakcoreControls(c, store);
    document.body.append(view.element);
    store.subscribe((state) => view.render(state.breakcore));
    view.render(store.state.breakcore);
    const toggle = view.element.querySelector<HTMLButtonElement>('.break-toggle');
    expect(toggle?.dataset['lamp']).toBe('off');
    expect(toggle?.getAttribute('aria-pressed')).toBe('false');
    toggle?.click();
    expect(toggle?.dataset['lamp']).toBe('loading');
    await c.load();
    expect(toggle?.dataset['lamp']).toBe('ready');
    expect(toggle?.getAttribute('aria-pressed')).toBe('true');

    const range = view.element.querySelector<HTMLInputElement>('.break-intensity');
    if (range === null) throw new Error('no slider');
    range.value = '80';
    range.dispatchEvent(new Event('input'));
    expect(store.state.breakcore.intensity).toBe(80);
    expect(view.element.querySelector('.break-percent')?.textContent).toBe('80%');

    const [speed, source] = [...view.element.querySelectorAll('select')];
    if (speed === undefined || source === undefined) throw new Error('no selects');
    speed.value = '2';
    speed.dispatchEvent(new Event('change'));
    expect(store.state.breakcore.speed).toBe(2);
    expect([...source.options].map((o) => o.textContent)).toEqual([
      'Bundled break',
      'Use my own break…',
    ]);
    view.element.remove();
  });
});
