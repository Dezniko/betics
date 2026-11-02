-- Audit fixes (2026-10-30).
-- Read load: the admin balance check reads the newest ledger row per player; with only
-- (player_id, created_at) it walked every row of that player. (player_id, real_money) keeps
-- rows in rowid order per key, so "ORDER BY rowid DESC LIMIT 1" is a single index step.
CREATE INDEX IF NOT EXISTS ledger_player_money ON ledger (player_id, real_money);
-- What players are owed: only players with a real balance matter.
CREATE INDEX IF NOT EXISTS players_real_tics ON players (real_tics_cents) WHERE real_tics_cents > 0;
-- chain_withdrawals: new status 'holding' (the row is claimed before the money is set aside, so a
-- request sent several times at once can only hold once) and row_mac (the payouts Worker
-- authenticates the treasury rows it signs). SQLite cannot change a CHECK, so rebuild the table.
CREATE TABLE chain_withdrawals_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'player' CHECK (kind IN ('player', 'treasury')),
  player_id TEXT,
  chain_id INTEGER NOT NULL,
  to_address TEXT NOT NULL,
  amount_units INTEGER NOT NULL CHECK (amount_units > 0),
  fee_units INTEGER NOT NULL DEFAULT 0,
  send_units INTEGER NOT NULL CHECK (send_units > 0),
  -- blocked: stopped before payment and the money is still held (needs review, still owed);
  -- cancelling: cancelled but the refund to the player is not confirmed yet (still owed).
  status TEXT NOT NULL CHECK (status IN ('holding', 'queued', 'signing', 'sending', 'sent', 'failed', 'cancelled', 'blocked', 'cancelling')),
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
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  row_mac TEXT
);
INSERT INTO chain_withdrawals_new (id, kind, player_id, chain_id, to_address, amount_units, fee_units, send_units, status, release_at, nonce, tx_hashes, tx_hash, raw_tx,
  max_fee_wei, attempts, last_error, requested_by, cancelled_by, sent_at, broadcast_at, created_at, updated_at)
  SELECT id, kind, player_id, chain_id, to_address, amount_units, fee_units, send_units, status, release_at, nonce, tx_hashes, tx_hash, raw_tx,
  max_fee_wei, attempts, last_error, requested_by, cancelled_by, sent_at, broadcast_at, created_at, updated_at FROM chain_withdrawals;
DROP TABLE chain_withdrawals;
ALTER TABLE chain_withdrawals_new RENAME TO chain_withdrawals;
CREATE INDEX IF NOT EXISTS chain_withdrawals_status ON chain_withdrawals (status, release_at);
CREATE INDEX IF NOT EXISTS chain_withdrawals_player ON chain_withdrawals (player_id, created_at);
-- Quick-lane credits per sending wallet: booked with one conditional INSERT so parallel deposit
-- checks can never pass the rolling 24-hour cap together.
CREATE TABLE IF NOT EXISTS quick_lane (
  deposit_id TEXT PRIMARY KEY,
  from_address TEXT NOT NULL,
  units INTEGER NOT NULL CHECK (units > 0),
  at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS quick_lane_from ON quick_lane (from_address, at_ms);
-- Money leaving the wallet (player and treasury) is summed by kind and status on every spin.
CREATE INDEX IF NOT EXISTS chain_withdrawals_kind_status ON chain_withdrawals (kind, status);
-- Central copy order: each copy of a player's balances carries a rising number, so an older copy
-- that lands late can never overwrite a newer one.
ALTER TABLE players ADD COLUMN flush_seq INTEGER NOT NULL DEFAULT 0;
