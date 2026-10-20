// Render docs/readme/banner.svg to banner.png at 2x with rsvg-convert, inlining the logomark
// from apps/web/public/brand/croky-mark.svg at the "<!-- @mark -->" placeholder (librsvg does
// not load external files from a parent directory). Run from the repository root:
//   node docs/readme/render-banner.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const banner = readFileSync('docs/readme/banner.svg', 'utf8');
const mark = readFileSync('apps/web/public/brand/croky-mark.svg', 'utf8');
// Keep the mark's inner content; the banner provides its own <svg> root and placement.
const inner = mark.replace(/^\s*<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
if (!banner.includes('<!-- @mark -->'))
  throw new Error('banner.svg has no <!-- @mark --> placeholder');
const svg = banner.replace('<!-- @mark -->', inner);

execFileSync('rsvg-convert', ['-z', '2', '-o', 'docs/readme/banner.png', '-'], { input: svg });
