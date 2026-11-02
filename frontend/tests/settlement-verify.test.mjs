// Audit F1 and F4: the browser checks the money, not only the winning number, and proof storage is bounded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifySettlement, saveRoundReceipt, readRoundReceipt, rememberRevealedSeed, readRevealedHashes, MAX_RECEIPTS, MAX_REVEALED } from '../src/fairnessClient.js';
import { didBetWin, STANDARD_MULTIPLIERS } from '../src/rouletteRules.js';
import { payoutCentsFor } from '../../backend/src/games/roulette.js';
import { ROULETTE_MATH } from '../../backend/src/games/rouletteMath.js';

const bets = [{ type: 'straight', value: 17, amountCents: 10000 }, { type: 'red', amountCents: 5000 }, { type: 'dozen2', amountCents: 2000 }];
const terms = { bets, stake: 17000, mode: 'real', mathId: 'standard', multipliers: STANDARD_MULTIPLIERS, balanceBefore: 1000000 };
function honest(pocket) {
  const betResults = bets.map((b) => ({ ...b, payoutCents: payoutCentsFor(b, pocket, ROULETTE_MATH.standard) }));
  const payout = betResults.reduce((t, b) => t + b.payoutCents, 0);
  return { pocket, mode: 'real', mathId: 'standard', betResults, totalStakeCents: 17000, totalPayoutCents: payout, balanceAfterCents: 1000000 - 17000 + payout };
}

test('an honest settlement passes for every pocket and matches the server payout maths', () => {
  for (let pocket = 0; pocket <= 36; pocket++) {
    const r = verifySettlement(terms, honest(pocket), didBetWin);
    assert.equal(r.ok, true, `pocket ${pocket}: ${r.problems}`);
  }
});

test('the browser rejects a correct winning number with the wrong money', () => {
  const win = honest(17); // straight 17 wins 3,600 $TICS, red wins, dozen2 wins
  const cases = {
    underpaid: { ...win, betResults: win.betResults.map((b, i) => (i === 0 ? { ...b, payoutCents: 36000 } : b)), totalPayoutCents: win.totalPayoutCents - 324000 },
    'total only': { ...win, totalPayoutCents: win.totalPayoutCents - 1 },
    'zero payout': { ...win, betResults: win.betResults.map((b) => ({ ...b, payoutCents: 0 })), totalPayoutCents: 0 },
    'stake changed': { ...win, totalStakeCents: 99999 },
    'mode changed': { ...win, mode: 'demo' },
    'payout table changed': { ...win, mathId: 'straight34' },
    'bet swapped': { ...win, betResults: win.betResults.map((b, i) => (i === 0 ? { ...b, value: 18 } : b)) },
    'bet dropped': { ...win, betResults: win.betResults.slice(1) },
    'empty bets': { ...win, betResults: [] },
    'balance short': { ...win, balanceAfterCents: win.balanceAfterCents - 100 },
    'negative balance': { ...win, balanceAfterCents: -5 },
  };
  for (const [name, data] of Object.entries(cases)) assert.equal(verifySettlement(terms, data, didBetWin).ok, false, name);
  // A top up landing at the same time only raises the balance, which is fine.
  assert.equal(verifySettlement(terms, { ...win, balanceAfterCents: win.balanceAfterCents + 500000 }, didBetWin).ok, true);
});

test('the 34 to 1 table is checked with its own multiplier', () => {
  const t = { ...terms, mathId: 'straight34', multipliers: ROULETTE_MATH.straight34.multipliers };
  const betResults = bets.map((b) => ({ ...b, payoutCents: payoutCentsFor(b, 17, ROULETTE_MATH.straight34) }));
  const payout = betResults.reduce((s, b) => s + b.payoutCents, 0);
  const data = { pocket: 17, mode: 'real', mathId: 'straight34', betResults, totalStakeCents: 17000, totalPayoutCents: payout, balanceAfterCents: 1000000 - 17000 + payout };
  assert.equal(verifySettlement(t, data, didBetWin).ok, true);
  assert.equal(verifySettlement(terms, data, didBetWin).ok, false, 'a silent switch of payout table is caught');
});

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; }, map: m };
}
test('proof storage is bounded: newest receipts and revealed fingerprints are kept', () => {
  const st = memoryStorage();
  const ids = [];
  for (let i = 0; i < MAX_RECEIPTS + 40; i++) {
    const requestId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    ids.push(requestId);
    saveRoundReceipt({ requestId, serverSeedHash: 'a'.repeat(64), clientSeed: 'x', nonce: 0 }, null, st);
  }
  const receipts = [...st.map.keys()].filter((k) => k.startsWith('noir:prebet:v1:'));
  assert.equal(receipts.length, MAX_RECEIPTS);
  assert.equal(readRoundReceipt(ids[0], null, st), null, 'oldest dropped');
  assert.ok(readRoundReceipt(ids.at(-1), null, st), 'newest kept');
  for (let i = 0; i < MAX_REVEALED + 25; i++) rememberRevealedSeed(i.toString(16).padStart(64, '0'), st);
  const revealed = readRevealedHashes(st);
  assert.equal(revealed.length, MAX_REVEALED);
  assert.ok(revealed.includes((MAX_REVEALED + 24).toString(16).padStart(64, '0')));
});
