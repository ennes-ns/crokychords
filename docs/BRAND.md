# Brand: Croky

Croky is the owner's parrot, a green-cheeked conure (*Pyrrhura molinae*). Every Croky project
(CrokyCraft, croky-horizon, Croky Chords, …) uses the same mascot and palette. The reference art
is the CrokyCraft server icon (`crokycraft-website/data/server-icon.png`, 64×64 pixel art). The
vector art in this repo is a **trace of that original** (owner's own artwork), produced with the
scripts in `tools/brand/`.

## Files (`apps/web/public/brand/`)

| File | Use |
|------|-----|
| `croky-art.svg` | The traced Croky alone, 64×64 viewBox, smooth silhouette + detailed interior. Source for everything below. |
| `croky-mark.svg` | Logomark: the art on a dark disc with a green ring, 256×256 viewBox. App toolbar, README, avatars. |
| `favicon.svg` | Same without the ring; referenced from `index.html`. |
| `croky-wordmark.svg` | Mark + "Croky Chords" + tagline, 980×256. README header, docs. |
| `croky-pixel.svg` | Pixel-perfect vector of the 64×64 original (`shape-rendering: crispEdges`). Retro/pixel contexts, CrokyCraft-style pages. |

### How the art was made (reproducible)

```bash
# 1. pixel-art upscale (scale2x-like), 64 -> 512 px
convert server-icon.png -magnify -magnify -magnify croky-mag8.png
# 2. quantize to ~11 colours, upscale 2x, blur each colour mask, majority-filter, trace contours
uv run --with pillow --with numpy tools/brand/trace_pixel_art.py croky-mag8.png pixel.svg interior.svg 11 2 2.0 8 3 0.55 3
# 3. smooth outer silhouette from the blurred alpha mask, clip the interior into it
uv run --with pillow --with numpy tools/brand/compose_silhouette.py croky-mag8.png interior.svg croky-art.svg 9 4 6 0
# pixel-perfect variant straight from the 64 px original
uv run --with pillow --with numpy tools/brand/trace_pixel_art.py server-icon.png croky-pixel.svg _.svg 14 8 3
```

The traced files are ~320 KB each because the interior keeps every colour region; that is fine
for a logo and a favicon but do not inline them into HTML. A hand-simplified version is welcome
as long as it is traced over `croky-art.svg`, not drawn from imagination.

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

## Anatomy (so edits stay on-model)

Three-quarter view facing right, slightly chubby. Dark brown crown and nape, green cheeks, white
eye ring with a dark eye and highlight, dark hooked beak with a light tip, scalloped cream chest,
yellow→orange→red belly, olive-green wings with darker feather edges, maroon-red tail pointing
down-left, pinkish-brown feet. Thick dark outline. That is Croky; a crocodile is not.
