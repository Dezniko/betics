// Audit fixes on the slot page: refused spins and lost replies retire the lock through the reveal and
// count in the refusal budgets like roulette; the receipt's terms (stake, mode, maths, balance before)
// are checked; the downloaded proof verifies with the standalone verifier; reduced motion and the
// session polling schedule are pure helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { playRound, gridFor } from '../../backend/src/games/slots.js';
import { SLOT_MATH } from '../../backend/src/games/slotsMath.js';
import { makeUint32At } from '../../backend/src/core/slotDraws.js';
import { revealAndRetireLock, fetchPlayerRounds, RETIRED_KEY_MISFIT_MESSAGE, RETIRED_LOCK_NOT_FRESH_MESSAGE } from '../src/fairnessClient.js';
import { waitForRoundWithLock, addRefusedSlotSpin, readRefusedLog, refusedSpinText, slotWouldHaveText, budgetFor, recordRefusal, REFUSAL_LIMIT, LOST_REPLY_WAIT_MS, LOST_REPLY_POLL_MS, OTHER_TAB_UNSEEN_MESSAGE } from '../src/spinRefusal.js';
import { verifySlotRound, recomputeSlotRound, sha256Hex } from '../src/slots/slotsVerify.js';
import { createSlotRequest } from '../src/slots/slotsApi.js';
import { buildSlotProof, slotExpectedFromReceipt, SLOT_PROOF_VERSION, slotProofFileName } from '../src/slots/slotProof.js';
import { checkSlotHistoryRound, slotRoundFromRow, withoutSlotBalance } from '../src/slots/slotHistory.js';
import { buildTimeline, reducedMotionTiming, prefersReducedMotion, motionEffects, reelStopTimes, TIMING, REDUCED_COUNT_SCALE } from '../src/slots/slotAnim.js';
import { pollDelayMs, isPlaying, refreshOnVisibility, ME_POLL_MS, ME_POLL_IDLE_MS, PLAY_RECENT_MS } from '../src/sessionPolling.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => fs.readFileSync(path.join(here, '..', 'src', f), 'utf8');
const slice = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const memStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null }; };
const reply = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });

// A real round from the engine, in the server's reply shape.
function makeReply({ seed = 'seed-' + crypto.randomBytes(8).toString('hex'), base = 'lucky', entropy = 'ab'.repeat(32), nonce = 0, stake = 2000, before = 100000, mode = 'demo' } = {}) {
  const clientSeed = `${base}:${entropy}`;
  const round = playRound({ stake, math: SLOT_MATH, uint32At: makeUint32At(seed, clientSeed, nonce) });
  return { requestId: '00000000-0000-4000-8000-000000000001', roundId: 7, game: 'godsofpower', stake, spins: round.spins, freeSpinsAwarded: round.freeSpinsAwarded, freeSpinsPlayed: round.freeSpinsPlayed, capped: round.capped,
    totalStakeCents: stake, totalPayoutCents: round.totalPayoutUnits, mathId: SLOT_MATH.id, mode, balanceBeforeCents: before, balanceAfterCents: before - stake + round.totalPayoutUnits,
    fairness: { serverSeed: seed, serverSeedHash: sha(seed), clientSeed, clientSeedBase: base, clientEntropy: entropy, nonce, nextCommitment: { serverSeedHash: sha(seed + '-next'), clientSeed: base, nonce: 0 } } };
}
const receiptFor = (r, over = {}) => ({ requestId: r.requestId, serverSeedHash: r.fairness.serverSeedHash, clientSeedBase: r.fairness.clientSeedBase, clientEntropy: r.fairness.clientEntropy, nonce: r.fairness.nonce, stake: r.stake, mode: r.mode, mathId: r.mathId, balanceBefore: r.balanceBeforeCents, at: 1, ...over });

