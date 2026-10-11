/**
 * Lookahead scheduler (Chris Wilson, "A Tale of Two Clocks"): a coarse timer wakes every
 * 25 ms and schedules every chord that starts within the next 100 ms on the precise audio
 * clock. Sinks (synth, Web MIDI) receive audio-clock times.
 */
import type { Song } from '@crokychords/core';
import { isRestToken, songKey, tryParseToken, voiceChord } from '@crokychords/core';

export const TICK_MS = 25;
export const LOOKAHEAD_S = 0.1;
/** Delay between pressing Play and the first note, so the first chord is not clipped. */
export const START_DELAY_S = 0.06;
/** Notes last this fraction of the chord (a tiny gap re-articulates repeated chords). */
export const GATE = 0.98;

export interface Clock {
  /** Seconds on the audio clock. */
  now(): number;
}

export interface ChordSink {
  playChord(notes: readonly number[], time: number, duration: number): void;
  stopAll(): void;
}

export interface Timer {
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
}

export interface PlannedChord {
  index: number;
  start: number;
  beats: number;
  notes: number[];
}

/** The song as note events in beats; rests and unparseable tokens only advance time. */
export function planSong(song: Song): { events: PlannedChord[]; total: number } {
  const key = songKey(song);
  const events: PlannedChord[] = [];
  let beat = 0;
  song.chords.forEach((c, index) => {
    const chord = isRestToken(c.token) ? undefined : tryParseToken(c.token);
    if (chord !== undefined) {
      events.push({ index, start: beat, beats: c.beats, notes: voiceChord(chord, key) });
    }
    beat += c.beats;
  });
  return { events, total: beat };
}

export interface StartOptions {
  fromBeat?: number;
  loop?: boolean;
}

export class Scheduler {
  readonly #clock: Clock;
  readonly #sinks: () => readonly ChordSink[];
  readonly #timer: Timer;

  #timerId: number | null = null;
  #events: PlannedChord[] = [];
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

  constructor(clock: Clock, sinks: () => readonly ChordSink[], timer?: Timer) {
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

  /** Follow edits while playing: re-anchor at the current position with the new tempo. */
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
    let pass = Math.floor(this.#scheduledUntil / this.#total);
    while (pass * this.#total < until) {
      const offset = pass * this.#total;
      for (const event of this.#events) {
        const beat = offset + event.start;
        if (beat < this.#scheduledUntil || beat >= until) continue;
        const time = this.#timeAt(beat);
        const duration = event.beats * GATE * this.#secondsPerBeat;
        for (const sink of sinks) sink.playChord(event.notes, time, duration);
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
