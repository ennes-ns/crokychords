/**
 * Weekly backups in the Workers runtime (docs/specs/backups-v1.md §9), against the local
 * Miniflare D1 and R2 bindings: a full run, retention, resuming after a budget stop or a crash,
 * the lease, the maintainer routes and the scheduled() export. Every test starts from an empty
 * database and empty buckets.
 */
import {
  createExecutionContext,
  createScheduledController,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { Env } from '../src/app';
import type { BackupEnv, Manifest } from '../src/backup';
import {
  KEEP_SETS,
  isSkippedTable,
  quoteIdent,
  rowToJson,
  runBackup,
  setFromPrefix,
  setIdFor,
} from '../src/backup';
import worker from '../src/index';
import { authed, makeKey, signToken, staticJwks } from './helpers';
import type { ErrorJson, TestKey } from './helpers';

const MONDAY = new Date('2026-10-26T03:00:00.000Z');
const SET = '2026-10-26';
const PREFIX = `weekly/${SET}/`;
const at = () => MONDAY;

/** Users, saves and their bodies, plus one binary object outside saves/ (a community sample). */
async function seed(users = 2, savesPerUser = 2): Promise<{ objects: number; bytes: number }> {
  let objects = 0;
  let bytes = 0;
  for (let u = 0; u < users; u++) {
    const userId = `user-${u}`;
    await env.DB.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)')
      .bind(userId, `u${u}@example.test`, '2026-10-01T00:00:00.000Z')
      .run();
    for (let s = 0; s < savesPerUser; s++) {
      const body = JSON.stringify({ id: `s${s}`, version: 1, title: `Save ${s}` });
      await env.DB.prepare(
        'INSERT INTO saves (user_id, id, version, updated_at, title, size) VALUES (?, ?, ?, ?, ?, ?)',
      )
        .bind(userId, `s${s}`, 1, '2026-10-02T00:00:00.000Z', `Save ${s}`, body.length)
        .run();
      await env.SAVES.put(`saves/${userId}/s${s}.json`, body, {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { version: '1' },
      });
      objects += 1;
      bytes += body.length;
    }
  }
  const sample = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4, 0, 255]);
  await env.SAVES.put(`samples/${'a'.repeat(64)}`, sample, {
    httpMetadata: { contentType: 'audio/wav' },
  });
  return { objects: objects + 1, bytes: bytes + sample.byteLength };
}

async function keys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list(cursor === undefined ? { prefix } : { prefix, cursor });
    out.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return out.sort();
}

async function text(key: string): Promise<string> {
  const object = await env.BACKUPS.get(key);
  if (object === null) throw new Error(`missing ${key}`);
  return object.text();
}

async function manifestOf(set: string): Promise<Manifest> {
  return JSON.parse(await text(`weekly/${set}/manifest.json`)) as Manifest;
}

/** Run chunks until the set is complete; returns the number of chunks. */
async function runToEnd(bindings: BackupEnv, budget: number): Promise<number> {
  for (let i = 1; i <= 100; i++) {
    const result = await runBackup(bindings, { now: at, budget });
    if (result.status === 'complete') return i;
    expect(result.status).toBe('partial');
  }
  throw new Error('backup did not finish');
}

