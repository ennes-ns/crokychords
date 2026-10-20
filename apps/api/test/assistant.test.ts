import { ASSISTANT_OPS, serializeSong } from '@crokychords/core';
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { Env } from '../src/app';
import {
  ANTHROPIC_URL,
  FALLBACK_BETA,
  assistantConfig,
  costMicroUsd,
  parseAssistantRequest,
} from '../src/assistant';
import { commandLine, systemPrompt } from '../src/assistantPrompt';
import { ApiError } from '../src/errors';
import { ORIGIN, authed, makeKey, signToken, staticJwks, testSong } from './helpers';
import type { ErrorJson, TestKey } from './helpers';

let key: TestKey;
let token: string;

beforeAll(async () => {
  key = await makeKey('assistant-key');
  token = await signToken({ key, email: 'composer@example.test' });
});

interface Sent {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

type Reply = { status?: number; json: unknown } | 'throw';

const answer = (explanation: string, commands: unknown[] = [], stop = 'end_turn') => ({
  json: {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    stop_reason: stop,
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: JSON.stringify({ explanation, commands }) },
    ],
    usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 2000 },
  },
});

/** The app with a model API that answers `replies` in turn and records what it was sent. */
function setup(vars: Partial<Env> = {}, replies: Reply[] = [answer('Done.')]) {
  const sent: Sent[] = [];
  let n = 0;
  const app = createApp({
    jwks: () => staticJwks([key.jwk]),
    fetch: (url, init) => {
      const reply = replies[Math.min(n, replies.length - 1)];
      n += 1;
      sent.push({
        url,
        headers: new Headers(init.headers),
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      if (reply === undefined || reply === 'throw') return Promise.reject(new Error('timeout'));
      return Promise.resolve(Response.json(reply.json, { status: reply.status ?? 200 }));
    },
  });
  const bindings = {
    ...env,
    ANTHROPIC_API_KEY: 'test-key-not-real',
    ASSISTANT_ENABLED: 'true',
    ...vars,
  };
  const request = (path: string, init: RequestInit = {}, as = token) =>
    Promise.resolve(app.request(`https://api.example.test${path}`, authed(as, init), bindings));
  const ask = (body: unknown, as = token) =>
    request(
      '/api/assistant',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      },
      as,
    );
  return { sent, request, ask };
}

const valid = () => ({ request: 'make the second half darker', song: testSong(), selected: 2 });

async function code(res: Response): Promise<string> {
  return ((await res.json()) as ErrorJson).error.code;
}

describe('GET /api/assistant', () => {
  it('reports availability, the model and the limits', async () => {
    const { request } = setup();
    const res = await request('/api/assistant');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: true,
      available: true,
      model: 'claude-sonnet-5-5',
      limits: { per_minute: 6, per_day: 50 },
      used_today: 0,
    });
  });

  it('is unavailable without a key', async () => {
    const { request } = setup({ ANTHROPIC_API_KEY: '' });
    expect(await (await request('/api/assistant')).json()).toMatchObject({
      enabled: false,
      available: false,
    });
  });

  it('is disabled unless ASSISTANT_ENABLED is "true" (the wrangler.toml default is "false")', async () => {
    expect(env.ASSISTANT_ENABLED).toBe('false');
    for (const value of ['false', '', 'yes']) {
      const { request } = setup({ ASSISTANT_ENABLED: value });
      expect(await (await request('/api/assistant')).json()).toMatchObject({
        enabled: false,
        available: false,
      });
    }
  });

  it('needs an Access token like every API route', async () => {
    const { request } = setup();
    const forger = await makeKey('assistant-key');
    const forged = await signToken({ key: forger, email: 'composer@example.test' });
    expect((await request('/api/assistant', {}, forged)).status).toBe(401);
  });
});

