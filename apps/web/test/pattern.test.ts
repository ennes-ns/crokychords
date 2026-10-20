import type { Pattern } from '@crokychords/core';
import { createSong, patternPreset, validateSong } from '@crokychords/core';
import { describe, expect, it } from 'vitest';
import {
  ACCENT_NORMAL,
  CUSTOM_PATTERN_ID,
  MIN_TONE_ROWS,
  addStep,
  clearSteps,
  fillDownUp,
  fillStrum,
  isAccented,
  patternColumns,
  patternRows,
  removeStep,
  selectorKey,
  setPatternLength,
  setPatternTail,
  setStepEnd,
  stepAt,
  toggleAccent,
} from '../src/pattern';

const empty = (length = 4): Pattern => ({ id: 'mine', name: 'Mine', length, steps: [] });

/** The pattern is valid song data (validateSong accepts it unchanged). */
function expectValid(pattern: Pattern): void {
  const song = createSong({ tracks: [], patterns: [] });
  const value = JSON.parse(JSON.stringify({ ...song, patterns: [{ ...pattern, id: 'user-x' }] }));
  expect(validateSong(value).patterns?.[0]).toEqual({ ...pattern, id: 'user-x' });
}

describe('patternRows', () => {
  it('lists chord, top, tones n..1, octave, fifth, root, bass', () => {
    const keys = patternRows(empty()).map((r) => r.key);
    expect(keys).toEqual([
      'chord',
      'top',
      ...Array.from({ length: MIN_TONE_ROWS }, (_, i) => `t${MIN_TONE_ROWS - 1 - i}`),
      'octave',
      'fifth',
      'root',
      'bass',
    ]);
    expect(patternRows(empty()).find((r) => r.key === 't0')?.label).toBe('Tone 1');
  });

  it('adds tone rows for higher indices', () => {
    const rows = patternRows({ ...empty(), steps: [{ at: 0, length: 1, notes: { index: 11 } }] });
    expect(rows.filter((r) => /^t\d+$/.test(r.key))).toHaveLength(12);
    expect(rows[2]?.key).toBe('t11');
  });

  it('every row key matches its selector and every preset step has a row', () => {
    for (const id of ['arp-up-16', 'bass-walk-4', 'waltz-3', 'quarters', 'bass-root-fifth']) {
      const p = patternPreset(id);
      const rows = patternRows(p);
      expect(rows.every((r) => selectorKey(r.selector) === r.key)).toBe(true);
      for (const s of p.steps) expect(rows.some((r) => r.key === selectorKey(s.notes))).toBe(true);
    }
  });
});

describe('patternColumns and stepAt', () => {
  it('has one column per 1/16', () => {
    expect(patternColumns(empty(4))).toBe(16);
    expect(patternColumns(empty(3))).toBe(12);
    expect(patternColumns(empty(1))).toBe(4);
  });

  it('finds the step starting in a cell, else the one covering it', () => {
    const p = patternPreset('pop-ballad'); // chord at 0 (1.5), 1.5 (0.5), 2 (1), 3 (1)
    expect(stepAt(p, 'chord', 0)).toBe(0);
    expect(stepAt(p, 'chord', 5)).toBe(0); // beat 1.25 lies inside the first step
    expect(stepAt(p, 'chord', 6)).toBe(1);
    expect(stepAt(p, 'bass', 0)).toBeNull();
    expect(stepAt(empty(), 'chord', 0)).toBeNull();
  });
});

