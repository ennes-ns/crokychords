/** Themes: every theme defines the full token list, styles.css uses only tokens, Pixel contrast. */
import { describe, expect, it } from 'vitest';
import css from '../src/styles.css?raw';
import type { Theme } from '../src/themes';
import {
  COLOUR_TOKENS,
  DEFAULT_THEME_ID,
  THEMES,
  TOKEN_NAMES,
  applyTheme,
  adoptThemeSheet,
  installThemes,
  loadThemeId,
  saveThemeId,
  themeCss,
  THEME_STORAGE_KEY,
} from '../src/themes';

const publicFiles = Object.keys(import.meta.glob('../public/fonts/*')).map((p) =>
  p.replace('../public/fonts/', ''),
);

const brandFiles = Object.keys(import.meta.glob('../public/brand/*')).map((p) =>
  p.replace('../public/', '/'),
);

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = ['--text', '--muted', '--accent', '--brand-accent', '--danger', '--ok'] as const;
const SURFACES = ['--bg', '--panel', '--panel-2', '--row-selected'] as const;

describe('theme registry', () => {
  it('has unique, storage-safe ids and starts with Default', () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
    expect(ids[0]).toBe(DEFAULT_THEME_ID);
  });

  it.each(THEMES.map((t): [string, Theme] => [t.id, t]))(
    '%s defines exactly the full token list',
    (_id, theme) => {
      expect(Object.keys(theme.tokens).sort()).toEqual([...TOKEN_NAMES].sort());
      for (const name of TOKEN_NAMES) expect(theme.tokens[name].trim()).not.toBe('');
      for (const name of COLOUR_TOKENS) expect(theme.tokens[name]).toMatch(/^#[0-9a-f]{6}$/);
    },
  );

  it.each(THEMES.map((t): [string, Theme] => [t.id, t]))(
    '%s bundles its fonts locally with a licence file',
    (_id, theme) => {
      for (const font of theme.fonts ?? []) {
        expect(publicFiles).toContain(font.file);
        expect(publicFiles).toContain(font.licence);
      }
    },
  );

  it.each(THEMES.map((t): [string, Theme] => [t.id, t]))(
    '%s only points its mark at a shipped brand file',
    (_id, theme) => {
      const url = /^url\('([^']+)'\)$/.exec(theme.tokens['--mark-image'])?.[1];
      if (url !== undefined) expect(brandFiles).toContain(url);
      else expect(theme.tokens['--mark-image']).toBe('normal');
    },
  );
});

describe('themeCss', () => {
  const out = themeCss();

  it('writes one rule per theme, Default also on plain :root', () => {
    for (const theme of THEMES) expect(out).toContain(`:root[data-theme='${theme.id}'] {`);
    expect(out).toMatch(/^:root,\n:root\[data-theme='default'\] \{/m);
    expect(out.split('--bg:').length - 1).toBe(THEMES.length);
  });

  it('declares every bundled font face from /fonts/, never a remote URL', () => {
    const faces = THEMES.flatMap((t) => t.fonts ?? []);
    expect(out.split('@font-face').length - 1).toBe(faces.length);
    for (const font of faces) expect(out).toContain(`url('/fonts/${font.file}')`);
    expect(out).not.toMatch(/https?:/);
  });
});

describe('styles.css', () => {
  it('has no hard-coded colours', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\brgba?\(/);
    expect(css).not.toMatch(/\bhsla?\((?!var\(--hue\) var\(--)/);
  });

  it('uses only theme tokens (and the per-element --hue)', () => {
    const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
    const known = new Set<string>([...TOKEN_NAMES, '--hue']);
    expect([...used].filter((name) => name !== undefined && !known.has(name))).toEqual([]);
    for (const name of TOKEN_NAMES) expect(used.has(name)).toBe(true);
  });

  it('turns transitions off for reduced motion', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});

describe('Pixel contrast', () => {
  const pixel = THEMES.find((t) => t.id === 'pixel');

  it('keeps every text colour at 4.5:1 or more on every surface', () => {
    expect(pixel).toBeDefined();
    if (pixel === undefined) return;
    for (const text of TEXT) {
      for (const surface of SURFACES) {
        const ratio = contrast(pixel.tokens[text], pixel.tokens[surface]);
        expect(ratio, `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrast(pixel.tokens['--on-accent'], pixel.tokens['--accent'])).toBeGreaterThanOrEqual(
      4.5,
    );
  });
});

describe('applying and persisting', () => {
  it('installs the stylesheet once and sets data-theme', () => {
    installThemes(document);
    installThemes(document);
    expect(document.querySelectorAll('style#themes')).toHaveLength(1);
    expect(applyTheme('pixel', document)).toBe('pixel');
    expect(document.documentElement.dataset.theme).toBe('pixel');
    expect(applyTheme('no-such-theme', document)).toBe(DEFAULT_THEME_ID);
    expect(document.documentElement.dataset.theme).toBe(DEFAULT_THEME_ID);
  });

  it('adopts a constructed stylesheet, so the CSP needs no inline style', () => {
    const replaced: string[] = [];
    class FakeSheet {
      replaceSync(css: string): void {
        replaced.push(css);
      }
    }
    const existing = new FakeSheet();
    const host = { adoptedStyleSheets: [existing] };
    adoptThemeSheet(host, FakeSheet);
    expect(host.adoptedStyleSheets).toHaveLength(2);
    expect(host.adoptedStyleSheets[1]).toBe(existing);
    expect(replaced).toEqual([themeCss()]);
  });

  it('loads the stored id, falling back to Default for unknown ids and storage errors', () => {
    const data: Record<string, string> = {};
    const storage = {
      getItem: (k: string) => data[k] ?? null,
      setItem: (k: string, v: string) => {
        data[k] = v;
      },
    };
    expect(loadThemeId(storage)).toBe(DEFAULT_THEME_ID);
    saveThemeId(storage, 'pixel');
    expect(data[THEME_STORAGE_KEY]).toBe('pixel');
    expect(loadThemeId(storage)).toBe('pixel');
    data[THEME_STORAGE_KEY] = 'gone';
    expect(loadThemeId(storage)).toBe(DEFAULT_THEME_ID);
    const broken = {
      getItem: (): string | null => {
        throw new Error('denied');
      },
      setItem: (): void => {
        throw new Error('denied');
      },
    };
    expect(loadThemeId(broken)).toBe(DEFAULT_THEME_ID);
    expect(() => saveThemeId(broken, 'pixel')).not.toThrow();
    expect(loadThemeId(null)).toBe(DEFAULT_THEME_ID);
  });
});
