/**
 * Sync configuration (docs/specs/sync-v1.md, "Configuration"): the one place that decides whether
 * the app syncs and where the API lives. Disabled unless the build sets `VITE_SYNC=on`.
 */

export interface SyncConfig {
  enabled: boolean;
  /** Base URL of the API without a trailing slash; same-origin `/api` by default. */
  baseUrl: string;
}

export const DEFAULT_SYNC_BASE_URL = '/api';

const ON = new Set(['on', 'true', '1']);

/** Resolve the config from a Vite-style environment (`import.meta.env`). */
export function syncConfig(env: Record<string, unknown>): SyncConfig {
  const flag = env['VITE_SYNC'];
  const enabled = typeof flag === 'string' && ON.has(flag.trim().toLowerCase());
  const raw = env['VITE_SYNC_API'];
  const base = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : DEFAULT_SYNC_BASE_URL;
  return { enabled, baseUrl: base.replace(/\/+$/, '') };
}
