/**
 * Moderation routes (docs/specs/moderation-v1.md §3): the scheduled job's routes behind service
 * auth (an Access service token at the edge plus the `MODERATION_TOKEN` bearer here), user
 * reports, the owner's one appeal and the maintainer's hard delete. The job only writes a
 * recommendation; nothing here lists, rejects or unlists a share on its own. Logs never contain
 * sample bytes, names or e-mails.
 */
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from './app';
import { CommunityStore, REJECT_REASONS } from './communityStore';
import { ApiError } from './errors';
import { ModerationStore } from './moderationStore';
import { describeIssues } from './record';

/** The Workers AI model that reads names and tags (rule 18). */
export const GUARD_MODEL = '@cf/meta/llama-guard-3-8b';

export interface ModerationEnv {
  /** Secret: the job's bearer token (`wrangler secret put MODERATION_TOKEN`). Missing: fail closed. */
  MODERATION_TOKEN?: string;
  /** Workers AI (wrangler.toml `[ai]`), for the text route. */
  AI?: Ai | undefined;
}

/** Runs the text model; injectable for tests. Null: no model available. */
export type GuardRunner = (input: {
  messages: { role: 'user'; content: string }[];
}) => Promise<unknown>;

export interface ModerationDeps {
  now: () => Date;
  readBody: (req: Request, max: number) => Promise<Uint8Array>;
  guard?: GuardRunner | undefined;
}

export const MODERATION_LIMITS = {
  jobDefaultLimit: 20,
  jobMaxLimit: 50,
  maxBody: 16 * 1024,
  dailyReports: 20,
  maxTexts: 20,
  maxTextLength: 300,
} as const;

/** Paths that take the job's service auth instead of a user's session. */
export function isJobPath(path: string): boolean {
  return path.startsWith('/api/moderation/job/');
}

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
}

/**
 * Whether `header` is `Bearer <secret>`, compared in constant time: both sides are hashed
 * first, so neither the content nor the length of the secret leaks through timing.
 */
export async function bearerMatches(header: string | undefined, secret: string): Promise<boolean> {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  const given = match?.[1] ?? '';
  const [a, b] = await Promise.all([sha256(given), sha256(secret)]);
  const equal = crypto.subtle.timingSafeEqual(a, b);
  return equal && given !== '';
}

