/**
 * Pattern editor (docs/specs/pattern-editor-v1.md, B3): a step grid under a track in the Band
 * panel. Rows are note selectors (chord tones, bass, ...), columns are 1/16 notes. Mouse-first:
 * click adds or removes a step, dragging sets its end, Shift+click toggles the accent. Every
 * gesture is one undo step; drags preview live.
 */
import type { Pattern, Song, Track } from '@crokychords/core';
import { MAX_SONG_PATTERNS } from '@crokychords/core';
import type { Actions } from '../actions';
import { findTrack, songPatterns } from '../band';
import { h, option } from '../dom';
import type { PatternRow } from '../pattern';
import {
  PATTERN_LENGTHS,
  PATTERN_STEP,
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
} from '../pattern';
import type { AppState, Store } from '../state';

/** Columns per beat. */
const PER_BEAT = Math.round(1 / PATTERN_STEP);

/** "1", "1.5", "0.25" beats. */
function beatsLabel(beats: number): string {
  return `${Math.round(beats * 1000) / 1000}`;
}

interface CellPaint {
  on: boolean;
  head: boolean;
  accent: boolean;
  title: string;
}

/** What every cell of the grid shows: `cells[row][column]`. */
export function paintCells(pattern: Pattern, rows: readonly PatternRow[]): CellPaint[][] {
  const columns = patternColumns(pattern);
  const cells = rows.map(() =>
    Array.from({ length: columns }, (): CellPaint => ({
      on: false,
      head: false,
      accent: false,
      title: '',
    })),
  );
  for (const step of pattern.steps) {
    const r = rows.findIndex((row) => row.key === selectorKey(step.notes));
    const line = cells[r];
    const row = rows[r];
    if (line === undefined || row === undefined) continue;
    const first = Math.floor(step.at / PATTERN_STEP + 1e-9);
    const last = Math.max(first, Math.ceil((step.at + step.length) / PATTERN_STEP - 1e-9) - 1);
    const accent = isAccented(step);
    for (let c = first; c <= Math.min(last, columns - 1); c++) {
      const cell = line[c];
      if (cell === undefined) continue;
      cell.on = true;
      cell.accent = accent;
      if (c === first) {
        cell.head = true;
        cell.title =
          `${row.label} · beat ${beatsLabel(step.at + 1)} · ${beatsLabel(step.length)} beats` +
          (accent ? ' · accent' : '');
      }
    }
  }
  return cells;
}

/** `Esc` closes the open editor (docs/specs/pattern-editor-v1.md, B3); true when handled. */
export function patternEditorKey(
  e: Pick<KeyboardEvent, 'key'>,
  state: Pick<AppState, 'patternEditor'>,
  actions: Pick<Actions, 'openPatternEditor'>,
): boolean {
  if (e.key !== 'Escape' || state.patternEditor === null) return false;
  actions.openPatternEditor(null);
  return true;
}

export interface PatternEditorView {
  el: HTMLElement;
  /** Show the editor for `track` (patched in place; the grid is rebuilt only when its shape changes). */
  update(track: Track, song: Song): void;
}

interface Drag {
  trackId: string;
  base: Song;
  /** The pattern the drag edits (after adding the new step). */
  pattern: Pattern;
  index: number;
  column: number;
  existing: boolean;
  moved: boolean;
}