// ---- 1. the shared reveal path ----
test('revealAndRetireLock: the revealed key must open the saved lock and the new lock must be fresh', async () => {
  const old = 'old-seed', oldHash = sha(old), expected = { serverSeedHash: oldHash, clientSeed: 'lucky', nonce: 3 };
  const fresh = { serverSeedHash: sha('new-seed'), clientSeed: 'lucky', nonce: 0 };
  const storage = memStorage();
  const calls = [];
  const fetchFn = async (url, opt) => { calls.push([url, JSON.parse(opt.body)]); return { ok: true, status: 200, json: async () => ({ retired: { serverSeed: old, serverSeedHash: oldHash }, commitment: fresh }) }; };
  const ok = await revealAndRetireLock(expected, { fetchFn, storage });
  assert.equal(ok.ok, true); assert.equal(ok.fits, true); assert.deepEqual(ok.commitment, fresh);
  assert.deepEqual(calls, [['/api/fairness/rotate', { expectedCommitment: expected }]], 'rotate carries the saved lock');
  assert.ok(JSON.parse(storage.getItem('noir:revealed:v1')).includes(oldHash), 'the retired lock is remembered so it can never come back');
  // Wrong key: the revealed seed does not hash to the saved lock.
  const misfit = await revealAndRetireLock(expected, { fetchFn: reply(200, { retired: { serverSeed: 'other', serverSeedHash: oldHash }, commitment: fresh }), storage: memStorage() });
  assert.equal(misfit.ok, false); assert.equal(misfit.problem, RETIRED_KEY_MISFIT_MESSAGE);
  // Same lock again, a changed lucky word or a non-zero nonce: not fresh.
  for (const bad of [{ ...fresh, serverSeedHash: oldHash }, { ...fresh, clientSeed: 'other' }, { ...fresh, nonce: 2 }]) {
    const r = await revealAndRetireLock(expected, { fetchFn: reply(200, { retired: { serverSeed: old, serverSeedHash: oldHash }, commitment: bad }), storage: memStorage() });
    assert.equal(r.ok, false); assert.equal(r.problem, RETIRED_LOCK_NOT_FRESH_MESSAGE);
  }
  // A revealed lock reused as the next lock is refused too.
  const s2 = memStorage(); s2.setItem('noir:revealed:v1', JSON.stringify([fresh.serverSeedHash]));
  assert.equal((await revealAndRetireLock(expected, { fetchFn: reply(200, { retired: { serverSeed: old, serverSeedHash: oldHash }, commitment: fresh }), storage: s2 })).problem, RETIRED_LOCK_NOT_FRESH_MESSAGE);
  // Server refusal: an error, not a problem (the page says the lock could not be checked and pauses).
  const err = await revealAndRetireLock(expected, { fetchFn: reply(409, { error: 'stale or mismatched expectedCommitment' }), storage: memStorage() });
  assert.equal(err.ok, false); assert.equal(err.error, 'stale or mismatched expectedCommitment'); assert.equal(err.problem, undefined);
  assert.equal((await fetchPlayerRounds({ fetchFn: reply(200, [{ id: 1 }]) })).length, 1);
  await assert.rejects(fetchPlayerRounds({ fetchFn: reply(500, {}) }));
  // Roulette uses the same function.
  assert.match(slice(src('App.jsx'), 'const retireLock = async', 'const openAndLog = async'), /await revealAndRetireLock\(expectedCommitment\)/);
});

