import { accessCertsUrl, createCachedJwks } from './auth';
import type { JwksSource } from './auth';
import { createApp } from './app';
import type { Env } from './app';

// One JWKS cache per team domain, kept for the life of the isolate.
const jwksCache = new Map<string, JwksSource>();

function jwksFor(env: Env): JwksSource {
  const url = accessCertsUrl(env.ACCESS_TEAM_DOMAIN);
  let source = jwksCache.get(url);
  if (source === undefined) {
    source = createCachedJwks({ url });
    jwksCache.set(url, source);
  }
  return source;
}

const app = createApp({ jwks: jwksFor });

export default app satisfies ExportedHandler<Env>;
export type { Env };
