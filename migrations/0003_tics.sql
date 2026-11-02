-- $TICS on Ethereum: wallet players, deposits to the casino wallet, automatic
-- withdrawals and treasury sends. USDT (NOWPayments / Tron) stays as it is.
-- Amounts are integers in units of 0.01 TICS (the *_cents columns keep that
-- meaning for TICS). On-chain amount = units * 10^16 wei (18 decimals).

INSERT INTO settings (key, value) VALUES ('currencies', '{"USDT":{"symbol":"USDT","name":"Tether USD","network":"tron","contract":"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t","decimals":6,"unitDecimals":2,"enabled":false},"TICS":{"symbol":"TICS","name":"Qubetics","network":"ethereum","chainId":1,"contract":"0x551ecfdba071cb6541f642cb90a073c8c158df05","decimals":18,"unitDecimals":2,"enabled":true}}')
  ON CONFLICT(key) DO NOTHING;
UPDATE settings SET value = '{"symbol":"TICS","name":"Qubetics","network":"ethereum","chainId":1,"contract":"0x551ecfdba071cb6541f642cb90a073c8c158df05","decimals":18,"unitDecimals":2,"usdRate":0}', updated_at = datetime('now')
  WHERE key = 'house_currency';
INSERT INTO settings (key, value) VALUES ('tics_payments', '{"chainId":1,"token":"0x551ecfdba071cb6541f642cb90a073c8c158df05","casinoWallet":null,"treasuryAddress":null,"confirmations":12,"startBlock":null,"realEnabled":false,"depositsOpen":true,"withdrawalsOpen":true,"payoutsPaused":false,"pausedReason":null,"minDepositUnits":100,"minWithdrawalUnits":10000000,"feesEnabled":true,"gasFeeMarginPct":20,"fallbackFeeUnits":50000,"coolingSeconds":120,"largeWithdrawalAlertUnits":5000000,"lowFloatUnits":0,"highFloatUnits":0,"lowEthWei":"5000000000000000","demoStartUnits":10000000}')
  ON CONFLICT(key) DO NOTHING;

-- Roulette limits in TICS units: min 1 TICS, max 50,000 TICS per spin, max win 1,800,000 TICS.
UPDATE games SET min_stake_cents = 100, max_stake_cents = 5000000, max_win_cents = 180000000, max_house_loss_cents = 180000000,
  config_version = config_version + 1, updated_at = datetime('now') WHERE id = 'roulette' AND max_stake_cents = 1000000;

-- Alert amounts in TICS units.
UPDATE settings SET value = '{"dailyHouseLossAlertCents":100000000,"bigWinAlertCents":20000000,"playerUpAlertCents":50000000,"rtpDriftPct":3,"rtpDriftMinRounds":500}', updated_at = datetime('now')
  WHERE key = 'limits' AND value LIKE '%"dailyHouseLossAlertCents":200000,%';

ALTER TABLE players ADD COLUMN wallet_address TEXT;
ALTER TABLE players ADD COLUMN first_connected_at TEXT;
ALTER TABLE players ADD COLUMN last_connected_at TEXT;
ALTER TABLE players ADD COLUMN terms_accepted_at TEXT;
ALTER TABLE players ADD COLUMN real_tics_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN holdings_usd REAL;
ALTER TABLE players ADD COLUMN holdings_updated_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS players_wallet ON players (wallet_address);

-- Sign-In with Ethereum: single-use nonces (stored hashed) and wallet sessions.
CREATE TABLE IF NOT EXISTS wallet_nonces (
  nonce_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS wallet_sessions (
  token_hash TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  address TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS wallet_sessions_player ON wallet_sessions (player_id);

CREATE TABLE IF NOT EXISTS wallet_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL,
  address TEXT NOT NULL,
  country TEXT, city TEXT, device TEXT, os TEXT, browser TEXT, language TEXT, ip_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS wallet_connections_player ON wallet_connections (player_id, created_at);

CREATE TABLE IF NOT EXISTS wallet_holdings (
  player_id TEXT NOT NULL,
  network TEXT NOT NULL,
  token TEXT NOT NULL,
  symbol TEXT, name TEXT, decimals INTEGER,
  amount TEXT NOT NULL,
  usd_price REAL,
  usd_value REAL,
  hidden INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (player_id, network, token)
);

-- Rate limiting for wallet endpoints (per hashed IP and bucket).
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

-- Every $TICS Transfer into the casino wallet that the watcher saw.
CREATE TABLE IF NOT EXISTS chain_deposits (
  id TEXT PRIMARY KEY,                 -- chainId:txHash:logIndex
  chain_id INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  amount_wei TEXT NOT NULL,
  amount_units INTEGER NOT NULL,
  player_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('credited', 'unmatched', 'below_min', 'assigned', 'ignored')),
  note TEXT,
  credited_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS chain_deposits_player ON chain_deposits (player_id, created_at);
CREATE INDEX IF NOT EXISTS chain_deposits_from ON chain_deposits (from_address);
CREATE INDEX IF NOT EXISTS chain_deposits_status ON chain_deposits (status, created_at);

CREATE TABLE IF NOT EXISTS chain_withdrawals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'player' CHECK (kind IN ('player', 'treasury')),
  player_id TEXT,
  chain_id INTEGER NOT NULL,
  to_address TEXT NOT NULL,
  amount_units INTEGER NOT NULL CHECK (amount_units > 0),
  fee_units INTEGER NOT NULL DEFAULT 0,
  send_units INTEGER NOT NULL CHECK (send_units > 0),
  status TEXT NOT NULL CHECK (status IN ('queued', 'signing', 'sending', 'sent', 'failed', 'cancelled')),
  release_at TEXT NOT NULL,
  nonce INTEGER,
  tx_hashes TEXT NOT NULL DEFAULT '[]',
  tx_hash TEXT,
  raw_tx TEXT,
  max_fee_wei TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  requested_by TEXT,
  cancelled_by TEXT,
  sent_at TEXT,
  broadcast_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS chain_withdrawals_status ON chain_withdrawals (status, release_at);
CREATE INDEX IF NOT EXISTS chain_withdrawals_player ON chain_withdrawals (player_id, created_at);

-- Watcher state and the cached casino wallet snapshot (balances, owed, float).
CREATE TABLE IF NOT EXISTS chain_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
