-- Deposits nobody has claimed yet (unmatched, below the minimum, or assigned but not yet credited) are
-- customer money until an owner resolves them. A resolution records why a deposit left that state:
-- 'house_funding' (the owner's own top up, marked by hand with step-up) or 'assigned' (credited to a player).
ALTER TABLE chain_deposits ADD COLUMN resolution TEXT;
ALTER TABLE chain_deposits ADD COLUMN resolved_at TEXT;
ALTER TABLE chain_deposits ADD COLUMN resolved_by TEXT;
