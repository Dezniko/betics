-- Payments (real money). Deposits arrive through a payment provider
-- (NOWPayments, USDT on Tron); withdrawals are requested by players, approved
-- in the admin panel, sent from the casino wallet and recorded with the
-- transaction hash. Play money and real money are separate balances.

ALTER TABLE players ADD COLUMN real_balance_cents INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS deposits (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_ref TEXT,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'confirming', 'partially_paid', 'finished', 'failed', 'expired', 'refunded')),
  network TEXT NOT NULL,
  pay_currency TEXT NOT NULL,
  pay_address TEXT,
  pay_amount TEXT,
  actually_paid TEXT,
  requested_cents INTEGER NOT NULL CHECK (requested_cents > 0),
  credited_cents INTEGER NOT NULL DEFAULT 0,
  tx_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  credited_at TEXT
);
CREATE INDEX IF NOT EXISTS deposits_player ON deposits (player_id, created_at);
CREATE INDEX IF NOT EXISTS deposits_status ON deposits (status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS deposits_provider_ref ON deposits (provider, provider_ref);

CREATE TABLE IF NOT EXISTS withdrawals (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  fee_cents INTEGER NOT NULL DEFAULT 0,
  network TEXT NOT NULL,
  currency TEXT NOT NULL,
  address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'sent', 'rejected', 'failed')),
  reason TEXT,
  tx_hash TEXT,
  approved_by TEXT,
  sent_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS withdrawals_status ON withdrawals (status, created_at);
CREATE INDEX IF NOT EXISTS withdrawals_player ON withdrawals (player_id, created_at);

INSERT OR IGNORE INTO settings (key, value) VALUES ('payments', '{"provider":"nowpayments","network":"tron","payCurrency":"usdttrc20","depositsOpen":false,"withdrawalsOpen":false,"minDepositCents":1000,"minWithdrawalCents":2000,"maxWithdrawalCents":1000000,"withdrawalFeeCents":100,"dailyWithdrawalLimitCents":2000000}');

-- USDT on Tron is the house currency (Dez chose TRC-20 for its low fees).
UPDATE settings SET value = '{"symbol":"USDT","name":"Tether USD","network":"tron","contract":"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t","decimals":6,"usdRate":1}', updated_at = datetime('now')
  WHERE key = 'house_currency' AND value LIKE '%0xdAC17F958D2ee523a2206206994597C13D831ec7%';
INSERT INTO admin_audit (admin_email, action, target, after_json, reason)
  SELECT 'system', 'settings.currency', 'settings:house_currency', value, 'Network set to Tron (TRC-20) as chosen by the owner'
  FROM settings WHERE key = 'house_currency' AND value LIKE '%TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t%';
