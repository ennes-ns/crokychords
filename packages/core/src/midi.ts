import type { VoicingOptions } from './chords';
import { voiceChord } from './chords';
import type { Song } from './progression';
import { songKey } from './progression';
import type { Mode } from './theory';
import { keySignature } from './theory';
import { isRestToken, parseToken } from './token';

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
  /** Default: song.title. */
  trackName?: string;
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

/**
 * Standard MIDI File, format 0, one track. Running status is not used. One beat of the
 * song is one quarter note (`ppq` ticks); rests advance time only.
 */
export function songToMidi(song: Song, opts: MidiOptions = {}): Uint8Array {
  const ppq = checkInt('ppq', opts.ppq ?? 480, 1, 0x7fff);
  const channel = checkInt('channel', opts.channel ?? 0, 0, 15);
  const velocity = checkInt('velocity', opts.velocity ?? 96, 1, 127);
  const gate = opts.gate ?? 0.98;
  if (!(gate > 0 && gate <= 1)) throw new RangeError(`gate must be in (0, 1], got ${gate}`);
  const voicing: VoicingOptions = {};
  if (opts.bassOctave !== undefined) voicing.bassOctave = opts.bassOctave;
  if (opts.octave !== undefined) voicing.octave = opts.octave;

  const key = songKey(song);
  const meta: number[] = [];
  const name = utf8(opts.trackName ?? song.title);
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

  const events: TimedEvent[] = [];
  let beat = 0;
  for (const chord of song.chords) {
    const start = Math.round(beat * ppq);
    beat += chord.beats;
    if (isRestToken(chord.token)) continue;
    const length = Math.max(1, Math.round(chord.beats * gate * ppq));
    const notes = [...new Set(voiceChord(parseToken(chord.token), key, voicing))];
    for (const note of notes) {
      checkInt('note', note, 0, 127);
      events.push({ tick: start, order: 1, bytes: [0x90 | channel, note, velocity] });
      events.push({
        tick: start + length,
        order: 0,
        bytes: [0x80 | channel, note, NOTE_OFF_VELOCITY],
      });
    }
  }
  // Stable sort: note-offs before note-ons at the same tick, otherwise insertion order.
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const track = [...meta];
  let now = 0;
  for (const e of events) {
    track.push(...encodeVlq(e.tick - now), ...e.bytes);
    now = e.tick;
  }
  const end = Math.max(now, Math.round(beat * ppq));
  track.push(...encodeVlq(end - now), 0xff, 0x2f, 0x00);

  const header = [0x4d, 0x54, 0x68, 0x64, ...uint32(6), ...uint16(0), ...uint16(1), ...uint16(ppq)];
  const trackHeader = [0x4d, 0x54, 0x72, 0x6b, ...uint32(track.length)];
  return Uint8Array.from([...header, ...trackHeader, ...track]);
}
