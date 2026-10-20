/**
 * Akai Fire pad layout (variant C, docs/specs/akai-fire-v1.md section 3): rows 1-3 are the
 * timeline (one pad per beat, sixteen beats = four 4/4 bars per row), row 4 the palette
 * (diatonic triads I..vii° on pads 1-7, the top eight Next chord suggestions on pads 9-16).
 * Everything here is pure: state in, colours and tokens out.
 */
import type { Song } from '@crokychords/core';
import { diatonicTriadToken, totalBeats } from '@crokychords/core';
import { barLength, chordStarts } from '../../edit';
import { DEGREES, colorDegree, degreeHue } from '../../music';
import type { AppState } from '../../state';
import type { SuggestionItem } from '../../views/suggest';
import type { Rgb } from './protocol';
import { BLACK, COLS, PAD_COUNT, hueRgb } from './protocol';

export const TIMELINE_ROWS = 3;
export const ROW_BEATS = COLS;
export const PALETTE_ROW = 3;
/** Palette pads 9-16 hold this many suggestions. */
export const SUGGESTION_PADS = 8;
const SUGGESTION_COL = 8;

const WHITE: Rgb = [127, 127, 127];
const APPEND_SLOT: Rgb = [14, 14, 14];
const BAR_START: Rgb = [2, 2, 2];
const REST_FIRST: Rgb = [20, 20, 20];
const REST_HELD: Rgb = [6, 6, 6];

/** Song beat under a timeline pad. */
export function padBeat(scroll: number, row: number, col: number): number {
  return (scroll + row) * ROW_BEATS + col;
}

/**
 * Chord shown on the pad of beat `beat` (the span [beat, beat + 1)): the chord sounding at its
 * start, else one that starts inside it (chords can be quarter beats long), else null.
 */
export function chordAtBeat(song: Song, beat: number): number | null {
  const starts = chordStarts(song);
  let inside: number | null = null;
  for (let i = 0; i < song.chords.length; i++) {
    const start = starts[i] ?? 0;
    const end = start + (song.chords[i]?.beats ?? 0);
    if (start <= beat && beat < end) return i;
    if (inside === null && start > beat && start < beat + 1) inside = i;
  }
  return inside;
}

/** The pad holding a chord's first beat. */
export function firstPadBeat(song: Song, index: number): number {
  return Math.floor(chordStarts(song)[index] ?? 0);
}

/** Highest useful scroll: the row holding the append slot is the last visible row. */
export function maxScroll(song: Song): number {
  const lastRow = Math.floor(Math.ceil(totalBeats(song)) / ROW_BEATS);
  return Math.max(0, lastRow - TIMELINE_ROWS + 1);
}

/** Token on a palette pad (column 0..15), or null for the gap and missing suggestions. */
export function paletteToken(
  state: Pick<AppState, 'song'>,
  suggestions: readonly SuggestionItem[],
  col: number,
): string | null {
  const degree = DEGREES[col];
  if (col < DEGREES.length && degree !== undefined) {
    return diatonicTriadToken(degree, state.song.key.mode);
  }
  if (col < SUGGESTION_COL) return null;
  return suggestions[col - SUGGESTION_COL]?.token ?? null;
}

/** Number of suggestions the SELECT cursor can reach. */
export function cursorLimit(suggestions: readonly SuggestionItem[]): number {
  return Math.min(SUGGESTION_PADS, suggestions.length);
}

function tokenHue(token: string): number | null {
  const degree = colorDegree(token);
  return degree === null ? null : degreeHue(degree);
}

/** Colours of all 64 pads, index = row * 16 + col. */
export function renderPads(
  state: Pick<AppState, 'song' | 'selected' | 'playing' | 'cursor' | 'fire'>,
  suggestions: readonly SuggestionItem[],
): Rgb[] {
  const { song, selected, fire } = state;
  const pads: Rgb[] = new Array<Rgb>(PAD_COUNT).fill(BLACK);
  const starts = chordStarts(song);
  const total = Math.ceil(totalBeats(song));
  const bar = barLength(song);
  const playhead = state.playing ? Math.floor(state.cursor) : null;

  for (let row = 0; row < TIMELINE_ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const beat = padBeat(fire.scroll, row, col);
      const i = chordAtBeat(song, beat);
      let rgb: Rgb = BLACK;
      if (i !== null) {
        const chord = song.chords[i];
        const first = Math.floor(starts[i] ?? 0) === beat;
        const hue = chord === undefined ? null : tokenHue(chord.token);
        if (hue === null) rgb = first ? REST_FIRST : REST_HELD;
        else if (i === selected) rgb = hueRgb(hue, 1, first ? 0.45 : 0.6);
        else rgb = hueRgb(hue, first ? 0.9 : 0.22);
      } else if (beat === total) {
        rgb = APPEND_SLOT;
      } else if (bar > 0 && beat % bar === 0) {
        rgb = BAR_START;
      }
      if (beat === playhead) rgb = WHITE;
      pads[row * COLS + col] = rgb;
    }
  }

  const base = PALETTE_ROW * COLS;
  DEGREES.forEach((degree, col) => {
    pads[base + col] = hueRgb(degreeHue(degree), 0.55);
  });
  const cursor = Math.min(fire.cursor, cursorLimit(suggestions) - 1);
  suggestions.slice(0, SUGGESTION_PADS).forEach((item, k) => {
    const hue = tokenHue(item.token);
    const light =
      item.probability === null ? 0.55 : 0.15 + 0.85 * Math.min(1, item.probability / 0.4);
    let rgb: Rgb;
    if (hue === null) rgb = k === cursor ? WHITE : REST_FIRST;
    else rgb = k === cursor ? hueRgb(hue, 1, 0.3) : hueRgb(hue, light);
    pads[base + SUGGESTION_COL + k] = rgb;
  });
  return pads;
}
