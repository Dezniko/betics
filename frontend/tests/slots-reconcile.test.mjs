// Re-audit fixes, round 2: open locks carry their game so a slot entry never blocks roulette (and the other
// way round); the slot page reconciles its saved locks with the round history on load like roulette; a 409
// other_tab is believed only on PLAY signals (announcement, play stamp, or this tab's own switch of game);
// the house loss cap is public and greys out the bet levels it would refuse.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { playRound, maxPayoutUnits } from '../../backend/src/games/slots.js';
import { SLOT_MATH, BET_LEVELS } from '../../backend/src/games/slotsMath.js';
import { makeUint32At } from '../../backend/src/core/slotDraws.js';
import { rememberOpenLock, readOpenLocks, findOpenLock, locksToCheck, findRoundForLock, ownRoundProblems, roundGame, canAcceptReloadedLock, mustRetireLock,
  otherTabSeenRecently, noteSpinPosted, readLastSpin, ownSpinSwitchedGame, classifySpinRefusal, budgetFor, OPEN_LOCK_GRACE_MS, OTHER_TAB_SEEN_WINDOW_MS, OTHER_TAB_GRACE_MS,
  GAMES, DEFAULT_GAME, retireWaitMs, LOCK_IN_FLIGHT_MESSAGE, LOCK_RECHECK_MESSAGE, LOST_REPLY_RECHECK_MESSAGE, STALE_LOCK_RECHECK_MESSAGE, LOCK_CHANGED_MESSAGE, LOCK_CHECK_GAVE_UP_MESSAGE } from '../src/spinRefusal.js';
import { beat, notePlay, otherTabRecently, otherTabPlayedRecently, tabIdFor } from '../src/tabPresence.js';
import { verifyRevealedRound } from '../src/fairnessClient.js';
import { createSlotRequest, betLevelStates, HOUSE_LOSS_LIMIT_MESSAGE } from '../src/slots/slotsApi.js';
import { checkSlotHistoryRound, slotRoundFromRow, withoutSlotBalance } from '../src/slots/slotHistory.js';
import { PAGE_COPY } from '../src/slots/slotCopy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => fs.readFileSync(path.join(here, '..', 'src', f), 'utf8');
const slice = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null }; };
const H = (c) => c.repeat(64), E = (c) => c.repeat(64), UUID = '00000000-0000-4000-8000-000000000001';
const lockEntry = (over = {}) => ({ identity: 'guest', serverSeedHash: H('a'), clientSeed: 'lucky', nonce: 0, clientEntropy: E('e'), requestId: UUID, ...over });

// A real slot round in the /api/rounds row shape, with the receipt the browser saved before the bet.
function slotRow({ stake = 2000, before = 100000 } = {}) {
  const seed = 'seed-' + crypto.randomBytes(8).toString('hex');
  const commitment = { serverSeedHash: sha(seed), clientSeed: 'lucky', nonce: 0 };
  const { receipt, body } = createSlotRequest(commitment, stake, 'demo', { revealed: [], balanceBefore: before });
  const clientSeed = `lucky:${body.clientEntropy}`;
  const round = playRound({ stake, math: SLOT_MATH, uint32At: makeUint32At(seed, clientSeed, 0) });
  const row = { id: 42, game: 'godsofpower', stake_cents: stake, payout_cents: round.totalPayoutUnits, server_seed: seed, server_seed_hash: sha(seed), client_seed: clientSeed, client_seed_base: 'lucky', client_entropy: body.clientEntropy, nonce: 0, request_id: receipt.requestId, real_money: 0, math_id: SLOT_MATH.id, created_at: '2026-11-06 10:00:00',
    outcome_json: JSON.stringify({ game: 'godsofpower', spins: round.spins, freeSpinsAwarded: round.freeSpinsAwarded, freeSpinsPlayed: round.freeSpinsPlayed, capped: round.capped }) };
  const entry = { identity: 'guest', game: 'godsofpower', serverSeedHash: sha(seed), clientSeed: 'lucky', nonce: 0, clientEntropy: body.clientEntropy, requestId: receipt.requestId };
  return { row, receipt, entry, round };
}

