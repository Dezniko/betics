// Second audit round: refused spins always open their lock and log the pocket they would have given,
// rolling refusal budgets, locks never opened, other tab/device, payout table id in the spin, lost
// replies, sign-in expiry, top up state, pinned chain, per-wallet saved deposits, frozen withdrawal
// fee, withdrawal request id reuse and the stale-balance re-sync.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classifySpinRefusal, budgetFor, recordRefusal, readRefusalCount, refusalStopMessage, refusalRetiredMessage, PREDICTED_LIMIT, REFUSAL_LIMIT,
  REFUSAL_WINDOW_MS, OPEN_LOCK_GRACE_MS, rememberOpenLock, readOpenLocks, updateOpenLock, forgetOpenLock, findOpenLock, mustRetireLock, locksToCheck,
  findRoundForLock, addRefusedSpin, readRefusedLog, refusedSpinText, MAX_REFUSED_LOG, isBalanceResync, SIGN_IN_EXPIRED_MESSAGE, TABLE_CHANGED_MESSAGE,
  LOST_REPLY_MESSAGE, LOST_REPLY_PAUSED_MESSAGE, OTHER_DEVICE_MESSAGE, STALE_LOCK_MESSAGE, NEVER_OPENED_MESSAGE,
} from '../src/spinRefusal.js';
import { pocketFor, verifyRevealedRound, verifySettlement } from '../src/fairnessClient.js';
import { topUpState, CHAIN_ID, DEPOSITS_CLOSED_MESSAGE, CASINO_WALLET, OFFICIAL_TICS } from '../src/depositTarget.js';
import { restoreSavedDeposit, saveDepositFor, clearDepositFor, depositKey, nextWithdrawRequest, withdrawReviewFee, STORAGE } from '../src/walletApi.js';
import { STANDARD_MULTIPLIERS, didBetWin } from '../src/rouletteRules.js';
import { deriveOutcome, hashServerSeed } from '../../backend/src/core/fairness.js';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, dump: () => m };
}
const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
const H = (c) => c.repeat(64);
const E = (c) => c.repeat(64);
const lock = (over = {}) => ({ identity: '0x12ab34cd56ef7890aabbccddeeff00112233fe0e', serverSeedHash: H('a'), clientSeed: 'lucky', nonce: 0,
  clientEntropy: E('e'), requestId: '0f8fad5b-d9cb-469f-a165-70867728950e', ...over });

// H1 + M4: classification and budgets
test('H1/M4: every refusal class has a budget, 401 is sign-in expiry and never counted', () => {
  assert.equal(classifySpinRefusal(401, 'session expired'), 'auth');
  assert.equal(budgetFor('auth'), null);
  assert.equal(SIGN_IN_EXPIRED_MESSAGE, 'Your sign-in expired. Please connect your wallet again.');
  assert.equal(classifySpinRefusal(503, 'Several big bets are being played at this moment. Please try again in a few seconds.'), 'predicted');
  assert.equal(budgetFor(classifySpinRefusal(503, 'Several big bets are being played at this moment.')), 'predicted', 'the bankroll guard always counts as predicted');
  assert.equal(classifySpinRefusal(409, TABLE_CHANGED_MESSAGE, 'table_changed'), 'table_changed');
  assert.equal(budgetFor('table_changed'), 'predicted');
  assert.equal(classifySpinRefusal(409, TABLE_CHANGED_MESSAGE), 'unpredicted', 'only the code marks a table change');
  assert.equal(classifySpinRefusal(409, 'stale or mismatched expectedCommitment'), 'stale_lock');
  assert.equal(budgetFor('stale_lock'), 'unpredicted');
  assert.equal(budgetFor(classifySpinRefusal(500, 'internal error')), 'predicted'); // transient: larger budget, lock still opened
  assert.equal(classifySpinRefusal(429, 'Too many'), 'transient');
  assert.equal(budgetFor(classifySpinRefusal(402, 'insufficient balance')), 'predicted');
});

