/**
 * Chord, key and melody recovery for the importer (docs/specs/import-v1.md §A3–A4): chord-part
 * segmentation, chord-shape matching on pitch-class weights, key and mode detection, Roman
 * numerals in the key (borrowed and secondary chords), and the melody as scale degrees.
 */
import type { Chord, Quality } from '../chords';
import { chordIntervals, chordTones } from '../chords';
import { diatonicQuality, isDiatonic } from '../diatonic';
import type { MelodyAccidental, MelodyNote } from '../melody';
import { MELODY_HOME_OCTAVE, MELODY_OCTAVE_MAX, MELODY_OCTAVE_MIN } from '../melody';
import type { Degree, Key, Mode, PitchClass } from '../theory';
import { MODES, SCALES, degreePitch, keySignature, midiNote, toPitchClass } from '../theory';
import { formatToken, tryParseToken } from '../token';
import type { KeyHint, ReportLog, ScoreHarmony, ScoreNote, ScorePart } from './score';
import { IMPORT_STEP, position, quantize } from './score';

/** A chord shape the token format spells: everything of a Chord but its place in the key. */
export type ShapeChord = Pick<Chord, 'quality' | 'extension' | 'sus' | 'adds' | 'alterations'>;

export interface Shape {
  chord: ShapeChord;
  /** Pitch-class intervals above the root (mod 12), root first. */
  intervals: number[];
  /** 0 triads, 1 sevenths and sus, 2 added tones and ninths: the simpler shape wins a tie. */
  complexity: number;
}

function shape(
  chord: Partial<ShapeChord> & Pick<ShapeChord, 'quality'>,
  complexity: number,
): Shape {
  const full: ShapeChord = {
    quality: chord.quality,
    extension: chord.extension ?? 'none',
    sus: chord.sus ?? [],
    adds: chord.adds ?? [],
    alterations: [],
  };
  const intervals = chordIntervals({ ...full, degree: 1, accidental: 0, inversion: 0 });
  return { chord: full, intervals: [...new Set(intervals.map((i) => i % 12))], complexity };
}

/** Every shape the matcher tries (docs/specs/import-v1.md §A3). */
export const SHAPES: readonly Shape[] = [
  shape({ quality: 'major' }, 0),
  shape({ quality: 'minor' }, 0),
  shape({ quality: 'dim' }, 0),
  shape({ quality: 'aug' }, 0),
  shape({ quality: 'major', sus: [2] }, 1),
  shape({ quality: 'major', sus: [4] }, 1),
  shape({ quality: 'major', extension: '7' }, 1),
  shape({ quality: 'major', extension: 'maj7' }, 1),
  shape({ quality: 'minor', extension: '7' }, 1),
  shape({ quality: 'minor', extension: 'maj7' }, 1),
  shape({ quality: 'dim', extension: 'ø7' }, 1),
  shape({ quality: 'dim', extension: '°7' }, 1),
  shape({ quality: 'major', extension: '7', sus: [4] }, 1),
  shape({ quality: 'aug', extension: 'maj7' }, 1),
  shape({ quality: 'major', adds: [6] }, 2),
  shape({ quality: 'minor', adds: [6] }, 2),
  shape({ quality: 'major', adds: [9] }, 2),
  shape({ quality: 'minor', adds: [9] }, 2),
  shape({ quality: 'major', extension: '9' }, 2),
  shape({ quality: 'major', extension: 'maj9' }, 2),
  shape({ quality: 'minor', extension: '9' }, 2),
];

/** A recognised chord before it is placed in a key. */
export interface ChordMatch {
  root: PitchClass;
  shape: Shape;
  /** The bass pitch class, or null when the bass is not a chord tone (it was ignored). */
  bass: PitchClass | null;
  score: number;
  /** Share of the segment's weight the shape covers, 0..1. */
  coverage: number;
}

/** Lowest score and coverage a match needs. */
const MIN_SCORE = 0.45;
const MIN_COVERAGE = 0.6;

/**
 * The best chord shape for pitch-class weights `weights` (12 entries) with `bass` in the bass, or
 * null when fewer than two pitch classes sound or nothing fits well enough.
 */
