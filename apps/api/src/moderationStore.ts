/**
 * D1 access of the moderation pipeline (docs/specs/moderation-v1.md §2–§3): the job's view of
 * pending shares, its recommendation (never a state change), the digest counts, user reports and
 * the owner's one appeal. Every write is one conditional statement or one batch whose later
 * statements depend on the first, and every action lands in `moderation_log`.
 */
import type { RejectReason } from './communityStore';
import { logStatement, splitTags } from './communityStore';

/** A pending share as the job sees it: no owner, no e-mail, no handle. */
export interface JobItem {
  id: string;
  revision: number;
  type: string;
  bytes: number;
  duration: number;
  channels: 1 | 2;
  name: string;
  tags: string[];
  shared_at: string;
}

export interface VerdictRecord {
  revision: number;
  /** `ok` | `flag:<category>`. */
  verdict: string;
  /** JSON stored on the share: scores, reasons, notes, peaks, models, policy. */
  detail: string;
  /** JSON stored in the log: scores, models, policy. */
  logDetail: string;
}

export interface Digest {
  pending: number;
  unchecked: number;
  flagged: number;
  reported: number;
  appeals: number;
  oldest_pending_at: string | null;
}

export type ReportResult = 'reported' | 'not_listed' | 'own' | 'limit';

export class ModerationStore {
  constructor(private readonly db: D1Database) {}

  /** Pending shares without a verdict about their current revision, oldest first. */
  async pendingForJob(limit: number): Promise<JobItem[]> {
    const { results } = await this.db
      .prepare(
        'SELECT s.id AS id, sh.revision AS revision, s.type AS type, s.bytes AS bytes, ' +
          's.duration AS duration, s.channels AS channels, s.name AS name, s.tags AS tags, ' +
          'sh.shared_at AS shared_at FROM shares sh JOIN samples s ON s.id = sh.sample_id ' +
          "WHERE sh.state = 'pending' AND (sh.auto_revision IS NULL OR sh.auto_revision <> sh.revision) " +
          'ORDER BY sh.shared_at, s.id LIMIT ?',
      )
      .bind(limit)
      .all<Omit<JobItem, 'tags' | 'channels'> & { tags: string; channels: number }>();
    return results.map((r) => ({
      ...r,
      channels: r.channels >= 2 ? 2 : 1,
      tags: splitTags(r.tags),
    }));
  }

  /** Content hash and type of a sample whose share is pending, else null. */
  pendingContent(id: string): Promise<{ sha256: string; type: string } | null> {
    return this.db
      .prepare(
        'SELECT s.sha256 AS sha256, s.type AS type FROM samples s JOIN shares sh ON sh.sample_id = s.id ' +
          "WHERE s.id = ? AND sh.state = 'pending'",
      )
      .bind(id)
      .first<{ sha256: string; type: string }>();
  }

  /**
   * Store the recommendation on a pending share of revision `revision` and log it. Never touches
   * the state, the rejection category or R2. False when the share is no longer pending at that
   * revision.
   */
  async writeVerdict(id: string, record: VerdictRecord, now: string): Promise<boolean> {
    const [update] = await this.db.batch([
      this.db
        .prepare(
          'UPDATE shares SET auto_verdict = ?1, auto_detail = ?2, auto_revision = ?3, auto_checked_at = ?4 ' +
            "WHERE sample_id = ?5 AND state = 'pending' AND revision = ?3",
        )
        .bind(record.verdict, record.detail, record.revision, now, id),
      logStatement(
        this.db,
        {
          sample_id: id,
          revision: record.revision,
          actor: 'auto',
          action: 'verdict',
          verdict: record.verdict,
          detail: record.logDetail,
          created_at: now,
        },
        {
          sql: 'EXISTS (SELECT 1 FROM shares WHERE sample_id = ? AND auto_checked_at = ? AND auto_revision = ?)',
          binds: [id, now, record.revision],
        },
      ),
    ]);
    return (update?.meta.changes ?? 0) === 1;
  }

