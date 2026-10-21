/** The community bank's HTTP client (docs/specs/community-v1.md §4.1) against a fake fetch. */
import { describe, expect, it } from 'vitest';
import type { CommunityResponse } from '../src/sync/community';
import {
  CommunityError,
  HttpCommunityClient,
  OFFLINE_MESSAGE,
  SIGNED_OUT_MESSAGE,
  parseQueueItem,
  rejectLabel,
  sha256Hex,
  uploadType,
} from '../src/sync/community';

interface Sent {
  url: string;
  init: RequestInit;
}

function respond(status: number, body?: unknown, type = 'application/json'): CommunityResponse {
  return {
    status,
    type: 'basic',
    redirected: false,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? type : null) },
    json: () =>
      body === undefined ? Promise.reject(new SyntaxError('none')) : Promise.resolve(body),
    arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
  };
}

const own = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Kick',
  tags: ['drums'],
  bytes: 10,
  type: 'audio/wav',
  duration: 0.5,
  channels: 1,
  root: 48,
  created_at: '2026-10-21T10:00:00.000Z',
  share: {
    state: 'pending',
    reason: null,
    shared_at: '2026-10-21T10:00:00.000Z',
    listed_at: null,
    unlisted_at: null,
  },
  refs: 0,
};
const listed = {
  id: own.id,
  name: own.name,
  tags: own.tags,
  bytes: own.bytes,
  duration: own.duration,
  channels: own.channels,
  root: own.root,
  owner: 'dusty',
  listed_at: '2026-10-21T10:00:00.000Z',
  own: false,
};

function client(answer: (sent: Sent) => CommunityResponse | 'throw', online = true) {
  const sent: Sent[] = [];
  const c = new HttpCommunityClient({
    baseUrl: '/api/',
    online: () => online,
    fetch: (url, init) => {
      sent.push({ url, init });
      const a = answer({ url, init });
      return a === 'throw' ? Promise.reject(new TypeError('network')) : Promise.resolve(a);
    },
  });
  return { c, sent };
}

describe('HttpCommunityClient: requests', () => {
  it('uploads raw bytes with the metadata in the query', async () => {
    const { c, sent } = client(() => respond(201, { sample: own }));
    const bytes = new Uint8Array([1, 2]).buffer;
    const sample = await c.upload(bytes, {
      name: 'Kick',
      duration: 0.51234,
      channels: 1,
      root: 48,
      sha256: 'ab'.repeat(32),
      type: 'audio/wav',
    });
    expect(sample.share?.state).toBe('pending');
    const { url, init } = sent[0] ?? { url: '', init: {} };
    expect(url).toBe(
      `/api/samples?name=Kick&duration=0.512&channels=1&root=48&sha256=${'ab'.repeat(32)}`,
    );
    expect(init.method).toBe('POST');
    expect(init.body).toBe(bytes);
    expect(new Headers(init.headers).get('Content-Type')).toBe('audio/wav');
    expect(init.credentials).toBe('include');
    expect(init.redirect).toBe('manual');
  });

  it('shares with the licence, browses with a query, takes into a slot', async () => {
    const { c, sent } = client(({ url }) => {
      if (url.includes('/community')) return respond(200, { samples: [listed], next: 'abc' });
      if (url.endsWith('/take')) return respond(200, { sample: listed });
      return respond(200, { sample: own });
    });
    await c.share(own.id, { licence: true, name: 'Kick', tags: ['drums'] });
    expect(JSON.parse(String(sent[0]?.init.body))).toEqual({
      licence: true,
      name: 'Kick',
      tags: ['drums'],
    });
    const page = await c.browse({ q: ' kick ', tag: 'Drums', cursor: 'xyz' });
    expect(sent[1]?.url).toBe('/api/community?q=kick&tag=drums&cursor=xyz');
    expect(page).toEqual({ samples: [listed], next: 'abc' });
    await c.browse({});
    expect(sent[2]?.url).toBe('/api/community');
    await c.take(own.id, 'sampler-3');
    expect(sent[3]?.url).toBe(`/api/samples/${own.id}/take`);
    expect(JSON.parse(String(sent[3]?.init.body))).toEqual({ slot: 'sampler-3' });
    await c.unshare(own.id);
    expect(sent[4]?.init.method).toBe('DELETE');
    expect(sent[4]?.url).toBe(`/api/samples/${own.id}/share`);
    expect(c.sampleUrl(own.id)).toBe(`/api/samples/${own.id}`);
  });

  it('reads me, the own list, bytes, the queue and decisions', async () => {
    const item = {
      revision: 2,
      ...listed,
      listed_at: null,
      state: 'pending',
      shared_at: own.created_at,
      owner_id: 'u1',
    };
    const { c, sent } = client(({ url }) => {
      if (url.endsWith('/me'))
        return respond(200, { handle: 'alice', maintainer: true, email: 'x' });
      if (url.endsWith('/me/handle')) return respond(200, { handle: 'new' });
      if (url.endsWith('/samples')) return respond(200, { samples: [own] });
      if (url.includes('/queue?state=')) return respond(200, { items: [item] });
      if (url.includes('/moderation/')) return respond(200, { item: { ...item, state: 'listed' } });
      if (url.endsWith(own.id)) return respond(200, undefined, 'audio/wav');
      return respond(204);
    });
    expect(await c.me()).toEqual({ handle: 'alice', maintainer: true });
    expect(await c.setHandle(null)).toBe('new');
    expect(JSON.parse(String(sent[1]?.init.body))).toEqual({ handle: null });
    expect((await c.mine())[0]?.id).toBe(own.id);
    expect(new Uint8Array(await c.bytes(own.id))).toEqual(new Uint8Array([1, 2, 3]));
    expect((await c.queue())[0]).toMatchObject({ state: 'pending', revision: 2 });
    expect(sent[4]?.url).toBe('/api/moderation/queue?state=pending');
    await c.queue('listed');
    expect(sent[5]?.url).toBe('/api/moderation/queue?state=listed');
    const decided = await c.decide(own.id, { action: 'reject', reason: 'speech', revision: 2 });
    expect(decided.state).toBe('listed');
    expect(JSON.parse(String(sent[6]?.init.body))).toEqual({
      action: 'reject',
      reason: 'speech',
      revision: 2,
    });
    await c.release(own.id, 'sampler-4');
    expect(sent[7]?.init.method).toBe('DELETE');
    expect(sent[7]?.url).toBe(`/api/samples/${own.id}/take?slot=sampler-4`);
  });
});

