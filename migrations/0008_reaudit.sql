-- Re-audit 2026-11-02.
-- R2: deposits credited at a shallow depth are re-checked once Ethereum has finalized their block.
--   finalized_at      when the transfer was seen again in a finalized block (withdrawals may then use it)
--   final_miss_at     first time (ms) the transfer was NOT found after its block was final
--   final_checked_at  last check (ms); the cron checks the longest-unchecked rows first, so rows that
--                     stay open (under review) never crowd out new deposits
--   review_at         the transfer is missing but no independent second provider confirmed it: the
--                     player is paused and an owner alerted, nothing is taken back automatically
--   reversed_at       the transfer is gone (two providers agree): the credit was taken back
--   token             the token contract the transfer was decoded for
-- Every deposit recorded before this migration is days old, so it counts as final already.
ALTER TABLE chain_deposits ADD COLUMN finalized_at TEXT;
ALTER TABLE chain_deposits ADD COLUMN final_miss_at INTEGER;
ALTER TABLE chain_deposits ADD COLUMN final_checked_at INTEGER;
ALTER TABLE chain_deposits ADD COLUMN review_at TEXT;
ALTER TABLE chain_deposits ADD COLUMN reversed_at TEXT;
ALTER TABLE chain_deposits ADD COLUMN token TEXT;
UPDATE chain_deposits SET finalized_at = datetime('now');
CREATE INDEX IF NOT EXISTS chain_deposits_unfinal ON chain_deposits (final_checked_at) WHERE finalized_at IS NULL AND reversed_at IS NULL;

-- R1: a spin's possible win stays counted until that player's new balance is in the central copy.
-- booked_at (ms) lets the cron ask the player's wallet about bookings that were not released;
-- checked_at (ms) makes it ask about the longest-unchecked ones first.
-- ROLLBACK NOTE: code from before this migration never releases these bookings. Before deploying an
-- older game Worker run: UPDATE spin_holds SET expires_at = <now ms + 60000> WHERE booked_at IS NOT NULL
ALTER TABLE spin_holds ADD COLUMN booked_at INTEGER;
ALTER TABLE spin_holds ADD COLUMN checked_at INTEGER;
CREATE INDEX IF NOT EXISTS spin_holds_booked ON spin_holds (checked_at) WHERE booked_at IS NOT NULL;
