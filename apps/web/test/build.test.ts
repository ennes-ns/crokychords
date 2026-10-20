// @vitest-environment node
/** Production build: the allow-listed public files ship (theme fonts, brand mark), ngrams.json never. */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SHIPPED_PUBLIC_DIRS,
  SHIPPED_PUBLIC_FILES,
  SHIPPED_PUBLIC_TREES,
  listTree,
} from '../vite.config';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'crokychords-web-build-'));

beforeAll(async () => {
  await build({
    configFile: join(webRoot, 'vite.config.ts'),
    logLevel: 'silent',
    build: { outDir, emptyOutDir: true },
  });
}, 120_000);

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe('vite build', () => {
  it('ships the Pixel theme font, its licence and the toolbar mark', () => {
    for (const file of [
      'index.html',
      'fonts/DepartureMono-Regular.woff2',
      'fonts/DepartureMono-OFL.txt',
      'brand/croky-mark.svg',
    ]) {
      expect(existsSync(join(outDir, file)), file).toBe(true);
    }
  });

  it('ships every file of the shipped public directories and the allow-listed files', () => {
    for (const dir of SHIPPED_PUBLIC_DIRS) {
      for (const file of readdirSync(join(webRoot, 'public', dir))) {
        expect(existsSync(join(outDir, dir, file)), `${dir}/${file}`).toBe(true);
      }
    }
    for (const file of SHIPPED_PUBLIC_FILES) {
      expect(existsSync(join(outDir, file)), file).toBe(true);
    }
  });

  it('ships the fetched SoundFont samples and their licence when present', () => {
    for (const tree of SHIPPED_PUBLIC_TREES) {
      const dir = join(webRoot, 'public', tree);
      if (!existsSync(dir)) continue;
      const files = listTree(dir);
      expect(files).toContain('LICENSE.txt');
      expect(files).toContain('NOTICE.txt');
      expect(files).toContain('acoustic_grand_piano/C4.ogg');
      for (const file of files) expect(existsSync(join(outDir, tree, file)), file).toBe(true);
    }
  });

  it('never ships the full n-gram table', () => {
    expect(existsSync(join(outDir, 'data/ngrams.json'))).toBe(false);
  });
});
