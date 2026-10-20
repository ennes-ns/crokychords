/**
 * Melody strip of every timeline row (docs/specs/melody-v1.md, B2; `timeline.ts`): directly under
 * the row's chords, a small piano roll of scale-degree rows (15, or 7 when folded), plus the
 * timeline bar with the melody controls. Notes carry their degree's hue (the chord blocks'
 * colours); rows holding a tone of the chord above them are tinted (B4).
 */
import type { Degree, MelodyNote, Song } from '@crokychords/core';
import { chordTones, melodyNoteHarmony, songKey, tryParseToken } from '@crokychords/core';
import type { MelodyHarmony } from '@crokychords/core';
import type { Actions } from '../actions';
import { h, option } from '../dom';
import { degreeHue } from '../music';
import type { SongStorage } from '../persist';
import { loadMelodyFolded, loadMelodyTones, saveMelodyFolded, saveMelodyTones } from '../persist';
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
import { beatToRowPosition, chordSegments, gridLayout, xToBeat } from './grid';
import type { CompactMedia } from './shell';
import type { RowHost } from './timeline';

/** How a note's tooltip names its relation to the chord under it. */
export const HARMONY_LABELS: Record<MelodyHarmony, string> = {
  chord: 'chord tone',
  scale: 'passing tone',
  outside: 'outside the key',
};

/** Class for a note's accidental: one step lighter (sharp) or darker (flat) than its hue. */
export const ACCIDENTAL_CLASSES: Record<MelodyNote['accidental'], string | null> = {
  [-1]: 'flat',
  0: null,
  1: 'sharp',
};

/** Rows of a folded strip: one per degree, every octave on its degree's row. */
export const FOLDED_ROWS = 7;

/** How many pitch rows a strip has: 15, or 7 when folded. */
export function stripRows(folded: boolean): number {
  return folded ? FOLDED_ROWS : PITCH_ROWS;
}

/** The degree strip row `lane` (0 = bottom) stands for. */
export function laneDegree(lane: number, folded: boolean): Degree {
  return folded ? ((lane + 1) as Degree) : rowPitch(lane + PITCH_ROW_MIN).degree;
}

/** Strip row of a note (0 = bottom) and whether it lies outside the rows (octaves) shown. */
export function noteLane(
  note: MelodyNote,
  folded: boolean,
): { lane: number; clamped: 'up' | 'down' | null } {
  if (folded) {
    const clamped = note.octave > 0 ? 'up' : note.octave < 0 ? 'down' : null;
    return { lane: note.degree - 1, clamped };
  }
  const pitch = pitchRow(note);
  const clamped = pitch > PITCH_ROW_MAX ? 'up' : pitch < PITCH_ROW_MIN ? 'down' : null;
  return { lane: Math.min(PITCH_ROW_MAX, Math.max(PITCH_ROW_MIN, pitch)) - PITCH_ROW_MIN, clamped };
}

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
  /** Pitch row inside the strip, 0 = bottom (clamped; the degree's row when folded). */
  lane: number;
  /** The note lies above or below the rows (folded: the home octave) the strip shows. */
  clamped: 'up' | 'down' | null;
  harmony: MelodyHarmony;
  /** Hue of the note's degree, the same as a chord on that degree (`DEGREE_HUES`). */
  hue: number;
}

/** Note blocks per row; a note crossing a row boundary is split. */
export function noteSegments(song: Song, layout: GridLayout, folded = false): NoteSegment[] {
  const segments: NoteSegment[] = [];
  songMelody(song).notes.forEach((note, index) => {
    const { lane, clamped } = noteLane(note, folded);
    const harmony = melodyNoteHarmony(song, note);
    const hue = degreeHue(note.degree);
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
        hue,
      });
      from = to;
    }
  });
  return segments;
}

/** A tinted lane row under one chord: a tone of that chord sits on this row's degree. */
export interface ToneSpan {
  row: number;
  /** Left edge and width as fractions of the row (the chord's span in that row). */
  left: number;
  width: number;
  /** Pitch row inside the lane, 0 = bottom. */
  lane: number;
  /** The chord's root is on this degree (drawn slightly stronger). */
  root: boolean;
}

/**
 * Chord-tone tint of the strip: for every chord segment, the strip rows whose degree carries one
 * of the chord's core tones (`chordTones`: root, third or sus, fifth, seventh; natural or
 * altered), in every octave the strip shows (folded: the degree's one row). Rests and
 * unparseable tokens tint nothing.
 */
export function chordToneSpans(song: Song, layout: GridLayout, folded = false): ToneSpan[] {
  const key = songKey(song);
  const spans: ToneSpan[] = [];
  const tonesByToken = new Map<string, ReturnType<typeof chordTones>>();
  for (const seg of chordSegments(song, layout)) {
    let tones = tonesByToken.get(seg.token);
    if (tones === undefined) {
      const chord = tryParseToken(seg.token);
      tones = chord === undefined ? [] : chordTones(chord, key);
      tonesByToken.set(seg.token, tones);
    }
    if (tones.length === 0) continue;
    for (let lane = 0; lane < stripRows(folded); lane++) {
      const degree = laneDegree(lane, folded);
      const onRow = tones.filter((t) => t.degree === degree);
      if (onRow.length === 0) continue;
      const root = onRow.some((t) => t.role === 'root');
      spans.push({ row: seg.row, left: seg.left, width: seg.width, lane, root });
    }
  }
  return spans;
}

