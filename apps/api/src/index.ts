import { accessCertsUrl, createCachedJwks } from './auth';
import type { JwksSource } from './auth';
import { createApp } from './app';
import { runBackup, setIdFor } from './backup';
import type { Env } from './app';

// One JWKS cache per team domain, kept for the life of the isolate.
const jwksCache = new Map<string, JwksSource>();

function jwksFor(teamDomain: string): JwksSource {
  const url = accessCertsUrl(teamDomain);
  let source = jwksCache.get(url);
  if (source === undefined) {
    source = createCachedJwks({ url });
    jwksCache.set(url, source);
  }
  return source;
}

const app = createApp({ jwks: jwksFor });

export default {
  fetch: app.fetch,
  // Weekly backup and its continuations (wrangler.toml [triggers], docs/specs/backups-v1.md §2).
  async scheduled(controller, env) {
    // The set is named after the cron's date; the clock stays real for timings and leases.
    const result = await runBackup(env, { set: setIdFor(new Date(controller.scheduledTime)) });
    console.log('backup', result.set, result.status, result.phase);
  },
} satisfies ExportedHandler<Env>;
export type { Env };
