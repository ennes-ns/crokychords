/**
 * An in-memory community bank behind the `CommunityClient` interface (docs/specs/community-v1.md
 * §3), for the view and sync tests: own samples with their shares, the listed bank, takes, the
 * queue, reports, appeals and hard deletes (docs/specs/moderation-v1.md). `fail` makes the next
 * calls of a method reject.
 */
import type { SamplerId } from '../src/audio/instruments';
import type {
  CommunityClient,
  CommunityPage,
  CommunitySample,
  Decision,
  Me,
  OwnSample,
  QueueItem,
  QueueView,
  RejectReason,
  UploadMeta,
} from '../src/sync/community';
import { CommunityError } from '../src/sync/community';

export interface Call {
  method: string;
  args: unknown[];
}

let counter = 0;
/** A fresh UUID-shaped id. */
export function fakeId(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

export function listed(name: string, extra: Partial<CommunitySample> = {}): CommunitySample {
  return {
    id: fakeId(),
    name,
    tags: [],
    bytes: 1000,
    duration: 0.5,
    channels: 1,
    root: 57,
    owner: 'dusty',
    listed_at: '2026-10-21T10:00:00.000Z',
    own: false,
    ...extra,
  };
}

export class FakeCommunity implements CommunityClient {
  readonly calls: Call[] = [];
  readonly own = new Map<string, OwnSample & { sha: string; data: ArrayBuffer }>();
  bank: CommunitySample[] = [];
  /** Bytes of bank samples by id. */
  readonly files = new Map<string, ArrayBuffer>();
  queueItems: QueueItem[] = [];
  me_: Me = { handle: 'alice', maintainer: false };
  pageSize = 24;
  /** Method name → error the next call throws. */
  readonly fail = new Map<string, CommunityError>();

  #call(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
    const error = this.fail.get(method);
    if (error !== undefined) {
      this.fail.delete(method);
      throw error;
    }
  }

  named(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }

  me(): Promise<Me> {
    return this.#run(() => {
      this.#call('me');
      return { ...this.me_ };
    });
  }

  setHandle(handle: string | null): Promise<string> {
    return this.#run(() => {
      this.#call('setHandle', handle);
      this.me_.handle = handle ?? 'alice';
      return this.me_.handle;
    });
  }

  mine(): Promise<OwnSample[]> {
    return this.#run(() => {
      this.#call('mine');
      return [...this.own.values()].map(strip);
    });
  }

  upload(bytes: ArrayBuffer, meta: UploadMeta): Promise<OwnSample> {
    return this.#run(() => {
      this.#call('upload', bytes, meta);
      const existing = [...this.own.values()].find((s) => s.sha === meta.sha256);
      if (existing !== undefined) return strip(existing);
      const sample = {
        id: fakeId(),
        name: meta.name,
        tags: [],
        bytes: bytes.byteLength,
        type: meta.type,
        duration: meta.duration,
        channels: meta.channels,
        root: meta.root,
        created_at: '2026-10-21T10:00:00.000Z',
        share: null,
        refs: 0,
        sha: meta.sha256,
        data: bytes,
      };
      this.own.set(sample.id, sample);
      return strip(sample);
    });
  }

  remove(id: string): Promise<void> {
    return this.#run(() => {
      this.#call('remove', id);
      this.own.delete(id);
    });
  }

  share(
    id: string,
    options: { licence: true; name?: string; tags?: string[] },
  ): Promise<OwnSample> {
    return this.#run(() => {
      this.#call('share', id, options);
      const sample = this.own.get(id);
      if (sample === undefined) throw new CommunityError('rejected', 'not found', 'not_found');
      if (options.name !== undefined) sample.name = options.name;
      if (options.tags !== undefined) sample.tags = options.tags;
      sample.share = {
        state: 'pending',
        reason: null,
        shared_at: '2026-10-21T10:00:00.000Z',
        listed_at: null,
        unlisted_at: null,
        appealed_at: sample.share?.appealed_at ?? null,
      };
      return strip(sample);
    });
  }

  unshare(id: string): Promise<OwnSample> {
    return this.#run(() => {
      this.#call('unshare', id);
      const sample = this.own.get(id);
      if (sample === undefined) throw new CommunityError('rejected', 'not found', 'not_found');
      if (sample.share !== null) {
        sample.share = {
          ...sample.share,
          state: 'unlisted',
          unlisted_at: '2026-10-21T11:00:00.000Z',
        };
      }
      return strip(sample);
    });
  }

  browse(options: { q?: string; tag?: string; cursor?: string | null }): Promise<CommunityPage> {
    return this.#run(() => {
      this.#call('browse', options);
      const q = (options.q ?? '').toLowerCase();
      const matching = this.bank.filter(
        (s) =>
          s.name.toLowerCase().includes(q) &&
          (options.tag === undefined || options.tag === '' || s.tags.includes(options.tag)),
      );
      const from = options.cursor == null ? 0 : Number(options.cursor);
      const page = matching.slice(from, from + this.pageSize);
      const next = from + this.pageSize < matching.length ? String(from + this.pageSize) : null;
      return { samples: page, next };
    });
  }

  take(id: string, slot: SamplerId): Promise<CommunitySample> {
    return this.#run(() => {
      this.#call('take', id, slot);
      const sample = this.bank.find((s) => s.id === id);
      if (sample === undefined)
        throw new CommunityError(
          'rejected',
          'This sample is no longer in the community bank.',
          'not_listed',
        );
      return sample;
    });
  }

  release(id: string, slot: SamplerId): Promise<void> {
    return this.#run(() => {
      this.#call('release', id, slot);
    });
  }

  bytes(id: string): Promise<ArrayBuffer> {
    return this.#run(() => {
      this.#call('bytes', id);
      const bytes = this.files.get(id) ?? this.own.get(id)?.data;
      if (bytes === undefined) throw new CommunityError('rejected', 'gone', 'not_found');
      return bytes.slice(0);
    });
  }

  queue(state: QueueView = 'pending'): Promise<QueueItem[]> {
    return this.#run(() => {
      this.#call('queue', state);
      return this.queueItems.filter((i) =>
        state === 'reported' ? i.state === 'listed' && i.reports.open > 0 : i.state === state,
      );
    });
  }

  decide(id: string, decision: Decision): Promise<QueueItem> {
    return this.#run(() => {
      this.#call('decide', id, decision);
      const item = this.queueItems.find((i) => i.id === id);
      if (item === undefined) throw new CommunityError('rejected', 'no share', 'not_found');
      this.queueItems = this.queueItems.filter((i) => i.id !== id);
      return {
        ...item,
        state: decision.action === 'reject' ? 'rejected' : 'listed',
        reports: { open: 0, reasons: {} },
      };
    });
  }

  report(id: string, reason: RejectReason): Promise<void> {
    return this.#run(() => {
      this.#call('report', id, reason);
    });
  }

  appeal(id: string): Promise<OwnSample> {
    return this.#run(() => {
      this.#call('appeal', id);
      const sample = this.own.get(id);
      if (sample?.share?.state !== 'rejected' || sample.share.appealed_at !== null) {
        throw new CommunityError('rejected', 'A review can be requested only once.', 'conflict');
      }
      sample.share = { ...sample.share, state: 'pending', reason: null, appealed_at: 'now' };
      return strip(sample);
    });
  }

  hardDelete(id: string): Promise<void> {
    return this.#run(() => {
      this.#call('hardDelete', id);
      this.queueItems = this.queueItems.filter((i) => i.id !== id);
    });
  }

  sampleUrl(id: string): string {
    return `/api/samples/${id}`;
  }

  #run<T>(fn: () => T): Promise<T> {
    try {
      return Promise.resolve(fn());
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }
}

function strip(sample: OwnSample & { sha: string; data: ArrayBuffer }): OwnSample {
  return {
    id: sample.id,
    name: sample.name,
    tags: [...sample.tags],
    bytes: sample.bytes,
    type: sample.type,
    duration: sample.duration,
    channels: sample.channels,
    root: sample.root,
    created_at: sample.created_at,
    share: sample.share === null ? null : { ...sample.share },
    refs: sample.refs,
  };
}

export function queueItem(name: string, extra: Partial<QueueItem> = {}): QueueItem {
  return {
    ...listed(name),
    listed_at: null,
    state: 'pending',
    shared_at: '2026-10-21T09:00:00.000Z',
    owner_id: 'u-1',
    revision: 1,
    auto: null,
    reports: { open: 0, reasons: {} },
    appeal: null,
    ...extra,
  };
}