export function createPatternEditor(store: Store, actions: Actions): PatternEditorView {
  let trackId = '';
  const current = (): Track | undefined => findTrack(store.state.song, trackId);
  const edit = (change: (p: Pattern) => Pattern): void => {
    const track = current();
    if (track === undefined) return;
    const next = change(track.pattern);
    if (next !== track.pattern) actions.editPattern(track.id, next);
  };

  const title = h('h3', { class: 'pattern-title' });
  const length = h('select', {
    attrs: { 'aria-label': 'Pattern length in beats', 'data-field': 'pattern-length' },
  });
  length.onchange = () => edit((p) => setPatternLength(p, Number(length.value)));
  const hold = h('input', {
    props: { type: 'checkbox' },
    attrs: { 'data-field': 'pattern-hold' },
  });
  hold.onchange = () => edit((p) => setPatternTail(p, hold.checked));
  const button = (text: string, field: string, tip: string, onClick: () => void) => {
    const b = h(
      'button',
      { props: { type: 'button' }, attrs: { 'data-field': field, title: tip } },
      text,
    );
    b.onclick = onClick;
    return b;
  };
  const strum = button('Strum', 'pattern-strum', 'Fill: tones 1–4 rolled on every beat', () =>
    edit(fillStrum),
  );
  const downUp = button(
    'Down–up',
    'pattern-downup',
    'Fill: the chord on every 1/8, accented on the beat',
    () => edit(fillDownUp),
  );
  const clear = button('Clear', 'pattern-clear', 'Remove every step', () => edit(clearSteps));
  const name = h('input', {
    class: 'pattern-name',
    props: { type: 'text', spellcheck: false, maxLength: 60 },
    attrs: { 'aria-label': 'Preset name', 'data-field': 'pattern-name' },
  });
  const save = button(
    'Save as preset',
    'pattern-save',
    'Store this pattern in the song so every track can pick it',
    () => {
      const chosen = name.value.trim() === '' ? name.placeholder : name.value;
      if (actions.savePatternPreset(trackId, chosen)) name.value = '';
    },
  );
  const remove = button('Delete preset', 'pattern-delete', 'Remove this song preset', () => {
    const track = current();
    if (track !== undefined) actions.deletePatternPreset(track.pattern.id);
  });
  remove.classList.add('danger');
  const close = h(
    'button',
    {
      class: 'icon',
      props: { type: 'button' },
      attrs: { title: 'Close (Esc)', 'aria-label': 'Close the pattern editor' },
    },
    '✕',
  );
  close.onclick = () => actions.openPatternEditor(null);

  const grid = h('div', { class: 'pattern-grid', attrs: { 'data-field': 'pattern-grid' } });
  const el = h(
    'div',
    { class: 'pattern-editor', attrs: { role: 'group', 'aria-label': 'Pattern editor' } },
    h(
      'div',
      { class: 'pattern-head' },
      title,
      h('label', {}, 'Length ', length),
      h('label', { class: 'check' }, hold, 'Hold last note'),
      h('span', { class: 'pattern-fills' }, strum, downUp, clear),
      h('span', { class: 'pattern-presets' }, name, save, remove),
      close,
    ),
    grid,
    h(
      'p',
      { class: 'hint' },
      'Click: add or remove a step · drag: length · Shift+click: accent · Esc: close. ' +
        'Tone rows count chord tones from the bottom of the voicing.',
    ),
  );
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    actions.openPatternEditor(null);
  });

  let shape = '';
  let rows: PatternRow[] = [];
  let cells: HTMLElement[][] = [];
  let drag: Drag | null = null;

  const build = (pattern: Pattern): void => {
    const columns = patternColumns(pattern);
    rows = patternRows(pattern);
    cells = [];
    grid.replaceChildren(
      ...rows.map((row, r) => {
        const line = Array.from({ length: columns }, (_, c) =>
          h('span', {
            class: c % PER_BEAT === 0 ? 'pcell beat' : 'pcell',
            attrs: { 'data-row': String(r), 'data-col': String(c) },
          }),
        );
        cells.push(line);
        return h(
          'div',
          { class: 'pattern-row', attrs: { 'data-key': row.key } },
          h('span', { class: 'pattern-label', attrs: { title: row.title } }, row.label),
          h(
            'span',
            {
              class: 'pattern-cells',
              style: { 'grid-template-columns': `repeat(${columns}, minmax(14px, 1fr))` },
            },
            ...line,
          ),
        );
      }),
    );
  };

  const paint = (pattern: Pattern): void => {
    const painted = paintCells(pattern, rows);
    cells.forEach((line, r) =>
      line.forEach((cell, c) => {
        const p = painted[r]?.[c];
        if (p === undefined) return;
        cell.classList.toggle('on', p.on);
        cell.classList.toggle('head', p.head);
        cell.classList.toggle('accent', p.on && p.accent);
        cell.classList.toggle('soft', p.on && !p.accent);
        if (p.title === '') cell.removeAttribute('title');
        else cell.title = p.title;
      }),
    );
  };

  const cellOf = (target: EventTarget | null): { row: number; col: number } | null => {
    if (!(target instanceof Element)) return null;
    const cell = target.closest<HTMLElement>('.pcell');
    if (cell === null) return null;
    return { row: Number(cell.dataset['row']), col: Number(cell.dataset['col']) };
  };

  const end = (): void => {
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    const d = drag;
    drag = null;
    if (d === null) return;
    if (d.existing && !d.moved) {
      actions.editPattern(d.trackId, removeStep(d.pattern, d.index), d.base);
      return;
    }
    const track = findTrack(store.state.song, d.trackId);
    if (track !== undefined) actions.editPattern(d.trackId, track.pattern, d.base);
  };

  grid.addEventListener('pointerdown', (e) => {
    const at = cellOf(e.target);
    const track = current();
    const row = at === null ? undefined : rows[at.row];
    if (at === null || track === undefined || row === undefined || e.button > 0) return;
    e.preventDefault();
    const pattern = track.pattern;
    const hit = stepAt(pattern, row.key, at.col);
    if (e.shiftKey) {
      edit((p) =>
        hit === null
          ? addStep(p, row.selector, at.col * PATTERN_STEP, true).pattern
          : toggleAccent(p, hit),
      );
      return;
    }
    const base = store.state.song;
    if (hit === null) {
      const added = addStep(pattern, row.selector, at.col * PATTERN_STEP);
      drag = {
        trackId,
        base,
        pattern: added.pattern,
        index: added.index,
        column: at.col,
        existing: false,
        moved: false,
      };
      actions.previewPattern(trackId, added.pattern);
    } else {
      drag = { trackId, base, pattern, index: hit, column: at.col, existing: true, moved: false };
    }
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  });

  grid.addEventListener('pointerover', (e) => {
    const at = cellOf(e.target);
    if (drag === null || at === null) return;
    if (at.col !== drag.column) drag.moved = true;
    if (!drag.moved) return;
    const next = setStepEnd(drag.pattern, drag.index, (at.col + 1) * PATTERN_STEP);
    const track = findTrack(store.state.song, drag.trackId);
    if (track !== undefined && JSON.stringify(next) !== JSON.stringify(track.pattern)) {
      actions.previewPattern(drag.trackId, next);
    }
  });

  return {
    el,
    update(track, song) {
      trackId = track.id;
      const { pattern } = track;
      el.dataset['track'] = track.id;
      title.textContent = `Pattern · ${track.name}`;
      const lengths = PATTERN_LENGTHS.includes(pattern.length)
        ? PATTERN_LENGTHS
        : [...PATTERN_LENGTHS, pattern.length].sort((a, b) => a - b);
      const lengthKey = lengths.join();
      if (length.dataset['options'] !== lengthKey) {
        length.dataset['options'] = lengthKey;
        length.replaceChildren(
          ...lengths.map((l) => option(String(l), `${beatsLabel(l)} beat${l === 1 ? '' : 's'}`)),
        );
      }
      length.value = String(pattern.length);
      hold.checked = pattern.tail === 'sustain';
      const presets = songPatterns(song);
      const isSongPreset = presets.some((p) => p.id === pattern.id);
      remove.hidden = !isSongPreset;
      save.disabled = presets.length >= MAX_SONG_PATTERNS;
      name.placeholder = pattern.name;
      const nextShape = `${patternRows(pattern)
        .map((r) => r.key)
        .join()}|${patternColumns(pattern)}`;
      if (nextShape !== shape) {
        shape = nextShape;
        build(pattern);
      }
      paint(pattern);
    },
  };
}
