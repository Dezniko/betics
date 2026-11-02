import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROULETTE_MATH, mathOption, rtpRange } from '../backend/src/games/rouletteMath.js';
import { payoutCentsFor, maxPayoutCents } from '../backend/src/games/roulette.js';
import { checkRoundLimits } from './limits.js';

const straight = (value, amountCents = 100) => ({ type: 'straight', value, amountCents });

test('standard maths keeps the classic payout table', () => {
  assert.equal(payoutCentsFor(straight(7), 7), 3600);
  assert.equal(payoutCentsFor({ type: 'split', value: [1, 2], amountCents: 100 }, 2), 1800);
  assert.equal(payoutCentsFor({ type: 'red', amountCents: 100 }, 1), 200);
  assert.equal(payoutCentsFor(straight(7), 8), 0);
});

test('straight34 pays 35x return on a single number and leaves other bets alone', () => {
  const o = mathOption('straight34');
  assert.equal(payoutCentsFor(straight(7), 7, o), 3500);
  assert.equal(payoutCentsFor({ type: 'split', value: [1, 2], amountCents: 100 }, 2, o), 1800);
  assert.equal(payoutCentsFor({ type: 'dozen1', amountCents: 100 }, 5, o), 300);
});

test('every option pays back under 100% and the range is honest', () => {
  for (const o of Object.values(ROULETTE_MATH)) {
    const { min, max } = rtpRange(o);
    assert.ok(max < 100, o.id);
    assert.ok(min <= max);
  }
  assert.deepEqual(rtpRange(mathOption('standard')), { min: 97.3, max: 97.3 });
  assert.deepEqual(rtpRange(mathOption('straight34')), { min: 94.59, max: 97.3 });
});

test('a million simulated spins match the published payback', () => {
  // Deterministic mulberry32; every bet type is played every spin.
  let s = 12345;
  const rand = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) % 37; };
  const bets = [straight(17), { type: 'split', value: [1, 2], amountCents: 100 }, { type: 'red', amountCents: 100 },
    { type: 'dozen2', amountCents: 100 }, { type: 'corner', value: [1, 2, 4, 5], amountCents: 100 }];
  for (const id of ['standard', 'straight34']) {
    const o = mathOption(id); let bet = 0, paid = 0; s = 12345;
    for (let i = 0; i < 1_000_000; i++) { const p = rand(); for (const b of bets) { bet += b.amountCents; paid += payoutCentsFor(b, p, o); } }
    const rtp = paid / bet * 100;
    const expected = id === 'standard' ? 97.3 : (94.59 + 97.3 * 4) / 5;
    assert.ok(Math.abs(rtp - expected) < 0.4, `${id} ${rtp}`);
  }
});

test('max payout is the worst pocket for the house', () => {
  const bets = [straight(17, 100), straight(18, 100), { type: 'red', amountCents: 100 }];
  // 17 is black, 18 is red: worst pocket is 18 (3600 + 200).
  assert.equal(maxPayoutCents(bets, mathOption('standard')), 3800);
});

const config = { enabled: true, maintenanceMessage: 'Back soon', minStakeCents: 100, maxStakeCents: 10000, maxWinCents: 50000, maxHouseLossCents: 40000, math: mathOption('standard') };
test('limits: game off, stake range, max win and house loss', () => {
  assert.equal(checkRoundLimits([straight(1, 200)], config), null);
  assert.match(checkRoundLimits([straight(1, 200)], { ...config, enabled: false }).error, /Back soon/);
  assert.equal(checkRoundLimits([straight(1, 200)], { ...config, enabled: false }).status, 503);
  assert.match(checkRoundLimits([straight(1, 50)], config).error, /at least 1\.00 \$TICS/);
  assert.match(checkRoundLimits([straight(1, 6000), straight(2, 6000)], config).error, /at most 100\.00 \$TICS\./);
  for (const bets of [[straight(1, 6000), straight(2, 6000)], [straight(1, 50)], [straight(1, 2000)]]) { const r = checkRoundLimits(bets, config); if (r) assert.doesNotMatch(r.error, /\$\s?\d/, 'no dollar amounts in player messages'); }
  // 2000 on a straight can return 72000 > max win 50000.
  assert.match(checkRoundLimits([straight(1, 2000)], config).error, /win more than 500\.00 \$TICS/);
  // House loss = 36000 - 1000 = 35000 ok; 1200 → 43200-1200 = 42000 > 40000 but win 43200 < 50000.
  assert.equal(checkRoundLimits([straight(1, 1000)], config), null);
  assert.match(checkRoundLimits([straight(1, 1200)], config).error, /table limit/);
});