// ---- 2. game-tagged open locks ----
test('open-lock entries carry their game; untagged legacy entries read as roulette; filters keep the games apart', () => {
  assert.deepEqual([...GAMES].sort(), ['godsofpower', 'roulette']); assert.equal(DEFAULT_GAME, 'roulette');
  const s = mem();
  const r = rememberOpenLock(lockEntry(), s);
  assert.equal(r.game, 'roulette', 'an untagged entry is roulette (the only game before tags)');
  const g = rememberOpenLock(lockEntry({ serverSeedHash: H('b'), game: 'godsofpower' }), s);
  assert.equal(g.game, 'godsofpower');
  assert.throws(() => rememberOpenLock(lockEntry({ serverSeedHash: H('c'), game: 'poker' }), s), 'an unknown game is refused');
  // A legacy entry written before tags existed (no game field at all) still validates and reads as roulette.
  s.setItem('betics:open-locks:v1', JSON.stringify([{ ...lockEntry({ serverSeedHash: H('d') }), at: 1, refused: false, counted: false }, { ...g }]));
  const all = readOpenLocks(s);
  assert.deepEqual(all.map((x) => x.game), ['roulette', 'godsofpower']);
  const later = Date.now() + OPEN_LOCK_GRACE_MS + 1000;
  assert.equal(locksToCheck('guest', H('z'), later, s).length, 2, 'no filter: every entry');
  assert.deepEqual(locksToCheck('guest', H('z'), later, s, { game: 'roulette' }).map((x) => x.serverSeedHash), [H('d')]);
  assert.deepEqual(locksToCheck('guest', H('z'), later, s, { game: 'godsofpower' }).map((x) => x.serverSeedHash), [H('b')]);
  assert.equal(findOpenLock(H('b'), 'guest', s)?.game, 'godsofpower', 'no game filter: found whichever game sent it (one lock per player)');
  assert.equal(findOpenLock(H('b'), 'guest', s, 'roulette'), null);
  assert.equal(findOpenLock(H('b'), 'guest', s, 'godsofpower')?.serverSeedHash, H('b'));
  assert.equal(roundGame({ game: 'godsofpower' }), 'godsofpower'); assert.equal(roundGame({ game_id: 'godsofpower' }), 'godsofpower');
  assert.equal(roundGame({ game: 'roulette' }), 'roulette'); assert.equal(roundGame({}), 'roulette'); assert.equal(roundGame(null), 'roulette');
});

