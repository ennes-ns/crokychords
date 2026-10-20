import { SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AuthError,
  accessCertsUrl,
  accessIssuer,
  createCachedJwks,
  verifyAccessJwt,
} from '../src/auth';
import type { FetchLike } from '../src/auth';
import { AUDIENCE, ISSUER, TEAM_DOMAIN, makeKey, signToken, staticJwks } from './helpers';
import type { TestKey } from './helpers';

const config = { teamDomain: TEAM_DOMAIN, audience: AUDIENCE };
let key: TestKey;
let other: TestKey;

beforeAll(async () => {
  key = await makeKey('key-1');
  other = await makeKey('key-2');
});

describe('accessIssuer / accessCertsUrl', () => {
  it('normalises the team domain', () => {
    expect(accessIssuer('team.cloudflareaccess.com')).toBe('https://team.cloudflareaccess.com');
    expect(accessIssuer('https://team.cloudflareaccess.com/')).toBe(
      'https://team.cloudflareaccess.com',
    );
    expect(accessCertsUrl(' team.cloudflareaccess.com ')).toBe(
      'https://team.cloudflareaccess.com/cdn-cgi/access/certs',
    );
  });
});

describe('verifyAccessJwt', () => {
  it('accepts a valid token and lower-cases the e-mail', async () => {
    const token = await signToken({ key, email: 'Player@Example.Test' });
    const identity = await verifyAccessJwt(token, config, staticJwks([key.jwk]));
    expect(identity.email).toBe('player@example.test');
    expect(identity.claims.iss).toBe(ISSUER);
  });

  it('accepts an audience array that contains the audience', async () => {
    const token = await new SignJWT({ email: 'a@example.test' })
      .setProtectedHeader({ alg: 'RS256', kid: key.kid })
      .setIssuer(ISSUER)
      .setAudience(['other', AUDIENCE])
      .setExpirationTime('5m')
      .sign(key.privateKey);
    await expect(verifyAccessJwt(token, config, staticJwks([key.jwk]))).resolves.toBeDefined();
  });

  it.each([
    ['wrong audience', { audience: 'someone-else' }],
    ['wrong issuer', { issuer: 'https://evil.cloudflareaccess.com' }],
    ['expired token', { expiresIn: -60 }],
    ['no exp claim', { omitExp: true }],
    ['no email claim', { email: undefined }],
    ['empty email claim', { email: '  ' }],
  ])('rejects %s', async (_name, overrides) => {
    const token = await signToken({ key, email: 'a@example.test', ...overrides });
    await expect(verifyAccessJwt(token, config, staticJwks([key.jwk]))).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it('rejects a token signed by a key that is not in the JWKS', async () => {
    const forged = await signToken({ key: { ...other, kid: key.kid }, email: 'a@example.test' });
    await expect(verifyAccessJwt(forged, config, staticJwks([key.jwk]))).rejects.toThrow(AuthError);
  });

  it('rejects an unknown key id after one refresh', async () => {
    const calls: boolean[] = [];
    const jwks = {
      getKeys: (refresh: boolean) => {
        calls.push(refresh);
        return Promise.resolve([key.jwk]);
      },
    };
    const token = await signToken({ key: other, email: 'a@example.test' });
    await expect(verifyAccessJwt(token, config, jwks)).rejects.toThrow('unknown key id');
    expect(calls).toEqual([false, true]);
  });

  it('rejects HS256 and alg none', async () => {
    const hs = await new SignJWT({ email: 'a@example.test' })
      .setProtectedHeader({ alg: 'HS256', kid: key.kid })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('a-test-secret-that-is-long-enough!!'));
    await expect(verifyAccessJwt(hs, config, staticJwks([key.jwk]))).rejects.toThrow(AuthError);

    const b64 = (v: object) => btoa(JSON.stringify(v)).replace(/=+$/, '');
    const none = `${b64({ alg: 'none' })}.${b64({ email: 'a@example.test', iss: ISSUER, aud: AUDIENCE, exp: 9999999999 })}.`;
    await expect(verifyAccessJwt(none, config, staticJwks([key.jwk]))).rejects.toThrow(AuthError);
  });

  it('rejects garbage', async () => {
    await expect(verifyAccessJwt('not-a-jwt', config, staticJwks([key.jwk]))).rejects.toThrow(
      AuthError,
    );
  });

  it('treats a failing JWKS as unauthorised', async () => {
    const token = await signToken({ key, email: 'a@example.test' });
    const broken = { getKeys: () => Promise.reject(new Error('network down')) };
    await expect(verifyAccessJwt(token, config, broken)).rejects.toThrow('JWKS unavailable');
  });
});

describe('createCachedJwks', () => {
  function fakeFetch(bodies: unknown[]): { fetch: FetchLike; urls: string[] } {
    const urls: string[] = [];
    return {
      urls,
      fetch: (url) => {
        urls.push(url);
        const body = bodies[Math.min(urls.length - 1, bodies.length - 1)];
        if (body instanceof Error) return Promise.reject(body);
        return Promise.resolve(Response.json(body));
      },
    };
  }

  it('fetches once and serves from the cache within the TTL', async () => {
    let t = 0;
    const f = fakeFetch([{ keys: [key.jwk] }]);
    const jwks = createCachedJwks({ url: 'https://jwks.test/certs', fetch: f.fetch, now: () => t });
    expect(await jwks.getKeys(false)).toEqual([key.jwk]);
    t = 60_000;
    await jwks.getKeys(false);
    expect(f.urls).toEqual(['https://jwks.test/certs']);
    t = 11 * 60_000;
    await jwks.getKeys(false);
    expect(f.urls).toHaveLength(2);
  });

  it('honours the refresh cooldown for forced refreshes', async () => {
    let t = 0;
    const f = fakeFetch([{ keys: [key.jwk] }, { keys: [key.jwk, other.jwk] }]);
    const jwks = createCachedJwks({ url: 'u', fetch: f.fetch, now: () => t });
    await jwks.getKeys(false);
    t = 5_000;
    expect(await jwks.getKeys(true)).toEqual([key.jwk]);
    expect(f.urls).toHaveLength(1);
    t = 31_000;
    expect(await jwks.getKeys(true)).toEqual([key.jwk, other.jwk]);
    expect(f.urls).toHaveLength(2);
  });

  it('shares one in-flight fetch between concurrent callers', async () => {
    const f = fakeFetch([{ keys: [key.jwk] }]);
    const jwks = createCachedJwks({ url: 'u', fetch: f.fetch });
    await Promise.all([jwks.getKeys(false), jwks.getKeys(false), jwks.getKeys(true)]);
    expect(f.urls).toHaveLength(1);
  });

  it('keeps the last good keys when a refresh fails, and fails without any', async () => {
    let t = 0;
    const f = fakeFetch([{ keys: [key.jwk] }, new Error('down')]);
    const jwks = createCachedJwks({ url: 'u', fetch: f.fetch, now: () => t });
    await jwks.getKeys(false);
    t = 20 * 60_000;
    expect(await jwks.getKeys(false)).toEqual([key.jwk]);

    const empty = createCachedJwks({ url: 'u', fetch: fakeFetch([new Error('down')]).fetch });
    await expect(empty.getKeys(false)).rejects.toThrow('down');
    const bad = createCachedJwks({ url: 'u', fetch: fakeFetch([{ nope: true }]).fetch });
    await expect(bad.getKeys(false)).rejects.toThrow('no keys array');
  });

  it('rejects a non-OK response', async () => {
    const jwks = createCachedJwks({
      url: 'u',
      fetch: () => Promise.resolve(new Response('nope', { status: 503 })),
    });
    await expect(jwks.getKeys(false)).rejects.toThrow('503');
  });
});
