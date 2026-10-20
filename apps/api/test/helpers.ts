import { createSong } from '@crokychords/core';
import type { Song } from '@crokychords/core';
import { env } from 'cloudflare:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { CryptoKey, JWK, JWTPayload } from 'jose';
import { createApp } from '../src/app';
import type { JwksSource } from '../src/auth';

export const TEAM_DOMAIN = 'test-team.cloudflareaccess.com';
export const ISSUER = `https://${TEAM_DOMAIN}`;
export const AUDIENCE = 'test-audience';
export const ORIGIN = 'https://app.example.test';

export interface TestKey {
  kid: string;
  privateKey: CryptoKey;
  jwk: JWK;
}

/** A fresh RS256 key pair generated for the test run (never a real key). */
export async function makeKey(kid: string): Promise<TestKey> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { kid, privateKey, jwk };
}

export function staticJwks(keys: JWK[]): JwksSource {
  return { getKeys: () => Promise.resolve(keys) };
}

export interface TokenOptions {
  key: TestKey;
  email?: string | undefined;
  audience?: string;
  issuer?: string;
  /** Expiry in seconds from now (negative = expired). */
  expiresIn?: number;
  omitExp?: boolean;
  extra?: JWTPayload;
}

export async function signToken(options: TokenOptions): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: JWTPayload = { ...options.extra };
  if (options.email !== undefined) payload['email'] = options.email;
  let jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: options.key.kid })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt(now - 10)
    .setSubject('test-subject');
  if (options.omitExp !== true) jwt = jwt.setExpirationTime(now + (options.expiresIn ?? 300));
  return jwt.sign(options.key.privateKey);
}

export function testSong(title = 'Test song'): Song {
  return createSong({
    title,
    chords: [
      { token: 'I', beats: 4 },
      { token: 'V', beats: 4 },
      { token: 'vi', beats: 4 },
      { token: 'IV', beats: 4 },
    ],
  });
}

export function record(id: string, version: number, title = 'My save'): Record<string, unknown> {
  return {
    schema_version: 1,
    id,
    version,
    updated_at: '2000-01-01T00:00:00.000Z',
    title,
    song: testSong(title),
  };
}

/** An app wired to the test bindings and a JWKS holding `keys`. */
export function testClient(keys: JWK[]) {
  const app = createApp({ jwks: () => staticJwks(keys) });
  return {
    request(path: string, init: RequestInit = {}): Promise<Response> {
      return Promise.resolve(app.request(`https://api.example.test${path}`, init, env));
    },
  };
}

export function authed(token: string, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set('Cf-Access-Jwt-Assertion', token);
  return { ...init, headers };
}

export function putInit(token: string, body: unknown, ifMatch?: string): RequestInit {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ifMatch !== undefined) headers['If-Match'] = ifMatch;
  return authed(token, { method: 'PUT', headers, body: JSON.stringify(body) });
}

export interface ErrorJson {
  error: { code: string; message: string; current?: unknown };
}
