import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: { port: 5173, strictPort: true },
  preview: { port: 4173 },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // public/ only holds the git-ignored data/ngrams.json, which the dev server serves but
    // must never end up in a build (Hooktheory data is personal-use only, see docs/DATA.md).
    copyPublicDir: false,
  },
});
