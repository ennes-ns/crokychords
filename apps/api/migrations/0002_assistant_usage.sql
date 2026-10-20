-- Assistant usage counters (docs/specs/assistant-v1.md §B2): requests and model cost per scope
-- (a user id, or '*' for everyone) and period ('day:2026-10-20' or 'min:2026-10-20T12:34').
CREATE TABLE assistant_usage (
  scope TEXT NOT NULL,
  period TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, period)
);
