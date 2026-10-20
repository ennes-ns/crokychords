/**
 * Breakcore slicing and chopping (docs/specs/breakcore-v1.md), rendered offline: nothing here
 * produces sound.
 */
import { describe, expect, it } from 'vitest';
import type { BreakSettings } from '../src/audio/breaks';
import {
  BREAK_PEAK,
  SLICES,
  barPlan,
  breakEvents,
  clampIntensity,
  isNative,
  mulberry32,
  nativeTempo,
  nextIntensity,
  prepareBreak,
  renderBreakcore,
  slotBeats,
  slotsPerBar,
} from '../src/audio/breaks';

const RATE = 8000;
/** A synthetic two-bar test break at 120 BPM: a distinct level per slice, so slices are traceable. */
const SLICE_LENGTH = 2000;
const SOURCE = (() => {
  const data = new Float32Array(SLICE_LENGTH * SLICES);
  for (let i = 0; i < data.length; i++) {
    const slice = Math.floor(i / SLICE_LENGTH);
    data[i] = ((slice + 1) / SLICES) * Math.sin((2 * Math.PI * 220 * i) / RATE);
  }
  return data;
})();
const NATIVE = nativeTempo(SOURCE.length / RATE);

const settings = (intensity: number, speed: 1 | 2 = 1): BreakSettings => ({ intensity, speed });

function differs(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return true;
  return a.some((v, i) => v !== b[i]);
}