test('H1/M4: budgets are rolling one-hour windows, predicted 10, unpredicted 3, kept apart', () => {
  const s = memoryStorage(), t0 = 1_800_000_000_000;
  assert.equal(PREDICTED_LIMIT, 10); assert.equal(REFUSAL_LIMIT, 3); assert.equal(REFUSAL_WINDOW_MS, 3600000);
  for (let i = 0; i < 9; i++) assert.equal(recordRefusal('predicted', t0 + i * 1000, s).reached, false);
  assert.equal(readRefusalCount('unpredicted', t0 + 9000, s), 0, 'predicted refusals do not use the strict budget');
  assert.equal(recordRefusal('predicted', t0 + 9000, s).reached, true, 'the 10th predicted refusal in an hour stops');
  // An hour later the old ones have rolled out of the window.
  assert.equal(readRefusalCount('predicted', t0 + REFUSAL_WINDOW_MS + 5000, s), 4);
  assert.equal(recordRefusal('predicted', t0 + REFUSAL_WINDOW_MS + 9001, s).count, 1);
  // Strict budget, rolling.
  recordRefusal('unpredicted', t0, s); recordRefusal('unpredicted', t0 + 10, s);
  assert.equal(recordRefusal('unpredicted', t0 + REFUSAL_WINDOW_MS + 1, s).count, 2, 'the first one rolled out');
  // Validation: future or junk timestamps are ignored.
  s.setItem('betics:refusals:unpredicted:v2', JSON.stringify([t0 + 10 * REFUSAL_WINDOW_MS, 'x', t0]));
  assert.equal(readRefusalCount('unpredicted', t0 + 1, s), 1);
  assert.throws(() => recordRefusal('other', t0, s));
});

test('H1/M4: plain, accurate stop and refusal wording with the server reason, no dashes', () => {
  const p = refusalStopMessage('predicted', 10), u = refusalStopMessage('unpredicted', 3);
  assert.match(p, /turned down 10 spins in the last hour/); assert.match(u, /turned down 3 spins in the last hour for a reason this page could not check/);
  for (const m of [p, u]) assert.doesNotMatch(m, /in a row|several/i);
  const r = refusalRetiredMessage('balance check failed');
  assert.match(r, /^The server refused the spin: balance check failed\. Your bet was not taken\./);
  assert.match(refusalRetiredMessage(''), /^The server refused the spin\. Your bet was not taken/);
  assert.doesNotMatch(refusalRetiredMessage('a \u2014 b'), /[\u2013\u2014]/);
  for (const m of [p, u, r, SIGN_IN_EXPIRED_MESSAGE, LOST_REPLY_MESSAGE, LOST_REPLY_PAUSED_MESSAGE, OTHER_DEVICE_MESSAGE, STALE_LOCK_MESSAGE, NEVER_OPENED_MESSAGE, DEPOSITS_CLOSED_MESSAGE]) {
    assert.doesNotMatch(m, /[\u2013\u2014]/, m);
  }
  assert.doesNotMatch(LOST_REPLY_MESSAGE + LOST_REPLY_PAUSED_MESSAGE, /fair|cheat|stopped/i, 'a network blip is not a fairness alert');
});

test('H1: the would-have pocket uses the verifier derivation with the revealed key, lucky word and the random value sent', async () => {
  for (let i = 0; i < 40; i++) {
    const serverSeed = `seed-${i}-${'f'.repeat(i % 7)}`, clientSeed = `lucky-${i}:${(i * 7919).toString(16).padStart(64, '0')}`;
    assert.equal(await pocketFor({ serverSeed, clientSeed, nonce: 0 }), deriveOutcome(serverSeed, clientSeed, 0, 37));
  }
  await assert.rejects(pocketFor({ serverSeed: '', clientSeed: 'x', nonce: 0 }));
  await assert.rejects(pocketFor({ serverSeed: 'k', clientSeed: 'x', nonce: -1 }));
});