test('REGRESSION: a godsofpower open lock in storage never reaches the roulette page check, and a slot round found by it is never judged with the pocket verifier', async () => {
  const { row, entry } = slotRow();
  const s = mem();
  rememberOpenLock(entry, s);
  const later = Date.now() + OPEN_LOCK_GRACE_MS + 1000;
  // The roulette page asks only for its own entries.
  assert.deepEqual(locksToCheck('guest', H('c'), later, s, { game: 'roulette' }), [], 'the slot entry is not roulette\'s to check');
  const app = src('App.jsx');
  const check = slice(app, 'const checkOpenLocks = async', 'const reloadCommitment = async');
  assert.match(check, /locksToCheck\(identity, currentHash, Date\.now\(\), undefined, \{ game: 'roulette' \}\)/, 'App.jsx filters by game');
  // And would the honest slot round have blocked roulette? Yes with the pocket verifier, which is why it is never applied to it.
  const v = await verifyRevealedRound(row);
  assert.equal(v.ok, false, 'the roulette verifier cannot judge a slot round (no pocket)');
  assert.match(check, /if \(roundGame\(hit\.round\) !== 'roulette'\) \{[\s\S]*?forgetOpenLock\(entry\.serverSeedHash\);\s*continue;/, 'a legacy untagged entry whose round is the slot\'s is cleared, not failed');
  assert.ok(check.indexOf("roundGame(hit.round) !== 'roulette'") < check.indexOf('await verifyRevealedRound(hit.round)'), 'the game check comes before the pocket verifier');
  const other = slice(app, 'const acceptOtherDeviceRound = async', 'const settleFoundRound = async');
  assert.match(other, /roundGame\(round\) === 'roulette' \? await verifyRevealedRound\(round\)/, 'another device\'s slot round on the lock is checked by its key only');
  assert.equal(ownRoundProblems(row, entry).length, 0);
  assert.ok(findRoundForLock([row], entry)?.own);
});

test('mirror: a roulette open lock never reaches the slot page check; the slot verifies its own found round with the slot checker', async () => {
  const s = mem();
  rememberOpenLock(lockEntry({ game: 'roulette' }), s);
  const later = Date.now() + OPEN_LOCK_GRACE_MS + 1000;
  assert.deepEqual(locksToCheck('guest', H('c'), later, s, { game: 'godsofpower' }), []);
  const slot = src('slots/SlotsApp.jsx');
  const check = slice(slot, 'const checkOpenLocks = async', 'checkOpenLocksRef.current = checkOpenLocks;');
  assert.match(check, /locksToCheck\(identity\(\), currentHash, Date\.now\(\), undefined, \{ game: 'godsofpower', tab: session\.tabId \|\| null \}\)/);
  const settle = slice(slot, 'const settleOpenLock = async', 'const checkOpenLocks = async');
  assert.match(settle, /const round = slotRoundFromRow\(hit\.round\);/);
  assert.match(settle, /await checkSlotHistoryRound\(round\)/, 'own slot rounds go through the slot history check (receipt without the balance)');
  assert.match(settle, /await verifyRevealedRound\(hit\.round\)/, 'a non-slot round on a slot entry falls back to the key check of roulette');
  // The slot checker on a real round, with the receipt saved before the bet (balance left out as the history has none).
  const { row, receipt } = slotRow();
  const read = (id) => (id === receipt.requestId ? receipt : null);
  const ok = await checkSlotHistoryRound(slotRoundFromRow(row), { read });
  assert.equal(ok.ok, true, ok.problems.join('; ')); assert.equal(ok.receipt, true);
  assert.equal('balanceBefore' in withoutSlotBalance(receipt), false);
  const tampered = { ...row, payout_cents: row.payout_cents + 1 };
  assert.equal((await checkSlotHistoryRound(slotRoundFromRow(tampered), { read })).ok, false);
  const stake = JSON.parse(JSON.stringify(row)); stake.stake_cents = 4000;
  assert.equal((await checkSlotHistoryRound(slotRoundFromRow(stake), { read })).ok, false, 'a stake that differs from the receipt fails');
});

// ---- 1. slot page: mount-time reconciliation and automatic recovery ----
test('SlotsApp loads the lock like roulette reloadCommitment: a saved lock that must retire is revealed BEFORE it is accepted, a changed lock needs the old key shown, open locks are reconciled on mount', () => {
  const slot = src('slots/SlotsApp.jsx');
  const load = slice(slot, 'const loadCommitment = async', 'const RECOVER_DELAYS_MS');
  assert.match(load, /if \(!canAcceptReloadedLock\(c, previousHash\)\)/, 'canAcceptReloadedLock semantics');
  assert.match(load, /const prev = findOpenLock\(previousHash, identity\(\)\);\s*const result = prev \? await settleOpenLock\(prev\) : 'missing';/, 'a different lock is only taken when the old key was shown in a settled round');
  assert.match(load, /if \(result !== 'settled' && result !== 'other'\) throw new Error\(LOCK_CHANGED_MESSAGE\);/);
  assert.match(load, /const open = findOpenLock\(c\.serverSeedHash, identity\(\)\);\s*if \(open && !mustRetireLock\(open, Date\.now\(\), session\.tabId \|\| null\)\) \{/, 'a fresh entry of ANOTHER tab is never accepted as it is: a timed wait instead');
  assert.match(load, /wait\.retryInMs = retireWaitMs\(open, Date\.now\(\), session\.tabId \|\| null\); throw wait;/);
  assert.match(load, /if \(open\) \{\s*const swap = await openAndLog\(open, 'lost'/, 'every other saved entry for the current lock is retired through the reveal first');
  assert.match(load, /await openAndLog\(open, 'lost', open\.refused \? 'Refused before this page was reloaded' : 'The page closed before the reply',\s*readSlotReceipt\(open\.requestId\)\?\.stake \?\? null, \{ serverSeedHash: c\.serverSeedHash, clientSeed: c\.clientSeed, nonce: c\.nonce \}\)/, 'retired through the reveal with the server\'s current form of the lock');
  assert.ok(load.indexOf('await openAndLog(open') < load.indexOf('setCommitment(swap.commitment)'), 'the reveal happens before the lock is accepted');
  assert.match(load, /if \(!swap\.ok\) throw new Error\(LOCK_RECHECK_MESSAGE\);/, 'a failed reveal never lets the saved lock through');
  assert.match(load, /if \(!open\.counted\) \{\s*const counted = recordRefusal\('unpredicted'\);/, 'counted once');
  const check = slice(slot, 'const checkOpenLocks = async', 'checkOpenLocksRef.current = checkOpenLocks;');
  assert.match(check, /addRefusedSlotSpin\(\{ lock: entry\.serverSeedHash, stops: null, kind: 'never_opened', reason: 'The server never showed this key' \}\)/);
  assert.match(check, /if \(!entry\.counted\) \{\s*const r = recordRefusal\('unpredicted'\);/);
  assert.match(check, /setNotice\(NEVER_OPENED_MESSAGE\)/);
  const settle = slice(slot, 'const settleOpenLock = async', 'const checkOpenLocks = async');
  assert.match(settle, /if \(!hit\.own\) return \(await acceptOtherDeviceRound\(hit, entry, readSlotReceipt\(entry\.requestId\)\?\.stake \?\? null, \{ adopt: false, checkAlone: false \}\)\)/);
  assert.match(settle, /ownRoundProblems\(hit\.round, entry\)/);
  // Mount: recoverLock (load + reconcile), the grace re-check, and a focus retry while no lock is held.
  const mount = slice(slot, 'const recoverRef = useRef(null);', 'useEffect(() => { if (session.sessionError)');
  assert.match(mount, /loadConfig\(\); recoverRef\.current\?\.\(\);/);
  assert.match(mount, /setTimeout\(\(\) => \{ if \(!busyRef\.current && commitmentRef\.current\) checkOpenLocksRef\.current\?\.\(commitmentRef\.current\.serverSeedHash\)/);
  assert.match(mount, /OPEN_LOCK_GRACE_MS \+ 1000/);
  assert.match(mount, /const onFocus = \(\) => \{ loadConfig\(\); if \(!commitmentRef\.current && !blockedRef\.current && !busyRef\.current\) recoverRef\.current\?\.\(pendingHashRef\.current\); \};/);
  const recover = slice(slot, 'const RECOVER_DELAYS_MS', 'recoverRef.current = recoverLock;');
  assert.match(recover, /const hash = await loadCommitment\(previousHash\);[\s\S]*await checkOpenLocks\(hash\);/, 'reconcile after every successful load');
  assert.match(recover, /if \(attempt < RECOVER_DELAYS_MS\.length\)/, 'spaced retries');
  assert.ok(!/stopForVerification/.test(recover), 'a failed request never blocks on its own; only checks and budgets do');
  // The lock is loaded in the spin's own flow via the ref too (identity change re-runs the effect).
  assert.match(slot, /\}, \[session\.identity, loadConfig\]\);/);
});

test('the slot page has no "reload the page" dead end left outside a fairness stop: every former one recovers on its own', () => {
  const slot = src('slots/SlotsApp.jsx');
  for (const gone of ['LOST_REPLY_PAUSED_MESSAGE', 'STALE_LOCK_MESSAGE', 'REFUSAL_NO_LOCK_MESSAGE']) assert.ok(!slot.includes(gone), `${gone} is gone from the slot page`);
  const lost = slice(slot, 'const recoverLostReply = async', 'const handleRefusal = async');
  assert.match(lost, /updateOpenLock\(entry\.serverSeedHash, \{ refused: true \}\);\s*setNotice\(LOST_REPLY_RECHECK_MESSAGE\); recoverLock\(entry\.serverSeedHash\); return;/, 'lost reply, reveal failed: marked refused so the recovery retires it, then recovery');
  const handler = slice(slot, 'const handleRefusal = async', 'const processReply = async');
  assert.match(handler, /setError\(STALE_LOCK_RECHECK_MESSAGE\); lockErrorRef\.current = true; recoverLock\(entry\.serverSeedHash\);/, 'stale lock without a round: recovery looks for it');
  assert.match(handler, /\$\{LOCK_RECHECK_MESSAGE\}`\); lockErrorRef\.current = true; recoverLock\(entry\.serverSeedHash\); return; \}/, 'refusal whose reveal failed: recovery');
  for (const m of [LOCK_RECHECK_MESSAGE, LOST_REPLY_RECHECK_MESSAGE, STALE_LOCK_RECHECK_MESSAGE, LOCK_CHANGED_MESSAGE, LOCK_CHECK_GAVE_UP_MESSAGE, PAGE_COPY.noLock]) {
    assert.ok(!/reload/i.test(m), `no reload wording: ${m}`);
    assert.ok(!/[\u2013\u2014]|\p{Extended_Pictographic}/u.test(m), 'no dashes or emoji');
  }
  // canAcceptReloadedLock: the same lock back is fine, another lock is not, no previous lock means anything valid.
  assert.equal(canAcceptReloadedLock({ serverSeedHash: H('a') }, H('a')), true);
  assert.equal(canAcceptReloadedLock({ serverSeedHash: H('b') }, H('a')), false);
  assert.equal(canAcceptReloadedLock({ serverSeedHash: H('b') }, null), true);
  assert.equal(mustRetireLock({ refused: true, at: Date.now() }), true);
  // The tab that sent the random value retires its own fresh entry at once after a reload (nothing else waits for it);
  // another tab's fresh entry waits out the grace.
  const t0 = 1_000_000, mine = { ...lockEntry({ tab: 'tab-1' }), at: t0, refused: false, counted: false };
  assert.equal(mustRetireLock(mine, t0 + 1000), false, 'no tab known: within the grace');
  assert.equal(mustRetireLock(mine, t0 + 1000, 'tab-1'), true, 'own tab: at once');
  assert.equal(mustRetireLock(mine, t0 + 1000, 'tab-2'), false, 'another tab: wait');
  assert.equal(retireWaitMs(mine, t0 + 1000, 'tab-1'), 0);
  assert.equal(retireWaitMs(mine, t0 + 1000, 'tab-2'), OPEN_LOCK_GRACE_MS - 1000 + 500);
  assert.equal(retireWaitMs(mine, t0 + OPEN_LOCK_GRACE_MS + 1, 'tab-2'), 0);
  const s = mem(); rememberOpenLock({ ...lockEntry({ tab: 'tab-1', game: 'godsofpower' }), at: t0 }, s);
  assert.equal(locksToCheck('guest', H('z'), t0 + 1000, s, { game: 'godsofpower' }).length, 0, 'fresh: left alone');
  assert.equal(locksToCheck('guest', H('z'), t0 + 1000, s, { game: 'godsofpower', tab: 'tab-1' }).length, 1, 'own tab: checked now');
  assert.equal(locksToCheck('guest', H('z'), t0 + 1000, s, { game: 'godsofpower', tab: 'tab-2' }).length, 0);
  assert.throws(() => rememberOpenLock(lockEntry({ tab: 'x'.repeat(65) }), mem()));
  assert.match(src('slots/SlotsApp.jsx'), /game: 'godsofpower', \.\.\.\(session\.tabId \? \{ tab: session\.tabId \} : \{\}\) \}\);/, 'the slot saves its tab id with the entry');
  const recover = slice(src('slots/SlotsApp.jsx'), 'const RECOVER_DELAYS_MS', 'recoverRef.current = recoverLock;');
  assert.match(recover, /if \(Number\.isFinite\(e\.retryInMs\)\)/, 'the timed wait is not one of the retries');
  assert.ok(!/reload/i.test(LOCK_IN_FLIGHT_MESSAGE));
});

// ---- 3. other tab: play signals only, same-tab game switch predicted ----
test('an idle second tab (heartbeat only) is NOT a seen tab; a tab that posted a spin is; the liveness beat never writes or erases the play stamp', () => {
  const s = mem(); const now = 1_000_000;
  beat('me', now - 1000, s); beat('idle-other', now - 3000, s);
  assert.equal(otherTabRecently('me', now, s, 10_000), true, 'the liveness heartbeat still says a tab exists (used for the "alone" wording)');
  assert.equal(otherTabPlayedRecently('me', now, s, 10_000), false, 'but it never played: no play signal');
  const seen = otherTabSeenRecently({ lastForeignAt: null, otherTabRecently: (n, w) => otherTabPlayedRecently('me', n, s, w), now });
  assert.equal(seen, false, 'a merely open other tab does not explain a 409 other_tab');
  assert.equal(classifySpinRefusal(409, '', 'other_tab', { otherTabSeen: seen }), 'other_tab_unseen');
  assert.equal(budgetFor('other_tab_unseen'), 'unpredicted', 'counted in the strict budget');
  // The other tab posts a spin: its play stamp makes it seen for the window plus grace.
  notePlay('idle-other', now - 2000, s);
  assert.equal(otherTabPlayedRecently('me', now, s, 10_000), true);
  assert.equal(otherTabSeenRecently({ otherTabRecently: (n, w) => otherTabPlayedRecently('me', n, s, w), now }), true);
  assert.equal(classifySpinRefusal(409, '', 'other_tab', { otherTabSeen: true }), 'other_tab');
  assert.equal(otherTabPlayedRecently('me', now + OTHER_TAB_SEEN_WINDOW_MS + OTHER_TAB_GRACE_MS + 1, s, OTHER_TAB_SEEN_WINDOW_MS + OTHER_TAB_GRACE_MS), false, 'ages out after 10 s');
  // Later liveness beats of the other tab keep its play stamp; the beat of this tab never adds one.
  beat('idle-other', now + 500, s); beat('me', now + 500, s);
  const m = JSON.parse(s.getItem('betics:tabs:v2'));
  assert.equal(m['idle-other'].p, now - 2000); assert.equal('p' in m.me, false);
  // The page's own play stamp never counts as another tab, even with a null id for the other entries.
  const s2 = mem(); notePlay('me', now, s2);
  assert.equal(otherTabPlayedRecently('me', now, s2, 10_000), false);
  assert.equal(otherTabPlayedRecently(null, now, s2, 10_000), true, 'with no id of its own every stamped tab is another tab (roulette before presence starts)');
  // Future stamps (wrong clock) are ignored; broken storage never counts as seen.
  const s3 = mem(); s3.setItem('betics:tabs:v2', JSON.stringify({ x: { t: now, p: now + 120_000 } }));
  assert.equal(otherTabPlayedRecently('me', now, s3, 10_000), false);
  assert.equal(otherTabSeenRecently({ otherTabRecently: () => { throw new Error('no storage'); }, now }), false);
  // An announcement on the channel is still a play signal.
  assert.equal(otherTabSeenRecently({ lastForeignAt: now - 9000, now }), true);
});

test('same tab, slot then roulette within 8 s: the tab\'s own previous spin on the other game predicts the 409, the same game again does not', () => {
  const session = mem(), local = mem();
  let now = 1_000_000;
  const tab = tabIdFor(session, local); beat(tab, now, local);
  // The slot page posts a spin: previous record is none.
  assert.equal(noteSpinPosted('godsofpower', now, session), null);
  assert.deepEqual(readLastSpin(session), { at: now, game: 'godsofpower' });
  now += 3000; beat(tab, now, local, true); // pagehide: the tab navigates to roulette
  now += 2000; assert.equal(tabIdFor(session, local), tab, 'the same tab keeps its id across the navigation');
  beat(tab, now, local);
  // Roulette posts a spin 5 s after the slot's: the server will answer 409 other_tab (game changed, same tab).
  const ownSpin = noteSpinPosted('roulette', now, session);
  assert.deepEqual(ownSpin, { at: now - 5000, game: 'godsofpower' }, 'the previous record, not the spin being posted');
  const seen = otherTabSeenRecently({ lastForeignAt: null, ownSpin, game: 'roulette', otherTabRecently: (n, w) => otherTabPlayedRecently(tab, n, local, w), now: now + 1000 });
  assert.equal(seen, true, 'predicted: this tab switched games inside the window');
  assert.equal(classifySpinRefusal(409, '', 'other_tab', { otherTabSeen: seen }), 'other_tab', 'lock kept, nothing counted');
  assert.equal(budgetFor('other_tab'), null);
  // The same game again inside the window is NOT an explanation: the server never refuses that, so a dishonest
  // server cannot drop every quick follow-up spin for free.
  const sameGame = otherTabSeenRecently({ ownSpin: { at: now - 2000, game: 'roulette' }, game: 'roulette', now });
  assert.equal(sameGame, false);
  assert.equal(ownSpinSwitchedGame({ at: now - 2000, game: 'roulette' }, 'roulette', now), false);
  assert.equal(ownSpinSwitchedGame({ at: now - 10_001, game: 'godsofpower' }, 'roulette', now), false, 'older than 8 s plus 2 s grace: not predicted');
  assert.equal(ownSpinSwitchedGame({ at: now - 10_000, game: 'godsofpower' }, 'roulette', now), true, 'inside the window plus grace');
  assert.equal(ownSpinSwitchedGame({ at: now + 120_000, game: 'godsofpower' }, 'roulette', now), false, 'a future stamp is ignored');
  assert.equal(ownSpinSwitchedGame({ at: now, game: 'poker' }, 'roulette', now), false);
  assert.equal(ownSpinSwitchedGame(null, 'roulette', now), false);
  // Without `game` the own-spin rule is off (callers that pass nothing keep the old behaviour).
  assert.equal(otherTabSeenRecently({ ownSpin: { at: now - 1000, game: 'godsofpower' }, now }), false);
  // Broken session data reads as nothing.
  const bad = mem(); bad.setItem('betics:last-spin-at', '{nope'); assert.equal(readLastSpin(bad), null);
  bad.setItem('betics:last-spin-at', JSON.stringify({ at: 'x', game: 'roulette' })); assert.equal(readLastSpin(bad), null);
  assert.equal(noteSpinPosted('poker', now, bad), null); assert.equal(readLastSpin(bad), null, 'an unknown game is not recorded');
  // Both pages stamp the play before the post, after the open lock is saved.
  for (const [f, game, id] of [['slots/SlotsApp.jsx', 'godsofpower', 'session.tabId'], ['App.jsx', 'roulette', 'presenceRef.current?.id ?? null']]) {
    const text = src(f);
    const i = text.indexOf(`notePlay(${id});`), j = text.indexOf(`noteSpinPosted('${game}')`), k = text.lastIndexOf('postJsonWithTimeout(`${' + (game === 'roulette' ? 'API}/games/roulette' : 'SLOT_API}') + '/spin`, bodyText)');
    assert.ok(i > 0 && j > i && k > j, `${f}: play stamps come right before the post`);
    assert.ok(text.indexOf('rememberOpenLock({') < i, `${f}: the open lock is saved before the play stamp`);
  }
});

// ---- 5. the house loss cap in the slot config ----
test('betLevelStates greys out the levels the house loss cap would refuse (stake x (cap - 1) over the cap), the same test as the server', () => {
  const cap = SLOT_MATH.capMultiplier;
  const states = betLevelStates({ maxHouseLossCents: 50_000_000, balance: 10_000_000 });
  for (const s of states) {
    const loss = maxPayoutUnits(s.stake, SLOT_MATH) - s.stake;
    assert.equal(s.allowed, loss <= 50_000_000, `${s.stake}: loss ${loss}`);
    if (!s.allowed) assert.equal(s.reason, HOUSE_LOSS_LIMIT_MESSAGE);
  }
  assert.ok(states.some((s) => s.allowed) && states.some((s) => !s.allowed), 'the cap splits the levels');
  // Boundary: exactly at the cap is allowed (the server tests with >).
  const edge = BET_LEVELS[0] * (cap - 1);
  assert.equal(betLevelStates({ levels: [BET_LEVELS[0]], maxHouseLossCents: edge }).at(0).allowed, true);
  assert.equal(betLevelStates({ levels: [BET_LEVELS[0]], maxHouseLossCents: edge - 1 }).at(0).allowed, false);
  // No cap known: unchanged.
  assert.ok(betLevelStates({ balance: 10_000_000 }).every((s) => s.allowed));
  assert.ok(betLevelStates({ maxHouseLossCents: 0, balance: 10_000_000 }).every((s) => s.allowed), 'zero or missing means not enforced here');
  assert.match(src('slots/SlotsApp.jsx'), /maxHouseLossCents: config\?\.maxHouseLossCents \?\? null/);
  assert.equal(HOUSE_LOSS_LIMIT_MESSAGE, 'This bet is over the table limit. Lower the bet.', 'the same words as the server, so the refusal classes agree');
});
