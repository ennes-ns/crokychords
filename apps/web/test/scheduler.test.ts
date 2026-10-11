import type { NoteEvent, Song, Track } from '@crokychords/core';
import { createSong, createTrack, patternPreset, renderSong } from '@crokychords/core';
import { describe, expect, it } from 'vitest';
import type { NoteSink, Timer } from '../src/audio/scheduler';
import {
  LOOKAHEAD_S,
  START_DELAY_S,
  Scheduler,
  firstEventAt,
  planSong,
} from '../src/audio/scheduler';

const chordsTrack = createTrack('chords', {
  id: 'trk-chords',
  channel: 0,
  pattern: patternPreset('whole'),
});
const bassTrack = createTrack('bass', { id: 'trk-bass', channel: 1 }); // bass-quarters
const arpTrack = createTrack('arp', { id: 'trk-arp', channel: 2, muted: true });

const songWith = (tracks: Track[]) =>
  createSong({
    tempo: 120, // 0.5 s per beat
    chords: [
      { token: 'I', beats: 2 },
      { token: 'rest', beats: 1 },
      { token: 'V', beats: 1 },
    ],
    tracks,
  });

const song = songWith([chordsTrack]);
const band = songWith([chordsTrack, bassTrack, arpTrack]);

interface Played {
  event: NoteEvent;
  time: number;
  duration: number;
}

function harness() {
  let now = 10;
  const played: Played[] = [];
  let stops = 0;
  const sink: NoteSink = {
    playNote: (event, time, duration) => played.push({ event, time, duration }),
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

/** Distinct start times (seconds after the first note), rounded to 10 ms. */
const startTimes = (played: Played[]) => [
  ...new Set(played.map((p) => Math.round((p.time - (10 + START_DELAY_S)) * 100) / 100)),
];

describe('planSong', () => {
  it('renders the unmuted tracks with core and keeps the song length', () => {
    const { events, total } = planSong(band);
    expect(total).toBe(4);
    expect(events).toEqual(renderSong(band, band.tracks ?? []));
    expect(events.some((e) => e.trackId === 'trk-arp')).toBe(false);
    expect(new Set(events.map((e) => e.channel))).toEqual(new Set([0, 1]));
  });

  it('plays nothing for a song object without tracks', () => {
    const legacy: Song = { ...song, schema: 1 };
    delete legacy.tracks;
    expect(planSong(legacy).events).toEqual([]);
  });
});

describe('firstEventAt', () => {
  it('binary-searches the first event at or after a beat', () => {
    const { events } = planSong(band);
    expect(firstEventAt(events, 0)).toBe(0);
    const i = firstEventAt(events, 0.5);
    expect(events[i]?.start).toBe(1);
    expect(events[i - 1]?.start).toBe(0);
    expect(firstEventAt(events, 99)).toBe(events.length);
    expect(firstEventAt([], 1)).toBe(0);
  });
});

describe('Scheduler', () => {
  it('schedules note events ahead on the audio clock and stops at the end', () => {
    const h = harness();
    let ended = 0;
    h.scheduler.onEnd = () => ended++;
    h.scheduler.start(song);
    const t0 = 10 + START_DELAY_S;
    expect(h.played.map((p) => p.event.note)).toEqual([60, 64, 67]); // I in C, octave 4
    expect(h.played[0]?.time).toBeCloseTo(t0);
    expect(h.played[0]?.duration).toBeCloseTo(2 * 0.9 * 0.5); // 2 beats, gate 0.9

    h.advance(1.5 + START_DELAY_S - LOOKAHEAD_S - 0.05);
    expect(h.played).toHaveLength(3);
    h.advance(0.075); // V at beat 3 = t0 + 1.5 s enters the lookahead window
    expect(h.played).toHaveLength(6);
    expect(h.played[3]?.time).toBeCloseTo(t0 + 1.5);
    expect(h.played[3]?.duration).toBeCloseTo(0.9 * 0.5);
    expect(h.scheduler.position()).toBeGreaterThan(2);

    h.advance(1);
    expect(h.scheduler.playing).toBe(false);
    expect(ended).toBe(1);
    expect(h.stops()).toBe(1);
    expect(h.played).toHaveLength(6);
    expect(h.scheduler.position()).toBeNull();
  });

  it('batches the events of every unmuted track by lookahead window, each exactly once', () => {
    const h = harness();
    h.scheduler.start(band);
    // First wake-up: beat 0 only (chords triad + bass note), nothing from the muted arp.
    expect(h.played.map((p) => [p.event.channel, p.event.note])).toEqual([
      [0, 60],
      [0, 64],
      [0, 67],
      [1, 36],
    ]);
    h.advance(0.5); // horizon now past beat 1 (t0 + 0.5 s): the second bass quarter
    expect(h.played).toHaveLength(5);
    expect(h.played[4]?.event).toMatchObject({ trackId: 'trk-bass', start: 1 });
    expect(h.played[4]?.time).toBeCloseTo(10 + START_DELAY_S + 0.5);

    h.advance(3);
    const expected = renderSong(band, band.tracks ?? []);
    expect(h.played.map((p) => p.event)).toEqual(expected);
    expect(h.played.every((p) => p.event.trackId !== 'trk-arp')).toBe(true);
    // Bass notes use the event's beats → seconds: 0.9 beats * gate 0.9 * 0.5 s.
    const bass = h.played.find((p) => p.event.trackId === 'trk-bass');
    expect(bass?.duration).toBeCloseTo(0.9 * 0.9 * 0.5);
  });

  it('loops by restarting the event list', () => {
    const h = harness();
    h.scheduler.start(song, { loop: true });
    h.advance(4.2); // a bit more than two passes of 2 s
    expect(startTimes(h.played)).toEqual([0, 1.5, 2, 3.5, 4]);
    expect(h.played).toHaveLength(15);
    expect(h.scheduler.playing).toBe(true);
    const position = h.scheduler.position();
    expect(position).not.toBeNull();
    expect(position ?? -1).toBeLessThan(4);
  });

  it('starts from a beat', () => {
    const h = harness();
    h.scheduler.start(song, { fromBeat: 3 });
    expect(h.played.map((p) => p.event.note)).toEqual([67, 71, 74]); // V: G B D
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
    expect(h.scheduler.secondsPerBeat).toBe(1);
    h.advance(1.95); // V at beat 3 is now 2 s after beat 1
    expect(h.played).toHaveLength(6);
    expect(h.played[3]?.time).toBeCloseTo(10 + START_DELAY_S + 0.5 + 2, 1);
  });

  it('follows track edits while playing (muting a track stops its future notes)', () => {
    const h = harness();
    h.scheduler.start(band);
    h.advance(0.2);
    const muted = { ...band, tracks: [chordsTrack, { ...bassTrack, muted: true }, arpTrack] };
    h.scheduler.update(muted);
    h.advance(3);
    const bassStarts = h.played.filter((p) => p.event.trackId === 'trk-bass');
    expect(bassStarts.map((p) => p.event.start)).toEqual([0]);
    expect(h.played.filter((p) => p.event.trackId === 'trk-chords')).toHaveLength(6);
  });
});
