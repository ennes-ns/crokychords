/**
 * Weekly backups (docs/specs/backups-v1.md): copies every D1 table (as JSON lines plus the schema)
 * and every object of the saves bucket into the backup bucket under `weekly/<YYYY-MM-DD>/`, writes
 * a manifest and keeps the newest 8 complete sets. One call of `runBackup` does one chunk of work
 * within a subrequest and time budget; progress lives in D1 (`backup_state`), so the next
 * invocation resumes where the last one stopped. Logs and stored errors never contain row or object
 * content.
 */

/** Bindings the backup needs (merged into the Worker's `Env`). */
export interface BackupEnv {
  DB: D1Database;
  SAVES: R2Bucket;
  /** The backup bucket `crokychords-backups`. */
  BACKUPS: R2Bucket;
  /** wrangler.toml `[version_metadata]`; missing in tests and local dev. */
  CF_VERSION_METADATA?: WorkerVersionMetadata;
}

export const MANIFEST_SCHEMA_VERSION = 1;
export const SET_PREFIX = 'weekly/';
/** Number of complete sets kept by retention. */
export const KEEP_SETS = 8;
/** Rows per D1 page. */
export const PAGE_ROWS = 1000;
/** Subrequests per chunk (Free plan: 1,000 to Cloudflare services per invocation). */
export const DEFAULT_BUDGET = 900;
/** Wall time per chunk (a cron invocation may run 15 minutes). */
export const DEFAULT_DEADLINE_MS = 10 * 60 * 1000;
/** How long a lease protects a set; longer than any invocation. */
export const LEASE_MS = 15 * 60 * 1000;
/** Subrequests kept back for state writes and the lease release. */
const RESERVE = 8;

/** Tables that are never dumped. */
export function isSkippedTable(name: string): boolean {
  return (
    name.startsWith('_cf_') ||
    name.startsWith('sqlite_') ||
    name === 'd1_migrations' ||
    name === 'backup_state'
  );
}

export type Phase = 'd1' | 'r2' | 'retention' | 'finish' | 'done';

export interface TableResult {
  name: string;
  key: string;
  rows: number;
  bytes: number;
}

/** `backup_state.progress` (JSON). */
export interface Progress {
  schema_version: 1;
  schema_done: boolean;
  tables: TableResult[];
  r2_cursor: string | null;
  r2_objects: number;
  r2_bytes: number;
  r2_skipped: number;
  retention_deleted: string[];
}

export interface Manifest {
  schema_version: typeof MANIFEST_SCHEMA_VERSION;
  set: string;
  prefix: string;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  elapsed_ms: number;
  invocations: number;
  worker_version: { id: string; tag: string } | null;
  d1: { schema_key: string; tables: TableResult[]; rows: number; bytes: number };
  r2: { objects: number; bytes: number; skipped: number };
  retention: { keep: number; deleted: string[] };
}

export type BackupStatus = 'complete' | 'partial' | 'busy';

export interface BackupResult {
  set: string;
  status: BackupStatus;
  phase: Phase;
  manifest?: Manifest;
}

export interface BackupOptions {
  /** Clock, for tests. */
  now?: () => Date;
  /** Subrequests this chunk may use. */
  budget?: number;
  /** Wall time this chunk may use (ms). */
  deadlineMs?: number;
  /** The set to work on; default: the UTC date of `now()`. */
  set?: string;
}

