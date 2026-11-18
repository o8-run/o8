CREATE TABLE IF NOT EXISTS prompt_library (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      body_fingerprint TEXT NOT NULL,
      tags_json TEXT NOT NULL DEFAULT '[]',
      scope TEXT NOT NULL DEFAULT 'global',
      repo_path TEXT,
      source_kind TEXT NOT NULL DEFAULT 'manual',
      source_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER,
      use_count INTEGER NOT NULL DEFAULT 0,
      CHECK (scope IN ('global', 'repo')),
      CHECK (source_kind IN ('manual', 'automation', 'watched_agent')),
      CHECK (
        (scope = 'global' AND repo_path IS NULL)
        OR (scope = 'repo' AND repo_path IS NOT NULL AND length(trim(repo_path)) > 0)
      )
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_library_global_body
      ON prompt_library(body_fingerprint)
      WHERE scope = 'global';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_library_repo_body
      ON prompt_library(repo_path, body_fingerprint)
      WHERE scope = 'repo';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_library_source
      ON prompt_library(source_kind, source_id)
      WHERE source_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_prompt_library_scope_recent
      ON prompt_library(scope, repo_path, last_used_at DESC, updated_at DESC);
