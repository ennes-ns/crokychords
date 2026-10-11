/** Chord grid: rows of bars, chord blocks spanning their beats, selection, add/remove/resize. */
import type { Song } from '@crokychords/core';
import { chordAtBeat, isRestToken, songKey, totalBeats } from '@crokychords/core';
import type { Actions } from '../actions';
import { h, replaceChildren } from '../dom';
import { MIN_BEATS, barLength, chordStarts, setChordBeats } from '../edit';
import { colorDegree, degreeHue, tokenName } from '../music';
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

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(4)}%`;
}

export function mountGrid(root: HTMLElement, store: Store, actions: Actions): void {
  root.classList.add('grid');
  root.setAttribute('aria-label', 'Chord grid');
  const playhead = h('div', { class: 'playhead', attrs: { 'aria-hidden': 'true' } });
  let tracks: HTMLElement[] = [];
  let layout = gridLayout(store.state.song);
  let last: unknown[] = [];

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
    const rect = track.getBoundingClientRect();
    const beat = xToBeat(row, event.clientX - rect.left, rect.width, layout);
    if (beat >= totalBeats(store.state.song)) actions.appendDefault();
  };

  const renderBlocks = (state: AppState, playingIndex: number | null): void => {
    const { song, selected } = state;
    layout = gridLayout(song);
    const key = songKey(song);
    tracks = [];
    const rows: HTMLElement[] = [];
    for (let row = 0; row < layout.rows; row++) {
      const labels = h('div', { class: 'bar-labels' });
      const track = h('div', { class: 'track' });
      for (let b = 0; b < layout.barsPerRow; b++) {
        labels.append(h('span', {}, String(row * layout.barsPerRow + b + 1)));
        const bar = h('div', { class: 'bar' });
        for (let t = 0; t < layout.ticksPerBar; t++) bar.append(h('span', { class: 'tick' }));
        track.append(bar);
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

    if (song.chords.length === 0) {
      tracks[0]?.append(
        h('div', { class: 'empty-hint' }, 'Click here, press 1–7, or pick a Magic Chord to start.'),
      );
    }
    replaceChildren(root, ...rows);
  };

  const renderPlayhead = (state: AppState): void => {
    if (!state.playing) {
      playhead.remove();
      return;
    }
    const { row, fraction } = beatToRowPosition(state.cursor, layout);
    const track = tracks[Math.min(row, tracks.length - 1)];
    if (track === undefined) return;
    if (playhead.parentElement !== track) track.append(playhead);
    playhead.style.left = pct(row >= tracks.length ? 1 : fraction);
  };

  const render = (state: AppState): void => {
    const playingIndex = state.playing
      ? (chordAtBeat(state.song, state.cursor)?.index ?? null)
      : null;
    const inputs = [state.song, state.selected, playingIndex];
    if (!inputs.every((value, i) => value === last[i])) {
      last = inputs;
      renderBlocks(state, playingIndex);
    }
    renderPlayhead(state);
  };

  render(store.state);
  store.subscribe(render);
}
