# Spec: themes (v1) — Default and Pixel

Status: **implemented** (issue #23). Builds on `web-v1.md`; the palette and the banner come from
`docs/BRAND.md`.

## Goal

The editor's look is a set of design tokens (CSS custom properties). A theme is one file that gives
every token a value. Two themes ship:

- **Default**: today's look, pixel for pixel.
- **Pixel**: the look of the README banner (`docs/readme/banner.png`, `tools/brand/concept_b.py`):
  bitmap typography, square corners, chunky 2 px borders, flat fills in the brand palette, crisp
  1 px grid lines, no blur or soft shadows, the pixel-art Croky with nearest-neighbour rendering.

The DOM does not change between themes; a theme is CSS values only, plus the switcher in the
toolbar.

## Tokens

`apps/web/src/themes/tokens.ts` holds the one list of token names (`TOKEN_NAMES`, type
`TokenName`). `apps/web/src/styles.css` uses only these tokens for colours, radii, borders, fonts,
font sizes, effects and the main spacing; it defines none of them itself.

| Group      | Tokens                                                                                                                                                                                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Surface    | `--color-scheme`, `--bg`, `--panel`, `--panel-2`, `--row-selected`, `--line`, `--line-strong`, `--rest-a`, `--rest-b`, `--melody-chord-tone`, `--melody-chord-root`                                                                                                                                                    |
| Text       | `--text`, `--muted`, `--accent`, `--on-accent`, `--brand-accent`, `--danger`, `--ok`                                                                                                                                                                                     |
| Degree hue | `--chord-fill`, `--chord-hover`, `--chord-edge`, `--chord-selected`, `--chord-ring`, `--chord-ink`, `--suggestion-edge`, `--suggestion-hover`, `--suggestion-bar`                                                                                                        |
| Type       | `--font-ui`, `--font-display`, `--font-size`, `--font-size-xs`, `--font-size-sm`, `--font-size-h`, `--font-size-lg`, `--font-size-xl`, `--line-height`, `--weight-bold`, `--weight-semibold`, `--heading-tracking`, `--brand-tracking`, `--brand-size`                                                    |
| Shape      | `--radius`, `--radius-panel`, `--radius-pill`, `--radius-bar`, `--border-w`, `--chord-border-w`, `--grid-line-w`, `--tick-style`, `--row-marker-w`, `--suggestion-marker-w`, `--focus-w`, `--chord-clip`                                                                  |
| Effects    | `--control-shadow`, `--chord-glow-w`, `--chord-playing-filter`, `--playhead-w`, `--playhead-glow`, `--overlay-shadow`, `--motion-fast`, `--motion`, `--motion-easing`                                                                                                    |
| Mark       | `--mark-size`, `--mark-radius`, `--mark-image`, `--mark-rendering`                                                                                                                                                                                                       |
| Spacing    | `--space-workspace`, `--space-panel`, `--toolbar-pad`, `--control-pad`, `--control-height`                                                                                                                                                                               |

Degree-hue tokens are a saturation/lightness pair (`45% 26%`), used as
`hsl(var(--hue) var(--chord-fill))`: every chord block keeps its degree hue (`DEGREE_HUES` in
`music.ts`), the theme sets how saturated and how light it is. Colour tokens are hex colours, so a
test can check their contrast. The melody lane's chord-tone tints (`--melody-chord-tone`,
`--melody-chord-root`, `melody-v1.md` §B4) are hex too, but may carry alpha (`#rrggbbaa`), so
they are not in the contrast list.

