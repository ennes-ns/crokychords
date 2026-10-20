import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

/**
 * Directory trees of public/ that go into a build, recursively, when they exist: soundfonts/
 * (the SoundFont samples with their licence, fetched by tools/soundfonts/fetch.mjs and
 * git-ignored; docs/specs/soundfonts-v1.md §4). Without them the app plays its synth stand-ins.
 */
export const SHIPPED_PUBLIC_TREES = ['soundfonts'] as const;

/** Every file under `dir` (recursively), as paths relative to it. */
export function listTree(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listTree(`${dir}/${entry.name}`).map((f) => `${entry.name}/${f}`)
      : [entry.name],
  );
}

/** Emit every file of the given public/ trees that exist, keeping their paths. */
function shipPublicTrees(trees: readonly string[]): Plugin {
  return {
    name: 'crokychords:ship-public-trees',
    apply: 'build',
    generateBundle() {
      for (const name of trees) {
        const dir = fileURLToPath(new URL(`public/${name}`, import.meta.url));
        if (!existsSync(dir)) {
          this.warn(`public/${name} is missing; run node tools/soundfonts/fetch.mjs`);
          continue;
        }
        for (const file of listTree(dir)) {
          this.emitFile({
            type: 'asset',
            fileName: `${name}/${file}`,
            source: readFileSync(`${dir}/${file}`),
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
  plugins: [
    shipPublicDirs(SHIPPED_PUBLIC_DIRS),
    shipPublicTrees(SHIPPED_PUBLIC_TREES),
    shipPublicFiles(SHIPPED_PUBLIC_FILES),
  ],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173 },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // public/ is not copied as a whole: only SHIPPED_PUBLIC_DIRS (shipPublicDirs),
    // SHIPPED_PUBLIC_TREES (shipPublicTrees) and SHIPPED_PUBLIC_FILES (shipPublicFiles) go into a
    // build, so a local full data/ngrams.json never ships.
    copyPublicDir: false,
    // Two pages: the app and the maintainer's review queue (docs/specs/community-v1.md §4.5).
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        review: fileURLToPath(new URL('review.html', import.meta.url)),
      },
    },
  },
});
