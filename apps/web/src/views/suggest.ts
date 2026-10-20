/** Next chord panel: suggestions for the next chord from the active n-gram table. */
import type { Mode, Song, Suggestion } from '@crokychords/core';
import {
  diatonicTriadToken,
  isDiatonic,
  isRestToken,
  popularChords,
  songKey,
  suggestNext,
  tryParseToken,
} from '@crokychords/core';
import type { Actions } from '../actions';
import { h, replaceChildren } from '../dom';
import { DEGREES, MODE_LABELS, colorDegree, degreeHue, tokenName } from '../music';
import type { AppState, Store } from '../state';
import { activeTable } from '../state';

export const SUGGESTION_LIMIT = 16;

/**
 * Context for the next chord: the tokens up to and including the selected chord (the
 * insertion point), or the whole song when nothing is selected. Rests are removed.
 */
export function suggestionContext(song: Song, selected: number | null): string[] {
  const chords = selected === null ? song.chords : song.chords.slice(0, selected + 1);
  return chords.map((c) => c.token).filter((t) => !isRestToken(t));
}

export interface SuggestionItem {
  token: string;
  name: string;
  /** null for the diatonic fallback (no data). */
  probability: number | null;
  count: number | null;
}

export interface SuggestionView {
  items: SuggestionItem[];
  /** 'after IV, I', 'any position', or a note about missing data. */
  contextLabel: string;
  /** The table has no row for the song's mode. */
  noData: boolean;
}

export function suggestionFilter(mode: Mode, diatonicOnly: boolean): (token: string) => boolean {
  return (token) =>
    tryParseToken(token) !== undefined && (!diatonicOnly || isDiatonic(token, mode));
}

export function computeSuggestions(
  state: Pick<AppState, 'song' | 'selected' | 'suggestMode' | 'diatonicOnly' | 'table' | 'ngrams'>,
): SuggestionView {
  const { song, selected, suggestMode, diatonicOnly } = state;
  const mode = song.key.mode;
  const table = activeTable(state);
  const key = songKey(song);
  const toItem = (s: Suggestion): SuggestionItem => ({
    token: s.token,
    name: tokenName(s.token, key),
    probability: s.probability,
    count: s.count,
  });

  if (table.modes[mode] === undefined) {
    const items = DEGREES.map((d) => diatonicTriadToken(d, mode)).map((token) => ({
      token,
      name: tokenName(token, key),
      probability: null,
      count: null,
    }));
    return {
      items,
      contextLabel: `no data for ${MODE_LABELS[mode].toLowerCase()} in "${table.source.name}": diatonic triads`,
      noData: true,
    };
  }

  const options = { limit: SUGGESTION_LIMIT, filter: suggestionFilter(mode, diatonicOnly) };
  const suggestions =
    suggestMode === 'popular'
      ? popularChords(table, mode, options)
      : suggestNext(table, mode, suggestionContext(song, selected), options);
  const used = suggestions[0]?.contextUsed ?? [];
  return {
    items: suggestions.map(toItem),
    contextLabel: used.length > 0 ? `after ${used.join(', ')}` : 'any position',
    noData: false,
  };
}

function percent(p: number): string {
  if (p >= 0.1) return `${Math.round(p * 100)}%`;
  return `${(p * 100).toFixed(1)}%`;
}

export function mountSuggest(root: HTMLElement, store: Store, actions: Actions): void {
  root.classList.add('panel', 'suggest');

  const contextButton = h('button', { class: 'seg', props: { type: 'button' } }, 'In context');
  const popularButton = h('button', { class: 'seg', props: { type: 'button' } }, 'Popular');
  contextButton.onclick = () => store.set({ suggestMode: 'context' });
  popularButton.onclick = () => store.set({ suggestMode: 'popular' });
  const diatonic = h('input', { props: { type: 'checkbox' } });
  diatonic.onchange = () => store.set({ diatonicOnly: diatonic.checked });
  const context = h('div', { class: 'context' });
  const list = h('ul', { class: 'suggestions', attrs: { 'aria-label': 'Suggested chords' } });

  root.append(
    h(
      'header',
      { class: 'panel-head' },
      h('h2', {}, 'Next chord'),
      h('div', { class: 'segmented', attrs: { role: 'group' } }, contextButton, popularButton),
    ),
    h('label', { class: 'check' }, diatonic, ' Diatonic only'),
    context,
    list,
    h('p', { class: 'hint' }, 'Click to insert after the selection. Hover to listen.'),
  );

  let hoverTimer: number | undefined;
  let last: unknown[] = [];

  const render = (state: AppState): void => {
    const inputs = [
      state.song,
      state.selected,
      state.suggestMode,
      state.diatonicOnly,
      activeTable(state),
    ];
    if (inputs.every((value, i) => value === last[i])) return;
    last = inputs;

    contextButton.classList.toggle('active', state.suggestMode === 'context');
    popularButton.classList.toggle('active', state.suggestMode === 'popular');
    contextButton.setAttribute('aria-pressed', String(state.suggestMode === 'context'));
    popularButton.setAttribute('aria-pressed', String(state.suggestMode === 'popular'));
    diatonic.checked = state.diatonicOnly;

    const view = computeSuggestions(state);
    context.textContent = view.contextLabel;
    context.classList.toggle('warn', view.noData);
    const top = Math.max(...view.items.map((i) => i.probability ?? 0), 0);

    replaceChildren(
      list,
      ...view.items.map((item) => {
        const degree = colorDegree(item.token);
        const width = item.probability === null || top <= 0 ? 0 : (item.probability / top) * 100;
        const button = h(
          'button',
          {
            class: 'suggestion',
            props: { type: 'button' },
            style: degree === null ? {} : { '--hue': String(degreeHue(degree)) },
            attrs: {
              title: item.count === null ? item.token : `${item.token}: ${item.count} observations`,
            },
          },
          h('span', { class: 'token' }, item.token),
          h('span', { class: 'name' }, item.name),
          h('span', { class: 'pct' }, item.probability === null ? '' : percent(item.probability)),
          h('span', { class: 'bar' }, h('span', { style: { width: `${width}%` } })),
        );
        button.onclick = () => actions.insert(item.token);
        button.onmouseenter = () => {
          window.clearTimeout(hoverTimer);
          hoverTimer = window.setTimeout(() => actions.audition(item.token), 60);
        };
        button.onmouseleave = () => window.clearTimeout(hoverTimer);
        return h('li', {}, button);
      }),
    );
    if (view.items.length === 0) {
      list.append(h('li', { class: 'empty' }, 'No suggestions.'));
    }
  };

  render(store.state);
  store.subscribe(render);
}