export function matchChord(weights: readonly number[], bass: PitchClass | null): ChordMatch | null {
  const total = weights.reduce((a, b) => a + b, 0);
  const present = weights.filter((w) => w > total * 0.02).length;
  if (total <= 0 || present < 2) return null;
  let best: ChordMatch | null = null;
  for (let root = 0; root < 12; root++) {
    const rootPc = toPitchClass(root);
    for (const s of SHAPES) {
      let covered = 0;
      let missing = 0;
      for (const i of s.intervals) {
        const w = weights[(root + i) % 12] ?? 0;
        covered += w;
        if (w <= total * 0.02) missing += i === 7 || i === 6 || i === 8 ? 0.15 : 0.5;
      }
      const coverage = covered / total;
      let score = coverage - (1 - coverage) - missing - s.complexity * 0.02;
      if (bass === rootPc) score += 0.08;
      if (bass !== null && s.intervals.includes(toPitchClass(bass - root))) score += 0.02;
      if (best === null || score > best.score + 1e-9) {
        const bassTone = bass !== null && s.intervals.includes(toPitchClass(bass - root));
        best = { root: rootPc, shape: s, bass: bassTone ? bass : null, score, coverage };
      }
    }
  }
  if (best === null || best.score < MIN_SCORE || best.coverage < MIN_COVERAGE) return null;
  return best;
}

/** A stretch of the song with one chord (or a rest). */
export interface Segment {
  start: number;
  end: number;
  match: ChordMatch | null;
  /** True when nothing sounds (a rest on purpose, not a dropped chord). */
  silent: boolean;
  /** The segment's notes as names, for the report of a dropped chord. */
  notes: string;
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function noteList(pcs: Iterable<number>): string {
  return [...new Set(pcs)]
    .sort((a, b) => a - b)
    .map((pc) => NAMES[pc] ?? '?')
    .join(' ');
}

interface QNote {
  start: number;
  end: number;
  pitch: number;
}

function quantizeNotes(notes: readonly ScoreNote[]): QNote[] {
  return notes.map((n) => {
    const start = quantize(n.start);
    return { start, end: Math.max(start + IMPORT_STEP, quantize(n.end)), pitch: n.pitch };
  });
}

/** Beats where three or more pitch classes sound together (the chord-part score). */
export function chordiness(notes: readonly ScoreNote[]): number {
  const q = quantizeNotes(notes);
  const times = [...new Set(q.flatMap((n) => [n.start, n.end]))].sort((a, b) => a - b);
  let beats = 0;
  for (let i = 0; i + 1 < times.length; i++) {
    const a = times[i] ?? 0;
    const b = times[i + 1] ?? a;
    const pcs = new Set(q.filter((n) => n.start <= a && n.end >= b).map((n) => n.pitch % 12));
    if (pcs.size >= 3) beats += b - a;
  }
  return beats;
}

/** Share of notes that start while an earlier note of the part still sounds. */
export function overlapShare(notes: readonly ScoreNote[]): number {
  if (notes.length === 0) return 0;
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  let end = -Infinity;
  let overlapping = 0;
  for (const n of sorted) {
    if (n.start < end - 0.05) overlapping++;
    end = Math.max(end, n.end);
  }
  return overlapping / notes.length;
}

/** Names that mark a part as the melody. */
const MELODY_NAMES = /melody|lead|vocal|voice|solo|tune|topline|singer|sing/i;

export function isMelodyName(name: string): boolean {
  return MELODY_NAMES.test(name);
}

/**
 * True for a machine-regular line (an arpeggio or a sequence): at least 16 notes, nine in ten of
 * the gaps between starts equal and every note as long as the others.
 */
export function isRegularLine(notes: readonly ScoreNote[]): boolean {
  if (notes.length < 16) return false;
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  const gaps = new Map<number, number>();
  const lengths = new Set<number>();
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (a === undefined) continue;
    lengths.add(Math.round((a.end - a.start) * 64));
    if (b === undefined) continue;
    const gap = Math.round((b.start - a.start) * 64);
    gaps.set(gap, (gaps.get(gap) ?? 0) + 1);
  }
  const common = Math.max(...gaps.values());
  return common >= 0.9 * (sorted.length - 1) && lengths.size === 1;
}