/**
 * Pitch (degree, octave) of the strip row under `y` px from the top of a `height` px strip. A
 * folded strip's rows are degrees; they take `octave` (the octave for new notes).
 */
export function yToPitch(
  y: number,
  height: number,
  folded = false,
  octave = 0,
): { degree: MelodyNote['degree']; octave: number } {
  const rows = stripRows(folded);
  const fromBottom = height > 0 ? (height - y) / height : 0;
  const lane = Math.min(rows - 1, Math.max(0, Math.floor(fromBottom * rows)));
  return folded ? { degree: laneDegree(lane, true), octave } : rowPitch(lane + PITCH_ROW_MIN);
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(4)}%`;
}

export interface MelodyLane {
  /** Show or hide the chord-tone tint (`H`); the choice is kept in local settings. */
  toggleChordTones(): void;
}

/**
 * Mount the melody strips into the timeline rows of `host` and the melody controls into `bar`
 * (the timeline bar above the rows). `compact` folds the strip while it matches.
 */
export function mountMelody(
  bar: HTMLElement,
  host: RowHost,
  store: Store,
  actions: Actions,
  storage: SongStorage | null = null,
  compact: CompactMedia | null = null,
): MelodyLane {
  const root = host.root;
  bar.classList.add('timeline-bar');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Melody');

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
  const tones = h('input', {
    props: { type: 'checkbox' },
    attrs: { 'data-field': 'melody-tones' },
  });
  /** A class switch only: the tint stays in the DOM, so toggling it costs no re-render. */
  const showTones = (on: boolean): void => {
    tones.checked = on;
    root.classList.toggle('hide-tones', !on);
  };
  showTones(loadMelodyTones(storage));
  const setTones = (on: boolean): void => {
    showTones(on);
    saveMelodyTones(storage, on);
  };
  tones.onchange = () => setTones(tones.checked);

  // The 7-row strip: a per-device choice, always on in compact density.
  const fold = h('input', {
    props: { type: 'checkbox' },
    attrs: { 'data-field': 'melody-folded' },
  });
  const foldLabel = h('label', { class: 'check' }, fold, '7 rows');
  let userFolded = loadMelodyFolded(storage);
  const isCompact = (): boolean => compact?.matches === true;
  const folded = (): boolean => userFolded || isCompact();
  const showFold = (): void => {
    fold.checked = folded();
    fold.disabled = isCompact();
    foldLabel.title = isCompact()
      ? 'Short screens always fold the melody strip to one row per degree'
      : 'Fold the melody strip to one row per degree, every octave on its row';
  };
  showFold();

  const status = h('span', { class: 'hint melody-status' });
  bar.append(
    h('h2', {}, 'Melody'),
    h(
      'div',
      { class: 'melody-controls' },
      h(
        'div',
        { class: 'segmented', attrs: { role: 'group', 'aria-label': 'Grid' } },
        ...gridButtons,
      ),
      h(
        'label',
        { class: 'check', attrs: { title: 'Tint the rows of the chord tones (H)' } },
        tones,
        'Chord tones',
      ),
      foldLabel,
      h('label', { class: 'check' }, mute, 'Mute'),
      h('label', {}, 'Ch ', channel),
    ),
    status,
  );

  let layout = host.plan(store.state).layout;
  let tracks: HTMLElement[] = [];
  let last: unknown[] = [];
  let lastHead: unknown[] = [];
  /** Tint spans, recomputed only when the chords, the key, the row length or the fold change. */
  let toneSpans: ToneSpan[] = [];
  let toneInputs: unknown[] = [];
  const spansFor = (song: Song, isFolded: boolean): ToneSpan[] => {
    const inputs = [song.chords, song.key.tonic, song.key.mode, layout.rowBeats, isFolded];
    if (!inputs.every((value, i) => value === toneInputs[i])) {
      toneInputs = inputs;
      toneSpans = chordToneSpans(song, layout, isFolded);
    }
    return toneSpans;
  };

  /** The strip under (or nearest above) the pointer. */
  const trackAt = (e: MouseEvent): HTMLElement | undefined =>
    tracks.find((t) => e.clientY < t.getBoundingClientRect().bottom) ?? tracks.at(-1);

  /** Pitch under the pointer within the strip it is over. */
  const yToPitchAt = (e: MouseEvent): { degree: MelodyNote['degree']; octave: number } => {
    const rect = trackAt(e)?.getBoundingClientRect();
    return rect === undefined
      ? rowPitch(0)
      : yToPitch(e.clientY - rect.top, rect.height, folded(), store.state.melodyOctave);
  };

  /** Beat and pitch under a pointer, snapped to the grid ('floor': the cell; 'round': a line). */
  const locate = (
    e: MouseEvent,
    rounding: 'floor' | 'round',
  ): { beat: number; degree: MelodyNote['degree']; octave: number; row: number } | null => {
    const track = trackAt(e);
    if (track === undefined) return null;
    const rect = track.getBoundingClientRect();
    const row = Number(track.dataset['row']);
    const beat = xToBeat(row, e.clientX - rect.left, rect.width, layout, {
      snap: store.state.melodyGrid,
      rounding,
      clamp: rounding === 'floor',
    });
    return { beat, row, ...yToPitchAt(e) };
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
    // Strip rows are scale steps in both views, so the row offset is the pitch offset.
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

  const renderStrips = (state: AppState, isFolded: boolean): void => {
    const { song } = state;
    const plan = host.plan(state);
    layout = plan.layout;
    const lanes = stripRows(isFolded);
    const lanePct = (lane: number): string => pct(lane / lanes);
    const laneHeight = pct(1 / lanes);
    tracks = [];
    const byRow: (HTMLElement | null)[] = plan.strips.map((hasStrip, row) => {
      if (!hasStrip) return null;
      const track = h('div', {
        class: isFolded ? 'melody-track folded' : 'melody-track',
        attrs: { 'data-row': String(row) },
      });
      for (let lane = 0; lane < lanes; lane++) {
        const tonic = laneDegree(lane, isFolded) === 1;
        track.append(
          h('div', {
            class: tonic ? 'melody-pitch tonic' : 'melody-pitch',
            style: { bottom: lanePct(lane), height: laneHeight },
          }),
        );
      }
      tracks.push(track);
      return track;
    });
    for (const span of spansFor(song, isFolded)) {
      byRow[span.row]?.append(
        h('div', {
          class: span.root ? 'melody-tone root' : 'melody-tone',
          style: {
            left: pct(span.left),
            width: pct(span.width),
            bottom: lanePct(span.lane),
            height: laneHeight,
          },
        }),
      );
    }
    for (const track of tracks) {
      for (let b = 0; b < layout.barsPerRow; b++) {
        const cell = h('div', { class: 'bar' });
        for (let t = 0; t < layout.ticksPerBar; t++) cell.append(h('span', { class: 'tick' }));
        track.append(cell);
      }
      track.addEventListener('pointerdown', (e) => startCreate(e));
    }

    const cursorIndex =
      state.focus === 'melody'
        ? songMelody(song).notes.findIndex(
            (n) => n.beat <= state.melodyCursor && state.melodyCursor < n.beat + n.length,
          )
        : -1;
    for (const seg of noteSegments(song, layout, isFolded)) {
      const track = byRow[seg.row];
      if (track === undefined || track === null) continue;
      const classes = ['mnote'];
      const accidental = ACCIDENTAL_CLASSES[seg.note.accidental];
      if (accidental !== null) classes.push(accidental);
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
            bottom: lanePct(seg.lane),
            height: laneHeight,
            '--hue': String(seg.hue),
          },
          attrs: {
            'data-index': String(seg.index),
            'data-harmony': seg.harmony,
            title: `${label} · ${HARMONY_LABELS[seg.harmony]} · octave ${seg.note.octave} · ${seg.note.length} beats`,
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
      byRow[row]?.append(
        h('div', {
          class: 'melody-cursor',
          style: { left: pct(fraction), width: pct(state.melodyGrid / layout.rowBeats) },
          attrs: { 'aria-hidden': 'true' },
        }),
      );
    }
    host.setStrips(byRow);
  };

  const renderHead = (state: AppState): void => {
    const melody = songMelody(state.song);
    root.classList.toggle('melody-muted', melody.muted);
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
    status.title = status.textContent;
  };

  const render = (state: AppState): void => {
    const isFolded = folded();
    const inputs = [state.song, state.focus, state.melodyCursor, state.melodyGrid, isFolded];
    if (!inputs.every((value, i) => value === last[i])) {
      last = inputs;
      renderStrips(state, isFolded);
    }
    // The head only changes with these inputs; skipping it keeps playback frames free of
    // DOM writes that would force a layout (issue #61).
    const headInputs = [
      state.song,
      state.focus,
      state.melodyGrid,
      state.melodyOctave,
      state.melodyLength,
    ];
    if (!headInputs.every((value, i) => value === lastHead[i])) {
      lastHead = headInputs;
      renderHead(state);
    }
  };

  /** Re-render the strips outside a store update (the fold changed) and recompose the rows. */
  const refold = (): void => {
    showFold();
    render(store.state);
    host.refresh();
  };
  fold.onchange = () => {
    userFolded = fold.checked;
    saveMelodyFolded(storage, userFolded);
    refold();
  };
  compact?.addEventListener('change', refold);

  render(store.state);
  store.subscribe(render);
  return { toggleChordTones: () => setTones(!tones.checked) };
}
