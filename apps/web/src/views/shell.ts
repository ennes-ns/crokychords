/**
 * App shell (docs/specs/web-v1.md, "Layout"): the containers every view mounts into, laid out so
 * the whole editor fits one screen without page scrolling. Toolbar on top; below it the stage
 * (chord grid, melody lane), the Band panel at the bottom of the stage column, and the side column
 * for the selected chord and the song list (Next chord, chord editor, saved progressions). The CSS grid lives in styles.css; this file
 * owns the DOM structure and the compact flag for short screens.
 */
import { h } from '../dom';

/** Below this viewport height the shell switches to compact density. */
export const COMPACT_MAX_HEIGHT = 959;
export const COMPACT_QUERY = `(max-height: ${COMPACT_MAX_HEIGHT}px)`;

/** The part of `MediaQueryList` the shell uses; `window.matchMedia(COMPACT_QUERY)` in the app. */
export interface CompactMedia {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: () => void): void;
}

export interface Shell {
  toolbar: HTMLElement;
  grid: HTMLElement;
  melody: HTMLElement;
  editor: HTMLElement;
  band: HTMLElement;
  suggest: HTMLElement;
  saves: HTMLElement;
  /** Whether compact density is active right now. */
  compact(): boolean;
}

/** `window.matchMedia(COMPACT_QUERY)`, or null where matchMedia is missing (jsdom). */
export function browserCompactMedia(): CompactMedia | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia(COMPACT_QUERY) : null;
}

/**
 * Build the shell inside `app` (before any other children) and keep its `compact` class in step
 * with `media`. Without media the shell stays in normal density.
 */
export function mountShell(app: HTMLElement, media: CompactMedia | null): Shell {
  const toolbar = h('header');
  const grid = h('section');
  const melody = h('section');
  const editor = h('section');
  const band = h('section');
  const suggest = h('aside');
  const saves = h('section');
  app.classList.add('shell');
  app.prepend(
    toolbar,
    h(
      'main',
      { class: 'workspace' },
      h('div', { class: 'stage' }, grid, melody),
      band,
      h('div', { class: 'side' }, suggest, editor, saves),
    ),
  );
  const sync = (): void => {
    app.classList.toggle('compact', media?.matches === true);
  };
  sync();
  media?.addEventListener('change', sync);
  return {
    toolbar,
    grid,
    melody,
    editor,
    band,
    suggest,
    saves,
    compact: () => media?.matches === true,
  };
}
