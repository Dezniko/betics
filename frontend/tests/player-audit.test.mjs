// Player frontend audit fixes: pinned deposit target, payout table check, inbox links, saved tx
// hash, refused-spin counter, history settlement check and the CSP mirror.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { depositTargetProblem, OFFICIAL_TICS, CASINO_WALLET, TICS_CONTRACT, sameAddress } from '../src/depositTarget.js';
import { checkPayoutTable, setPayoutTable, maxPayoutUnits, readConfirmedTables, confirmTable, isTableConfirmed, describeTableDifferences, STANDARD_MULTIPLIERS, didBetWin } from '../src/rouletteRules.js';
import { inboxLink } from '../src/inboxLink.js';
import { isTxHash, readSavedDeposit } from '../src/walletApi.js';
import { classifySpinRefusal, readRefusalCount, recordRefusal, refusalLimitReached, REFUSAL_LIMIT, canAcceptReloadedLock } from '../src/spinRefusal.js';
import { combineVerification, settlementFromRound, withoutBalance } from '../src/fairnessClient.js';
import { ROULETTE_MATH } from '../../backend/src/games/rouletteMath.js';
import { payoutCentsFor } from '../../backend/src/games/roulette.js';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null };
}

// 2. Pinned deposit target
test('deposit target: only the pinned token and casino wallet, compared without case', () => {
  assert.equal(OFFICIAL_TICS, TICS_CONTRACT, 'default token is the Terms contract');
  assert.equal(CASINO_WALLET, '0x0400e48587a43078c72158fb5c2e482d181754db');
  const ok = { token: '0x551ECFDBA071CB6541F642CB90A073C8C158DF05', casinoWallet: '0x0400E48587A43078C72158fB5C2e482D181754DB' };
  assert.equal(depositTargetProblem(ok), null);
  assert.equal(depositTargetProblem({ ...ok, token: '0xad34bb0000000000000000000000000000a177aa' }), 'token differs');
  assert.equal(depositTargetProblem({ ...ok, casinoWallet: '0xc0ffee0000000000000000000000000000000001' }), 'casino wallet differs');
  assert.equal(depositTargetProblem({ ...ok, casinoWallet: undefined }), 'casino wallet differs');
  assert.equal(depositTargetProblem({ ...ok, casinoWallet: `${ok.casinoWallet} ` }), 'casino wallet differs', 'no trimming tricks');
  assert.equal(depositTargetProblem(null), 'no profile');
  assert.equal(sameAddress('0xabc', '0xABC'), false, 'only full 20-byte addresses');
  // A custom build pins other addresses.
  const pinned = { token: '0x1111111111111111111111111111111111111111', wallet: '0x2222222222222222222222222222222222222222' };
  assert.equal(depositTargetProblem({ token: pinned.token, casinoWallet: pinned.wallet }, pinned), null);
});

// 3. Payout table
test('payout table: standard and lower tables pass, higher or malformed ones are rejected', () => {
  assert.deepEqual(checkPayoutTable(ROULETTE_MATH.standard).lower, false);
  assert.equal(checkPayoutTable(null).ok, true, 'no config yet means standard');
  const lower = checkPayoutTable(ROULETTE_MATH.straight34);
  assert.equal(lower.ok, true); assert.equal(lower.lower, true);
  assert.deepEqual(lower.differences, [{ type: 'straight', multiplier: 35, standard: 36 }]);
  assert.deepEqual(describeTableDifferences(lower.differences), ['Straight up pays 34 to 1 (standard 35 to 1)']);
  assert.equal(lower.key, `straight34:${Object.keys(STANDARD_MULTIPLIERS).map((t) => (t === 'straight' ? 35 : STANDARD_MULTIPLIERS[t])).join(',')}`);
  for (const bad of [
    { id: 'x', multipliers: { straight: 37 } },        // above standard
    { id: 'x', multipliers: { red: 2.5 } },            // not an integer
    { id: 'x', multipliers: { red: 0 } },              // not positive
    { id: 'x', multipliers: { red: -2 } },
    { id: 'x', multipliers: { red: '2' } },
    { id: 'x', multipliers: { jackpot: 2 } },          // unknown type
    { id: 'x', multipliers: [] },
    { id: 'standard', multipliers: { ...STANDARD_MULTIPLIERS, straight: 35 } }, // "standard" must be standard
    { id: '<script>', multipliers: STANDARD_MULTIPLIERS },
    { id: 42, multipliers: STANDARD_MULTIPLIERS },
  ]) assert.equal(checkPayoutTable(bad).ok, false, JSON.stringify(bad));
  assert.equal(checkPayoutTable({ id: 'standard' }).ok, true, 'a standard id without a table is the standard table');
  assert.equal(checkPayoutTable({ id: 'odd' }).ok, false, 'a non-standard id needs its table');
});

