/**
 * Chord grid: rows of bars, chord blocks spanning their beats, the "+" slot after the last chord,
 * selection, resize, and the loop range (shaded; set by clicking or dragging the bar numbers).
 */
import type { Song } from '@crokychords/core';
import { chordAtBeat, isRestToken, songKey, totalBeats } from '@crokychords/core';
import type { Actions } from '../actions';
import { h, replaceChildren } from '../dom';
import type { LoopRange } from '../loop';
import { barRange, extendRange, spanBars } from '../loop';
import { MIN_BEATS, barLength, chordStarts, insertLength, setChordBeats } from '../edit';
import { colorDegree, degreeHue, tokenName } from '../music';
import { TAB_SLOTS_ATTR } from '../shortcuts';
import type { AppState, Store } from '../state';

export const BARS_PER_ROW = 4;

export interface GridLayout {
  /** Beats (quarter notes) per bar. */
  barBeats: number;
  barsPerRow: number;
  rowBeats: number;
  rows: number;
  /** Meter ticks drawn per bar (meter.beats) and their length in beats. */
  ticksPerBar: number;
  beatsPerTick: number;
}

/** Enough rows for the song plus at least one empty bar to click into. */
export function gridLayout(song: Song, barsPerRow = BARS_PER_ROW): GridLayout {
  const barBeats = barLength(song);
  const usedBars = Math.ceil(totalBeats(song) / barBeats - 1e-9);
  const bars = Math.max(barsPerRow, usedBars + 1);
  return {
    barBeats,
    barsPerRow,
    rowBeats: barBeats * barsPerRow,
    rows: Math.ceil(bars / barsPerRow),
    ticksPerBar: song.meter.beats,
    beatsPerTick: 4 / song.meter.unit,
  };
}

/** Row index and fraction (0..1) of the row width at which `beat` lies. */
export function beatToRowPosition(
  beat: number,
  layout: GridLayout,
): { row: number; fraction: number } {
  const row = Math.max(0, Math.floor(beat / layout.rowBeats + 1e-9));
  return { row, fraction: (beat - row * layout.rowBeats) / layout.rowBeats };
}

/** Last known content width of each track, kept current by one shared ResizeObserver. */
const trackWidths = new WeakMap<Element, number>();
let trackObserver: ResizeObserver | null | undefined;

function trackWidth(track: HTMLElement): number {
  const cached = trackWidths.get(track);
  if (cached !== undefined) return cached;
  if (trackObserver === undefined) {
    trackObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver((entries) => {
            for (const entry of entries) trackWidths.set(entry.target, entry.contentRect.width);
          });
  }
  // Measured once per track (a new track, or no observer); later frames read the cache.
  const width = track.clientWidth;
  trackWidths.set(track, width);
  trackObserver?.observe(track);
  return width;
}

/**
 * Put a playhead at `fraction` (0..1) of `track`. It moves by `transform` on its own composited
 * layer, so playback never invalidates layout (issue #61). The Pixel theme snaps to whole pixels;
 * other themes keep sub-pixel positions for smooth motion.
 */
export function placePlayhead(playhead: HTMLElement, track: HTMLElement, fraction: number): void {
  if (playhead.parentElement !== track) track.append(playhead);
  const x = fraction * trackWidth(track);
  const snap = document.documentElement.dataset.theme === 'pixel';
  playhead.style.transform = `translateX(${snap ? Math.round(x) : x}px)`;
}

export function beatToX(
  beat: number,
  layout: GridLayout,
  rowWidth: number,
): { row: number; x: number } {
  const { row, fraction } = beatToRowPosition(beat, layout);
  return { row, x: fraction * rowWidth };
}

export interface XToBeatOptions {
  /** Grid in beats, default 1. */
  snap?: number;
  /** 'floor' gives the cell that was clicked, 'round' the nearest grid line (dragging). */
  rounding?: 'floor' | 'round';
  /** Keep the result inside the row (clicks); off for drags that run past the row's end. */
  clamp?: boolean;
}

