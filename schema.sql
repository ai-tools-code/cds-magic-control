CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  active_effect TEXT NOT NULL DEFAULT 'scratch',
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_api_key_hash ON users(api_key_hash);

-- Kept only for backwards compatibility with older builds.
CREATE TABLE IF NOT EXISTS letter_assets (
  user_id TEXT NOT NULL,
  letter TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, letter)
);

-- New in v1.1.0: one shared A-Z library for all users.
CREATE TABLE IF NOT EXISTS global_letter_assets (
  letter TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS peek_state (
  user_id TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  is_done INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
