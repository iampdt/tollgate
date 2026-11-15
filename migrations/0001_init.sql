-- API keys. Only the SHA-256 of a key is stored; the key itself is shown once, at creation.
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  requests_per_minute INTEGER NOT NULL,
  tokens_per_day INTEGER NOT NULL,
  cache_mode TEXT NOT NULL DEFAULT 'exact',
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

-- One row per request to the gateway. No prompt or completion text is stored here.
CREATE TABLE traces (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  key_id TEXT NOT NULL,
  model_requested TEXT NOT NULL,
  provider TEXT,
  model_used TEXT,
  status INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  cache TEXT NOT NULL,
  similarity REAL,
  judged TEXT,
  stream INTEGER NOT NULL,
  attempts TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  saved_micros INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL,
  first_token_ms INTEGER,
  overhead_ms INTEGER,
  admit_ms INTEGER,
  cache_ms INTEGER,
  -- Upstreams that failed or were skipped before the one that answered.
  fallbacks INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX traces_key_ts ON traces (key_id, ts DESC);
CREATE INDEX traces_ts ON traces (ts);

-- Vectors in the semantic cache, so expired ones can be found and deleted.
CREATE TABLE cache_vectors (
  id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX cache_vectors_expiry ON cache_vectors (expires_at);
