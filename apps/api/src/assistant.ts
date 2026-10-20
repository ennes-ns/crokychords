/**
 * `/api/assistant` (docs/specs/assistant-v1.md §B2): the in-app assistant. Validates the request,
 * enforces the per-user rate limits and the daily cost budget (D1 `assistant_usage`), asks the
 * model through the Anthropic Messages API (plain `fetch`) and returns its answer as commands
 * checked against the core contract. Logs never contain the song, the request text or the key.
 */
import type { Song } from '@crokychords/core';
import {
  SongError,
  assistantReplyJsonSchema,
  parseAssistantReply,
  serializeSong,
  validateSong,
} from '@crokychords/core';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from './app';
import { systemPrompt } from './assistantPrompt';
import { ApiError } from './errors';
import { describeIssues } from './record';

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
/** Beta header of server-side fallback in its "default" form. */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const MAX_TOKENS = 8000;
export const MAX_ASSISTANT_BODY_BYTES = 262_144;
export const MAX_REQUEST_CHARS = 2000;
export const MAX_HISTORY = 8;
export const MAX_HISTORY_CHARS = 4000;
/** How long the model may take before the request counts as failed (ms). */
export const MODEL_TIMEOUT_MS = 90_000;

/** USD per million input / output tokens; unknown models are charged at the highest rate. */
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};
const FALLBACK_PRICE = { input: 10, output: 50 };

export interface AssistantEnv {
  DB: D1Database;
  /** Secret; without it the assistant is unavailable. */
  ANTHROPIC_API_KEY?: string;
  /** "true" switches the assistant on; anything else (default "false") hides it in the app. */
  ASSISTANT_ENABLED?: string;
  ASSISTANT_MODEL?: string;
  ASSISTANT_DAILY_BUDGET_USD?: string;
  ASSISTANT_USER_DAILY_REQUESTS?: string;
  ASSISTANT_USER_MINUTE_REQUESTS?: string;
  /** 'schema' (default): structured output; 'text': JSON asked for in the prompt only. */
  ASSISTANT_OUTPUT?: string;
  /** 'default' (default): server-side fallback on a refusal; empty: off. */
  ASSISTANT_FALLBACKS?: string;
}

export interface AssistantConfig {
  /** `ASSISTANT_ENABLED` is "true" and a key is set: the app may show the assistant. */
  enabled: boolean;
  key: string | null;
  model: string;
  budgetMicroUsd: number;
  perDay: number;
  perMinute: number;
  structured: boolean;
  fallbacks: boolean;
}

function positive(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function assistantConfig(env: AssistantEnv): AssistantConfig {
  const key = (env.ANTHROPIC_API_KEY ?? '').trim();
  const model = (env.ASSISTANT_MODEL ?? '').trim();
  return {
    enabled: (env.ASSISTANT_ENABLED ?? '').trim().toLowerCase() === 'true' && key !== '',
    key: key === '' ? null : key,
    model: model === '' ? DEFAULT_MODEL : model,
    budgetMicroUsd: Math.round(positive(env.ASSISTANT_DAILY_BUDGET_USD, 1) * 1e6),
    perDay: Math.floor(positive(env.ASSISTANT_USER_DAILY_REQUESTS, 50)),
    perMinute: Math.floor(positive(env.ASSISTANT_USER_MINUTE_REQUESTS, 6)),
    structured: (env.ASSISTANT_OUTPUT ?? 'schema').trim() !== 'text',
    fallbacks: (env.ASSISTANT_FALLBACKS ?? 'default').trim() === 'default',
  };
}

export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** Estimated cost of one call in millionths of a dollar (cache writes 1.25×, reads 0.1×). */
export function costMicroUsd(model: string, usage: ModelUsage): number {
  const price = PRICES[model] ?? FALLBACK_PRICE;
  const input =
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) * 1.25 +
    (usage.cache_read_input_tokens ?? 0) * 0.1;
  return Math.ceil(input * price.input + usage.output_tokens * price.output);
}

const dayKey = (now: Date) => `day:${now.toISOString().slice(0, 10)}`;
const minuteKey = (now: Date) => `min:${now.toISOString().slice(0, 16)}`;
const EVERYONE = '*';

