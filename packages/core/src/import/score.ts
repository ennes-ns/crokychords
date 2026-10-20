/**
 * The intermediate score both importers produce (docs/specs/import-v1.md §A2): parts of timed
 * notes in beats (one beat = one quarter note), chord symbols, the first tempo and meter, a key
 * hint, and the report entries collected while reading.
 */
import type { Mode, PitchClass } from '../theory';

export interface ScoreNote {
  /** Beats from the start. */
  start: number;
  /** Beats from the start, > start. */
  end: number;
  /** MIDI note number 0..127. */
  pitch: number;
  velocity: number;
}

export interface ScorePart {
  name: string;
  notes: ScoreNote[];
  /** MIDI channel 9 (shown 10): percussion, never used. */
  drums: boolean;
  /** Where the part ends (end of track), when the file says so. */
  end: number | null;
}

/** A chord symbol (MusicXML `<harmony>`). */
export interface ScoreHarmony {
  start: number;
  root: PitchClass;
  /** Semitones above the root, 0 first. */
  intervals: number[];
  bass: PitchClass;
  /** What the symbol said, for the report. */
  label: string;
}

/** Key signature from the file: sharps > 0, flats < 0, and the mode when the file names one. */
export interface KeyHint {
  fifths: number;
  minor: boolean;
  mode: Mode | null;
}

export type DropKind = 'chord' | 'note' | 'part' | 'event';

export interface ImportDrop {
  kind: DropKind;
  /** Beat in the song, or null when the drop has no position. */
  beat: number | null;
  detail: string;
}

/** Collects drops (at most MAX_REPORTED_DROPS entries, the rest counted) and warnings. */
export class ReportLog {
  readonly dropped: ImportDrop[] = [];
  droppedMore = 0;
  readonly warnings: string[] = [];

  drop(kind: DropKind, beat: number | null, detail: string): void {
    if (this.dropped.length < MAX_REPORTED_DROPS) this.dropped.push({ kind, beat, detail });
    else this.droppedMore++;
  }

  warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }
}

export interface ImportScore {
  format: 'midi' | 'musicxml';
  title: string | null;
  /** BPM of the first tempo, or null when the file has none. */
  tempo: number | null;
  meter: { beats: number; unit: number } | null;
  key: KeyHint | null;
  parts: ScorePart[];
  harmonies: ScoreHarmony[];
  /** Length of the score in beats when the file defines it (MusicXML measures), else null. */
  length: number | null;
  log: ReportLog;
}

/** Thrown when a file cannot be read at all (not MIDI/MusicXML, no parts). */
export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

/** Most notes read from one file; the rest are dropped. */
export const MAX_IMPORT_NOTES = 200_000;
/** Most chords an imported song gets. */
export const MAX_IMPORT_CHORDS = 1024;
/** Longest imported song in beats. */
export const MAX_IMPORT_BEATS = 4096;
/** Most drops listed one by one in the report. */
export const MAX_REPORTED_DROPS = 200;
/** The import grid: a 1/16 note. */
export const IMPORT_STEP = 0.25;

/** Round to the 1/16 grid. */
export function quantize(beat: number): number {
  return Math.round(beat / IMPORT_STEP) * IMPORT_STEP;
}

/** "bar 3 beat 2" style position for the report (1-based). */
export function position(beat: number, beatsPerBar: number): string {
  const bar = Math.floor(beat / beatsPerBar) + 1;
  const inBar = beat - (bar - 1) * beatsPerBar + 1;
  return `bar ${bar}, beat ${Number.isInteger(inBar) ? inBar : inBar.toFixed(2)}`;
}
