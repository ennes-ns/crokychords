/**
 * D1 and R2 access of the community bank (docs/specs/community-v1.md §1–§3): samples, shares,
 * the slots that reference a taken sample, handles. Every state change is one conditional
 * statement (or one D1 batch), so concurrent requests cannot move a share past its rules.
 */

export type ShareState = 'pending' | 'listed' | 'unlisted' | 'rejected';

/** Rejection categories the owner sees (docs/specs/community-v1.md §2). */
export const REJECT_REASONS = [
  'speech',
  'sexual',
  'violence',
  'hate',
  'copyright',
  'loudness',
  'quality',
  'personal',
  'other',
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export const SAMPLER_SLOTS = [
  'sampler-1',
  'sampler-2',
  'sampler-3',
  'sampler-4',
  'sampler-5',
  'sampler-6',
  'sampler-7',
  'sampler-8',
] as const;
export type SlotId = (typeof SAMPLER_SLOTS)[number];

/** Id of the licence text a share acknowledges (docs/specs/community-v1.md §6). */
export const LICENCE_ID = 'community-v1';

export const COMMUNITY_LIMITS = {
  /** Largest upload (bytes). */
  maxSampleBytes: 10 * 1024 * 1024,
  /** Samples per owner. */
  maxSamples: 50,
  /** Sum of the owner's sample sizes (bytes). */
  maxTotalBytes: 100 * 1024 * 1024,
  pageSize: 24,
  /** Refs per user (8 slots on a handful of devices). */
  maxRefs: 64,
  queueSize: 100,
  maxNameLength: 64,
  maxTags: 5,
  maxQueryLength: 64,
  minDuration: 0.01,
  maxDuration: 30,
} as const;

/** R2 key of a sample's bytes: once per content. */
export function sampleKey(sha256: string): string {
  return `samples/${sha256}`;
}

export interface SampleRow {
  id: string;
  owner_id: string;
  sha256: string;
  bytes: number;
  type: string;
  duration: number;
  channels: number;
  name: string;
  tags: string;
  root: number;
  created_at: string;
}

interface ShareColumns {
  state: ShareState | null;
  reason: string | null;
  shared_at: string | null;
  listed_at: string | null;
  unlisted_at: string | null;
  appealed_at: string | null;
}

interface QueueColumns {
  auto_verdict: string | null;
  auto_detail: string | null;
  auto_revision: number | null;
  auto_checked_at: string | null;
  open_reports: number;
  /** Reasons of the open reports, space separated. */
  report_reasons: string | null;
}

interface OwnerColumns {
  owner_handle: string | null;
  revision: number | null;
}

type OwnRow = SampleRow & ShareColumns & { refs: number };
type ListedRow = SampleRow & ShareColumns & OwnerColumns;
type QueueRow = ListedRow & QueueColumns;

export interface Share {
  state: ShareState;
  reason: string | null;
  shared_at: string;
  listed_at: string | null;
  unlisted_at: string | null;
  /** When the owner asked for a second review (once); docs/specs/moderation-v1.md §3.2. */
  appealed_at: string | null;
}

export interface OwnSample {
  id: string;
  name: string;
  tags: string[];
  bytes: number;
  type: string;
  duration: number;
  channels: 1 | 2;
  root: number;
  created_at: string;
  share: Share | null;
  /** Other users holding it in a slot. */
  refs: number;
}

export interface CommunitySample {
  id: string;
  name: string;
  tags: string[];
  bytes: number;
  duration: number;
  channels: 1 | 2;
  root: number;
  owner: string;
  listed_at: string;
  own: boolean;
}

/** The automatic checks' recommendation (docs/specs/moderation-v1.md §3.3). */
export interface AutoVerdict {
  /** `ok` | `flag:<category>`. */
  verdict: string;
  checked_at: string;
  /** Whether it is about the revision shown (a rename since makes it outdated). */
  current: boolean;
  scores: Record<string, number>;
  reasons: string[];
  notes: string[];
  peaks: number[];
  models: Record<string, string>;
  policy: string;
}

export interface QueueItem extends Omit<CommunitySample, 'listed_at'> {
  listed_at: string | null;
  state: ShareState;
  shared_at: string;
  owner_id: string;
  /** The share's revision; a decision must name it (docs/specs/community-v1.md §3). */
  revision: number;
  auto: AutoVerdict | null;
  reports: { open: number; reasons: Record<string, number> };
  /** The owner's request for a second review, with the category of the rejection. */
  appeal: { at: string; of: string | null } | null;
}

export type Decision =
  { action: 'list' } | { action: 'reject'; reason: RejectReason } | { action: 'dismiss' };

/** The display name: the chosen handle, else the neutral `user-<first 6 hex of the id>`. */
export function displayHandle(userId: string, handle: string | null): string {
  if (handle !== null && handle !== '') return handle;
  return `user-${userId
    .replace(/[^0-9a-f]/gi, '')
    .slice(0, 6)
    .toLowerCase()}`;
}

/** `' a b '` → `['a', 'b']`. */
export function splitTags(stored: string): string[] {
  return stored.split(' ').filter((t) => t !== '');
}

/** `['a', 'b']` → `' a b '`. */
export function joinTags(tags: readonly string[]): string {
  return ` ${tags.join(' ')} `;
}

function channels(n: number): 1 | 2 {
  return n >= 2 ? 2 : 1;
}

function shareOf(row: ShareColumns): Share | null {
  if (row.state === null || row.shared_at === null) return null;
  return {
    state: row.state,
    reason: row.state === 'rejected' ? row.reason : null,
    shared_at: row.shared_at,
    listed_at: row.listed_at,
    unlisted_at: row.unlisted_at,
    appealed_at: row.appealed_at,
  };
}

function toOwn(row: OwnRow): OwnSample {
  return {
    id: row.id,
    name: row.name,
    tags: splitTags(row.tags),
    bytes: row.bytes,
    type: row.type,
    duration: row.duration,
    channels: channels(row.channels),
    root: row.root,
    created_at: row.created_at,
    share: shareOf(row),
    refs: row.refs,
  };
}

function toCommunity(row: ListedRow, viewer: string): CommunitySample {
  return {
    id: row.id,
    name: row.name,
    tags: splitTags(row.tags),
    bytes: row.bytes,
    duration: row.duration,
    channels: channels(row.channels),
    root: row.root,
    owner: displayHandle(row.owner_id, row.owner_handle),
    listed_at: row.listed_at ?? '',
    own: row.owner_id === viewer,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numbers(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) if (typeof v === 'number') out[k] = v;
  }
  return out;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** The stored verdict and its JSON detail; null when the share was never checked. */
export function parseAuto(row: QueueColumns & { revision: number | null }): AutoVerdict | null {
  if (row.auto_verdict === null || row.auto_checked_at === null) return null;
  let detail: unknown = null;
  try {
    detail = JSON.parse(row.auto_detail ?? 'null');
  } catch {
    detail = null;
  }
  const d = isRecord(detail) ? detail : {};
  return {
    verdict: row.auto_verdict,
    checked_at: row.auto_checked_at,
    current: row.auto_revision !== null && row.auto_revision === row.revision,
    scores: numbers(d['scores']),
    reasons: strings(d['reasons']),
    notes: strings(d['notes']),
    peaks: Array.isArray(d['peaks'])
      ? d['peaks'].filter((v): v is number => typeof v === 'number')
      : [],
    models: stringMap(d['models']),
    policy: typeof d['policy'] === 'string' ? d['policy'] : '',
  };
}

function toQueueItem(row: QueueRow): QueueItem {
  const reasons: Record<string, number> = {};
  for (const r of (row.report_reasons ?? '').split(' ')) {
    if (r !== '') reasons[r] = (reasons[r] ?? 0) + 1;
  }
  return {
    ...toCommunity(row, ''),
    listed_at: row.listed_at,
    state: row.state ?? 'pending',
    shared_at: row.shared_at ?? '',
    owner_id: row.owner_id,
    revision: row.revision ?? 1,
    auto: parseAuto(row),
    reports: { open: row.open_reports, reasons },
    appeal:
      row.appealed_at === null
        ? null
        : { at: row.appealed_at, of: row.state === 'pending' ? row.reason : null },
  };
}

const SHARE_COLUMNS =
  'sh.state AS state, sh.reason AS reason, sh.shared_at AS shared_at, ' +
  'sh.listed_at AS listed_at, sh.unlisted_at AS unlisted_at, sh.appealed_at AS appealed_at';
const OWN_SELECT =
  `SELECT s.*, ${SHARE_COLUMNS}, ` +
  '(SELECT COUNT(*) FROM sample_refs r WHERE r.sample_id = s.id AND r.user_id <> s.owner_id) AS refs ' +
  'FROM samples s LEFT JOIN shares sh ON sh.sample_id = s.id';
const LISTED_SELECT =
  `SELECT s.*, ${SHARE_COLUMNS}, sh.revision AS revision, u.handle AS owner_handle ` +
  'FROM samples s JOIN shares sh ON sh.sample_id = s.id JOIN users u ON u.id = s.owner_id';
const OPEN_REPORTS = 'FROM reports r WHERE r.sample_id = s.id AND r.resolved_at IS NULL';
const QUEUE_SELECT =
  `SELECT s.*, ${SHARE_COLUMNS}, sh.revision AS revision, u.handle AS owner_handle, ` +
  'sh.auto_verdict AS auto_verdict, sh.auto_detail AS auto_detail, ' +
  'sh.auto_revision AS auto_revision, sh.auto_checked_at AS auto_checked_at, ' +
  `(SELECT COUNT(*) ${OPEN_REPORTS}) AS open_reports, ` +
  `(SELECT group_concat(r.reason, ' ') ${OPEN_REPORTS}) AS report_reasons ` +
  'FROM samples s JOIN shares sh ON sh.sample_id = s.id JOIN users u ON u.id = s.owner_id';

/** One row of `moderation_log` (docs/specs/moderation-v1.md §2). */
export interface LogEntry {
  sample_id: string;
  revision: number | null;
  actor: 'auto' | 'maintainer' | 'owner' | 'user';
  action: 'verdict' | 'list' | 'reject' | 'dismiss' | 'report' | 'appeal' | 'delete';
  verdict?: string | null;
  reason?: string | null;
  detail?: string | null;
  created_at: string;
}

/** An INSERT into the log, optionally only when `condition` (an SQL expression) holds. */
export function logStatement(
  db: D1Database,
  entry: LogEntry,
  condition?: { sql: string; binds: (string | number)[] },
): D1PreparedStatement {
  const binds: (string | number | null)[] = [
    entry.sample_id,
    entry.revision,
    entry.actor,
    entry.action,
    entry.verdict ?? null,
    entry.reason ?? null,
    entry.detail ?? null,
    entry.created_at,
  ];
  const where = condition === undefined ? '' : ` WHERE ${condition.sql}`;
  return db
    .prepare(
      'INSERT INTO moderation_log (sample_id, revision, actor, action, verdict, reason, detail, created_at) ' +
        `SELECT ?, ?, ?, ?, ?, ?, ?, ?${where}`,
    )
    .bind(...binds, ...(condition?.binds ?? []));
}

export type InsertResult =
  | { status: 'created'; sample: OwnSample }
  | { status: 'exists'; sample: OwnSample }
  | { status: 'limit' };

/** What the read rule needs to know about a sample (docs/specs/community-v1.md §3). */
export interface ReadInfo {
  sha256: string;
  type: string;
  owner_id: string;
  state: ShareState | null;
  has_ref: number;
}

/** Samples, shares and refs in D1; the bytes in R2 under `samples/<sha256>`. */
export class CommunityStore {
  constructor(
    private readonly db: D1Database,
    private readonly bucket: R2Bucket,
  ) {}

  /**
   * Insert a sample of `owner`, unless the owner already has this content (then that sample
   * comes back) or the insert would break the quota. Count, size and insert are one statement.
   */
  async insertSample(row: SampleRow): Promise<InsertResult> {
    const limits = COMMUNITY_LIMITS;
    const result = await this.db
      .prepare(
        'INSERT INTO samples (id, owner_id, sha256, bytes, type, duration, channels, name, tags, root, created_at) ' +
          'SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11 ' +
          'WHERE (SELECT COUNT(*) FROM samples WHERE owner_id = ?2) < ?12 ' +
          'AND (SELECT COALESCE(SUM(bytes), 0) FROM samples WHERE owner_id = ?2) + ?4 <= ?13 ' +
          'ON CONFLICT (owner_id, sha256) DO NOTHING',
      )
      .bind(
        row.id,
        row.owner_id,
        row.sha256,
        row.bytes,
        row.type,
        row.duration,
        row.channels,
        row.name,
        row.tags,
        row.root,
        row.created_at,
        limits.maxSamples,
        limits.maxTotalBytes,
      )
      .run();
    if (result.meta.changes === 1) {
      const sample = await this.ownSample(row.owner_id, row.id);
      if (sample === null) throw new Error('sample row missing after insert');
      return { status: 'created', sample };
    }
    const existing = await this.db
      .prepare(`${OWN_SELECT} WHERE s.owner_id = ? AND s.sha256 = ?`)
      .bind(row.owner_id, row.sha256)
      .first<OwnRow>();
    return existing === null ? { status: 'limit' } : { status: 'exists', sample: toOwn(existing) };
  }

  /** Undo the insert of a sample whose bytes did not reach R2. */
  async dropInserted(owner: string, id: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM samples WHERE id = ? AND owner_id = ?')
      .bind(id, owner)
      .run();
  }

  /** Write the bytes; R2 checks them against `sha256` and refuses a mismatch. */
  async putBytes(sha256: string, bytes: Uint8Array, type: string): Promise<void> {
    await this.bucket.put(sampleKey(sha256), bytes, {
      sha256,
      httpMetadata: { contentType: type },
    });
  }

  getBytes(sha256: string): Promise<R2ObjectBody | null> {
    return this.bucket.get(sampleKey(sha256));
  }

  async ownSample(owner: string, id: string): Promise<OwnSample | null> {
    const row = await this.db
      .prepare(`${OWN_SELECT} WHERE s.id = ? AND s.owner_id = ?`)
      .bind(id, owner)
      .first<OwnRow>();
    return row === null ? null : toOwn(row);
  }

  async listOwn(owner: string): Promise<OwnSample[]> {
    const { results } = await this.db
      .prepare(`${OWN_SELECT} WHERE s.owner_id = ? ORDER BY s.created_at DESC, s.id`)
      .bind(owner)
      .all<OwnRow>();
    return results.map(toOwn);
  }

  async usage(owner: string): Promise<{ samples: number; bytes: number }> {
    const row = await this.db
      .prepare(
        'SELECT COUNT(*) AS samples, COALESCE(SUM(bytes), 0) AS bytes FROM samples WHERE owner_id = ?',
      )
      .bind(owner)
      .first<{ samples: number; bytes: number }>();
    return { samples: row?.samples ?? 0, bytes: row?.bytes ?? 0 };
  }

  /** Whether `owner` already has a sample with this content. */
  async hasContent(owner: string, sha256: string): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT 1 AS ok FROM samples WHERE owner_id = ? AND sha256 = ?')
      .bind(owner, sha256)
      .first<{ ok: number }>();
    return row !== null;
  }

  /** The read rule's inputs for `viewer`, or null for an unknown sample. */
  readInfo(id: string, viewer: string): Promise<ReadInfo | null> {
    return this.db
      .prepare(
        'SELECT s.sha256 AS sha256, s.type AS type, s.owner_id AS owner_id, sh.state AS state, ' +
          'EXISTS (SELECT 1 FROM sample_refs r WHERE r.sample_id = s.id AND r.user_id = ?) AS has_ref ' +
          'FROM samples s LEFT JOIN shares sh ON sh.sample_id = s.id WHERE s.id = ?',
      )
      .bind(viewer, id)
      .first<ReadInfo>();
  }

  /**
   * Delete an own sample, unless its share is pending or listed or another user references it
   * (one conditional statement). The R2 object goes when no other row has the same content.
   * Returns false when the sample is in use (or not the owner's).
   */
  async deleteSample(owner: string, id: string, sha256: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        'DELETE FROM samples WHERE id = ?1 AND owner_id = ?2 ' +
          "AND NOT EXISTS (SELECT 1 FROM shares WHERE sample_id = ?1 AND state IN ('pending', 'listed')) " +
          'AND NOT EXISTS (SELECT 1 FROM sample_refs WHERE sample_id = ?1 AND user_id <> ?2)',
      )
      .bind(id, owner)
      .run();
    if (result.meta.changes !== 1) return false;
    await this.db.batch([
      this.db.prepare('DELETE FROM shares WHERE sample_id = ?').bind(id),
      this.db.prepare('DELETE FROM sample_refs WHERE sample_id = ?').bind(id),
    ]);
    await this.#dropObjectIfUnused(sha256);
    return true;
  }

  /**
   * The maintainer's hard delete (docs/specs/moderation-v1.md §3.3), in any state, unless
   * another user references the sample (one conditional statement). Removes the row, its share,
   * the owner's refs and its reports, logs it, and drops the R2 object when no other row has the
   * same content. False when the sample is unknown or referenced.
   */
  async hardDelete(id: string, now: string): Promise<'deleted' | 'not_found' | 'in_use'> {
    const row = await this.db
      .prepare(
        'SELECT s.sha256 AS sha256, sh.revision AS revision FROM samples s ' +
          'LEFT JOIN shares sh ON sh.sample_id = s.id WHERE s.id = ?',
      )
      .bind(id)
      .first<{ sha256: string; revision: number | null }>();
    if (row === null) return 'not_found';
    const result = await this.db
      .prepare(
        'DELETE FROM samples WHERE id = ?1 ' +
          'AND NOT EXISTS (SELECT 1 FROM sample_refs r WHERE r.sample_id = ?1 AND r.user_id <> samples.owner_id)',
      )
      .bind(id)
      .run();
    if (result.meta.changes !== 1) return 'in_use';
    await this.db.batch([
      this.db.prepare('DELETE FROM shares WHERE sample_id = ?').bind(id),
      this.db.prepare('DELETE FROM sample_refs WHERE sample_id = ?').bind(id),
      this.db.prepare('DELETE FROM reports WHERE sample_id = ?').bind(id),
      logStatement(this.db, {
        sample_id: id,
        revision: row.revision,
        actor: 'maintainer',
        action: 'delete',
        created_at: now,
      }),
    ]);
    await this.#dropObjectIfUnused(row.sha256);
    return 'deleted';
  }

  /**
   * Delete `samples/<sha256>` when no row names it. An upload of the same content may race
   * with this (its row lands between the count and the delete), so the bytes are read first and
   * put back when a row has appeared by the time the object is gone.
   */
  async #dropObjectIfUnused(sha256: string): Promise<void> {
    if ((await this.#rowsWith(sha256)) > 0) return;
    const object = await this.bucket.get(sampleKey(sha256));
    if (object === null) return;
    const bytes = await object.arrayBuffer();
    const type = object.httpMetadata?.contentType ?? 'application/octet-stream';
    await this.bucket.delete(sampleKey(sha256));
    if ((await this.#rowsWith(sha256)) > 0) {
      await this.bucket.put(sampleKey(sha256), bytes, { httpMetadata: { contentType: type } });
    }
  }

  async #rowsWith(sha256: string): Promise<number> {
    const row = await this.db
      .prepare('SELECT COUNT(*) AS n FROM samples WHERE sha256 = ?')
      .bind(sha256)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /**
   * Share an own sample: none or unlisted → pending; pending keeps its place in the queue and
   * takes the new name and tags. Every call bumps the revision, so a decision taken on what the
   * maintainer saw earlier is refused. Listed and rejected shares are left alone (one batch, so
   * a decision in between cannot be overwritten).
   */
  async share(owner: string, id: string, name: string, tags: string, now: string): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          'UPDATE samples SET name = ?1, tags = ?2 WHERE id = ?3 AND owner_id = ?4 ' +
            "AND NOT EXISTS (SELECT 1 FROM shares WHERE sample_id = ?3 AND state IN ('listed', 'rejected'))",
        )
        .bind(name, tags, id, owner),
      this.db
        .prepare(
          'INSERT INTO shares (sample_id, owner_id, state, licence_ack, shared_at) ' +
            "VALUES (?1, ?2, 'pending', ?3, ?4) " +
            'ON CONFLICT (sample_id) DO UPDATE SET ' +
            "state = 'pending', licence_ack = excluded.licence_ack, unlisted_at = NULL, revision = shares.revision + 1, " +
            "shared_at = CASE WHEN shares.state = 'unlisted' THEN excluded.shared_at ELSE shares.shared_at END " +
            "WHERE shares.state IN ('pending', 'unlisted')",
        )
        .bind(id, owner, LICENCE_ID, now),
    ]);
  }

  /** pending | listed → unlisted; anything else stays. */
  async unshare(owner: string, id: string, now: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE shares SET state = 'unlisted', unlisted_at = ? WHERE sample_id = ? AND owner_id = ? " +
          "AND state IN ('pending', 'listed')",
      )
      .bind(now, id, owner)
      .run();
  }

  /**
   * Record that `slot` of `user` holds a listed sample. The listed check, the per-user cap and
   * the insert are one statement. Returns the sample, `null` when it is not listed, or `limit`.
   * An own sample needs no ref.
   */
  async take(
    user: string,
    id: string,
    slot: SlotId,
    now: string,
  ): Promise<CommunitySample | null | 'limit'> {
    const listed = await this.listedSample(id, user);
    if (listed === null) return null;
    if (listed.own) return listed;
    const result = await this.db
      .prepare(
        'INSERT INTO sample_refs (user_id, sample_id, slot, taken_at) ' +
          'SELECT ?1, ?2, ?3, ?4 WHERE EXISTS ' +
          "(SELECT 1 FROM shares WHERE sample_id = ?2 AND state = 'listed') " +
          'AND ((SELECT COUNT(*) FROM sample_refs WHERE user_id = ?1) < ?5 ' +
          'OR EXISTS (SELECT 1 FROM sample_refs WHERE user_id = ?1 AND sample_id = ?2 AND slot = ?3)) ' +
          'ON CONFLICT (user_id, sample_id, slot) DO UPDATE SET taken_at = excluded.taken_at',
      )
      .bind(user, id, slot, now, COMMUNITY_LIMITS.maxRefs)
      .run();
    if (result.meta.changes === 1) return listed;
    return (await this.listedSample(id, user)) === null ? null : 'limit';
  }

  /** Drop the ref of `slot` of `user` to a sample (the slot holds something else now). */
  async release(user: string, id: string, slot: SlotId): Promise<void> {
    await this.db
      .prepare('DELETE FROM sample_refs WHERE user_id = ? AND sample_id = ? AND slot = ?')
      .bind(user, id, slot)
      .run();
  }

  async listedSample(id: string, viewer: string): Promise<CommunitySample | null> {
    const row = await this.db
      .prepare(`${LISTED_SELECT} WHERE s.id = ? AND sh.state = 'listed'`)
      .bind(id)
      .first<ListedRow>();
    return row === null ? null : toCommunity(row, viewer);
  }

  /**
   * One page of the bank: listed only, newest first; `after` is the last row of the previous
   * page. `query` is a name substring, `tag` one tag.
   */
  async community(
    viewer: string,
    options: { query: string | null; tag: string | null; after: [string, string] | null },
  ): Promise<{ samples: CommunitySample[]; next: [string, string] | null }> {
    const where = ["sh.state = 'listed'"];
    const binds: (string | number)[] = [];
    if (options.query !== null) {
      where.push("s.name LIKE ? ESCAPE '\\'");
      binds.push(`%${options.query.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    }
    if (options.tag !== null) {
      where.push('s.tags LIKE ?');
      binds.push(`% ${options.tag} %`);
    }
    if (options.after !== null) {
      where.push('(sh.listed_at < ? OR (sh.listed_at = ? AND s.id > ?))');
      binds.push(options.after[0], options.after[0], options.after[1]);
    }
    const size = COMMUNITY_LIMITS.pageSize;
    const { results } = await this.db
      .prepare(
        `${LISTED_SELECT} WHERE ${where.join(' AND ')} ORDER BY sh.listed_at DESC, s.id LIMIT ?`,
      )
      .bind(...binds, size + 1)
      .all<ListedRow>();
    const page = results.slice(0, size);
    const last = page[page.length - 1];
    return {
      samples: page.map((row) => toCommunity(row, viewer)),
      next: results.length > size && last !== undefined ? [last.listed_at ?? '', last.id] : null,
    };
  }

  /**
   * Pending shares oldest first, listed ones newest first (for a take-down), or listed ones with
   * open reports, oldest open report first (docs/specs/moderation-v1.md §3.3).
   */
  async queue(state: 'pending' | 'listed' | 'reported'): Promise<QueueItem[]> {
    const query =
      state === 'pending'
        ? `${QUEUE_SELECT} WHERE sh.state = 'pending' ORDER BY sh.shared_at, s.id LIMIT ?`
        : state === 'listed'
          ? `${QUEUE_SELECT} WHERE sh.state = 'listed' ORDER BY sh.listed_at DESC, s.id LIMIT ?`
          : `${QUEUE_SELECT} WHERE sh.state = 'listed' AND EXISTS (SELECT 1 ${OPEN_REPORTS}) ` +
            `ORDER BY (SELECT MIN(r.created_at) ${OPEN_REPORTS}), s.id LIMIT ?`;
    const { results } = await this.db
      .prepare(query)
      .bind(COMMUNITY_LIMITS.queueSize)
      .all<QueueRow>();
    return results.map(toQueueItem);
  }

  async queueItem(id: string): Promise<QueueItem | null> {
    const row = await this.db.prepare(`${QUEUE_SELECT} WHERE s.id = ?`).bind(id).first<QueueRow>();
    return row === null ? null : toQueueItem(row);
  }

  /**
   * The maintainer's decision on revision `revision` (what they saw): pending → listed,
   * pending | listed → rejected, or dismiss: a listed share's open reports are resolved and it
   * stays listed. Every decision resolves open reports and is logged, in one batch whose later
   * statements run only when the share was updated. False when the state or the revision has
   * moved on.
   */
  async decide(id: string, decision: Decision, revision: number, now: string): Promise<boolean> {
    const update =
      decision.action === 'list'
        ? this.db
            .prepare(
              "UPDATE shares SET state = 'listed', listed_at = ?1, reviewed_at = ?1, reason = NULL " +
                "WHERE sample_id = ?2 AND state = 'pending' AND revision = ?3",
            )
            .bind(now, id, revision)
        : decision.action === 'reject'
          ? this.db
              .prepare(
                "UPDATE shares SET state = 'rejected', reviewed_at = ?1, reason = ?4 " +
                  "WHERE sample_id = ?2 AND state IN ('pending', 'listed') AND revision = ?3",
              )
              .bind(now, id, revision, decision.reason)
          : this.db
              .prepare(
                'UPDATE shares SET reviewed_at = ?1 ' +
                  "WHERE sample_id = ?2 AND state = 'listed' AND revision = ?3 " +
                  'AND EXISTS (SELECT 1 FROM reports WHERE sample_id = ?2 AND resolved_at IS NULL)',
              )
              .bind(now, id, revision);
    const decided = {
      sql: 'EXISTS (SELECT 1 FROM shares WHERE sample_id = ? AND reviewed_at = ? AND revision = ?)',
      binds: [id, now, revision],
    };
    const [result] = await this.db.batch([
      update,
      this.db
        .prepare(
          'UPDATE reports SET resolved_at = ?1 WHERE sample_id = ?2 AND resolved_at IS NULL ' +
            'AND EXISTS (SELECT 1 FROM shares WHERE sample_id = ?2 AND reviewed_at = ?1 AND revision = ?3)',
        )
        .bind(now, id, revision),
      logStatement(
        this.db,
        {
          sample_id: id,
          revision,
          actor: 'maintainer',
          action: decision.action,
          reason: decision.action === 'reject' ? decision.reason : null,
          created_at: now,
        },
        decided,
      ),
    ]);
    return (result?.meta.changes ?? 0) === 1;
  }

  /** Set (or clear) the handle; false when another user has it (ignoring case). */
  async setHandle(user: string, handle: string | null): Promise<boolean> {
    try {
      await this.db.prepare('UPDATE users SET handle = ? WHERE id = ?').bind(handle, user).run();
      return true;
    } catch (e) {
      if (e instanceof Error && /UNIQUE/i.test(e.message)) return false;
      throw e;
    }
  }
}
