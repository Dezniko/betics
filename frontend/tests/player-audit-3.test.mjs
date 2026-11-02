// Re-audit 3 (frontend): a malicious or compromised server must not be able to choose outcomes that
// this browser then accepts silently. Each test is the safe counterpart of a PoC that reproduced the
// problem before the fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  classifySpinRefusal, budgetFor, findRoundForLock, ownRoundProblems, isBalanceResync, shortCreditMessage, BALANCE_RESYNC_MESSAGE,
  wouldHaveWon, wouldHaveText, addRefusedSpin, readRefusedLog, refusedSpinText, checkRefusalAgainstKnown, postJsonWithTimeout, SPIN_TIMEOUT_MS,
  refusalRetiredMessage, OTHER_DEVICE_MESSAGE, OTHER_DEVICE_ALONE_MESSAGE, OWN_ROUND_SWAPPED_MESSAGE, PREDICTED_LIMIT,
} from '../src/spinRefusal.js';
import { beat, otherTabRecently, tabIdFor, OTHER_TAB_WINDOW_MS } from '../src/tabPresence.js';
import { pocketFor, verifyRevealedRound, verifySettlement, settlementFromRound } from '../src/fairnessClient.js';
import { STANDARD_MULTIPLIERS, didBetWin } from '../src/rouletteRules.js';
import { reserveWalletMatches, etherscanAddress, PINNED_WALLET_URL, CASINO_WALLET, CHAIN_ID } from '../src/depositTarget.js';
import { heldRowText } from '../src/walletApi.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
const slice = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from) + 1));
const DASH = /[\u2013\u2014]| - /;
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null };
}
function lockAndEntry() {
  const serverSeed = randomBytes(32).toString('hex');
  const entry = { identity: 'guest', serverSeedHash: sha(serverSeed), clientSeed: 'lucky', nonce: 0, clientEntropy: randomBytes(32).toString('hex'), requestId: randomUUID(), at: 0, refused: false, counted: false };
  return { serverSeed, entry };
}

// ---- Finding 1: a made-up "another device" round on the same lock ----
test('R3-1: a round on this lock that this browser did not make counts in the strict budget and logs the would-have win', async () => {
  const { serverSeed, entry } = lockAndEntry();
  const fakeEntropy = randomBytes(32).toString('hex');
  const pocket = await pocketFor({ serverSeed, clientSeed: `lucky:${fakeEntropy}`, nonce: 0 });
  const round = { server_seed: serverSeed, server_seed_hash: entry.serverSeedHash, client_seed: `lucky:${fakeEntropy}`, client_seed_base: 'lucky',
    client_entropy: fakeEntropy, nonce: 0, request_id: randomUUID(), outcome_json: JSON.stringify({ pocket }) };
  assert.equal(classifySpinRefusal(409, 'stale or mismatched expectedCommitment'), 'stale_lock');
  const hit = findRoundForLock([round], entry);
  assert.equal(hit.own, false);
  assert.equal((await verifyRevealedRound(round)).ok, true, 'the made-up round is self-consistent, so self-checks alone cannot catch it');
  assert.equal(budgetFor('other_device'), 'unpredicted', 'counted in the strict budget');

  // The revealed key gives where THIS browser's spin would have landed, and what it would have won.
  const mine = await pocketFor({ serverSeed, clientSeed: `lucky:${entry.clientEntropy}`, nonce: 0 });
  const bets = [{ type: 'straight', value: mine, amountCents: 100 }, { type: 'red', amountCents: 200 }];
  const won = wouldHaveWon(bets, mine, STANDARD_MULTIPLIERS);
  assert.equal(won, 3600 + (didBetWin(bets[1], mine) ? 400 : 0));
  assert.equal(wouldHaveWon(bets, mine, null), null, 'no table known: no amount claimed');
  assert.equal(wouldHaveWon([], mine, STANDARD_MULTIPLIERS), null);
  assert.equal(wouldHaveWon([{ type: 'odd', amountCents: 100 }], 0, STANDARD_MULTIPLIERS), 0);
  assert.match(wouldHaveText(mine, won), new RegExp(`would have landed on ${mine} and won 36(\\.00)?|would have landed on ${mine} and won 40`));
  assert.equal(wouldHaveText(5, 0), 'Had it gone ahead, it would have landed on 5.');
  assert.equal(wouldHaveText(null, 0), '');

  const s = memoryStorage();
  addRefusedSpin({ lock: entry.serverSeedHash, pocket: mine, won, kind: 'other_device', reason: 'The lock was used by a spin this page did not make' }, s);
  const [logged] = readRefusedLog(s);
  assert.equal(logged.kind, 'other_device'); assert.equal(logged.pocket, mine); assert.equal(logged.won, won);
  assert.match(refusedSpinText(logged), new RegExp(`^Refused spin: would have been ${mine}, would have won `));
  assert.equal(refusedSpinText({ ...logged, won: 0 }), `Refused spin: would have been ${mine}`);
  addRefusedSpin({ lock: 'b'.repeat(64), pocket: 3, won: -5, kind: 'other_device', reason: '' }, s);
  assert.equal(readRefusedLog(s).length, 1, 'a negative amount is rejected');
});

