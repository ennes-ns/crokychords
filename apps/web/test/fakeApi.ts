/**
 * A small in-memory model of the Worker API (docs/specs/api-v1.md) behind a fake `fetch`: versions,
 * If-Match, 409 with `current`, limits, and the failure modes the sync client must survive.
 */
import type { SaveRecord } from '../src/store/record';
import type { FetchLike, ResponseLike } from '../src/sync/http';

export type FakeMode =
  | 'ok'
  | 'offline' // fetch rejects
  | 'unauthorized' // 401 JSON
  | 'redirect' // Access login redirect (opaque with redirect: 'manual')
  | 'html' // a login page served with 200
  | 'error'; // 503

export interface FakeRequest {
  method: string;
  path: string;
  ifMatch: string | null;
}

function response(status: number, body?: unknown, type = 'application/json'): ResponseLike {
  return {
    status,
    type: 'basic',
    redirected: false,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? type : null) },
    json: () =>
      body === undefined ? Promise.reject(new SyntaxError('no body')) : Promise.resolve(body),
  };
}

function apiError(status: number, code: string, current?: unknown): ResponseLike {
  return response(status, {
    error: {
      code,
      message: code.replace(/_/g, ' '),
      ...(current !== undefined ? { current } : {}),
    },
  });
}

export class FakeApi {
  /** Stored records, as the server keeps them. */
  readonly saves = new Map<string, SaveRecord>();
  readonly requests: FakeRequest[] = [];
  mode: FakeMode = 'ok';
  /** Handle the next request, then lose its response (fetch rejects as if offline). */
  dropNextResponse = false;
  /** Runs before each request is handled (to interleave local edits with an in-flight request). */
  beforeHandle: ((method: string, path: string) => Promise<void>) | null = null;
  /** Ids whose GET returns a record that does not parse. */
  readonly corrupt = new Set<string>();
  maxSaves = 200;
  maxBytes = 262_144;
  #tick = 0;

  /** Server-side `updated_at`, increasing per write. */
  #now(): string {
    this.#tick++;
    return new Date(Date.UTC(2026, 9, 20, 13, 0, this.#tick)).toISOString();
  }

  meta(id: string): { id: string; version: number; updated_at: string; title: string } | null {
    const r = this.saves.get(id);
    return r === undefined
      ? null
      : { id: r.id, version: r.version, updated_at: r.updated_at, title: r.title };
  }

  /** Write a record as another device would (next version). */
  remoteWrite(record: SaveRecord): SaveRecord {
    const version = (this.saves.get(record.id)?.version ?? 0) + 1;
    const stored = { ...record, version, updated_at: this.#now() };
    this.saves.set(record.id, stored);
    return stored;
  }

  count(method: string): number {
    return this.requests.filter((r) => r.method === method).length;
  }

  readonly fetch: FetchLike = (url, init) => {
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const ifMatch = headers.get('If-Match');
    const path = url.replace(/^\/api/, '');
    this.requests.push({ method, path, ifMatch });
    switch (this.mode) {
      case 'offline':
        return Promise.reject(new TypeError('Failed to fetch'));
      case 'unauthorized':
        return Promise.resolve(apiError(401, 'unauthorized'));
      case 'redirect':
        return Promise.resolve({ ...response(0), type: 'opaqueredirect' });
      case 'html':
        return Promise.resolve(response(200, undefined, 'text/html; charset=utf-8'));
      case 'error':
        return Promise.resolve(apiError(503, 'internal'));
      case 'ok': {
        const hook = this.beforeHandle;
        const handled = (hook === null ? Promise.resolve() : hook(method, path)).then(() =>
          this.#handle(method, path, ifMatch, init.body),
        );
        if (!this.dropNextResponse) return handled;
        this.dropNextResponse = false;
        return handled.then(() => Promise.reject(new TypeError('Failed to fetch')));
      }
    }
  };

  #handle(method: string, path: string, ifMatchHeader: string | null, body: unknown): ResponseLike {
    if (method === 'GET' && path === '/saves') {
      const saves = [...this.saves.keys()].map((id) => this.meta(id));
      return response(200, { saves });
    }
    const match = /^\/saves\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    const id = match?.[1];
    if (id === undefined) return apiError(404, 'not_found');
    const ifMatch = ifMatchHeader === null ? null : Number(/^"(\d+)"$/.exec(ifMatchHeader)?.[1]);
    if (ifMatch !== null && Number.isNaN(ifMatch)) return apiError(400, 'invalid_request');
    const stored = this.saves.get(id);
    const storedVersion = stored?.version ?? 0;
    if (method === 'GET' && stored !== undefined && this.corrupt.has(id)) {
      return response(200, { ...stored, song: 42 });
    }
    if (method === 'GET')
      return stored === undefined ? apiError(404, 'not_found') : response(200, stored);
    if (method === 'DELETE') {
      if (stored === undefined) return apiError(404, 'not_found');
      if (ifMatch !== null && ifMatch !== storedVersion) {
        return apiError(409, 'conflict', this.meta(id));
      }
      this.saves.delete(id);
      return response(204);
    }
    if (method === 'PUT') {
      const text = typeof body === 'string' ? body : '';
      if (text.length > this.maxBytes) return apiError(413, 'payload_too_large');
      const record = JSON.parse(text) as SaveRecord;
      const base = ifMatch ?? record.version - 1;
      if (record.id !== id || record.version !== base + 1) return apiError(400, 'invalid_request');
      if (storedVersion !== base) return apiError(409, 'conflict', this.meta(id));
      if (stored === undefined && this.saves.size >= this.maxSaves) {
        return apiError(403, 'save_limit_reached');
      }
      const saved = { ...record, updated_at: this.#now() };
      this.saves.set(id, saved);
      return response(stored === undefined ? 201 : 200, saved);
    }
    return apiError(404, 'not_found');
  }
}
