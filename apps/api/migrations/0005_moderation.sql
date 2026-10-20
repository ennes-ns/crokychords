-- Moderation v1 (docs/specs/moderation-v1.md §2): the automatic checks' recommendation on a share,
-- the owner's one appeal, user reports and an append-only log of every verdict and decision.
-- Nothing here changes a share's state by itself; only the maintainer does.

-- 'ok' | 'flag:<category>'; NULL = not checked yet.
ALTER TABLE shares ADD COLUMN auto_verdict TEXT;
-- JSON: { scores, reasons, notes, peaks, models, policy }.
ALTER TABLE shares ADD COLUMN auto_detail TEXT;
-- The share revision the verdict is about; a rename bumps the revision and makes it stale.
ALTER TABLE shares ADD COLUMN auto_revision INTEGER;
ALTER TABLE shares ADD COLUMN auto_checked_at TEXT;
-- Set by the owner's single "request review" of a rejected share; never cleared.
ALTER TABLE shares ADD COLUMN appealed_at TEXT;

-- One report per user and sample; open while resolved_at IS NULL.
CREATE TABLE reports (
  sample_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY (sample_id, user_id)
);

CREATE INDEX reports_open ON reports (sample_id) WHERE resolved_at IS NULL;
CREATE INDEX reports_by_user ON reports (user_id, created_at);

-- Every automatic verdict and every human action. No e-mail addresses, no reporter ids.
CREATE TABLE moderation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sample_id TEXT NOT NULL,
  revision INTEGER,
  actor TEXT NOT NULL CHECK (actor IN ('auto', 'maintainer', 'owner', 'user')),
  action TEXT NOT NULL CHECK (action IN ('verdict', 'list', 'reject', 'dismiss', 'report', 'appeal', 'delete')),
  verdict TEXT,
  reason TEXT,
  -- JSON; for 'verdict' the scores and model versions.
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX moderation_log_by_sample ON moderation_log (sample_id, id);
