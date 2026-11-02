import test from 'node:test';
import assert from 'node:assert/strict';
import { displayedBalanceCents } from '../src/balanceDisplay.js';

test('chips on the table do not reduce the shown balance before Spin', () => {
  assert.equal(displayedBalanceCents({ balanceCents: 100000, committedStakeCents: 0 }), 100000);
});

test('Spin deducts the committed stake until the server balance is applied', () => {
  assert.equal(displayedBalanceCents({ balanceCents: 100000, committedStakeCents: 1500 }), 98500);
});

test('the payout transfer override wins while it animates', () => {
  assert.equal(displayedBalanceCents({ balanceCents: 100000, committedStakeCents: 1500, overrideCents: 99000 }), 99000);
});

test('no user yet shows nothing', () => {
  assert.equal(displayedBalanceCents({ balanceCents: null, committedStakeCents: 0 }), null);
});

import { tableFitsBalance } from '../src/balanceDisplay.js';
test('chips left on the table must never exceed the balance after a round', () => {
  assert.equal(tableFitsBalance(915800, 6800), false);
  assert.equal(tableFitsBalance(6800, 6800), true);
  assert.equal(tableFitsBalance(0, 0), true);
});
