import type { Degree, Key, Mode, PitchClass } from './theory';
import {
  SCALES,
  degreePitch,
  keySignature,
  midiNote,
  noteName,
  pitchClassOf,
  toPitchClass,
} from './theory';

export type Quality = 'major' | 'minor' | 'dim' | 'aug';

export type Extension =
  | 'none'
  | '7'
  | 'maj7'
  | 'ø7'
  | '°7'
  | '9'
  | 'maj9'
  | 'ø9'
  | '°9'
  | '11'
  | 'maj11'
  | 'ø11'
  | '°11'
  | '13'
  | 'maj13'
  | 'ø13'
  | '°13';

export type Alteration = 'b5' | '#5' | 'b9' | '#9' | '#11' | 'b13';

/** bb, b, natural, #, ## */
export type Accidental = -2 | -1 | 0 | 1 | 2;

export interface AppliedTarget {
  target: Degree;
  targetAccidental: Accidental;
  targetQuality: Quality;
}

export interface Chord {
  degree: Degree;
  /** bb, b, natural, #, ## in front of the numeral */
  accidental: Accidental;
  quality: Quality;
  extension: Extension;
  /** sorted */
  sus: readonly (2 | 4)[];
  /** sorted */
  adds: readonly (6 | 9 | 11)[];
  /** in the order b5 #5 b9 #9 #11 b13 */
  alterations: readonly Alteration[];
  inversion: 0 | 1 | 2 | 3;
  /** Secondary chord: this chord is `degree`/`quality`/... *of* the target. */
  applied?: AppliedTarget;
}

export const QUALITIES: readonly Quality[] = ['major', 'minor', 'dim', 'aug'];

export const EXTENSIONS: readonly Extension[] = [
  'none',
  '7',
  'maj7',
  'ø7',
  '°7',
  '9',
  'maj9',
  'ø9',
  '°9',
  '11',
  'maj11',
  'ø11',
  '°11',
  '13',
  'maj13',
  'ø13',
  '°13',
];

/** Canonical alteration order (also the token order). */
export const ALTERATIONS: readonly Alteration[] = ['b5', '#5', 'b9', '#9', '#11', 'b13'];

interface ExtensionShape {
  /** Interval of the seventh, undefined for a triad. */
  seventh: number | undefined;
  /** 5 (triad), 7, 9, 11 or 13. */
  size: 5 | 7 | 9 | 11 | 13;
}

const EXTENSION_SHAPES: Record<Extension, ExtensionShape> = {
  none: { seventh: undefined, size: 5 },
  '7': { seventh: 10, size: 7 },
  maj7: { seventh: 11, size: 7 },
  ø7: { seventh: 10, size: 7 },
  '°7': { seventh: 9, size: 7 },
  '9': { seventh: 10, size: 9 },
  maj9: { seventh: 11, size: 9 },
  ø9: { seventh: 10, size: 9 },
  '°9': { seventh: 9, size: 9 },
  '11': { seventh: 10, size: 11 },
  maj11: { seventh: 11, size: 11 },
  ø11: { seventh: 10, size: 11 },
  '°11': { seventh: 9, size: 11 },
  '13': { seventh: 10, size: 13 },
  maj13: { seventh: 11, size: 13 },
  ø13: { seventh: 10, size: 13 },
  '°13': { seventh: 9, size: 13 },
};

/** True for the diminished-family extensions ('ø7', '°7', 'ø9', ...). */
export function isDiminishedExtension(ext: Extension): boolean {
  return ext.startsWith('ø') || ext.startsWith('°');
}

interface ChordStructure {
  /** Third, or the sus tone(s) replacing it. Never empty. */
  thirds: number[];
  /** Fifth(s). Never empty. */
  fifths: number[];
  seventh: number | undefined;
  /** Ninths, elevenths, thirteenths and adds. */
  upper: number[];
}

