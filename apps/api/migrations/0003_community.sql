-- Community bank (docs/specs/community-v1.md §1): uploaded samples (bytes in R2 under
-- samples/<sha256>, once per content), their shares with the review state, and the slots that
-- reference a taken sample, so a referenced sample is never deleted.

-- A chosen display name; NULL = the part of the e-mail before '@'.
ALTER TABLE users ADD COLUMN handle TEXT;

CREATE TABLE samples (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  type TEXT NOT NULL,
  duration REAL NOT NULL,
  channels INTEGER NOT NULL,
  name TEXT NOT NULL,
  -- Space-delimited with a leading and trailing space: ' drums kick '.
  tags TEXT NOT NULL DEFAULT ' ',
  root INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (owner_id, sha256)
);

CREATE INDEX samples_by_sha ON samples (sha256);

CREATE TABLE shares (
  sample_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'listed', 'unlisted', 'rejected')),
  -- Id of the licence text the owner acknowledged (docs/specs/community-v1.md §6).
  licence_ack TEXT NOT NULL,
  shared_at TEXT NOT NULL,
  listed_at TEXT,
  unlisted_at TEXT,
  reviewed_at TEXT,
  -- Rejection category, shown to the owner only.
  reason TEXT
);

CREATE INDEX shares_by_state ON shares (state, listed_at DESC, sample_id);

CREATE TABLE sample_refs (
  user_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  sample_id TEXT NOT NULL,
  taken_at TEXT NOT NULL,
  PRIMARY KEY (user_id, slot)
);

CREATE INDEX sample_refs_by_sample ON sample_refs (sample_id);