describe('POST /api/assistant', () => {
  it('answers with the explanation and the commands, and sends the model a full request', async () => {
    const commands = [{ op: 'replaceChord', index: 2, token: 'bVI' }];
    const { ask, sent } = setup({}, [answer('Borrowed bVI darkens the end.', commands)]);
    const history = [
      { role: 'user', text: 'add a chord' },
      { role: 'assistant', text: 'Added IV.' },
    ];
    const request = valid();
    const res = await ask({ ...request, history });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      explanation: 'Borrowed bVI darkens the end.',
      commands,
      usage: { input_tokens: 1200, output_tokens: 300 },
    });

    expect(sent).toHaveLength(1);
    const [call] = sent;
    expect(call?.url).toBe(ANTHROPIC_URL);
    expect(call?.headers.get('x-api-key')).toBe('test-key-not-real');
    expect(call?.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(call?.headers.get('anthropic-beta')).toBe(FALLBACK_BETA);
    const body = call?.body ?? {};
    expect(body).toMatchObject({
      model: 'claude-sonnet-5-5',
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low', format: { type: 'json_schema' } },
      fallbacks: 'default',
    });
    expect(body['system']).toEqual([
      { type: 'text', text: systemPrompt(), cache_control: { type: 'ephemeral' } },
    ]);
    const messages = body['messages'] as { role: string; content: string }[];
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[2]?.content).toContain(serializeSong(request.song));
    expect(messages[2]?.content).toContain('Selected chord index: 2 (vi)');
    expect(messages[2]?.content).toContain('Request: make the second half darker');
  });

  it('a question gets an explanation and no commands', async () => {
    const { ask } = setup({}, [answer('I–V–vi–IV, the axis progression.')]);
    const res = await ask({ request: 'what is this called?', song: testSong() });
    expect(await res.json()).toMatchObject({ commands: [] });
  });

  it('can ask for plain-text JSON and without server-side fallback', async () => {
    const reply = answer('ok');
    const json = reply.json;
    json.content[1] = { type: 'text', text: `Here you go:\n${json.content[1]?.text ?? ''}` };
    const { ask, sent } = setup({ ASSISTANT_OUTPUT: 'text', ASSISTANT_FALLBACKS: '' }, [reply]);
    expect((await ask(valid())).status).toBe(200);
    const body = sent[0]?.body ?? {};
    expect(body['output_config']).toEqual({ effort: 'low' });
    expect(body['fallbacks']).toBeUndefined();
    expect(sent[0]?.headers.get('anthropic-beta')).toBeNull();
  });

  it('is unavailable without a key, before the body is even read', async () => {
    const { ask, sent } = setup({ ANTHROPIC_API_KEY: '' });
    const res = await ask('not json');
    expect(res.status).toBe(503);
    expect(await code(res)).toBe('assistant_unavailable');
    expect(sent).toHaveLength(0);
  });

  it('is unavailable while ASSISTANT_ENABLED is off, even with a key', async () => {
    const { ask, sent } = setup({ ASSISTANT_ENABLED: 'false' });
    const res = await ask('not json');
    expect(res.status).toBe(503);
    expect(await code(res)).toBe('assistant_unavailable');
    expect(sent).toHaveLength(0);
  });

  it.each([
    ['not json', 'invalid_request'],
    [{ song: testSong() }, 'invalid_request'],
    [{ request: '   ', song: testSong() }, 'invalid_request'],
    [{ request: 'x'.repeat(2001), song: testSong() }, 'invalid_request'],
    [{ request: 'hi', song: { schema: 9 } }, 'invalid_request'],
    [{ request: 'hi', song: testSong(), selected: 4 }, 'invalid_request'],
    [{ request: 'hi', song: testSong(), extra: 1 }, 'invalid_request'],
    [
      { request: 'hi', song: testSong(), history: [{ role: 'assistant', text: 'x' }] },
      'invalid_request',
    ],
    [
      { request: 'hi', song: testSong(), history: [{ role: 'user', text: 'x' }] },
      'invalid_request',
    ],
  ])('refuses bad body %#', async (body, expected) => {
    const { ask, sent } = setup();
    const res = await ask(body);
    expect(res.status).toBe(400);
    expect(await code(res)).toBe(expected);
    expect(sent).toHaveLength(0);
  });

  it('wants JSON and a bounded body', async () => {
    const { request } = setup();
    const text = await request('/api/assistant', { method: 'POST', body: '{}' });
    expect(text.status).toBe(415);
    const big = await request('/api/assistant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request: 'x', song: testSong(), pad: 'x'.repeat(300_000) }),
    });
    expect(big.status).toBe(413);
  });

  it('limits requests per minute and per day', async () => {
    const minute = setup({ ASSISTANT_USER_MINUTE_REQUESTS: '2' });
    expect((await minute.ask(valid())).status).toBe(200);
    expect((await minute.ask(valid())).status).toBe(200);
    const third = await minute.ask(valid());
    expect(third.status).toBe(429);
    expect(await code(third)).toBe('rate_limited');
    expect(minute.sent).toHaveLength(2);

    const other = await signToken({ key, email: 'other@example.test' });
    const day = setup({ ASSISTANT_USER_DAILY_REQUESTS: '1' });
    expect((await day.ask(valid(), other)).status).toBe(200);
    const again = await day.ask(valid(), other);
    expect(again.status).toBe(429);
    expect(((await again.json()) as ErrorJson).error.message).toContain('a day');
    const status = await day.request('/api/assistant', {}, other);
    expect(await status.json()).toMatchObject({ used_today: 1 });
  });

  it('stops for everyone once the budget of the day is spent', async () => {
    const { ask, request } = setup({ ASSISTANT_DAILY_BUDGET_USD: '0.001' });
    expect((await ask(valid())).status).toBe(200);
    const over = await ask(valid());
    expect(over.status).toBe(429);
    expect(await code(over)).toBe('budget_exhausted');
    expect(await (await request('/api/assistant')).json()).toMatchObject({ available: false });
  });

  it.each([
    [answer('no', [], 'refusal'), 502, 'assistant_failed'],
    [answer('cut', [], 'max_tokens'), 502, 'assistant_failed'],
    [answer('bad', [{ op: 'play' }]), 502, 'assistant_failed'],
    [answer('bad', [{ op: 'setTempo', bpm: 5 }]), 502, 'assistant_failed'],
    [
      { json: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'no json here' }] } },
      502,
      'assistant_failed',
    ],
    [{ status: 400, json: { error: { type: 'invalid_request_error' } } }, 502, 'assistant_failed'],
    [
      { status: 401, json: { error: { type: 'authentication_error' } } },
      503,
      'assistant_unavailable',
    ],
    [{ status: 429, json: { error: { type: 'rate_limit_error' } } }, 503, 'assistant_busy'],
    [{ status: 529, json: { error: { type: 'overloaded_error' } } }, 503, 'assistant_busy'],
    ['throw', 503, 'assistant_busy'],
  ] as [Reply, number, string][])(
    'turns model failure %# into an error',
    async (reply, status, expected) => {
      const { ask } = setup({}, [reply]);
      const res = await ask(valid());
      expect(res.status).toBe(status);
      expect(await code(res)).toBe(expected);
    },
  );

  it('allows POST from the app origin in CORS', async () => {
    const { request } = setup();
    const res = await request('/api/assistant', {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });
});

