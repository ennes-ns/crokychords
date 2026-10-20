import { decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import type { JWK, JWTPayload } from 'jose';

/** Header in which Cloudflare Access forwards the signed identity of the user. */
export const ACCESS_JWT_HEADER = 'Cf-Access-Jwt-Assertion';

/** A source of public keys (the Access JWKS). Injectable so tests can use their own keys. */
export interface JwksSource {
  /** The current key set; `refresh` asks for a fresh copy (the source may rate-limit that). */
  getKeys(refresh: boolean): Promise<JWK[]>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CachedJwksOptions {
  url: string;
  fetch?: FetchLike;
  /** How long a fetched key set is used without asking again. Default 10 minutes. */
  ttlMs?: number;
  /** Minimum time between two fetches triggered by an unknown key id. Default 30 seconds. */
  refreshCooldownMs?: number;
  now?: () => number;
}

/** Remote JWKS with an in-memory cache. One instance is meant to live as long as the isolate. */
export function createCachedJwks(options: CachedJwksOptions): JwksSource {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const ttl = options.ttlMs ?? 10 * 60 * 1000;
  const cooldown = options.refreshCooldownMs ?? 30 * 1000;
  const now = options.now ?? Date.now;
  let keys: JWK[] | undefined;
  let lastAttempt = Number.NEGATIVE_INFINITY;
  let fetchedAt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<JWK[]> | undefined;

  async function load(): Promise<JWK[]> {
    lastAttempt = now();
    const res = await doFetch(options.url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`JWKS fetch failed with status ${res.status}`);
    const body: unknown = await res.json();
    const list = isRecord(body) && Array.isArray(body['keys']) ? body['keys'] : undefined;
    if (list === undefined) throw new Error('JWKS response has no keys array');
    const parsed: JWK[] = list.filter(isRecord);
    keys = parsed;
    fetchedAt = now();
    return parsed;
  }

  return {
    async getKeys(refresh) {
      const t = now();
      if (keys !== undefined) {
        const stale = t - fetchedAt >= ttl;
        const mayFetch = t - lastAttempt >= cooldown;
        // Within the TTL, or rate-limited after a recent attempt: serve the cached set.
        if ((!stale && !refresh) || !mayFetch) return keys;
      }
      inflight ??= load().finally(() => {
        inflight = undefined;
      });
      try {
        return await inflight;
      } catch (e) {
        // Keep serving the last good key set when a refresh fails.
        if (keys !== undefined) return keys;
        throw e;
      }
    },
  };
}

export interface AccessConfig {
  /** `<team>.cloudflareaccess.com`, with or without `https://`. */
  teamDomain: string;
  audience: string;
}

/** Issuer of Access tokens for a team domain: `https://<team>.cloudflareaccess.com`. */
export function accessIssuer(teamDomain: string): string {
  const host = teamDomain
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  return `https://${host}`;
}

export function accessCertsUrl(teamDomain: string): string {
  return `${accessIssuer(teamDomain)}/cdn-cgi/access/certs`;
}

export interface AccessIdentity {
  email: string;
  claims: JWTPayload;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Verify an Access JWT: RS256 signature against the JWKS, issuer, audience and expiry, and a
 * non-empty `email` claim. Throws AuthError for every kind of invalid token.
 */
export async function verifyAccessJwt(
  token: string,
  config: AccessConfig,
  jwks: JwksSource,
  now?: Date,
): Promise<AccessIdentity> {
  let kid: string | undefined;
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg !== 'RS256') throw new AuthError(`unsupported alg ${String(header.alg)}`);
    kid = header.kid;
  } catch (e) {
    if (e instanceof AuthError) throw e;
    throw new AuthError('malformed token');
  }

  const jwk = await findKey(jwks, kid);
  let payload: JWTPayload;
  try {
    const key = await importJWK({ ...jwk, alg: 'RS256' }, 'RS256');
    const result = await jwtVerify(token, key, {
      algorithms: ['RS256'],
      issuer: accessIssuer(config.teamDomain),
      audience: config.audience,
      requiredClaims: ['exp'],
      ...(now === undefined ? {} : { currentDate: now }),
    });
    payload = result.payload;
  } catch (e) {
    throw new AuthError(e instanceof Error ? e.message : 'verification failed');
  }

  const email = payload['email'];
  if (typeof email !== 'string' || email.trim() === '') throw new AuthError('no email claim');
  return { email: email.trim().toLowerCase(), claims: payload };
}

async function findKey(jwks: JwksSource, kid: string | undefined): Promise<JWK> {
  const pick = (keys: JWK[]): JWK | undefined => {
    const rsa = keys.filter((k) => k.kty === 'RSA' && (k.use === undefined || k.use === 'sig'));
    if (kid !== undefined) return rsa.find((k) => k.kid === kid);
    return rsa.length === 1 ? rsa[0] : undefined;
  };
  let keys: JWK[];
  try {
    keys = await jwks.getKeys(false);
    const found = pick(keys);
    if (found !== undefined) return found;
    keys = await jwks.getKeys(true);
  } catch {
    throw new AuthError('JWKS unavailable');
  }
  const found = pick(keys);
  if (found === undefined) throw new AuthError('unknown key id');
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
