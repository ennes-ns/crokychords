/**
 * Lookahead scheduler (Chris Wilson, "A Tale of Two Clocks"): a coarse timer wakes every
 * 25 ms and schedules every note event (from core's `renderSong`) that starts within the next
 * 100 ms on the precise audio clock. Sinks (synth, Web MIDI) receive audio-clock times.
 * Drum hits of the current drum pattern are scheduled the same way, to sinks that play drums.
 *
 * Looping (docs/specs/loop-v1.md) plays the loop range `[start, end)` (or the whole song) again
 * and again without a gap: beats on the scheduler's timeline keep growing, and pass k >= 1 plays
 * the events of the range shifted by k range lengths. Notes are cut at the loop end, and sinks
 * get `loopWrap` at every jump back so they can release what is still held.
 *
 * Breakcore slices (docs/specs/breakcore-v1.md) are scheduled the same way, on the song-beat grid,
 * to sinks that play them; a looped bar repeats its own chop sequence.
 */
import type { NoteEvent, Song } from '@crokychords/core';
import { renderMelody, renderSong, totalBeats } from '@crokychords/core';
import type { BreakEvent, BreakSettings } from './breaks';
import { breakEvents, isNative } from './breaks';
import type { DrumHit, DrumPatternId } from './instruments';
import type { LoopRange } from '../loop';
import { loopBounds } from '../loop';
import { drumHits } from './instruments';

export const TICK_MS = 25;
export const LOOKAHEAD_S = 0.1;
/** Delay between pressing Play and the first note, so the first chord is not clipped. */
export const START_DELAY_S = 0.06;

export interface Clock {
  /** Seconds on the audio clock. */
  now(): number;
}

export interface NoteSink {
  /** Play `event` at `time` (audio-clock seconds) for `duration` seconds. */
  playNote(event: NoteEvent, time: number, duration: number): void;
  stopAll(): void;
  /** Play a drum hit at `time`. Optional: sinks without it (Web MIDI) get no drums. */
  playDrum?(hit: DrumHit, time: number): void;
  /** The playhead jumps from the loop end back to the loop start at `time` (optional). */
  loopWrap?(time: number): void;
  /** Play a Breakcore slice at `time` for at most `seconds` (optional, like drums). */
  playBreak?(event: BreakEvent, time: number, seconds: number): void;
}

/** What the scheduler needs to place Breakcore slices: the settings and the break's tempo. */
export interface BreakPlan extends BreakSettings {
  /** Native tempo of the loaded break (BPM). */
  nativeTempo: number;
}

export interface Timer {
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
}

/**
 * The song as note events in beats (unmuted tracks and the melody, sorted by start; ties keep
 * the band first) and its length.
 */
export function planSong(song: Song): { events: NoteEvent[]; total: number } {
  const events = [...renderSong(song, song.tracks ?? []), ...renderMelody(song)];
  events.sort((a, b) => a.start - b.start);
  return { events, total: totalBeats(song) };
}