test('payout table: an invalid table is never used for display maths', () => {
  setPayoutTable({ straight: 1000 });
  assert.equal(maxPayoutUnits([{ type: 'straight', value: 7, amountCents: 100 }]), 3600, 'falls back to standard');
  setPayoutTable(ROULETTE_MATH.straight34.multipliers);
  assert.equal(maxPayoutUnits([{ type: 'straight', value: 7, amountCents: 100 }]), 3500);
  setPayoutTable(null);
});

test('payout table: a lower table is confirmed once per exact table, storage is validated on read', () => {
  const s = memoryStorage();
  const key = checkPayoutTable(ROULETTE_MATH.straight34).key;
  assert.equal(isTableConfirmed(key, s), false);
  confirmTable(key, s);
  assert.equal(isTableConfirmed(key, s), true);
  const other = checkPayoutTable({ id: 'straight34', multipliers: { ...ROULETTE_MATH.straight34.multipliers, red: 1 } }).key;
  assert.equal(isTableConfirmed(other, s), false, 'a further change needs a new confirmation');
  confirmTable('junk', s);
  assert.deepEqual(readConfirmedTables(s), [key]);
  s.setItem('betics:payout-confirmed:v1', JSON.stringify([key, 'x:1', { a: 1 }, 7]));
  assert.deepEqual(readConfirmedTables(s), [key], 'malformed entries are ignored');
  s.setItem('betics:payout-confirmed:v1', '{not json');
  assert.deepEqual(readConfirmedTables(s), []);
});

// 4. Inbox links
test('inbox links: same site or https only, external ones flagged for a new tab', () => {
  const o = 'https://www.betics.io';
  assert.deepEqual(inboxLink('/how-it-works', o), { href: '/how-it-works', external: false });
  assert.deepEqual(inboxLink('https://www.betics.io/terms?x=1#a', o), { href: '/terms?x=1#a', external: false });
  assert.deepEqual(inboxLink('https://t.me/Betics_casino', o), { href: 'https://t.me/Betics_casino', external: true });
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,hi', 'http://evil.example/', 'https://user:pw@evil.example/', 'vbscript:x', '', '   ', null, 42, `https://x.example/${'a'.repeat(2100)}`]) {
    const r = inboxLink(bad, o);
    assert.ok(r === null || (r.external === false && r.href.startsWith('/') && !r.href.startsWith('//')), `${String(bad).slice(0, 40)} -> ${JSON.stringify(r)}`);
  }
  // Tricks that resolve to another site are judged by where the browser would go: external https, new tab.
  assert.deepEqual(inboxLink('//evil.example/x', o), { href: 'https://evil.example/x', external: true });
  assert.deepEqual(inboxLink('/\\evil.example', o), { href: 'https://evil.example/', external: true });
  assert.equal(inboxLink('//evil.example/x', 'http://127.0.0.1:8789'), null, 'on an http page a protocol-relative link is http, refused');
});

