/**
 * Maintainer routes for the weekly backups (docs/specs/backups-v1.md §6): the list of runs and a
 * manual chunk. Behind the normal Access check and `ADMIN_EMAILS` (the same maintainer check as the
 * community review queue); everyone else gets `403 forbidden`.
 */
import type { Context, Hono } from 'hono';
import type { AppEnv } from './app';
import { runBackup } from './backup';
import { isMaintainer } from './community';
import { ApiError } from './errors';

export interface BackupRouteDeps {
  now: () => Date;
}

interface RunRow {
  set_id: string;
  completed_at: string;
  table_count: number;
  row_count: number;
  object_count: number;
  bytes: number;
  duration_ms: number;
  invocations: number;
  pruned_at: string | null;
}

interface StateRow {
  set_id: string;
  started_at: string;
  updated_at: string;
  phase: string;
  invocations: number;
  lease_until: string | null;
  error: string | null;
}

/** Number of finished runs `GET /api/admin/backups` returns. */
export const RUNS_LISTED = 20;

function requireMaintainer(c: Context<AppEnv>): void {
  if (!isMaintainer(c.env.ADMIN_EMAILS, c.get('user').email)) {
    throw new ApiError('forbidden', 'only the maintainer may do this');
  }
}

export function registerBackupRoutes(app: Hono<AppEnv>, deps: BackupRouteDeps): void {
  app.get('/api/admin/backups', async (c) => {
    requireMaintainer(c);
    const { results: runs } = await c.env.DB.prepare(
      'SELECT set_id, completed_at, table_count, row_count, object_count, bytes, duration_ms, ' +
        'invocations, pruned_at FROM backups ORDER BY set_id DESC LIMIT ?',
    )
      .bind(RUNS_LISTED)
      .all<RunRow>();
    const { results: unfinished } = await c.env.DB.prepare(
      'SELECT set_id, started_at, updated_at, phase, invocations, lease_until, error ' +
        "FROM backup_state WHERE phase <> 'done' ORDER BY set_id DESC",
    ).all<StateRow>();
    return c.json({
      runs: runs.map((r) => ({
        set: r.set_id,
        completed_at: r.completed_at,
        tables: r.table_count,
        rows: r.row_count,
        objects: r.object_count,
        bytes: r.bytes,
        duration_ms: r.duration_ms,
        invocations: r.invocations,
        pruned_at: r.pruned_at,
      })),
      unfinished: unfinished.map((s) => ({
        set: s.set_id,
        started_at: s.started_at,
        updated_at: s.updated_at,
        phase: s.phase,
        invocations: s.invocations,
        lease_until: s.lease_until,
        error: s.error,
      })),
    });
  });

  app.post('/api/admin/backup', async (c) => {
    requireMaintainer(c);
    const result = await runBackup(c.env, { now: deps.now });
    return c.json({ set: result.set, status: result.status, phase: result.phase });
  });
}
