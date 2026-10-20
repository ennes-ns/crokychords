/**
 * Pure pattern edits for the pattern editor (docs/specs/pattern-editor-v1.md, B2): the grid rows,
 * hit-testing a 1/16 cell, and edits that turn any pattern into a custom one.
 */
import type { NoteSelector, Pattern, PatternStep } from '@crokychords/core';
import { clonePattern } from '@crokychords/core';

/** One grid column: a 1/16 note. */
export const PATTERN_STEP = 0.25;
/** Lengths the editor offers, in beats. */
export const PATTERN_LENGTHS: readonly number[] = [1, 2, 3, 4];
/** Accent of a normal (not accented) step; accented steps play at full track velocity. */
export const ACCENT_NORMAL = 0.75;
/** Tone rows shown at least (more when a pattern uses higher indices). */
export const MIN_TONE_ROWS = 8;
/** Id of a pattern that is not a preset. */
export const CUSTOM_PATTERN_ID = 'custom';

export interface PatternRow {
  /** Stable key: the selector name, or 't<index>' for tone rows. */
  key: string;
  selector: NoteSelector;
  label: string;
  title: string;
}

export function selectorKey(selector: NoteSelector): string {
  return typeof selector === 'string' ? selector : `t${selector.index}`;
}

const NAMED_ROWS: Record<Exclude<NoteSelector, { index: number }>, PatternRow> = {
  chord: { key: 'chord', selector: 'chord', label: 'Chord', title: 'All chord tones at once' },
  top: { key: 'top', selector: 'top', label: 'Top', title: 'The highest chord tone' },
  octave: {
    key: 'octave',
    selector: 'octave',
    label: 'Octave',
    title: 'The bass note one octave up',
  },
  fifth: {
    key: 'fifth',
    selector: 'fifth',
    label: 'Fifth',
    title: 'The fifth above the bass note (the root when the chord has none there)',
  },
  root: { key: 'root', selector: 'root', label: 'Root', title: 'The root, ignoring inversions' },
  bass: { key: 'bass', selector: 'bass', label: 'Bass', title: 'The bass note of the chord' },
};

function toneRow(index: number): PatternRow {
  return {
    key: `t${index}`,
    selector: { index },
    label: `Tone ${index + 1}`,
    title:
      `Chord tone ${index + 1} from the bottom of the voicing ` +
      '(on a triad: root, 3rd, 5th, then the same an octave up)',
  };
}

/**
 * Grid rows, top to bottom: Chord, Top, tones n..1, Octave, Fifth, Root, Bass. At least
 * MIN_TONE_ROWS tone rows, more when the pattern uses higher indices.
 */
export function patternRows(pattern: Pattern): PatternRow[] {
  const highest = pattern.steps.reduce(
    (max, s) => (typeof s.notes === 'object' ? Math.max(max, s.notes.index) : max),
    -1,
  );
  const tones = Math.max(MIN_TONE_ROWS, highest + 1);
  return [
    NAMED_ROWS.chord,
    NAMED_ROWS.top,
    ...Array.from({ length: tones }, (_, i) => toneRow(tones - 1 - i)),
    NAMED_ROWS.octave,
    NAMED_ROWS.fifth,
    NAMED_ROWS.root,
    NAMED_ROWS.bass,
  ];
}

/** Number of 1/16 columns of the grid. */
export function patternColumns(pattern: Pattern): number {
  return Math.max(1, Math.ceil(pattern.length / PATTERN_STEP - 1e-9));
}

/** Accented steps play at full track velocity (`accent` absent or 1). */
export function isAccented(step: PatternStep): boolean {
  return (step.accent ?? 1) >= 1;
}

/**
 * Index of the step in row `key` that starts inside 1/16 cell `cell`, else of the step in that
 * row covering the cell, else null.
 */
export function stepAt(pattern: Pattern, key: string, cell: number): number | null {
  const from = cell * PATTERN_STEP;
  const to = from + PATTERN_STEP;
  const inRow = (s: PatternStep): boolean => selectorKey(s.notes) === key;
  const starts = pattern.steps.findIndex((s) => inRow(s) && s.at >= from && s.at < to);
  if (starts >= 0) return starts;
  const covers = pattern.steps.findIndex((s) => inRow(s) && s.at < from && s.at + s.length > from);
  return covers >= 0 ? covers : null;
}

/** Sort rank of a selector inside one beat position: low notes first. */
function rank(selector: NoteSelector): number {
  if (typeof selector === 'object') return 10 + selector.index;
  return { bass: 0, root: 1, fifth: 2, octave: 3, top: 1000, chord: 1001 }[selector];
}

/**
 * A custom copy of `pattern` with `steps`, sorted by start, then low to high rows (`sort`
 * false keeps the given order, so step indices stay valid during a drag).
 */