/** BACKUPS that fails on the n-th put, like an invocation that dies halfway. */
function failingBucket(bucket: R2Bucket, failOnPut: number): R2Bucket {
  let puts = 0;
  return new Proxy(bucket, {
    get(target, prop) {
      if (prop === 'put') {
        return (...args: Parameters<R2Bucket['put']>) => {
          puts += 1;
          if (puts === failOnPut) {
            const value = args[1];
            if (value instanceof ReadableStream) void value.cancel();
            return Promise.reject(new Error('simulated crash'));
          }
          return target.put(...args);
        };
      }
      const value: unknown = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function addSet(set: string, complete: boolean): Promise<void> {
  await env.BACKUPS.put(`weekly/${set}/d1/users.jsonl`, '{}\n');
  await env.BACKUPS.put(`weekly/${set}/r2/saves/x/y.json`, '{}');
  if (complete) await env.BACKUPS.put(`weekly/${set}/manifest.json`, '{}');
}

describe('helpers', () => {
  it('names sets by UTC date and parses set prefixes', () => {
    expect(setIdFor(new Date('2026-10-26T23:59:59.000Z'))).toBe('2026-10-26');
    expect(setFromPrefix('weekly/2026-10-26/')).toBe('2026-10-26');
    expect(setFromPrefix('weekly/latest/')).toBeNull();
    expect(setFromPrefix('other/2026-10-26/')).toBeNull();
  });

  it('skips internal and transient tables', () => {
    for (const name of ['_cf_KV', 'sqlite_sequence', 'd1_migrations', 'backup_state']) {
      expect(isSkippedTable(name)).toBe(true);
    }
    for (const name of ['users', 'saves', 'backups', 'samples']) {
      expect(isSkippedTable(name)).toBe(false);
    }
  });

  it('quotes identifiers and encodes blobs as base64', () => {
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
    expect(rowToJson({ a: 1, b: new Uint8Array([1, 2, 255]).buffer, c: null })).toBe(
      '{"a":1,"b":{"$base64":"AQL/"},"c":null}',
    );
  });
});

describe('a full run', () => {
  it('writes the schema, every table, every object and the manifest', async () => {
    const { objects, bytes } = await seed();
    const result = await runBackup(env, { now: at });
    expect(result).toMatchObject({ set: SET, status: 'complete', phase: 'done' });

    const schema = await text(`${PREFIX}d1/schema.sql`);
    expect(schema).toContain('CREATE TABLE users');
    expect(schema).toContain('CREATE TABLE saves');
    expect(schema).toContain('CREATE INDEX saves_by_updated');

    const d1Keys = await keys(env.BACKUPS, `${PREFIX}d1/`);
    expect(d1Keys).toContain(`${PREFIX}d1/users.jsonl`);
    expect(d1Keys).toContain(`${PREFIX}d1/saves.jsonl`);
    expect(d1Keys).toContain(`${PREFIX}d1/backups.jsonl`);
    expect(d1Keys).not.toContain(`${PREFIX}d1/backup_state.jsonl`);
    expect(d1Keys).not.toContain(`${PREFIX}d1/d1_migrations.jsonl`);
    expect(d1Keys.some((k) => k.includes('/_cf_'))).toBe(false);

    const users = (await text(`${PREFIX}d1/users.jsonl`)).trim().split('\n');
    expect(users).toHaveLength(2);
    expect(JSON.parse(users[0] ?? '')).toMatchObject({ id: 'user-0' });
    const saves = (await text(`${PREFIX}d1/saves.jsonl`)).trim().split('\n');
    expect(saves).toHaveLength(4);

    const copied = await keys(env.BACKUPS, `${PREFIX}r2/`);
    const source = await keys(env.SAVES, '');
    expect(copied).toEqual(source.map((k) => `${PREFIX}r2/${k}`));
    const save = await env.BACKUPS.head(`${PREFIX}r2/saves/user-0/s0.json`);
    expect(save?.httpMetadata?.contentType).toBe('application/json');
    expect(save?.customMetadata).toEqual({ version: '1' });
    const sample = await env.BACKUPS.get(`${PREFIX}r2/samples/${'a'.repeat(64)}`);
    expect(sample?.httpMetadata?.contentType).toBe('audio/wav');
    expect(new Uint8Array((await sample?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(
      new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4, 0, 255]),
    );

    const manifest = await manifestOf(SET);
    expect(manifest).toMatchObject({
      schema_version: 1,
      set: SET,
      prefix: PREFIX,
      invocations: 1,
      worker_version: { id: expect.any(String), tag: expect.any(String) },
      r2: { objects, bytes, skipped: 0 },
      retention: { keep: KEEP_SETS, deleted: [] },
    });
    expect(manifest.d1.tables.find((t) => t.name === 'users')?.rows).toBe(2);
    expect(manifest.d1.rows).toBe(manifest.d1.tables.reduce((n, t) => n + t.rows, 0));
    expect(result.manifest).toEqual(manifest);

    const run = await env.DB.prepare('SELECT * FROM backups WHERE set_id = ?')
      .bind(SET)
      .first<Record<string, unknown>>();
    expect(run).toMatchObject({ set_id: SET, object_count: objects, invocations: 1 });
    expect(JSON.parse(String(run?.['manifest']))).toEqual(manifest);
  });

  it('does nothing on a second run the same day', async () => {
    await seed();
    await runBackup(env, { now: at });
    const before = await text(`${PREFIX}manifest.json`);
    await env.SAVES.put('saves/user-0/new.json', '{}');

    const again = await runBackup(env, { now: () => new Date('2026-10-26T09:00:00.000Z') });
    expect(again).toEqual({ set: SET, status: 'complete', phase: 'done' });
    expect(await text(`${PREFIX}manifest.json`)).toBe(before);
    expect(await env.BACKUPS.head(`${PREFIX}r2/saves/user-0/new.json`)).toBeNull();
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM backups').first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('backs up empty buckets and tables', async () => {
    const result = await runBackup(env, { now: at });
    expect(result.status).toBe('complete');
    const manifest = await manifestOf(SET);
    expect(manifest.r2).toEqual({ objects: 0, bytes: 0, skipped: 0 });
    expect(await text(`${PREFIX}d1/users.jsonl`)).toBe('');
  });
});

describe('retention', () => {
  const older = [
    '2026-10-19',
    '2026-10-12',
    '2026-10-05',
    '2026-09-28',
    '2026-09-21',
    '2026-09-14',
    '2026-09-07',
    '2026-08-31',
  ];

  it('deletes the 9th complete set and older leftovers, keeps newer unfinished sets', async () => {
    await seed(1, 1);
    for (const set of older) await addSet(set, true);
    await addSet('2026-10-20', false); // unfinished manual run, newer than the oldest kept set
    await addSet('2026-08-01', false); // unfinished and older: deleted with the rest
    await env.DB.prepare(
      'INSERT INTO backups (set_id, started_at, completed_at, table_count, row_count, object_count, bytes, ' +
        "duration_ms, invocations, manifest) VALUES ('2026-08-31', 'x', 'x', 0, 0, 0, 0, 0, 1, '{}')",
    ).run();

    await runBackup(env, { now: at });

    const listed = await env.BACKUPS.list({ prefix: 'weekly/', delimiter: '/' });
    const sets = listed.delimitedPrefixes.map((p) => setFromPrefix(p)).sort();
    expect(sets).toEqual([...older.slice(0, 7), '2026-10-20', SET].sort());
    expect(await keys(env.BACKUPS, 'weekly/2026-08-31/')).toEqual([]);
    expect(await keys(env.BACKUPS, 'weekly/2026-08-01/')).toEqual([]);
    expect((await manifestOf(SET)).retention.deleted.sort()).toEqual(['2026-08-01', '2026-08-31']);
    const pruned = await env.DB.prepare(
      "SELECT pruned_at FROM backups WHERE set_id = '2026-08-31'",
    ).first<{ pruned_at: string | null }>();
    expect(pruned?.pruned_at).toBe(MONDAY.toISOString());
  });

  it('deletes nothing while fewer than 8 complete sets exist', async () => {
    for (const set of older.slice(0, 6)) await addSet(set, true);
    await addSet('2026-01-05', false);
    await runBackup(env, { now: at });
    expect((await manifestOf(SET)).retention.deleted).toEqual([]);
    expect(await keys(env.BACKUPS, 'weekly/2026-01-05/')).toHaveLength(2);
  });
});

describe('resume', () => {
  it('continues after the budget runs out and ends with the same set', async () => {
    const { objects, bytes } = await seed(3, 12);
    const chunks = await runToEnd(env, 30);
    expect(chunks).toBeGreaterThan(2);

    const manifest = await manifestOf(SET);
    expect(manifest.invocations).toBe(chunks);
    expect(manifest.r2).toEqual({ objects, bytes, skipped: 0 });
    expect(manifest.d1.tables.find((t) => t.name === 'saves')?.rows).toBe(36);
    const names = manifest.d1.tables.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    const copied = await keys(env.BACKUPS, `${PREFIX}r2/`);
    expect(copied).toHaveLength(objects);
    const runs = await env.DB.prepare('SELECT COUNT(*) AS n FROM backups').first<{ n: number }>();
    expect(runs?.n).toBe(1);
  });

  it('recovers from a crash halfway through the copy without double counting', async () => {
    const { objects, bytes } = await seed(2, 5);
    // Puts: schema, then one per table, then the objects; the 15th put is inside the R2 phase.
    const crashing = { ...env, BACKUPS: failingBucket(env.BACKUPS, 15) };
    await expect(runBackup(crashing, { now: at })).rejects.toThrow('simulated crash');

    const state = await env.DB.prepare(
      'SELECT phase, error, lease_id FROM backup_state WHERE set_id = ?',
    )
      .bind(SET)
      .first<{ phase: string; error: string | null; lease_id: string | null }>();
    expect(state?.phase).toBe('r2');
    expect(state?.error).toContain('simulated crash');
    expect(state?.lease_id).toBeNull();

    const result = await runBackup(env, { now: at });
    expect(result.status).toBe('complete');
    const manifest = await manifestOf(SET);
    expect(manifest.r2).toEqual({ objects, bytes, skipped: 0 });
    expect(manifest.invocations).toBe(2);
    expect(await keys(env.BACKUPS, `${PREFIX}r2/`)).toHaveLength(objects);
  });

  it('answers busy while another invocation holds the lease', async () => {
    await seed(1, 1);
    await env.DB.prepare(
      'INSERT INTO backup_state (set_id, started_at, updated_at, phase, progress, lease_id, lease_until) ' +
        "VALUES (?, ?, ?, 'r2', '{}', 'other', ?)",
    )
      .bind(SET, MONDAY.toISOString(), MONDAY.toISOString(), '2026-10-26T03:10:00.000Z')
      .run();
    expect(await runBackup(env, { now: at })).toEqual({ set: SET, status: 'busy', phase: 'r2' });

    // Once the lease has expired, the next invocation takes over.
    const later = await runBackup(env, { now: () => new Date('2026-10-26T03:20:00.000Z') });
    expect(later.status).toBe('complete');
  });
});

describe('maintainer routes', () => {
  const MAINTAINER = 'boss@example.test';
  let key: TestKey;
  let boss: string;
  let alice: string;

  beforeAll(async () => {
    key = await makeKey('backup-key');
    boss = await signToken({ key, email: MAINTAINER });
    alice = await signToken({ key, email: 'alice@example.test' });
  });

  function client(vars: Partial<Env> = {}) {
    const app = createApp({ jwks: () => staticJwks([key.jwk]) });
    const bindings = { ...env, ADMIN_EMAILS: MAINTAINER, ...vars };
    return (path: string, init: RequestInit = {}) =>
      Promise.resolve(app.request(`https://api.example.test${path}`, init, bindings));
  }

  it('refuses everyone but the maintainer', async () => {
    for (const [api, token] of [
      [client(), alice],
      [client({ ADMIN_EMAILS: '' }), boss],
    ] as const) {
      for (const [method, path] of [
        ['GET', '/api/admin/backups'],
        ['POST', '/api/admin/backup'],
      ] as const) {
        const res = await api(path, authed(token, { method }));
        expect(res.status).toBe(403);
        expect(((await res.json()) as ErrorJson).error.code).toBe('forbidden');
      }
    }
    const anonymous = await client()('/api/admin/backups');
    expect(anonymous.status).toBe(401);
    const none = await env.DB.prepare('SELECT COUNT(*) AS n FROM backup_state').first<{
      n: number;
    }>();
    expect(none?.n).toBe(0);
  });

  it('runs a chunk and lists runs and unfinished sets', async () => {
    await seed(1, 1);
    await env.DB.prepare(
      'INSERT INTO backup_state (set_id, started_at, updated_at, phase, progress, error) ' +
        "VALUES ('2026-10-19', 'a', 'b', 'r2', '{}', 'Error: boom')",
    ).run();
    const api = client();
    const run = await api('/api/admin/backup', authed(boss, { method: 'POST' }));
    expect(run.status).toBe(200);
    // The route works on today's set (the app's clock is real: it also checks the token).
    const today = setIdFor(new Date());
    expect(await run.json()).toEqual({ set: today, status: 'complete', phase: 'done' });

    const res = await api('/api/admin/backups', authed(boss));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runs: Record<string, unknown>[];
      unfinished: Record<string, unknown>[];
    };
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({ set: today, tables: expect.any(Number), pruned_at: null });
    expect(body.unfinished).toEqual([
      expect.objectContaining({ set: '2026-10-19', phase: 'r2', error: 'Error: boom' }),
    ]);
  });
});

describe('scheduled()', () => {
  it('runs the backup for the date of the cron', async () => {
    await seed(1, 1);
    const controller = createScheduledController({
      scheduledTime: MONDAY.getTime(),
      cron: '0 3 * * 1',
    });
    const ctx = createExecutionContext();
    await worker.scheduled(controller, env);
    await waitOnExecutionContext(ctx);
    const state = await env.DB.prepare('SELECT phase FROM backup_state WHERE set_id = ?')
      .bind(SET)
      .first<{ phase: string }>();
    expect(state?.phase).toBe('done');
    expect(await env.BACKUPS.head(`${PREFIX}manifest.json`)).not.toBeNull();
  });
});