test('H1: refused-spins log is bounded, validated on read and reads "Refused spin: would have been 17"', () => {
  const s = memoryStorage(), t0 = 1_800_000_000_000;
  addRefusedSpin({ at: t0, lock: H('a'), pocket: 17, kind: 'predicted', reason: 'The most you can bet on one number right now is 10 $TICS.' }, s);
  addRefusedSpin({ at: t0, lock: H('b'), pocket: null, kind: 'never_opened', reason: 'x' }, s);
  addRefusedSpin({ at: t0, lock: 'nope', pocket: 3, kind: 'predicted' }, s);
  addRefusedSpin({ at: t0, lock: H('c'), pocket: 37, kind: 'predicted' }, s);
  addRefusedSpin({ at: t0, lock: H('d'), pocket: 2, kind: 'made-up' }, s);
  const log = readRefusedLog(s);
  assert.equal(log.length, 2);
  assert.equal(refusedSpinText(log[0]), 'Refused spin: would have been 17');
  assert.equal(refusedSpinText(log[1]), 'Refused spin: the lock was never opened');
  for (let i = 0; i < MAX_REFUSED_LOG + 20; i++) addRefusedSpin({ at: t0 + i, lock: (i.toString(16).padStart(2, '0')).repeat(32), pocket: i % 37, kind: 'unpredicted' }, s);
  assert.equal(readRefusedLog(s).length, MAX_REFUSED_LOG);
  s.setItem('betics:refused-log:v1', JSON.stringify([{ at: 'x' }, { at: t0, lock: H('a'), pocket: 1, kind: 'lost', reason: '<b>'.repeat(100) }, 5]));
  assert.deepEqual(readRefusedLog(s), [], 'malformed or oversized entries are dropped');
  s.setItem('betics:refused-log:v1', '{x'); assert.deepEqual(readRefusedLog(s), []);
  const sheet = src('FairnessSheet.jsx');
  assert.match(sheet, /data-testid="refused-spins"/); assert.match(sheet, /<RefusedSpins entries=\{readRefusedLog\(\)\} \/>/);
  assert.match(src('App.jsx'), /<RefusedSpins entries=\{readRefusedLog\(\)\} \/>/, 'shown in How it works too');
});

test('H1: the app opens the lock through the reveal on every refusal after the random value was sent', () => {
  const app = src('App.jsx');
  const handler = app.slice(app.indexOf('const handleRefusal = async'), app.indexOf('const spin = async'));
  assert.match(handler, /openAndLog\(entry, kind, reason, null, request\.expected\.terms\)/, 'retired through the reveal-and-verify path');
  assert.doesNotMatch(handler, /=== 'predicted'\) \{\s*setError[^}]*return;\s*\}\s*const swap/, 'no early return before the reveal for predicted refusals');
  assert.ok(handler.indexOf('openAndLog(entry, kind, reason, null, request.expected.terms)') < handler.indexOf("if (kind === 'predicted')"), 'reveal happens before the predicted-refusal toast');
  assert.match(app, /recordRefusal\(budget\)/);
  assert.match(app, /pocketFor\(\{ serverSeed: swap\.retired\.serverSeed, clientSeed: `\$\{entry\.clientSeed\}:\$\{entry\.clientEntropy\}`, nonce: entry\.nonce/);
});

// H2 + M1: locks never opened, other tab/device
test('H2: open locks are persisted, validated, per player, and only checked once no tab can still be spinning', () => {
  const s = memoryStorage(), t0 = 1_800_000_000_000;
  rememberOpenLock(lock({ at: t0 }), s);
  rememberOpenLock(lock({ serverSeedHash: H('b'), at: t0, identity: 'guest' }), s);
  assert.throws(() => rememberOpenLock(lock({ clientEntropy: 'short' }), s));
  assert.throws(() => rememberOpenLock(lock({ requestId: 'not-a-uuid' }), s));
  assert.equal(readOpenLocks(s).length, 2);
  assert.equal(findOpenLock(H('a'), lock().identity, s)?.clientEntropy, E('e'));
  assert.equal(findOpenLock(H('a'), 'guest', s), null, 'another player never sees this lock');
  assert.equal(mustRetireLock(findOpenLock(H('a'), lock().identity, s), t0 + 1000), false, 'fresh: another tab may still be waiting for its reply');
  assert.equal(mustRetireLock(findOpenLock(H('a'), lock().identity, s), t0 + OPEN_LOCK_GRACE_MS + 1), true);
  updateOpenLock(H('a'), { refused: true }, s);
  assert.equal(mustRetireLock(findOpenLock(H('a'), lock().identity, s), t0 + 1), true, 'a refused lock is opened at once');
  assert.deepEqual(locksToCheck(lock().identity, H('a'), t0 + OPEN_LOCK_GRACE_MS + 1, s), [], 'the current lock is retired, not looked up');
  assert.equal(locksToCheck(lock().identity, H('c'), t0 + 1, s).length, 1);
  assert.equal(locksToCheck('guest', H('c'), t0 + 1, s).length, 0, 'guest entry is still within the grace time');
  forgetOpenLock(H('a'), s);
  assert.equal(readOpenLocks(s).length, 1);
  s.setItem('betics:open-locks:v1', JSON.stringify([{ ...lock(), at: 'x', refused: false, counted: false }, 7]));
  assert.deepEqual(readOpenLocks(s), []);
});

