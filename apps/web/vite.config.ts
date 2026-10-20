import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

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

export default defineConfig({
  root,
  plugins: [copyBrand()],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173 },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // public/ is not copied as a whole; see copyBrand() above.
    copyPublicDir: false,
  },
});
