/**
 * Plays Breakcore slice events (docs/specs/breakcore-v1.md) with Web Audio: one buffer source per
 * slice from the loaded break (a reversed copy serves reversed slices), through a fade gain into
 * the break bus. Works on an injected `SynthContext`, so tests use the fake context.
 */
import type { BreakEvent } from './breaks';
import { FADE_IN_S, FADE_OUT_S, SLICES, nativeTempo } from './breaks';
import type { BreakBuffers, NodeLike, SourceLike, SynthContext } from './graph';
import { buildSlice } from './graph';

export class BreakPlayer {
  readonly #ctx: SynthContext;
  readonly #out: () => NodeLike;
  #buffers: BreakBuffers | null = null;
  #native = 0;
  readonly #sounding = new Map<SourceLike, number>();

  /** `out` is read on every slice (the synth's break bus). */
  constructor(ctx: SynthContext, out: () => NodeLike) {
    this.#ctx = ctx;
    this.#out = out;
  }

  /** Native tempo of the loaded break, or null before one is loaded. */
  get nativeTempo(): number | null {
    return this.#buffers === null ? null : this.#native;
  }

  /** Number of slices still sounding (for tests). */
  get sounding(): number {
    this.#prune();
    return this.#sounding.size;
  }

  /** Use `mono` (a prepared break at `sampleRate`) from now on. */
  load(mono: Float32Array, sampleRate: number): void {
    const forward = this.#ctx.createBuffer(1, mono.length, sampleRate);
    forward.getChannelData(0).set(mono);
    const reverse = this.#ctx.createBuffer(1, mono.length, sampleRate);
    const data = reverse.getChannelData(0);
    for (let i = 0; i < mono.length; i++) data[i] = mono[mono.length - 1 - i] ?? 0;
    const seconds = mono.length / sampleRate;
    this.#buffers = { forward, reverse, sliceSeconds: seconds / SLICES };
    this.#native = nativeTempo(seconds);
  }

  /** Play `event` at `time` (audio-clock seconds) for at most `seconds`. */
  play(event: BreakEvent, time: number, seconds: number): void {
    const buffers = this.#buffers;
    if (buffers === null || seconds <= 0) return;
    this.#prune();
    const start = Math.max(time, this.#ctx.currentTime);
    const { source, end } = buildSlice(this.#ctx, buffers, event, start, seconds, this.#out(), {
      in: FADE_IN_S,
      out: FADE_OUT_S,
    });
    this.#sounding.set(source, end);
  }

  /** Silence every slice now (Stop, Breakcore off). */
  stopAll(): void {
    const now = this.#ctx.currentTime;
    for (const source of this.#sounding.keys()) {
      try {
        source.stop(now);
      } catch {
        // A source that already ended may reject a second stop().
      }
    }
    this.#sounding.clear();
  }

  #prune(): void {
    const now = this.#ctx.currentTime;
    for (const [source, end] of this.#sounding) {
      if (end < now) this.#sounding.delete(source);
    }
  }
}