function chordStructure(chord: Chord): ChordStructure {
  const alt = new Set(chord.alterations);
  const shape = EXTENSION_SHAPES[chord.extension];
  const minorThird = chord.quality === 'minor' || chord.quality === 'dim';

  const thirds =
    chord.sus.length > 0 ? chord.sus.map((s) => (s === 2 ? 2 : 5)) : [minorThird ? 3 : 4];

  const fifths: number[] = [];
  if (alt.has('b5')) fifths.push(6);
  if (alt.has('#5')) fifths.push(8);
  if (fifths.length === 0) {
    fifths.push(chord.quality === 'dim' ? 6 : chord.quality === 'aug' ? 8 : 7);
  }

  // Altered tensions sound whenever they are present (e.g. V7(b9), iii(#9)); natural
  // tensions come from the extension size and are replaced by their alteration.
  const upper: number[] = [];
  const ninths = [...(alt.has('b9') ? [13] : []), ...(alt.has('#9') ? [15] : [])];
  upper.push(...(ninths.length > 0 ? ninths : shape.size >= 9 ? [14] : []));
  if (alt.has('#11')) upper.push(18);
  else if (shape.size >= 11) upper.push(17);
  if (alt.has('b13')) upper.push(20);
  else if (shape.size >= 13) upper.push(21);
  for (const add of chord.adds) upper.push(add === 6 ? 9 : add === 9 ? 14 : 17);

  return { thirds, fifths, seventh: shape.seventh, upper };
}

/** Intervals in semitones from the root, ascending and deduplicated (root = 0 included). */
export function chordIntervals(chord: Chord): number[] {
  const s = chordStructure(chord);
  const all = [0, ...s.thirds, ...s.fifths, ...(s.seventh === undefined ? [] : [s.seventh])];
  all.push(...s.upper);
  return [...new Set(all)].sort((a, b) => a - b);
}

export function chordRootPitchClass(chord: Chord, key: Key): PitchClass {
  if (chord.applied === undefined) return pitchClassOf(key, chord.degree, chord.accidental);
  const targetPc = pitchClassOf(key, chord.applied.target, chord.applied.targetAccidental);
  return toPitchClass(targetPc + degreePitch('major', chord.degree));
}

/** Pitch classes of the chord, root first, in ascending interval order, deduplicated. */
export function chordPitchClasses(chord: Chord, key: Key): PitchClass[] {
  const root = chordRootPitchClass(chord, key);
  return [...new Set(chordIntervals(chord).map((i) => toPitchClass(root + i)))];
}

/** Interval (above the root) of the tone the inversion puts in the bass. */
function bassInterval(chord: Chord): number {
  const s = chordStructure(chord);
  const third = s.thirds[0] ?? 0;
  const fifth = s.fifths[0] ?? third;
  switch (chord.inversion) {
    case 0:
      return 0;
    case 1:
      return third;
    case 2:
      return fifth;
    case 3:
      return s.seventh ?? fifth;
  }
}

export function chordBassPitchClass(chord: Chord, key: Key): PitchClass {
  return toPitchClass(chordRootPitchClass(chord, key) + bassInterval(chord));
}

/** `third` is the chord's third, or the sus tone that replaces it. */
export type ChordToneRole = 'root' | 'third' | 'fifth' | 'seventh';

/** One core tone of a chord, spelled as a scale degree of the key. */
export interface ChordTone {
  role: ChordToneRole;
  /** Semitones above the root. */
  interval: number;
  pitchClass: PitchClass;
  /** The degree of the key the tone is spelled on (the third of V is degree 7, ...). */
  degree: Degree;
  /** Semitones from that degree as the mode has it: 0 in the mode, -1 flat, +1 sharp. */
  accidental: number;
}

/** Scale steps above the root on which a core tone is spelled. */
function toneSteps(role: ChordToneRole, interval: number): number {
  switch (role) {
    case 'root':
      return 0;
    case 'third':
      return interval === 2 ? 1 : interval === 5 ? 3 : 2;
    case 'fifth':
      return 4;
    case 'seventh':
      return 6;
  }
}