/** Beat under pixel `x` of row `row` (`rowWidth` px wide), snapped to the grid. */
export function xToBeat(
  row: number,
  x: number,
  rowWidth: number,
  layout: GridLayout,
  options: XToBeatOptions = {},
): number {
  const { snap = 1, rounding = 'floor', clamp = true } = options;
  const raw = rowWidth > 0 ? x / rowWidth : 0;
  const fraction = clamp ? Math.min(1, Math.max(0, raw)) : Math.max(0, raw);
  const beat = (row + fraction) * layout.rowBeats;
  const snapped =
    (rounding === 'floor' ? Math.floor(beat / snap + 1e-9) : Math.round(beat / snap)) * snap;
  return clamp ? Math.min(snapped, (row + 1) * layout.rowBeats) : snapped;
}

export interface ChordSegment {
  index: number;
  token: string;
  row: number;
  /** Left edge and width as fractions of the row. */
  left: number;
  width: number;
  /** Segment holds the chord's start / end (a chord can wrap over rows). */
  first: boolean;
  last: boolean;
}

/** Chord blocks per row; a chord that crosses a row boundary is split. */
export function chordSegments(song: Song, layout: GridLayout): ChordSegment[] {
  const segments: ChordSegment[] = [];
  const starts = chordStarts(song);
  song.chords.forEach((chord, index) => {
    const start = starts[index] ?? 0;
    const end = start + chord.beats;
    let from = start;
    while (from < end - 1e-9) {
      const { row } = beatToRowPosition(from, layout);
      const rowEnd = (row + 1) * layout.rowBeats;
      const to = Math.min(end, rowEnd);
      segments.push({
        index,
        token: chord.token,
        row,
        left: (from - row * layout.rowBeats) / layout.rowBeats,
        width: (to - from) / layout.rowBeats,
        first: from === start,
        last: to === end,
      });
      from = to;
    }
  });
  return segments;
}

export interface LoopSegment {
  row: number;
  /** Left edge and width as fractions of the row. */
  left: number;
  width: number;
}

/** The loop range per row (split at row ends), limited to the rows the grid shows. */
export function loopSegments(range: LoopRange, layout: GridLayout): LoopSegment[] {
  const segments: LoopSegment[] = [];
  const end = Math.min(range.end, layout.rows * layout.rowBeats);
  let from = Math.max(0, range.start);
  while (from < end - 1e-9) {
    const { row } = beatToRowPosition(from, layout);
    const to = Math.min(end, (row + 1) * layout.rowBeats);
    segments.push({
      row,
      left: (from - row * layout.rowBeats) / layout.rowBeats,
      width: (to - from) / layout.rowBeats,
    });
    from = to;
  }
  return segments;
}

export interface PlusSlot {
  row: number;
  /** Left edge and width as fractions of the row. */
  left: number;
  width: number;
}

/**
 * Where the "+" slot sits: right after the last chord, as long as the chord a pick would append
 * there (the last chord's length, or `insertLength` in an empty song), cut at the row's end.
 */