// 5. Saved deposit tx hash
test('saved deposit: only a 0x + 64 hex tx hash for this wallet is used', () => {
  const addr = '0x12ab34cd56ef7890aabbccddeeff00112233fe0e';
  const hash = `0x${'ab'.repeat(32)}`;
  assert.equal(isTxHash(hash), true);
  assert.equal(isTxHash(hash.toUpperCase().replace('0X', '0x')), true);
  for (const bad of [hash.slice(0, -1), `${hash}0`, `0x${'g'.repeat(64)}`, `javascript:${hash}`, hash.slice(2), null, 1]) assert.equal(isTxHash(bad), false, String(bad));
  assert.deepEqual(readSavedDeposit(JSON.stringify({ txHash: hash, address: addr }), addr), { txHash: hash, address: addr });
  assert.deepEqual(readSavedDeposit(JSON.stringify({ txHash: hash, address: addr.toUpperCase().replace('0X', '0x') }), addr)?.txHash, hash);
  assert.equal(readSavedDeposit(JSON.stringify({ txHash: `${hash}"><img>`, address: addr }), addr), null);
  assert.equal(readSavedDeposit(JSON.stringify({ txHash: hash, address: '0x0000000000000000000000000000000000000001' }), addr), null);
  assert.equal(readSavedDeposit('{bad json', addr), null);
  assert.equal(readSavedDeposit(null, addr), null);
});

// 1. Refused spins
test('refused spins: limit, balance, mode and pause refusals are expected, anything else is not', () => {
  assert.equal(classifySpinRefusal(402, 'insufficient balance'), 'predicted');
  assert.equal(classifySpinRefusal(403, 'Demo is not available while you have real funds.'), 'predicted');
  assert.equal(classifySpinRefusal(503, 'This game is having a short break.'), 'predicted');
  assert.equal(classifySpinRefusal(503, 'The most you can bet on one number right now is 10 $TICS.'), 'predicted');
  assert.equal(classifySpinRefusal(400, 'The total bet can be at most 5,000 $TICS.'), 'predicted');
  assert.equal(classifySpinRefusal(400, 'The total bet must be at least 1 $TICS.'), 'predicted');
  assert.equal(classifySpinRefusal(400, 'These bets could win more than 50,000 $TICS, the most one spin can pay. Lower the bet.'), 'predicted');
  assert.equal(classifySpinRefusal(400, 'These bets are over the table limit. Lower the bet.'), 'predicted');
  assert.equal(classifySpinRefusal(409, 'stale or mismatched expectedCommitment'), 'stale_lock');
  assert.equal(classifySpinRefusal(401, 'demo session required'), 'auth');
  for (const [status, msg] of [[409, 'clientEntropy already used'], [409, 'balance check failed'],
    [400, 'invalid bet type'], [400, 'clientEntropy must be 64 lowercase hex characters'], [418, ''], [0, undefined]]) {
    assert.equal(classifySpinRefusal(status, msg), 'unpredicted', `${status} ${msg}`);
  }
});

test('refused spins: unpredicted ones stop on the third within an hour, storage validated', () => {
  const s = memoryStorage();
  const t0 = 1_800_000_000_000;
  assert.equal(REFUSAL_LIMIT, 3);
  assert.equal(readRefusalCount('unpredicted', t0, s), 0);
  assert.equal(recordRefusal('unpredicted', t0, s).reached, false);
  assert.equal(recordRefusal('unpredicted', t0 + 1, s).reached, false);
  const third = recordRefusal('unpredicted', t0 + 2, s);
  assert.equal(third.count, 3); assert.equal(third.reached, true); assert.equal(refusalLimitReached(3), true);
  s.setItem('betics:refusals:unpredicted:v2', 'abc'); assert.equal(readRefusalCount('unpredicted', t0, s), 0);
  s.setItem('betics:refusals:unpredicted:v2', JSON.stringify(['x', -4, null])); assert.equal(readRefusalCount('unpredicted', t0, s), 0);
  assert.equal(recordRefusal('unpredicted', t0, null).count, 1, 'no storage still counts this one');
  assert.equal(canAcceptReloadedLock({ serverSeedHash: 'b'.repeat(64) }, 'a'.repeat(64)), false, 'a swapped lock without the reveal');
  assert.equal(canAcceptReloadedLock({ serverSeedHash: 'a'.repeat(64) }, 'a'.repeat(64)), true, 'same lock after a failed request');
  assert.equal(canAcceptReloadedLock({ serverSeedHash: 'b'.repeat(64) }, null), true, 'first load');
});

