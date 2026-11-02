-- Real-money exposure holds. Before a real spin runs, its biggest possible net win
-- (worst payout minus stake) is reserved here in one atomic, conditional insert:
-- it only succeeds while casino wallet - owed to players - other open holds still
-- covers it. The hold is removed once the settled balance is copied to players,
-- and expires on its own if a spin never finishes. So any number of players
-- spinning at the same moment can never be owed more than the wallet holds.
CREATE TABLE IF NOT EXISTS spin_holds (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  units INTEGER NOT NULL CHECK (units >= 0),
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS spin_holds_expiry ON spin_holds (expires_at);
