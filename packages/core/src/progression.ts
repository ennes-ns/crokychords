import type { Melody, MelodyNote } from './melody';
import {
  MAX_MELODY_NOTES,
  MELODY_ACCIDENTALS,
  MELODY_OCTAVE_MAX,
  MELODY_OCTAVE_MIN,
  MELODY_STEP,
  cloneMelody,
  defaultMelody,
} from './melody';
import { DEFAULT_TRACKS } from './patterns';
import type { Degree, Key, Mode } from './theory';
import { isMode, parseNoteName } from './theory';
import { isRestToken, TokenError, parseToken } from './token';
import type { NoteSelector, Pattern, PatternStep, Track } from './tracks';
import { NOTE_SELECTOR_NAMES, TRACK_ROLES, cloneTrack } from './tracks';

export interface SongChord {
  /** A `roman-numeral-v1` token or 'rest'. */
  token: string;
  /** > 0, a multiple of 0.25. One beat is one quarter note (MIDI ppq). */
  beats: number;
}

export interface Song {
  /**
   * 3 since melody v1 (2: tracks v1). validateSong migrates schema 1 (no tracks) and schema 2
   * (no melody).
   */
  schema: 1 | 2 | 3;
  title: string;
  /** Tonic as a note name, e.g. 'C', 'F#', 'Bb'. */
  key: { tonic: string; mode: Mode };
  /** BPM (quarter notes per minute). */
  tempo: number;
  /** 4/4 is { beats: 4, unit: 4 }. */
  meter: { beats: number; unit: number };
  chords: SongChord[];
  /** The band (schema 2). Undefined only for schema-1 song objects built by hand. */
  tracks?: Track[];
  /** The melody lane (schema 3). Undefined only for schema-1/2 song objects built by hand. */
  melody?: Melody;
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

/**
 * A new schema-3 song with defaults (C major, 120 BPM, 4/4, no chords, DEFAULT_TRACKS(), an
 * empty melody) overridden by `partial` (deep-copied; `partial.schema` is ignored). Not validated.
 */
export function createSong(partial: Partial<Song> = {}): Song {
  return {
    schema: 3,
    title: partial.title ?? DEFAULT_SONG_TITLE,
    key: partial.key ? { ...partial.key } : { tonic: 'C', mode: 'major' },
    tempo: partial.tempo ?? 120,
    meter: partial.meter ? { ...partial.meter } : { beats: 4, unit: 4 },
    chords: (partial.chords ?? []).map((c) => ({ token: c.token, beats: c.beats })),
    tracks: partial.tracks ? partial.tracks.map(cloneTrack) : DEFAULT_TRACKS(),
    melody: partial.melody ? cloneMelody(partial.melody) : defaultMelody(),
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

/** Highest tempo (BPM) a song may have; the editor offers 20–300. */
export const MAX_TEMPO = 1000;
/** Most beats per bar a song may have. */
export const MAX_METER_BEATS = 32;

function intField(
  obj: Record<string, unknown>,
  field: string,
  path: string,
  min: number,
  max: number,
): number {
  const value = numberField(obj, field, path);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new SongError(join(path, field), `must be an integer in ${min}..${max}`);
  }
  return value;
}

function oneOf<T extends string>(
  obj: Record<string, unknown>,
  field: string,
  path: string,
  allowed: readonly T[],
): T {
  const value = obj[field];
  const found = allowed.find((a) => a === value);
  if (found === undefined) {
    throw new SongError(join(path, field), `expected one of ${allowed.join(', ')}`);
  }
  return found;
}

/** True when `n` is a whole number of eighth beats. */
function onEighthGrid(n: number): boolean {
  return Number.isInteger(n * 8);
}

function validateSelector(value: unknown, path: string): NoteSelector {
  if (typeof value === 'string') {
    const name = NOTE_SELECTOR_NAMES.find((n) => n === value);
    if (name === undefined) throw new SongError(path, `unknown note selector "${value}"`);
    return name;
  }
  const obj = record(value, path);
  const index = numberField(obj, 'index', path);
  if (!Number.isInteger(index) || index < 0) {
    throw new SongError(`${path}.index`, 'must be a non-negative integer');
  }
  return { index };
}

function validatePattern(value: unknown, path: string): Pattern {
  const obj = record(value, path);
  const id = stringField(obj, 'id', path);
  const name = stringField(obj, 'name', path);
  const length = numberField(obj, 'length', path);
  if (length <= 0 || !onEighthGrid(length)) {
    throw new SongError(`${path}.length`, 'must be > 0 and a multiple of 1/8');
  }
  const rawSteps = obj['steps'];
  if (!Array.isArray(rawSteps)) throw new SongError(`${path}.steps`, 'expected an array');
  const steps = rawSteps.map((item: unknown, i): PatternStep => {
    const p = `${path}.steps[${i}]`;
    const s = record(item, p);
    const at = numberField(s, 'at', p);
    if (at < 0 || at >= length || !onEighthGrid(at)) {
      throw new SongError(`${p}.at`, 'must be in 0..length (exclusive) and a multiple of 1/8');
    }
    const stepLength = numberField(s, 'length', p);
    if (stepLength <= 0) throw new SongError(`${p}.length`, 'must be > 0');
    const step: PatternStep = {
      at,
      length: stepLength,
      notes: validateSelector(s['notes'], `${p}.notes`),
    };
    if (s['accent'] !== undefined) {
      const accent = numberField(s, 'accent', p);
      if (accent < 0 || accent > 1) throw new SongError(`${p}.accent`, 'must be in 0..1');
      step.accent = accent;
    }
    return step;
  });
  const pattern: Pattern = { id, name, length, steps };
  if (obj['tail'] !== undefined) pattern.tail = oneOf(obj, 'tail', path, ['cut', 'sustain']);
  return pattern;
}

function validateTrack(value: unknown, path: string): Track {
  const obj = record(value, path);
  const id = stringField(obj, 'id', path);
  if (id === '') throw new SongError(`${path}.id`, 'must not be empty');
  const name = stringField(obj, 'name', path);
  const role = oneOf(obj, 'role', path, TRACK_ROLES);
  const channel = intField(obj, 'channel', path, 0, 15);
  const octave = intField(obj, 'octave', path, -1, 9);
  const voicing = oneOf(obj, 'voicing', path, ['close', 'root-only']);
  const pattern = validatePattern(obj['pattern'], `${path}.pattern`);
  const velocity = intField(obj, 'velocity', path, 1, 127);
  const gate = numberField(obj, 'gate', path);
  if (!(gate > 0 && gate <= 1)) throw new SongError(`${path}.gate`, 'must be in (0, 1]');
  const muted = obj['muted'];
  if (typeof muted !== 'boolean') throw new SongError(`${path}.muted`, 'expected a boolean');
  const transpose = intField(obj, 'transpose', path, -127, 127);
  return { id, name, role, channel, octave, voicing, pattern, velocity, gate, muted, transpose };
}

function validateTracks(value: unknown): Track[] {
  if (!Array.isArray(value)) throw new SongError('tracks', 'expected an array');
  const seen = new Set<string>();
  return value.map((item: unknown, i) => {
    const track = validateTrack(item, `tracks[${i}]`);
    if (seen.has(track.id)) throw new SongError(`tracks[${i}].id`, `duplicate id "${track.id}"`);
    seen.add(track.id);
    return track;
  });
}

const DEGREES: readonly Degree[] = [1, 2, 3, 4, 5, 6, 7];

/** True when `n` is a whole number of melody steps (1/16 notes). */
function onMelodyGrid(n: number): boolean {
  return Number.isInteger(n / MELODY_STEP);
}

function validateMelodyNote(value: unknown, path: string): MelodyNote {
  const obj = record(value, path);
  const beat = numberField(obj, 'beat', path);
  if (beat < 0 || !onMelodyGrid(beat)) {
    throw new SongError(`${path}.beat`, `must be >= 0 and a multiple of ${MELODY_STEP}`);
  }
  const length = numberField(obj, 'length', path);
  if (length <= 0 || !onMelodyGrid(length)) {
    throw new SongError(`${path}.length`, `must be > 0 and a multiple of ${MELODY_STEP}`);
  }
  const rawDegree = obj['degree'];
  const degree = DEGREES.find((d) => d === rawDegree);
  if (degree === undefined) throw new SongError(`${path}.degree`, 'must be an integer in 1..7');
  const octave = intField(obj, 'octave', path, MELODY_OCTAVE_MIN, MELODY_OCTAVE_MAX);
  const rawAccidental = obj['accidental'];
  const accidental = MELODY_ACCIDENTALS.find((a) => a === rawAccidental);
  if (accidental === undefined) {
    throw new SongError(`${path}.accidental`, 'expected one of -1, 0, 1');
  }
  return { beat, length, degree, octave, accidental };
}

function validateMelody(value: unknown): Melody {
  const obj = record(value, 'melody');
  const channel = intField(obj, 'channel', 'melody', 0, 15);
  const muted = obj['muted'];
  if (typeof muted !== 'boolean') throw new SongError('melody.muted', 'expected a boolean');
  const rawNotes = obj['notes'];
  if (!Array.isArray(rawNotes)) throw new SongError('melody.notes', 'expected an array');
  if (rawNotes.length > MAX_MELODY_NOTES) {
    throw new SongError('melody.notes', `at most ${MAX_MELODY_NOTES} notes`);
  }
  let end = 0;
  const notes = rawNotes.map((item: unknown, i): MelodyNote => {
    const path = `melody.notes[${i}]`;
    const note = validateMelodyNote(item, path);
    if (note.beat < end) throw new SongError(`${path}.beat`, 'overlaps the previous note');
    end = note.beat + note.length;
    return note;
  });
  return { channel, muted, notes };
}

/**
 * Check that `value` is a valid Song and return a normalised schema-3 copy (unknown fields
 * dropped). Older songs are migrated: schema 1 ignores any `tracks` field and gets
 * DEFAULT_TRACKS() (fresh ids); schema 1 and 2 ignore any `melody` field and get an empty
 * defaultMelody(). Throws SongError with a path such as 'chords[3].beats',
 * 'tracks[1].pattern.steps[2].at' or 'melody.notes[0].degree'.
 */
export function validateSong(value: unknown): Song {
  const root = record(value, '');
  const schema = root['schema'];
  if (schema !== 1 && schema !== 2 && schema !== 3) {
    throw new SongError('schema', 'expected 1, 2 or 3');
  }
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
  if (tempo <= 0 || tempo > MAX_TEMPO) {
    throw new SongError('tempo', `must be > 0 and at most ${MAX_TEMPO}`);
  }

  const meterObj = record(root['meter'], 'meter');
  const meterBeats = numberField(meterObj, 'beats', 'meter');
  if (!Number.isInteger(meterBeats) || meterBeats < 1 || meterBeats > MAX_METER_BEATS) {
    throw new SongError('meter.beats', `must be an integer from 1 to ${MAX_METER_BEATS}`);
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
    schema: 3,
    title,
    key: { tonic, mode },
    tempo,
    meter: { beats: meterBeats, unit },
    chords,
    tracks: schema === 1 ? DEFAULT_TRACKS() : validateTracks(root['tracks']),
    melody: schema === 3 ? validateMelody(root['melody']) : defaultMelody(),
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

/**
 * JSON (2-space indented) with a stable key order; unknown fields are dropped. Writes
 * schema 3 with the tracks and the melody (an empty default one when the object has none); a
 * song object without `tracks` (a hand-built schema-1 song) is written as schema 1, which
 * validateSong migrates on load.
 */
export function serializeSong(song: Song): string {
  const ordered: Song = {
    schema: song.tracks === undefined ? 1 : 3,
    title: song.title,
    key: { tonic: song.key.tonic, mode: song.key.mode },
    tempo: song.tempo,
    meter: { beats: song.meter.beats, unit: song.meter.unit },
    chords: song.chords.map((c) => ({ token: c.token, beats: c.beats })),
  };
  if (song.tracks !== undefined) {
    ordered.tracks = song.tracks.map(cloneTrack);
    ordered.melody = cloneMelody(song.melody ?? defaultMelody());
  }
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
