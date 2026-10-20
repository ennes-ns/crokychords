-- Weekly backups (docs/specs/backups-v1.md). `backups`: one row per finished set, kept as history
-- after retention deleted the files (`pruned_at`). `backup_state`: progress of a set across
-- invocations, with a lease so two invocations never work on the same set at once.
CREATE TABLE backups (
  set_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  table_count INTEGER NOT NULL,
  row_count INTEGER NOT NULL,
  object_count INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  invocations INTEGER NOT NULL,
  manifest TEXT NOT NULL,
  pruned_at TEXT
);

CREATE TABLE backup_state (
  set_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  phase TEXT NOT NULL,
  progress TEXT NOT NULL,
  invocations INTEGER NOT NULL DEFAULT 0,
  active_ms INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_until TEXT,
  error TEXT
);
