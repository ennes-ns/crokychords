/** Properties of the selected chord; every edit round-trips through the token. */
import type {
  Accidental,
  Alteration,
  AppliedTarget,
  Chord,
  Degree,
  Extension,
  Mode,
  Quality,
} from '@crokychords/core';
import {
  ALTERATIONS,
  EXTENSIONS,
  QUALITIES,
  REST_TOKEN,
  formatToken,
  isDiminishedExtension,
  isRestToken,
  songKey,
  tryParseToken,
} from '@crokychords/core';
import type { Actions } from '../actions';
import { h, option, replaceChildren } from '../dom';
import { MIN_BEATS, setChordBeats } from '../edit';
import { DEGREES, diatonicQuality, diatonicTriadToken, tokenName } from '../music';
import type { AppState, Store } from '../state';

export type AppliedFunction = 'V' | 'IV' | 'vii°';
export const APPLIED_FUNCTIONS: readonly AppliedFunction[] = ['V', 'IV', 'vii°'];
const FUNCTION_CHORDS: Record<AppliedFunction, { degree: Degree; quality: Quality }> = {
  V: { degree: 5, quality: 'major' },
  IV: { degree: 4, quality: 'major' },
  'vii°': { degree: 7, quality: 'dim' },
};

export const ACCIDENTALS: readonly Accidental[] = [-2, -1, 0, 1, 2];
const ACCIDENTAL_LABELS: Record<Accidental, string> = {
  [-2]: 'bb',
  [-1]: 'b',
  0: '♮',
  1: '#',
  2: '##',
};
const NUMERALS: Record<Degree, string> = {
  1: 'I',
  2: 'II',
  3: 'III',
  4: 'IV',
  5: 'V',
  6: 'VI',
  7: 'VII',
};
const QUALITY_LABELS: Record<Quality, string> = {
  major: 'major',
  minor: 'minor',
  dim: 'diminished',
  aug: 'augmented',
};
const SUS_OPTIONS: readonly (readonly (2 | 4)[])[] = [[], [2], [4], [2, 4]];
const ADDS: readonly (6 | 9 | 11)[] = [6, 9, 11];
const INVERSIONS: readonly Chord['inversion'][] = [0, 1, 2, 3];
const INVERSION_LABELS = ['root', '1st', '2nd', '3rd'] as const;

export type ChordChange =
  | { field: 'degree'; value: Degree }
  | { field: 'accidental'; value: Accidental }
  | { field: 'quality'; value: Quality }
  | { field: 'extension'; value: Extension }
  | { field: 'sus'; value: readonly (2 | 4)[] }
  | { field: 'add'; value: 6 | 9 | 11; on: boolean }
  | { field: 'alteration'; value: Alteration; on: boolean }
  | { field: 'inversion'; value: Chord['inversion'] }
  | { field: 'applied'; value: AppliedFunction | null }
  | { field: 'target'; value: Degree; accidental: Accidental };

function sorted<T extends number>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/** Make extension and quality agree ('7' on a dim triad becomes 'ø7', 'ø7' on minor '7'). */
function fitExtension(chord: Chord): Chord {
  const ext = chord.extension;
  if (ext === 'none') return chord;
  if (chord.quality === 'dim' && !isDiminishedExtension(ext) && !ext.startsWith('maj')) {
    return { ...chord, extension: EXTENSIONS.find((e) => e === `ø${ext}`) ?? 'none' };
  }
  if (chord.quality !== 'dim' && isDiminishedExtension(ext)) {
    return { ...chord, extension: EXTENSIONS.find((e) => e === ext.slice(1)) ?? 'none' };
  }
  return chord;
}

function targetFor(mode: Mode, target: Degree, accidental: Accidental): AppliedTarget {
  return {
    target,
    targetAccidental: accidental,
    targetQuality: accidental === 0 ? diatonicQuality(mode, target) : 'major',
  };
}

/** Apply one edit and repair the fields it invalidates (sus ⇒ major, dim ⇒ ø7, ...). */
export function applyChange(chord: Chord, change: ChordChange, mode: Mode): Chord {
  let next: Chord = { ...chord };
  switch (change.field) {
    case 'degree':
      next.degree = change.value;
      break;
    case 'accidental':
      next.accidental = change.value;
      break;
    case 'quality':
      next.quality = change.value;
      if (change.value !== 'major') next.sus = [];
      next = fitExtension(next);
      break;
    case 'extension':
      next.extension = change.value;
      if (isDiminishedExtension(change.value)) {
        next.quality = 'dim';
        next.sus = [];
      } else if (
        next.quality === 'dim' &&
        change.value !== 'none' &&
        !change.value.startsWith('maj')
      ) {
        next.quality = 'minor';
      }
      if (change.value === 'none' && next.inversion === 3) next.inversion = 0;
      break;
    case 'sus':
      next.sus = sorted(change.value);
      if (next.sus.length > 0) {
        next.quality = 'major';
        next = fitExtension(next);
      }
      break;
    case 'add':
      next.adds = sorted(
        change.on ? [...chord.adds, change.value] : chord.adds.filter((a) => a !== change.value),
      );
      break;
    case 'alteration': {
      const set = new Set(chord.alterations);
      if (change.on) set.add(change.value);
      else set.delete(change.value);
      next.alterations = ALTERATIONS.filter((a) => set.has(a));
      break;
    }
    case 'inversion':
      next.inversion = change.value;
      break;
    case 'applied':
      if (change.value === null) {
        delete next.applied;
      } else {
        const fn = FUNCTION_CHORDS[change.value];
        next.degree = fn.degree;
        next.quality = fn.quality;
        next.accidental = 0;
        if (fn.quality !== 'major') next.sus = [];
        next.applied = chord.applied ?? targetFor(mode, 5, 0);
        next = fitExtension(next);
      }
      break;
    case 'target':
      next.applied = targetFor(mode, change.value, change.accidental);
      break;
  }
  return next;
}

