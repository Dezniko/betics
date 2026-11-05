import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGrid, playRound, maxPayoutUnits, drawStop, gridFor, validStake } from '../backend/src/games/slots.js';
import { SLOT_MATH, BET_LEVELS } from '../backend/src/games/slotsMath.js';

const strip = (s) => Array(4).fill(s);
const M = { reels: 5, rows: 3, stops: 4, lineCount: 2, betLevels: null,
  strips: [strip('A'), strip('A'), strip('A'), strip('A'), strip('A')],
  lines: [[1, 1, 1, 1, 1], [0, 0, 0, 0, 0]],
  pays: { A: { 3: 2, 4: 5, 5: 10 }, W: { 3: 20, 4: 50, 5: 100 } },
  scatterPays: { 3: 2, 4: 10, 5: 50 },
  freeSpins: { award: { 3: 10, 4: 15, 5: 20 }, retrigger: { 3: 5, 4: 8, 5: 10 }, maxSpins: 50, multiplier: 2 },
  capMultiplier: 2000 };
const one = [[1, 1, 1, 1, 1]];

test('five of a kind on both lines pays each line', () => {
  const grid = [['A', 'A', 'A', 'A', 'A'], ['A', 'A', 'A', 'A', 'A'], ['A', 'A', 'A', 'A', 'A']];
  const r = evaluateGrid(grid, M);
  assert.equal(r.lineWins.length, 2);
  assert.equal(r.linePay, 20);
});
test('wild substitutes, scatter breaks the line, two of a kind pays nothing', () => {
  const r = evaluateGrid([['B', 'B', 'B', 'B', 'B'], ['A', 'W', 'A', 'S', 'B'], ['B', 'B', 'B', 'B', 'B']], { ...M, lines: one });
  assert.equal(r.lineWins[0].count, 3);
  assert.equal(r.linePay, 2);
  assert.equal(evaluateGrid([['B', 'B', 'B', 'B', 'B'], ['A', 'A', 'B', 'A', 'A'], ['B', 'B', 'B', 'B', 'B']], { ...M, lines: one }).linePay, 0);
});
test('a line of wilds then a symbol takes the better pay, once', () => {
  const r = evaluateGrid([['B', 'B', 'B', 'B', 'B'], ['W', 'W', 'W', 'A', 'B'], ['B', 'B', 'B', 'B', 'B']], { ...M, lines: one });
  assert.equal(r.lineWins.length, 1);
  assert.equal(r.linePay, 20);
  const r2 = evaluateGrid([['B', 'B', 'B', 'B', 'B'], ['W', 'A', 'A', 'A', 'A'], ['B', 'B', 'B', 'B', 'B']], { ...M, lines: one });
  assert.equal(r2.linePay, 10);
});
test('scatters pay anywhere, only from three', () => {
  const g = [['S', 'B', 'S', 'B', 'B'], ['B', 'B', 'B', 'B', 'B'], ['B', 'B', 'B', 'B', 'S']];
  assert.equal(evaluateGrid(g, { ...M, lines: one }).scatterPay, 2);
  g[2][4] = 'B';
  assert.equal(evaluateGrid(g, { ...M, lines: one }).scatterPay, 0);
});
test('draw stop uses rejection sampling and rejects bad values', () => {
  const values = [0xffffffff, 0xffffffff, 39];
  assert.equal(drawStop((draw, counter) => values[counter], 0, 32), 7);
  assert.throws(() => drawStop(() => 0xffffffff, 0, 32), /ran out/);
  assert.throws(() => drawStop(() => -1, 0, 32), /32-bit/);
});
test('grid reads rows down the strip and wraps', () => {
  const m = { ...M, strips: [['A', 'B', 'C', 'D'], strip('A'), strip('A'), strip('A'), strip('A')] };
  const g = gridFor([3, 0, 0, 0, 0], m);
  assert.deepEqual([g[0][0], g[1][0], g[2][0]], ['D', 'A', 'B']);
});
test('a plain round: two lines of five A pay ten line bets each', () => {
  const round = playRound({ stake: 20, uint32At: () => 0, math: M });
  assert.equal(round.spins.length, 1);
  assert.equal(round.totalPayoutUnits, 200);
  assert.equal(round.capped, false);
});
test('free spins double wins, retrigger within the 50 spin limit, and the round stops at the cap', () => {
  // Reel 1 shows S S S down the column on every spin: three scatters each spin, wins doubled in free spins.
  const m = { ...M, strips: [strip('S'), strip('A'), strip('A'), strip('A'), strip('A')], lines: [[1, 1, 1, 1, 1]] };
  const round = playRound({ stake: 20, uint32At: () => 0, math: m });
  // base spin: scatter 2 x 20 = 40; every free spin: 80 (doubled). Retrigger +5 each spin, capped at 50 free spins.
  assert.equal(round.freeSpinsPlayed, 50);
  assert.equal(round.freeSpinsAwarded, 50);
  assert.equal(round.totalPayoutUnits, 40 + 50 * 80);
  assert.equal(round.spins.filter((s) => s.free).length, 50);
  const capped = playRound({ stake: 20, uint32At: () => 0, math: { ...m, capMultiplier: 10 } });
  assert.equal(capped.totalPayoutUnits, 200);
  assert.equal(capped.capped, true);
  assert.ok(capped.spins.length < 51);
});
test('draw numbers advance by five per spin', () => {
  const seen = [];
  const m = { ...M, strips: [strip('S'), strip('A'), strip('A'), strip('A'), strip('A')], capMultiplier: 10 };
  playRound({ stake: 20, uint32At: (d) => { seen.push(d); return 0; }, math: m });
  assert.deepEqual(seen.slice(0, 10), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});
test('max payout is cap times stake; stake must be a bet level and a multiple of the lines', () => {
  assert.equal(maxPayoutUnits(100, M), 200000);
  assert.throws(() => playRound({ stake: 21, uint32At: () => 0, math: M }), /invalid stake/);
  assert.ok(validStake(2000, SLOT_MATH));
  assert.ok(!validStake(2001, SLOT_MATH));
  assert.ok(!validStake(100, SLOT_MATH));
  assert.deepEqual(BET_LEVELS, [2000, 4000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000]);
});
test('published maths is well formed', () => {
  assert.equal(SLOT_MATH.strips.length, 5);
  for (const s of SLOT_MATH.strips) assert.equal(s.length, SLOT_MATH.stops);
  assert.equal(SLOT_MATH.lines.length, 20);
  for (const l of SLOT_MATH.lines) { assert.equal(l.length, 5); for (const r of l) assert.ok(r >= 0 && r < 3); }
  const symbols = new Set(SLOT_MATH.symbols.map((s) => s.code));
  for (const s of SLOT_MATH.strips.flat()) assert.ok(symbols.has(s), s);
  for (const code of Object.keys(SLOT_MATH.pays)) assert.ok(symbols.has(code));
  assert.equal(SLOT_MATH.capMultiplier, 2000);
  assert.equal(SLOT_MATH.rtp, 92);
});