describe('step edits', () => {
  it('adds a normal 1/16 step and turns the pattern custom', () => {
    const { pattern, index } = addStep(patternPreset('quarters'), { index: 2 }, 0.5);
    expect(pattern.id).toBe(CUSTOM_PATTERN_ID);
    expect(pattern.name).toBe('Quarter stabs');
    expect(pattern.steps[index]).toEqual({
      at: 0.5,
      length: 0.25,
      notes: { index: 2 },
      accent: ACCENT_NORMAL,
    });
    expect(pattern.steps.map((s) => s.at)).toEqual([0, 0.5, 1, 2, 3]);
    expectValid(pattern);
  });

  it('adds accented steps without an accent field and sorts low rows first', () => {
    const one = addStep(empty(), 'chord', 0, true).pattern;
    const two = addStep(one, 'bass', 0, true);
    expect(two.pattern.steps).toEqual([
      { at: 0, length: 0.25, notes: 'bass' },
      { at: 0, length: 0.25, notes: 'chord' },
    ]);
    expect(two.index).toBe(0);
  });

  it('does not let a new step run past the pattern end', () => {
    const { pattern } = addStep(empty(1), 'chord', 0.75, false, 1);
    expect(pattern.steps[0]?.length).toBe(0.25);
  });

  it('removes a step', () => {
    const p = patternPreset('half');
    expect(removeStep(p, 0).steps).toEqual([{ at: 2, length: 2, notes: 'chord' }]);
    expect(removeStep(p, 5)).toBe(p);
  });

  it('sets a step end on the grid, at least 1/16 and at most the pattern end', () => {
    const p = addStep(empty(), 'root', 1).pattern;
    expect(setStepEnd(p, 0, 2).steps[0]?.length).toBe(1);
    expect(setStepEnd(p, 0, 0.5).steps[0]?.length).toBe(0.25);
    expect(setStepEnd(p, 0, 9).steps[0]?.length).toBe(3);
    expect(setStepEnd(p, 0, 1.25)).toBe(p); // unchanged
    expect(setStepEnd(p, 3, 2)).toBe(p);
  });

  it('keeps the step order while dragging, so indices stay valid', () => {
    const unsorted: Pattern = {
      ...empty(),
      steps: [
        { at: 2, length: 0.5, notes: 'chord' },
        { at: 0, length: 0.5, notes: 'chord' },
      ],
    };
    expect(setStepEnd(unsorted, 0, 3).steps.map((s) => [s.at, s.length])).toEqual([
      [2, 1],
      [0, 0.5],
    ]);
  });

  it('toggles the accent', () => {
    const p = patternPreset('quarters');
    const soft = toggleAccent(p, 1);
    expect(soft.steps[1]?.accent).toBe(ACCENT_NORMAL);
    expect(soft.steps[1] !== undefined && isAccented(soft.steps[1])).toBe(false);
    const loud = toggleAccent(soft, 1);
    expect(loud.steps[1]).not.toHaveProperty('accent');
    expect(loud.steps[1] !== undefined && isAccented(loud.steps[1])).toBe(true);
    expect(isAccented({ at: 0, length: 1, notes: 'chord', accent: 0.8 })).toBe(false);
    expect(toggleAccent(p, 9)).toBe(p);
  });
});

describe('pattern edits', () => {
  it('changes the length: drops later steps and cuts long ones', () => {
    const p = patternPreset('pop-ballad');
    const short = setPatternLength(p, 2);
    expect(short).toMatchObject({ id: CUSTOM_PATTERN_ID, length: 2 });
    expect(short.steps.map((s) => [s.at, s.length])).toEqual([
      [0, 1.5],
      [1.5, 0.5],
    ]);
    expect(setPatternLength(patternPreset('sustain'), 1).steps[0]?.length).toBe(1);
    expect(setPatternLength(p, 4)).toBe(p);
    expect(setPatternLength(p, 0)).toBe(p);
    expectValid(short);
  });

  it('turns hold (tail sustain) on and off', () => {
    const p = patternPreset('quarters');
    expect(setPatternTail(p, true).tail).toBe('sustain');
    expect(setPatternTail(p, false)).toBe(p);
    const off = setPatternTail(patternPreset('sustain'), false);
    expect(off).not.toHaveProperty('tail');
    expect(off.id).toBe(CUSTOM_PATTERN_ID);
  });

  it('strum: tones 1-4 a 1/16 apart on every beat, held to the end of the beat', () => {
    const p = fillStrum(empty(2));
    expect(p.steps.map((s) => [s.at, s.length, s.notes, s.accent])).toEqual([
      [0, 1, { index: 0 }, undefined],
      [0.25, 0.75, { index: 1 }, ACCENT_NORMAL],
      [0.5, 0.5, { index: 2 }, ACCENT_NORMAL],
      [0.75, 0.25, { index: 3 }, ACCENT_NORMAL],
      [1, 1, { index: 0 }, undefined],
      [1.25, 0.75, { index: 1 }, ACCENT_NORMAL],
      [1.5, 0.5, { index: 2 }, ACCENT_NORMAL],
      [1.75, 0.25, { index: 3 }, ACCENT_NORMAL],
    ]);
    expectValid(fillStrum(empty(3)));
  });

  it('down-up: the chord on every 1/8, accented on the beat', () => {
    const p = fillDownUp(empty(1));
    expect(p.steps).toEqual([
      { at: 0, length: 0.45, notes: 'chord' },
      { at: 0.5, length: 0.3, notes: 'chord', accent: ACCENT_NORMAL },
    ]);
    expect(fillDownUp(empty(4)).steps).toHaveLength(8);
    expectValid(fillDownUp(empty(3)));
  });

  it('clears every step', () => {
    expect(clearSteps(patternPreset('eighths'))).toMatchObject({ id: 'custom', steps: [] });
    const none = empty();
    expect(clearSteps(none)).toBe(none);
  });
});
