import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
    // test/themes.test.ts reads styles.css as text to check it only uses theme tokens.
    css: { include: [/styles\.css/] },
  },
});
