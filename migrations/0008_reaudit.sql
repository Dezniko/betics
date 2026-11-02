-- Re-audit 2026-11-02.
-- R2: deposits credited at a shallow depth are re-checked once Ethereum has finalized their block.
--   finalized_at   when the transfer was seen again in a finalized block (withdrawals may then use it)
--   final_miss_at  first time (ms) the transfer was NOT found after its block was final; a second miss
--                  minutes later means it is gone, and the credit is reversed
--   reversed_at    when that reversal was booked in the player's wallet
-- Every deposit recorded before this migration is days old, so it counts as final already.
ALTER TABLE chain_deposits ADD COLUMN finalized_at TEXT;
ALTER TABLE chain_deposits ADD COLUMN final_miss_at INTEGER;
ALTER TABLE chain_deposits ADD COLUMN reversed_at TEXT;
UPDATE chain_deposits SET finalized_at = datetime('now');
CREATE INDEX IF NOT EXISTS chain_deposits_unfinal ON chain_deposits (player_id, block_number) WHERE credited_at IS NOT NULL AND finalized_at IS NULL;

-- R1: a spin's possible win stays counted until that player's new balance is in the central copy.
-- booked_at (ms) lets the cron ask the player's wallet about bookings that were not released.
ALTER TABLE spin_holds ADD COLUMN booked_at INTEGER;
CREATE INDEX IF NOT EXISTS spin_holds_booked ON spin_holds (booked_at) WHERE booked_at IS NOT NULL;