test('R3-1: the app counts it, logs it, and warns when no other tab of the game was open', () => {
  const app = src('App.jsx');
  const fn = slice(app, 'const acceptOtherDeviceRound = async', 'const settleFoundRound = async');
  assert.match(fn, /pocketFor\(\{ serverSeed: round\.server_seed, clientSeed: `\$\{entry\.clientSeed\}:\$\{entry\.clientEntropy\}`, nonce: entry\.nonce/);
  assert.match(fn, /addRefusedSpin\(\{ lock: entry\.serverSeedHash, pocket, won, kind: 'other_device'/);
  assert.match(fn, /const alone = checkAlone && !otherTabRecently\(presenceRef\.current\?\.id \?\? null\);/);
  assert.match(fn, /recordRefusal\('unpredicted'\)/, 'always counted toward the strict limit');
  assert.match(fn, /alone \? OTHER_DEVICE_ALONE_MESSAGE : OTHER_DEVICE_MESSAGE/);
  assert.match(fn, /if \(!entry\.counted\) \{\s*const r = recordRefusal\('unpredicted'\);\s*if \(r\.reached\) \{ stopForVerification/);
  assert.ok(fn.indexOf('otherTabRecently') < fn.indexOf('adoptCurrentLock'), 'the alone check runs before the new lock is taken');
  assert.match(app, /useEffect\(\(\) => \{ const p = startPresence\(\); presenceRef\.current = p; return \(\) => p\.stop\(\); \}, \[\]\);/);
  const handler = slice(app, 'const handleRefusal = async', 'const spin = async');
  assert.match(handler, /if \(hit\) \{ await acceptOtherDeviceRound\(hit\.round, entry, request\.expected\.terms\); return; \}/);
  for (const m of [OTHER_DEVICE_MESSAGE, OTHER_DEVICE_ALONE_MESSAGE, OWN_ROUND_SWAPPED_MESSAGE]) assert.doesNotMatch(m, DASH, m);
  assert.match(OTHER_DEVICE_ALONE_MESSAGE, /contact support/); assert.match(OTHER_DEVICE_ALONE_MESSAGE, /safety limit/);
});

test('R3-1: tab heartbeat tells "another tab was open" apart from "only this tab"', () => {
  const s = memoryStorage(), t0 = 1_800_000_000_000;
  beat('me', t0, s);
  assert.equal(otherTabRecently('me', t0 + 1000, s), false, 'only this tab');
  beat('other', t0 + 2000, s);
  assert.equal(otherTabRecently('me', t0 + 3000, s), true);
  beat('other', t0 + 4000, s, true); // the other tab closed: it still counts for the window, it may have just spun
  assert.equal(otherTabRecently('me', t0 + 5000, s), true);
  assert.equal(otherTabRecently('me', t0 + 4000 + OTHER_TAB_WINDOW_MS + 1, s), false, 'ages out');
  s.setItem('betics:tabs:v2', '{bad'); assert.equal(otherTabRecently('me', t0, s), false);
  s.setItem('betics:tabs:v2', JSON.stringify({ x: { t: t0 + 10 * OTHER_TAB_WINDOW_MS } })); assert.equal(otherTabRecently('me', t0, s), false, 'future stamps ignored');
  // A reload of the same tab keeps its id (its entry was marked closed); a duplicated tab gets a new one.
  const ls = memoryStorage(), ss = memoryStorage();
  const id = tabIdFor(ss, ls); beat(id, t0, ls);
  const dup = tabIdFor(ss, ls);
  assert.notEqual(dup, id, 'the original is still open: a copied session is a new tab');
  ss.setItem('betics:tab-id:v1', id); beat(id, t0 + 1, ls, true);
  assert.equal(tabIdFor(ss, ls), id, 'reload of the same tab');
});

// ---- Finding 2: entropy swapped in after a reload; spin timeout ----
test('R3-2: an "own" round must use exactly the random value, lucky word and nonce this browser sent', async () => {
  const { serverSeed, entry } = lockAndEntry();
  const ent = randomBytes(32).toString('hex');
  const pocket = await pocketFor({ serverSeed, clientSeed: `lucky:${ent}`, nonce: 0 });
  const swapped = { server_seed: serverSeed, server_seed_hash: entry.serverSeedHash, client_seed: `lucky:${ent}`, client_seed_base: 'lucky',
    client_entropy: ent, nonce: 0, request_id: entry.requestId, outcome_json: JSON.stringify({ pocket }) };
  assert.equal(findRoundForLock([swapped], entry).own, true);
  assert.deepEqual(ownRoundProblems(swapped, entry), ['your random value was not used', 'random value changed']);
  const honest = { ...swapped, client_seed: `lucky:${entry.clientEntropy}`, client_entropy: entry.clientEntropy };
  assert.deepEqual(ownRoundProblems(honest, entry), []);
  assert.deepEqual(ownRoundProblems({ ...honest, nonce: 1 }, entry), ['spin number changed']);
  assert.deepEqual(ownRoundProblems({ ...honest, client_seed: `other:${entry.clientEntropy}` }, entry), ['your random value was not used']);
  assert.deepEqual(ownRoundProblems({ ...honest, request_id: randomUUID() }, entry), ['request changed']);
  assert.deepEqual(ownRoundProblems(null, entry), ['missing round']);
});

test('R3-2: after a reload, own rounds are checked for swapped inputs and against the saved pre-bet receipt', () => {
  const app = src('App.jsx');
  const fn = slice(app, 'const checkOpenLocks = async', 'const reloadCommitment = async');
  assert.match(fn, /const swapped = ownRoundProblems\(hit\.round, entry\);\s*if \(swapped\.length\) \{ stopForVerification\(/);
  assert.match(fn, /const receipt = readRoundReceipt\(entry\.requestId, hit\.round\.id\);/);
  assert.match(fn, /verifySettlement\(terms, settlementFromRound\(hit\.round\), didBetWin\)/);
  assert.match(fn, /if \(!paid\.ok\) \{ stopForVerification\(/);
  assert.ok(fn.indexOf('ownRoundProblems') < fn.indexOf('forgetOpenLock(entry.serverSeedHash)'), 'checked before the lock is forgotten');
  assert.match(fn, /if \(hit && !hit\.own\) \{\s*\/\/[^\n]*\n\s*if \(!\(await acceptOtherDeviceRound\(hit\.round, entry, null, \{ adopt: false, checkAlone: false \}\)\)\) return;/);
});

test('R3-2: a payout that differs from the saved receipt is caught for a history round', () => {
  const bets = [{ type: 'straight', value: 7, amountCents: 100 }];
  const terms = { bets, stake: 100, mode: 'real', mathId: 'standard', multipliers: STANDARD_MULTIPLIERS };
  const round = { real_money: 1, math_id: 'standard', stake_cents: 100, payout_cents: 0, outcome_json: JSON.stringify({ pocket: 7, betResults: [{ ...bets[0], payoutCents: 0 }] }) };
  const r = verifySettlement(terms, settlementFromRound(round), didBetWin);
  assert.equal(r.ok, false);
  assert.ok(r.problems.includes('bet 1 paid 0 instead of 3600'));
});

test('R3-2: the spin request times out after 30 s and is handled as a lost reply', async () => {
  assert.equal(SPIN_TIMEOUT_MS, 30000);
  let aborted = false;
  const hanging = (url, init) => new Promise((_, reject) => { init.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }); });
  const t = Date.now();
  const r = await postJsonWithTimeout('/api/games/roulette/spin', '{}', { fetchFn: hanging, ms: 30 });
  assert.equal(r.resp, null); assert.equal(r.timedOut, true); assert.equal(aborted, true);
  assert.ok(Date.now() - t < 1000);
  // A reply whose body never finishes also times out.
  const slowBody = async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) });
  assert.equal((await postJsonWithTimeout('/x', '{}', { fetchFn: slowBody, ms: 30 })).resp, null);
  const fine = async (url, init) => ({ ok: true, status: 200, json: async () => ({ echo: init.body, method: init.method }) });
  const ok = await postJsonWithTimeout('/x', '{"a":1}', { fetchFn: fine, ms: 1000 });
  assert.equal(ok.resp.status, 200); assert.deepEqual(ok.data, { echo: '{"a":1}', method: 'POST' });
  const refused = async () => ({ ok: false, status: 402, json: async () => { throw new Error('not json'); } });
  const rr = await postJsonWithTimeout('/x', '{}', { fetchFn: refused, ms: 1000 });
  assert.equal(rr.resp.status, 402); assert.equal(rr.data, null);
  assert.equal((await postJsonWithTimeout('/x', '{}', { fetchFn: async () => { throw new Error('offline'); }, ms: 1000 })).resp, null);
  const app = src('App.jsx');
  const spin = slice(app, 'const spin = async', 'spinRef.current = spin;');
  assert.match(spin, /const \{ resp, data \} = await postJsonWithTimeout\(`\$\{API\}\/games\/roulette\/spin`, bodyText\);\s*if \(!resp \|\| \(resp\.ok && !data\)\) \{[^}]*recoverLostReply/);
  assert.doesNotMatch(spin, /await fetch\(`\$\{API\}\/games\/roulette\/spin`/, 'no spin request without the timeout');
  assert.doesNotMatch(slice(app, 'const settleFoundRound = async', 'const recoverLostReply = async'), /await fetch\(/);
});

// ---- Finding 3: short credit ----
test('R3-3: a short credit is never re-synced away as "another device"', () => {
  const bets = [{ type: 'straight', value: 17, amountCents: 100 }];
  const terms = { bets, stake: 100, mode: 'real', mathId: null, multipliers: STANDARD_MULTIPLIERS, balanceBefore: 10000, balanceFresh: false };
  const data = { mode: 'real', pocket: 17, betResults: [{ type: 'straight', value: 17, amountCents: 100, payoutCents: 3600 }],
    totalStakeCents: 100, totalPayoutCents: 3600, balanceAfterCents: 12500 };
  const s = verifySettlement(terms, data, didBetWin);
  assert.deepEqual(s.problems, ['balance credited too little']);
  assert.equal(isBalanceResync({ terms, data, settlement: s, freshBalance: 12500 }), false, 'the PoC short credit is flagged');
  const big = { ...data, balanceAfterCents: 3700 };
  assert.equal(isBalanceResync({ terms, data: big, settlement: verifySettlement(terms, big, didBetWin), freshBalance: 3700 }), false);
  assert.equal(isBalanceResync({ terms, data, settlement: s, freshBalance: 13500 }), true, 'only when the wallet shows at least the right balance');
  assert.equal(isBalanceResync({ terms, data, settlement: s, freshBalance: 20000 }), true, 'a top up meanwhile is fine');
  assert.equal(isBalanceResync({ terms, data, settlement: s, freshBalance: 13499 }), false);
  const msg = shortCreditMessage(13500, 12500);
  assert.match(msg, /credited too little/); assert.match(msg, /Betting is stopped/); assert.doesNotMatch(msg, /another device/i);
  for (const m of [msg, BALANCE_RESYNC_MESSAGE]) assert.doesNotMatch(m, DASH, m);
  const app = src('App.jsx');
  const fn = slice(app, 'const processSpinReply = async', 'const acceptOtherDeviceRound = async');
  assert.doesNotMatch(fn, /setNotice\([^)]*another device/, 'never blames another device');
  assert.doesNotMatch(src('spinRefusal.js'), /balance changed on another device/i);
  assert.match(fn, /stopForVerification\(verification\.shortCredit \|\|/);
  assert.match(fn, /data = \{ \.\.\.data, balanceAfterCents: fresh \};/, 'the balance shown is the one read again');
});

// ---- Finding 4: the server alone does not decide a refusal was expected ----
test('R3-4: "predicted" refusals the page\'s own figures contradict count as unexpected', () => {
  const known = { balance: 10000, stake: 500, worstPayout: 18000, minStake: 100, maxStake: 100000, maxWin: 5000000, tableLimit: 1000000 };
  assert.equal(checkRefusalAgainstKnown('predicted', 402, 'insufficient balance', known), 'unpredicted', 'balance covers the stake');
  assert.equal(checkRefusalAgainstKnown('predicted', 402, 'insufficient balance', { ...known, balance: 400 }), 'predicted');
  assert.equal(checkRefusalAgainstKnown('predicted', 402, 'insufficient balance', { ...known, balance: null }), 'predicted', 'unknown balance: trust the reason');
  assert.equal(checkRefusalAgainstKnown('predicted', 400, 'The total bet must be at least 1.00 $TICS.', known), 'unpredicted');
  assert.equal(checkRefusalAgainstKnown('predicted', 400, 'The total bet must be at least 10.00 $TICS.', { ...known, minStake: 1000 }), 'predicted');
  assert.equal(checkRefusalAgainstKnown('predicted', 400, 'The total bet can be at most 1,000.00 $TICS.', known), 'unpredicted');
  assert.equal(checkRefusalAgainstKnown('predicted', 400, 'The total bet can be at most 1.00 $TICS.', { ...known, maxStake: 100 }), 'predicted');
  assert.equal(checkRefusalAgainstKnown('predicted', 400, 'These bets could win more than 50,000.00 $TICS', known), 'unpredicted');
  assert.equal(checkRefusalAgainstKnown('predicted', 400, 'These bets could win more than 50 $TICS', { ...known, maxWin: 5000 }), 'predicted');
  assert.equal(checkRefusalAgainstKnown('predicted', 503, 'The most you can bet on one number right now is 100 $TICS.', known), 'predicted', 'the table limit moves with other players, so the page figure is never proof');
  assert.equal(checkRefusalAgainstKnown('predicted', 503, 'The most you can bet on one number right now is 1 $TICS.', { ...known, tableLimit: 3600 }), 'predicted');
  assert.equal(checkRefusalAgainstKnown('predicted', 503, 'The most you can bet on one number right now is 1 $TICS.', { ...known, tableLimit: null }), 'predicted', 'limit not known yet');
  assert.equal(checkRefusalAgainstKnown('predicted', 503, 'Several big bets are being played at this moment.', known), 'predicted', 'the page cannot check this one');
  assert.equal(checkRefusalAgainstKnown('predicted', 403, 'Demo is not available while you have real funds.', known), 'predicted');
  assert.equal(checkRefusalAgainstKnown('transient', 429, '', known), 'transient', 'busy refusals are left alone');
  assert.equal(budgetFor('transient'), 'predicted', 'transient refusals still count, in the larger budget');
  assert.equal(PREDICTED_LIMIT, 10);
  const m = refusalRetiredMessage('insufficient balance', { checked: true, wouldHave: wouldHaveText(17, 3600) });
  assert.match(m, /This page checked your balance and the limits, and they allowed this bet/);
  assert.match(m, /would have landed on 17 and won 36 \$TICS\./);
  assert.doesNotMatch(m, DASH);
});

test('R3-4: the app checks refusals against its own figures and shows the would-have win', () => {
  const app = src('App.jsx');
  const spin = slice(app, 'const spin = async', 'spinRef.current = spin;');
  assert.match(spin, /const kind = checkRefusalAgainstKnown\(first, resp\.status, reason, known\);/);
  assert.match(spin, /if \(first === 'predicted' && resp\.status === 402 && !balanceFresh\) \{\s*try \{ known\.balance = modeBalance\(await walletApi\.wallet\(\), mode\);/, 'a stale balance is read again before calling a 402 unexpected');
  const handler = slice(app, 'const handleRefusal = async', 'const spin = async');
  assert.match(handler, /setError\(refusalRetiredMessage\(reason, \{ checked, wouldHave \}\)\);/);
  assert.match(handler, /kind === 'transient'\) \{ setError\([^\n]*\$\{wouldHave \?/);
  assert.match(handler, /kind === 'predicted'\) \{[\s\S]*?\$\{wouldHave \?/);
  const open = slice(app, 'const openAndLog = async', 'const adoptCurrentLock = async');
  assert.match(open, /addRefusedSpin\(\{ lock: entry\.serverSeedHash, pocket, won, kind, reason \}\);/);
  // Transient refusals are now kept in the log too.
  const s = memoryStorage();
  addRefusedSpin({ lock: 'c'.repeat(64), pocket: 9, won: 0, kind: 'transient', reason: 'internal error' }, s);
  assert.equal(readRefusedLog(s).length, 1);
});

// ---- Findings 5 to 7: wording and pinned wallet ----
test('R3-5: How it works says a lower table is shown first and the stop promise is backed by the checks', () => {
  const how = src('HowItWorks.jsx');
  assert.match(how, /pays 35 to 1, so you get back 36 times your stake\. If the casino ever uses a table that pays less, the game shows you that table first and you play only after you accept it\./);
  assert.match(how, /If anything does not match, the game stops and tells you\./);
  const text = how.replace(/<[^>]+>/g, ' ');
  for (const line of text.split('\n').filter((l) => /^\s*[A-Z][a-z].*[.]\s*$/.test(l))) assert.doesNotMatch(line, /[\u2013\u2014]/, line);
});

test('R3-6: the Etherscan link uses the pinned wallet and "covered" needs the pinned wallet', () => {
  assert.equal(PINNED_WALLET_URL, etherscanAddress(CHAIN_ID, CASINO_WALLET));
  assert.equal(etherscanAddress(1, '0xabc'), 'https://etherscan.io/address/0xabc');
  assert.equal(etherscanAddress(11155111, '0xabc'), 'https://sepolia.etherscan.io/address/0xabc');
  assert.equal(reserveWalletMatches({ wallet: CASINO_WALLET.toUpperCase().replace('0X', '0x'), chainId: CHAIN_ID }), true);
  assert.equal(reserveWalletMatches({ wallet: '0x1111111111111111111111111111111111111111', chainId: CHAIN_ID }), false);
  assert.equal(reserveWalletMatches({ wallet: CASINO_WALLET, chainId: 56 }), false);
  assert.equal(reserveWalletMatches({ wallet: null, chainId: CHAIN_ID }), false);
  assert.equal(reserveWalletMatches(null), false);
  for (const f of ['CasinoReserve.jsx', 'HowItWorks.jsx']) {
    const code = src(f);
    assert.doesNotMatch(code, /etherscanAddress\(r\.chainId, r\.wallet\)/, `${f}: no server-chosen link`);
    assert.match(code, /href=\{PINNED_WALLET_URL\}/, f);
    assert.match(code, /reserveWalletMatches\(r\)/, f);
  }
  assert.match(src('CasinoReserve.jsx'), /const ok = r\.covered && pinned;/);
  assert.match(src('CasinoReserve.jsx'), /!pinned \? 'Wallet not confirmed'/);
  assert.match(src('HowItWorks.jsx'), /!pinned \? 'Wallet not confirmed'/);
});

test('R3-7: the held row only says "on its way" when no withdrawal is under review or being cancelled', () => {
  assert.deepEqual(heldRowText([{ status: 'queued' }, { status: 'sending' }]), { title: 'Being withdrawn', note: 'On its way to your wallet' });
  assert.deepEqual(heldRowText([]), { title: 'Being withdrawn', note: 'On its way to your wallet' });
  for (const status of ['blocked', 'cancelling']) {
    const t = heldRowText([{ status: 'queued' }, { status }]);
    assert.equal(t.title, 'Held for a withdrawal', status);
    assert.doesNotMatch(t.note, /on its way/i);
    assert.doesNotMatch(`${t.title} ${t.note}`, DASH);
  }
  assert.deepEqual(heldRowText(null), { title: 'Being withdrawn', note: 'On its way to your wallet' });
  const panel = src('WalletPanel.jsx');
  assert.match(panel, /const held = heldRowText\(profile\.withdrawals\);/);
  assert.match(panel, /<dt>\{held\.title\}<small>\{held\.note\}<\/small><\/dt>/);
  assert.doesNotMatch(panel, /<dt>Being withdrawn<small>On its way to your wallet<\/small>/);
});

test('R4: a lock used elsewhere while this page sat idle is picked up on focus without counting, only when the old key opens it', () => {
  const app = src('App.jsx');
  const fn = slice(app, 'const syncIdleLock = async () => {', 'const syncIdleLockRef = useRef(null);');
  assert.match(fn, /if \(!cur \|\| findOpenLock\(cur\.serverSeedHash, user\.identity \|\| 'guest'\)\) return;/, 'never while a spin of ours is open on it');
  assert.match(fn, /busyRef\.current \|\| operationRef\.current \|\| verificationBlockedRef\.current/);
  assert.match(fn, /verifyRevealedRound\(round\)\)\.ok\) return;/, 'the old key must open the old lock');
  assert.doesNotMatch(fn, /recordRefusal/, 'nothing of ours was exposed, so nothing is counted');
  assert.match(fn, /adoptCurrentLock\(cur\.serverSeedHash\)/);
  assert.match(app, /const onFocus = \(\) => \{ loadGameConfig\(\); syncIdleLockRef\.current\?\.\(\)\.catch\(\(\) => \{\}\); \};/);
});
