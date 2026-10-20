/**
 * The community bank's routes (docs/specs/community-v1.md §3): upload and own samples, share and
 * unshare, the bank, take, handles, and the maintainer's review queue with the automatic
 * recommendation, reports and appeals of docs/specs/moderation-v1.md. Human review first: a
 * share stays `pending` until the maintainer lists or rejects it here; nothing changes a share
 * automatically. Logs never contain sample bytes, names or e-mails.
 */
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from './app';
import type { CommunitySample } from './communityStore';
import {
  COMMUNITY_LIMITS,
  CommunityStore,
  REJECT_REASONS,
  SAMPLER_SLOTS,
  displayHandle,
  joinTags,
} from './communityStore';
import { ApiError } from './errors';
import type { ModerationDeps } from './moderation';
import { hardDeleteRoute } from './moderation';
import { describeIssues } from './record';

export interface CommunityEnv {
  /** Maintainer e-mails, comma separated; empty: nobody (docs/specs/community-v1.md §3). */
  ADMIN_EMAILS?: string;
}

export type CommunityDeps = ModerationDeps;

/** Whether `email` is one of the maintainers in `ADMIN_EMAILS`. */
export function isMaintainer(adminEmails: string | undefined, email: string): boolean {
  const wanted = email.trim().toLowerCase();
  if (wanted === '') return false;
  return (adminEmails ?? '')
    .split(/[\s,;]+/)
    .map((e) => e.trim().toLowerCase())
    .some((e) => e !== '' && e === wanted);
}

/** Accepted upload types and the stored type of their family. */
const UPLOAD_TYPES: Readonly<Record<string, Family>> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
};
type Family = 'wav' | 'ogg' | 'flac' | 'mp3';
const STORED_TYPE: Readonly<Record<Family, string>> = {
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  mp3: 'audio/mpeg',
};

/** The family of a `Content-Type` header, or null when it is not an accepted audio type. */
export function uploadFamily(header: string | undefined): Family | null {
  const type = (header ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return UPLOAD_TYPES[type] ?? null;
}

function ascii(bytes: Uint8Array, from: number, text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (bytes[from + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** Whether the first bytes are those of a file of `family`. */
export function matchesMagic(bytes: Uint8Array, family: Family): boolean {
  switch (family) {
    case 'wav':
      return (ascii(bytes, 0, 'RIFF') || ascii(bytes, 0, 'RF64')) && ascii(bytes, 8, 'WAVE');
    case 'ogg':
      return ascii(bytes, 0, 'OggS');
    case 'flac':
      return ascii(bytes, 0, 'fLaC');
    case 'mp3':
      return (
        ascii(bytes, 0, 'ID3') ||
        (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0 && bytes.length > 1)
      );
  }
}

/** A name without control characters, trimmed; 1–64 characters. */
const nameSchema = z
  .string()
  .transform((s) =>
    s
      .replace(/\p{Cc}/gu, '')
      .replace(/\s+/g, ' ')
      .trim(),
  )
  .pipe(z.string().min(1).max(COMMUNITY_LIMITS.maxNameLength));

const TAG = /^[a-z0-9-]{1,16}$/;

const tagsSchema = z
  .array(z.string())
  .max(20)
  .transform((tags) => [...new Set(tags.map((t) => t.trim().toLowerCase()))])
  .pipe(
    z.array(z.string().regex(TAG, 'tags are 1–16 of a-z, 0-9 and -')).max(COMMUNITY_LIMITS.maxTags),
  );

const numberParam = z.string().trim().min(1).pipe(z.coerce.number());

export const uploadQuerySchema = z.object({
  name: nameSchema,
  duration: numberParam.pipe(
    z.number().min(COMMUNITY_LIMITS.minDuration).max(COMMUNITY_LIMITS.maxDuration),
  ),
  channels: numberParam.pipe(z.union([z.literal(1), z.literal(2)])),
  root: numberParam.pipe(z.number().int().min(0).max(127)).optional(),
  sha256: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 hex characters'),
});

export const shareBodySchema = z.object({
  licence: z.literal(true, { error: 'the licence must be acknowledged (licence: true)' }),
  name: nameSchema.optional(),
  tags: tagsSchema.optional(),
});

export const takeBodySchema = z.object({ slot: z.enum(SAMPLER_SLOTS) });

export const handleBodySchema = z.object({
  handle: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{2,24}$/, 'a handle is 2–24 of A-Z, a-z, 0-9, _ . -')
    .refine((h) => !/^user-/i.test(h), 'handles starting with user- are the defaults')
    .nullable(),
});

const revisionSchema = z.number().int().min(1);

export const decisionBodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), revision: revisionSchema }),
  z.object({
    action: z.literal('reject'),
    reason: z.enum(REJECT_REASONS),
    revision: revisionSchema,
  }),
  z.object({ action: z.literal('dismiss'), revision: revisionSchema }),
]);