/** The usage counters in D1. */
export class AssistantUsage {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  /** Count one request for `scope` in `period` unless it already has `limit`; false when full. */
  async #claim(scope: string, period: string, limit: number): Promise<boolean> {
    const result = await this.#db
      .prepare(
        `INSERT INTO assistant_usage (scope, period, requests, cost_micro_usd) VALUES (?1, ?2, 1, 0)
         ON CONFLICT (scope, period) DO UPDATE SET requests = requests + 1 WHERE requests < ?3`,
      )
      .bind(scope, period, limit)
      .run();
    return limit > 0 && result.meta.changes > 0;
  }

  /** Claim a request of `user` against both limits: null when allowed, else which limit. */
  async claim(
    user: string,
    now: Date,
    config: Pick<AssistantConfig, 'perMinute' | 'perDay'>,
  ): Promise<'minute' | 'day' | null> {
    await this.#db
      .prepare(
        `DELETE FROM assistant_usage WHERE scope = ?1 AND period LIKE 'min:%' AND period < ?2`,
      )
      .bind(user, minuteKey(now))
      .run();
    if (!(await this.#claim(user, minuteKey(now), config.perMinute))) return 'minute';
    if (!(await this.#claim(user, dayKey(now), config.perDay))) return 'day';
    return null;
  }

  /** Model cost of everyone today, in millionths of a dollar. */
  async spentToday(now: Date): Promise<number> {
    const row = await this.#db
      .prepare(
        'SELECT cost_micro_usd AS cost FROM assistant_usage WHERE scope = ?1 AND period = ?2',
      )
      .bind(EVERYONE, dayKey(now))
      .first<{ cost: number }>();
    return row?.cost ?? 0;
  }

  /** Requests `user` made today. */
  async usedToday(user: string, now: Date): Promise<number> {
    const row = await this.#db
      .prepare('SELECT requests FROM assistant_usage WHERE scope = ?1 AND period = ?2')
      .bind(user, dayKey(now))
      .first<{ requests: number }>();
    return row?.requests ?? 0;
  }

  /** Add the cost of one call to the user's and everyone's day. */
  async record(user: string, now: Date, cost: number): Promise<void> {
    const add = this.#db.prepare(
      `INSERT INTO assistant_usage (scope, period, requests, cost_micro_usd) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (scope, period) DO UPDATE SET
         requests = requests + excluded.requests, cost_micro_usd = cost_micro_usd + excluded.cost_micro_usd`,
    );
    await this.#db.batch([
      add.bind(EVERYONE, dayKey(now), 1, cost),
      add.bind(user, dayKey(now), 0, cost),
    ]);
  }
}

const historySchema = z
  .array(
    z.strictObject({
      role: z.enum(['user', 'assistant']),
      text: z.string().min(1).max(MAX_HISTORY_CHARS),
    }),
  )
  .max(MAX_HISTORY)
  .refine(
    (turns) => turns.every((t, i) => t.role === (i % 2 === 0 ? 'user' : 'assistant')),
    'history alternates user and assistant turns, starting with the user',
  )
  .refine((turns) => turns.length % 2 === 0, 'history ends with an assistant turn');

export const assistantRequestSchema = z.strictObject({
  request: z.string().trim().min(1).max(MAX_REQUEST_CHARS),
  song: z.unknown(),
  selected: z.int().min(0).nullable().optional(),
  history: historySchema.optional(),
});

export interface AssistantRequest {
  request: string;
  song: Song;
  selected: number | null;
  history: { role: 'user' | 'assistant'; text: string }[];
}

/** Parse and check the POST body (the song with validateSong). */
export function parseAssistantRequest(json: unknown): AssistantRequest {
  const parsed = assistantRequestSchema.safeParse(json);
  if (!parsed.success) throw new ApiError('invalid_request', describeIssues(parsed.error));
  let song: Song;
  try {
    song = validateSong(parsed.data.song);
  } catch (e) {
    if (e instanceof SongError) throw new ApiError('invalid_request', `song: ${e.message}`);
    throw e;
  }
  const selected = parsed.data.selected ?? null;
  if (selected !== null && selected >= song.chords.length) {
    throw new ApiError('invalid_request', 'selected: no such chord');
  }
  return { request: parsed.data.request, song, selected, history: parsed.data.history ?? [] };
}

/** The user turn: the song as the app stores it, the selection and the request. */
export function userMessage(req: AssistantRequest): string {
  const selected =
    req.selected === null
      ? 'null (no chord selected)'
      : `${req.selected} (${req.song.chords[req.selected]?.token ?? '?'})`;
  return `Song:\n${serializeSong(req.song)}\n\nSelected chord index: ${selected}\n\nRequest: ${req.request}`;
}

/** The Messages API request body. */
export function modelRequest(req: AssistantRequest, config: AssistantConfig): object {
  const messages = [
    ...req.history.map((t) => ({ role: t.role, content: t.text })),
    { role: 'user', content: userMessage(req) },
  ];
  return {
    model: config.model,
    max_tokens: MAX_TOKENS,
    system: [{ type: 'text', text: systemPrompt(), cache_control: { type: 'ephemeral' } }],
    messages,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'low',
      ...(config.structured
        ? { format: { type: 'json_schema', schema: assistantReplyJsonSchema() } }
        : {}),
    },
    ...(config.fallbacks ? { fallbacks: 'default' } : {}),
  };
}

interface ModelResponse {
  stop_reason?: string | null;
  content?: { type: string; text?: string }[];
  usage?: ModelUsage;
}

/** The JSON object in the model's text (the whole text, or its outermost braces). */
function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

export interface AssistantDeps {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  now: () => Date;
  /** Read the POST body with a size limit. */
  readBody: (req: Request, max: number) => Promise<Uint8Array>;
}