  async digest(): Promise<Digest> {
    const row = await this.db
      .prepare(
        'SELECT ' +
          "(SELECT COUNT(*) FROM shares WHERE state = 'pending') AS pending, " +
          "(SELECT COUNT(*) FROM shares WHERE state = 'pending' AND (auto_revision IS NULL OR auto_revision <> revision)) AS unchecked, " +
          "(SELECT COUNT(*) FROM shares WHERE state = 'pending' AND auto_revision = revision AND auto_verdict LIKE 'flag:%') AS flagged, " +
          "(SELECT COUNT(*) FROM shares sh WHERE sh.state = 'listed' AND EXISTS (SELECT 1 FROM reports r WHERE r.sample_id = sh.sample_id AND r.resolved_at IS NULL)) AS reported, " +
          "(SELECT COUNT(*) FROM shares WHERE state = 'pending' AND appealed_at IS NOT NULL) AS appeals, " +
          "(SELECT MIN(shared_at) FROM shares WHERE state = 'pending') AS oldest_pending_at",
      )
      .first<Digest>();
    return (
      row ?? {
        pending: 0,
        unchecked: 0,
        flagged: 0,
        reported: 0,
        appeals: 0,
        oldest_pending_at: null,
      }
    );
  }

  /**
   * Report a listed sample of someone else. One report per user and sample (a new one replaces
   * the reason and reopens it); at most `dailyCap` reports per user in 24 hours. The insert,
   * the listed check, the owner check and the cap are one statement.
   */
  async report(
    user: string,
    id: string,
    reason: RejectReason,
    now: Date,
    dailyCap: number,
  ): Promise<ReportResult> {
    const sample = await this.db
      .prepare(
        'SELECT s.owner_id AS owner_id, sh.state AS state, sh.revision AS revision FROM samples s ' +
          'JOIN shares sh ON sh.sample_id = s.id WHERE s.id = ?',
      )
      .bind(id)
      .first<{ owner_id: string; state: string; revision: number }>();
    if (sample === null || sample.state !== 'listed') return 'not_listed';
    if (sample.owner_id === user) return 'own';
    const at = now.toISOString();
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const [insert] = await this.db.batch([
      this.db
        .prepare(
          'INSERT INTO reports (sample_id, user_id, reason, created_at) ' +
            'SELECT ?1, ?2, ?3, ?4 WHERE ' +
            "EXISTS (SELECT 1 FROM shares WHERE sample_id = ?1 AND state = 'listed' AND owner_id <> ?2) " +
            'AND (SELECT COUNT(*) FROM reports WHERE user_id = ?2 AND created_at > ?5) < ?6 ' +
            'ON CONFLICT (sample_id, user_id) DO UPDATE SET reason = excluded.reason, ' +
            'created_at = excluded.created_at, resolved_at = NULL',
        )
        .bind(id, user, reason, at, since, dailyCap),
      logStatement(
        this.db,
        {
          sample_id: id,
          revision: sample.revision,
          actor: 'user',
          action: 'report',
          reason,
          created_at: at,
        },
        {
          sql: 'EXISTS (SELECT 1 FROM reports WHERE sample_id = ? AND user_id = ? AND created_at = ?)',
          binds: [id, user, at],
        },
      ),
    ]);
    if ((insert?.meta.changes ?? 0) === 1) return 'reported';
    const again = await this.db
      .prepare("SELECT state FROM shares WHERE sample_id = ? AND state = 'listed'")
      .bind(id)
      .first();
    return again === null ? 'not_listed' : 'limit';
  }

  /**
   * The owner's single "request review": rejected and never appealed → pending (revision + 1,
   * the category kept for the maintainer). False otherwise.
   */
  async appeal(owner: string, id: string, now: string): Promise<boolean> {
    const [update] = await this.db.batch([
      this.db
        .prepare(
          "UPDATE shares SET state = 'pending', appealed_at = ?1, revision = revision + 1 " +
            "WHERE sample_id = ?2 AND owner_id = ?3 AND state = 'rejected' AND appealed_at IS NULL",
        )
        .bind(now, id, owner),
      logStatement(
        this.db,
        { sample_id: id, revision: null, actor: 'owner', action: 'appeal', created_at: now },
        {
          sql: "EXISTS (SELECT 1 FROM shares WHERE sample_id = ? AND state = 'pending' AND appealed_at = ?)",
          binds: [id, now],
        },
      ),
    ]);
    return (update?.meta.changes ?? 0) === 1;
  }

  /** The log of one sample, oldest first (tests and future tooling). */
  async log(id: string): Promise<
    {
      revision: number | null;
      actor: string;
      action: string;
      verdict: string | null;
      reason: string | null;
      detail: string | null;
    }[]
  > {
    const { results } = await this.db
      .prepare(
        'SELECT revision, actor, action, verdict, reason, detail FROM moderation_log WHERE sample_id = ? ORDER BY id',
      )
      .bind(id)
      .all<{
        revision: number | null;
        actor: string;
        action: string;
        verdict: string | null;
        reason: string | null;
        detail: string | null;
      }>();
    return results;
  }
}
