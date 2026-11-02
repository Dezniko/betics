// Core Platform API — database layer.
// Uses Node's built-in node:sqlite for local dev (zero native deps).
// Swap-in note: production will move this to Postgres per the design spec;
// the ledger/users/rounds schema below is written to translate directly.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', '..', 'data', 'casino.db');

export const db = new DatabaseSync(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    balance_cents INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Append-only ledger. Never UPDATE or DELETE a row here — the balance
  -- is always reconstructable as the sum of ledger rows for a user.
  CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL, -- deposit | bet_reserve | bet_settle_win | bet_settle_loss | admin_adjustment
    amount_cents INTEGER NOT NULL, -- signed: negative for debits, positive for credits
    balance_after_cents INTEGER NOT NULL,
    round_id INTEGER,
    meta TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS rounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    game TEXT NOT NULL,
    stake_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'reserved', -- reserved | settled
    bet_json TEXT NOT NULL,
    outcome_json TEXT,
    payout_cents INTEGER,
    server_seed TEXT NOT NULL,
    server_seed_hash TEXT NOT NULL,
    client_seed TEXT NOT NULL,
    nonce INTEGER NOT NULL,
    revealed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS admin_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    meta TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- The server seed a user's NEXT round will use. Its hash is shown to the
  -- player before they place a single bet — the whole point of "provably
  -- fair" is that this commitment exists and is visible *before* play, not
  -- just revealed afterwards. One row per user; replaced (not appended)
  -- each time a round consumes it and a fresh one is minted.
  CREATE TABLE IF NOT EXISTS fairness_commitments (
    user_id INTEGER PRIMARY KEY,
    server_seed TEXT NOT NULL,
    server_seed_hash TEXT NOT NULL,
    client_seed TEXT NOT NULL,
    nonce INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

export function getOrCreateDemoUser(username) {
  const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (existing) return existing;
  const startingBalanceCents = 100000; // $1000 demo balance
  const info = db
    .prepare('INSERT INTO users (username, balance_cents) VALUES (?, ?)')
    .run(username, startingBalanceCents);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid));
}

export function getUser(userId) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}
