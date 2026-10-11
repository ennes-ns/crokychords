# Brand: Croky

Croky is the owner's parrot, a green-cheeked conure (*Pyrrhura molinae*). Every Croky project
(CrokyCraft, croky-horizon, Croky Chords, …) uses the same mascot and palette. The reference art
is the CrokyCraft server icon (`crokycraft-website/data/server-icon.png`, 64×64 pixel art); the
vector mark in this repo is an original drawing based on it, not a trace of any third-party image.

## Files (`apps/web/public/brand/`)

| File | Use |
|------|-----|
| `croky-mark.svg` | Logomark, 256×256 viewBox on a dark disc. App toolbar, README, social avatars. |
| `favicon.svg` | Same art without the inner ring; referenced from `index.html`. |
| `croky-wordmark.svg` | Mark + "Croky Chords" + tagline, 980×256. README header, docs. |

Export PNGs when a raster is needed (`node scratch/render-svg.cjs <svg> <png> <size>` in a
session, or any SVG renderer); do not commit PNGs larger than needed.

## Palette (the "Pyrrhura" palette from `crokycraft-website/www/css/base.css`)

| Token | Hex | Where it comes from / use |
|-------|-----|---------------------------|
| `--py-green` | `#2ecc71` | cheeks and wings; primary accent, "Croky" in the wordmark |
| `--py-red` | `#e74c3c` | tail and lower belly; destructive actions, errors |
| `--py-yellow` | `#f1c40f` | upper belly; highlights, the music-note accent, Play button |
| `--py-blue` | `#3498db` | flight feathers; links, secondary accent, taglines |
| crown | `#3b2a26` | dark brown crown; avoid for UI, art only |
| chest | `#f6ecd6` → `#d8c19c` | scalloped cream chest; light text on dark backgrounds (`#f6ecd6`) |
| `--bg-dark` | `#121212` | background disc and app background |
| outline | `#1a1a1a` | 4–5 px outlines in the art, pixel-art heritage |

Rules of thumb: dark UI by default; green is *the* brand colour, yellow is for the one thing you
want clicked, red only for warnings. Keep outlines thick and shapes chunky (the pixel-art
origin). Text: a heavy geometric sans (Avenir Next / Segoe UI / Inter, weight 800) for the
wordmark, system UI font for the app.

## Anatomy of the mark (so edits stay on-model)

Profile facing right. Dark brown crown, green cheeks with a grey ear patch, white eye ring with a
black eye, dark hooked beak, scalloped cream chest (wavy lines), yellow→orange→red belly low on
the body, layered green wing feathers with blue tips, long maroon-red tail pointing down-left,
grey-brown feet. A yellow eighth note floats top-left. That is Croky; a crocodile is not.
