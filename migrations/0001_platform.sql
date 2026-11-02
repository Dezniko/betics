-- Central platform database (Cloudflare D1). Wallet Durable Objects hold the
-- authoritative live balance; this database holds config, a copy of every
-- round and ledger entry, players, analytics, alerts, messages and admin data.

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('house_currency', '{"symbol":"USDT","name":"Tether USD","contract":"0xdAC17F958D2ee523a2206206994597C13D831ec7","decimals":6,"usdRate":1}'),
  ('mode', '"play"'),
  ('limits', '{"dailyHouseLossAlertCents":200000,"bigWinAlertCents":500000,"playerUpAlertCents":300000,"rtpDriftPct":3,"rtpDriftMinRounds":500}');

CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  maintenance_message TEXT NOT NULL DEFAULT 'This game is having a short break. Please check back soon.',
  min_stake_cents INTEGER NOT NULL DEFAULT 1,
  max_stake_cents INTEGER NOT NULL DEFAULT 1000000,
  max_win_cents INTEGER NOT NULL DEFAULT 5000000,
  max_house_loss_cents INTEGER NOT NULL DEFAULT 5000000,
  math_id TEXT NOT NULL,
  config_version INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO games (id, name, kind, math_id, sort) VALUES ('roulette', 'Roulette', 'table', 'standard', 1);

CREATE TABLE IF NOT EXISTS game_math (
  game_id TEXT NOT NULL,
  id TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT NOT NULL,
  rtp_min REAL NOT NULL,
  rtp_max REAL NOT NULL,
  rtp_target REAL NOT NULL,
  PRIMARY KEY (game_id, id),
  CHECK (rtp_max < 100)
);
INSERT OR IGNORE INTO game_math VALUES
  ('roulette', 'standard', 'Standard European', 'Single zero wheel, standard payouts: straight up 35 to 1, split 17 to 1, street 11 to 1, corner 8 to 1, six line 5 to 1, dozens and columns 2 to 1, even money 1 to 1.', 97.30, 97.30, 97.30),
  ('roulette', 'straight34', 'Straight up 34 to 1', 'Same as standard, except a single number pays 34 to 1 instead of 35 to 1. Payback 94.6% on single numbers, 97.3% on every other bet.', 94.59, 97.30, 96.00);

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'banned')),
  status_reason TEXT,
  display_name TEXT NOT NULL DEFAULT 'player',
  country TEXT,
  city TEXT,
  device TEXT,
  os TEXT,
  browser TEXT,
  language TEXT,
  first_referrer TEXT,
  first_campaign TEXT,
  ip_hash TEXT,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  total_bet_cents INTEGER NOT NULL DEFAULT 0,
  total_paid_cents INTEGER NOT NULL DEFAULT 0,
  rounds INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS players_last_seen ON players (last_seen_at);
CREATE INDEX IF NOT EXISTS players_ip ON players (ip_hash);

CREATE TABLE IF NOT EXISTS player_identities (
  kind TEXT NOT NULL CHECK (kind IN ('guest', 'wallet', 'email', 'telegram')),
  value TEXT NOT NULL,
  player_id TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  consent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (kind, value)
);
CREATE INDEX IF NOT EXISTS identities_player ON player_identities (player_id);

CREATE TABLE IF NOT EXISTS rounds (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  math_id TEXT NOT NULL,
  config_version INTEGER NOT NULL,
  stake_cents INTEGER NOT NULL,
  payout_cents INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  bets_json TEXT NOT NULL,
  fairness_json TEXT NOT NULL,
  currency TEXT NOT NULL,
  real_money INTEGER NOT NULL DEFAULT 0,
  country TEXT,
  device TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rounds_time ON rounds (created_at);
CREATE INDEX IF NOT EXISTS rounds_player ON rounds (player_id, created_at);
CREATE INDEX IF NOT EXISTS rounds_game ON rounds (game_id, created_at);

CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  balance_after_cents INTEGER NOT NULL,
  round_id TEXT,
  meta TEXT,
  currency TEXT NOT NULL,
  real_money INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_player ON ledger (player_id, created_at);
CREATE INDEX IF NOT EXISTS ledger_time ON ledger (created_at);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  title TEXT NOT NULL,
  details TEXT,
  player_id TEXT,
  game_id TEXT,
  round_id TEXT,
  dedupe_key TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  telegram_sent INTEGER NOT NULL DEFAULT 0,
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS alerts_status ON alerts (status, created_at);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  player_id TEXT,
  game_id TEXT,
  country TEXT,
  city TEXT,
  device TEXT,
  os TEXT,
  browser TEXT,
  screen TEXT,
  language TEXT,
  referrer TEXT,
  campaign TEXT,
  value_cents INTEGER,
  meta TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS events_time ON events (created_at, type);
CREATE INDEX IF NOT EXISTS events_player ON events (player_id, created_at);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  button_label TEXT,
  button_url TEXT,
  audience_json TEXT NOT NULL,
  channels_json TEXT NOT NULL DEFAULT '["site"]',
  trigger TEXT NOT NULL DEFAULT 'now' CHECK (trigger IN ('now', 'scheduled', 'wallet_connect', 'first_visit', 'first_deposit')),
  send_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'sent', 'stopped')),
  is_template INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS message_deliveries (
  message_id INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'site',
  delivered_at TEXT NOT NULL DEFAULT (datetime('now')),
  seen_at TEXT,
  clicked_at TEXT,
  dismissed_at TEXT,
  PRIMARY KEY (message_id, player_id, channel)
);
CREATE INDEX IF NOT EXISTS deliveries_player ON message_deliveries (player_id, delivered_at);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'finance', 'support', 'readonly')),
  password_hash TEXT,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  setup_token_hash TEXT,
  setup_expires_at TEXT,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  ip_hash TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS admin_login_attempts (
  key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS login_attempts_key ON admin_login_attempts (key, created_at);

CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER,
  admin_email TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  before_json TEXT,
  after_json TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS audit_time ON admin_audit (created_at);

-- Append-only guards for money and audit history.
CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT, 'ledger is append only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT, 'ledger is append only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON admin_audit BEGIN SELECT RAISE(ABORT, 'audit log is append only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON admin_audit BEGIN SELECT RAISE(ABORT, 'audit log is append only'); END;
CREATE TRIGGER IF NOT EXISTS rounds_no_update BEFORE UPDATE ON rounds BEGIN SELECT RAISE(ABORT, 'rounds are append only'); END;
