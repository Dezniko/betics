import assert from 'node:assert/strict';
import { test } from 'node:test';
import { overMaxBet, CHIP_VALUES, fmtMoney } from '../src/chips.js';

test('1 and 5 $TICS chips exist so small balances can still be played', () => {
  assert.deepEqual(CHIP_VALUES.slice(0, 2), [100, 500]);
  assert.deepEqual(CHIP_VALUES, [...CHIP_VALUES].sort((a, b) => a - b));
});

test('no more chips once the max bet per spin is reached; message is in $TICS', () => {
  const max = 5_000_000; // 50,000 $TICS
  assert.equal(overMaxBet(4_900_000, 100_000, max), null, 'exactly at the limit is fine');
  assert.equal(overMaxBet(5_000_000, 100, max), 'The most you can bet on one spin is 50,000.00 $TICS.');
  assert.doesNotMatch(overMaxBet(5_000_000, 100, max), /\$\s?\d/);
  assert.equal(overMaxBet(10, 10, undefined), null, 'no limit known yet');
  assert.equal(fmtMoney(700), '7.00 $TICS');
});
