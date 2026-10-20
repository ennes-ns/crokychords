/**
 * Akai Fire OLED (docs/specs/akai-fire-v1.md §v2): what the 128x64 screen shows, drawn in the
 * Pixel theme's font. Pure: `oledModel` turns state into a few strings, `renderOled` draws them,
 * `oledUpdate` turns a changed frame into one full-frame SysEx. The connection decides when.
 *
 *   rows  0-9   status: mode badge, bar:beat, loop and play/stop icons
 *   rows 11-30  selected chord: Roman numeral (2x), letter name and length on the right
 *   rows 31-63  three suggestions around the SELECT cursor, the cursor row inverted
 *
 * While a knob is touched, rows 11-63 show its parameter name and value in big digits instead.
 */
import { songKey, totalBeats, tryParseToken } from '@crokychords/core';
import { barLength, chordStarts } from '../../edit';
import { tokenName } from '../../music';
import type { AppState, FireMode } from '../../state';
import type { SuggestionItem } from '../../views/suggest';
import { GLYPHS, GLYPH_H, GLYPH_W } from './font';
import type { OledFrame } from './protocol';
import {
  ENC_FILTER,
  ENC_PAN,
  ENC_RESONANCE,
  ENC_VOLUME,
  OLED_H,
  OLED_W,
  blankFrame,
  oledSysex,
} from './protocol';
import { cursorLimit } from './view';

/** Measured on the device (spec §v2): 30 full frames per second never queue. */
export const OLED_MAX_FPS = 30;

// --- drawing ------------------------------------------------------------------------------

export function textWidth(text: string, scale = 1): number {
  return [...text].length * GLYPH_W * scale;
}

/**
 * Draw `text` with its glyph cell's top-left at (x, y); `scale` 1..3. Pixels are set to `on`
 * (0 draws dark text on an inverted bar). Characters without a glyph draw as `?`.
 */
export function drawText(
  frame: OledFrame,
  text: string,
  x: number,
  y: number,
  scale = 1,
  on = 1,
): void {
  [...text].forEach((ch, k) => {
    const rows = GLYPHS.get(ch) ?? GLYPHS.get('?') ?? '';
    for (let gy = 0; gy < GLYPH_H; gy++) {
      const bits = parseInt(rows.slice(gy * 2, gy * 2 + 2), 16);
      if (!bits) continue;
      for (let gx = 0; gx < GLYPH_W; gx++) {
        if (!(bits & (1 << (GLYPH_W - 1 - gx)))) continue;
        fillRect(frame, x + (k * GLYPH_W + gx) * scale, y + gy * scale, scale, scale, on);
      }
    }
  });
}

export function fillRect(
  frame: OledFrame,
  x: number,
  y: number,
  w: number,
  h: number,
  value = 1,
): void {
  for (let py = Math.max(0, y); py < Math.min(OLED_H, y + h); py++) {
    for (let px = Math.max(0, x); px < Math.min(OLED_W, x + w); px++) {
      frame[py * OLED_W + px] = value;
    }
  }
}

