/**
 * Melody lane under the chord grid (docs/specs/melody-v1.md, B2): the grid's rows as small
 * piano rolls of scale-degree rows, notes coloured by how they sit on the chord under them.
 */
import type { MelodyNote, Song } from '@crokychords/core';
import { melodyNoteHarmony } from '@crokychords/core';
import type { MelodyHarmony } from '@crokychords/core';
import type { Actions } from '../actions';
import { h, option, replaceChildren } from '../dom';
import {
  MELODY_GRIDS,
  MELODY_GRID_LABELS,
  PITCH_ROWS,
  PITCH_ROW_MAX,
  PITCH_ROW_MIN,
  degreeLabel,
  melodyEnd,
  pitchRow,
  placeNote,
  removeNote,
  rowPitch,
  songMelody,
} from '../melody';
import type { AppState, Store } from '../state';
import type { GridLayout } from './grid';
import { beatToRowPosition, gridLayout, xToBeat } from './grid';

export const HARMONY_CLASSES: Record<MelodyHarmony, string> = {
  chord: 'chord-tone',
  scale: 'scale-tone',
  outside: 'outside',
};

/** The chord grid's layout, with extra rows when the melody runs past it. */
export function melodyLayout(song: Song): GridLayout {
  const layout = gridLayout(song);
  const rows = Math.max(layout.rows, Math.ceil(melodyEnd(song) / layout.rowBeats - 1e-9));
  return { ...layout, rows };
}

/** Length of the lane in beats (the cursor stays inside it). */
export function melodyLaneBeats(song: Song): number {
  const layout = melodyLayout(song);
  return layout.rows * layout.rowBeats;
}

export interface NoteSegment {
  index: number;
  note: MelodyNote;
  row: number;
  /** Left edge and width as fractions of the row. */
  left: number;
  width: number;
  first: boolean;
  last: boolean;
  /** Pitch row inside the lane, 0 = bottom (clamped). */
  lane: number;
  /** The note lies above or below the rows the lane shows. */
  clamped: 'up' | 'down' | null;
  harmony: MelodyHarmony;
}

/** Note blocks per row; a note crossing a row boundary is split. */
export function noteSegments(song: Song, layout: GridLayout): NoteSegment[] {
  const segments: NoteSegment[] = [];
  songMelody(song).notes.forEach((note, index) => {
    const pitch = pitchRow(note);
    const clamped = pitch > PITCH_ROW_MAX ? 'up' : pitch < PITCH_ROW_MIN ? 'down' : null;
    const lane = Math.min(PITCH_ROW_MAX, Math.max(PITCH_ROW_MIN, pitch)) - PITCH_ROW_MIN;
    const harmony = melodyNoteHarmony(song, note);
    const end = note.beat + note.length;
    let from = note.beat;
    while (from < end - 1e-9) {
      const { row } = beatToRowPosition(from, layout);
      const to = Math.min(end, (row + 1) * layout.rowBeats);
      segments.push({
        index,
        note,
        row,
        left: (from - row * layout.rowBeats) / layout.rowBeats,
        width: (to - from) / layout.rowBeats,
        first: from === note.beat,
        last: to === end,
        lane,
        clamped,
        harmony,
      });
      from = to;
    }
  });
  return segments;
}

