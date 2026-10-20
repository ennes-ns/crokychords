/** App shell (docs/specs/web-v1.md, "Layout"): containers, the compact flag and the Band default. */
import { createSong, createTrack } from '@crokychords/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createActions } from '../src/actions';
import { AudioEngine } from '../src/audio/synth';
import { MidiOut } from '../src/midi/webmidi';
import type { SongStorage } from '../src/persist';
import { BAND_OPEN_KEY, loadBandOpen } from '../src/persist';
import { Store, initialState } from '../src/state';
import css from '../src/styles.css?raw';
import { mountBand } from '../src/views/band';
import type { CompactMedia } from '../src/views/shell';
import { COMPACT_MAX_HEIGHT, COMPACT_QUERY, mountShell } from '../src/views/shell';

/** A media query list whose `matches` the test flips, like a window resized across 960 px. */
function fakeMedia(matches: boolean): CompactMedia & { set(matches: boolean): void } {
  const listeners: (() => void)[] = [];
  const media = {
    matches,
    addEventListener: (_type: 'change', listener: () => void) => {
      listeners.push(listener);
    },
    set(next: boolean) {
      media.matches = next;
      for (const listener of listeners) listener();
    },
  };
  return media;
}

function memoryStorage(initial: Record<string, string> = {}): SongStorage {
  const data = { ...initial };
  return {
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

function mountApp(media: CompactMedia | null, storage: SongStorage | null = null) {
  const app = document.createElement('div');
  document.body.append(app);
  const shell = mountShell(app, media);
  const song = createSong({ tracks: [createTrack('chords', { id: 'trk-a', channel: 0 })] });
  const store = new Store(initialState(song));
  const actions = createActions(store, new AudioEngine(), new MidiOut(null));
  mountBand(shell.band, store, actions, storage, null, null, { defaultOpen: !shell.compact() });
  return { app, shell };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('mountShell', () => {
  it('builds toolbar, stage, band and side column in reading order', () => {
    const { app, shell } = mountApp(null);
    expect(app.classList.contains('shell')).toBe(true);
    const workspace = app.querySelector(':scope > main.workspace');
    expect(app.firstElementChild).toBe(shell.toolbar);
    expect(workspace?.previousElementSibling).toBe(shell.toolbar);
    const [stage, band, side] = [...(workspace?.children ?? [])];
    expect(stage?.className).toBe('stage');
    // One timeline: the slim bar, then the rows (docs/specs/melody-v1.md §B2).
    expect([...(stage?.children ?? [])]).toEqual([shell.timelineBar, shell.timeline]);
    expect(band).toBe(shell.band);
    expect(side?.className).toBe('side');
    expect([...(side?.children ?? [])]).toEqual([shell.suggest, shell.editor, shell.saves]);
  });

  it('is not compact without a media query (jsdom, old browsers)', () => {
    const { app, shell } = mountApp(null);
    expect(shell.compact()).toBe(false);
    expect(app.classList.contains('compact')).toBe(false);
  });

  it('switches to compact below 960 px height and back when the window is resized', () => {
    expect(COMPACT_QUERY).toBe(`(max-height: ${COMPACT_MAX_HEIGHT}px)`);
    expect(COMPACT_MAX_HEIGHT).toBe(959);
    const media = fakeMedia(true);
    const { app, shell } = mountApp(media);
    expect(shell.compact()).toBe(true);
    expect(app.className).toBe('shell compact');
    media.set(false);
    expect(shell.compact()).toBe(false);
    expect(app.className).toBe('shell');
    media.set(true);
    expect(app.classList.contains('compact')).toBe(true);
  });
});

describe('Band panel in the shell', () => {
  it('starts collapsed on a compact screen when nothing is stored', () => {
    const { shell } = mountApp(fakeMedia(true), memoryStorage());
    expect(shell.band.classList.contains('collapsed')).toBe(true);
    expect(shell.band.querySelector('.band-toggle')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('starts open on a tall screen when nothing is stored', () => {
    const { shell } = mountApp(fakeMedia(false), memoryStorage());
    expect(shell.band.classList.contains('collapsed')).toBe(false);
  });

  it('keeps the stored choice on a compact screen', () => {
    const { shell } = mountApp(fakeMedia(true), memoryStorage({ [BAND_OPEN_KEY]: 'true' }));
    expect(shell.band.classList.contains('collapsed')).toBe(false);
  });

  it('loadBandOpen falls back to the given default only when nothing is stored', () => {
    expect(loadBandOpen(null)).toBe(true);
    expect(loadBandOpen(null, false)).toBe(false);
    expect(loadBandOpen(memoryStorage(), false)).toBe(false);
    expect(loadBandOpen(memoryStorage({ [BAND_OPEN_KEY]: 'true' }), false)).toBe(true);
    expect(loadBandOpen(memoryStorage({ [BAND_OPEN_KEY]: 'false' }), true)).toBe(false);
  });
});

describe('shell CSS', () => {
  it('locks the page and lets the panels scroll', () => {
    expect(css).toMatch(
      /html:has\(> body > \.shell\),\s*html:has\(> body > \.shell\) body \{[^}]*overflow: hidden;/,
    );
    expect(css).toMatch(/\.shell \{[^}]*height: 100dvh;/);
    for (const panel of [
      '.stage > .timeline',
      '.side .suggestions',
      '.workspace > .band .band-body',
    ]) {
      // The selector itself, not a longer one it is a prefix of (`.timeline` vs `.timeline-bar`).
      const at = css.search(new RegExp(`${panel.replace(/[.>]/g, '\\$&')}(?![\\w-])`));
      const rule = css.slice(at);
      expect(rule.slice(0, rule.indexOf('}')), panel).toMatch(/overflow-y: auto;/);
    }
  });

  it('keeps the toolbar on one row from 1366 px up (issue #84)', () => {
    expect(css).toMatch(/@media \(min-width: 1366px\) \{\s*\.toolbar \{\s*flex-wrap: nowrap;/);
    expect(css).toMatch(/\.toolbar > \.table-status \{[^}]*overflow: hidden;/);
  });

  it('has the compact density rules', () => {
    for (const selector of ['.shell.compact .track', '.shell.compact .melody-track']) {
      expect(css).toContain(`${selector} {`);
    }
  });
});
