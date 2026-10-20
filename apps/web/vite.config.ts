import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * Directories of public/ that go into a build as a whole: brand/ (logo, favicon, the toolbar mark),
 * fonts/ (the bundled theme fonts with their licence files) and samples/ (the CC0 Breakcore break
 * and its source note, docs/DATA.md "Samples"). The rest of public/ stays out: it
 * holds the git-ignored data/ngrams.json, which must never end up in a build (see docs/DATA.md).
 */
export const SHIPPED_PUBLIC_DIRS = ['brand', 'fonts', 'samples'] as const;

/** Emit every file of the given public/ directories, keeping their paths. */
function shipPublicDirs(dirs: readonly string[]): Plugin {
  return {
    name: 'crokychords:ship-public-dirs',
    apply: 'build',
    generateBundle() {
      for (const name of dirs) {
        const dir = new URL(`public/${name}/`, import.meta.url);
        for (const file of readdirSync(dir)) {
          this.emitFile({
            type: 'asset',
            fileName: `${name}/${file}`,
            source: readFileSync(new URL(file, dir)),
          });
        }
      }
    },
  };
}

/** Files from public/ that do go into a build (see docs/specs/data-default-table.md). */
export const SHIPPED_PUBLIC_FILES = ['data/default.json', '_headers'] as const;

/** Emit only the allow-listed public files, so a local full ngrams.json never ships. */
function shipPublicFiles(files: readonly string[]): Plugin {
  return {
    name: 'crokychords:ship-public-files',
    apply: 'build',
    generateBundle() {
      for (const fileName of files) {
        const source = readFileSync(new URL(`public/${fileName}`, import.meta.url));
        this.emitFile({ type: 'asset', fileName, source });
      }
    },
  };
}

export default defineConfig({
  root,
  plugins: [shipPublicDirs(SHIPPED_PUBLIC_DIRS), shipPublicFiles(SHIPPED_PUBLIC_FILES)],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173 },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // public/ is not copied as a whole: only SHIPPED_PUBLIC_DIRS (shipPublicDirs) and
    // SHIPPED_PUBLIC_FILES (shipPublicFiles) go into a build, so a local full data/ngrams.json never ships.
    copyPublicDir: false,
  },
});