export function meanPitch(notes: readonly ScoreNote[]): number {
  return notes.length === 0 ? 0 : notes.reduce((a, n) => a + n.pitch, 0) / notes.length;
}

/**
 * Cut the chord part into segments (docs/specs/import-v1.md §A3): boundaries at attacks of two or
 * more notes (plus bar starts for arpeggios), rests after long silences, repeated stabs merged.
 * `end` is where the part ends.
 */
export function segmentChords(
  part: ScorePart,
  barBeats: number,
  end: number,
  log: ReportLog,
): Segment[] {
  const notes = quantizeNotes(part.notes).filter((n) => n.start < end);
  if (notes.length === 0) return [];
  const starts = new Map<number, number>();
  for (const n of notes) starts.set(n.start, (starts.get(n.start) ?? 0) + 1);
  const attacks = [...starts].filter(([, count]) => count >= 2).map(([t]) => t);
  const inAttacks = notes.filter((n) => (starts.get(n.start) ?? 0) >= 2).length;
  const bounds = new Set<number>(attacks);
  const first = Math.min(...notes.map((n) => n.start));
  bounds.add(first);
  if (inAttacks < notes.length / 2) {
    for (let t = Math.ceil(first / barBeats) * barBeats; t < end; t += barBeats) bounds.add(t);
  }
  const times = [...bounds].filter((t) => t < end).sort((a, b) => a - b);
  times.push(end);

  const raw: Segment[] = [];
  if (first > 0) raw.push({ start: 0, end: first, match: null, silent: true, notes: '' });
  for (let i = 0; i + 1 < times.length; i++) {
    const a = times[i] ?? 0;
    const b = times[i + 1] ?? a;
    if (b <= a) continue;
    const inside = notes.filter((n) => n.start < b && n.end > a);
    if (inside.length === 0) {
      raw.push({ start: a, end: b, match: null, silent: true, notes: '' });
      continue;
    }
    const sounding = Math.max(...inside.map((n) => Math.min(n.end, b)));
    let chordEnd = b;
    // A long silence after the notes is a rest: the chord ends at its last note, on a whole beat.
    const silence = b - sounding;
    if (silence >= 1 && silence >= 0.25 * (sounding - a)) {
      const cut = Math.ceil(sounding - 1e-9);
      if (cut > a && cut < b) chordEnd = cut;
    }
    const weights = Array.from({ length: 12 }, () => 0);
    for (const n of inside) {
      const pc = n.pitch % 12;
      weights[pc] = (weights[pc] ?? 0) + Math.min(n.end, chordEnd) - Math.max(n.start, a);
    }
    const atStart = inside.filter((n) => n.start <= a && n.end > a);
    const low = Math.min(...(atStart.length > 0 ? atStart : inside).map((n) => n.pitch));
    const match = matchChord(weights, toPitchClass(low));
    const names = noteList(inside.map((n) => n.pitch % 12));
    raw.push({ start: a, end: chordEnd, match, silent: false, notes: names });
    if (chordEnd < b) raw.push({ start: chordEnd, end: b, match: null, silent: true, notes: '' });
  }

  // Repeated stabs of one chord inside a bar merge (attacks under two beats apart).
  const merged: Segment[] = [];
  for (const seg of raw) {
    const prev = merged.at(-1);
    if (
      prev !== undefined &&
      ((prev.silent && seg.silent) ||
        (prev.match !== null &&
          seg.match !== null &&
          sameChord(prev.match, seg.match) &&
          prev.end - prev.start < 2 &&
          Math.floor(prev.start / barBeats) === Math.floor((seg.start - 1e-9) / barBeats)))
    ) {
      prev.end = seg.end;
      continue;
    }
    merged.push({ ...seg });
  }
  for (const seg of merged) {
    if (!seg.silent && seg.match === null) {
      log.drop('chord', seg.start, `${position(seg.start, barBeats)}: no chord in ${seg.notes}`);
    }
  }
  return merged;
}

function sameChord(a: ChordMatch, b: ChordMatch): boolean {
  return a.root === b.root && a.shape === b.shape && a.bass === b.bass;
}

