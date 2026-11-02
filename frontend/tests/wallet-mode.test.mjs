import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMode, parseTicsInput, shortAddress, explorerTx, modeBalance, balanceField } from '../src/walletApi.js';

const profile = { address: '0x12ab34cd56ef7890aabbccddeeff00112233fe0e', realEnabled: true };

test('Real / Demo: demo by default, real needs a wallet and realEnabled, funded players are always in Real', () => {
  assert.deepEqual(resolveMode({ stored: null, wallet: { demoAllowed: true }, profile: null }),
    { mode: 'demo', demoVisible: true, realAvailable: false, realReason: 'Connect a wallet to play with real $TICS.' });
  assert.equal(resolveMode({ stored: 'real', wallet: { demoAllowed: true }, profile: null }).mode, 'demo');
  assert.equal(resolveMode({ stored: 'real', wallet: { demoAllowed: true }, profile: { ...profile, realEnabled: false } }).realReason, 'Real play is not open yet.');
  assert.equal(resolveMode({ stored: 'real', wallet: { demoAllowed: true }, profile }).mode, 'real');
  assert.equal(resolveMode({ stored: 'demo', wallet: { demoAllowed: true }, profile }).mode, 'demo');
  const funded = resolveMode({ stored: 'demo', wallet: { demoAllowed: false }, profile });
  assert.equal(funded.mode, 'real'); assert.equal(funded.demoVisible, false);
  // Old fixtures without demoAllowed keep Demo.
  assert.equal(resolveMode({ stored: null, wallet: { balanceCents: 5 }, profile: null }).demoVisible, true);
});

test('balance of the current mode', () => {
  const w = { balanceCents: 10000000, realTicsCents: 2500 };
  assert.equal(modeBalance(w, 'demo'), 10000000);
  assert.equal(modeBalance(w, 'real'), 2500);
  assert.equal(modeBalance(null, 'real'), null);
  assert.equal(balanceField('real'), 'realTicsCents');
  assert.equal(balanceField(undefined), 'balanceCents');
});

test('amount input, short address and explorer links', () => {
  assert.equal(parseTicsInput('12.5'), 1250);
  assert.equal(parseTicsInput('1,000'), 100000);
  assert.equal(parseTicsInput('0.01'), 1);
  for (const bad of ['', '0', '-1', '1.234', 'abc', '1e5']) assert.equal(parseTicsInput(bad), null, bad);
  assert.equal(shortAddress(profile.address), '0x12ab...fe0e');
  assert.ok(!/[\u2026\u2013\u2014]/.test(shortAddress(profile.address)));
  assert.equal(explorerTx(1, '0xab'), 'https://etherscan.io/tx/0xab');
  assert.equal(explorerTx(11155111, '0xab'), 'https://sepolia.etherscan.io/tx/0xab');
});
