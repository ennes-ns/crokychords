import { createSong, parseToken, songKey, voiceChord } from '@crokychords/core';
import { describe, expect, it } from 'vitest';
import type { ChordSink, Timer } from '../src/audio/scheduler';
import { GATE, LOOKAHEAD_S, START_DELAY_S, Scheduler, planSong } from '../src/audio/scheduler';

const song = createSong({
  tempo: 120, // 0.5 s per beat
  chords: [
    { token: 'I', beats: 2 },
    { token: 'rest', beats: 1 },
    { token: 'V', beats: 1 },
  ],
});

function harness() {
  let now = 10;
  const played: { notes: readonly number[]; time: number; duration: number }[] = [];
  let stops = 0;
  const sink: ChordSink = {
    playChord: (notes, time, duration) => played.push({ notes, time, duration }),
    stopAll: () => stops++,
  };
  let intervals = 0;
  const timer: Timer = {
    setInterval: () => ++intervals,
    clearInterval: () => undefined,
  };
  const scheduler = new Scheduler({ now: () => now }, () => [sink], timer);
  return {
    scheduler,
    played,
    stops: () => stops,
    advance(seconds: number) {
      // Wake up every 25 ms like the real timer.
      const end = now + seconds;
      while (now < end - 1e-9) {
        now = Math.min(end, now + 0.025);
        scheduler.tick();
      }
    },
    get now() {
      return now;
    },
  };
}

describe('planSong', () => {
  it('voices chords and skips rests', () => {
    const { events, total } = planSong(song);
    expect(total).toBe(4);
    expect(events.map((e) => [e.index, e.start, e.beats])).toEqual([
      [0, 0, 2],
      [2, 3, 1],
    ]);
    expect(events[0]?.notes).toEqual(voiceChord(parseToken('I'), songKey(song)));
  });
});

describe('Scheduler', () => {
  it('schedules chords ahead on the audio clock and stops at the end', () => {
    const h = harness();
    let ended = 0;
    h.scheduler.onEnd = () => ended++;
    h.scheduler.start(song);
    const t0 = 10 + START_DELAY_S;
    expect(h.played).toHaveLength(1);
    expect(h.played[0]?.time).toBeCloseTo(t0);
    expect(h.played[0]?.duration).toBeCloseTo(2 * 0.5 * GATE);

    h.advance(1.5 + START_DELAY_S - LOOKAHEAD_S - 0.05);
    expect(h.played).toHaveLength(1);
    h.advance(0.075); // V at beat 3 = t0 + 1.5 s enters the lookahead window
    expect(h.played).toHaveLength(2);
    expect(h.played[1]?.time).toBeCloseTo(t0 + 1.5);
    expect(h.scheduler.position()).toBeGreaterThan(2);

    h.advance(1);
    expect(h.scheduler.playing).toBe(false);
    expect(ended).toBe(1);
    expect(h.stops()).toBe(1);
    expect(h.played).toHaveLength(2);
    expect(h.scheduler.position()).toBeNull();
  });

  it('loops', () => {
    const h = harness();
    h.scheduler.start(song, { loop: true });
    h.advance(4.2); // a bit more than two passes of 2 s
    const times = h.played.map((p) => p.time - (10 + START_DELAY_S));
    expect(times.map((t) => Math.round(t * 100) / 100)).toEqual([0, 1.5, 2, 3.5, 4]);
    expect(h.scheduler.playing).toBe(true);
    const position = h.scheduler.position();
    expect(position).not.toBeNull();
    expect(position ?? -1).toBeLessThan(4);
  });

  it('starts from a beat', () => {
    const h = harness();
    h.scheduler.start(song, { fromBeat: 3 });
    expect(h.played).toHaveLength(1);
    expect(h.played[0]?.notes).toEqual(voiceChord(parseToken('V'), songKey(song)));
  });

  it('does nothing for an empty song and stops on demand', () => {
    const h = harness();
    h.scheduler.start(createSong());
    expect(h.scheduler.playing).toBe(false);
    h.scheduler.start(song, { loop: true });
    h.scheduler.stop();
    expect(h.scheduler.playing).toBe(false);
    expect(h.stops()).toBe(1);
  });

  it('follows tempo changes while playing', () => {
    const h = harness();
    h.scheduler.start(song);
    h.advance(0.56); // beat 1 at 120 BPM
    h.scheduler.update({ ...song, tempo: 60 });
    h.advance(1.95); // V at beat 3 is now 2 s after beat 1
    expect(h.played).toHaveLength(2);
    expect(h.played[1]?.time).toBeCloseTo(10 + START_DELAY_S + 0.5 + 2, 1);
  });
});