describe('slots and helpers', () => {
  it('an eighth per slot at ×1, a sixteenth at ×2', () => {
    expect(slotBeats(1)).toBe(0.5);
    expect(slotBeats(2)).toBe(0.25);
    expect(slotsPerBar(4, 1)).toBe(8);
    expect(slotsPerBar(3, 2)).toBe(12);
    expect(nativeTempo(8 * 0.5)).toBe(120);
    expect(isNative(70.5, 2, 141)).toBe(true);
    expect(isNative(141, 1, 141.0001)).toBe(false);
  });

  it('Shift+K cycles 25 → 50 → 75 → 100 → 25 and intensities clamp', () => {
    expect([0, 25, 50, 75, 100, 33].map(nextIntensity)).toEqual([25, 50, 75, 100, 25, 50]);
    expect(clampIntensity(140)).toBe(100);
    expect(clampIntensity(-3)).toBe(0);
    expect(clampIntensity(Number.NaN)).toBe(50);
  });

  it('mulberry32 is a deterministic generator in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 100 }, () => a());
    expect(xs).toEqual(Array.from({ length: 100 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});

describe('chop sequence', () => {
  it('at intensity 0 every slot plays its own slice straight', () => {
    const events = breakEvents(settings(0), 4, 0, 16);
    expect(events).toHaveLength(32);
    expect(events.every((e) => e.op === 'straight' && e.rate === 1 && !e.reverse)).toBe(true);
    expect(events.map((e) => e.slice)).toEqual(Array.from({ length: 32 }, (_, i) => i % SLICES));
    expect(events.map((e) => e.beat)).toEqual(Array.from({ length: 32 }, (_, i) => i / 2));
  });

  it('at intensity 100 every bar is chopped', () => {
    for (let bar = 0; bar < 64; bar++) {
      const plan = barPlan(bar, settings(100), 4);
      expect(
        plan.some((slot) => slot.op !== 'straight'),
        `bar ${bar}`,
      ).toBe(true);
    }
  });

  it('is deterministic for a given bar number, whatever is asked around it', () => {
    const first = barPlan(17, settings(75), 4);
    breakEvents(settings(75), 4, 0, 200);
    expect(barPlan(17, settings(75), 4)).toEqual(first);
    // The same bar inside a different window gives the same events.
    const wide = breakEvents(settings(75), 4, 60, 76).filter((e) => e.beat >= 68 && e.beat < 72);
    const narrow = breakEvents(settings(75), 4, 68, 72);
    expect(narrow).toEqual(wide);
  });

  it('a higher intensity only chops more: the chopped bars at 50 stay chopped at 75', () => {
    const chopped = (intensity: number) =>
      Array.from({ length: 64 }, (_, bar) =>
        barPlan(bar, settings(intensity), 4).some((s) => s.op !== 'straight'),
      );
    const half = chopped(50);
    const more = chopped(75);
    half.forEach((c, bar) => {
      if (c) expect(more[bar], `bar ${bar}`).toBe(true);
    });
    expect(more.filter(Boolean).length).toBeGreaterThan(half.filter(Boolean).length);
  });

  it('draws every chop: repeats, stutters, reverses, pitches and shuffles', () => {
    const ops = new Set(breakEvents(settings(100), 4, 0, 256).map((e) => e.op));
    expect([...ops].sort()).toEqual(
      ['pitch', 'repeat', 'reverse', 'shuffle', 'straight', 'stutter2', 'stutter4'].sort(),
    );
    const events = breakEvents(settings(100), 4, 0, 256);
    for (const e of events) {
      if (e.op === 'stutter2') expect(e.beats).toBe(0.25);
      if (e.op === 'stutter4') expect(e.beats).toBe(0.125);
      if (e.op === 'pitch') expect([2 ** (-2 / 12), 2 ** (2 / 12)]).toContain(e.rate);
      if (e.op === 'repeat') expect(e.slice).toBe((Math.round(e.beat * 2) + SLICES - 1) % SLICES);
    }
  });

  it('×2 plays the break twice as fast: sixteenth slots, a full cycle per 4/4 bar', () => {
    const events = breakEvents(settings(0, 2), 4, 0, 4);
    expect(events).toHaveLength(16);
    expect(events.map((e) => e.slice)).toEqual(Array.from({ length: 16 }, (_, i) => i));
    expect(events.every((e) => e.beats === 0.25)).toBe(true);
  });
});

describe('offline render', () => {
  const render = (intensity: number, tempo = NATIVE, toBeat = 16) =>
    renderBreakcore(SOURCE, RATE, {
      tempo,
      beatsPerBar: 4,
      settings: settings(intensity),
      toBeat,
    });

  it('intensity 0 at the native tempo is the break itself, sample for sample', () => {
    const out = render(0, NATIVE, 8);
    expect(out.length).toBe(SOURCE.length);
    expect(differs(out, SOURCE)).toBe(false);
  });

  it('intensity 0 over 4 bars is the straight break looped', () => {
    const out = render(0);
    expect(out.length).toBe(SOURCE.length * 2);
    expect(differs(out.subarray(0, SOURCE.length), SOURCE)).toBe(false);
    expect(differs(out.subarray(SOURCE.length), SOURCE)).toBe(false);
  });

  it('4 bars at intensity 100 differ from intensity 0', () => {
    expect(differs(render(100), render(0))).toBe(true);
  });

  it('the render is reproducible', () => {
    expect(differs(render(75), render(75))).toBe(false);
  });

  it('re-times slices to another tempo: each slot starts on its own grid line', () => {
    const tempo = 100;
    const out = render(0, tempo, 8);
    const spb = 60 / tempo;
    expect(out.length).toBe(Math.round(8 * spb * RATE));
    // Slower than native: each slice plays at its own pitch and length, then a gap.
    for (let slot = 0; slot < 16; slot++) {
      const start = Math.round(slot * 0.5 * spb * RATE);
      const k = 50; // past the fade-in
      expect(out[start + k]).toBeCloseTo(SOURCE[slot * SLICE_LENGTH + k] ?? 0, 6);
      const gap = start + SLICE_LENGTH + 5;
      expect(out[gap]).toBe(0);
    }
  });

  it('a faster song cuts the slices short with a fade-out', () => {
    const tempo = 200;
    const out = render(0, tempo, 1);
    const slotSamples = Math.round(0.5 * (60 / tempo) * RATE);
    expect(slotSamples).toBeLessThan(SLICE_LENGTH);
    // Last sample of the first slot is faded to silence.
    expect(out[slotSamples - 1]).toBe(0);
  });

  it('stays within the break peak plus overlapping fades', () => {
    const out = render(100, 160);
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThanOrEqual(1 + 1e-6);
  });
});

describe('prepareBreak', () => {
  it('mixes stereo to mono and normalises the peak', () => {
    const left = new Float32Array(RATE).fill(0.2);
    const right = new Float32Array(RATE).fill(0.4);
    left[10] = -0.5;
    const mono = prepareBreak([left, right], RATE);
    expect(mono.length).toBe(RATE);
    const peak = Math.max(...mono.map(Math.abs));
    expect(peak).toBeCloseTo(BREAK_PEAK, 6);
    expect(mono[0]).toBeCloseTo(BREAK_PEAK, 6);
    expect(mono[10]).toBeCloseTo((-0.05 / 0.3) * BREAK_PEAK, 6);
  });

  it('rejects breaks that are too short, too long or silent', () => {
    expect(() => prepareBreak([new Float32Array(RATE / 4).fill(0.1)], RATE)).toThrow(RangeError);
    expect(() => prepareBreak([new Float32Array(RATE * 21).fill(0.1)], RATE)).toThrow(RangeError);
    expect(() => prepareBreak([new Float32Array(RATE)], RATE)).toThrow(/silent/);
  });
});
