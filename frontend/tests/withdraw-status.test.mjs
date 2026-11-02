import test from 'node:test';
import assert from 'node:assert/strict';
import { WITHDRAW_TEXT, WITHDRAW_NOTE, withdrawText } from '../src/walletApi.js';

test('every withdrawal status the server can return reads as plain words for the player', () => {
  for (const s of ['holding', 'pending', 'queued', 'signing', 'sending', 'sent', 'failed', 'cancelled', 'cancelling', 'blocked']) {
    assert.ok(WITHDRAW_TEXT[s], s);
    assert.doesNotMatch(withdrawText(s), /^[a-z_]+$/, `${s} is not shown as a raw code`);
  }
  assert.equal(withdrawText('blocked'), 'Under review');
  assert.equal(withdrawText('something_new'), 'Processing');
  for (const t of [...Object.values(WITHDRAW_TEXT), ...Object.values(WITHDRAW_NOTE)]) assert.doesNotMatch(t, /[\u2013\u2014]/, 'no dashes');
  assert.match(WITHDRAW_NOTE.blocked, /money is safe/);
});