/** The token after the change, or null when the result has no valid token spelling. */
export function changedToken(chord: Chord, change: ChordChange, mode: Mode): string | null {
  const next = applyChange(chord, change, mode);
  if (next.inversion === 3 && next.extension === 'none') return null;
  try {
    const token = formatToken(next);
    const back = tryParseToken(token);
    return back !== undefined && formatToken(back) === token ? token : null;
  } catch {
    return null;
  }
}

/** The applied function of a chord, if it is one of the presets. */
export function appliedFunction(chord: Chord): AppliedFunction | null {
  if (chord.applied === undefined || chord.accidental !== 0) return null;
  return (
    APPLIED_FUNCTIONS.find((f) => {
      const fn = FUNCTION_CHORDS[f];
      return fn.degree === chord.degree && fn.quality === chord.quality;
    }) ?? null
  );
}

export function mountChordEditor(root: HTMLElement, store: Store, actions: Actions): void {
  root.classList.add('panel', 'editor');
  let last: unknown[] = [];

  const render = (state: AppState): void => {
    const { song, selected } = state;
    const current = selected === null ? undefined : song.chords[selected];
    const inputs = [current?.token, current?.beats, selected, song.key.mode, song.key.tonic];
    if (inputs.every((value, i) => value === last[i])) return;
    last = inputs;

    const focused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.dataset['field']
        : undefined;
    replaceChildren(root, ...build(state));
    if (focused !== undefined) {
      root.querySelector<HTMLElement>(`[data-field="${focused}"]`)?.focus();
    }
  };

  const build = (state: AppState): HTMLElement[] => {
    const { song, selected } = state;
    const current = selected === null ? undefined : song.chords[selected];
    const head = h('header', { class: 'panel-head' }, h('h2', {}, 'Chord'));
    if (selected === null || current === undefined) {
      return [head, h('p', { class: 'hint' }, 'Select a chord in the grid to edit it.')];
    }

    const lengthInput = h('input', {
      props: {
        type: 'number',
        min: String(MIN_BEATS),
        step: String(MIN_BEATS),
        value: String(current.beats),
      },
      attrs: { 'data-field': 'beats', 'aria-label': 'Length in beats' },
    });
    lengthInput.onchange = () => {
      const beats = Number(lengthInput.value);
      if (Number.isFinite(beats) && beats > 0) {
        store.commit(setChordBeats(store.state.song, selected, beats));
      } else {
        lengthInput.value = String(current.beats);
      }
    };
    const length = field('Beats', lengthInput);

    if (isRestToken(current.token)) {
      const toChord = button('Make chord', 'rest', () =>
        actions.setSelectedToken(diatonicTriadToken(song.key.mode, 1)),
      );
      return [
        head,
        h('div', { class: 'summary' }, h('span', { class: 'token' }, 'rest')),
        h('div', { class: 'fields' }, length, toChord),
      ];
    }

    const chord = tryParseToken(current.token);
    if (chord === undefined) {
      return [head, h('p', { class: 'hint warn' }, `Unknown token "${current.token}".`)];
    }

    const mode = song.key.mode;
    const set = (token: string | null): void => {
      if (token === null) return;
      actions.setSelectedToken(token);
      actions.audition(token);
    };
    const choose = <T>(
      name: string,
      label: string,
      values: readonly T[],
      currentValue: T,
      labelOf: (v: T) => string,
      change: (v: T) => ChordChange,
    ): HTMLElement => {
      const select = h('select', { attrs: { 'data-field': name, 'aria-label': label } });
      values.forEach((value, i) => {
        const token =
          value === currentValue ? current.token : changedToken(chord, change(value), mode);
        const opt = option(String(i), labelOf(value), value === currentValue);
        opt.disabled = token === null;
        select.append(opt);
      });
      select.onchange = () => {
        const value = values[Number(select.value)];
        if (value !== undefined) set(changedToken(chord, change(value), mode));
      };
      return field(label, select);
    };
    const toggles = <T extends string | number>(
      name: string,
      label: string,
      values: readonly T[],
      isOn: (v: T) => boolean,
      labelOf: (v: T) => string,
      change: (v: T, on: boolean) => ChordChange,
    ): HTMLElement => {
      const boxes = values.map((value) => {
        const on = isOn(value);
        const token = changedToken(chord, change(value, !on), mode);
        const input = h('input', {
          props: { type: 'checkbox', checked: on, disabled: token === null },
          attrs: { 'data-field': `${name}-${value}` },
        });
        input.onchange = () => set(changedToken(chord, change(value, input.checked), mode));
        return h('label', { class: 'check' }, input, labelOf(value));
      });
      return h('fieldset', { class: 'field toggles' }, h('legend', {}, label), ...boxes);
    };

    const fn = appliedFunction(chord);
    const appliedValues: readonly (AppliedFunction | null)[] = [null, ...APPLIED_FUNCTIONS];
    const appliedCurrent = chord.applied === undefined ? null : fn;
    const appliedSelect = choose(
      'applied',
      'Applied',
      chord.applied !== undefined && fn === null
        ? [...appliedValues, 'custom' as const]
        : appliedValues,
      chord.applied !== undefined && fn === null ? ('custom' as const) : appliedCurrent,
      (v) => (v === null ? 'none' : v === 'custom' ? 'custom' : `${v} of…`),
      (v) => ({ field: 'applied', value: v === 'custom' ? fn : v }),
    );

    const fields: HTMLElement[] = [
      choose(
        'degree',
        'Degree',
        DEGREES,
        chord.degree,
        (d) => `${d} · ${NUMERALS[d]}`,
        (d) => ({ field: 'degree', value: d }),
      ),
      choose(
        'accidental',
        'Accidental',
        ACCIDENTALS,
        chord.accidental,
        (a) => ACCIDENTAL_LABELS[a],
        (a) => ({ field: 'accidental', value: a }),
      ),
      choose(
        'quality',
        'Quality',
        QUALITIES,
        chord.quality,
        (q) => QUALITY_LABELS[q],
        (q) => ({ field: 'quality', value: q }),
      ),
      choose(
        'extension',
        'Extension',
        EXTENSIONS,
        chord.extension,
        (e) => (e === 'none' ? 'triad' : e),
        (e) => ({ field: 'extension', value: e }),
      ),
      choose(
        'sus',
        'Sus',
        SUS_OPTIONS,
        SUS_OPTIONS.find((s) => s.join() === chord.sus.join()) ?? [],
        (s) => (s.length === 0 ? 'none' : s.map((n) => `sus${n}`).join(' ')),
        (s) => ({ field: 'sus', value: s }),
      ),
      choose(
        'inversion',
        'Inversion',
        INVERSIONS,
        chord.inversion,
        (i) => INVERSION_LABELS[i],
        (i) => ({ field: 'inversion', value: i }),
      ),
      appliedSelect,
    ];
    if (chord.applied !== undefined) {
      const applied = chord.applied;
      fields.push(
        choose(
          'target-accidental',
          'Target accidental',
          ACCIDENTALS,
          applied.targetAccidental,
          (a) => ACCIDENTAL_LABELS[a],
          (a) => ({ field: 'target', value: applied.target, accidental: a }),
        ),
        choose(
          'target',
          'Target',
          DEGREES,
          applied.target,
          (d) => `${d} · ${NUMERALS[d]}`,
          (d) => ({ field: 'target', value: d, accidental: applied.targetAccidental }),
        ),
      );
    }
    fields.push(length);

    const summary = h(
      'div',
      { class: 'summary' },
      h('span', { class: 'token' }, current.token),
      h('span', { class: 'name' }, tokenName(current.token, songKey(song))),
      button('▶', 'Listen', () => actions.audition(current.token)),
      button('Make rest', 'Turn this chord into a rest', () =>
        actions.setSelectedToken(REST_TOKEN),
      ),
    );

    return [
      head,
      summary,
      h('div', { class: 'fields' }, ...fields),
      h(
        'div',
        { class: 'fields' },
        toggles(
          'add',
          'Add',
          ADDS,
          (a) => chord.adds.includes(a),
          (a) => `add${a}`,
          (a, on) => ({ field: 'add', value: a, on }),
        ),
        toggles(
          'alt',
          'Alterations',
          ALTERATIONS,
          (a) => chord.alterations.includes(a),
          (a) => a,
          (a, on) => ({ field: 'alteration', value: a, on }),
        ),
      ),
    ];
  };

  render(store.state);
  store.subscribe(render);
}

function field(label: string, control: HTMLElement): HTMLElement {
  return h('label', { class: 'field' }, h('span', { class: 'label' }, label), control);
}

function button(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = h('button', { props: { type: 'button' }, attrs: { title } }, text);
  b.onclick = onClick;
  return b;
}