async function realRound({ serverSeed = 'srv-key-1', base = 'lucky', entropy = E('e'), requestId = lock().requestId, nonce = 0 } = {}) {
  const clientSeed = `${base}:${entropy}`;
  const pocket = deriveOutcome(serverSeed, clientSeed, nonce, 37);
  return { id: 9, server_seed: serverSeed, server_seed_hash: hashServerSeed(serverSeed), client_seed: clientSeed, client_seed_base: base, client_entropy: entropy,
    request_id: requestId, nonce, outcome_json: JSON.stringify({ pocket, betResults: [] }), stake_cents: 100, payout_cents: 0 };
}

test('H2/M1: a settled round for the lock is found, told apart (own vs other tab or device) and verified', async () => {
  const own = await realRound();
  const entry = lock({ serverSeedHash: own.server_seed_hash, at: 0, refused: false, counted: false });
  assert.equal(findRoundForLock([own], entry).own, true);
  const other = await realRound({ entropy: E('1'), requestId: '1b4e28ba-2fa1-11d2-883f-0016d3cca427' });
  const hit = findRoundForLock([{ server_seed_hash: H('9') }, other], entry);
  assert.equal(hit.own, false, 'a different random value and request: another tab or device used the lock');
  assert.equal(findRoundForLock([{ server_seed_hash: H('9') }], entry), null, 'not in the history: never opened');
  assert.equal(findRoundForLock(null, entry), null);
  assert.deepEqual(await verifyRevealedRound(own), { ok: true, pocket: JSON.parse(own.outcome_json).pocket });
  const p = JSON.parse(own.outcome_json).pocket;
  assert.equal((await verifyRevealedRound({ ...own, outcome_json: JSON.stringify({ pocket: (p + 1) % 37 }) })).ok, false, 'a wrong pocket fails');
  assert.equal((await verifyRevealedRound({ ...own, server_seed: 'another key' })).ok, false, 'a key that does not fit the lock fails');
  assert.equal((await verifyRevealedRound({ ...own, client_seed: `lucky:${E('2')}` })).ok, false, 'inputs that do not add up fail');
  assert.equal((await verifyRevealedRound({ ...own, server_seed: undefined })).ok, false);
  assert.equal((await verifyRevealedRound(null)).ok, false);
  const app = src('App.jsx');
  assert.match(app, /if \(!entry\.counted\) \{\s*const r = recordRefusal\('unpredicted'\)/, 'a lock never opened counts as unpredicted once');
  assert.match(app, /setNotice\(NEVER_OPENED_MESSAGE\)/);
  assert.match(app, /if \(hit\) \{ await acceptOtherDeviceRound\(hit\.round, entry, request\.expected\.terms\); return; \}/, 'stale lock used elsewhere: checked, counted and logged (see player-audit-3)');
});

// M2: payout table id in the spin
test('M2: the spin body carries the confirmed payout table id; table_changed re-prompts the confirm', () => {
  const app = src('App.jsx');
  assert.match(app, /JSON\.stringify\(\{ \.\.\.request\.body, mode, \.\.\.\(mathId \? \{ mathId \} : \{\}\) \}\)/);
  assert.match(app, /const mathId = gameConfig\?\.math\?\.id \|\| null;/);
  const handler = app.slice(app.indexOf('const handleRefusal = async'), app.indexOf('const spin = async'));
  assert.match(handler, /kind === 'table_changed'\) \{\s*setTableRecheck\(true\);\s*await loadGameConfig\(\);\s*setTableNoticeOpen\(true\);/);
  assert.match(app, /data-testid="payout-table-accept"/);
});

// M3: lost reply
test('M3: no reply polls the history for about 20 s, then opens the lock calmly', () => {
  const app = src('App.jsx');
  assert.match(app, /const LOST_REPLY_WAIT_MS = 20000;/);
  const fn = app.slice(app.indexOf('const recoverLostReply = async'), app.indexOf('const handleRefusal = async'));
  assert.match(fn, /fetchRounds\(\)/);
  assert.match(fn, /openAndLog\(entry, 'lost'/);
  assert.doesNotMatch(fn, /recordRefusal/, 'a network blip is not counted');
  assert.match(fn, /setNotice\(LOST_REPLY_MESSAGE\)/);
  const spin = app.slice(app.indexOf('const spin = async'), app.indexOf('spinRef.current = spin;'));
  assert.match(spin, /if \(!resp \|\| \(resp\.ok && !data\)\) \{[^}]*recoverLostReply/);
});

// L1, L2
test('L1/L2: top ups closed (no casino wallet or switched off) is checked before the address check; chain pinned', () => {
  const ok = { depositsOpen: true, token: OFFICIAL_TICS, casinoWallet: CASINO_WALLET };
  assert.equal(topUpState(ok), 'open');
  assert.equal(topUpState({ ...ok, casinoWallet: null }), 'closed');
  assert.equal(topUpState({ ...ok, casinoWallet: null, token: '0x1111111111111111111111111111111111111111' }), 'closed', 'closed wins over a mismatch');
  assert.equal(topUpState({ ...ok, depositsOpen: false, casinoWallet: '0xc0ffee0000000000000000000000000000000001' }), 'closed');
  assert.equal(topUpState({ ...ok, casinoWallet: '0xc0ffee0000000000000000000000000000000001' }), 'paused');
  assert.equal(topUpState(null), 'closed');
  assert.equal(CHAIN_ID, 1, 'Ethereum mainnet unless VITE_CHAIN_ID says otherwise');
  const app = src('App.jsx'), panel = src('WalletPanel.jsx');
  assert.match(app, /sendTics\(\{ token: OFFICIAL_TICS, to: CASINO_WALLET, units, chainId: CHAIN_ID, from: profile\.address \}\)/);
  assert.doesNotMatch(panel, /profile\.casinoWallet/, 'the pinned casino wallet is shown and copied, never the server one');
  assert.match(panel, /writeText\(CASINO_WALLET\)/); assert.match(panel, /\{CASINO_WALLET\}<\/code>/);
  const topup = panel.slice(panel.indexOf('function TopUp'), panel.indexOf('function Withdraw'));
  assert.equal((topup.match(/\{statusLine\}/g) || []).length, 3, 'the deposit on its way stays visible when closed, paused or open');
});

// L3
test('L3: no spin before the game config is loaded', () => {
  const app = src('App.jsx');
  assert.match(app, /failed: verificationBlocked \|\| !gameConfig \|\| gameClosed \|\| tableInvalid/);
});

// L4
test('L4: saved top ups are kept per wallet; another wallet\'s entry is never deleted', () => {
  const s = memoryStorage();
  const a = '0x12ab34cd56ef7890aabbccddeeff00112233fe0e', b = '0x0000000000000000000000000000000000000001';
  const ha = `0x${'ab'.repeat(32)}`, hb = `0x${'cd'.repeat(32)}`;
  saveDepositFor(s, a, ha); saveDepositFor(s, b, hb);
  assert.equal(depositKey(a.toUpperCase().replace('0X', '0x')), depositKey(a));
  assert.equal(restoreSavedDeposit(s, a).txHash, ha);
  assert.equal(restoreSavedDeposit(s, b).txHash, hb, 'wallet B still has its own');
  clearDepositFor(s, a);
  assert.equal(restoreSavedDeposit(s, a), null); assert.equal(restoreSavedDeposit(s, b).txHash, hb);
  // An older build's shared entry: moved for its own wallet, left alone for another.
  s.setItem(STORAGE.deposit, JSON.stringify({ txHash: ha, address: a }));
  assert.equal(restoreSavedDeposit(s, b).txHash, hb);
  assert.ok(s.getItem(STORAGE.deposit), 'another wallet\'s legacy entry is kept');
  assert.equal(restoreSavedDeposit(s, a).txHash, ha);
  assert.equal(s.getItem(STORAGE.deposit), null, 'moved under the per-wallet key');
  s.setItem(depositKey(a), '{bad'); assert.equal(restoreSavedDeposit(s, a), null); assert.equal(s.getItem(depositKey(a)), null);
  assert.doesNotMatch(src('App.jsx'), /writeStore\(STORAGE\.deposit, null\)/);
});

// L5, L6
test('L5: the review freezes the fee; a changed quote shows and must confirm the new fee', () => {
  assert.deepEqual(withdrawReviewFee({ confirming: false, frozenFee: null, fee: 500 }), { shownFee: 500, feeChanged: false });
  assert.deepEqual(withdrawReviewFee({ confirming: true, frozenFee: 500, fee: 500 }), { shownFee: 500, feeChanged: false });
  assert.deepEqual(withdrawReviewFee({ confirming: true, frozenFee: 500, fee: 650 }), { shownFee: 650, feeChanged: true });
  const panel = src('WalletPanel.jsx');
  assert.match(panel, /feeChanged \? `Confirm new fee \$\{fmtMoney\(fee\)\}` : 'Confirm'/);
  assert.match(panel, /await walletApi\.withdraw\(units, agreedFee, request\.id\)/);
});

test('L6: the same withdrawal retried after a failed try reuses its request id', () => {
  let n = 0; const id = () => `id-${++n}`;
  const first = nextWithdrawRequest(null, 10000, id);
  assert.equal(nextWithdrawRequest(first, 10000, id), first, 'retry of the same amount: same id');
  const changed = nextWithdrawRequest(first, 12000, id);
  assert.notEqual(changed.id, first.id, 'a new amount gets a new id');
  assert.notEqual(nextWithdrawRequest(null, 10000, id).id, first.id, 'after a success (pending cleared) a new id');
  const panel = src('WalletPanel.jsx');
  assert.match(panel, /pendingRequest\.current = null;\s*setAmount\(''\)/, 'cleared only after success');
});

// L7
test('L7: a stale balance before the spin is a re-sync only when the fresh balance is at least what it should be', () => {
  const bets = [{ type: 'red', amountCents: 1000 }];
  const terms = { bets, stake: 1000, mode: 'real', mathId: 'standard', multipliers: STANDARD_MULTIPLIERS, balanceBefore: 50000, balanceFresh: false };
  // Another device withdrew 20,000 before this spin: the server started from 30,000 and lost the red bet.
  const data = { pocket: 2, mode: 'real', mathId: 'standard', betResults: [{ ...bets[0], payoutCents: 0 }], totalStakeCents: 1000, totalPayoutCents: 0, balanceAfterCents: 29000 };
  const settlement = verifySettlement(terms, data, didBetWin);
  assert.deepEqual(settlement.problems, ['balance credited too little']);
  // Re-audit 3: a lower balance is never explained away as another device any more.
  assert.equal(isBalanceResync({ terms, data, settlement, freshBalance: 29000 }), false, 'lower than balance before - stake + payout: always flagged');
  assert.equal(isBalanceResync({ terms, data, settlement, freshBalance: 49000 }), true, 'the fresh balance is what it should be after the spin');
  assert.equal(isBalanceResync({ terms: { ...terms, balanceFresh: true }, data, settlement, freshBalance: 49000 }), false, 'a balance read right before the spin is never re-synced');
  assert.equal(isBalanceResync({ terms, data, settlement, freshBalance: null }), false);
  const shortPaid = verifySettlement(terms, { ...data, pocket: 1, betResults: [{ ...bets[0], payoutCents: 1000 }], totalPayoutCents: 1000 }, didBetWin);
  assert.equal(isBalanceResync({ terms, data, settlement: shortPaid, freshBalance: 49000 }), false, 'any other problem stays a failure');
  const app = src('App.jsx');
  assert.match(app, /const WALLET_STALE_MS = 10000;/);
  assert.match(app, /if \(Date\.now\(\) - walletAtRef\.current > WALLET_STALE_MS\) \{\s*try \{\s*const w = await walletApi\.wallet\(\);/);
});
