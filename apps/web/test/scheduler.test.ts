import type { NoteEvent, Song, Track } from '@crokychords/core';
import {
  MELODY_TRACK_ID,
  createSong,
  createTrack,
  defaultMelody,
  patternPreset,
  renderMelody,
  renderSong,
} from '@crokychords/core';
import { describe, expect, it } from 'vitest';
import type { DrumHit, DrumPatternId } from '../src/audio/instruments';
import { drumHits } from '../src/audio/instruments';
import type { MidiAccessLike } from '../src/midi/webmidi';
import { MidiOut } from '../src/midi/webmidi';
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

  it('merges the melody into the band events by start time', () => {
    const notes = [0.5, 1, 3].map((beat) => ({
      beat,
      length: 0.5,
      degree: 3 as const,
      octave: 0,
      accidental: 0 as const,
    }));
    const withMelody: Song = { ...band, melody: { ...defaultMelody(), notes } };
    const { events } = planSong(withMelody);
    const melody = events.filter((e) => e.trackId === MELODY_TRACK_ID);
    expect(melody).toEqual(renderMelody(withMelody));
    expect(melody.map((e) => [e.start, e.channel])).toEqual([
      [0.5, 3],
      [1, 3],
      [3, 3],
    ]);
    const starts = events.map((e) => e.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    const muted: Song = { ...withMelody, melody: { ...defaultMelody(), muted: true, notes } };
    expect(planSong(muted).events.some((e) => e.trackId === MELODY_TRACK_ID)).toBe(false);
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

describe('Scheduler drums', () => {
  function drumHarness(pattern: () => DrumPatternId) {
    let now = 10;
    const hits: { hit: DrumHit; time: number }[] = [];
    const notes: NoteEvent[] = [];
    const drumSink: NoteSink = {
      playNote: (event) => notes.push(event),
      stopAll: () => undefined,
      playDrum: (hit, time) => hits.push({ hit, time }),
    };
    const midiLike: NoteSink = { playNote: () => undefined, stopAll: () => undefined };
    const timer: Timer = { setInterval: () => 1, clearInterval: () => undefined };
    const scheduler = new Scheduler({ now: () => now }, () => [drumSink, midiLike], timer, pattern);
    return {
      scheduler,
      hits,
      notes,
      advance(seconds: number) {
        const end = now + seconds;
        while (now < end - 1e-9) {
          now = Math.min(end, now + 0.025);
          scheduler.tick();
        }
      },
    };
  }

  /** One 4/4 bar of I at 120 BPM: 2 s. */
  const bar = createSong({ tempo: 120, chords: [{ token: 'I', beats: 4 }], tracks: [chordsTrack] });

  it('schedules the drum pattern on the audio clock, each hit once', () => {
    const h = drumHarness(() => 'straight');
    h.scheduler.start(bar);
    h.advance(3);
    expect(h.scheduler.playing).toBe(false);
    expect(h.hits.map((x) => x.hit)).toEqual(drumHits('straight', 4, 0, 4));
    const t0 = 10 + START_DELAY_S;
    const snare = h.hits.find((x) => x.hit.drum === 'snare');
    expect(snare?.time).toBeCloseTo(t0 + 0.5); // beat 1 at 0.5 s per beat
    expect(h.hits.at(-1)?.time).toBeCloseTo(t0 + 3.5 * 0.5);
  });

  it('restarts the bars on every loop pass', () => {
    const h = drumHarness(() => 'half-time');
    const short = { ...bar, chords: [{ token: 'I', beats: 3 }] }; // 3 beats in a 4/4 bar
    h.scheduler.start(short, { loop: true });
    h.advance(3 + START_DELAY_S); // two passes of 1.5 s
    const kicks = h.hits.filter((x) => x.hit.drum === 'kick').map((x) => x.hit.beat);
    expect(kicks).toEqual([0, 0, 0]);
    expect(h.hits.filter((x) => x.hit.drum === 'snare')).toHaveLength(2); // beat 2, once a pass
  });

  it('reads the pattern live: a change applies to hits not yet scheduled', () => {
    let pattern: DrumPatternId = 'none';
    const h = drumHarness(() => pattern);
    h.scheduler.start(bar);
    h.advance(0.5);
    expect(h.hits).toHaveLength(0);
    pattern = 'ballad';
    h.advance(3);
    expect(h.hits.length).toBeGreaterThan(0);
    expect(h.hits.every((x) => x.hit.beat >= 1)).toBe(true);
    expect(h.notes).toHaveLength(3);
  });

  it('plays no drums by default and never to sinks without playDrum', () => {
    const played: number[] = [];
    const sink: NoteSink = { playNote: (e) => played.push(e.note), stopAll: () => undefined };
    let asked = 0;
    const scheduler = new Scheduler(
      { now: () => 0 },
      () => [sink],
      { setInterval: () => 1, clearInterval: () => undefined },
      () => {
        asked++;
        return 'straight';
      },
    );
    scheduler.start(bar);
    expect(played).toEqual([60, 64, 67]);
    expect(asked).toBe(0);
  });
});

describe('Scheduler loop range', () => {
  // Four one-bar chords at 120 BPM: bar n starts at n * 2 s.
  const fourBars = createSong({
    tempo: 120,
    chords: ['I', 'IV', 'V', 'vi'].map((token) => ({ token, beats: 4 })),
    tracks: [chordsTrack],
  });

  function loopHarness() {
    const h = harness();
    const wraps: number[] = [];
    const sink: NoteSink = {
      playNote: (event, time, duration) => h.played.push({ event, time, duration }),
      stopAll: () => undefined,
      loopWrap: (time) => wraps.push(time),
    };
    let now = 10;
    const timer: Timer = { setInterval: () => 1, clearInterval: () => undefined };
    const scheduler = new Scheduler({ now: () => now }, () => [sink], timer);
    return {
      scheduler,
      played: h.played,
      wraps,
      advance(seconds: number) {
        const end = now + seconds;
        while (now < end - 1e-9) {
          now = Math.min(end, now + 0.025);
          scheduler.tick();
        }
      },
    };
  }

  const t0 = 10 + START_DELAY_S;

  it('wraps from the loop end to the loop start without a gap', () => {
    const h = loopHarness();
    h.scheduler.start(fourBars, { loop: true, range: { start: 4, end: 12 }, fromBeat: 4 });
    h.advance(8.5); // two passes of the 4 s range, and a bit
    const starts = [...new Set(h.played.map((p) => Math.round((p.time - t0) * 100) / 100))];
    // IV at 0 s, V at 2 s, wrap: IV at 4 s, V at 6 s, IV at 8 s.
    expect(starts).toEqual([0, 2, 4, 6, 8]);
    const firstNotes = [...new Set(h.played.map((p) => p.event.start))];
    expect(firstNotes).toEqual([4, 8]); // only IV and V, never I or vi
    expect(h.wraps.map((t) => Math.round((t - t0) * 100) / 100)).toEqual([4, 8]);
    const position = h.scheduler.position() ?? -1;
    expect(position).toBeGreaterThanOrEqual(4);
    expect(position).toBeLessThan(12);
  });

  it('plays into the range from an earlier beat, then loops the range', () => {
    const h = loopHarness();
    h.scheduler.start(fourBars, { loop: true, range: { start: 8, end: 12 }, fromBeat: 0 });
    h.advance(8.2);
    const firsts = h.played.filter(
      (_, i, all) => all.findIndex((p) => p.time === all[i]?.time) === i,
    );
    expect(firsts.map((p) => [p.event.start, Math.round((p.time - t0) * 100) / 100])).toEqual([
      [0, 0],
      [4, 2],
      [8, 4],
      [8, 6], // wrapped: bar 3 again right after its end
      [8, 8],
    ]);
    expect(h.wraps.map((t) => Math.round((t - t0) * 100) / 100)).toEqual([6, 8]);
  });

  it('cuts notes at the loop end', () => {
    const long = createSong({
      tempo: 120,
      chords: [{ token: 'I', beats: 8 }],
      tracks: [chordsTrack],
    });
    const h = loopHarness();
    h.scheduler.start(long, { loop: true, range: { start: 0, end: 2 } });
    expect(h.played[0]?.duration).toBeCloseTo(2 * 0.5); // a 3.6-beat note cut to 2 beats
    h.advance(1.1);
    expect(h.played.filter((p) => p.event.note === 60)).toHaveLength(2);
    expect(h.wraps).toHaveLength(1);
  });

  it('loops the melody with the range and cuts it at the loop end', () => {
    const melodic: Song = {
      ...fourBars,
      tracks: [],
      melody: {
        ...defaultMelody(),
        notes: [1, 3, 5, 6].map((beat) => ({
          beat,
          length: 2,
          degree: 1 as const,
          octave: 0,
          accidental: 0 as const,
        })),
      },
    };
    const h = loopHarness();
    h.scheduler.start(melodic, { loop: true, range: { start: 0, end: 4 } });
    h.advance(4.2); // two passes of the 2 s range
    const notes = h.played.map((p) => [p.event.trackId, p.event.start]);
    expect(notes).toEqual([
      [MELODY_TRACK_ID, 1],
      [MELODY_TRACK_ID, 3],
      [MELODY_TRACK_ID, 1],
      [MELODY_TRACK_ID, 3],
    ]);
    // The note at beat 3 crosses the loop end at 4: cut to one beat (0.5 s).
    expect(h.played[1]?.duration).toBeCloseTo(0.5);
    expect(h.wraps).toHaveLength(2);
  });

  it('starts at the loop start when started past the loop end', () => {
    const h = loopHarness();
    h.scheduler.start(fourBars, { loop: true, range: { start: 4, end: 8 }, fromBeat: 12 });
    expect(h.played.length).toBeGreaterThan(0);
    expect(new Set(h.played.map((p) => p.event.start))).toEqual(new Set([4]));
  });

  it('ignores a range outside the song and loops the whole song instead', () => {
    const h = loopHarness();
    h.scheduler.start(fourBars, { loop: true, range: { start: 20, end: 24 } });
    h.advance(8.2);
    expect(h.wraps.map((t) => Math.round((t - t0) * 100) / 100)).toEqual([8]);
  });

  it('applies a new range while playing, jumping when the playhead is past its end', () => {
    const h = loopHarness();
    h.scheduler.start(fourBars, { loop: true });
    h.advance(5); // beat 10: bar 3
    h.scheduler.setLoop(true, { start: 0, end: 4 });
    const position = h.scheduler.position() ?? -1;
    expect(position).toBeGreaterThanOrEqual(0);
    expect(position).toBeLessThan(4);
    h.played.length = 0;
    h.advance(4);
    expect(new Set(h.played.map((p) => p.event.start))).toEqual(new Set([0]));
  });

  it('stops looping when looping is turned off mid-pass', () => {
    const h = loopHarness();
    let ended = 0;
    h.scheduler.onEnd = () => ended++;
    h.scheduler.start(fourBars, { loop: true, range: { start: 0, end: 4 } });
    h.advance(3); // second pass of bar 1
    h.scheduler.setLoop(false);
    h.advance(8);
    expect(ended).toBe(1);
    expect(h.wraps).toHaveLength(1);
  });

  it('sends MIDI all-notes-off at the wrap, before the next pass', () => {
    const sent: { data: number[]; time: number | undefined }[] = [];
    const access: MidiAccessLike = {
      outputs: {
        forEach: (fn) =>
          fn({ id: 'p', name: 'p', send: (data, time) => sent.push({ data, time }) }),
      },
      addEventListener: () => undefined,
    };
    const midi = new MidiOut(() => Promise.resolve(access));
    return midi.enable().then(() => {
      midi.select('p');
      let now = 10;
      const sink: NoteSink = {
        playNote: (e, time, duration) =>
          midi.playNote(e.channel, e.note, e.velocity, time * 1000, duration * 1000),
        stopAll: () => midi.allNotesOff(),
        loopWrap: (time) => midi.notesOffAt([0], time * 1000),
      };
      const scheduler = new Scheduler({ now: () => now }, () => [sink], {
        setInterval: () => 1,
        clearInterval: () => undefined,
      });
      scheduler.start(fourBars, { loop: true, range: { start: 0, end: 4 } });
      while (now < 12.1) {
        now += 0.025;
        scheduler.tick();
      }
      const wrapAt = (t0 + 2) * 1000;
      const cc = sent.findIndex((m) => m.data[0] === 0xb0 && m.data[1] === 123);
      expect(cc).toBeGreaterThan(0);
      expect(sent[cc]?.time).toBeCloseTo(wrapAt);
      // Note-offs for the held triad go out at the wrap, then the next pass's note-ons.
      const offs = sent
        .slice(0, cc)
        .filter((m) => m.data[0] === 0x80 && Math.abs((m.time ?? 0) - wrapAt) < 1e-6);
      expect(offs.length).toBeGreaterThanOrEqual(3);
      const after = sent.slice(cc + 1).filter((m) => m.data[0] === 0x90);
      expect(after.map((m) => m.data[1])).toEqual([60, 64, 67]);
      expect(after[0]?.time).toBeCloseTo(wrapAt);
    });
  });
});