describe('HttpCommunityClient: moderation (docs/specs/moderation-v1.md)', () => {
  it('reports, appeals, deletes for good and asks for the reported view', async () => {
    const { c, sent } = client(({ url }) => {
      if (url.endsWith('/appeal'))
        return respond(200, { sample: { ...own, share: { ...own.share, appealed_at: 'x' } } });
      if (url.includes('/queue?state=')) return respond(200, { items: [] });
      return respond(200, { reported: true, deleted: true });
    });
    await c.report(own.id, 'violence');
    expect(sent[0]?.url).toBe(`/api/samples/${own.id}/report`);
    expect(sent[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(sent[0]?.init.body))).toEqual({ reason: 'violence' });
    const appealed = await c.appeal(own.id);
    expect(sent[1]?.url).toBe(`/api/samples/${own.id}/appeal`);
    expect(appealed.share?.appealed_at).toBe('x');
    await c.hardDelete(own.id);
    expect(sent[2]?.url).toBe(`/api/moderation/${own.id}/delete`);
    expect(JSON.parse(String(sent[2]?.init.body))).toEqual({ confirm: own.id });
    await c.queue('reported');
    expect(sent[3]?.url).toBe('/api/moderation/queue?state=reported');
  });

  it('parses the recommendation, reports and appeal of a queue item, tolerating junk', () => {
    const base = {
      ...listed,
      listed_at: null,
      state: 'pending',
      shared_at: own.created_at,
      owner_id: 'u1',
      revision: 1,
    };
    const item = parseQueueItem({
      ...base,
      auto: {
        verdict: 'flag:speech',
        checked_at: 'now',
        current: true,
        scores: { Speech: 0.9, bad: 'x' },
        reasons: ['speech: words', 3],
        notes: [],
        peaks: [0.1, 'x', 1],
        models: { asr: 'w' },
        policy: 'moderation-v1/1',
      },
      reports: { open: 2, reasons: { hate: 2 } },
      appeal: { at: 'then', of: 'speech' },
    });
    expect(item.auto).toEqual({
      verdict: 'flag:speech',
      checked_at: 'now',
      current: true,
      scores: { Speech: 0.9 },
      reasons: ['speech: words'],
      notes: [],
      peaks: [0.1, 1],
      models: { asr: 'w' },
      policy: 'moderation-v1/1',
    });
    expect(item.reports).toEqual({ open: 2, reasons: { hate: 2 } });
    expect(item.appeal).toEqual({ at: 'then', of: 'speech' });
    const bare = parseQueueItem(base);
    expect(bare.auto).toBeNull();
    expect(bare.reports).toEqual({ open: 0, reasons: {} });
    expect(bare.appeal).toBeNull();
    expect(parseQueueItem({ ...base, auto: { verdict: 3 } }).auto).toBeNull();
  });

  it('words the report limit', async () => {
    const { c } = client(() =>
      respond(429, { error: { code: 'rate_limited', message: 'at most 20 reports per day' } }),
    );
    await expect(c.report(own.id, 'hate')).rejects.toMatchObject({
      kind: 'rejected',
      message: 'You have sent many reports today. Thank you; try again tomorrow.',
    });
  });
});

