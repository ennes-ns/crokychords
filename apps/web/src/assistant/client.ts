/**
 * The assistant's backend client (docs/specs/assistant-v1.md §B2): `GET /api/assistant` for
 * availability and `POST /api/assistant` for an answer. Every failure becomes an
 * `AssistantError` with a message the panel can show as is.
 */
import type { Song } from '@crokychords/core';

export interface AssistantTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface AssistantQuestion {
  request: string;
  song: Song;
  selected: number | null;
  history: AssistantTurn[];
}

export interface AssistantAnswer {
  explanation: string;
  /** Not trusted: the panel checks them with the command contract before showing them. */
  commands: unknown[];
}

export type AssistantStatus = { available: true } | { available: false; reason: string };

export interface AssistantClient {
  status(): Promise<AssistantStatus>;
  ask(question: AssistantQuestion): Promise<AssistantAnswer>;
}

export class AssistantError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AssistantError';
    this.code = code;
  }
}

/** What the panel says for an error code of the API. */
const MESSAGES: Record<string, string> = {
  assistant_unavailable: 'The assistant is not set up on this server.',
  budget_exhausted: 'The assistant has used up today’s budget. Try again tomorrow.',
  assistant_busy: 'The assistant is busy. Try again in a moment.',
  unauthorized: 'Your sign-in has expired. Reload the page to sign in again.',
  payload_too_large: 'This song is too large to send to the assistant.',
};

export const NO_SERVER_REASON =
  'The assistant runs on the server: it works in the online version of Croky Chords.';
export const OFFLINE_REASON = 'You are offline, so the assistant is unavailable.';

/** A client for builds without the API: always unavailable. */
export function unavailableClient(reason: string = NO_SERVER_REASON): AssistantClient {
  return {
    status: () => Promise.resolve({ available: false, reason }),
    ask: () => Promise.reject(new AssistantError('assistant_unavailable', reason)),
  };
}

export interface HttpAssistantOptions {
  /** API base without a trailing slash, e.g. '/api'. */
  baseUrl: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  online?: () => boolean;
}

async function errorOf(response: Response): Promise<AssistantError> {
  let code = 'internal';
  let message = '';
  try {
    const body: unknown = await response.json();
    const error: unknown =
      typeof body === 'object' && body !== null ? Reflect.get(body, 'error') : null;
    if (typeof error === 'object' && error !== null) {
      const c: unknown = Reflect.get(error, 'code');
      const m: unknown = Reflect.get(error, 'message');
      if (typeof c === 'string') code = c;
      if (typeof m === 'string') message = m;
    }
  } catch {
    // Not JSON (a proxy or Access page): the status decides.
    if (response.status === 401 || response.status === 403) code = 'unauthorized';
  }
  const text =
    MESSAGES[code] ??
    (message !== ''
      ? `${message.charAt(0).toUpperCase()}${message.slice(1)}.`
      : `The assistant failed (HTTP ${response.status}).`);
  return new AssistantError(code, text);
}

export class HttpAssistantClient implements AssistantClient {
  readonly #options: HttpAssistantOptions;

  constructor(options: HttpAssistantOptions) {
    this.#options = options;
  }

  get #offline(): boolean {
    return this.#options.online !== undefined && !this.#options.online();
  }

  async status(): Promise<AssistantStatus> {
    if (this.#offline) return { available: false, reason: OFFLINE_REASON };
    let response: Response;
    try {
      response = await this.#options.fetch(`${this.#options.baseUrl}/assistant`, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
    } catch {
      return { available: false, reason: 'The server cannot be reached right now.' };
    }
    if (!response.ok) return { available: false, reason: (await errorOf(response)).message };
    const body: unknown = await response.json().catch(() => null);
    const available =
      typeof body === 'object' && body !== null && Reflect.get(body, 'available') === true;
    return available
      ? { available: true }
      : { available: false, reason: MESSAGES['assistant_unavailable'] ?? '' };
  }

  async ask(question: AssistantQuestion): Promise<AssistantAnswer> {
    if (this.#offline) throw new AssistantError('offline', OFFLINE_REASON);
    let response: Response;
    try {
      response = await this.#options.fetch(`${this.#options.baseUrl}/assistant`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(question),
      });
    } catch {
      throw new AssistantError('network', 'The server cannot be reached right now.');
    }
    if (!response.ok) throw await errorOf(response);
    const body: unknown = await response.json().catch(() => null);
    const explanation: unknown =
      typeof body === 'object' && body !== null ? Reflect.get(body, 'explanation') : null;
    const commands: unknown =
      typeof body === 'object' && body !== null ? Reflect.get(body, 'commands') : null;
    if (typeof explanation !== 'string' || !Array.isArray(commands)) {
      throw new AssistantError(
        'assistant_failed',
        'The assistant sent an answer the app cannot read.',
      );
    }
    return { explanation, commands: commands as unknown[] };
  }
}