const SCALE_DEGREES: readonly Degree[] = [1, 2, 3, 4, 5, 6, 7];

/** The degree `steps` scale steps above `degree`, wrapping round the octave. */
function stepDegree(degree: Degree, steps: number): Degree {
  return at(SCALE_DEGREES, (degree - 1 + steps) % 7) as Degree;
}

/**
 * The core tones of a chord (root, third or sus tones, fifth(s), seventh), root first, each
 * spelled on a degree of the key: in C major V7 is 5 7 2 4, bVII is b7 2 4 and V/vi is 3 #5 7.
 * Extensions and added tones are left out, and the inversion does not change the set.
 */
export function chordTones(chord: Chord, key: Key): ChordTone[] {
  const s = chordStructure(chord);
  const rootPc = chordRootPitchClass(chord, key);
  const rootDegree =
    chord.applied === undefined ? chord.degree : stepDegree(chord.applied.target, chord.degree - 1);
  const slots: [ChordToneRole, number][] = [
    ['root', 0],
    ...s.thirds.map((i): [ChordToneRole, number] => ['third', i]),
    ...s.fifths.map((i): [ChordToneRole, number] => ['fifth', i]),
  ];
  if (s.seventh !== undefined) slots.push(['seventh', s.seventh]);
  return slots.map(([role, interval]) => {
    const pitchClass = toPitchClass(rootPc + interval);
    const degree = stepDegree(rootDegree, toneSteps(role, interval));
    const accidental = toPitchClass(pitchClass - pitchClassOf(key, degree) + 6) - 6;
    return { role, interval, pitchClass, degree, accidental };
  });
}

/** Position on the circle of fifths of each major-scale degree, relative to the tonic. */
const MAJOR_DEGREE_FIFTHS = [0, 2, 4, -1, 1, 3, 5] as const;

/** Which degree of its parent major scale each mode starts on (0-based). */
const MODE_ROTATION: Record<Mode, number> = {
  major: 0,
  dorian: 1,
  phrygian: 2,
  lydian: 3,
  mixolydian: 4,
  minor: 5,
  locrian: 6,
  harmonicMinor: 5,
  phrygianDominant: 2,
};

/** Interval above the root -> its offset on the circle of fifths (b5 = -6, bb7 = -9...). */
const INTERVAL_FIFTHS: Readonly<Record<number, number>> = {
  0: 0,
  2: 2,
  3: -3,
  4: 4,
  5: -1,
  6: -6,
  7: 1,
  8: 8,
  9: -9,
  10: -2,
  11: 5,
};

function at(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) throw new RangeError(`Index out of range: ${index}`);
  return value;
}

/**
 * Circle-of-fifths position (C = 0, G = 1, F = -1, Bb = -2, F# = 6...) of a scale degree,
 * spelled from the key's signature. Only used to decide between flats and sharps.
 */
function degreeFifths(key: Key, degree: Degree, accidental: number): number {
  const rotation = MODE_ROTATION[key.mode];
  const parentIndex = (degree - 1 + rotation) % 7;
  const parentTonic = key.tonic - at(SCALES.major, rotation);
  const parentPc = toPitchClass(parentTonic + at(SCALES.major, parentIndex));
  // Harmonic minor and phrygian dominant raise one degree of their parent scale.
  const raised = ((pitchClassOf(key, degree) - parentPc + 18) % 12) - 6;
  return keySignature(key) + at(MAJOR_DEGREE_FIFTHS, parentIndex) + 7 * (raised + accidental);
}

function rootFifths(chord: Chord, key: Key): number {
  if (chord.applied === undefined) return degreeFifths(key, chord.degree, chord.accidental);
  const { target, targetAccidental } = chord.applied;
  return degreeFifths(key, target, targetAccidental) + at(MAJOR_DEGREE_FIFTHS, chord.degree - 1);
}