function custom(
  pattern: Pattern,
  steps: PatternStep[],
  changes: Partial<Pattern> = {},
  sort = true,
): Pattern {
  const copy = clonePattern({ ...pattern, ...changes, steps });
  copy.id = CUSTOM_PATTERN_ID;
  if (sort) copy.steps.sort((a, b) => a.at - b.at || rank(a.notes) - rank(b.notes));
  return copy;
}

function step(selector: NoteSelector, at: number, length: number, accented: boolean): PatternStep {
  const s: PatternStep = { at, length, notes: selector };
  if (!accented) s.accent = ACCENT_NORMAL;
  return s;
}

/** Add a step (normal or accented); returns the pattern and the new step's index. */
export function addStep(
  pattern: Pattern,
  selector: NoteSelector,
  at: number,
  accented = false,
  length = PATTERN_STEP,
): { pattern: Pattern; index: number } {
  const added = step(selector, at, Math.min(length, pattern.length - at), accented);
  const next = custom(pattern, [...pattern.steps, added]);
  const index = next.steps.findIndex(
    (s) => s.at === added.at && selectorKey(s.notes) === selectorKey(selector),
  );
  return { pattern: next, index };
}

export function removeStep(pattern: Pattern, index: number): Pattern {
  if (pattern.steps[index] === undefined) return pattern;
  return custom(
    pattern,
    pattern.steps.filter((_, i) => i !== index),
  );
}

/**
 * Let step `index` end at beat `end` (clamped to at least one 1/16 and to the pattern end). The
 * step order is kept, so the index stays valid while dragging.
 */
export function setStepEnd(pattern: Pattern, index: number, end: number): Pattern {
  const s = pattern.steps[index];
  if (s === undefined) return pattern;
  const room = pattern.length - s.at;
  const length = Math.max(Math.min(PATTERN_STEP, room), Math.min(end, pattern.length) - s.at);
  if (length === s.length) return pattern;
  return custom(
    pattern,
    pattern.steps.map((x, i) => (i === index ? { ...x, length } : x)),
    {},
    false,
  );
}

/** Accented ↔ normal. */
export function toggleAccent(pattern: Pattern, index: number): Pattern {
  const s = pattern.steps[index];
  if (s === undefined) return pattern;
  const toggled = step(s.notes, s.at, s.length, !isAccented(s));
  return custom(
    pattern,
    pattern.steps.map((x, i) => (i === index ? toggled : x)),
    {},
    false,
  );
}

/** New length in beats: later steps are dropped, steps running past the end are cut. */
export function setPatternLength(pattern: Pattern, length: number): Pattern {
  if (!(length > 0) || length === pattern.length) return pattern;
  const steps = pattern.steps
    .filter((s) => s.at < length)
    .map((s) => (s.at + s.length > length ? { ...s, length: length - s.at } : s));
  return custom(pattern, steps, { length });
}

/** `tail: 'sustain'` (hold the last step to the chord end) on or off. */
export function setPatternTail(pattern: Pattern, hold: boolean): Pattern {
  if ((pattern.tail === 'sustain') === hold) return pattern;
  const next = custom(pattern, pattern.steps);
  if (hold) next.tail = 'sustain';
  else delete next.tail;
  return next;
}

/** Beats 0, 1, ... inside the pattern. */
function beats(pattern: Pattern): number[] {
  return Array.from({ length: Math.ceil(pattern.length - 1e-9) }, (_, b) => b);
}

/**
 * Strum: on every beat tones 1-4 enter one 1/16 apart and ring to the end of the beat (the first
 * one accented).
 */
export function fillStrum(pattern: Pattern): Pattern {
  const steps: PatternStep[] = [];
  for (const b of beats(pattern)) {
    const end = Math.min(b + 1, pattern.length);
    for (let i = 0; i < 4; i++) {
      const at = b + i * PATTERN_STEP;
      if (at >= end) break;
      steps.push(step({ index: i }, at, end - at, i === 0));
    }
  }
  return custom(pattern, steps);
}

/** Down-up: the chord on every 1/8, accented on the beat (down) and normal between (up). */
export function fillDownUp(pattern: Pattern): Pattern {
  const steps: PatternStep[] = [];
  for (const b of beats(pattern)) {
    for (const [offset, down] of [
      [0, true],
      [0.5, false],
    ] as const) {
      const at = b + offset;
      if (at >= pattern.length) continue;
      steps.push(step('chord', at, Math.min(down ? 0.45 : 0.3, pattern.length - at), down));
    }
  }
  return custom(pattern, steps);
}

export function clearSteps(pattern: Pattern): Pattern {
  return pattern.steps.length === 0 ? pattern : custom(pattern, []);
}
