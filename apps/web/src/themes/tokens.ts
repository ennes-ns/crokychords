/** The design tokens every theme defines (docs/specs/themes-v1.md, "Tokens"). */

export const TOKEN_NAMES = [
  // Surface
  '--color-scheme',
  '--bg',
  '--panel',
  '--panel-2',
  '--row-selected',
  '--line',
  '--line-strong',
  '--rest-a',
  '--rest-b',
  '--melody-chord-tone',
  '--melody-chord-root',
  // Text
  '--text',
  '--muted',
  '--accent',
  '--on-accent',
  '--brand-accent',
  '--danger',
  '--ok',
  // Degree hue: saturation/lightness pairs, used as hsl(var(--hue) var(--token))
  '--chord-fill',
  '--chord-hover',
  '--chord-edge',
  '--chord-selected',
  '--chord-ring',
  '--chord-ink',
  '--suggestion-edge',
  '--suggestion-hover',
  '--suggestion-bar',
  // Type
  '--font-ui',
  '--font-display',
  '--font-size',
  '--font-size-xs',
  '--font-size-sm',
  '--font-size-h',
  '--font-size-lg',
  '--font-size-xl',
  '--line-height',
  '--weight-bold',
  '--weight-semibold',
  '--heading-tracking',
  '--brand-tracking',
  '--brand-size',
  // Shape
  '--radius',
  '--radius-panel',
  '--radius-pill',
  '--radius-bar',
  '--border-w',
  '--chord-border-w',
  '--grid-line-w',
  '--tick-style',
  '--row-marker-w',
  '--suggestion-marker-w',
  '--focus-w',
  '--chord-clip',
  // Effects
  '--control-shadow',
  '--chord-glow-w',
  '--chord-playing-filter',
  '--playhead-w',
  '--playhead-glow',
  '--overlay-shadow',
  '--motion-fast',
  '--motion',
  '--motion-easing',
  // Mark
  '--mark-size',
  '--mark-radius',
  '--mark-image',
  '--mark-rendering',
  // Spacing
  '--space-workspace',
  '--space-panel',
  '--toolbar-pad',
  '--control-pad',
  '--control-height',
] as const;

export type TokenName = (typeof TOKEN_NAMES)[number];

/** Tokens whose value is a hex colour (checked for contrast in the tests). */
export const COLOUR_TOKENS = [
  '--bg',
  '--panel',
  '--panel-2',
  '--row-selected',
  '--line',
  '--line-strong',
  '--rest-a',
  '--rest-b',
  '--text',
  '--muted',
  '--accent',
  '--on-accent',
  '--brand-accent',
  '--danger',
  '--ok',
] as const satisfies readonly TokenName[];

/** A bundled web font: `apps/web/public/fonts/<file>`, with its licence file next to it. */
export interface ThemeFont {
  family: string;
  file: string;
  /** CSS font-weight descriptor, e.g. '400' or '400 700' for a variable font. */
  weight: string;
  licence: string;
}

export interface Theme {
  /** [a-z0-9-]+; stored in localStorage and used as the data-theme value. */
  id: string;
  /** Shown in the toolbar switcher. */
  label: string;
  tokens: Record<TokenName, string>;
  fonts?: readonly ThemeFont[];
}
