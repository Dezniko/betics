import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { withdrawWaitText, creditedText, TOPUP_WAIT_NOTE } from '../src/walletApi.js';

const T = Date.parse('2026-11-02T12:00:00Z');
const at = (min) => new Date(T - min * 60_000).toISOString();

test('withdraw wait note: the agreed words, an estimate in minutes, and nothing once the top up is final', () => {
  assert.equal(withdrawWaitText(null, T), null);
  assert.equal(withdrawWaitText(at(3), T), 'Your latest top up is still being confirmed on Ethereum. Withdrawals open in about 12 minutes. You can keep playing in the meantime.');
  assert.match(withdrawWaitText(at(0), T), /about 15 minutes/);
  assert.match(withdrawWaitText(at(14.5), T), /about 1 minute\. /);
  assert.match(withdrawWaitText(at(16), T), /Withdrawals open any moment now\./);
  assert.match(withdrawWaitText(new Date(T + 5 * 60_000).toISOString(), T), /about 15 minutes/, 'a clock ahead never shows more than 15');
  assert.equal(creditedText('5,000.00 $TICS'), 'Credited 5,000.00 $TICS. You can play now. Withdrawals open in about 15 minutes.');
  assert.equal(TOPUP_WAIT_NOTE, 'You can play as soon as your top up is credited. Withdrawals open about 15 minutes after it arrives, once Ethereum has confirmed it for good.');
});

test('withdraw wait: the same words on the server, in the Terms and on How it works, with no dashes', () => {
  const worker = readFileSync(new URL('../../worker/index.js', import.meta.url), 'utf8');
  assert.ok(worker.includes("'Your latest top up is still being confirmed on Ethereum. You can withdraw about 15 minutes after it arrived.'"));
  const terms = readFileSync(new URL('../src/Terms.jsx', import.meta.url), 'utf8');
  assert.ok(terms.includes('Until your latest top up is confirmed, you cannot withdraw. This includes any winnings made in that time.'));
  const how = readFileSync(new URL('../src/HowItWorks.jsx', import.meta.url), 'utf8');
  assert.ok(how.includes('After a top up, withdrawals open about 15 minutes later, once Ethereum has confirmed it for good. You can play in the meantime.'));
  for (const text of [withdrawWaitText(at(3), T), creditedText('1 $TICS'), TOPUP_WAIT_NOTE]) assert.doesNotMatch(text, /[\u2013\u2014]| - /);
  const panel = readFileSync(new URL('../src/WalletPanel.jsx', import.meta.url), 'utf8');
  assert.match(panel, /disabled=\{!units \|\| !!problem \|\| busy \|\| !!waitText\}/, 'Withdraw is greyed out while waiting');
});