describe('assistant helpers', () => {
  it('reads its configuration with defaults for missing or bad values', () => {
    expect(assistantConfig({ DB: env.DB })).toEqual({
      enabled: false,
      key: null,
      model: 'claude-sonnet-5-5',
      budgetMicroUsd: 1_000_000,
      perDay: 50,
      perMinute: 6,
      structured: true,
      fallbacks: true,
    });
    expect(
      assistantConfig({
        DB: env.DB,
        ANTHROPIC_API_KEY: ' k ',
        ASSISTANT_DAILY_BUDGET_USD: 'lots',
        ASSISTANT_USER_DAILY_REQUESTS: '-3',
        ASSISTANT_MODEL: 'claude-haiku-5-5',
      }),
    ).toMatchObject({
      enabled: false,
      key: 'k',
      budgetMicroUsd: 1_000_000,
      perDay: 50,
      model: 'claude-haiku-5-5',
    });
    expect(
      assistantConfig({ DB: env.DB, ANTHROPIC_API_KEY: 'k', ASSISTANT_ENABLED: 'true' }).enabled,
    ).toBe(true);
    expect(assistantConfig({ DB: env.DB, ASSISTANT_ENABLED: 'true' }).enabled).toBe(false);
  });

  it('estimates the cost per model, unknown models at the highest rate', () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 100_000 };
    expect(costMicroUsd('claude-sonnet-5-5', usage)).toBe(3_000_000);
    expect(
      costMicroUsd('claude-sonnet-5-5', { ...usage, cache_read_input_tokens: 1_000_000 }),
    ).toBe(3_200_000);
    expect(costMicroUsd('some-new-model', usage)).toBe(15_000_000);
  });

  it('parses a request into a validated song', () => {
    const req = parseAssistantRequest({ request: ' hi ', song: testSong(), selected: null });
    expect(req).toMatchObject({ request: 'hi', selected: null, history: [] });
    expect(req.song.schema).toBe(4);
    expect(() => parseAssistantRequest({ request: 'hi', song: [] })).toThrow(ApiError);
  });

  it('the system prompt lists every assistant command with its arguments', () => {
    const prompt = systemPrompt();
    for (const op of ASSISTANT_OPS) expect(prompt).toContain(commandLine(op));
    expect(commandLine('replaceChord')).toBe(
      '- replaceChord { index: integer, token: string, beats?: number }: Replace the token of chord `index` (and its length when `beats` is given).',
    );
    expect(commandLine('setChords')).toContain('chords: [{ token, beats }]');
    expect(prompt).not.toContain('"play"');
  });
});
