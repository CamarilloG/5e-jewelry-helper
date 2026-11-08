-- 001 初始结构：所有平台大整数标识为 TEXT，金额为十进制字符串，时间为 UTC 毫秒。
CREATE TABLE profiles (
  profile_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);

CREATE TABLE favorites (
  profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,
  account_no TEXT NOT NULL,
  monitor_enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL CHECK (source IN ('local', 'platform')),
  platform_state TEXT NOT NULL DEFAULT 'unknown' CHECK (platform_state IN ('favorited', 'removed', 'unknown')),
  trusted_status TEXT,
  trusted_at INTEGER,
  display_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  display_error TEXT,
  checked_at INTEGER,
  expire_time_ms INTEGER,
  last_change_at INTEGER,
  last_change_from TEXT,
  last_change_to TEXT,
  cycle_id INTEGER NOT NULL DEFAULT 0,
  notified_cycle INTEGER NOT NULL DEFAULT 0,
  baseline_pending INTEGER NOT NULL DEFAULT 1,
  unseen INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, account_no)
);

CREATE TABLE favorite_tombstones (
  profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,
  account_no TEXT NOT NULL,
  removed_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (profile_id, account_no)
);

CREATE TABLE favorite_sync_ops (
  profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,
  account_no TEXT NOT NULL,
  target_status INTEGER NOT NULL CHECK (target_status IN (0, 1)),
  revision INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (profile_id, account_no)
);

CREATE TABLE order_presets (
  profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,
  account_no TEXT NOT NULL,
  rent_kind TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  pay_channel INTEGER NOT NULL,
  auto_coupon INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, account_no)
);

CREATE TABLE filter_presets (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  conditions_json TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  UNIQUE (profile_id, name)
);

CREATE TABLE account_snapshots (
  account_no TEXT PRIMARY KEY,
  data_json TEXT NOT NULL,
  source TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  schema_version INTEGER NOT NULL
);

CREATE TABLE inventory_cache (
  account_no TEXT PRIMARY KEY,
  items_json TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  schema_version INTEGER NOT NULL
);

CREATE TABLE order_attempts (
  attempt_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,
  account_no TEXT NOT NULL,
  params_json TEXT NOT NULL,
  state TEXT NOT NULL,
  payment_order_id TEXT,
  deadline_ms INTEGER,
  release_state TEXT NOT NULL DEFAULT 'NONE',
  lock_requested INTEGER NOT NULL DEFAULT 0,
  create_sent INTEGER NOT NULL DEFAULT 0,
  cleanup_done INTEGER NOT NULL DEFAULT 0,
  finished INTEGER NOT NULL DEFAULT 0,
  reason_json TEXT,
  resolution TEXT,
  trace_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX order_attempts_open ON order_attempts (profile_id, finished);

CREATE TABLE notification_intents (
  nonce TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  account_no TEXT,
  action TEXT NOT NULL,
  preset_digest TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE TABLE settings (
  profile_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, key)
);
