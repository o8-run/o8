CREATE TABLE mobile_diff_comments (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  path TEXT NOT NULL,
  line_number INTEGER NOT NULL,
  side TEXT NOT NULL DEFAULT 'new',
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX idx_mobile_diff_comments_session ON mobile_diff_comments(session_key);
