/**
 * Lookahead scheduler (Chris Wilson, "A Tale of Two Clocks"): a coarse timer wakes every
 * 25 ms and schedules every note event (from core's `renderSong`) that starts within the next
 * 100 ms on the precise audio clock. Sinks (synth, Web MIDI) receive audio-clock times.
 */
import type { NoteEvent, Song } from '@crokychords/core';
import { renderSong, totalBeats } from '@crokychords/core';

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
}

export interface Timer {
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
}

/** The song as note events in beats (unmuted tracks, sorted by start) and its length. */
export function planSong(song: Song): { events: NoteEvent[]; total: number } {
  return { events: renderSong(song, song.tracks ?? []), total: totalBeats(song) };
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
}

export class Scheduler {
  readonly #clock: Clock;
  readonly #sinks: () => readonly NoteSink[];
  readonly #timer: Timer;

  #timerId: number | null = null;
  #events: NoteEvent[] = [];
  #total = 0;
  #loop = false;
  #secondsPerBeat = 0.5;
  /** Absolute beats (they keep growing while looping) are anchored to an audio time. */
  #anchorTime = 0;
  #anchorBeat = 0;
  /** Everything before this absolute beat has been scheduled. */
  #scheduledUntil = 0;

  /** Called once when a non-looping song has played to its end. */
  onEnd: (() => void) | null = null;

  constructor(clock: Clock, sinks: () => readonly NoteSink[], timer?: Timer) {
    this.#clock = clock;
    this.#sinks = sinks;
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
    this.#setSong(song);
    if (this.#total <= 0) return;
    const from = Math.min(Math.max(0, options.fromBeat ?? 0), this.#total);
    this.#anchorBeat = from >= this.#total ? 0 : from;
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

  setLoop(loop: boolean): void {
    this.#loop = loop;
  }

  /**
   * Follow edits while playing (chords, tempo, tracks): re-render the events and re-anchor at
   * the current position with the new tempo. Already scheduled notes keep sounding.
   */
  update(song: Song): void {
    if (!this.playing) return;
    const now = this.#clock.now();
    const beat = Math.max(this.#anchorBeat, this.#beatAt(now));
    const shift = this.#total > 0 ? Math.floor(beat / this.#total) * this.#total : 0;
    this.#anchorBeat = beat - shift;
    this.#anchorTime = Math.max(now, this.#anchorTime);
    this.#scheduledUntil = Math.max(this.#anchorBeat, this.#scheduledUntil - shift);
    this.#setSong(song);
    if (this.#total <= 0) this.#finish();
  }

  /** Playhead in song beats (wrapped while looping), or null when stopped. */
  position(): number | null {
    if (!this.playing) return null;
    const beat = Math.max(this.#anchorBeat, this.#beatAt(this.#clock.now()));
    if (this.#loop && this.#total > 0) return beat % this.#total;
    return Math.min(beat, this.#total);
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
    const events = this.#events;
    let pass = Math.floor(this.#scheduledUntil / this.#total);
    while (pass * this.#total < until) {
      // Looping restarts the event list: pass k plays every event shifted by k song lengths.
      const offset = pass * this.#total;
      for (let i = firstEventAt(events, this.#scheduledUntil - offset); i < events.length; i++) {
        const event = events[i];
        if (event === undefined || offset + event.start >= until) break;
        const time = this.#timeAt(offset + event.start);
        const duration = event.duration * this.#secondsPerBeat;
        for (const sink of sinks) sink.playNote(event, time, duration);
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
  }

  #beatAt(time: number): number {
    return this.#anchorBeat + (time - this.#anchorTime) / this.#secondsPerBeat;
  }

  #timeAt(beat: number): number {
    return this.#anchorTime + (beat - this.#anchorBeat) * this.#secondsPerBeat;
  }
}
