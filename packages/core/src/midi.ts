import type { VoicingOptions } from './chords';
import { voiceChord } from './chords';
import { MELODY_TRACK_ID } from './melody';
import type { Song } from './progression';
import { songKey, totalBeats } from './progression';
import { renderMelody, renderTrack } from './render';
import type { NoteEvent } from './render';
import type { Mode } from './theory';
import { keySignature } from './theory';
import { isRestToken, parseToken } from './token';
import type { Track } from './tracks';

/**
 * `channel`, `velocity`, `bassOctave`, `octave` and `gate` only apply to songs without tracks
 * (format 0); with tracks they come from each track.
 */
export interface MidiOptions {
  /** Ticks per quarter note, default 480. */
  ppq?: number;
  /** 0-15, default 0. */
  channel?: number;
  /** 1-127, default 96. */
  velocity?: number;
  /** Passed to voiceChord. */
  bassOctave?: number;
  /** Passed to voiceChord. */
  octave?: number;
  /** 0 < gate <= 1: note length as a fraction of the chord's beats, default 0.98. */
  gate?: number;
  /** Name of the (conductor) track. Default: song.title. */
  trackName?: string;
  /** Also write muted tracks (format 1), default false. */
  includeMuted?: boolean;
  /**
   * General MIDI program (0-127) per track id, or `MELODY_TRACK_ID` for the melody (format 1):
   * the track gets a Program Change at tick 0. Tracks without an entry get none.
   */
  programs?: Readonly<Record<string, number>>;
}

const NOTE_OFF_VELOCITY = 64;

/** Modes written with the minor flag in the key signature meta event. */
const MINOR_FLAG_MODES: ReadonlySet<Mode> = new Set<Mode>([
  'minor',
  'dorian',
  'phrygian',
  'locrian',
  'harmonicMinor',
  'phrygianDominant',
]);

/** Variable-length quantity as used for delta times and meta lengths. */
export function encodeVlq(value: number): number[] {
  if (!Number.isInteger(value) || value < 0 || value > 0x0fffffff) {
    throw new RangeError(`VLQ out of range: ${value}`);
  }
  const bytes = [value & 0x7f];
  let rest = value >>> 7;
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  return bytes;
}

/** UTF-8 bytes of a string (kept local so the writer needs no DOM or Node API). */
function utf8(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return out;
}

function uint32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function uint16(n: number): number[] {
  return [(n >>> 8) & 0xff, n & 0xff];
}