describe('HttpCommunityClient: failures', () => {
  const code = async (p: Promise<unknown>): Promise<[string, string | null, string]> => {
    try {
      await p;
    } catch (e) {
      if (e instanceof CommunityError) return [e.kind, e.code, e.message];
      throw e;
    }
    throw new Error('did not fail');
  };
  const error = (status: number, c: string, message = c) =>
    respond(status, { error: { code: c, message } });

  it('classifies network, sign-in, limits and server errors', async () => {
    expect(await code(client(() => 'throw').c.mine())).toEqual([
      'offline',
      null,
      'The server cannot be reached.',
    ]);
    expect(await code(client(() => respond(200, {}), false).c.mine())).toEqual([
      'offline',
      null,
      OFFLINE_MESSAGE,
    ]);
    expect((await code(client(() => respond(302)).c.mine()))[0]).toBe('signed-out');
    expect(await code(client(() => error(401, 'unauthorized')).c.mine())).toEqual([
      'signed-out',
      'unauthorized',
      SIGNED_OUT_MESSAGE,
    ]);
    expect((await code(client(() => respond(403, undefined, 'text/html')).c.mine()))[0]).toBe(
      'signed-out',
    );
    expect(await code(client(() => error(403, 'sample_limit_reached')).c.mine())).toEqual([
      'rejected',
      'sample_limit_reached',
      'You have reached the limit on the server (50 samples or 100 MB). Delete samples you no longer use in the Community tab.',
    ]);
    expect((await code(client(() => error(403, 'forbidden')).c.queue()))[0]).toBe('rejected');
    expect(await code(client(() => error(409, 'not_listed')).c.take('x', 'sampler-1'))).toEqual([
      'rejected',
      'not_listed',
      'This sample is no longer in the community bank.',
    ]);
    expect(
      (await code(client(() => error(400, 'invalid_request', 'tags: too many')).c.mine()))[2],
    ).toBe('Tags: too many.');
    expect((await code(client(() => respond(503)).c.mine()))[0]).toBe('server');
    expect((await code(client(() => respond(200, {}, 'text/html')).c.mine()))[0]).toBe('server');
    expect((await code(client(() => respond(200, { samples: [{ id: 1 }] })).c.mine()))[0]).toBe(
      'server',
    );
  });
});

describe('helpers', () => {
  it('maps types and file names to the accepted upload types', () => {
    expect(uploadType('audio/x-wav', 'a')).toBe('audio/wav');
    expect(uploadType('audio/wave', 'a')).toBe('audio/wav');
    expect(uploadType('audio/mp3', 'a')).toBe('audio/mpeg');
    expect(uploadType('audio/x-flac', 'a')).toBe('audio/flac');
    expect(uploadType('', 'Kick.WAV')).toBe('audio/wav');
    expect(uploadType('', 'pad.oga')).toBe('audio/ogg');
    expect(uploadType('audio/aac', 'x.m4a')).toBeNull();
    expect(uploadType('', 'noext')).toBeNull();
  });

  it('hashes with SHA-256 and labels the rejection categories', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc').buffer)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(rejectLabel('speech')).toBe('speech');
    expect(rejectLabel('copyright')).toBe('someone else’s recording');
    expect(rejectLabel('new-kind')).toBe('new-kind');
    expect(rejectLabel(null)).toBe('not accepted');
  });
});
