-- Users (one row per Access e-mail) and save metadata. Save bodies live in R2.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE saves (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  title TEXT NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE INDEX saves_by_updated ON saves (user_id, updated_at DESC);