// ---- 2. lost replies: shared poll of /api/rounds ----
test('waitForRoundWithLock polls until the lock shows up, survives fetch errors and gives up after the wait', async () => {
  assert.equal(LOST_REPLY_WAIT_MS, 20000); assert.equal(LOST_REPLY_POLL_MS, 2000);
  const entry = { serverSeedHash: 'a'.repeat(64), requestId: 'r1', clientEntropy: 'e'.repeat(64) };
  let t = 0, n = 0;
  const now = () => t, sleep = async (ms) => { t += ms; };
  const fetchRounds = async () => { n += 1; if (n === 1) throw new Error('offline'); return n >= 3 ? [{ server_seed_hash: 'a'.repeat(64), request_id: 'r1' }] : []; };
  const hit = await waitForRoundWithLock(entry, fetchRounds, { waitMs: 20000, pollMs: 2000, sleep, now });
  assert.equal(hit.own, true); assert.equal(n, 3); assert.equal(t, 6000);
  t = 0; n = 0;
  assert.equal(await waitForRoundWithLock(entry, async () => { n += 1; return []; }, { waitMs: 20000, pollMs: 2000, sleep, now }), null);
  assert.equal(n, 10, 'ten polls in twenty seconds');
  const app = src('App.jsx');
  assert.match(slice(app, 'const recoverLostReply = async', 'const handleRefusal = async'), /await waitForRoundWithLock\(entry, fetchRounds/, 'roulette shares the poll');
  assert.match(slice(src('slots/SlotsApp.jsx'), 'const recoverLostReply = async', 'const handleRefusal = async'), /await waitForRoundWithLock\(entry, fetchRounds\)/, 'the slot shares the poll');
});

// ---- 3. the refused spins log takes slot rounds ----
test('a refused slot round is logged with its reel stops and payout, and other_tab_unseen is a counted kind', () => {
  const s = memStorage();
  const lock = 'b'.repeat(64);
  addRefusedSlotSpin({ lock, stops: [1, 2, 3, 4, 5], won: 4000, kind: 'other_tab_unseen', reason: 'You are playing in another tab' }, s);
  const [e] = readRefusedLog(s);
  assert.equal(e.game, 'godsofpower'); assert.deepEqual(e.stops, [1, 2, 3, 4, 5]); assert.equal(e.won, 4000); assert.equal(e.pocket, null); assert.equal(e.kind, 'other_tab_unseen');
  assert.equal(refusedSpinText(e), 'Refused spin: the reels would have stopped at 1 2 3 4 5, would have won 40 $TICS');
  addRefusedSlotSpin({ lock: 'c'.repeat(64), stops: null, won: 10, kind: 'lost', reason: 'x' }, s);
  const never = readRefusedLog(s).find((x) => x.lock === 'c'.repeat(64));
  assert.equal(never.won, null, 'no payout without stops'); assert.equal(refusedSpinText(never), 'Refused spin: the lock was never opened');
  assert.equal(readRefusedLog(s).length, 2);
  addRefusedSlotSpin({ lock: 'd'.repeat(64), stops: [1, 2, 3], won: 1, kind: 'lost' }, s);
  assert.equal(readRefusedLog(s).length, 3, 'bad stops are stored as "never shown", the entry itself is kept');
  assert.equal(readRefusedLog(s).at(-1).stops, null);
  assert.equal(slotWouldHaveText([3, 11, 7, 19, 27], 6000), 'Had it gone ahead, the reels would have stopped at 3 11 7 19 27 and won 60 $TICS.');
  assert.equal(slotWouldHaveText([3, 11, 7, 19, 27], 0), 'Had it gone ahead, the reels would have stopped at 3 11 7 19 27 with no win.');
  assert.equal(slotWouldHaveText(null, 5), '');
  assert.equal(budgetFor('other_tab_unseen'), 'unpredicted');
  assert.equal(budgetFor('lost'), null, 'a lost reply is counted explicitly by the page (strict budget), not by kind');
  assert.ok(!/[\u2013\u2014]|\p{Extended_Pictographic}/u.test(OTHER_TAB_UNSEEN_MESSAGE));
});

// ---- 4. the would-have round: same engine, same draws ----
test('recomputeSlotRound matches the engine, also for free spin rounds that need more draws than the first batch', async () => {
  let freeSeen = false;
  for (let i = 0; i < 400 && !freeSeen; i++) {
    const seed = `seed-${i}`, clientSeed = `lucky:${'ab'.repeat(32)}`;
    const expected = playRound({ stake: 2000, math: SLOT_MATH, uint32At: makeUint32At(seed, clientSeed, 0) });
    if (expected.freeSpinsAwarded === 0 && i % 25 !== 0) continue;
    const got = await recomputeSlotRound({ serverSeed: seed, clientSeed, nonce: 0, stake: 2000 });
    assert.deepEqual(got.spins.map((s) => s.stops), expected.spins.map((s) => s.stops), `seed ${i}`);
    assert.equal(got.totalPayoutUnits, expected.totalPayoutUnits);
    if (expected.freeSpinsAwarded > 0) freeSeen = true;
  }
  assert.ok(freeSeen, 'at least one free spin round was recomputed from a grown draw batch');
});

// ---- 5. verifySlotRound checks the terms of the bet ----
test('verifySlotRound flags a changed stake, mode or payout table, a grid that does not match the stops, and a short balance', async () => {
  const r = makeReply();
  const good = await verifySlotRound(receiptFor(r), r);
  assert.deepEqual(good.problems, [], 'an honest reply passes with the full receipt');
  const bad = async (receiptOver, replyOver = {}) => (await verifySlotRound(receiptFor(r, receiptOver), { ...r, ...replyOver })).problems;
  assert.ok((await bad({ stake: 5000 })).some((p) => /stake differs \(2000 played, 5000 sent\)/.test(p)));
  assert.ok((await bad({ mode: 'real' })).some((p) => /play mode/.test(p)));
  assert.ok((await bad({ mathId: 'other-table' })).some((p) => /payout table differs/.test(p)));
  // A grid the server sends must be gridFor(stops); the page draws gridFor(stops) regardless.
  const spins = r.spins.map((s, i) => (i === 0 ? { ...s, grid: s.grid.map((row, ri) => (ri === 0 ? [...row.slice(1), row[0]] : row)) } : s));
  assert.ok((await bad({}, { spins })).some((p) => p === 'Spin 1: the symbols shown do not match the reel stops.'));
  assert.deepEqual(gridFor(r.spins[0].stops, SLOT_MATH), r.spins[0].grid, 'the engine grid is gridFor(stops)');
  // Balance pinned before the spin: too little is flagged, a higher balance (top up meanwhile) is fine.
  assert.ok((await bad({ balanceBefore: r.balanceBeforeCents + 100 })).some((p) => /credited too little/.test(p)));
  assert.deepEqual(await bad({ balanceBefore: r.balanceBeforeCents - 500 }), [], 'a lower balance before (top up landed) passes');
  assert.ok((await bad({}, { balanceAfterCents: undefined, balanceBeforeCents: undefined })).some((p) => /balance after the round is missing/.test(p)), 'with a pinned balance the reply must carry one');
  assert.deepEqual(await bad({ balanceBefore: null }, { balanceAfterCents: undefined, balanceBeforeCents: undefined }), [], 'no pinned balance, nothing to check');
  // History rows have no ending balance: the history check drops the pinned balance first.
  const row = { id: 7, game: 'godsofpower', stake_cents: r.stake, payout_cents: r.totalPayoutCents, server_seed: r.fairness.serverSeed, server_seed_hash: r.fairness.serverSeedHash, client_seed: r.fairness.clientSeed, client_seed_base: r.fairness.clientSeedBase, client_entropy: r.fairness.clientEntropy, nonce: 0, request_id: r.requestId, real_money: 0, math_id: SLOT_MATH.id,
    outcome_json: JSON.stringify({ game: 'godsofpower', spins: r.spins, freeSpinsAwarded: r.freeSpinsAwarded, freeSpinsPlayed: r.freeSpinsPlayed, capped: r.capped }) };
  const hist = await checkSlotHistoryRound(slotRoundFromRow(row), { read: () => receiptFor(r) });
  assert.deepEqual(hist, { ok: true, problems: [], receipt: true });
  assert.equal(withoutSlotBalance(receiptFor(r)).balanceBefore, undefined);
  assert.equal(slotRoundFromRow(row).mathId, SLOT_MATH.id);
});

test('createSlotRequest pins the balance shown when the spin is sent; the page passes the settled balance', () => {
  const c = { serverSeedHash: 'f'.repeat(64), clientSeed: 'lucky', nonce: 0 };
  const opts = { random: (n) => new Uint8Array(n).fill(7), uuid: () => '00000000-0000-4000-8000-000000000002', revealed: [] };
  assert.equal(createSlotRequest(c, 2000, 'demo', { ...opts, balanceBefore: 123456 }).receipt.balanceBefore, 123456);
  assert.equal(createSlotRequest(c, 2000, 'demo', { ...opts }).receipt.balanceBefore, null);
  assert.equal(createSlotRequest(c, 2000, 'demo', { ...opts, balanceBefore: -1 }).receipt.balanceBefore, null);
  assert.equal(createSlotRequest(c, 2000, 'demo', { ...opts, balanceBefore: 1.5 }).receipt.balanceBefore, null);
  assert.match(src('slots/SlotsApp.jsx'), /createSlotRequest\(c, bet, mode, \{ balanceBefore: balance \}\)/);
});

// ---- 6. the downloaded proof verifies with the standalone verifier ----
test('buildSlotProof writes the flat shape; the generated verifier accepts it, the nested shape, and rejects tampered terms', () => {
  const r = makeReply();
  const proof = buildSlotProof(r, receiptFor(r));
  assert.equal(proof.version, SLOT_PROOF_VERSION);
  assert.deepEqual(proof.expected, { serverSeedHash: r.fairness.serverSeedHash, clientSeedBase: 'lucky', clientEntropy: 'ab'.repeat(32), nonce: 0, stake: 2000, mode: 'demo', mathId: SLOT_MATH.id });
  assert.equal(proof.expected.balanceBefore, undefined, 'nothing but the terms from the receipt');
  assert.equal(proof.fairness.serverSeed, r.fairness.serverSeed); assert.equal(proof.stake, 2000);
  assert.equal(slotExpectedFromReceipt(null), null);
  assert.equal(buildSlotProof(r, null).expected, undefined, 'no receipt, no expected block');
  assert.equal(slotProofFileName(r), 'gods-of-power-round-7.json');
  assert.match(src('slots/SlotFairness.jsx'), /JSON\.stringify\(buildSlotProof\(round, receipt\), null, 2\)/, 'the page writes exactly this');
  const verifier = path.join(here, '..', 'public', 'verify-slots.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'verify-slots-proof-'));
  copyFileSync(verifier, path.join(dir, 'verify-slots.mjs'));
  const run = (name, obj) => { writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 2)); try { return { code: 0, out: execFileSync(process.execPath, ['verify-slots.mjs', name], { cwd: dir, encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: String(e.stdout) }; } };
  const flat = run('flat.json', proof); assert.equal(flat.code, 0, flat.out); assert.match(flat.out, /^OK: \d+ spin/);
  const nested = run('nested.json', { version: 'slots-1', receipt: receiptFor(r), round: r }); assert.equal(nested.code, 0, nested.out);
  const tampered = run('stake.json', { ...proof, expected: { ...proof.expected, stake: 5000 } }); assert.equal(tampered.code, 1); assert.match(tampered.out, /stake differs from the one saved before the bet/);
  const mode = run('mode.json', { version: 'slots-1', receipt: receiptFor(r, { mode: 'real' }), round: r }); assert.equal(mode.code, 1); assert.match(mode.out, /play mode differs/);
  const ent = run('entropy.json', { ...proof, expected: { ...proof.expected, clientEntropy: 'cd'.repeat(32) } }); assert.equal(ent.code, 1); assert.match(ent.out, /randomness differs/);
  const table = run('table.json', { ...proof, expected: { ...proof.expected, mathId: 'x' } }); assert.equal(table.code, 1); assert.match(table.out, /payout table/);
  const nonce = run('nonce.json', { ...proof, expected: { ...proof.expected, nonce: 1 } }); assert.equal(nonce.code, 1); assert.match(nonce.out, /round number differs/);
  const word = run('word.json', { ...proof, expected: { ...proof.expected, clientSeedBase: 'other' } }); assert.equal(word.code, 1); assert.match(word.out, /lucky word differs/);
  assert.ok(!/from '\.\.?\//.test(fs.readFileSync(verifier, 'utf8')), 'still standalone');
});

// ---- 7. the slot page follows the roulette protocol ----
test('SlotsApp saves the open lock before posting, retires it on refusals and lost replies, counts them, and draws gridFor(stops)', () => {
  const slot = src('slots/SlotsApp.jsx');
  const spin = slice(slot, 'const spin = async', 'spinRef.current = spin;');
  assert.ok(spin.indexOf('rememberOpenLock({ identity: identity(), serverSeedHash: c.serverSeedHash') < spin.indexOf('postJsonWithTimeout('), 'the open lock is saved BEFORE the post');
  assert.match(spin, /if \(!resp \|\| \(resp\.ok && !data\)\) \{[^}]*\n\s*stopAuto\(\);\n\s*await recoverLostReply\(\{ entry, request, bodyText, startedAt \}\);/, 'no reply goes to the lost reply path');
  assert.match(spin, /await handleRefusal\(\{ kind, reason, code: data\?\.code, entry, request, bodyText, startedAt \}\);/);
  assert.ok(!/C\.lostReply\b/.test(spin), 'no "reload the page" message for a lost reply any more');
  const open = slice(slot, 'const openAndLog = async', 'const adoptCurrentLock = async');
  assert.match(open, /revealAndRetireLock\(\{ serverSeedHash: entry\.serverSeedHash, clientSeed: entry\.clientSeed, nonce: entry\.nonce \}\)/, 'retired through the reveal with the saved lock');
  assert.match(open, /recomputeSlotRound\(\{ serverSeed: swap\.retired\.serverSeed, clientSeed: `\$\{entry\.clientSeed\}:\$\{entry\.clientEntropy\}`, nonce: entry\.nonce, stake \}\)/, 'the would-have round from the revealed key and the saved randomness');
  assert.match(open, /addRefusedSlotSpin\(\{ lock: entry\.serverSeedHash, stops, won, kind, reason \}\)/);
  const handler = slice(slot, 'const handleRefusal = async', 'const processReply = async');
  assert.match(handler, /updateOpenLock\(entry\.serverSeedHash, \{ refused: true, counted: !budgetFor\(kind\) \}\)/);
  assert.match(handler, /const swap = await openAndLog\(entry, kind, reason, stake\);/);
  assert.match(handler, /const r = recordRefusal\(budget\); updateOpenLock\(entry\.serverSeedHash, \{ counted: true \}\);\s*if \(r\.reached\) \{ stopForVerification\(`\$\{refusalStopMessage\(budget, r\.count\)\}/, 'the budget stop is the same as roulette');
  assert.ok(handler.indexOf('await openAndLog(') < handler.indexOf("if (kind === 'predicted')"), 'the reveal happens before any predicted-refusal wording');
  assert.match(handler, /if \(kind === 'other_tab'\) \{ forgetOpenLock\(entry\.serverSeedHash\); settleReelsRef\.current\(\); setNotice\(reason \|\| OTHER_TAB_MESSAGE\); return; \}/, 'a seen other tab: nothing used, nothing counted');
  assert.match(handler, /if \(kind === 'auth' && isSignedInElsewhere/);
  assert.match(handler, /if \(kind === 'stale_lock'\)/);
  const lost = slice(slot, 'const recoverLostReply = async', 'const handleRefusal = async');
  assert.match(lost, /openAndLog\(entry, 'lost', 'The connection dropped before the reply', request\.receipt\.stake\)/);
  assert.match(lost, /const r = recordRefusal\('unpredicted'\); updateOpenLock\(entry\.serverSeedHash, \{ counted: true \}\);/, 'a lost reply whose round never shows counts in the strict budget');
  assert.match(lost, /if \(!hit\.own\) \{[^\n]*await acceptOtherDeviceRound\(hit, entry, request\.receipt\.stake\); return; \}/);
  assert.match(lost, /await settleFoundRound\(\{ hit, request, bodyText, entry, startedAt \}\);/);
  const found = slice(slot, 'const settleFoundRound = async', 'const recoverLostReply = async');
  assert.match(found, /await postJsonWithTimeout\(`\$\{SLOT_API\}\/spin`, bodyText\)/, 'the byte-identical body is re-posted');
  assert.match(found, /data\.requestId === request\.receipt\.requestId\) \{ await processReply\(data, request, entry, startedAt\); return; \}/, 'the cached reply is presented normally');
  const other = slice(slot, 'const acceptOtherDeviceRound = async', 'const settleFoundRound = async');
  assert.match(other, /recordRefusal\('unpredicted'\)/); assert.match(other, /otherTabRecently\(session\.tabId\)/);
  const process_ = slice(slot, 'const processReply = async', 'const settleReelsRef = useRef');
  assert.match(process_, /forgetOpenLock\(entry\.serverSeedHash\);/, 'a verified reply closes the open lock');
  assert.match(process_, /updateOpenLock\(entry\.serverSeedHash, \{ refused: true, counted: true \}\); stopForVerification\(C\.verificationFailed\)/);
  const present = slice(slot, 'const present = async', 'const identity = ');
  assert.match(present, /const shownGrid = \(spin\) => gridFor\(spin\.stops, SLOT_MATH\);/);
  assert.ok(!/setGrid\(spin\.grid\)/.test(present), 'the server grid is never drawn as is');
  assert.match(present, /setGrid\(shownGrid\(spin\)\)/);
  assert.match(slot, /useEffect\(\(\) => \{ const p = startPresence\(\); return \(\) => p\.stop\(\); \}, \[\]\);/, 'the slot tab heartbeats too');
  assert.match(src('slots/slotCopy.js'), /lostReplyChecking: 'The connection dropped\. Checking whether your spin went through\.\.\.'/);
  // Budget maths shared with roulette: three unpredicted refusals in an hour stop the game.
  const s = memStorage(); let last;
  for (let i = 0; i < REFUSAL_LIMIT; i++) last = recordRefusal('unpredicted', 1000 + i, s);
  assert.equal(last.reached, true);
});

// ---- 8. reduced motion ----
test('reduced motion: shorter reel spin and count-up, no slow-down tease, no coin shower or streaks', () => {
  const t = reducedMotionTiming(TIMING);
  assert.ok(t.spinMs < TIMING.spinMs / 2 && t.staggerMs < TIMING.staggerMs); assert.equal(t.anticipationFactor, 1);
  const round = playRound({ stake: 2000, math: SLOT_MATH, uint32At: () => 0 }); const data = { ...round, totalPayoutCents: round.totalPayoutUnits };
  const normal = buildTimeline(data), reduced = buildTimeline(data, { reduced: true });
  assert.ok(reelStopTimes(reduced, 0).at(-1) < reelStopTimes(normal, 0).at(-1) / 2, 'the reels settle in less than half the time');
  const win = { stake: 2000, totalPayoutCents: 6000, spins: [{ ...round.spins[0], winUnits: 6000, lineWins: [{ line: 0, symbol: 'J', count: 3, pay: 3 }] }] };
  const n = buildTimeline(win).steps.find((s) => s.type === 'count-up'), r = buildTimeline(win, { reduced: true }).steps.find((s) => s.type === 'count-up');
  assert.equal(r.duration, Math.round(n.duration * REDUCED_COUNT_SCALE));
  assert.ok(buildTimeline(win, { reduced: true }).totalMs < buildTimeline(win).totalMs);
  assert.deepEqual(motionEffects({ reduced: true }), { coinBurst: false, coinRain: false, streaks: false, blur: false });
  assert.deepEqual(motionEffects({ reduced: false }), { coinBurst: true, coinRain: true, streaks: true, blur: true });
  assert.deepEqual(motionEffects({ hidden: true }), { coinBurst: false, coinRain: false, streaks: true, blur: true });
  assert.equal(prefersReducedMotion({ matchMedia: (q) => ({ matches: q === '(prefers-reduced-motion: reduce)' }) }), true);
  assert.equal(prefersReducedMotion({ matchMedia: () => ({ matches: false }) }), false);
  assert.equal(prefersReducedMotion({}), false); assert.equal(prefersReducedMotion(null), false);
  const slot = src('slots/SlotsApp.jsx');
  assert.match(slot, /const reduced = prefersReducedMotion\(\);\s*const tl = buildTimeline\(data, \{ pace, reduced \}\);/);
  assert.match(slot, /if \(effects\.coinBurst\) setBurstKey/); assert.match(slot, /celebration && !celebration\.reduced && <div key=\{`rain-/);
  assert.match(slot, /data-reduced-motion=\{reducedMotion \|\| undefined\}/);
  assert.match(src('slots/slots.css'), /\.slot-app\[data-reduced-motion\] \.slot-tile\.blur \{ filter: none; \}/);
});

// ---- 9. session polling ----
test('session polling: 10 s during play, 30 s idle, nothing while hidden, refresh when visible again', () => {
  const now = 1_700_000_000_000;
  assert.equal(ME_POLL_MS, 10000); assert.equal(ME_POLL_IDLE_MS, 30000); assert.equal(PLAY_RECENT_MS, 60000);
  assert.equal(pollDelayMs({ connected: true, visible: true, lastRoundAt: now - 5000, now }), 10000, 'a round in the last minute: play rate');
  assert.equal(pollDelayMs({ connected: true, visible: true, busy: true, now }), 10000, 'a round in flight: play rate');
  assert.equal(pollDelayMs({ connected: true, visible: true, lastRoundAt: now - 61000, now }), 30000, 'idle: back off');
  assert.equal(pollDelayMs({ connected: true, visible: true, lastRoundAt: null, now }), 30000);
  assert.equal(pollDelayMs({ connected: true, visible: false, lastRoundAt: now - 5000, now }), null, 'hidden tab: no polling');
  assert.equal(pollDelayMs({ connected: false, visible: true, now }), null, 'guest: no polling');
  assert.equal(isPlaying({ lastRoundAt: now + 120000, now }), false, 'a future stamp is not play');
  assert.equal(refreshOnVisibility({ connected: true, visible: true }), true);
  assert.equal(refreshOnVisibility({ connected: true, visible: false }), false);
  assert.equal(refreshOnVisibility({ connected: false, visible: true }), false);
  const hook = src('useSession.js');
  assert.match(hook, /lastRoundAtRef\.current = Date\.now\(\);/, 'a settled round starts the play window');
  assert.match(hook, /window\.addEventListener\('focus', onVisible\)/);
  assert.ok(!/setInterval/.test(hook), 'no fixed interval any more');
});