/** Segments from chord symbols: each symbol lasts until the next one (or `end`). */
export function harmonySegments(harmonies: readonly ScoreHarmony[], end: number): Segment[] {
  const out: Segment[] = [];
  const list = harmonies
    .map((h) => ({ ...h, start: quantize(h.start) }))
    .filter((h) => h.start < end);
  const first = list[0];
  if (first !== undefined && first.start > 0) {
    out.push({ start: 0, end: first.start, match: null, silent: true, notes: '' });
  }
  list.forEach((h, i) => {
    const next = list[i + 1]?.start ?? end;
    if (next <= h.start) return;
    const weights = Array.from({ length: 12 }, () => 0);
    for (const iv of h.intervals) weights[(h.root + iv) % 12] = 1;
    const match = matchChord(weights, h.bass);
    out.push({ start: h.start, end: next, match, silent: false, notes: h.label });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Key and mode

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const MAJOR_LIKE: ReadonlySet<Mode> = new Set<Mode>(['major', 'lydian', 'mixolydian']);
const MODE_PRIOR: Readonly<Record<Mode, number>> = {
  major: 0.06,
  minor: 0.05,
  dorian: 0,
  mixolydian: 0,
  lydian: -0.01,
  phrygian: -0.01,
  // A raised seventh in a minor song is usually a borrowed V, not a harmonic-minor song.
  harmonicMinor: -0.12,
  phrygianDominant: -0.12,
  locrian: -0.06,
};

function correlation(a: readonly number[], b: readonly number[]): number {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = (a[i] ?? 0) - ma;
    const y = (b[i] ?? 0) - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db);
}

export interface KeyGuess {
  key: Key;
  score: number;
  confidence: number;
  runnerUp: Key | null;
}

/** Duration-weighted pitch-class histogram. */
export function histogram(notes: readonly ScoreNote[]): number[] {
  const h = Array.from({ length: 12 }, () => 0);
  for (const n of notes) h[n.pitch % 12] = (h[n.pitch % 12] ?? 0) + Math.max(0, n.end - n.start);
  return h;
}

function tonicTriad(match: ChordMatch, key: Key): boolean {
  if (match.root !== key.tonic) return false;
  const q = match.shape.chord.quality;
  return match.shape.chord.sus.length > 0 || q === diatonicQuality(1, key.mode);
}

/**
 * The most likely key and mode for the pitch-class histogram `hist` and the chord segments, with
 * the file's key signature as a hint (docs/specs/import-v1.md §A3, "Key and mode").
 */
export function detectKey(
  hist: readonly number[],
  segments: readonly Segment[],
  hint: KeyHint | null,
): KeyGuess {
  const total = hist.reduce((a, b) => a + b, 0);
  const chords = segments.filter((s) => s.match !== null);
  const firstChord = chords[0]?.match ?? null;
  const lastChord = chords.at(-1)?.match ?? null;
  const chordBeats = chords.reduce((a, s) => a + (s.end - s.start), 0);
  const ranked: { key: Key; score: number }[] = [];
  for (let t = 0; t < 12; t++) {
    const tonic = toPitchClass(t);
    for (const mode of MODES) {
      const key: Key = { tonic, mode };
      const scale = new Set(SCALES[mode].map((s) => (s + t) % 12));
      let score = MODE_PRIOR[mode];
      if (total > 0) {
        const inside = hist.reduce((a, w, pc) => a + (scale.has(pc) ? w : 0), 0) / total;
        const profile = MAJOR_LIKE.has(mode) ? MAJOR_PROFILE : MINOR_PROFILE;
        const rotated = Array.from({ length: 12 }, (_, pc) => profile[(pc - t + 12) % 12] ?? 0);
        score += inside + 0.5 * correlation(rotated, hist);
      }
      if (chords.length > 0) {
        let diatonic = 0;
        let onTonic = 0;
        for (const s of chords) {
          const m = s.match;
          if (m === null) continue;
          const len = s.end - s.start;
          if (m.shape.intervals.every((i) => scale.has((m.root + i) % 12))) diatonic += len;
          if (tonicTriad(m, key)) onTonic += len;
        }
        score += (0.3 * diatonic) / chordBeats + (0.2 * onTonic) / chordBeats;
        if (firstChord !== null && tonicTriad(firstChord, key)) score += 0.12;
        if (lastChord !== null && tonicTriad(lastChord, key)) score += 0.18;
      }
      if (hint !== null && keySignature(key) === hint.fifths) {
        score += 0.08;
        if (hint.mode !== null) score += hint.mode === mode ? 0.2 : 0;
        else if (hint.minor === !MAJOR_LIKE.has(mode)) score += 0.06;
      }
      ranked.push({ key, score });
    }
  }
  ranked.sort((a, b) => b.score - a.score);
  const best = ranked[0] ?? { key: { tonic: 0, mode: 'major' }, score: 0 };
  const second = ranked[1] ?? null;
  const confidence =
    second === null ? 1 : Math.max(0, Math.min(1, (best.score - second.score) / 0.2));
  return { key: best.key, score: best.score, confidence, runnerUp: second?.key ?? null };
}

// ---------------------------------------------------------------------------------------------
// Roman numerals

const DEGREES: readonly Degree[] = [1, 2, 3, 4, 5, 6, 7];

/** The degree and accidental of a pitch class in the key: on the scale, else flat or sharp. */
function degreeOf(
  rel: number,
  mode: Mode,
  preferSharp: boolean,
): { degree: Degree; accidental: -1 | 0 | 1 } {
  const exact = DEGREES.find((d) => degreePitch(mode, d) === rel);
  if (exact !== undefined) return { degree: exact, accidental: 0 };
  const flat = DEGREES.find((d) => degreePitch(mode, d) === rel + 1);
  const sharp = DEGREES.find((d) => degreePitch(mode, d) === rel - 1);
  if (sharp !== undefined && (preferSharp || flat === undefined)) {
    return { degree: sharp, accidental: 1 };
  }
  if (flat !== undefined) return { degree: flat, accidental: -1 };
  return { degree: 1, accidental: 0 };
}

/** The inversion that puts `bass` in the bass of `chord`, or null when it is no core tone. */
function inversionFor(chord: Chord, key: Key, bass: PitchClass | null): Chord['inversion'] | null {
  if (bass === null) return 0;
  const tones = chordTones(chord, key);
  const tone = tones.find((t) => t.pitchClass === bass);
  if (tone === undefined) return null;
  if (tone.role === 'third' && tones.find((t) => t.role === 'third') !== tone) return null;
  if (tone.role === 'fifth' && tones.find((t) => t.role === 'fifth') !== tone) return null;
  return tone.role === 'root' ? 0 : tone.role === 'third' ? 1 : tone.role === 'fifth' ? 2 : 3;
}

export type ChordKind = 'diatonic' | 'borrowed' | 'secondary';

export interface PlacedChord {
  token: string;
  kind: ChordKind;
  /** The bass was not a chord tone and was ignored. */
  bassIgnored: boolean;
}

/**
 * The token of `match` in `key`. `next` is the chord after it: a major triad or dominant seventh
 * off the key that resolves a fourth up to a major or minor scale degree other than the tonic
 * becomes a secondary dominant (`V/vi`, `V7/ii`).
 */
export function placeChord(
  match: ChordMatch,
  key: Key,
  next: ChordMatch | null,
): PlacedChord | null {
  const rel = toPitchClass(match.root - key.tonic);
  const c = match.shape.chord;
  const dimFamily = c.quality === 'dim';
  const { degree, accidental } = degreeOf(rel, key.mode, dimFamily);
  let chord: Chord = { ...c, degree, accidental, inversion: 0 };
  let kind: ChordKind = isDiatonic(chord, key.mode) ? 'diatonic' : 'borrowed';
  const dominant =
    c.quality === 'major' &&
    c.sus.length === 0 &&
    c.adds.length === 0 &&
    (c.extension === 'none' || c.extension === '7');
  if (kind === 'borrowed' && dominant && next !== null) {
    const targetRel = toPitchClass(next.root - key.tonic);
    const target = DEGREES.find((d) => degreePitch(key.mode, d) === targetRel);
    if (toPitchClass(match.root + 5) === next.root && target !== undefined && target !== 1) {
      const targetQuality: Quality = diatonicQuality(target, key.mode);
      if (targetQuality === 'major' || targetQuality === 'minor') {
        chord = {
          ...c,
          degree: 5,
          accidental: 0,
          inversion: 0,
          applied: { target, targetAccidental: 0, targetQuality },
        };
        kind = 'secondary';
      }
    }
  }
  const inversion = inversionFor(chord, key, match.bass);
  chord = { ...chord, inversion: inversion ?? 0 };
  let token: string;
  try {
    token = formatToken(chord);
  } catch {
    return null;
  }
  if (tryParseToken(token) === undefined) return null;
  return { token, kind, bassIgnored: inversion === null };
}

// ---------------------------------------------------------------------------------------------
// Melody

/** Spell `pitch` as a melody note in `key`, preferring a tone of `chord` when off the scale. */
export function melodyDegree(
  pitch: number,
  key: Key,
  chord: Chord | null,
): Pick<MelodyNote, 'degree' | 'octave' | 'accidental'> | null {
  const home = midiNote(key.tonic, MELODY_HOME_OCTAVE);
  const pc = toPitchClass(pitch);
  const rel = toPitchClass(pitch - home);
  let spelled: { degree: Degree; accidental: number } | undefined;
  const onScale = DEGREES.find((d) => degreePitch(key.mode, d) === rel);
  if (onScale !== undefined) spelled = { degree: onScale, accidental: 0 };
  if (spelled === undefined && chord !== null) {
    const tone = chordTones(chord, key).find((t) => t.pitchClass === pc);
    if (tone !== undefined && Math.abs(tone.accidental) === 1) spelled = tone;
  }
  if (spelled === undefined) {
    const sharpFour = degreePitch(key.mode, 4) + 1 === rel;
    spelled = sharpFour ? { degree: 4, accidental: 1 } : degreeOf(rel, key.mode, false);
  }
  const accidental = spelled.accidental;
  if (accidental !== -1 && accidental !== 0 && accidental !== 1) return null;
  const octave = (pitch - home - degreePitch(key.mode, spelled.degree) - accidental) / 12;
  if (!Number.isInteger(octave) || octave < MELODY_OCTAVE_MIN || octave > MELODY_OCTAVE_MAX) {
    return null;
  }
  const acc: MelodyAccidental = accidental;
  return { degree: spelled.degree, octave, accidental: acc };
}

/** One quantised monophonic melody note in pitch form. */
export interface MelodyLine {
  start: number;
  end: number;
  pitch: number;
}

/**
 * How much of the time to the next note a note sounds (its gate): the largest ratio of length to
 * the time to the next note (a rest only makes the ratio smaller), ignoring overlaps; 1 when the
 * part gives no evidence.
 */
export function estimateGate(notes: readonly ScoreNote[]): number {
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  const ratios: number[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (a === undefined || b === undefined) continue;
    const ioi = b.start - a.start;
    if (ioi <= 0) continue;
    const ratio = (a.end - a.start) / ioi;
    if (ratio >= 0.4 && ratio <= 1) ratios.push(ratio);
  }
  return ratios.reduce((a, b) => Math.max(a, b), 0) || 1;
}

/**
 * The part's notes as one monophonic line on the 1/16 grid (docs/specs/import-v1.md §A4):
 * highest note per start, cut at the next start; the part's gate is undone, then an end snaps to
 * the next start (or `end`) when the gap is under a 1/32 note or 10 % of the note.
 */
export function melodyLine(notes: readonly ScoreNote[], end: number): MelodyLine[] {
  const gate = estimateGate(notes);
  const byStart = new Map<number, ScoreNote>();
  for (const n of notes) {
    const start = quantize(n.start);
    const other = byStart.get(start);
    if (other === undefined || n.pitch > other.pitch) byStart.set(start, n);
  }
  const starts = [...byStart.keys()].sort((a, b) => a - b);
  const out: MelodyLine[] = [];
  starts.forEach((start, i) => {
    const n = byStart.get(start);
    if (n === undefined) return;
    const next = starts[i + 1] ?? Math.max(end, start + IMPORT_STEP);
    const length = Math.max(0, n.end - start) / gate;
    const sounding = start + length;
    let noteEnd: number;
    if (next - sounding < Math.max(IMPORT_STEP / 2, 0.1 * length)) noteEnd = next;
    else noteEnd = Math.min(next, Math.max(start + IMPORT_STEP, quantize(sounding)));
    if (noteEnd <= start) return;
    out.push({ start, end: noteEnd, pitch: n.pitch });
  });
  return out;
}
