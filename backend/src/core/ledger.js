// Ledger: the only code allowed to mutate a user's balance.
// Games call reserve() then settle() — they never touch balance_cents
// directly. A per-user in-process lock stands in for the Redis lock the
// design spec calls for in production (single-process local dev today;
// swap for a Redis lock when this runs as multiple service processes).
import { db, getUser } from './db.js';

// node:sqlite is fully synchronous and Node is single-threaded, so a
// function with no `await` inside it already runs atomically with respect
// to every other request — there is no interleaving to guard against yet.
// This stays a named seam so that when the DB layer moves to Postgres
// (async) or this logic moves into a separate service reachable over the
// network, it's obvious where the real per-user lock (Redis) plugs in.
function withUserLock(userId, fn) {
  return fn();
}

export class InsufficientBalanceError extends Error {
  constructor() {
    super('insufficient balance');
    this.code = 'INSUFFICIENT_BALANCE';
  }
}

// Atomically debits stakeCents from the user, writes a round row in
// 'reserved' status, and a matching ledger row. Returns the round id.
export function reserveBet({ userId, game, stakeCents, betJson, serverSeed, serverSeedHash, clientSeed, nonce }) {
  return withUserLock(userId, () => {
    const user = getUser(userId);
    if (!user || user.balance_cents < stakeCents) {
      throw new InsufficientBalanceError();
    }

    db.exec('BEGIN');
    try {
      const newBalance = user.balance_cents - stakeCents;
      db.prepare('UPDATE users SET balance_cents = ? WHERE id = ?').run(newBalance, userId);

      const roundInfo = db
        .prepare(
          `INSERT INTO rounds
           (user_id, game, stake_cents, status, bet_json, server_seed, server_seed_hash, client_seed, nonce)
           VALUES (?, ?, ?, 'reserved', ?, ?, ?, ?, ?)`
        )
        .run(userId, game, stakeCents, JSON.stringify(betJson), serverSeed, serverSeedHash, clientSeed, nonce);

      const roundId = Number(roundInfo.lastInsertRowid);

      db.prepare(
        `INSERT INTO ledger (user_id, type, amount_cents, balance_after_cents, round_id, meta)
         VALUES (?, 'bet_reserve', ?, ?, ?, ?)`
      ).run(userId, -stakeCents, newBalance, roundId, JSON.stringify({ game }));

      db.exec('COMMIT');
      return { roundId, balanceAfter: newBalance };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  });
}

// Settles a previously-reserved round: records the outcome, credits any
// payout, marks the round settled. Idempotent — settling an already-settled
// round is a safe no-op that returns the existing result.
export function settleBet({ roundId, outcomeJson, payoutCents }) {
  const round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(roundId);
  if (!round) throw new Error(`round ${roundId} not found`);

  if (round.status === 'settled') {
    // Already settled (e.g. a retried request) — return the prior result,
    // do not credit twice.
    return {
      balanceAfter: getUser(round.user_id).balance_cents,
      payoutCents: round.payout_cents,
      alreadySettled: true,
    };
  }

  return withUserLock(round.user_id, () => {
    const freshRound = db.prepare('SELECT * FROM rounds WHERE id = ?').get(roundId);
    if (freshRound.status === 'settled') {
      return {
        balanceAfter: getUser(freshRound.user_id).balance_cents,
        payoutCents: freshRound.payout_cents,
        alreadySettled: true,
      };
    }

    const user = getUser(freshRound.user_id);
    db.exec('BEGIN');
    try {
      const newBalance = user.balance_cents + payoutCents;
      db.prepare('UPDATE users SET balance_cents = ? WHERE id = ?').run(newBalance, user.id);

      db.prepare(
        `UPDATE rounds SET status = 'settled', outcome_json = ?, payout_cents = ?, revealed_at = datetime('now')
         WHERE id = ?`
      ).run(JSON.stringify(outcomeJson), payoutCents, roundId);

      if (payoutCents > 0) {
        db.prepare(
          `INSERT INTO ledger (user_id, type, amount_cents, balance_after_cents, round_id, meta)
           VALUES (?, 'bet_settle_win', ?, ?, ?, ?)`
        ).run(user.id, payoutCents, newBalance, roundId, JSON.stringify(outcomeJson));
      } else {
        db.prepare(
          `INSERT INTO ledger (user_id, type, amount_cents, balance_after_cents, round_id, meta)
           VALUES (?, 'bet_settle_loss', 0, ?, ?, ?)`
        ).run(user.id, newBalance, roundId, JSON.stringify(outcomeJson));
      }

      db.exec('COMMIT');
      return { balanceAfter: newBalance, payoutCents, alreadySettled: false };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  });
}
