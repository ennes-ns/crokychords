import { createSong } from '@crokychords/core';
import { describe, expect, it } from 'vitest';
import {
  AssistantError,
  HttpAssistantClient,
  OFFLINE_REASON,
  assistantVisible,
  unavailableClient,
} from '../src/assistant/client';

function client(responses: (Response | Error)[], online = true) {
  const calls: { url: string; init: RequestInit }[] = [];
  const c = new HttpAssistantClient({
    baseUrl: '/api',
    fetch: (url, init) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (next === undefined || next instanceof Error)
        return Promise.reject(next ?? new Error('x'));
      return Promise.resolve(next);
    },
    online: () => online,
  });
  return { c, calls };
}

const question = () => ({ request: 'hi', song: createSong(), selected: null, history: [] });
const error = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status });

describe('HttpAssistantClient', () => {
  it('status: available, not set up, offline, unreachable', async () => {
    expect(await client([Response.json({ available: true })]).c.status()).toEqual({
      available: true,
    });
    expect(await client([Response.json({ available: false })]).c.status()).toMatchObject({
      available: false,
      reason: expect.stringMatching(/not set up/),
    });
    expect(await client([], false).c.status()).toEqual({
      available: false,
      reason: OFFLINE_REASON,
    });
    expect(await client([new Error('down')]).c.status()).toMatchObject({ available: false });
    const { c, calls } = client([Response.json({ available: true })]);
    await c.status();
    expect(calls[0]?.url).toBe('/api/assistant');
  });

  it('ask posts the question as JSON and returns the answer', async () => {
    const { c, calls } = client([Response.json({ explanation: 'ok', commands: [{ op: 'undo' }] })]);
    expect(await c.ask(question())).toEqual({ explanation: 'ok', commands: [{ op: 'undo' }] });
    expect(calls[0]?.init.method).toBe('POST');
    expect(new Headers(calls[0]?.init.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      request: 'hi',
      selected: null,
    });
  });

  it.each([
    [
      error(429, 'rate_limited', 'at most 6 requests a minute; wait a moment'),
      'At most 6 requests a minute; wait a moment.',
    ],
    [
      error(429, 'budget_exhausted', 'x'),
      'The assistant has used up today’s budget. Try again tomorrow.',
    ],
    [error(503, 'assistant_unavailable', 'x'), 'The assistant is not set up on this server.'],
    [
      new Response('<html>sign in</html>', { status: 403 }),
      'Your sign-in has expired. Reload the page to sign in again.',
    ],
    [new Response('', { status: 500 }), 'The assistant failed (HTTP 500).'],
    [Response.json({ nope: true }), 'The assistant sent an answer the app cannot read.'],
  ])('turns a failure into a readable message (%#)', async (response, message) => {
    await expect(client([response]).c.ask(question())).rejects.toThrow(message);
  });

  it('fails fast offline and without a network', async () => {
    await expect(client([], false).c.ask(question())).rejects.toBeInstanceOf(AssistantError);
    await expect(client([new Error('down')]).c.ask(question())).rejects.toThrow(
      /cannot be reached/,
    );
    await expect(unavailableClient().ask(question())).rejects.toThrow(/online version/);
  });
});

describe('assistant visibility (issue #100)', () => {
  it('with the API: only when GET /assistant says enabled', async () => {
    expect(await client([Response.json({ enabled: true, available: true })]).c.enabled()).toBe(
      true,
    );
    expect(await client([Response.json({ enabled: false, available: false })]).c.enabled()).toBe(
      false,
    );
    expect(await client([Response.json({ available: true })]).c.enabled()).toBe(false);
    expect(await client([error(401, 'unauthorized', 'no')]).c.enabled()).toBe(false);
    expect(await client([new Error('down')]).c.enabled()).toBe(false);
    const on = client([Response.json({ enabled: true })]).c;
    expect(await assistantVisible({ VITE_ASSISTANT: 'off' }, on)).toBe(true);
    const off = client([Response.json({ enabled: false })]).c;
    expect(await assistantVisible({ VITE_ASSISTANT: 'on' }, off)).toBe(false);
  });

  it('without the API: hidden unless VITE_ASSISTANT=on', async () => {
    expect(await assistantVisible({}, null)).toBe(false);
    expect(await assistantVisible({ VITE_ASSISTANT: 'off' }, null)).toBe(false);
    expect(await assistantVisible({ VITE_ASSISTANT: 'on' }, null)).toBe(true);
  });
});