function checkInt(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer in ${min}..${max}, got ${value}`);
  }
  return value;
}

interface TimedEvent {
  tick: number;
  /** Sort key within a tick: 0 = note-off, 1 = note-on. */
  order: number;
  bytes: number[];
}

/** Track name, tempo, time signature and key signature at tick 0. */
function conductorMeta(song: Song, trackName: string): number[] {
  const key = songKey(song);
  const meta: number[] = [];
  const name = utf8(trackName);
  meta.push(0, 0xff, 0x03, ...encodeVlq(name.length), ...name);
  const usPerQuarter = Math.round(60_000_000 / song.tempo);
  checkInt('microseconds per quarter', usPerQuarter, 1, 0xffffff);
  meta.push(0, 0xff, 0x51, 0x03, (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff);
  meta.push(usPerQuarter & 0xff);
  const numerator = checkInt('meter.beats', song.meter.beats, 1, 255);
  const denominatorPower = Math.log2(song.meter.unit);
  checkInt('log2(meter.unit)', denominatorPower, 0, 7);
  meta.push(0, 0xff, 0x58, 0x04, numerator, denominatorPower, 24, 8);
  const sf = keySignature(key);
  meta.push(0, 0xff, 0x59, 0x02, sf & 0xff, MINOR_FLAG_MODES.has(key.mode) ? 1 : 0);
  return meta;
}

/** Track chunk body: `head` (delta-timed bytes at tick 0), the events, end of track at >= `end`. */
function trackBody(head: readonly number[], events: TimedEvent[], end: number): number[] {
  // Stable sort: note-offs before note-ons at the same tick, otherwise insertion order.
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const track = [...head];
  let now = 0;
  for (const e of events) {
    track.push(...encodeVlq(e.tick - now), ...e.bytes);
    now = e.tick;
  }
  track.push(...encodeVlq(Math.max(now, end) - now), 0xff, 0x2f, 0x00);
  return track;
}

function chunk(body: readonly number[]): number[] {
  return [0x4d, 0x54, 0x72, 0x6b, ...uint32(body.length), ...body];
}

function smf(
  format: 0 | 1,
  ppq: number,
  tracks: readonly (readonly number[])[],
): Uint8Array<ArrayBuffer> {
  const bytes = [
    ...[0x4d, 0x54, 0x68, 0x64, ...uint32(6), ...uint16(format), ...uint16(tracks.length)],
    ...uint16(ppq),
    ...tracks.flatMap(chunk),
  ];
  const out = new Uint8Array(new ArrayBuffer(bytes.length));
  out.set(bytes);
  return out;
}

function noteEvents(
  channel: number,
  note: number,
  velocity: number,
  on: number,
  off: number,
): TimedEvent[] {
  checkInt('note', note, 0, 127);
  return [
    { tick: on, order: 1, bytes: [0x90 | channel, note, velocity] },
    { tick: off, order: 0, bytes: [0x80 | channel, note, NOTE_OFF_VELOCITY] },
  ];
}

/**
 * Standard MIDI File. One beat of the song is one quarter note (`ppq` ticks); rests advance
 * time only. Running status is not used; note-offs come before note-ons at the same tick.
 *
 * - Song with `tracks` (schema 2): format 1. Track 0 is the conductor (name, tempo, time and
 *   key signature); then one track per unmuted track (all with `opts.includeMuted`) in song
 *   order, each with a track name, a MIDI channel prefix, a Program Change when
 *   `opts.programs` names the track, and the events of renderTrack on the track's channel.
 *   Then, when the melody has notes and is unmuted (or `opts.includeMuted`), a track named
 *   'Melody' with renderMelody's events on its channel (and `opts.programs.melody`).
 * - Song without `tracks` (schema 1): format 0, one track, every chord voiced with
 *   voiceChord and held for `beats * gate`.
 */
export function songToMidi(song: Song, opts: MidiOptions = {}): Uint8Array<ArrayBuffer> {
  const ppq = checkInt('ppq', opts.ppq ?? 480, 1, 0x7fff);
  if (song.tracks !== undefined) return multiTrackMidi(song, song.tracks, ppq, opts);

  const channel = checkInt('channel', opts.channel ?? 0, 0, 15);
  const velocity = checkInt('velocity', opts.velocity ?? 96, 1, 127);
  const gate = opts.gate ?? 0.98;
  if (!(gate > 0 && gate <= 1)) throw new RangeError(`gate must be in (0, 1], got ${gate}`);
  const voicing: VoicingOptions = {};
  if (opts.bassOctave !== undefined) voicing.bassOctave = opts.bassOctave;
  if (opts.octave !== undefined) voicing.octave = opts.octave;

  const key = songKey(song);
  const events: TimedEvent[] = [];
  let beat = 0;
  for (const chord of song.chords) {
    const start = Math.round(beat * ppq);
    beat += chord.beats;
    if (isRestToken(chord.token)) continue;
    const length = Math.max(1, Math.round(chord.beats * gate * ppq));
    const notes = [...new Set(voiceChord(parseToken(chord.token), key, voicing))];
    for (const note of notes) {
      events.push(...noteEvents(channel, note, velocity, start, start + length));
    }
  }
  const head = conductorMeta(song, opts.trackName ?? song.title);
  return smf(0, ppq, [trackBody(head, events, Math.round(beat * ppq))]);
}

function multiTrackMidi(
  song: Song,
  tracks: readonly Track[],
  ppq: number,
  opts: MidiOptions,
): Uint8Array<ArrayBuffer> {
  const end = Math.round(totalBeats(song) * ppq);
  const chunks = [trackBody(conductorMeta(song, opts.trackName ?? song.title), [], end)];
  const includeMuted = opts.includeMuted === true;
  for (const track of tracks) {
    if (track.muted && !includeMuted) continue;
    const events = renderTrack(song, track, { includeMuted: true });
    const program = opts.programs?.[track.id];
    chunks.push(eventTrack(track.name, track.channel, events, ppq, end, program));
  }
  const melody = song.melody;
  if (melody !== undefined && melody.notes.length > 0 && (!melody.muted || includeMuted)) {
    const events = renderMelody(song, { includeMuted: true });
    const program = opts.programs?.[MELODY_TRACK_ID];
    chunks.push(eventTrack(MELODY_TRACK_NAME, melody.channel, events, ppq, end, program));
  }
  return smf(1, ppq, chunks);
}

/** Name of the melody track in the exported file. */
export const MELODY_TRACK_NAME = 'Melody';

/**
 * Track chunk body: name, channel prefix, an optional Program Change at tick 0 and the note
 * events on `channel`.
 */
function eventTrack(
  trackName: string,
  trackChannel: number,
  notes: readonly NoteEvent[],
  ppq: number,
  end: number,
  program?: number,
): number[] {
  const channel = checkInt('track.channel', trackChannel, 0, 15);
  const name = utf8(trackName);
  const head = [0, 0xff, 0x03, ...encodeVlq(name.length), ...name, 0, 0xff, 0x20, 0x01, channel];
  if (program !== undefined) head.push(0, 0xc0 | channel, checkInt('program', program, 0, 127));
  const events: TimedEvent[] = [];
  for (const e of notes) {
    const velocity = checkInt('track.velocity', e.velocity, 1, 127);
    const on = Math.round(e.start * ppq);
    const off = Math.max(on + 1, Math.round((e.start + e.duration) * ppq));
    events.push(...noteEvents(channel, e.note, velocity, on, off));
  }
  return trackBody(head, events, end);
}