Spacing: the layout spacing (workspace gap and padding, panel padding, toolbar padding, control
padding and height) is tokenised; the 1–6 px offsets inside single components (label gaps, a
badge's padding) stay literal, because they are geometry, not style, and a theme that wants other
offsets wants other CSS.

## Theme file format

One TypeScript module per theme in `apps/web/src/themes/` exporting a `Theme`:

```ts
export const pixelTheme: Theme = {
  id: 'pixel', // [a-z0-9-]+, stored in localStorage
  label: 'Pixel', // shown in the switcher
  tokens: { '--bg': '#121212' /* … every TokenName, the compiler enforces the full set … */ },
  fonts: [{ family: 'Departure Mono', file: 'DepartureMono-Regular.woff2', weight: '400', licence: 'DepartureMono-OFL.txt' }],
};
```

`themes/index.ts` is the registry (`THEMES`, in switcher order, Default first). It turns every
theme into one rule, `:root[data-theme='<id>'] { … }` (Default also gets plain `:root`, so the app
renders as Default before a theme is applied), plus an `@font-face` per font, and installs the
result before the app mounts as one constructed stylesheet (`document.adoptedStyleSheets`), which
the CSP `style-src 'self'` allows; an inline `<style>` would be blocked (`public/_headers`). The
`<style id="themes">` fallback only runs where constructable stylesheets are missing (jsdom).

**Adding a theme** (for example a light one): add `themes/light.ts` with every token and add it to
`THEMES`. Nothing else changes; the switcher, persistence and the token test pick it up.

## Fonts

Fonts are bundled, never loaded from a CDN: `apps/web/public/fonts/<file>` next to its licence
file. A face is declared in the theme's `fonts` and only downloaded when the theme is active.
Pixel uses one font, **Departure Mono** (SIL Open Font License 1.1), for both `--font-ui` and
`--font-display` (wordmark and panel headings): a pixel monospace drawn on an 11 px grid, so it is
crisp at 11 and 22 px. Its letters and digits are unambiguous (`C` vs `O`, `5` vs `S`), which
matters for the wordmark and for chord tokens such as `b5` and `#5`. Bold is synthesised. A pixel
sans with a closer match to the banner wordmark (Pixelify Sans) was tried and dropped: at UI sizes
its `C` reads as `O` and its `5` as `S`. `--font-display` stays a separate token so a later theme
can use a display face.

Glyphs a font lacks (▾ ▶ ▲ ▼ ♮) fall back to the next family in the stack.

## Switching and persistence

- A `<select aria-label="Theme">` at the end of the toolbar lists `THEMES` by label.
- Changing it sets `data-theme` on `<html>` and stores the id in `localStorage` under
  `crokychords.theme`. On boot the stored id is applied before the first render; a missing or
  unknown id (a removed theme) falls back to Default. Storage errors are ignored (the theme is a
  preference).
- The theme is not part of the song, the Store or the undo history.
- Motion: theme transitions use `--motion`/`--motion-fast`; under `prefers-reduced-motion: reduce`
  transitions are off whatever the theme.

## How the Pixel theme is built

| Element        | Pixel                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Background     | `#121212` (the banner background), panels `#1a1a1a` / `#242424`, lines neutral greys                                         |
| Text           | cream `#f6ecd6` (the chest colour), muted `#b4aa96`; every text/background pair ≥ 4.5:1 (tested)                             |
| Accent         | Pyrrhura yellow `#f1c40f` for the one thing to click (Play, active tab), green `#2ecc71` for "Croky", red for errors          |
| Chord blocks   | the banner's degree colours: fill `hsl(hue 45% 26%)`, 3 px edge `hsl(hue 45% 38%)`, numerals `hsl(hue 30% 85%)`; corners notched one step like the banner blocks (`clip-path`) |
| Shapes         | radius 0 everywhere, 2 px borders, a hard 2 px bevel on controls instead of soft shadows                                     |
| Grid           | bar and beat lines solid 1 px (no dashes), so the grid reads as pixels                                                      |
| Effects        | no glow on the playhead or selection, hard offset shadow on the audio overlay, transitions in `steps()`                     |
| Mark           | `croky-mark.svg` (the pixel mark from the 32 px master, see `docs/BRAND.md`) at 32 px, square, `image-rendering: pixelated` |
| Type           | Departure Mono: 13 px for the UI, 11 px for small labels and panel headings, 22 px for the wordmark                         |

The mark swaps image through `content: var(--mark-image)` on the existing `<img>` (Default:
`normal`, the `src` stays), so the DOM is the same in both themes.

## Tests

- `test/themes.test.ts`: every theme defines exactly the token list with non-empty values; ids are
  unique; the generated CSS has one rule per theme and only local font URLs; every bundled font
  file and its licence exist under `public/fonts/`; `styles.css` has no hard-coded colour and uses
  only tokens (plus `--hue`); Pixel text tokens meet 4.5:1 against every surface.
- `test/toolbar.test.ts`: the switcher lists every theme, applies the stored theme on mount,
  switching sets `data-theme` and writes `localStorage`, an unknown stored id falls back to
  Default.
- Screenshots: Default before and after are compared pixel for pixel (headless Chromium, the
  README progression, theme switcher hidden for the comparison); both themes are in the PR.
