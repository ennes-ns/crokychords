import type { Key, Mode } from './theory';
import { isMode, parseNoteName } from './theory';
import { isRestToken, TokenError, parseToken } from './token';

export interface SongChord {
  /** A `roman-numeral-v1` token or 'rest'. */
  token: string;
  /** > 0, a multiple of 0.25. One beat is one quarter note (MIDI ppq). */
  beats: number;
}

export interface Song {
  schema: 1;
  title: string;
  /** Tonic as a note name, e.g. 'C', 'F#', 'Bb'. */
  key: { tonic: string; mode: Mode };
  /** BPM (quarter notes per minute). */
  tempo: number;
  /** 4/4 is { beats: 4, unit: 4 }. */
  meter: { beats: number; unit: number };
  chords: SongChord[];
}

/** Thrown by validateSong / deserializeSong; `path` points at the offending value. */
export class SongError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(path === '' ? reason : `${path}: ${reason}`);
    this.name = 'SongError';
    this.path = path;
  }
}

export const DEFAULT_SONG_TITLE = 'Untitled';

/** A new song with defaults (C major, 120 BPM, 4/4, no chords) overridden by `partial`. Not validated. */
export function createSong(partial: Partial<Song> = {}): Song {
  return {
    schema: 1,
    title: partial.title ?? DEFAULT_SONG_TITLE,
    key: partial.key ? { ...partial.key } : { tonic: 'C', mode: 'major' },
    tempo: partial.tempo ?? 120,
    meter: partial.meter ? { ...partial.meter } : { beats: 4, unit: 4 },
    chords: (partial.chords ?? []).map((c) => ({ token: c.token, beats: c.beats })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new SongError(path, 'expected an object');
  return value;
}

function join(path: string, field: string): string {
  return path === '' ? field : `${path}.${field}`;
}

function stringField(obj: Record<string, unknown>, field: string, path: string): string {
  const value = obj[field];
  if (typeof value !== 'string') throw new SongError(join(path, field), 'expected a string');
  return value;
}

function numberField(obj: Record<string, unknown>, field: string, path: string): number {
  const value = obj[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SongError(join(path, field), 'expected a finite number');
  }
  return value;
}

const METER_UNITS = [1, 2, 4, 8, 16, 32];

/**
 * Check that `value` is a valid Song and return a normalised copy (unknown fields dropped).
 * Throws SongError with a path such as 'chords[3].beats'.
 */
export function validateSong(value: unknown): Song {
  const root = record(value, '');
  if (root['schema'] !== 1) throw new SongError('schema', 'expected 1');
  const title = stringField(root, 'title', '');

  const keyObj = record(root['key'], 'key');
  const tonic = stringField(keyObj, 'tonic', 'key');
  try {
    parseNoteName(tonic);
  } catch {
    throw new SongError('key.tonic', `invalid note name "${tonic}"`);
  }
  const mode = keyObj['mode'];
  if (!isMode(mode)) throw new SongError('key.mode', 'unknown mode');

  const tempo = numberField(root, 'tempo', '');
  if (tempo <= 0) throw new SongError('tempo', 'must be > 0');

  const meterObj = record(root['meter'], 'meter');
  const meterBeats = numberField(meterObj, 'beats', 'meter');
  if (!Number.isInteger(meterBeats) || meterBeats < 1) {
    throw new SongError('meter.beats', 'must be a positive integer');
  }
  const unit = numberField(meterObj, 'unit', 'meter');
  if (!METER_UNITS.includes(unit)) throw new SongError('meter.unit', 'must be 1, 2, 4, ..., 32');

  const rawChords = root['chords'];
  if (!Array.isArray(rawChords)) throw new SongError('chords', 'expected an array');
  const chords = rawChords.map((item: unknown, i): SongChord => {
    const path = `chords[${i}]`;
    const obj = record(item, path);
    const token = stringField(obj, 'token', path);
    if (!isRestToken(token)) {
      try {
        parseToken(token);
      } catch (e) {
        if (e instanceof TokenError) throw new SongError(`${path}.token`, e.message);
        throw e;
      }
    }
    const beats = numberField(obj, 'beats', path);
    if (beats <= 0 || !Number.isInteger(beats * 4)) {
      throw new SongError(`${path}.beats`, 'must be > 0 and a multiple of 0.25');
    }
    return { token, beats };
  });

  return {
    schema: 1,
    title,
    key: { tonic, mode },
    tempo,
    meter: { beats: meterBeats, unit },
    chords,
  };
}

export function songKey(song: Song): Key {
  return { tonic: parseNoteName(song.key.tonic), mode: song.key.mode };
}

export function totalBeats(song: Song): number {
  return song.chords.reduce((sum, c) => sum + c.beats, 0);
}

/** The chord (or rest) sounding at `beat` (0-based), or undefined outside the song. */
export function chordAtBeat(
  song: Song,
  beat: number,
): { index: number; chord: SongChord; start: number } | undefined {
  if (!(beat >= 0)) return undefined;
  let start = 0;
  for (const [index, chord] of song.chords.entries()) {
    if (beat < start + chord.beats) return { index, chord, start };
    start += chord.beats;
  }
  return undefined;
}

/** Tokens in order, rests removed (the context for suggestNext). */
export function songTokens(song: Song): string[] {
  return song.chords.map((c) => c.token).filter((t) => !isRestToken(t));
}

/** JSON (2-space indented) with a stable key order; unknown fields are dropped. */
export function serializeSong(song: Song): string {
  const ordered: Song = {
    schema: 1,
    title: song.title,
    key: { tonic: song.key.tonic, mode: song.key.mode },
    tempo: song.tempo,
    meter: { beats: song.meter.beats, unit: song.meter.unit },
    chords: song.chords.map((c) => ({ token: c.token, beats: c.beats })),
  };
  return JSON.stringify(ordered, null, 2);
}

/** Parse JSON and validate it. Throws SongError (path '' for a JSON syntax error). */
export function deserializeSong(json: string): Song {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (e) {
    throw new SongError('', `invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return validateSong(value);
}