/** Check the job's bearer token; throws the matching API error. */
export async function requireModerationToken(c: Context<AppEnv>): Promise<void> {
  const secret = (c.env.MODERATION_TOKEN ?? '').trim();
  if (secret === '') {
    throw new ApiError('server_misconfigured', 'the moderation job is not configured');
  }
  if (!(await bearerMatches(c.req.header('Authorization'), secret))) {
    throw new ApiError('unauthorized', 'a valid moderation token is required');
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sampleIdParam(id: string): string {
  if (!UUID.test(id)) throw new ApiError('not_found', 'sample not found');
  return id;
}

const shortText = z.string().max(200);

export const verdictBodySchema = z
  .object({
    revision: z.number().int().min(1),
    verdict: z.enum(['ok', 'flag']),
    category: z.enum(REJECT_REASONS).optional(),
    scores: z
      .record(z.string().max(64), z.number().finite())
      .refine((r) => Object.keys(r).length <= 64, 'at most 64 scores'),
    reasons: z.array(shortText).max(20),
    notes: z.array(shortText).max(20),
    peaks: z.array(z.number().min(0).max(1)).max(64),
    models: z
      .record(z.string().max(32), z.string().max(120))
      .refine((r) => Object.keys(r).length <= 12, 'at most 12 models'),
    policy: z.string().min(1).max(64),
  })
  .refine((v) => (v.verdict === 'flag') === (v.category !== undefined), {
    message: 'a flag needs a category, ok has none',
    path: ['category'],
  });

export const textBodySchema = z.object({
  texts: z
    .array(z.string().max(MODERATION_LIMITS.maxTextLength))
    .min(1)
    .max(MODERATION_LIMITS.maxTexts),
});

/** A report names any rejection category but `quality`. */
export const reportBodySchema = z.object({
  reason: z.enum(REJECT_REASONS).refine((r) => r !== 'quality', 'quality is not a report reason'),
});
export const deleteBodySchema = z.object({ confirm: z.string() });

export interface GuardAnswer {
  safe: boolean;
  categories: string[];
}

/** Llama Guard's output, as JSON (`{ response: { safe, categories } }`) or as text (`unsafe\nS1,S10`). */
export function parseGuard(output: unknown): GuardAnswer | null {
  const response =
    typeof output === 'object' && output !== null && 'response' in output
      ? (output as { response: unknown }).response
      : output;
  if (typeof response === 'string') {
    const text = response.trim().toLowerCase();
    if (text.startsWith('safe')) return { safe: true, categories: [] };
    if (text.startsWith('unsafe')) {
      const categories = (response.toUpperCase().match(/S\d{1,2}/g) ?? []).filter(
        (c, i, all) => all.indexOf(c) === i,
      );
      return { safe: false, categories };
    }
    return null;
  }
  if (typeof response === 'object' && response !== null) {
    const r = response as { safe?: unknown; categories?: unknown };
    if (typeof r.safe !== 'boolean') return null;
    const categories = Array.isArray(r.categories)
      ? r.categories.filter((c): c is string => typeof c === 'string').map((c) => c.toUpperCase())
      : [];
    return { safe: r.safe, categories };
  }
  return null;
}

async function jsonBody<T>(
  c: Context<AppEnv>,
  deps: ModerationDeps,
  schema: z.ZodType<T>,
): Promise<T> {
  const contentType = c.req.header('Content-Type') ?? '';
  if (!/^application\/json\s*(;|$)/i.test(contentType)) {
    throw new ApiError('unsupported_media_type', 'expected application/json');
  }
  const max = MODERATION_LIMITS.maxBody;
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

function guardRunner(c: Context<AppEnv>, deps: ModerationDeps): GuardRunner | null {
  if (deps.guard !== undefined) return deps.guard;
  const ai = c.env.AI;
  if (ai === undefined) return null;
  return (input) => ai.run(GUARD_MODEL, { ...input, response_format: { type: 'json_object' } });
}

export function registerModeration(app: Hono<AppEnv>, deps: ModerationDeps): void {
  const moderation = (c: Context<AppEnv>) => new ModerationStore(c.env.DB);

  // --- The job (service auth is checked by the app's /api middleware for these paths). ---

  app.get('/api/moderation/job/pending', async (c) => {
    const raw = c.req.query('limit');
    const limit = raw === undefined ? MODERATION_LIMITS.jobDefaultLimit : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > MODERATION_LIMITS.jobMaxLimit) {
      throw new ApiError('invalid_request', `limit is 1–${MODERATION_LIMITS.jobMaxLimit}`);
    }
    return c.json({ items: await moderation(c).pendingForJob(limit) });
  });

  app.get('/api/moderation/job/samples/:id', async (c) => {
    const id = sampleIdParam(c.req.param('id'));
    const content = await moderation(c).pendingContent(id);
    if (content === null) throw new ApiError('not_found', 'no pending share for this sample');
    const object = await new CommunityStore(c.env.DB, c.env.SAVES).getBytes(content.sha256);
    if (object === null) throw new ApiError('not_found', 'sample not found');
    return new Response(object.body, {
      status: 200,
      headers: {
        'Content-Type': content.type,
        'Content-Length': String(object.size),
        'Content-Disposition': 'attachment',
      },
    });
  });

  app.post('/api/moderation/job/samples/:id/verdict', async (c) => {
    const id = sampleIdParam(c.req.param('id'));
    const body = await jsonBody(c, deps, verdictBodySchema);
    const label = body.verdict === 'ok' ? 'ok' : `flag:${body.category ?? 'other'}`;
    const written = await moderation(c).writeVerdict(
      id,
      {
        revision: body.revision,
        verdict: label,
        detail: JSON.stringify({
          scores: body.scores,
          reasons: body.reasons,
          notes: body.notes,
          peaks: body.peaks,
          models: body.models,
          policy: body.policy,
        }),
        logDetail: JSON.stringify({
          scores: body.scores,
          models: body.models,
          policy: body.policy,
        }),
      },
      deps.now().toISOString(),
    );
    if (!written) {
      throw new ApiError('conflict', 'the share is no longer pending at this revision');
    }
    return c.json({ ok: true });
  });

  app.post('/api/moderation/job/text', async (c) => {
    const { texts } = await jsonBody(c, deps, textBodySchema);
    const run = guardRunner(c, deps);
    if (run === null) return c.json({ available: false, model: GUARD_MODEL, results: [] });
    const results: GuardAnswer[] = [];
    for (const text of texts) {
      let answer: GuardAnswer | null;
      try {
        answer = parseGuard(await run({ messages: [{ role: 'user', content: text }] }));
      } catch {
        console.error('text moderation failed');
        answer = null;
      }
      if (answer === null) return c.json({ available: false, model: GUARD_MODEL, results: [] });
      results.push(answer);
    }
    return c.json({ available: true, model: GUARD_MODEL, results });
  });

  app.get('/api/moderation/job/digest', async (c) => c.json(await moderation(c).digest()));

  // --- Users and owners (Access session). ---

  app.post('/api/samples/:id/report', async (c) => {
    const id = sampleIdParam(c.req.param('id'));
    const { reason } = await jsonBody(c, deps, reportBodySchema);
    const result = await moderation(c).report(
      c.get('user').id,
      id,
      reason,
      deps.now(),
      MODERATION_LIMITS.dailyReports,
    );
    switch (result) {
      case 'not_listed':
        throw new ApiError('not_listed', 'this sample is not in the community bank (any more)');
      case 'own':
        throw new ApiError('conflict', 'you cannot report your own sample');
      case 'limit':
        throw new ApiError(
          'rate_limited',
          `at most ${MODERATION_LIMITS.dailyReports} reports per day; thank you for the help`,
        );
      case 'reported':
        return c.json({ reported: true });
    }
  });

  app.post('/api/samples/:id/appeal', async (c) => {
    const id = sampleIdParam(c.req.param('id'));
    const owner = c.get('user').id;
    const community = new CommunityStore(c.env.DB, c.env.SAVES);
    const sample = await community.ownSample(owner, id);
    if (sample === null) throw new ApiError('not_found', 'sample not found');
    if (!(await moderation(c).appeal(owner, id, deps.now().toISOString()))) {
      throw new ApiError(
        'conflict',
        sample.share?.appealed_at != null
          ? 'a review can be requested only once'
          : 'only a sample that was not accepted can be reviewed again',
      );
    }
    return c.json({ sample: await community.ownSample(owner, id) });
  });
}

/** The maintainer's hard delete; registered by community.ts beside the other decisions. */
export async function hardDeleteRoute(
  c: Context<AppEnv>,
  deps: ModerationDeps,
  id: string,
): Promise<Response> {
  const { confirm } = await jsonBody(c, deps, deleteBodySchema);
  if (confirm !== id) {
    throw new ApiError('invalid_request', 'confirm must repeat the sample id');
  }
  const result = await new CommunityStore(c.env.DB, c.env.SAVES).hardDelete(
    id,
    deps.now().toISOString(),
  );
  if (result === 'not_found') throw new ApiError('not_found', 'sample not found');
  if (result === 'in_use') {
    throw new ApiError(
      'sample_in_use',
      'another user has this sample in a slot; it cannot be deleted',
    );
  }
  return c.json({ deleted: true });
}