// 7. History verify
test('history verify: money is checked against saved terms, without terms it says number only', () => {
  const bets = [{ type: 'straight', value: 17, amountCents: 1000 }, { type: 'red', amountCents: 500 }];
  const terms = { bets, stake: 1500, mode: 'real', mathId: 'standard', multipliers: STANDARD_MULTIPLIERS, balanceBefore: 10000 };
  const pocket = 17;
  const betResults = bets.map((b) => ({ ...b, payoutCents: payoutCentsFor(b, pocket, ROULETTE_MATH.standard) }));
  const payout = betResults.reduce((t, b) => t + b.payoutCents, 0);
  const row = { id: 5, stake_cents: 1500, payout_cents: payout, math_id: 'standard', real_money: 1, outcome_json: JSON.stringify({ pocket, color: 'black', betResults }) };
  const data = settlementFromRound(row);
  assert.equal(data.mode, 'real'); assert.equal(data.totalPayoutCents, payout);
  const outcome = { ok: true, status: 'verified' };
  // History rounds carry no ending balance, so callers pass the terms without balanceBefore.
  assert.equal(combineVerification(outcome, withoutBalance(terms), data, didBetWin).ok, true);
  assert.equal(combineVerification(outcome, withoutBalance(terms), data, didBetWin).numberOnly, false);
  // With balanceBefore in the terms a missing ending balance is a failure, never a skipped check.
  assert.equal(combineVerification(outcome, terms, data, didBetWin).ok, false);
  const shortPaid = settlementFromRound({ ...row, payout_cents: payout - 100, outcome_json: JSON.stringify({ pocket, betResults: betResults.map((b, i) => (i === 0 ? { ...b, payoutCents: b.payoutCents - 100 } : b)) }) });
  const bad = combineVerification(outcome, withoutBalance(terms), shortPaid, didBetWin);
  assert.equal(bad.ok, false); assert.equal(bad.status, 'settlement');
  assert.equal(combineVerification(outcome, null, data, didBetWin).numberOnly, true);
  assert.equal(combineVerification(outcome, terms, null, didBetWin).numberOnly, true);
  const failed = { ok: false, status: 'mismatch' };
  assert.equal(combineVerification(failed, terms, data, didBetWin), failed, 'a failed number proof is never upgraded');
  assert.equal(settlementFromRound({ outcome_json: '{bad' }), null);
});

// 8. Headers
test('headers: _headers CSP equals the Worker CSP, only the Cloudflare and Google analytics hosts besides self, COOP set', () => {
  const headersFile = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('../../worker/index.js', import.meta.url), 'utf8');
  const block = worker.match(/const CSP = \[([\s\S]*?)\]\.join\('; '\);/)[1];
  const csp = [...block.matchAll(/^\s*"([^"]+)",?\s*$/gm)].map((m) => m[1]).join('; ');
  assert.ok(headersFile.includes(`Content-Security-Policy: ${csp}`), '_headers carries the same CSP as the Worker');
  assert.match(csp, /script-src 'self' https:\/\/static\.cloudflareinsights\.com https:\/\/www\.googletagmanager\.com;/); // Cloudflare Web Analytics and Google Analytics, nothing else
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  assert.match(headersFile, /Cross-Origin-Opener-Policy: same-origin-allow-popups/);
});

// 9. Wording
test('player copy: softened promises, no dashes', () => {
  const how = readFileSync(new URL('../src/HowItWorks.jsx', import.meta.url), 'utf8');
  const wallet = readFileSync(new URL('../src/WalletPanel.jsx', import.meta.url), 'utf8');
  for (const s of ['How your balance is covered', 'designed to always hold enough', 'the game is designed so every one of them can be paid',
    'the casino cannot change it after you bet without the check failing', 'Withdrawals are sent automatically']) assert.ok(how.includes(s), s);
  for (const s of ['Your balance is always covered', 'built to always hold enough', 'every one of them is paid,', 'Withdrawals are automatic']) assert.ok(!how.includes(s), s);
  assert.ok(!wallet.includes('Your balance is safe'));
  assert.ok(wallet.includes('Your balance stays in your account.'));
  for (const src of [how, wallet]) assert.doesNotMatch(src, /[\u2013\u2014]/);
});
