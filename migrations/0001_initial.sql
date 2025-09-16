-- D1 initial schema for aviator-bot dashboard
PRAGMA foreign_keys=ON;

-- signals: core table storing predictions/signals
CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  round_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL, -- ms epoch
  predicted_class TEXT NOT NULL, -- low|medium|high|extreme
  predicted_multiplier REAL, -- optional
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  model_version TEXT NOT NULL,
  recommended_action TEXT NOT NULL, -- BET|HOLD|WAIT
  suggested_bet_pct REAL, -- optional
  cashout_targets TEXT, -- JSON string
  source TEXT,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_signals_platform_round ON signals(platform, round_id);
CREATE INDEX IF NOT EXISTS ix_signals_platform_time ON signals(platform, timestamp DESC);

-- alerts: deliveries to channels
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  signal_id TEXT NOT NULL,
  channel TEXT NOT NULL, -- telegram|discord|email|webhook
  payload TEXT, -- JSON string
  status TEXT NOT NULL, -- queued|sent|failed
  sent_at INTEGER,
  retries INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (signal_id) REFERENCES signals(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_alerts_signal ON alerts(signal_id);

-- models: model registry
CREATE TABLE IF NOT EXISTS models (
  model_version TEXT PRIMARY KEY,
  model_type TEXT NOT NULL,
  trained_on_until TEXT,
  metrics TEXT,
  created_at INTEGER NOT NULL
);

-- api_keys: hashed keys and limits
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL, -- ingest|viewer|admin
  key_hash TEXT NOT NULL,
  allowed_ips TEXT, -- JSON array string
  rate_limit_per_min INTEGER NOT NULL DEFAULT 60,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_api_keys_role ON api_keys(role);

-- audit logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL, -- api_key_id or user
  action TEXT NOT NULL,
  details TEXT, -- JSON string
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_created_at ON audit_logs(created_at DESC);

-- simple rate limit storage (windowed per key)
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
