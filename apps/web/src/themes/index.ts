/**
 * Theme registry: the themes in switcher order, the CSS they generate, and applying and
 * persisting the choice (docs/specs/themes-v1.md). To add a theme, add its file to THEMES.
 */
import { defaultTheme } from './default';
import { pixelTheme } from './pixel';
import type { Theme } from './tokens';
import { TOKEN_NAMES } from './tokens';

export type { Theme, ThemeFont, TokenName } from './tokens';
export { COLOUR_TOKENS, TOKEN_NAMES } from './tokens';

export const THEMES: readonly Theme[] = [defaultTheme, pixelTheme];
export const DEFAULT_THEME_ID = defaultTheme.id;
export const THEME_STORAGE_KEY = 'crokychords.theme';
export const THEME_STYLE_ID = 'themes';
/** Where bundled fonts are served from (apps/web/public/fonts). */
export const FONT_BASE = '/fonts/';

export type ThemeStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function themeById(id: string | null | undefined): Theme | undefined {
  return THEMES.find((t) => t.id === id);
}

/** One rule per theme (Default also on plain :root) plus an @font-face per bundled font. */
export function themeCss(themes: readonly Theme[] = THEMES): string {
  const parts: string[] = [];
  for (const theme of themes) {
    for (const font of theme.fonts ?? []) {
      parts.push(
        `@font-face {\n  font-family: '${font.family}';\n  src: url('${FONT_BASE}${font.file}') format('woff2');\n` +
          `  font-weight: ${font.weight};\n  font-style: normal;\n  font-display: swap;\n}`,
      );
    }
  }
  for (const theme of themes) {
    const selector =
      theme.id === DEFAULT_THEME_ID
        ? `:root,\n:root[data-theme='${theme.id}']`
        : `:root[data-theme='${theme.id}']`;
    const body = TOKEN_NAMES.map((name) => `  ${name}: ${theme.tokens[name]};`).join('\n');
    parts.push(`${selector} {\n${body}\n}`);
  }
  return parts.join('\n\n') + '\n';
}

/** Inject the theme stylesheet once (before the app's own styles take effect). */
export function installThemes(doc: Document = document): void {
  if (doc.getElementById(THEME_STYLE_ID) !== null) return;
  const style = doc.createElement('style');
  style.id = THEME_STYLE_ID;
  style.textContent = themeCss();
  doc.head.prepend(style);
}

/** Activate a theme; an unknown id activates Default. Returns the id that is active. */
export function applyTheme(id: string | null, doc: Document = document): string {
  const theme = themeById(id) ?? defaultTheme;
  doc.documentElement.dataset.theme = theme.id;
  return theme.id;
}

/** The stored theme id, or Default when none (or an unknown one) is stored. */
export function loadThemeId(storage: ThemeStorage | null): string {
  let id: string | null = null;
  try {
    id = storage?.getItem(THEME_STORAGE_KEY) ?? null;
  } catch {
    id = null;
  }
  return themeById(id)?.id ?? DEFAULT_THEME_ID;
}

export function saveThemeId(storage: ThemeStorage | null, id: string): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, id);
  } catch {
    // A preference only: the theme falls back to Default next time.
  }
}