/** `YYYY-MM-DD` of a date in UTC. */
export function setIdFor(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function setPrefix(set: string): string {
  return `${SET_PREFIX}${set}/`;
}

const SET_ID = /^\d{4}-\d{2}-\d{2}$/;

/** The set id of a delimited prefix `weekly/<YYYY-MM-DD>/`, or null for anything else. */
export function setFromPrefix(prefix: string): string | null {
  if (!prefix.startsWith(SET_PREFIX) || !prefix.endsWith('/')) return null;
  const set = prefix.slice(SET_PREFIX.length, -1);
  return SET_ID.test(set) ? set : null;
}

/** Double-quoted SQL identifier. */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** One row as a JSON line; BLOB values become `{"$base64": "…"}`. */
export function rowToJson(row: Record<string, unknown>): string {
  return JSON.stringify(row, (_key, value: unknown) => {
    if (value instanceof ArrayBuffer) return { $base64: toBase64(new Uint8Array(value)) };
    if (ArrayBuffer.isView(value)) {
      return {
        $base64: toBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
      };
    }
    return value;
  });
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function emptyProgress(): Progress {
  return {
    schema_version: 1,
    schema_done: false,
    tables: [],
    r2_cursor: null,
    r2_objects: 0,
    r2_bytes: 0,
    r2_skipped: 0,
    retention_deleted: [],
  };
}

/** Raised when the chunk's budget or time is used up; the run continues next invocation. */
class OutOfBudget extends Error {
  constructor() {
    super('chunk budget used up');
    this.name = 'OutOfBudget';
  }
}

/** Raised when the lease was lost (another invocation took over after it expired). */
class LeaseLost extends Error {
  constructor() {
    super('lease lost');
    this.name = 'LeaseLost';
  }
}

/** Counts subrequests and wall time of one chunk. */
class Budget {
  private used = 0;
  constructor(
    private readonly limit: number,
    private readonly deadline: number,
  ) {}

  get remaining(): number {
    return this.limit - RESERVE - this.used;
  }

  /** Whether `n` more subrequests fit (and time is left). */
  fits(n: number): boolean {
    return this.remaining >= n && Date.now() < this.deadline;
  }

  /** Spend `n` subrequests, or stop the chunk when they do not fit. */
  spend(n: number): void {
    if (!this.fits(n)) throw new OutOfBudget();
    this.used += n;
  }

  /** Spend without checking (state writes, which use the reserve). */
  force(n: number): void {
    this.used += n;
  }
}

interface StateRow {
  set_id: string;
  started_at: string;
  phase: Phase;
  progress: string;
  invocations: number;
  active_ms: number;
}

/** Run one chunk of the backup for a set (default: today's). */
export async function runBackup(
  env: BackupEnv,
  options: BackupOptions = {},
): Promise<BackupResult> {
  const now = options.now ?? (() => new Date());
  const startedMs = Date.now();
  const start = now();
  const set = options.set ?? setIdFor(start);
  if (!SET_ID.test(set)) throw new Error('invalid set id');
  const budget = new Budget(
    options.budget ?? DEFAULT_BUDGET,
    startedMs + (options.deadlineMs ?? DEFAULT_DEADLINE_MS),
  );
  const db = env.DB;
  const leaseId = crypto.randomUUID();

  // Fast path for continuations of a finished set: one read.
  budget.force(1);
  const existing = await db
    .prepare('SELECT phase FROM backup_state WHERE set_id = ?')
    .bind(set)
    .first<{ phase: Phase }>();
  if (existing?.phase === 'done') return { set, status: 'complete', phase: 'done' };

  budget.force(3);
  const iso = start.toISOString();
  await db
    .prepare(
      'INSERT INTO backup_state (set_id, started_at, updated_at, phase, progress) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(set_id) DO NOTHING',
    )
    .bind(set, iso, iso, 'd1', JSON.stringify(emptyProgress()))
    .run();
  const leased = await db
    .prepare(
      'UPDATE backup_state SET lease_id = ?, lease_until = ?, invocations = invocations + 1, error = NULL ' +
        "WHERE set_id = ? AND phase <> 'done' AND (lease_until IS NULL OR lease_until < ?)",
    )
    .bind(leaseId, new Date(start.getTime() + LEASE_MS).toISOString(), set, iso)
    .run();
  const row = await db
    .prepare(
      'SELECT set_id, started_at, phase, progress, invocations, active_ms FROM backup_state WHERE set_id = ?',
    )
    .bind(set)
    .first<StateRow>();
  if (row === null) throw new Error('backup_state row missing after insert');
  if (leased.meta.changes !== 1) {
    return row.phase === 'done'
      ? { set, status: 'complete', phase: 'done' }
      : { set, status: 'busy', phase: row.phase };
  }

  const run = new Run(env, budget, now, set, leaseId, row, startedMs);
  try {
    return await run.execute();
  } catch (e) {
    if (e instanceof OutOfBudget) {
      await run.save(null);
      return { set, status: 'partial', phase: run.phase };
    }
    if (e instanceof LeaseLost) return { set, status: 'busy', phase: run.phase };
    const message = e instanceof Error ? `${e.name}: ${e.message}` : 'unknown error';
    await run.save(message.slice(0, 500)).catch(() => undefined);
    throw e;
  }
}

/** One chunk of work on one set, holding the lease. */
class Run {
  phase: Phase;
  private progress: Progress;
  private readonly prefix: string;

  constructor(
    private readonly env: BackupEnv,
    private readonly budget: Budget,
    private readonly now: () => Date,
    private readonly set: string,
    private readonly leaseId: string,
    private readonly row: StateRow,
    private readonly startedMs: number,
  ) {
    this.phase = row.phase;
    this.progress = { ...emptyProgress(), ...(JSON.parse(row.progress) as Partial<Progress>) };
    this.prefix = setPrefix(set);
  }

  async execute(): Promise<BackupResult> {
    if (this.phase === 'd1') {
      await this.dumpD1();
      await this.advance('r2');
    }
    if (this.phase === 'r2') {
      await this.copyR2();
      await this.advance('retention');
    }
    if (this.phase === 'retention') {
      await this.retention();
      await this.advance('finish');
    }
    let manifest: Manifest | undefined;
    if (this.phase === 'finish') {
      manifest = await this.finish();
    }
    return {
      set: this.set,
      status: 'complete',
      phase: 'done',
      ...(manifest === undefined ? {} : { manifest }),
    };
  }

  /** Persist progress (and an optional error) and release the lease. */
  async save(error: string | null): Promise<void> {
    this.budget.force(1);
    await this.env.DB.prepare(
      'UPDATE backup_state SET phase = ?, progress = ?, updated_at = ?, active_ms = active_ms + ?, ' +
        'error = ?, lease_id = NULL, lease_until = NULL WHERE set_id = ? AND lease_id = ?',
    )
      .bind(
        this.phase,
        JSON.stringify(this.progress),
        this.now().toISOString(),
        Date.now() - this.startedMs,
        error,
        this.set,
        this.leaseId,
      )
      .run();
  }

  /** Persist progress, keeping the lease. */
  private async checkpoint(): Promise<void> {
    this.budget.force(1);
    const result = await this.env.DB.prepare(
      'UPDATE backup_state SET phase = ?, progress = ?, updated_at = ? WHERE set_id = ? AND lease_id = ?',
    )
      .bind(
        this.phase,
        JSON.stringify(this.progress),
        this.now().toISOString(),
        this.set,
        this.leaseId,
      )
      .run();
    if (result.meta.changes !== 1) throw new LeaseLost();
  }

  private async advance(phase: Phase): Promise<void> {
    this.phase = phase;
    await this.checkpoint();
  }

  private async dumpD1(): Promise<void> {
    const db = this.env.DB;
    if (!this.progress.schema_done) {
      this.budget.spend(2);
      const { results } = await db
        .prepare(
          "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' " +
            "AND name NOT LIKE '_cf_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 " +
            "WHEN 'view' THEN 2 ELSE 3 END, name",
        )
        .all<{ type: string; name: string; sql: string }>();
      // Every CREATE statement, including the skipped tables', so an empty database gets the
      // full schema back.
      const schema = results.map((r) => `${r.sql};\n`).join('');
      await this.env.BACKUPS.put(`${this.prefix}d1/schema.sql`, schema, {
        httpMetadata: { contentType: 'application/sql' },
      });
      this.progress.schema_done = true;
      await this.checkpoint();
    }

    this.budget.spend(1);
    const { results: tables } = await db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string; sql: string | null }>();
    const done = new Set(this.progress.tables.map((t) => t.name));
    for (const table of tables) {
      if (isSkippedTable(table.name) || done.has(table.name)) continue;
      this.progress.tables.push(await this.dumpTable(table.name, table.sql ?? ''));
      await this.checkpoint();
    }
  }

  private async dumpTable(name: string, sql: string): Promise<TableResult> {
    const db = this.env.DB;
    const ident = quoteIdent(name);
    this.budget.spend(1);
    const count = await db.prepare(`SELECT COUNT(*) AS n FROM ${ident}`).first<{ n: number }>();
    const pages = Math.max(1, Math.ceil((count?.n ?? 0) / PAGE_ROWS)) + 1;
    if (pages > DEFAULT_BUDGET - RESERVE - 10) {
      throw new Error(`table ${name} is too large for one chunk (${pages} pages)`);
    }
    this.budget.spend(pages + 1);
    const order = /without\s+rowid/i.test(sql) ? '' : ' ORDER BY rowid';
    const lines: string[] = [];
    for (let offset = 0; ; offset += PAGE_ROWS) {
      const { results } = await db
        .prepare(`SELECT * FROM ${ident}${order} LIMIT ? OFFSET ?`)
        .bind(PAGE_ROWS, offset)
        .all<Record<string, unknown>>();
      for (const row of results) lines.push(rowToJson(row));
      if (results.length < PAGE_ROWS) break;
    }
    const body = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
    const bytes = new TextEncoder().encode(body);
    const key = `${this.prefix}d1/${name}.jsonl`;
    await this.env.BACKUPS.put(key, bytes, {
      httpMetadata: { contentType: 'application/x-ndjson' },
    });
    return { name, key, rows: lines.length, bytes: bytes.byteLength };
  }

  private async copyR2(): Promise<void> {
    for (;;) {
      // One list call plus a get and a put per object.
      const limit = Math.min(1000, Math.floor((this.budget.remaining - 1) / 2));
      if (limit < 1) throw new OutOfBudget();
      this.budget.spend(1);
      const options: R2ListOptions = { limit };
      if (this.progress.r2_cursor !== null) options.cursor = this.progress.r2_cursor;
      const page = await this.env.SAVES.list(options);
      // The page was sized to fit, so its get/put pairs are within the budget.
      this.budget.force(2 * page.objects.length);
      let objects = 0;
      let bytes = 0;
      let skipped = 0;
      for (const listed of page.objects) {
        const object = await this.env.SAVES.get(listed.key);
        if (object === null) {
          skipped += 1;
          continue;
        }
        await this.env.BACKUPS.put(`${this.prefix}r2/${listed.key}`, object.body, {
          httpMetadata: object.httpMetadata ?? {},
          customMetadata: object.customMetadata ?? {},
        });
        objects += 1;
        bytes += object.size;
      }
      // Counters and cursor are committed together, so a repeated page is never counted twice.
      this.progress.r2_objects += objects;
      this.progress.r2_bytes += bytes;
      this.progress.r2_skipped += skipped;
      this.progress.r2_cursor = page.truncated ? page.cursor : null;
      if (!page.truncated) return;
      await this.checkpoint();
    }
  }

  private async retention(): Promise<void> {
    const bucket = this.env.BACKUPS;
    const sets: string[] = [];
    let cursor: string | undefined;
    do {
      this.budget.spend(1);
      const options: R2ListOptions = { prefix: SET_PREFIX, delimiter: '/' };
      if (cursor !== undefined) options.cursor = cursor;
      const page = await bucket.list(options);
      for (const prefix of page.delimitedPrefixes) {
        const set = setFromPrefix(prefix);
        if (set !== null) sets.push(set);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor !== undefined);
    if (!sets.includes(this.set)) sets.push(this.set);
    sets.sort().reverse();

    const kept: string[] = [];
    for (const set of sets) {
      if (kept.length >= KEEP_SETS) break;
      if (set === this.set) {
        kept.push(set);
        continue;
      }
      this.budget.spend(1);
      if ((await bucket.head(`${setPrefix(set)}manifest.json`)) !== null) kept.push(set);
    }
    const oldestKept = kept[kept.length - 1];
    if (kept.length < KEEP_SETS || oldestKept === undefined) return;

    for (const set of sets) {
      if (set >= oldestKept) continue;
      await this.deletePrefix(setPrefix(set));
      if (!this.progress.retention_deleted.includes(set)) this.progress.retention_deleted.push(set);
      this.budget.force(1);
      await this.env.DB.prepare(
        'UPDATE backups SET pruned_at = ? WHERE set_id = ? AND pruned_at IS NULL',
      )
        .bind(this.now().toISOString(), set)
        .run();
      await this.checkpoint();
    }
  }

  private async deletePrefix(prefix: string): Promise<void> {
    const bucket = this.env.BACKUPS;
    for (;;) {
      this.budget.spend(2);
      // No cursor: every page is deleted before the next list, so the first page is always next.
      const page = await bucket.list({ prefix, limit: 1000 });
      const keys = page.objects.map((o) => o.key);
      if (keys.length > 0) await bucket.delete(keys);
      if (!page.truncated) return;
    }
  }

  private async finish(): Promise<Manifest> {
    const completed = this.now();
    const p = this.progress;
    const rows = p.tables.reduce((sum, t) => sum + t.rows, 0);
    const d1Bytes = p.tables.reduce((sum, t) => sum + t.bytes, 0);
    const version = this.env.CF_VERSION_METADATA;
    const manifest: Manifest = {
      schema_version: MANIFEST_SCHEMA_VERSION,
      set: this.set,
      prefix: this.prefix,
      started_at: this.row.started_at,
      completed_at: completed.toISOString(),
      duration_ms: this.row.active_ms + (Date.now() - this.startedMs),
      elapsed_ms: Math.max(0, completed.getTime() - Date.parse(this.row.started_at)),
      invocations: this.row.invocations,
      worker_version: version === undefined ? null : { id: version.id, tag: version.tag },
      d1: { schema_key: `${this.prefix}d1/schema.sql`, tables: p.tables, rows, bytes: d1Bytes },
      r2: { objects: p.r2_objects, bytes: p.r2_bytes, skipped: p.r2_skipped },
      retention: { keep: KEEP_SETS, deleted: p.retention_deleted },
    };
    const json = JSON.stringify(manifest, null, 2);
    this.budget.force(3);
    await this.env.BACKUPS.put(`${this.prefix}manifest.json`, json, {
      httpMetadata: { contentType: 'application/json' },
    });
    await this.env.DB.prepare(
      'INSERT OR REPLACE INTO backups (set_id, started_at, completed_at, table_count, row_count, ' +
        'object_count, bytes, ' +
        'duration_ms, invocations, manifest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        this.set,
        manifest.started_at,
        manifest.completed_at,
        p.tables.length,
        rows,
        p.r2_objects,
        d1Bytes + p.r2_bytes,
        manifest.duration_ms,
        manifest.invocations,
        json,
      )
      .run();
    this.phase = 'done';
    await this.save(null);
    return manifest;
  }
}