/** Natural notes sit at -1..5 on the circle of fifths; further left is flat, right is sharp. */
function spell(pc: PitchClass, fifths: number): string {
  return noteName(pc, fifths < 0);
}

const QUALITY_SYMBOL: Record<Quality, string> = { major: '', minor: 'm', dim: '°', aug: '+' };

function qualityAndExtensionName(chord: Chord): string {
  const { quality, extension } = chord;
  const sus = chord.sus.length > 0;
  if (extension === 'none') return sus ? '' : QUALITY_SYMBOL[quality];
  if (isDiminishedExtension(extension)) {
    return quality === 'dim' || sus ? extension : QUALITY_SYMBOL[quality] + extension;
  }
  if (sus) return extension;
  if (quality === 'dim') {
    // A diminished triad with a minor seventh is half-diminished.
    return extension.startsWith('maj') ? `°${extension}` : `ø${extension}`;
  }
  if (quality === 'minor' && extension.startsWith('maj')) return `mMaj${extension.slice(3)}`;
  return QUALITY_SYMBOL[quality] + extension;
}

/**
 * Lead-sheet chord name: 'C', 'Am', 'G7', 'Fmaj7', 'Bø7', 'B°7', 'C+', 'Gsus4', 'Cadd9',
 * 'G/B'. Flats or sharps follow the key signature (keySignature / keyPrefersFlats) and the
 * chord's position in it, so 'bVII' in C is 'Bb', 'IV/IV' is 'Bb' and 'V/vi/1' is 'E/G#'.
 * Sus chords omit the quality symbol; a sus chord on a diminished or augmented
 * triad gets '(b5)' / '(#5)' so the altered fifth is not lost.
 */
export function chordName(chord: Chord, key: Key): string {
  const fifths = rootFifths(chord, key);
  let name = spell(chordRootPitchClass(chord, key), fifths) + qualityAndExtensionName(chord);
  for (const s of chord.sus) name += `sus${s}`;
  for (const a of chord.adds) name += `add${a}`;
  const alts = new Set(chord.alterations);
  if (chord.sus.length > 0 && !alts.has('b5') && !alts.has('#5')) {
    if (chord.quality === 'dim') alts.add('b5');
    if (chord.quality === 'aug') alts.add('#5');
  }
  for (const a of ALTERATIONS) if (alts.has(a)) name += `(${a})`;
  if (chord.inversion !== 0) {
    const bassFifths = fifths + (INTERVAL_FIFTHS[bassInterval(chord)] ?? 0);
    name += `/${spell(chordBassPitchClass(chord, key), bassFifths)}`;
  }
  return name;
}

export interface VoicingOptions {
  /** Octave of the bass note, default 2. */
  bassOctave?: number;
  /** Octave the close-position chord starts in, default 4. */
  octave?: number;
}

/**
 * MIDI notes: the bass note (chordBassPitchClass) in `bassOctave`, then every chord tone in
 * close position from `octave` upward. The lowest upper tone is the root, or for inversions
 * the inverted tone; the remaining tones follow in interval order, each stacked as the
 * nearest note above the previous one.
 */
export function voiceChord(chord: Chord, key: Key, opts: VoicingOptions = {}): number[] {
  const bassOctave = opts.bassOctave ?? 2;
  const octave = opts.octave ?? 4;
  const bassPc = chordBassPitchClass(chord, key);
  const pcs = chordPitchClasses(chord, key);
  const start = Math.max(0, pcs.indexOf(bassPc));
  const rotated = [...pcs.slice(start), ...pcs.slice(0, start)];

  const notes = [midiNote(bassPc, bassOctave)];
  let previous: number | undefined;
  for (const pc of rotated) {
    let note = midiNote(pc, octave);
    if (previous !== undefined) {
      while (note <= previous) note += 12;
    }
    notes.push(note);
    previous = note;
  }
  return notes;
}