export function plusSlot(song: Song, layout: GridLayout): PlusSlot {
  const start = totalBeats(song);
  const length = song.chords.at(-1)?.beats ?? insertLength(song, start);
  const { row, fraction } = beatToRowPosition(start, layout);
  const rowEnd = (row + 1) * layout.rowBeats;
  return {
    row,
    left: fraction,
    width: (Math.min(start + length, rowEnd) - start) / layout.rowBeats,
  };
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(4)}%`;
}

export function mountGrid(root: HTMLElement, store: Store, actions: Actions): void {
  root.classList.add('grid');
  root.setAttribute('aria-label', 'Chord grid');
  // Focusable so Tab / Shift+Tab can walk the chord slots (see bindShortcuts).
  root.tabIndex = 0;
  root.setAttribute(TAB_SLOTS_ATTR, '');
  const playhead = h('div', { class: 'playhead', attrs: { 'aria-hidden': 'true' } });
  let tracks: HTMLElement[] = [];
  let barLabels: HTMLElement[] = [];
  let layout = gridLayout(store.state.song);
  let last: unknown[] = [];
  let lastLoop: unknown[] = [];
  /** The bar a drag over the bar numbers started on. */
  let dragBar: number | null = null;

  const onBarLabelEnter = (bar: number): void => {
    if (dragBar === null) return;
    actions.setLoopRange(spanBars(layout.barBeats, dragBar, bar));
  };

  /** Touch pointers are captured by the label they start on: find the bar under the pointer. */
  const onLoopDragMove = (event: PointerEvent): void => {
    const doc = root.ownerDocument;
    if (typeof doc.elementFromPoint !== 'function') return;
    const label = doc.elementFromPoint(event.clientX, event.clientY)?.closest('.bar-label');
    if (label instanceof HTMLElement) onBarLabelEnter(Number(label.dataset['bar']));
  };

  const endLoopDrag = (): void => {
    dragBar = null;
    window.removeEventListener('pointermove', onLoopDragMove);
    window.removeEventListener('pointerup', endLoopDrag);
    window.removeEventListener('pointercancel', endLoopDrag);
  };

  const onBarLabelDown = (event: PointerEvent, bar: number): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const { loopRange } = store.state;
    if (event.shiftKey) {
      actions.setLoopRange(extendRange(loopRange, layout.barBeats, bar));
      return;
    }
    dragBar = bar;
    actions.setLoopRange(barRange(layout.barBeats, bar));
    window.addEventListener('pointermove', onLoopDragMove);
    window.addEventListener('pointerup', endLoopDrag);
    window.addEventListener('pointercancel', endLoopDrag);
  };

  const startResize = (event: PointerEvent, index: number): void => {
    event.preventDefault();
    event.stopPropagation();
    const base = store.state.song;
    const start = chordStarts(base)[index] ?? 0;
    const move = (e: PointerEvent): void => {
      const track =
        tracks.find((t) => e.clientY < t.getBoundingClientRect().bottom) ?? tracks.at(-1);
      if (track === undefined) return;
      const rect = track.getBoundingClientRect();
      const row = tracks.indexOf(track);
      const snap = e.shiftKey ? MIN_BEATS : 1;
      const beat = xToBeat(row, e.clientX - rect.left, rect.width, layout, {
        snap,
        rounding: 'round',
        clamp: false,
      });
      const song = setChordBeats(base, index, Math.max(snap, beat - start));
      if (song !== store.state.song) store.preview(song);
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (store.state.song !== base) store.commit(store.state.song, {}, { base });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const onTrackClick = (event: MouseEvent, row: number, track: HTMLElement): void => {
    const target = event.target instanceof Element ? event.target.closest('.chord') : null;
    if (target instanceof HTMLElement) {
      const index = Number(target.dataset['index']);
      actions.select(index);
      const chord = store.state.song.chords[index];
      if (chord !== undefined && !store.state.playing) actions.audition(chord.token);
      return;
    }
    // The "+" slot, or empty space after the last chord: select the "+" slot (the next pick adds).
    if (event.target instanceof Element && event.target.closest('.plus-slot') !== null) {
      actions.select(null);
      return;
    }
    const rect = track.getBoundingClientRect();
    const beat = xToBeat(row, event.clientX - rect.left, rect.width, layout);
    if (beat >= totalBeats(store.state.song)) actions.select(null);
  };

  const renderBlocks = (state: AppState, playingIndex: number | null): void => {
    const { song, selected } = state;
    layout = gridLayout(song);
    const key = songKey(song);
    tracks = [];
    barLabels = [];
    const rows: HTMLElement[] = [];
    for (let row = 0; row < layout.rows; row++) {
      const labels = h('div', { class: 'bar-labels' });
      const track = h('div', { class: 'track' });
      for (let b = 0; b < layout.barsPerRow; b++) {
        const bar = row * layout.barsPerRow + b;
        const label = h(
          'span',
          {
            class: 'bar-label',
            attrs: {
              'data-bar': String(bar),
              title: 'Click or drag: loop these bars · Shift+click: extend the loop',
            },
          },
          String(bar + 1),
        );
        label.addEventListener('pointerdown', (e) => onBarLabelDown(e, bar));
        label.addEventListener('pointerenter', () => onBarLabelEnter(bar));
        barLabels.push(label);
        labels.append(label);
        const cell = h('div', { class: 'bar' });
        for (let t = 0; t < layout.ticksPerBar; t++) cell.append(h('span', { class: 'tick' }));
        track.append(cell);
      }
      track.onclick = (e) => onTrackClick(e, row, track);
      tracks.push(track);
      rows.push(h('div', { class: 'grid-row' }, labels, track));
    }

    for (const seg of chordSegments(song, layout)) {
      const track = tracks[seg.row];
      if (track === undefined) continue;
      const rest = isRestToken(seg.token);
      const degree = colorDegree(seg.token);
      const classes = ['chord'];
      if (rest) classes.push('rest');
      if (seg.index === selected) classes.push('selected');
      if (seg.index === playingIndex) classes.push('playing');
      if (!seg.first) classes.push('cont');
      if (!seg.last) classes.push('wraps');
      const block = h(
        'div',
        {
          class: classes.join(' '),
          style: {
            left: pct(seg.left),
            width: pct(seg.width),
            ...(degree === null ? {} : { '--hue': String(degreeHue(degree)) }),
          },
          attrs: {
            'data-index': String(seg.index),
            role: 'button',
            'aria-pressed': String(seg.index === selected),
            title: `${seg.token} · ${song.chords[seg.index]?.beats ?? 0} beats`,
          },
        },
        h('span', { class: 'token' }, rest ? 'rest' : seg.token),
        h('span', { class: 'name' }, rest ? '' : tokenName(seg.token, key)),
      );
      if (seg.index === selected && seg.last) {
        const handle = h('span', {
          class: 'handle',
          attrs: { title: 'Drag to resize (Shift: quarter beats)' },
        });
        const index = seg.index;
        handle.onpointerdown = (e) => startResize(e, index);
        handle.onclick = (e) => e.stopPropagation();
        block.append(handle);
      }
      track.append(block);
    }

    const plus = plusSlot(song, layout);
    const plusSelected = selected === null;
    tracks[plus.row]?.append(
      h(
        'div',
        {
          class: plusSelected ? 'plus-slot selected' : 'plus-slot',
          style: { left: pct(plus.left), width: pct(plus.width) },
          attrs: {
            role: 'button',
            'aria-pressed': String(plusSelected),
            'aria-label': 'Add a chord at the end',
            title: 'Select, then pick a suggestion or press 1–7 to add a chord',
          },
        },
        '+',
      ),
    );

    if (song.chords.length === 0) {
      tracks[0]?.append(
        h(
          'div',
          { class: 'empty-hint', style: { left: pct(plus.width) } },
          'Press 1–7 or pick a suggested chord to start.',
        ),
      );
    }
    replaceChildren(root, ...rows);
  };

  const renderLoop = (state: AppState): void => {
    for (const track of tracks) track.querySelector('.loop-region')?.remove();
    const range = state.loopRange;
    for (const label of barLabels) {
      const bar = Number(label.dataset['bar']);
      const inside =
        range !== null &&
        bar * layout.barBeats < range.end - 1e-9 &&
        (bar + 1) * layout.barBeats > range.start + 1e-9;
      label.classList.toggle('in-loop', inside);
      label.classList.toggle('off', inside && !state.loop);
    }
    if (range === null) return;
    for (const seg of loopSegments(range, layout)) {
      const track = tracks[seg.row];
      if (track === undefined) continue;
      track.prepend(
        h('div', {
          class: state.loop ? 'loop-region' : 'loop-region off',
          style: { left: pct(seg.left), width: pct(seg.width) },
          attrs: { 'aria-hidden': 'true' },
        }),
      );
    }
  };

  const renderPlayhead = (state: AppState): void => {
    if (!state.playing) {
      playhead.remove();
      return;
    }
    const { row, fraction } = beatToRowPosition(state.cursor, layout);
    const track = tracks[Math.min(row, tracks.length - 1)];
    if (track === undefined) return;
    placePlayhead(playhead, track, row >= tracks.length ? 1 : fraction);
  };

  const render = (state: AppState): void => {
    const playingIndex = state.playing
      ? (chordAtBeat(state.song, state.cursor)?.index ?? null)
      : null;
    const inputs = [state.song, state.selected, playingIndex];
    let rebuilt = false;
    if (!inputs.every((value, i) => value === last[i])) {
      last = inputs;
      renderBlocks(state, playingIndex);
      rebuilt = true;
    }
    const loopInputs = [state.loopRange, state.loop];
    if (rebuilt || !loopInputs.every((value, i) => value === lastLoop[i])) {
      lastLoop = loopInputs;
      renderLoop(state);
    }
    renderPlayhead(state);
  };

  render(store.state);
  store.subscribe(render);
}
