// Shared provably-fair RNG core. Every game (roulette now, slots/blackjack
// later) derives its randomness from here — one fairness implementation,
// one verifier, used by all games.
//
// Model: HMAC-SHA256(serverSeed, `${clientSeed}:${nonce}`) -> uniform int
// in [0, max). Server seed is committed (its SHA-256 hash) before the round
// is played, then revealed after settlement so the player can independently
// recompute the outcome and confirm it matches.
import crypto from 'node:crypto';

export function generateServerSeed() {
  return crypto.randomBytes(32).toString('hex');
}

export function hashServerSeed(serverSeed) {
  return crypto.createHash('sha256').update(serverSeed).digest('hex');
}

export function generateClientSeed() {
  return crypto.randomBytes(8).toString('hex');
}

// Derives a uniform integer in [0, max) from the seeds/nonce via
// HMAC-SHA256, with rejection sampling to avoid modulo bias.
export function deriveOutcome(serverSeed, clientSeed, nonce, max) {
  const limit = Math.floor(0xffffffff / max) * max; // largest multiple of max <= 2^32-1
  let counter = 0;
  for (;;) {
    const hmac = crypto
      .createHmac('sha256', serverSeed)
      .update(`${clientSeed}:${nonce}:${counter}`)
      .digest();
    const value = hmac.readUInt32BE(0);
    if (value < limit) {
      return value % max;
    }
    counter += 1; // exceedingly rare; re-derive with a bumped counter
  }
}

// Recomputes an outcome purely from revealed public data — this is what
// the player-facing verifier calls, independent of any server state.
export function verifyOutcome({ serverSeed, serverSeedHash, clientSeed, nonce, max }) {
  const recomputedHash = hashServerSeed(serverSeed);
  const hashMatches = recomputedHash === serverSeedHash;
  const outcome = deriveOutcome(serverSeed, clientSeed, nonce, max);
  return { hashMatches, outcome, recomputedHash };
}

// --- Commitment lifecycle (the "hash shown before you play" part) ---
// Every user always has exactly one pending commitment: a server seed
// already generated and hashed, with the hash visible to them, well before
// they place a bet against it. A round always consumes the CURRENT pending
// commitment (never mints a fresh one for itself) and a new one is minted
// immediately after, so there is never a moment where no commitment is on
// display.
export function getOrCreateCommitment(db, userId) {
  const existing = db.prepare('SELECT * FROM fairness_commitments WHERE user_id = ?').get(userId);
  if (existing) return existing;
  const serverSeed = generateServerSeed();
  const serverSeedHash = hashServerSeed(serverSeed);
  const clientSeed = generateClientSeed();
  db.prepare(
    'INSERT INTO fairness_commitments (user_id, server_seed, server_seed_hash, client_seed, nonce) VALUES (?, ?, ?, ?, 0)'
  ).run(userId, serverSeed, serverSeedHash, clientSeed);
  return db.prepare('SELECT * FROM fairness_commitments WHERE user_id = ?').get(userId);
}

export function setClientSeed(db, userId, clientSeed) {
  getOrCreateCommitment(db, userId); // ensure a row exists first
  db.prepare('UPDATE fairness_commitments SET client_seed = ? WHERE user_id = ?').run(clientSeed, userId);
  return db.prepare('SELECT * FROM fairness_commitments WHERE user_id = ?').get(userId);
}

// Consumes the user's current commitment for one round (returns it, with
// the nonce about to be used) and immediately mints the next one so a new
// hash is already on display before the player can place another bet.
export function consumeCommitmentAndRotate(db, userId) {
  const current = getOrCreateCommitment(db, userId);
  const nextServerSeed = generateServerSeed();
  const nextServerSeedHash = hashServerSeed(nextServerSeed);
  db.prepare(
    'UPDATE fairness_commitments SET server_seed = ?, server_seed_hash = ?, nonce = 0 WHERE user_id = ?'
  ).run(nextServerSeed, nextServerSeedHash, userId);
  const next = db.prepare('SELECT * FROM fairness_commitments WHERE user_id = ?').get(userId);
  return { used: current, next };
}