/** Pitch (degree, octave) of the lane row under `y` px from the top of a `height` px track. */
export function yToPitch(
  y: number,
  height: number,
): { degree: MelodyNote['degree']; octave: number } {
  const fromBottom = height > 0 ? (height - y) / height : 0;
  const lane = Math.min(PITCH_ROWS - 1, Math.max(0, Math.floor(fromBottom * PITCH_ROWS)));
  return rowPitch(lane + PITCH_ROW_MIN);
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(4)}%`;
}

export function mountMelody(root: HTMLElement, store: Store, actions: Actions): void {
  root.classList.add('panel', 'melody');
  root.setAttribute('aria-label', 'Melody lane');

  const gridButtons = MELODY_GRIDS.map((grid) => {
    const button = h(
      'button',
      { class: 'seg', props: { type: 'button' }, attrs: { 'data-grid': String(grid) } },
      MELODY_GRID_LABELS[grid],
    );
    button.onclick = () => actions.setMelodyGrid(grid);
    return button;
  });
  const mute = h('input', { props: { type: 'checkbox' }, attrs: { 'data-field': 'melody-mute' } });
  mute.onchange = () => actions.toggleMelodyMute();
  const channel = h(
    'select',
    { attrs: { 'aria-label': 'Melody MIDI channel', 'data-field': 'melody-channel' } },
    ...Array.from({ length: 16 }, (_, ch) => option(String(ch), String(ch + 1))),
  );
  channel.onchange = () => actions.setMelodyChannel(Number(channel.value));
  const status = h('span', { class: 'hint melody-status' });
  const head = h(
    'div',
    { class: 'panel-head' },
    h('h2', {}, 'Melody'),
    h(
      'div',
      { class: 'melody-controls' },
      h(
        'div',
        { class: 'segmented', attrs: { role: 'group', 'aria-label': 'Grid' } },
        ...gridButtons,
      ),
      h('label', { class: 'check' }, mute, 'Mute'),
      h('label', {}, 'Ch ', channel),
    ),
  );
  const body = h('div', { class: 'melody-rows' });
  const playhead = h('div', { class: 'playhead', attrs: { 'aria-hidden': 'true' } });
  root.append(head, body, status);

  let layout = melodyLayout(store.state.song);
  let tracks: HTMLElement[] = [];
  let last: unknown[] = [];

  /** Beat and pitch under a pointer, snapped to the grid ('floor': the cell; 'round': a line). */
  const locate = (
    e: MouseEvent,
    rounding: 'floor' | 'round',
  ): { beat: number; degree: MelodyNote['degree']; octave: number; row: number } | null => {
    const track = tracks.find((t) => e.clientY < t.getBoundingClientRect().bottom) ?? tracks.at(-1);
    if (track === undefined) return null;
    const rect = track.getBoundingClientRect();
    const row = tracks.indexOf(track);
    const beat = xToBeat(row, e.clientX - rect.left, rect.width, layout, {
      snap: store.state.melodyGrid,
      rounding,
      clamp: rounding === 'floor',
    });
    return { beat, row, ...yToPitch(e.clientY - rect.top, rect.height) };
  };

  /** Run a pointer drag: `move` previews, the song is committed (one undo step) on release. */
  const drag = (onMove: (e: MouseEvent) => void, onClick: () => void, base: Song): void => {
    let moved = false;
    const move = (e: MouseEvent): void => {
      moved = true;
      onMove(e);
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (store.state.song !== base) store.commit(store.state.song, {}, { base });
      if (!moved || store.state.song === base) onClick();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const hearIndex = (index: number): void => {
    const note = songMelody(store.state.song).notes[index];
    if (note !== undefined && !store.state.playing) actions.auditionNote(note);
  };

  /** Empty space: a new note at the cell, dragged right for its length. */
  const startCreate = (e: MouseEvent): void => {
    const at = locate(e, 'floor');
    if (at === null) return;
    e.preventDefault();
    actions.setFocus('melody');
    const base = store.state.song;
    const grid = store.state.melodyGrid;
    const note: MelodyNote = {
      beat: at.beat,
      length: store.state.melodyLength,
      degree: at.degree,
      octave: at.octave,
      accidental: 0,
    };
    let placed = placeNote(base, note);
    store.preview(placed.song, { melodyCursor: note.beat });
    drag(
      (ev) => {
        const to = locate(ev, 'round');
        if (to === null) return;
        placed = placeNote(base, { ...note, length: Math.max(grid, to.beat - note.beat) });
        store.preview(placed.song);
      },
      () => undefined,
      base,
    );
    hearIndex(placed.index);
  };

  /** A note: drag to move it in time and pitch; a click without moving selects it. */
  const startMove = (e: MouseEvent, index: number): void => {
    const from = locate(e, 'round');
    const note = songMelody(store.state.song).notes[index];
    if (from === null || note === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    actions.setFocus('melody');
    const base = store.state.song;
    const startPitch = pitchRow(note);
    const startLane = pitchRow(yToPitchAt(e));
    let lastKey = '';
    drag(
      (ev) => {
        const to = locate(ev, 'round');
        if (to === null) return;
        const beat = Math.max(0, note.beat + to.beat - from.beat);
        const pitch = rowPitch(startPitch + pitchRow(yToPitchAt(ev)) - startLane);
        const key = `${beat}:${pitch.degree}:${pitch.octave}`;
        if (key === lastKey) return;
        lastKey = key;
        const moved = placeNote(removeNote(base, index), { ...note, beat, ...pitch });
        store.preview(moved.song, { melodyCursor: beat });
        hearIndex(moved.index);
      },
      () => {
        actions.setMelodyCursor(note.beat);
        hearIndex(index);
      },
      base,
    );
  };

  /** The right edge of a note: drag for its length. */
  const startResize = (e: MouseEvent, index: number): void => {
    const note = songMelody(store.state.song).notes[index];
    if (note === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    const base = store.state.song;
    const grid = store.state.melodyGrid;
    drag(
      (ev) => {
        const to = locate(ev, 'round');
        if (to === null) return;
        const length = Math.max(grid, to.beat - note.beat);
        store.preview(placeNote(removeNote(base, index), { ...note, length }).song);
      },
      () => undefined,
      base,
    );
  };

  /** Pitch under the pointer within the track it is over. */
  const yToPitchAt = (e: MouseEvent): { degree: MelodyNote['degree']; octave: number } => {
    const track = tracks.find((t) => e.clientY < t.getBoundingClientRect().bottom) ?? tracks.at(-1);
    const rect = track?.getBoundingClientRect();
    return rect === undefined ? rowPitch(0) : yToPitch(e.clientY - rect.top, rect.height);
  };

  const renderLane = (state: AppState): void => {
    const { song } = state;
    layout = melodyLayout(song);
    tracks = [];
    const rows: HTMLElement[] = [];
    for (let row = 0; row < layout.rows; row++) {
      const track = h('div', { class: 'melody-track', attrs: { 'data-row': String(row) } });
      for (let lane = 0; lane < PITCH_ROWS; lane++) {
        const pitch = lane + PITCH_ROW_MIN;
        const tonic = ((pitch % 7) + 7) % 7 === 0;
        track.append(
          h('div', {
            class: tonic ? 'melody-pitch tonic' : 'melody-pitch',
            style: { bottom: pct(lane / PITCH_ROWS), height: pct(1 / PITCH_ROWS) },
          }),
        );
      }
      for (let b = 0; b < layout.barsPerRow; b++) {
        const bar = h('div', { class: 'bar' });
        for (let t = 0; t < layout.ticksPerBar; t++) bar.append(h('span', { class: 'tick' }));
        track.append(bar);
      }
      track.addEventListener('pointerdown', (e) => startCreate(e));
      tracks.push(track);
      rows.push(track);
    }

    const cursorIndex =
      state.focus === 'melody'
        ? songMelody(song).notes.findIndex(
            (n) => n.beat <= state.melodyCursor && state.melodyCursor < n.beat + n.length,
          )
        : -1;
    for (const seg of noteSegments(song, layout)) {
      const track = tracks[seg.row];
      if (track === undefined) continue;
      const classes = ['mnote', HARMONY_CLASSES[seg.harmony]];
      if (seg.index === cursorIndex) classes.push('selected');
      if (!seg.first) classes.push('cont');
      if (!seg.last) classes.push('wraps');
      if (seg.clamped !== null) classes.push(`clamped-${seg.clamped}`);
      const label = degreeLabel(seg.note);
      const block = h(
        'div',
        {
          class: classes.join(' '),
          style: {
            left: pct(seg.left),
            width: pct(seg.width),
            bottom: pct(seg.lane / PITCH_ROWS),
            height: pct(1 / PITCH_ROWS),
          },
          attrs: {
            'data-index': String(seg.index),
            title: `${label} · octave ${seg.note.octave} · ${seg.note.length} beats`,
          },
        },
        seg.first ? label : '',
      );
      const index = seg.index;
      block.addEventListener('pointerdown', (e) => startMove(e, index));
      block.ondblclick = (e) => {
        e.stopPropagation();
        store.commit(removeNote(store.state.song, index));
      };
      if (seg.last) {
        const handle = h('span', {
          class: 'handle',
          attrs: { title: 'Drag to change the length' },
        });
        handle.addEventListener('pointerdown', (e) => startResize(e, index));
        block.append(handle);
      }
      track.append(block);
    }

    if (state.focus === 'melody') {
      const { row, fraction } = beatToRowPosition(state.melodyCursor, layout);
      tracks[row]?.append(
        h('div', {
          class: 'melody-cursor',
          style: { left: pct(fraction), width: pct(state.melodyGrid / layout.rowBeats) },
          attrs: { 'aria-hidden': 'true' },
        }),
      );
    }
    replaceChildren(body, ...rows);
  };

  const renderHead = (state: AppState): void => {
    const melody = songMelody(state.song);
    root.classList.toggle('focused', state.focus === 'melody');
    root.classList.toggle('muted', melody.muted);
    for (const button of gridButtons) {
      const active = Number(button.dataset['grid']) === state.melodyGrid;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    mute.checked = melody.muted;
    channel.value = String(melody.channel);
    status.textContent =
      state.focus === 'melody'
        ? `Editing melody · new notes: octave ${state.melodyOctave}, ${state.melodyLength} beats · N or Esc: back to chords`
        : 'N: edit the melody with the keyboard · click to add a note · double-click to delete';
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
    const inputs = [state.song, state.focus, state.melodyCursor, state.melodyGrid];
    if (!inputs.every((value, i) => value === last[i])) {
      last = inputs;
      renderLane(state);
    }
    renderHead(state);
    renderPlayhead(state);
  };

  render(store.state);
  store.subscribe(render);
}
