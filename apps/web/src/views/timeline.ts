/**
 * The stage's one timeline (docs/specs/melody-v1.md §B2, issue #105): rows of chord blocks with
 * the melody strip of the same bars directly beneath, in one scroll container, with one x-scale,
 * one playhead and one focus mark. The chord grid (`grid.ts`) and the melody strip (`melody.ts`)
 * render their halves of every row; this file composes the rows and moves the playhead.
 */
import type { Song } from '@crokychords/core';
import { totalBeats } from '@crokychords/core';
import type { Actions } from '../actions';
import { h, replaceChildren } from '../dom';
import { melodyEnd } from '../melody';
import type { SongStorage } from '../persist';
import type { AppState, Store } from '../state';
import type { GridLayout } from './grid';
import { anchorPlayhead, beatToRowPosition, gridLayout, mountGrid, removePlayhead } from './grid';
import type { MelodyLane } from './melody';
import { mountMelody } from './melody';
import type { CompactMedia } from './shell';

/** Which rows the timeline has and which of them carry a melody strip. */
export interface TimelinePlan {
  layout: GridLayout;
  /** One entry per row: true when the row shows a melody strip under its chords. */
  strips: boolean[];
}

/**
 * The chord grid's rows (the song plus at least one empty bar), more when the melody runs past
 * them. A row gets a strip when it is the first row, when chords or notes reach into it, or when
 * the melody cursor (`cursor`, null while the chords have focus) is in it; the row after an
 * exactly full song only holds the "+" slot.
 */
export function timelinePlan(song: Song, cursor: number | null = null): TimelinePlan {
  const base = gridLayout(song);
  const melodyBeats = melodyEnd(song);
  const rows = Math.max(base.rows, Math.ceil(melodyBeats / base.rowBeats - 1e-9));
  const layout = { ...base, rows };
  const reach = Math.max(totalBeats(song), melodyBeats);
  const cursorRow = cursor === null ? -1 : beatToRowPosition(cursor, layout).row;
  const strips = Array.from(
    { length: rows },
    (_, row) => row === 0 || row * layout.rowBeats < reach - 1e-9 || row === cursorRow,
  );
  return { layout, strips };
}

/** The chord half of one row: its bar numbers and the track with the chord blocks. */
export interface ChordRow {
  labels: HTMLElement;
  track: HTMLElement;
}

/** What the chord grid and the melody strip render into. */
export interface RowHost {
  /** The scroll container holding the rows. */
  readonly root: HTMLElement;
  /** The plan for `state` (memoised on the song and the melody cursor). */
  plan(state: AppState): TimelinePlan;
  setChordRows(rows: readonly ChordRow[]): void;
  /** One entry per row; null for a row without a strip. */
  setStrips(strips: readonly (HTMLElement | null)[]): void;
  /** Recompose the rows after a half was re-rendered outside a store update. */
  refresh(): void;
}

export class Timeline implements RowHost {
  readonly root: HTMLElement;
  #chordRows: readonly ChordRow[] = [];
  #strips: readonly (HTMLElement | null)[] = [];
  #composed: unknown[] = [];
  #bodies: HTMLElement[] = [];
  #rows: HTMLElement[] = [];
  #planInputs: unknown[] = [];
  #plan: TimelinePlan | null = null;
  /** Set by `mountTimeline`: compose and re-anchor the playhead. */
  onRefresh: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  refresh(): void {
    if (this.onRefresh === null) this.compose();
    else this.onRefresh();
  }

  plan(state: AppState): TimelinePlan {
    const cursor = state.focus === 'melody' ? state.melodyCursor : null;
    const inputs = [state.song, cursor];
    if (this.#plan === null || !inputs.every((value, i) => value === this.#planInputs[i])) {
      this.#planInputs = inputs;
      this.#plan = timelinePlan(state.song, cursor);
    }
    return this.#plan;
  }

  setChordRows(rows: readonly ChordRow[]): void {
    this.#chordRows = rows;
  }

  setStrips(strips: readonly (HTMLElement | null)[]): void {
    this.#strips = strips;
  }

  /** The box of every row (chord area plus strip), where the playhead runs. */
  get bodies(): readonly HTMLElement[] {
    return this.#bodies;
  }

  /** The row elements (bar numbers plus box). */
  get rows(): readonly HTMLElement[] {
    return this.#rows;
  }