export const releaseQuerySchema = z.object({ slot: z.enum(SAMPLER_SLOTS) });

const communityQuerySchema = z.object({
  q: z.string().trim().max(COMMUNITY_LIMITS.maxQueryLength).optional(),
  tag: z
    .string()
    .trim()
    .toLowerCase()
    .regex(TAG, 'tags are 1–16 of a-z, 0-9 and -')
    .optional()
    .or(z.literal('')),
  cursor: z.string().optional(),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether an R2 write failed because the bytes did not match the given checksum. */
export function isChecksumError(e: unknown): boolean {
  return e instanceof Error && /sha-?256|checksum|digest|did not match/i.test(e.message);
}

/** A sample id from the path; anything that is not a UUID is simply not found. */
function sampleIdParam(id: string): string {
  if (!UUID.test(id)) throw new ApiError('not_found', 'sample not found');
  return id;
}

/** `[listed_at, id]` ↔ an opaque base64url cursor. */
export function encodeCursor(after: [string, string]): string {
  return btoa(JSON.stringify(after)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeCursor(cursor: string): [string, string] {
  try {
    const json: unknown = JSON.parse(atob(cursor.replace(/-/g, '+').replace(/_/g, '/')));
    if (
      Array.isArray(json) &&
      json.length === 2 &&
      typeof json[0] === 'string' &&
      typeof json[1] === 'string'
    ) {
      return [json[0], json[1]];
    }
  } catch {
    // Falls through to the error below.
  }
  throw new ApiError('invalid_request', 'the cursor is not valid');
}

async function jsonBody<T>(
  c: Context<AppEnv>,
  deps: CommunityDeps,
  schema: z.ZodType<T>,
): Promise<T> {
  const contentType = c.req.header('Content-Type') ?? '';
  if (!/^application\/json\s*(;|$)/i.test(contentType)) {
    throw new ApiError('unsupported_media_type', 'expected application/json');
  }
  const max = 16 * 1024;
  if (Number(c.req.header('Content-Length') ?? '0') > max) {
    throw new ApiError('payload_too_large', `at most ${max} bytes`);
  }
  let raw: Uint8Array;
  try {
    raw = await deps.readBody(c.req.raw, max);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'payload_too_large') {
      throw new ApiError('payload_too_large', `at most ${max} bytes`);
    }
    throw e;
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new ApiError('invalid_request', 'body is not valid JSON');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiError('invalid_request', describeIssues(parsed.error));
  return parsed.data;
}

function store(c: Context<AppEnv>): CommunityStore {
  return new CommunityStore(c.env.DB, c.env.SAVES);
}

function requireMaintainer(c: Context<AppEnv>): void {
  if (!isMaintainer(c.env.ADMIN_EMAILS, c.get('user').email)) {
    throw new ApiError('forbidden', 'only the maintainer may do this');
  }
}

function sampleLimitError(): ApiError {
  const { maxSamples, maxTotalBytes } = COMMUNITY_LIMITS;
  return new ApiError(
    'sample_limit_reached',
    `at most ${maxSamples} samples and ${maxTotalBytes / 1024 / 1024} MB per user`,
  );
}

function uploadTooLarge(): ApiError {
  return new ApiError(
    'payload_too_large',
    `a sample may be at most ${COMMUNITY_LIMITS.maxSampleBytes / 1024 / 1024} MB`,
  );
}

const limitsBody = () => ({
  max_sample_bytes: COMMUNITY_LIMITS.maxSampleBytes,
  max_samples: COMMUNITY_LIMITS.maxSamples,
  max_total_bytes: COMMUNITY_LIMITS.maxTotalBytes,
});

export function registerCommunity(app: Hono<AppEnv>, deps: CommunityDeps): void {
  app.put('/api/me/handle', async (c) => {
    const { handle } = await jsonBody(c, deps, handleBodySchema);
    const user = c.get('user');
    if (!(await store(c).setHandle(user.id, handle))) {
      throw new ApiError('handle_taken', 'someone else already uses this name');
    }
    return c.json({ handle: displayHandle(user.id, handle) });
  });

  app.get('/api/samples', async (c) => {
    const owner = c.get('user').id;
    const s = store(c);
    return c.json({
      samples: await s.listOwn(owner),
      usage: await s.usage(owner),
      limits: limitsBody(),
    });
  });

  app.post('/api/samples', async (c) => {
    const family = uploadFamily(c.req.header('Content-Type'));
    if (family === null) {
      throw new ApiError('unsupported_media_type', 'expected a wav, ogg, flac or mp3 file');
    }
    const query = uploadQuerySchema.safeParse(c.req.query());
    if (!query.success) throw new ApiError('invalid_request', describeIssues(query.error));
    const max = COMMUNITY_LIMITS.maxSampleBytes;
    const declared = Number(c.req.header('Content-Length') ?? '0');
    if (declared > max) throw uploadTooLarge();
    const owner = c.get('user').id;
    const s = store(c);
    // Refuse an upload beyond the quota before reading up to 10 MB of it (content the owner
    // already has is still answered; the insert below is the binding check).
    const usage = await s.usage(owner);
    const full =
      usage.samples >= COMMUNITY_LIMITS.maxSamples ||
      usage.bytes + Math.max(0, declared) > COMMUNITY_LIMITS.maxTotalBytes;
    if (full && !(await s.hasContent(owner, query.data.sha256))) throw sampleLimitError();
    let bytes: Uint8Array;
    try {
      bytes = await deps.readBody(c.req.raw, max);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'payload_too_large') throw uploadTooLarge();
      throw e;
    }
    if (bytes.byteLength === 0) throw new ApiError('invalid_request', 'the file is empty');
    if (!matchesMagic(bytes, family)) {
      throw new ApiError('invalid_request', `the file is not a ${family} file`);
    }
    const { name, duration, channels, root, sha256 } = query.data;
    const inserted = await s.insertSample({
      id: crypto.randomUUID(),
      owner_id: owner,
      sha256,
      bytes: bytes.byteLength,
      type: STORED_TYPE[family],
      duration,
      channels,
      name,
      tags: joinTags([]),
      root: root ?? 60,
      created_at: deps.now().toISOString(),
    });
    if (inserted.status === 'limit') throw sampleLimitError();
    try {
      // Also for an existing sample: the bytes prove the caller holds the content.
      await s.putBytes(sha256, bytes, STORED_TYPE[family]);
    } catch (e) {
      if (inserted.status === 'created') await s.dropInserted(owner, inserted.sample.id);
      if (isChecksumError(e))
        throw new ApiError('invalid_request', 'the bytes do not match sha256');
      throw e;
    }
    return c.json({ sample: inserted.sample }, inserted.status === 'created' ? 201 : 200);
  });

  app.get('/api/samples/:id', async (c) => {
    const id = sampleIdParam(c.req.param('id'));
    const user = c.get('user');
    const s = store(c);
    const info = await s.readInfo(id, user.id);
    const allowed =
      info !== null &&
      (info.state === 'listed' ||
        info.owner_id === user.id ||
        info.has_ref === 1 ||
        isMaintainer(c.env.ADMIN_EMAILS, user.email));
    if (info === null || !allowed) throw new ApiError('not_found', 'sample not found');
    const object = await s.getBytes(info.sha256);
    if (object === null) throw new ApiError('not_found', 'sample not found');
    return new Response(object.body, {
      status: 200,
      headers: {
        'Content-Type': info.type,
        'Content-Length': String(object.size),
        ETag: `"${info.sha256}"`,
        'Content-Disposition': 'inline',
      },
    });
  });

  app.delete('/api/samples/:id', async (c) => {
    const id = sampleIdParam(c.req.param('id'));
    const owner = c.get('user').id;
    const s = store(c);
    const sample = await s.ownSample(owner, id);
    if (sample === null) throw new ApiError('not_found', 'sample not found');
    const info = await s.readInfo(id, owner);
    if (info === null || !(await s.deleteSample(owner, id, info.sha256))) {
      throw new ApiError(
        'sample_in_use',
        'the sample is shared or someone has it in a slot; unshare it first (it stays while others use it)',
      );
    }
    return c.body(null, 204);
  });

  app.post('/api/samples/:id/share', async (c) => {
    const id = sampleIdParam(c.req.param('id'));
    const body = await jsonBody(c, deps, shareBodySchema);
    const owner = c.get('user').id;
    const s = store(c);
    const sample = await s.ownSample(owner, id);
    if (sample === null) throw new ApiError('not_found', 'sample not found');
    if (sample.share?.state === 'rejected') {
      throw new ApiError('share_rejected', 'this sample was not accepted for the community bank');
    }
    if (sample.share?.state !== 'listed') {
      await s.share(
        owner,
        id,
        body.name ?? sample.name,
        joinTags(body.tags ?? sample.tags),
        deps.now().toISOString(),
      );
    }
    return c.json({ sample: await s.ownSample(owner, id) });
  });

  app.delete('/api/samples/:id/share', async (c) => {
    const id = sampleIdParam(c.req.param('id'));
    const owner = c.get('user').id;
    const s = store(c);
    if ((await s.ownSample(owner, id)) === null) {
      throw new ApiError('not_found', 'sample not found');
    }
    await s.unshare(owner, id, deps.now().toISOString());
    return c.json({ sample: await s.ownSample(owner, id) });
  });

  app.post('/api/samples/:id/take', async (c) => {
    const id = sampleIdParam(c.req.param('id'));
    const { slot } = await jsonBody(c, deps, takeBodySchema);
    const taken = await store(c).take(c.get('user').id, id, slot, deps.now().toISOString());
    if (taken === null) {
      throw new ApiError('not_listed', 'this sample is not in the community bank (any more)');
    }
    if (taken === 'limit') {
      throw new ApiError(
        'sample_limit_reached',
        `at most ${COMMUNITY_LIMITS.maxRefs} community samples in slots per user`,
      );
    }
    return c.json({ sample: taken });
  });

  app.delete('/api/samples/:id/take', async (c) => {
    const id = sampleIdParam(c.req.param('id'));
    const query = releaseQuerySchema.safeParse(c.req.query());
    if (!query.success) throw new ApiError('invalid_request', describeIssues(query.error));
    await store(c).release(c.get('user').id, id, query.data.slot);
    return c.body(null, 204);
  });

  app.get('/api/community', async (c) => {
    const parsed = communityQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw new ApiError('invalid_request', describeIssues(parsed.error));
    const { q, tag, cursor } = parsed.data;
    const page = await store(c).community(c.get('user').id, {
      query: q === undefined || q === '' ? null : q,
      tag: tag === undefined || tag === '' ? null : tag,
      after: cursor === undefined || cursor === '' ? null : decodeCursor(cursor),
    });
    const samples: CommunitySample[] = page.samples;
    return c.json({ samples, next: page.next === null ? null : encodeCursor(page.next) });
  });

  app.get('/api/moderation/queue', async (c) => {
    requireMaintainer(c);
    const state = c.req.query('state') ?? 'pending';
    if (state !== 'pending' && state !== 'listed' && state !== 'reported') {
      throw new ApiError('invalid_request', 'state is pending, listed or reported');
    }
    return c.json({ items: await store(c).queue(state) });
  });

  app.post('/api/moderation/:id', async (c) => {
    requireMaintainer(c);
    const id = sampleIdParam(c.req.param('id'));
    const decision = await jsonBody(c, deps, decisionBodySchema);
    const s = store(c);
    const item = await s.queueItem(id);
    if (item === null) throw new ApiError('not_found', 'no share for this sample');
    if (!(await s.decide(id, decision, decision.revision, deps.now().toISOString()))) {
      throw new ApiError(
        'conflict',
        item.revision !== decision.revision
          ? 'the owner changed the share since you loaded it; reload and look again'
          : decision.action === 'dismiss'
            ? 'there are no open reports on a listed share to dismiss'
            : `the share is ${item.state}; it cannot be decided that way`,
      );
    }
    return c.json({ item: await s.queueItem(id) });
  });

  app.post('/api/moderation/:id/delete', async (c) => {
    requireMaintainer(c);
    return hardDeleteRoute(c, deps, sampleIdParam(c.req.param('id')));
  });
}
