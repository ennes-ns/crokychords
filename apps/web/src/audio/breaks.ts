/**
 * Breakcore mode (docs/specs/breakcore-v1.md): a two-bar break cut into 16 slices, re-timed to
 * the song tempo slot by slot and chopped per song bar by a seeded generator (beat repeats,
 * stutters, reversed, pitched and shuffled slices), plus an offline renderer of the result.
 * Pure: no Web Audio here (`breakPlayer.ts` plays the events).
 */

/** Slices of the break (an eighth note each at its native tempo). */
export const SLICES = 16;
/** Every break counts as two bars of four beats. */
export const BREAK_BEATS = 8;
/** Peak the break is normalised to on load (−0.1 dBFS). */
export const BREAK_PEAK = 0.989;
/** Fades at slice edges that are not seamless (seconds). */
export const FADE_IN_S = 0.001;
export const FADE_OUT_S = 0.004;
/** Pitched slices: ± this many semitones. */
export const PITCH_SEMITONES = 2;
/** Accepted length of a decoded break (seconds). */
export const BREAK_MIN_S = 0.5;
export const BREAK_MAX_S = 20;

export type BreakSpeed = 1 | 2;
export const BREAK_SPEEDS: readonly BreakSpeed[] = [1, 2];
export const DEFAULT_INTENSITY = 50;
/** Shift+K cycles through these intensities. */
export const INTENSITY_STEPS: readonly number[] = [25, 50, 75, 100];

export function isBreakSpeed(value: unknown): value is BreakSpeed {
  return value === 1 || value === 2;
}

/** Clamp an intensity to a whole percent in 0–100 (non-numbers give the default). */
export function clampIntensity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_INTENSITY;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** The next Shift+K intensity: the first step above `current`, wrapping to the first step. */
export function nextIntensity(current: number): number {
  return INTENSITY_STEPS.find((step) => step > current) ?? INTENSITY_STEPS[0] ?? DEFAULT_INTENSITY;
}

export type BreakOp =
  'straight' | 'repeat' | 'stutter2' | 'stutter4' | 'reverse' | 'pitch' | 'shuffle';
/** The operations a chopped slot can draw, equally likely. */
export const CHOP_OPS: readonly BreakOp[] = [
  'repeat',
  'stutter2',
  'stutter4',
  'reverse',
  'pitch',
  'shuffle',
];

export interface BreakSettings {
  /** 0–100: share of chopped bars, and how busy a chopped bar is. */
  intensity: number;
  speed: BreakSpeed;
}

/** One slice to play. */
export interface BreakEvent {
  /** Song beat of the start. */
  beat: number;
  /** Length on the song timeline (beats); the slice plays at most this long. */
  beats: number;
  /** Slice index 0..SLICES-1. */
  slice: number;
  reverse: boolean;
  /** Playback rate (1, or ±PITCH_SEMITONES). */
  rate: number;
  fadeIn: boolean;
  fadeOut: boolean;
  op: BreakOp;
}

/** Length of one slot on the song timeline (beats): an eighth at ×1, a sixteenth at ×2. */
export function slotBeats(speed: BreakSpeed): number {
  return BREAK_BEATS / SLICES / speed;
}

/** Native tempo (BPM) of a break `seconds` long. */
export function nativeTempo(seconds: number): number {
  return (BREAK_BEATS * 60) / seconds;
}