/** Shorten `text` to at most `width` pixels at `scale`. */
export function fit(text: string, width: number, scale = 1): string {
  const max = Math.max(0, Math.floor(width / (GLYPH_W * scale)));
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

export const ICONS = {
  play: ['#......', '###....', '#####..', '#######', '#####..', '###....', '#......'],
  stop: ['.......', '######.', '######.', '######.', '######.', '######.', '######.'],
  loop: ['..####.', '.#....#', '###...#', '.#....#', '#....#.', '#...###', '.####..'],
} as const;

export function drawIcon(frame: OledFrame, icon: readonly string[], x: number, y: number): void {
  icon.forEach((line, gy) => {
    [...line].forEach((cell, gx) => {
      if (cell === '#') fillRect(frame, x + gx, y + gy, 1, 1);
    });
  });
}

// --- model --------------------------------------------------------------------------------

export interface OledKnob {
  label: string;
  value: string;
  unit: string;
}

export interface OledSuggestion {
  token: string;
  name: string;
  /** '39%', or '' for the diatonic fallback without data. */
  percent: string;
}

/** Everything the OLED shows, as plain values: equal models draw equal frames. */
export interface OledModel {
  mode: FireMode;
  /** 'bar:beat' of the playhead while playing, else of the selected slot. */
  position: string;
  playing: boolean;
  loop: boolean;
  /** Roman numeral of the selected chord, '+' on the "+" slot. */
  roman: string;
  name: string;
  /** Length of the selected chord ('4 beats'), or the chord count on the "+" slot. */
  detail: string;
  /** Up to three suggestions around the cursor. */
  suggestions: OledSuggestion[];
  /** Row of `suggestions` under the SELECT cursor, null when there are none. */
  cursorRow: number | null;
  knob: OledKnob | null;
}

/** Visible suggestion rows. */
export const SUGGESTION_ROWS = 3;
const INVERSIONS = ['root', '1st', '2nd', '3rd'] as const;

function formatBeats(beats: number): string {
  return String(Math.round(beats * 100) / 100);
}

function position(song: AppState['song'], beat: number): string {
  const bar = barLength(song);
  if (bar <= 0) return '1:1';
  const b = Math.max(0, beat);
  return `${Math.floor(b / bar) + 1}:${Math.floor(b % bar) + 1}`;
}

function knob(
  state: Pick<AppState, 'song' | 'selected'>,
  encoder: number,
  inversion: number,
): OledKnob | null {
  const { song, selected } = state;
  const chord = selected === null ? undefined : song.chords[selected];
  const none: OledKnob = { label: '', value: '-', unit: 'select a chord' };
  switch (encoder) {
    case ENC_RESONANCE:
      return { label: 'Tempo', value: String(song.tempo), unit: 'BPM' };
    case ENC_VOLUME:
      return chord === undefined
        ? { ...none, label: 'Length' }
        : { label: 'Length', value: formatBeats(chord.beats), unit: 'beats' };
    case ENC_PAN:
      return chord === undefined
        ? { ...none, label: 'Inversion' }
        : { label: 'Inversion', value: INVERSIONS[inversion] ?? 'root', unit: chord.token };
    case ENC_FILTER:
      return chord === undefined
        ? { ...none, label: 'Chord' }
        : { label: 'Chord', value: chord.token, unit: tokenName(chord.token, songKey(song)) };
    default:
      return null;
  }
}

/** What the OLED shows for `state`; `touched` is the encoder whose knob is touched. */
export function oledModel(
  state: Pick<AppState, 'song' | 'selected' | 'playing' | 'loop' | 'cursor' | 'fire'>,
  suggestions: readonly SuggestionItem[],
  touched: number | null,
): OledModel {
  const { song, selected } = state;
  const chord = selected === null ? undefined : song.chords[selected];
  const key = songKey(song);
  const at = state.playing
    ? state.cursor
    : selected === null
      ? totalBeats(song)
      : (chordStarts(song)[selected] ?? 0);

  const limit = cursorLimit(suggestions);
  const cursor = Math.max(0, Math.min(state.fire.cursor, limit - 1));
  const first = Math.max(0, Math.min(cursor - 1, limit - SUGGESTION_ROWS));
  const visible = suggestions.slice(first, Math.min(limit, first + SUGGESTION_ROWS));

  const inversion = chord === undefined ? 0 : (tryParseToken(chord.token)?.inversion ?? 0);

  return {
    mode: state.fire.mode,
    position: position(song, at),
    playing: state.playing,
    loop: state.loop,
    roman: chord === undefined ? '+' : chord.token,
    name: chord === undefined ? 'add' : tokenName(chord.token, key),
    detail:
      chord === undefined
        ? `${song.chords.length} chords`
        : `${formatBeats(chord.beats)} ${chord.beats === 1 ? 'beat' : 'beats'}`,
    suggestions: visible.map((item) => ({
      token: item.token,
      name: item.name,
      percent: item.probability === null ? '' : `${Math.round(item.probability * 100)}%`,
    })),
    cursorRow: visible.length === 0 ? null : cursor - first,
    knob: touched === null ? null : knob(state, touched, inversion),
  };
}

// --- frame --------------------------------------------------------------------------------

const STATUS_Y = 0; // caps on rows 1-8
const CHORD_Y = 9;
const SUGGEST_Y = 31;
const LINE = GLYPH_H;
const RIGHT = OLED_W - 1;

function drawStatus(frame: OledFrame, model: OledModel): void {
  const badge = model.mode === 'replace' ? 'REPLACE' : 'ADD';
  const w = textWidth(badge) + 2;
  fillRect(frame, 0, 0, w, 10);
  drawText(frame, badge, 1, STATUS_Y, 1, 0);
  drawText(frame, model.position, w + 6, STATUS_Y);
  if (model.loop) drawIcon(frame, ICONS.loop, RIGHT - 17, 2);
  drawIcon(frame, model.playing ? ICONS.play : ICONS.stop, RIGHT - 7, 2);
}

function drawChord(frame: OledFrame, model: OledModel): void {
  const side = Math.max(textWidth(model.name), textWidth(model.detail));
  const room = OLED_W - Math.min(side, 6 * GLYPH_W) - 4;
  const scale = textWidth(model.roman, 2) <= room ? 2 : 1;
  const roman = fit(model.roman, room, scale);
  drawText(frame, roman, 0, scale === 2 ? CHORD_Y : CHORD_Y + 6, scale);
  const left = textWidth(roman, scale) + 4;
  const name = fit(model.name, OLED_W - left);
  const detail = fit(model.detail, OLED_W - left);
  drawText(frame, name, OLED_W - textWidth(name), CHORD_Y + 1);
  drawText(frame, detail, OLED_W - textWidth(detail), CHORD_Y + 11);
}

function drawSuggestions(frame: OledFrame, model: OledModel): void {
  if (model.suggestions.length === 0) {
    drawText(frame, 'no suggestions', 2, SUGGEST_Y + LINE);
    return;
  }
  model.suggestions.forEach((s, row) => {
    const y = SUGGEST_Y + row * LINE;
    const on = row === model.cursorRow ? 0 : 1;
    if (on === 0) fillRect(frame, 0, y, OLED_W, LINE);
    const pctX = OLED_W - 1 - textWidth(s.percent);
    drawText(frame, fit(s.token, 6 * GLYPH_W), 1, y, 1, on);
    drawText(frame, fit(s.name, pctX - 50 - 2), 50, y, 1, on);
    drawText(frame, s.percent, pctX, y, 1, on);
  });
}

function drawKnob(frame: OledFrame, knob: OledKnob): void {
  drawText(frame, knob.label, 1, CHORD_Y + 1);
  const scale = textWidth(knob.value, 3) <= OLED_W ? 3 : textWidth(knob.value, 2) <= OLED_W ? 2 : 1;
  const value = fit(knob.value, OLED_W, scale);
  drawText(frame, value, 0, scale === 3 ? 17 : 24, scale);
  const unit = fit(knob.unit, OLED_W);
  drawText(frame, unit, OLED_W - textWidth(unit), 52);
}

export function renderOled(model: OledModel): OledFrame {
  const frame = blankFrame();
  drawStatus(frame, model);
  if (model.knob !== null) {
    drawKnob(frame, model.knob);
  } else {
    drawChord(frame, model);
    drawSuggestions(frame, model);
  }
  return frame;
}

// --- updates ------------------------------------------------------------------------------

/** True when two frames light the same pixels. */
export function sameFrame(a: OledFrame, b: OledFrame): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!a[i] !== !b[i]) return false;
  return true;
}

/**
 * The SysEx that shows `next` when the device shows `previous` (null: unknown), or null when
 * nothing changed. Always a full 1183-byte frame: partial-band updates did not display on the
 * device (firmware 0.22, spec "v2 as built").
 */
export function oledUpdate(previous: OledFrame | null, next: OledFrame): number[] | null {
  return previous !== null && sameFrame(previous, next) ? null : oledSysex(next);
}
