// The notice shown once per browser when a player presses Connect wallet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONNECT_NOTICE_KEY, CONNECT_NOTICE, needsConnectNotice, acceptConnectNotice } from '../src/connectNotice.js';

const memory = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

test('shown until accepted, then never again in that browser', () => {
  const s = memory();
  assert.equal(needsConnectNotice(s), true);
  acceptConnectNotice(s);
  assert.equal(s.getItem(CONNECT_NOTICE_KEY), '1');
  assert.equal(needsConnectNotice(s), false);
});

test('storage that throws (private mode) still shows the notice and does not crash', () => {
  const broken = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
  assert.equal(needsConnectNotice(broken), true);
  assert.doesNotThrow(() => acceptConnectNotice(broken));
});

test('copy is exactly what Dez approved: no emoji, no dashes', () => {
  assert.equal(CONNECT_NOTICE.title, 'Before you connect');
  assert.deepEqual(CONNECT_NOTICE.sections.map((s) => s.heading), [
    'Your balance is held by the casino.', 'Every win is covered.', 'Every spin is provably fair.', 'qu-BETICS is in beta.']);
  const all = [CONNECT_NOTICE.title, ...CONNECT_NOTICE.sections.flatMap((s) => [s.heading, s.text]), CONNECT_NOTICE.agree].join(' ');
  assert.match(all, /qu-BETICS is a custodial casino, like most crypto casinos\./);
  assert.match(all, /The maximum bet adjusts automatically to the funds in the casino wallet, so the table only accepts bets it can pay out\./);
  assert.match(all, /your browser adds its own random number/);
  assert.match(all, /Please only play with what you are comfortable with\./);
  assert.ok(!/\p{Extended_Pictographic}/u.test(all), 'no emoji');
  assert.ok(!/[\u2013\u2014]/.test(all) && !/ - /.test(all), 'no dashes');
});

test('App: Connect wallet opens the notice first when it was not accepted yet', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /onClick=\{requestConnect\}/);
  assert.match(app, /const requestConnect = \(\) => \{[^}]*needsConnectNotice\(\)/);
  assert.match(app, /<ConnectNotice /);
});

test('How it works says the casino is custodial, in the same words as the notice', () => {
  const how = readFileSync(new URL('../src/HowItWorks.jsx', import.meta.url), 'utf8');
  assert.match(how, /<h2>Your balance is held by the casino<\/h2>/);
  assert.match(how, /const CUSTODY_TEXT = CONNECT_NOTICE\.sections\[0\]\.text;/);
  assert.ok(how.indexOf('Your balance is held by the casino') < how.indexOf('<h2>Withdrawals</h2>'), 'before Withdrawals');
});
