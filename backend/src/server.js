import express from 'express';
import cors from 'cors';
import { getOrCreateDemoUser, getUser, db } from './core/db.js';
import { deriveOutcome, verifyOutcome, getOrCreateCommitment, setClientSeed, consumeCommitmentAndRotate } from './core/fairness.js';
import { reserveBet, settleBet, InsufficientBalanceError } from './core/ledger.js';
import { POCKET_COUNT, pocketColor, payoutCentsFor, validateBet } from './games/roulette.js';

const app = express();
app.use(cors());
app.use(express.json());

// --- Session (local-dev simplification: one demo user per username) ---
app.post('/api/session', (req, res) => {
  const username = (req.body?.username || 'player1').trim() || 'player1';
  const user = getOrCreateDemoUser(username);
  res.json({ userId: user.id, username: user.username, balanceCents: user.balance_cents });
});

app.get('/api/wallet/:userId', (req, res) => {
  const user = getUser(Number(req.params.userId));
  if (!user) return res.status(404).json({ error: 'user not found' });
  res.json({ userId: user.id, username: user.username, balanceCents: user.balance_cents });
});

// --- Fairness commitment: the hash shown BEFORE a player ever bets ---
// GET returns the currently active commitment (minting one on first call).
// Never returns the real server seed — only its hash, the client seed, and
// the nonce, since that's all a player should see before playing.
app.get('/api/fairness/commitment/:userId', (req, res) => {
  const userId = Number(req.params.userId);
  const c = getOrCreateCommitment(db, userId);
  res.json({ serverSeedHash: c.server_seed_hash, clientSeed: c.client_seed, nonce: c.nonce });
});

// Lets the player set their own client seed ahead of playing — their own
// contributed entropy the server couldn't have known when it committed to
// the (already-hashed, already-displayed) server seed.
app.post('/api/fairness/client-seed', (req, res) => {
  const { userId, clientSeed } = req.body || {};
  if (!userId || typeof clientSeed !== 'string' || !clientSeed.trim()) {
    return res.status(400).json({ error: 'userId and a non-empty clientSeed are required' });
  }
  const trimmed = clientSeed.trim().slice(0, 64);
  const c = setClientSeed(db, Number(userId), trimmed);
  res.json({ serverSeedHash: c.server_seed_hash, clientSeed: c.client_seed, nonce: c.nonce });
});

// --- Roulette ---
// Places N bets in one spin, all against the single commitment that was
// already shown to this player before they placed this bet.
app.post('/api/games/roulette/spin', (req, res) => {
  const { userId, bets } = req.body || {};
  if (!userId || !Array.isArray(bets) || bets.length === 0) {
    return res.status(400).json({ error: 'userId and non-empty bets[] are required' });
  }

  const totalStakeCents = bets.reduce((sum, b) => sum + Number(b.amountCents || 0), 0);
  if (!Number.isInteger(totalStakeCents) || totalStakeCents <= 0) {
    return res.status(400).json({ error: 'invalid stake' });
  }

  try {
    for (const bet of bets) validateBet(bet);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Consume the commitment the player already saw the hash of — never mint
  // a fresh one here, or the "shown before you play" guarantee is hollow.
  const { used, next } = consumeCommitmentAndRotate(db, userId);
  const serverSeed = used.server_seed;
  const serverSeedHash = used.server_seed_hash;
  const finalClientSeed = used.client_seed;
  const nonce = used.nonce;

  let roundId;
  try {
    const reserved = reserveBet({
      userId,
      game: 'roulette',
      stakeCents: totalStakeCents,
      betJson: bets,
      serverSeed,
      serverSeedHash,
      clientSeed: finalClientSeed,
      nonce,
    });
    roundId = reserved.roundId;
  } catch (err) {
    if (err instanceof InsufficientBalanceError) {
      return res.status(402).json({ error: 'insufficient balance' });
    }
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }

  const pocket = deriveOutcome(serverSeed, finalClientSeed, nonce, POCKET_COUNT);
  const color = pocketColor(pocket);

  const betResults = bets.map((bet) => {
    const payoutCents = payoutCentsFor(bet, pocket);
    return { ...bet, payoutCents, won: payoutCents > 0 };
  });
  const totalPayoutCents = betResults.reduce((sum, b) => sum + b.payoutCents, 0);

  const outcomeJson = { pocket, color, betResults };
  const settled = settleBet({ roundId, outcomeJson, payoutCents: totalPayoutCents });

  res.json({
    roundId,
    pocket,
    color,
    betResults,
    totalStakeCents,
    totalPayoutCents,
    balanceAfterCents: settled.balanceAfter,
    fairness: {
      serverSeed, // revealed immediately post-round, per provably-fair design
      serverSeedHash,
      clientSeed: finalClientSeed,
      nonce,
      // Already-committed hash for the NEXT round — shown to the player
      // right away, before they place their next bet, no extra round-trip.
      nextCommitment: { serverSeedHash: next.server_seed_hash, clientSeed: next.client_seed, nonce: next.nonce },
    },
  });
});

// --- Fairness verifier: recompute any past round's outcome independently ---
app.post('/api/fairness/verify', (req, res) => {
  const { serverSeed, serverSeedHash, clientSeed, nonce, max } = req.body || {};
  if (!serverSeed || !serverSeedHash || !clientSeed || nonce === undefined) {
    return res.status(400).json({ error: 'serverSeed, serverSeedHash, clientSeed, nonce are required' });
  }
  const result = verifyOutcome({ serverSeed, serverSeedHash, clientSeed, nonce, max: max || POCKET_COUNT });
  res.json(result);
});

app.get('/api/rounds/:userId', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM rounds WHERE user_id = ? ORDER BY id DESC LIMIT 25')
    .all(Number(req.params.userId));
  res.json(rows);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Core Platform API listening on http://localhost:${PORT}`);
});
