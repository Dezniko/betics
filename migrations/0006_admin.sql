-- betics-admin audit fixes (2026-10-30). Additive only.
-- An owner whose sign-in was just set up (or who was just raised to owner) cannot send to the
-- treasury or change the treasury address before this time (UTC, 'YYYY-MM-DD HH:MM:SS').
ALTER TABLE admins ADD COLUMN treasury_ok_after TEXT;
-- Bank page: deposits and withdrawals of the last 30 days without walking every bet in the ledger.
CREATE INDEX IF NOT EXISTS ledger_type_time ON ledger (type, created_at);
-- Telegram sender (runs every 2 minutes): only the alerts not sent yet.
CREATE INDEX IF NOT EXISTS alerts_unsent ON alerts (telegram_sent, status, id);
-- Old USDT owed figure: only players with a real USDT balance.
CREATE INDEX IF NOT EXISTS players_real_usdt ON players (real_balance_cents) WHERE real_balance_cents > 0;
-- Owner sign-in from a new device: look up this admin's earlier sign-ins.
CREATE INDEX IF NOT EXISTS audit_admin_action ON admin_audit (admin_id, action);
-- Live rounds feeds (Overview every 15 s, Rounds every 5 s) filter by Real/Demo and take the newest:
-- without this, the Real view walks back through every demo round to find 15 real ones.
-- Partial, so the planner only uses it for queries that say "real_money = 1" literally (never for
-- per-player queries, which must keep using rounds_player).
CREATE INDEX IF NOT EXISTS rounds_real_time ON rounds (created_at) WHERE real_money = 1;