/** mulberry32: a small, fast, seeded generator of numbers in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A well-mixed 32-bit seed for a bar number (negative bars too). */
export function barSeed(bar: number): number {
  let h = Math.imul(bar | 0, 0x9e3779b1) ^ 0x2545f491;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/** What one slot of a bar plays. */
export interface SlotPlan {
  op: BreakOp;
  slice: number;
  reverse: boolean;
  rate: number;
  /** Retriggers within the slot (1 = plays once). */
  parts: number;
}

function straight(slot: number): SlotPlan {
  return { op: 'straight', slice: mod(slot, SLICES), reverse: false, rate: 1, parts: 1 };
}

/** Slots per song bar (whole: beats are whole numbers and slots are 1/2 or 1/4 beat). */
export function slotsPerBar(beatsPerBar: number, speed: BreakSpeed): number {
  return Math.max(1, Math.round(beatsPerBar / slotBeats(speed)));
}

/**
 * The chop plan of song bar `bar`: one entry per slot. The generator is seeded by the bar number
 * alone and draws the same numbers at every intensity (one for the bar, three per slot), so a
 * bar's sequence is reproducible and a higher intensity only chops more.
 */
export function barPlan(bar: number, settings: BreakSettings, beatsPerBar: number): SlotPlan[] {
  const count = slotsPerBar(beatsPerBar, settings.speed);
  const level = clampIntensity(settings.intensity) / 100;
  const random = mulberry32(barSeed(bar));
  const chopped = random() < level;
  const change = 0.35 + 0.4 * level;
  const plan: SlotPlan[] = [];
  for (let i = 0; i < count; i++) {
    const slot = bar * count + i;
    const a = random();
    const b = random();
    const c = random();
    const base = straight(slot);
    if (!chopped || a >= change) {
      plan.push(base);
      continue;
    }
    const op = CHOP_OPS[Math.min(CHOP_OPS.length - 1, Math.floor(b * CHOP_OPS.length))];
    switch (op) {
      case 'repeat':
        plan.push({ ...base, op, slice: mod(slot - 1, SLICES) });
        break;
      case 'stutter2':
        plan.push({ ...base, op, parts: 2 });
        break;
      case 'stutter4':
        plan.push({ ...base, op, parts: 4 });
        break;
      case 'reverse':
        plan.push({ ...base, op, reverse: true });
        break;
      case 'pitch':
        plan.push({ ...base, op, rate: 2 ** ((c < 0.5 ? -1 : 1) * (PITCH_SEMITONES / 12)) });
        break;
      case 'shuffle':
        plan.push({ ...base, op, slice: Math.min(SLICES - 1, Math.floor(c * SLICES)) });
        break;
      default:
        plan.push(base);
    }
  }
  return plan;
}

/** The plan of global slot `slot` (cached per bar by the caller). */
function planAt(
  slot: number,
  settings: BreakSettings,
  beatsPerBar: number,
  bars: Map<number, SlotPlan[]>,
): SlotPlan {
  const count = slotsPerBar(beatsPerBar, settings.speed);
  const bar = Math.floor(slot / count);
  let plan = bars.get(bar);
  if (plan === undefined) {
    plan = barPlan(bar, settings, beatsPerBar);
    bars.set(bar, plan);
  }
  return plan[slot - bar * count] ?? straight(slot);
}

/**
 * Slice events starting in `[from, to)` (song beats). `native` is true when the song runs at the
 * break's native tempo (song BPM × speed = native BPM): only then do straight slices next to
 * straight slices join without fades.
 */
export function breakEvents(
  settings: BreakSettings,
  beatsPerBar: number,
  from: number,
  to: number,
  native = false,
): BreakEvent[] {
  if (to <= from || beatsPerBar <= 0) return [];
  const slot = slotBeats(settings.speed);
  const bars = new Map<number, SlotPlan[]>();
  const events: BreakEvent[] = [];
  const eps = 1e-9;
  for (let g = Math.max(0, Math.ceil(from / slot - 1 - eps)); g * slot < to - eps; g++) {
    const start = g * slot;
    const plan = planAt(g, settings, beatsPerBar, bars);
    const parts = plan.parts;
    const part = slot / parts;
    for (let p = 0; p < parts; p++) {
      const beat = start + p * part;
      if (beat < from - eps || beat >= to - eps) continue;
      let fadeIn = true;
      let fadeOut = true;
      if (plan.op === 'straight' && native) {
        fadeIn = planAt(g - 1, settings, beatsPerBar, bars).op !== 'straight';
        fadeOut = planAt(g + 1, settings, beatsPerBar, bars).op !== 'straight';
      }
      events.push({
        beat,
        beats: part,
        slice: plan.slice,
        reverse: plan.reverse,
        rate: plan.rate,
        fadeIn,
        fadeOut,
        op: plan.op,
      });
    }
  }
  return events;
}

/** True when `tempo × speed` is the break's native tempo (within a millionth of a BPM). */
export function isNative(tempo: number, speed: BreakSpeed, native: number): boolean {
  return Math.abs(tempo * speed - native) < 1e-6;
}

/** Seconds of buffer a slice event reads and the seconds it sounds for. */
export function sliceSpan(
  event: Pick<BreakEvent, 'rate'>,
  seconds: number,
  sliceSeconds: number,
): { read: number; play: number } {
  const read = Math.min(seconds * event.rate, sliceSeconds);
  return { read, play: read / event.rate };
}

/**
 * A decoded break as one normalised mono channel: channels are averaged, then scaled so the peak
 * is BREAK_PEAK. Throws a RangeError for breaks shorter than BREAK_MIN_S or longer than
 * BREAK_MAX_S, or silent ones.
 */
export function prepareBreak(channels: readonly Float32Array[], sampleRate: number): Float32Array {
  const length = channels[0]?.length ?? 0;
  const seconds = length / sampleRate;
  if (!(seconds >= BREAK_MIN_S && seconds <= BREAK_MAX_S)) {
    throw new RangeError(
      `a break must be ${BREAK_MIN_S}–${BREAK_MAX_S} s long (this one is ${seconds.toFixed(2)} s)`,
    );
  }
  const mono = new Float32Array(length);
  for (const channel of channels) {
    for (let i = 0; i < length; i++) mono[i] = (mono[i] ?? 0) + (channel[i] ?? 0) / channels.length;
  }
  let peak = 0;
  for (const v of mono) peak = Math.max(peak, Math.abs(v));
  if (peak === 0) throw new RangeError('the break is silent');
  const scale = BREAK_PEAK / peak;
  for (let i = 0; i < length; i++) mono[i] = (mono[i] ?? 0) * scale;
  return mono;
}

export interface RenderOptions {
  /** Song tempo (BPM). */
  tempo: number;
  beatsPerBar: number;
  settings: BreakSettings;
  fromBeat?: number;
  toBeat: number;
}

/**
 * Render the break offline from song beat `fromBeat` to `toBeat`: the same events, re-timing and
 * fades as live playback, with linear interpolation for pitched slices. `source` is the prepared
 * mono break at `sampleRate`; the output has the same rate.
 */
export function renderBreakcore(
  source: Float32Array,
  sampleRate: number,
  options: RenderOptions,
): Float32Array {
  const { tempo, beatsPerBar, settings, toBeat } = options;
  const fromBeat = options.fromBeat ?? 0;
  const spb = 60 / tempo;
  const out = new Float32Array(Math.max(0, Math.round((toBeat - fromBeat) * spb * sampleRate)));
  const sliceLength = source.length / SLICES;
  const sliceSeconds = sliceLength / sampleRate;
  const native = isNative(tempo, settings.speed, nativeTempo(source.length / sampleRate));
  const fadeIn = Math.max(1, Math.round(FADE_IN_S * sampleRate));
  const fadeOut = Math.max(1, Math.round(FADE_OUT_S * sampleRate));
  for (const event of breakEvents(settings, beatsPerBar, fromBeat, toBeat, native)) {
    const start = Math.round((event.beat - fromBeat) * spb * sampleRate);
    const { play } = sliceSpan(event, event.beats * spb, sliceSeconds);
    const n = Math.min(Math.round(play * sampleRate), out.length - start);
    const base = event.slice * sliceLength;
    for (let k = 0; k < n; k++) {
      // Position inside the slice, read forwards or backwards from its end.
      const pos = k * event.rate;
      const at = event.reverse ? base + sliceLength - 1 - pos : base + pos;
      let v = sampleAt(source, at);
      if (event.fadeIn && k < fadeIn) v *= k / fadeIn;
      if (event.fadeOut && k >= n - fadeOut) v *= (n - 1 - k) / fadeOut;
      const i = start + k;
      out[i] = (out[i] ?? 0) + v;
    }
  }
  return out;
}

/** Linear interpolation; outside the buffer is silence. */
function sampleAt(source: Float32Array, at: number): number {
  const i = Math.floor(at);
  const frac = at - i;
  const a = i >= 0 && i < source.length ? (source[i] ?? 0) : 0;
  if (frac === 0) return a;
  const b = i + 1 >= 0 && i + 1 < source.length ? (source[i + 1] ?? 0) : 0;
  return a + (b - a) * frac;
}
