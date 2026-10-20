import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * Copies public/brand/ (logo, favicon) into the build. The rest of public/ stays out: it holds
 * the git-ignored data/ngrams.json, which must never end up in a build (see docs/DATA.md).
 */
function copyBrand(): Plugin {
  const dir = new URL('public/brand/', import.meta.url);
  return {
    name: 'crokychords-copy-brand',
    apply: 'build',
    generateBundle() {
      for (const name of readdirSync(dir)) {
        this.emitFile({
          type: 'asset',
          fileName: `brand/${name}`,
          source: readFileSync(new URL(name, dir)),
        });
      }
    },
  };
}

/** Files from public/ that do go into a build (see docs/specs/data-default-table.md). */
const SHIPPED_PUBLIC_FILES = ['data/default.json'];

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
  plugins: [copyBrand(), shipPublicFiles(SHIPPED_PUBLIC_FILES)],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173 },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // public/ is not copied as a whole: only brand/ (copyBrand) and SHIPPED_PUBLIC_FILES
    // (shipPublicFiles) go into a build, so a local full data/ngrams.json never ships.
    copyPublicDir: false,
  },
});