  /**
   * Put every row's chord half and strip into its box; only when either half was rebuilt. The row
   * elements and boxes are kept while the row count stays, so the playhead stays where it is (it
   * is kept in its box) and the cached track widths stay valid (issue #82).
   */
  compose(): void {
    const inputs = [this.#chordRows, this.#strips];
    if (inputs.every((value, i) => value === this.#composed[i])) return;
    this.#composed = inputs;
    const count = Math.max(this.#chordRows.length, this.#strips.length);
    if (count !== this.#rows.length) {
      const rows = this.#rows.slice(0, count);
      const bodies = this.#bodies.slice(0, count);
      for (let row = rows.length; row < count; row++) {
        const body = h('div', { class: 'row-body', attrs: { 'data-row': String(row) } });
        bodies.push(body);
        rows.push(h('div', { class: 'timeline-row' }, body));
      }
      this.#rows = rows;
      this.#bodies = bodies;
      replaceChildren(this.root, ...rows);
    }
    for (let row = 0; row < count; row++) {
      const el = this.#rows[row];
      const body = this.#bodies[row];
      if (el === undefined || body === undefined) continue;
      const chords = this.#chordRows[row];
      const strip = this.#strips[row] ?? null;
      el.classList.toggle('no-strip', strip === null);
      const kept = [...body.children].filter((c) => c.classList.contains('playhead'));
      const kids = [chords?.track, strip, ...kept].filter(
        (c): c is Element => c !== undefined && c !== null,
      );
      if (!sameChildren(body, kids)) body.replaceChildren(...kids);
      const head = chords === undefined ? [body] : [chords.labels, body];
      if (!sameChildren(el, head)) el.replaceChildren(...head);
    }
  }
}

function sameChildren(parent: Element, children: readonly Element[]): boolean {
  return (
    parent.children.length === children.length &&
    children.every((child, i) => parent.children[i] === child)
  );
}

export interface TimelineOptions {
  storage?: SongStorage | null;
  /** Compact density (`COMPACT_QUERY`): the strip folds to 7 rows while it matches. */
  compact?: CompactMedia | null;
}

/**
 * Mount the timeline into `root` (the scroll container) and its bar (`bar`, the melody controls
 * above the rows). Returns the melody lane's handle (the chord-tone toggle for `H`).
 */
export function mountTimeline(
  bar: HTMLElement,
  root: HTMLElement,
  store: Store,
  actions: Actions,
  options: TimelineOptions = {},
): MelodyLane {
  root.classList.add('timeline');
  root.setAttribute('aria-label', 'Timeline: chords with the melody beneath');
  const timeline = new Timeline(root);
  mountGrid(timeline, store, actions);
  const lane = mountMelody(bar, timeline, store, actions, options.storage ?? null, options.compact);
  // Working on the chord half gives the editing keys back to the chords; the strip takes them
  // itself when it is clicked (melody.ts).
  root.addEventListener('pointerdown', (e) => {
    if (!(e.target instanceof Element && e.target.closest('.melody-track') !== null)) {
      actions.setFocus('chords');
    }
  });

  const playhead = h('div', { class: 'playhead', attrs: { 'aria-hidden': 'true' } });
  let lastHead: unknown[] = [];
  let lastRow: number | null = null;

  /** Re-anchored only when the cursor, the timing or the rows change (issue #82). */
  const renderPlayhead = (state: AppState): void => {
    if (!state.playing) {
      lastHead = [];
      lastRow = null;
      removePlayhead(playhead);
      return;
    }
    const inputs = [state.cursor, state.song, state.loop, state.loopRange, timeline.bodies];
    if (inputs.every((value, i) => value === lastHead[i])) return;
    lastHead = inputs;
    const { layout } = timeline.plan(state);
    const row = anchorPlayhead(playhead, timeline.bodies, layout, state, actions.playhead());
    // Follow the playhead: its row scrolls into view once per row change, never per frame.
    if (row !== null && row !== lastRow) {
      lastRow = row;
      const el = timeline.rows[row];
      if (el !== undefined && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest' });
      }
    }
  };

  const render = (state: AppState): void => {
    timeline.compose();
    root.classList.toggle('focus-chords', state.focus === 'chords');
    root.classList.toggle('focus-melody', state.focus === 'melody');
    renderPlayhead(state);
  };
  render(store.state);
  store.subscribe(render);
  timeline.onRefresh = () => render(store.state);
  return lane;
}
