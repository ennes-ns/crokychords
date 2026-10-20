import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { ACCESS_JWT_HEADER, AuthError, verifyAccessJwt } from './auth';
import type { JwksSource } from './auth';
import type { AssistantEnv } from './assistant';
import { registerAssistant } from './assistant';
import { ApiError } from './errors';
import { LIMITS, SCHEMA_VERSION, describeIssues, isSaveId, saveInputSchema } from './record';
import type { SaveRecord } from './record';
import { Storage } from './storage';
import type { User } from './storage';

/** Bindings, vars and secrets of the Worker (see wrangler.toml and docs/specs/api-v1.md §2). */
export interface Env extends AssistantEnv {
  DB: D1Database;
  SAVES: R2Bucket;
  /** The built web app (wrangler.toml `[assets]`); not used by the API routes. */
  ASSETS?: Fetcher;
  /** Secret; missing until `wrangler secret put` (the API then fails closed). */
  ACCESS_TEAM_DOMAIN?: string;
  /** Secret; missing until `wrangler secret put` (the API then fails closed). */
  ACCESS_AUD?: string;
  ALLOWED_ORIGIN: string;
}

export interface AppDeps {
  /** The JWKS to verify Access tokens with, per team domain (cached by the caller). */
  jwks: (teamDomain: string) => JwksSource;
  /** Clock, for tests. */
  now?: () => Date;
  /** `fetch` for the model API (docs/specs/assistant-v1.md §B2), for tests. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

export type AppEnv = { Bindings: Env; Variables: { user: User; storage: Storage } };

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const now = deps.now ?? (() => new Date());
  const app = new Hono<AppEnv>();

  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      strictTransportSecurity: 'max-age=31536000',
      xFrameOptions: 'DENY',
      referrerPolicy: 'no-referrer',
      crossOriginResourcePolicy: 'same-site',
    }),
  );

  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  // Refuse foreign origins before anything else. Requests without Origin (same-origin GETs,
  // non-browser clients) and requests from ALLOWED_ORIGIN (the app this Worker serves) pass,
  // but still need a valid Access JWT below.
  app.use('*', async (c, next) => {
    const origin = c.req.header('Origin');
    if (origin !== undefined && !isAllowedOrigin(origin, c)) {
      throw new ApiError('forbidden_origin', 'origin not allowed');
    }
    await next();
  });

  app.use(
    '*',
    cors({
      origin: (origin, c: Context<AppEnv>) => (isAllowedOrigin(origin, c) ? origin : null),
      allowMethods: ['GET', 'PUT', 'POST', 'DELETE'],
      allowHeaders: ['Content-Type', 'If-Match'],
      exposeHeaders: ['ETag'],
      credentials: true,
      maxAge: 600,
    }),
  );

  app.use('/api/*', async (c, next) => {
    const teamDomain = (c.env.ACCESS_TEAM_DOMAIN ?? '').trim();
    const audience = (c.env.ACCESS_AUD ?? '').trim();
    if (teamDomain === '' || audience === '') {
      throw new ApiError('server_misconfigured', 'access is not configured');
    }
    const token = c.req.header(ACCESS_JWT_HEADER);
    if (token === undefined || token === '') throw unauthorized();
    let email: string;
    try {
      ({ email } = await verifyAccessJwt(
        token,
        { teamDomain, audience },
        deps.jwks(teamDomain),
        now(),
      ));
    } catch (e) {
      if (e instanceof AuthError) throw unauthorized();
      throw e;
    }
    const storage = new Storage(c.env.DB, c.env.SAVES);
    c.set('storage', storage);
    c.set('user', await storage.ensureUser(email, now()));
    await next();
  });

  app.get('/api/me', async (c) => {
    const user = c.get('user');
    return c.json({
      id: user.id,
      email: user.email,
      created_at: user.created_at,
      save_count: await c.get('storage').countSaves(user.id),
      limits: { max_save_bytes: LIMITS.maxSaveBytes, max_saves: LIMITS.maxSaves },
    });
  });

  app.get('/api/saves', async (c) => {
    return c.json({ saves: await c.get('storage').listSaves(c.get('user').id) });
  });

  app.get('/api/saves/:id', async (c) => {
    const id = saveIdParam(c.req.param('id'));
    const record = await c.get('storage').getRecord(c.get('user').id, id);
    if (record === null) throw new ApiError('not_found', 'save not found');
    c.header('ETag', etag(record.version));
    return c.json(record);
  });

  app.put('/api/saves/:id', async (c) => {
    const id = saveIdParam(c.req.param('id'));
    const contentType = c.req.header('Content-Type') ?? '';
    if (!/^application\/json\s*(;|$)/i.test(contentType)) {
      throw new ApiError('unsupported_media_type', 'expected application/json');
    }
    const declared = Number(c.req.header('Content-Length') ?? '0');
    if (declared > LIMITS.maxSaveBytes) throw tooLarge();
    const raw = await readBounded(c.req.raw, LIMITS.maxSaveBytes);

    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw new ApiError('invalid_request', 'body is not valid JSON');
    }
    const parsed = saveInputSchema.safeParse(json);
    if (!parsed.success) throw new ApiError('invalid_request', describeIssues(parsed.error));
    const input = parsed.data;
    if (input.id !== id) throw new ApiError('invalid_request', 'id does not match the URL');

    const ifMatch = parseIfMatch(c.req.header('If-Match'));
    const base = ifMatch ?? input.version - 1;
    if (input.version !== base + 1) {
      throw new ApiError('invalid_request', 'version must be the If-Match version + 1');
    }

    const user = c.get('user');
    const storage = c.get('storage');
    const current = await storage.getMeta(user.id, id);
    if ((current?.version ?? 0) !== base) {
      throw new ApiError('conflict', 'the save has changed since this version', current);
    }

    const record: SaveRecord = {
      schema_version: SCHEMA_VERSION,
      id,
      version: input.version,
      updated_at: now().toISOString(),
      title: input.title,
      song: input.song,
    };
    const claim = await storage.claimVersion(
      user.id,
      record,
      base,
      raw.byteLength,
      LIMITS.maxSaves,
    );
    if (claim === 'limit') {
      throw new ApiError('save_limit_reached', `at most ${LIMITS.maxSaves} saves per user`);
    }
    if (claim === 'conflict') {
      throw new ApiError(
        'conflict',
        'the save has changed since this version',
        await storage.getMeta(user.id, id),
      );
    }
    try {
      await storage.putBody(user.id, record);
    } catch (e) {
      await storage.rollbackClaim(user.id, current, record);
      throw e;
    }
    c.header('ETag', etag(record.version));
    return c.json(record, current === null ? 201 : 200);
  });

  app.delete('/api/saves/:id', async (c) => {
    const id = saveIdParam(c.req.param('id'));
    const expected = parseIfMatch(c.req.header('If-Match'));
    const user = c.get('user');
    const storage = c.get('storage');
    if (await storage.deleteSave(user.id, id, expected)) return c.body(null, 204);
    const current = await storage.getMeta(user.id, id);
    if (current === null) throw new ApiError('not_found', 'save not found');
    throw new ApiError('conflict', 'the save has changed since this version', current);
  });

  registerAssistant(app, {
    fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
    now,
    readBody: readBounded,
  });

  app.notFound((c) => c.json(new ApiError('not_found', 'no such route').toBody(), 404));

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(err.toBody(), err.status);
    console.error('unhandled error', err instanceof Error ? err.name : typeof err);
    return c.json(new ApiError('internal', 'internal error').toBody(), 500);
  });

  return app;
}

/**
 * Only the configured `ALLOWED_ORIGIN` (the production hostname of the app this Worker serves).
 * The request's own origin is deliberately not trusted: with `workers.dev` and Preview URLs off
 * there is no second hostname that would need it.
 */
function isAllowedOrigin(origin: string, c: Context<AppEnv>): boolean {
  return origin === c.env.ALLOWED_ORIGIN;
}

/**
 * The request body, read chunk by chunk and abandoned as soon as it exceeds `max` bytes, so a
 * chunked upload without `Content-Length` is never buffered beyond the limit.
 */
export async function readBounded(req: Request, max: number): Promise<Uint8Array> {
  if (req.body === null) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function unauthorized(): ApiError {
  return new ApiError('unauthorized', 'a valid Cloudflare Access token is required');
}

function tooLarge(): ApiError {
  return new ApiError('payload_too_large', `a save may be at most ${LIMITS.maxSaveBytes} bytes`);
}

function saveIdParam(id: string): string {
  if (!isSaveId(id)) throw new ApiError('not_found', 'save not found');
  return id;
}

function etag(version: number): string {
  return `"${version}"`;
}

/** `"<n>"` or `W/"<n>"` → n; absent → undefined; anything else → 400. */
export function parseIfMatch(header: string | undefined): number | undefined {
  if (header === undefined) return undefined;
  const match = /^\s*(?:W\/)?"(\d{1,15})"\s*$/.exec(header);
  if (match?.[1] === undefined) {
    throw new ApiError('invalid_request', 'If-Match must be one entity tag "<version>"');
  }
  return Number(match[1]);
}