/** Call the model; ApiError for every way it can fail. */
async function callModel(
  deps: AssistantDeps,
  config: AssistantConfig,
  key: string,
  req: AssistantRequest,
): Promise<{ body: ModelResponse; usage: ModelUsage | null }> {
  let response: Response;
  try {
    response = await deps.fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': ANTHROPIC_VERSION,
        ...(config.fallbacks ? { 'anthropic-beta': FALLBACK_BETA } : {}),
      },
      body: JSON.stringify(modelRequest(req, config)),
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    });
  } catch (e) {
    console.error('assistant: model request failed', e instanceof Error ? e.name : typeof e);
    throw new ApiError('assistant_busy', 'the assistant did not answer in time; try again');
  }
  if (!response.ok) {
    let type = 'unknown';
    try {
      const err: unknown = await response.json();
      const inner: unknown =
        typeof err === 'object' && err !== null ? Reflect.get(err, 'error') : null;
      const t: unknown =
        typeof inner === 'object' && inner !== null ? Reflect.get(inner, 'type') : null;
      if (typeof t === 'string') type = t;
    } catch {
      // Not JSON: the status says enough.
    }
    console.error('assistant: model API error', response.status, type);
    if (response.status === 401 || response.status === 403) {
      throw new ApiError('assistant_unavailable', 'the assistant is not set up correctly');
    }
    if (response.status === 429 || response.status >= 500) {
      throw new ApiError('assistant_busy', 'the assistant is busy; try again in a moment');
    }
    throw new ApiError('assistant_failed', 'the assistant could not handle this request');
  }
  const body = (await response.json()) as ModelResponse;
  const usage = body.usage ?? null;
  return { body, usage };
}

export function registerAssistant(app: Hono<AppEnv>, deps: AssistantDeps): void {
  app.get('/api/assistant', async (c) => {
    const config = assistantConfig(c.env);
    const usage = new AssistantUsage(c.env.DB);
    const now = deps.now();
    const spent = await usage.spentToday(now);
    return c.json({
      enabled: config.enabled,
      available: config.enabled && spent < config.budgetMicroUsd,
      model: config.model,
      limits: { per_minute: config.perMinute, per_day: config.perDay },
      used_today: await usage.usedToday(c.get('user').id, now),
    });
  });

  app.post('/api/assistant', async (c) => {
    const config = assistantConfig(c.env);
    if (config.key === null || !config.enabled) {
      throw new ApiError('assistant_unavailable', 'the assistant is not set up on this server');
    }
    const contentType = c.req.header('Content-Type') ?? '';
    if (!/^application\/json\s*(;|$)/i.test(contentType)) {
      throw new ApiError('unsupported_media_type', 'expected application/json');
    }
    if (Number(c.req.header('Content-Length') ?? '0') > MAX_ASSISTANT_BODY_BYTES) {
      throw new ApiError('payload_too_large', `at most ${MAX_ASSISTANT_BODY_BYTES} bytes`);
    }
    let raw: Uint8Array;
    try {
      raw = await deps.readBody(c.req.raw, MAX_ASSISTANT_BODY_BYTES);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'payload_too_large') {
        throw new ApiError('payload_too_large', `at most ${MAX_ASSISTANT_BODY_BYTES} bytes`);
      }
      throw e;
    }
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw new ApiError('invalid_request', 'body is not valid JSON');
    }
    const req = parseAssistantRequest(json);

    const user = c.get('user');
    const usage = new AssistantUsage(c.env.DB);
    const now = deps.now();
    if ((await usage.spentToday(now)) >= config.budgetMicroUsd) {
      throw new ApiError('budget_exhausted', 'the assistant has used up today’s budget');
    }
    const limit = await usage.claim(user.id, now, config);
    if (limit !== null) {
      throw new ApiError(
        'rate_limited',
        limit === 'minute'
          ? `at most ${config.perMinute} requests a minute; wait a moment`
          : `at most ${config.perDay} requests a day`,
      );
    }

    const { body, usage: tokens } = await callModel(deps, config, config.key, req);
    if (tokens !== null) await usage.record(user.id, now, costMicroUsd(config.model, tokens));
    if (body.stop_reason === 'refusal') {
      throw new ApiError('assistant_failed', 'the assistant declined this request');
    }
    if (body.stop_reason === 'max_tokens') {
      throw new ApiError('assistant_failed', 'the answer was cut off; try a smaller request');
    }
    const text = (body.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
    const reply = parseAssistantReply(extractJson(text));
    if (!reply.ok) {
      console.error('assistant: unusable answer', reply.message);
      throw new ApiError('assistant_failed', 'the assistant answered in a form the app cannot use');
    }
    return c.json({
      ...reply.reply,
      usage: {
        input_tokens: tokens?.input_tokens ?? 0,
        output_tokens: tokens?.output_tokens ?? 0,
      },
    });
  });
}
