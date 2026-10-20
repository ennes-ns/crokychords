import type { SaveMeta, SaveRecord } from './record';

export interface User {
  id: string;
  email: string;
  created_at: string;
  /** Chosen display name, or null (docs/specs/community-v1.md §1). */
  handle: string | null;
}

interface SaveRow {
  id: string;
  version: number;
  updated_at: string;
  title: string;
}

/** Outcome of Storage.claimVersion. */
export type ClaimResult = 'claimed' | 'conflict' | 'limit';

/** R2 key of a save body: `saves/<user-id>/<save-id>.json`. */
export function saveKey(userId: string, saveId: string): string {
  return `saves/${userId}/${saveId}.json`;
}

/** Users and save metadata in D1, save bodies in R2. */
export class Storage {
  constructor(
    private readonly db: D1Database,
    private readonly bucket: R2Bucket,
  ) {}

  /** The user for an e-mail address, created on first sight. */
  async ensureUser(email: string, now: Date): Promise<User> {
    await this.db
      .prepare(
        'INSERT INTO users (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING',
      )
      .bind(crypto.randomUUID(), email, now.toISOString())
      .run();
    const user = await this.db
      .prepare('SELECT id, email, created_at, handle FROM users WHERE email = ?')
      .bind(email)
      .first<User>();
    if (user === null) throw new Error('user row missing after insert');
    return user;
  }

  async countSaves(userId: string): Promise<number> {
    const row = await this.db
      .prepare('SELECT COUNT(*) AS n FROM saves WHERE user_id = ?')
      .bind(userId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async listSaves(userId: string): Promise<SaveMeta[]> {
    const { results } = await this.db
      .prepare(
        'SELECT id, version, updated_at, title FROM saves WHERE user_id = ? ORDER BY updated_at DESC, id',
      )
      .bind(userId)
      .all<SaveRow>();
    return results.map(toMeta);
  }

  async getMeta(userId: string, saveId: string): Promise<SaveMeta | null> {
    const row = await this.db
      .prepare('SELECT id, version, updated_at, title FROM saves WHERE user_id = ? AND id = ?')
      .bind(userId, saveId)
      .first<SaveRow>();
    return row === null ? null : toMeta(row);
  }

  async getRecord(userId: string, saveId: string): Promise<SaveRecord | null> {
    const object = await this.bucket.get(saveKey(userId, saveId));
    if (object === null) return null;
    return object.json<SaveRecord>();
  }

  /**
   * Claim `record.version` in D1, provided the stored version still equals `base` (0 = the save
   * does not exist yet). A new save is only inserted while the user has fewer than `maxSaves`
   * saves; the count and the insert are one statement, so concurrent creates cannot overshoot.
   * Returns `conflict` when another write got there first, `limit` when the cap is reached.
   */
  async claimVersion(
    userId: string,
    record: SaveRecord,
    base: number,
    size: number,
    maxSaves: number,
  ): Promise<ClaimResult> {
    if (base !== 0) {
      const result = await this.db
        .prepare(
          'UPDATE saves SET version = ?, updated_at = ?, title = ?, size = ? WHERE user_id = ? AND id = ? AND version = ?',
        )
        .bind(record.version, record.updated_at, record.title, size, userId, record.id, base)
        .run();
      return result.meta.changes === 1 ? 'claimed' : 'conflict';
    }
    const result = await this.db
      .prepare(
        'INSERT INTO saves (user_id, id, version, updated_at, title, size) ' +
          'SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM saves WHERE user_id = ?) < ? ' +
          'ON CONFLICT(user_id, id) DO NOTHING',
      )
      .bind(
        userId,
        record.id,
        record.version,
        record.updated_at,
        record.title,
        size,
        userId,
        maxSaves,
      )
      .run();
    if (result.meta.changes === 1) return 'claimed';
    return (await this.getMeta(userId, record.id)) === null ? 'limit' : 'conflict';
  }

  /** Undo a claim whose R2 write failed. */
  async rollbackClaim(
    userId: string,
    previous: SaveMeta | null,
    claimed: SaveRecord,
  ): Promise<void> {
    if (previous === null) {
      await this.db
        .prepare('DELETE FROM saves WHERE user_id = ? AND id = ? AND version = ?')
        .bind(userId, claimed.id, claimed.version)
        .run();
      return;
    }
    await this.db
      .prepare(
        'UPDATE saves SET version = ?, updated_at = ?, title = ? WHERE user_id = ? AND id = ? AND version = ?',
      )
      .bind(
        previous.version,
        previous.updated_at,
        previous.title,
        userId,
        claimed.id,
        claimed.version,
      )
      .run();
  }

  async putBody(userId: string, record: SaveRecord): Promise<void> {
    await this.bucket.put(saveKey(userId, record.id), JSON.stringify(record), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { version: String(record.version) },
    });
  }

  /** Delete a save if its stored version equals `expected` (or unconditionally when undefined). */
  async deleteSave(userId: string, saveId: string, expected: number | undefined): Promise<boolean> {
    const result =
      expected === undefined
        ? await this.db
            .prepare('DELETE FROM saves WHERE user_id = ? AND id = ?')
            .bind(userId, saveId)
            .run()
        : await this.db
            .prepare('DELETE FROM saves WHERE user_id = ? AND id = ? AND version = ?')
            .bind(userId, saveId, expected)
            .run();
    if (result.meta.changes !== 1) return false;
    await this.bucket.delete(saveKey(userId, saveId));
    return true;
  }
}

function toMeta(row: SaveRow): SaveMeta {
  return { id: row.id, version: row.version, updated_at: row.updated_at, title: row.title };
}
