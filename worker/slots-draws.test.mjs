import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeUint32At } from '../backend/src/core/slotDraws.js';
import { browserUint32At, verifySlotRound, sha256Hex } from '../frontend/src/slots/slotsVerify.js';
import { playRound } from '../backend/src/games/slots.js';
import { SLOT_MATH } from '../backend/src/games/slotsMath.js';
import { deriveOutcome } from '../backend/src/core/fairness.js';

const seed = 'a'.repeat(64), client = 'luckyword:' + 'b'.repeat(64);

test('node draws are deterministic and change with every input', () => {
  const a = makeUint32At(seed, client, 3), b = makeUint32At(seed, client, 3);
  assert.equal(a(0, 0), b(0, 0));
  assert.notEqual(a(0, 0), a(1, 0));
  assert.notEqual(a(0, 0), a(0, 1));
  assert.notEqual(a(0, 0), makeUint32At('c'.repeat(64), client, 3)(0, 0));
  assert.notEqual(a(0, 0), makeUint32At(seed, client + 'x', 3)(0, 0));
  assert.notEqual(a(0, 0), makeUint32At(seed, client, 4)(0, 0));
});
test('browser WebCrypto draws equal node draws for every draw and counter', async () => {
  const node = makeUint32At(seed, client, 7);
  const web = await browserUint32At(seed, client, 7, { draws: 40 });
  for (let d = 0; d < 40; d++) for (let c = 0; c < 8; c++) assert.equal(web(d, c), node(d, c), `${d}:${c}`);
});
test('a round replays identically from node and browser draws for random seeds', async () => {
  for (let i = 0; i < 40; i++) {
    const s = crypto.randomBytes(32).toString('hex'), c = crypto.randomBytes(8).toString('hex') + ':' + crypto.randomBytes(32).toString('hex');
    const a = playRound({ stake: 2000, uint32At: makeUint32At(s, c, 0), math: SLOT_MATH });
    const b = playRound({ stake: 2000, uint32At: await browserUint32At(s, c, 0), math: SLOT_MATH });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  }
});
test('roulette derivation is untouched', () => {
  assert.equal(deriveOutcome('seed', 'client', 0, 37), deriveOutcome('seed', 'client', 0, 37));
  assert.equal(deriveOutcome('0f'.repeat(32), 'abc:def', 5, 37), 32);
});

function serverReply(s, base, entropy, nonce, stake = 2000) {
  const clientSeed = `${base}:${entropy}`;
  const round = playRound({ stake, uint32At: makeUint32At(s, clientSeed, nonce), math: SLOT_MATH });
  const hash = crypto.createHash('sha256').update(s).digest('hex');
  return { requestId: 'r1', stake, spins: round.spins, freeSpinsPlayed: round.freeSpinsPlayed, freeSpinsAwarded: round.freeSpinsAwarded, capped: round.capped,
    totalPayoutCents: round.totalPayoutUnits, balanceBeforeCents: 100000, balanceAfterCents: 100000 - stake + round.totalPayoutUnits,
    fairness: { serverSeed: s, serverSeedHash: hash, clientSeed, clientSeedBase: base, clientEntropy: entropy, nonce } };
}
const receiptFor = (d) => ({ requestId: d.requestId, serverSeedHash: d.fairness.serverSeedHash, clientSeedBase: d.fairness.clientSeedBase, clientEntropy: d.fairness.clientEntropy, nonce: d.fairness.nonce });

test('an honest round verifies, and every tampering is named', async () => {
  const s = crypto.randomBytes(32).toString('hex'), base = 'word', entropy = 'e'.repeat(64);
  const honest = serverReply(s, base, entropy, 0);
  assert.deepEqual(await verifySlotRound(receiptFor(honest), honest).then((r) => r.ok), true);
  const clone = () => JSON.parse(JSON.stringify(honest));
  let d = clone(); d.spins[0].stops[2] = (d.spins[0].stops[2] + 1) % 32;
  assert.match((await verifySlotRound(receiptFor(d), d)).problems.join(' '), /reel stops differ/);
  d = clone(); d.totalPayoutCents += 100; d.balanceAfterCents += 100;
  assert.match((await verifySlotRound(receiptFor(d), d)).problems.join(' '), /total payout differs/);
  d = clone(); d.spins[0].winUnits += 1;
  assert.match((await verifySlotRound(receiptFor(d), d)).problems.join(' '), /win differs/);
  d = clone(); d.fairness.nonce = 9;
  assert.match((await verifySlotRound(receiptFor(honest), d)).problems.join(' '), /round number differs/);
  d = clone(); d.fairness.clientEntropy = 'f'.repeat(64); d.fairness.clientSeed = `${base}:${'f'.repeat(64)}`;
  assert.match((await verifySlotRound(receiptFor(honest), d)).problems.join(' '), /randomness was not the one you sent/);
  d = clone(); d.fairness.serverSeed = crypto.randomBytes(32).toString('hex');
  assert.match((await verifySlotRound(receiptFor(d), d)).problems.join(' '), /does not open the lock/);
  d = clone(); d.balanceAfterCents += 5;
  assert.match((await verifySlotRound(receiptFor(d), d)).problems.join(' '), /does not add up/);
  assert.match((await verifySlotRound(null, honest)).problems.join(' '), /No pre-bet receipt/);
  d = clone(); d.freeSpinsPlayed += 1;
  assert.match((await verifySlotRound(receiptFor(d), d)).problems.join(' '), /free spins differs/);
});
test('verification handles a free spin round', async () => {
  // find a seed whose round has free spins
  for (let i = 0; i < 5000; i++) {
    const s = crypto.randomBytes(32).toString('hex');
    const d = serverReply(s, 'w', 'd'.repeat(64), 0);
    if (d.freeSpinsPlayed > 0) {
      const r = await verifySlotRound(receiptFor(d), d);
      assert.equal(r.ok, true, r.problems.join(' '));
      assert.ok(d.spins.length > 1);
      return;
    }
  }
  assert.fail('no free spin round found in 5000 seeds');
});
test('sha256Hex matches node', async () => {
  assert.equal(await sha256Hex('abc'), crypto.createHash('sha256').update('abc').digest('hex'));
});
