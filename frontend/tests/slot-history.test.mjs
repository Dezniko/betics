import test from 'node:test';
import assert from 'node:assert/strict';
import { slotRoundFromRow, slotHistoryRows, checkSlotHistoryRound, SLOT_GAME } from '../src/slots/slotHistory.js';

const row = (over = {}) => ({ id: 42, game: SLOT_GAME, stake_cents: 2000, payout_cents: 5000, server_seed: 'k'.repeat(64), server_seed_hash: 'h'.repeat(64), client_seed: 'word:ent', client_seed_base: 'word', client_entropy: 'ent', nonce: 3, request_id: 'req-1', real_money: 0, created_at: '2026-11-05 10:00:00',
  outcome_json: JSON.stringify({ game: SLOT_GAME, spins: [{ free: false, stops: [1, 2, 3, 4, 5], lineWins: [], scatterCount: 0, scatterPay: 0, multiplier: 1, winUnits: 5000, freeSpinsAdded: 0 }], freeSpinsAwarded: 0, freeSpinsPlayed: 0, capped: false }), ...over });

test('a slot /api/rounds row becomes the reply shape the browser verifier checks', () => {
  const r = slotRoundFromRow(row());
  assert.equal(r.roundId, 42); assert.equal(r.requestId, 'req-1'); assert.equal(r.stake, 2000); assert.equal(r.totalPayoutCents, 5000); assert.equal(r.mode, 'demo');
  assert.deepEqual(r.spins[0].stops, [1, 2, 3, 4, 5]);
  assert.deepEqual(r.fairness, { serverSeed: 'k'.repeat(64), serverSeedHash: 'h'.repeat(64), clientSeed: 'word:ent', clientSeedBase: 'word', clientEntropy: 'ent', nonce: 3 });
  assert.equal(slotRoundFromRow(row({ real_money: 1 })).mode, 'real');
});

test('roulette rows, rows without an outcome and broken JSON are skipped; the list is capped', () => {
  assert.equal(slotRoundFromRow(row({ game: 'roulette' })), null);
  assert.equal(slotRoundFromRow(row({ outcome_json: null })), null);
  assert.equal(slotRoundFromRow(row({ outcome_json: '{nope' })), null);
  assert.equal(slotRoundFromRow(row({ outcome_json: JSON.stringify({ pocket: 7 }) })), null);
  assert.equal(slotRoundFromRow(null), null);
  const rows = slotHistoryRows([row({ game: 'roulette' }), ...Array.from({ length: 20 }, (_, i) => row({ id: i }))]);
  assert.equal(rows.length, 15);
  assert.equal(slotHistoryRows('nope').length, 0);
});

test('checking a listed round uses the saved receipt when this browser has it, and says so', async () => {
  const r = slotRoundFromRow(row());
  const seen = [];
  const verify = async (receipt, data) => { seen.push([receipt, data.roundId]); return { ok: !!receipt, problems: receipt ? [] : ['No pre-bet receipt was saved for this spin.'] }; };
  const withReceipt = await checkSlotHistoryRound(r, { read: (id) => (id === 'req-1' ? { requestId: id } : null), verify });
  assert.deepEqual(withReceipt, { ok: true, problems: [], receipt: true });
  const without = await checkSlotHistoryRound(r, { read: () => null, verify });
  assert.deepEqual(without, { ok: true, problems: [], receipt: false });
  assert.deepEqual(seen, [[{ requestId: 'req-1' }, 42], [null, 42]]);
  const bad = await checkSlotHistoryRound(r, { read: () => null, verify: async () => ({ ok: false, problems: ['The revealed seed does not open the lock.'] }) });
  assert.equal(bad.ok, false); assert.equal(bad.problems.length, 1);
});

test('the real verifier accepts a round the engine itself played from the stored row', async () => {
  const { SLOT_MATH } = await import('../../backend/src/games/slotsMath.js');
  const { playRound } = await import('../../backend/src/games/slots.js');
  const { makeUint32At } = await import('../../backend/src/core/slotDraws.js');
  const serverSeed = 'a'.repeat(64), clientSeed = 'lucky:deadbeef', nonce = 0;
  const { sha256Hex } = await import('../src/slots/slotsVerify.js');
  const played = playRound({ stake: 2000, uint32At: makeUint32At(serverSeed, clientSeed, nonce), math: SLOT_MATH });
  const r = slotRoundFromRow(row({ server_seed: serverSeed, server_seed_hash: await sha256Hex(serverSeed), client_seed: clientSeed, client_seed_base: 'lucky', client_entropy: 'deadbeef', nonce,
    payout_cents: played.totalPayoutUnits, outcome_json: JSON.stringify({ game: SLOT_GAME, spins: played.spins.map((s) => ({ free: s.free, stops: s.stops, lineWins: s.lineWins, scatterCount: s.scatterCount, scatterPay: s.scatterPay, multiplier: s.multiplier, winUnits: s.winUnits, freeSpinsAdded: s.freeSpinsAdded })), freeSpinsAwarded: played.freeSpinsAwarded, freeSpinsPlayed: played.freeSpinsPlayed, capped: played.capped }) }));
  const result = await checkSlotHistoryRound(r, { read: () => null });
  assert.deepEqual(result, { ok: true, problems: [], receipt: false });
});
