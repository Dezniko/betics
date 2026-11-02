-- Re-audit round 3 (2026-10-30). Additive only: one new column, two new indexes. No table rebuild.

-- Deposits after a chain reorganisation: the same transaction can come back in another block with a
-- different log index, which used to give it a new id (chainId:txHash:logIndex) and a second credit.
-- A transfer is now also identified by what a reorg does not change: its transaction, sender, amount
-- and tx_ordinal = how many identical transfers (same sender and amount) come before it in that
-- transaction (almost always 0). One row per (chain, tx, sender, amount, ordinal).
ALTER TABLE chain_deposits ADD COLUMN tx_ordinal INTEGER;
-- The index is created first (every ordinal is still NULL, and NULLs never clash), so the backfill
-- below finds rows by the index prefix instead of scanning the table once per row.
CREATE UNIQUE INDEX IF NOT EXISTS chain_deposits_transfer ON chain_deposits (chain_id, tx_hash, from_address, amount_wei, tx_ordinal);
-- Backfill: existing ids are unique per (chain, tx, log index), so counting the earlier log indexes of
-- identical transfers in the same transaction gives each existing row a distinct ordinal, and the
-- unique index cannot be violated by existing data.
UPDATE chain_deposits SET tx_ordinal = (
  SELECT COUNT(*) FROM chain_deposits d2
  WHERE d2.chain_id = chain_deposits.chain_id AND d2.tx_hash = chain_deposits.tx_hash AND d2.from_address = chain_deposits.from_address
    AND d2.amount_wei = chain_deposits.amount_wei AND d2.log_index < chain_deposits.log_index
);

-- Table limit: payouts marked 'sent' after the last casino wallet snapshot are still inside that
-- snapshot's token balance, so every spin subtracts them. (status, sent_at) keeps that lookup to the
-- few rows sent since the snapshot; without it the planner walks every row ever sent.
CREATE INDEX IF NOT EXISTS chain_withdrawals_sent_at ON chain_withdrawals (status, sent_at);
