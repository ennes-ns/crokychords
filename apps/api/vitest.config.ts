import path from 'node:path';
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  return {
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
      poolOptions: {
        workers: {
          singleWorker: true,
          // The Workers AI binding (moderation, docs/specs/moderation-v1.md §3.1) is always remote;
          // tests inject a fake model instead, so no remote session (and no Cloudflare login) is needed.
          remoteBindings: false,
          wrangler: { configPath: './wrangler.toml' },
          miniflare: {
            // Stand-in for ../web/dist, so the tests run without building the web app first.
            assets: { directory: path.join(import.meta.dirname, 'test', 'assets') },
            bindings: {
              TEST_MIGRATIONS: migrations,
              ACCESS_TEAM_DOMAIN: 'test-team.cloudflareaccess.com',
              ACCESS_AUD: 'test-audience',
              ALLOWED_ORIGIN: 'https://app.example.test',
            },
          },
        },
      },
    },
  };
});