/** Index of the first event starting at or after `beat` (events sorted by start). */
export function firstEventAt(events: readonly NoteEvent[], beat: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((events[mid]?.start ?? Infinity) < beat) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface StartOptions {
  fromBeat?: number;
  loop?: boolean;
  /** The loop range; null or absent loops the whole song. */
  range?: LoopRange | null;
}

export class Scheduler {
  readonly #clock: Clock;
  readonly #sinks: () => readonly NoteSink[];
  readonly #timer: Timer;
  readonly #drums: () => DrumPatternId;
  readonly #breaks: () => BreakPlan | null;

  #timerId: number | null = null;
  #events: NoteEvent[] = [];
  #total = 0;
  #loop = false;
  #range: LoopRange | null = null;
  #secondsPerBeat = 0.5;
  #beatsPerBar = 4;
  /** Absolute beats (they keep growing while looping) are anchored to an audio time. */
  #anchorTime = 0;
  #anchorBeat = 0;
  /** Everything before this absolute beat has been scheduled. */
  #scheduledUntil = 0;

  /** Called once when a non-looping song has played to its end. */
  onEnd: (() => void) | null = null;

  /**
   * `drums` and `breaks` are read on every wake-up, so a pattern or Breakcore change applies
   * within the lookahead.
   */
  constructor(
    clock: Clock,
    sinks: () => readonly NoteSink[],
    timer?: Timer,
    drums: () => DrumPatternId = () => 'none',
    breaks: () => BreakPlan | null = () => null,
  ) {
    this.#clock = clock;
    this.#sinks = sinks;
    this.#drums = drums;
    this.#breaks = breaks;
    this.#timer = timer ?? {
      setInterval: (fn, ms) => window.setInterval(fn, ms),
      clearInterval: (id) => window.clearInterval(id),
    };
  }

  get playing(): boolean {
    return this.#timerId !== null;
  }

  get secondsPerBeat(): number {
    return this.#secondsPerBeat;
  }

  start(song: Song, options: StartOptions = {}): void {
    this.stop();
    this.#loop = options.loop ?? false;
    this.#range = options.range ?? null;
    this.#setSong(song);
    if (this.#total <= 0) return;
    const from = Math.min(Math.max(0, options.fromBeat ?? 0), this.#total);
    const { start, end } = this.#bounds();
    // Past the end there is nothing to play: start over (from the loop start when looping).
    const last = this.#loop ? end : this.#total;
    this.#anchorBeat = from >= last ? (this.#loop ? start : 0) : from;
    this.#anchorTime = this.#clock.now() + START_DELAY_S;
    this.#scheduledUntil = this.#anchorBeat;
    this.#timerId = this.#timer.setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  stop(): void {
    if (this.#timerId === null) return;
    this.#timer.clearInterval(this.#timerId);
    this.#timerId = null;
    for (const sink of this.#sinks()) sink.stopAll();
  }

  /** Turn looping on or off and set the loop range; while playing the change applies at once. */
  setLoop(loop: boolean, range: LoopRange | null = this.#range): void {
    if (!this.playing) {
      this.#loop = loop;
      this.#range = range;
      return;
    }
    this.#rebase(() => {
      this.#loop = loop;
      this.#range = range;
    });
  }

  /**
   * Follow edits while playing (chords, tempo, tracks): re-render the events and re-anchor at
   * the current position with the new tempo. Already scheduled notes keep sounding.
   */
  update(song: Song): void {
    if (!this.playing) return;
    this.#rebase(() => this.#setSong(song));
    if (this.#total <= 0) this.#finish();
  }

  /**
   * Re-anchor the timeline at the current song position (pass 0, where timeline beats are song
   * beats), apply `change`, and jump to the loop start when the position is past the new loop end.
   */
  #rebase(change: () => void): void {
    const now = this.#clock.now();
    const beat = Math.max(this.#anchorBeat, this.#beatAt(now));
    const position = this.#songBeat(beat);
    const shift = beat - position;
    this.#anchorTime = Math.max(now, this.#anchorTime);
    this.#scheduledUntil = Math.max(position, this.#scheduledUntil - shift);
    this.#anchorBeat = position;
    change();
    const { start, end } = this.#bounds();
    if (this.#loop && position >= end) {
      this.#anchorBeat = start;
      this.#scheduledUntil = start;
    }
  }

  /** Playhead in song beats (wrapped while looping), or null when stopped. */
  position(): number | null {
    if (!this.playing) return null;
    return this.#songBeat(Math.max(this.#anchorBeat, this.#beatAt(this.#clock.now())));
  }

  /** Seconds until the playhead starts moving (the start delay after Play), else 0. */
  wait(): number {
    if (!this.playing) return 0;
    return Math.max(0, this.#anchorTime - this.#clock.now());
  }

  /** One scheduler wake-up (public for tests). */
  tick(): void {
    if (!this.playing) return;
    const now = this.#clock.now();
    if (!this.#loop && this.#beatAt(now) >= this.#total) {
      this.#finish();
      return;
    }
    const horizon = this.#beatAt(now + LOOKAHEAD_S);
    const until = this.#loop ? horizon : Math.min(horizon, this.#total);
    if (until <= this.#scheduledUntil) return;

    const sinks = this.#sinks();
    const drumSinks = sinks.filter((s) => s.playDrum !== undefined);
    const pattern = drumSinks.length > 0 ? this.#drums() : 'none';
    const breakSinks = sinks.filter((s) => s.playBreak !== undefined);
    const plan = breakSinks.length > 0 ? this.#breaks() : null;
    const native =
      plan !== null && isNative(60 / this.#secondsPerBeat, plan.speed, plan.nativeTempo);
    const events = this.#events;
    const { start, end } = this.#loop ? this.#bounds() : { start: 0, end: this.#total };
    const length = end - start;
    // Pass 0 plays the song from beat 0 up to the loop end; pass k >= 1 the range, k lengths on.
    let pass = this.#scheduledUntil < end ? 0 : Math.floor((this.#scheduledUntil - start) / length);
    for (;;) {
      const offset = pass * length;
      const passStart = pass === 0 ? 0 : start;
      if (passStart + offset >= until) break;
      const from = Math.max(this.#scheduledUntil - offset, passStart);
      const to = Math.min(until - offset, end);
      if (pass > 0 && from === passStart) {
        const time = this.#timeAt(offset + start);
        for (const sink of sinks) sink.loopWrap?.(time);
      }
      for (let i = firstEventAt(events, from); i < events.length; i++) {
        const event = events[i];
        if (event === undefined || event.start >= to) break;
        const time = this.#timeAt(offset + event.start);
        // While looping, a note that runs past the loop end is cut there.
        const beats = this.#loop ? Math.min(event.duration, end - event.start) : event.duration;
        const duration = beats * this.#secondsPerBeat;
        for (const sink of sinks) sink.playNote(event, time, duration);
      }
      // Drum bars restart with every pass, like the events.
      for (const hit of drumHits(pattern, this.#beatsPerBar, from, to)) {
        const time = this.#timeAt(offset + hit.beat);
        for (const sink of drumSinks) sink.playDrum?.(hit, time);
      }
      if (plan !== null) {
        for (const slice of breakEvents(plan, this.#beatsPerBar, from, to, native)) {
          const time = this.#timeAt(offset + slice.beat);
          // While looping, a slice that runs past the loop end is cut there (with a fade).
          const cut = this.#loop && slice.beat + slice.beats > end;
          const event = cut ? { ...slice, beats: end - slice.beat, fadeOut: true } : slice;
          const seconds = event.beats * this.#secondsPerBeat;
          for (const sink of breakSinks) sink.playBreak?.(event, time, seconds);
        }
      }
      if (!this.#loop) break;
      pass += 1;
    }
    this.#scheduledUntil = until;
  }

  #finish(): void {
    this.stop();
    this.onEnd?.();
  }

  #setSong(song: Song): void {
    const { events, total } = planSong(song);
    this.#events = events;
    this.#total = total;
    this.#secondsPerBeat = 60 / song.tempo;
    this.#beatsPerBar = song.meter.beats;
  }

  /** The loop range clipped to the song (the whole song without a range). */
  #bounds(): LoopRange {
    return loopBounds(this.#range, this.#total);
  }

  /** Timeline beat → song beat: wrapped into the loop range while looping, else clamped. */
  #songBeat(beat: number): number {
    if (!this.#loop) return Math.min(beat, this.#total);
    const { start, end } = this.#bounds();
    const length = end - start;
    if (beat < end || length <= 0) return beat;
    return beat - Math.floor((beat - start) / length) * length;
  }

  #beatAt(time: number): number {
    return this.#anchorBeat + (time - this.#anchorTime) / this.#secondsPerBeat;
  }

  #timeAt(beat: number): number {
    return this.#anchorTime + (beat - this.#anchorBeat) * this.#secondsPerBeat;
  }
}
