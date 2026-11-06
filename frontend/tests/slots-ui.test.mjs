import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SLOT_MATH, BET_LEVELS } from '../../backend/src/games/slotsMath.js';
import { playRound, maxPayoutUnits } from '../../backend/src/games/slots.js';
import { buildTimeline, reelStopTimes, TIMING, freeLeftBefore, linePoints, winningCells } from '../src/slots/slotAnim.js';
import { createSlotRequest, saveSlotReceipt, readSlotReceipt, countSlotReceipts, MAX_SLOT_RECEIPTS, betLevelStates, pickBetLevel, stepBetLevel, slotTableLimitMessage, fmtBet, autoShouldStop, balanceDuringSpin, NOT_ENOUGH_BALANCE_MESSAGE } from '../src/slots/slotsApi.js';
import { paytableRows, scatterRow, paytableCopy, allPlayerCopy } from '../src/slots/slotCopy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => fs.readFileSync(path.join(here, '..', 'src', 'slots', f), 'utf8');

// A fixed round from the real engine: all draws 0 lands every reel on stop 0 (no scatter in that window).
const flat = playRound({ stake: 2000, math: SLOT_MATH, uint32At: () => 0 });
const asReply = (r) => ({ ...r, totalPayoutCents: r.totalPayoutUnits });

// Hand-made rounds, so free spins and scatters are certain.
const grid = (rows) => rows.map((r) => r.split(''));
const spin = (over = {}) => ({ index: 0, free: false, stops: [0, 0, 0, 0, 0], grid: grid(['JJJJJ', 'QQQQQ', 'KKKKK']), lineWins: [], scatterCount: 0, scatterPay: 0, multiplier: 1, winUnits: 0, freeSpinsAdded: 0, ...over });
const scatterGrid = grid(['SJJSJ', 'QQQQS', 'KKKKK']); // vault doors on reels 1, 4 and 5
const freeRound = { stake: 2000, totalPayoutCents: 4400, freeSpinsAwarded: 10, freeSpinsPlayed: 10, capped: false,
  spins: [spin({ grid: scatterGrid, scatterCount: 3, scatterPay: 2, winUnits: 4000, freeSpinsAdded: 10 }),
    ...Array.from({ length: 10 }, (_, i) => spin({ index: i + 1, free: true, multiplier: 2, winUnits: i === 2 ? 400 : 0, lineWins: i === 2 ? [{ line: 4, symbol: 'J', count: 3, pay: 2 }, { line: 1, symbol: 'Q', count: 3, pay: 3 }] : [] }))] };

test('timeline: reels stop left to right 220 ms apart after a 900 ms spin, half that in turbo', () => {
  const tl = buildTimeline(asReply(flat));
  const stops = reelStopTimes(tl, 0);
  assert.equal(stops.length, 5);
  assert.equal(stops[0], TIMING.spinMs);
  for (let i = 1; i < 5; i++) assert.equal(stops[i] - stops[i - 1], TIMING.staggerMs);
  const turbo = reelStopTimes(buildTimeline(asReply(flat), { turbo: true }), 0);
  assert.equal(turbo[0], TIMING.spinMs / 2);
  assert.equal(turbo[1] - turbo[0], TIMING.staggerMs / 2);
});

test('timeline: steps are ordered by time and end with done; a no-win manual spin takes 2.5 to 4 s', () => {
  const tl = buildTimeline(asReply(flat));
  for (let i = 1; i < tl.steps.length; i++) assert.ok(tl.steps[i].at >= tl.steps[i - 1].at, `step ${i} out of order`);
  assert.equal(tl.steps.at(-1).type, 'done');
  if (flat.totalPayoutUnits === 0) { assert.ok(tl.totalMs >= 1500 && tl.totalMs <= 4000, `total ${tl.totalMs}`); }
});

test('timeline: anticipation flags once two vault doors are down and reels remain, and slows the rest', () => {
  const tl = buildTimeline(freeRound);
  const stops = tl.steps.filter((s) => s.type === 'reel-stop' && s.spin === 0);
  assert.deepEqual(stops.map((s) => s.anticipation), [false, false, false, false, true]);
  const ant = tl.steps.find((s) => s.type === 'anticipation');
  assert.equal(ant.fromReel, 4);
  assert.equal(stops[4].at - stops[3].at, Math.round(TIMING.staggerMs * TIMING.anticipationFactor));
  assert.equal(stops[3].at - stops[2].at, TIMING.staggerMs);
  const scatters = tl.steps.filter((s) => s.type === 'scatter' && s.spin === 0);
  assert.deepEqual(scatters.map((s) => s.count), [1, 2, 3]);
  assert.deepEqual(scatters.map((s) => s.reel), [0, 3, 4]);
});

test('timeline: free spin intro before the first free spin, lines traced in line order, retrigger and total banner', () => {
  const tl = buildTimeline(freeRound);
  const types = tl.steps.map((s) => s.type);
  const intro = tl.steps.find((s) => s.type === 'free-intro');
  assert.ok(intro && intro.duration === TIMING.vaultMs && intro.spin === 1);
  const firstFree = tl.steps.find((s) => s.type === 'spin-start' && s.spin === 1);
  assert.equal(firstFree.at, intro.at + TIMING.vaultMs);
  assert.equal(firstFree.freeLeft, 9); // 9 more after this one
  const lines = tl.steps.filter((s) => s.type === 'line-win');
  assert.deepEqual(lines.map((l) => l.line), [1, 4]);
  assert.equal(lines[1].at - lines[0].at, TIMING.lineMs);
  assert.equal(lines[0].pay, 3 * 100 * 2);
  assert.ok(types.includes('total'));
  assert.equal(types.indexOf('total'), types.length - 2);
  const r = { ...freeRound, spins: freeRound.spins.map((s, i) => (i === 3 ? { ...s, scatterCount: 3, freeSpinsAdded: 5 } : s)) };
  assert.ok(buildTimeline(r).steps.some((s) => s.type === 'retrigger' && s.added === 5));
});

test('timeline: many lines are capped to the total line budget; pace scales win beats only', () => {
  const many = { stake: 2000, totalPayoutCents: 2000, spins: [spin({ winUnits: 2000, lineWins: Array.from({ length: 20 }, (_, i) => ({ line: i, symbol: 'J', count: 3, pay: 2 })) })] };
  const lines = buildTimeline(many).steps.filter((s) => s.type === 'line-win');
  assert.equal(lines.length, 20);
  assert.ok(lines.at(-1).at + lines.at(-1).duration - lines[0].at <= TIMING.lineTotalCapMs);
  const slow = buildTimeline(many), fast = buildTimeline(many, { pace: 0.4 });
  assert.equal(reelStopTimes(fast, 0)[4], reelStopTimes(slow, 0)[4]);
  assert.ok(fast.totalMs < slow.totalMs);
});

test('free spins left counter and line geometry helpers', () => {
  assert.equal(freeLeftBefore(freeRound.spins, 1), 10);
  assert.equal(freeLeftBefore(freeRound.spins, 2), 9);
  assert.equal(freeLeftBefore(freeRound.spins, 10), 1);
  assert.equal(linePoints(0), '50,150 150,150 250,150 350,150 450,150');
  assert.deepEqual(winningCells(3, 3), [{ reel: 0, row: 0 }, { reel: 1, row: 1 }, { reel: 2, row: 2 }]);
});

// Bet levels: the table limit and the balance grey levels with one plain sentence each.
test('bet levels above the table limit or the balance are greyed with the server sentence', () => {
  const states = betLevelStates({ tableLimit: 2000 * 2000 * 5, balance: 3000 });
  assert.equal(states.length, BET_LEVELS.length);
  assert.deepEqual(states.filter((s) => s.allowed).map((s) => s.stake), [2000]);
  assert.equal(states[1].reason, NOT_ENOUGH_BALANCE_MESSAGE);
  assert.equal(states[3].reason, 'The most you can bet on one spin right now is 100.00 $TICS.');
  assert.equal(slotTableLimitMessage(10), 'The casino wallet cannot cover a round at the smallest bet right now. Please try again later.');
  const rich = betLevelStates({ tableLimit: null, balance: 10 ** 9, maxStakeCents: 100000 });
  assert.deepEqual(rich.filter((s) => s.allowed).map((s) => s.stake), [2000, 4000, 10000, 20000, 50000, 100000]);
  assert.equal(rich[6].reason, 'The bet can be at most 1,000.00 $TICS.');
  assert.equal(pickBetLevel(states, 20000), 2000);
  assert.equal(pickBetLevel(rich, 50000), 50000);
  assert.equal(pickBetLevel(rich, 1000000), 100000);
  assert.equal(stepBetLevel(BET_LEVELS, 2000, -1), null);
  assert.equal(stepBetLevel(BET_LEVELS, 2000, 1), 4000);
  assert.equal(fmtBet(100000), '1,000 $TICS');
  assert.equal(balanceDuringSpin(100000, 2000), 98000);
  assert.equal(autoShouldStop({ balance: 1000, stake: 2000 }), 'balance');
  assert.equal(autoShouldStop({ freeSpins: 10, balance: 9000, stake: 2000 }), 'free_spins');
  assert.equal(autoShouldStop({ verified: false }), 'verification');
  assert.equal(autoShouldStop({ balance: 9000, stake: 2000 }), null);
});

// Receipts: saved before the post, readable afterwards, capped at 200.
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), get length() { return m.size; }, key: (i) => [...m.keys()][i] };
}
const commitment = { serverSeedHash: 'a'.repeat(64), clientSeed: 'player', nonce: 0 };
test('createSlotRequest: fresh 32 byte entropy after the lock, receipt and body agree', () => {
  let n = 0;
  const { receipt, body } = createSlotRequest(commitment, 4000, 'demo', { random: (k) => new Uint8Array(k).map((_, i) => (i + n++) & 255), uuid: () => '11111111-2222-4333-8444-555555555555', revealed: [] });
  assert.match(body.clientEntropy, /^[a-f0-9]{64}$/);
  assert.equal(body.requestId, receipt.requestId);
  assert.equal(body.stake, 4000);
  assert.equal(body.mode, 'demo');
  assert.equal(body.mathId, SLOT_MATH.id);
  assert.deepEqual(body.expectedCommitment, commitment);
  assert.equal(receipt.clientSeedBase, 'player');
  assert.equal(receipt.clientEntropy, body.clientEntropy);
  assert.equal(receipt.serverSeedHash, commitment.serverSeedHash);
  assert.throws(() => createSlotRequest(commitment, 3000, 'demo', { revealed: [] }), /bet amounts shown/);
  assert.throws(() => createSlotRequest(commitment, 2000, 'demo', { revealed: [commitment.serverSeedHash] }), /already opened/);
  assert.throws(() => createSlotRequest({ serverSeedHash: 'x' }, 2000, 'demo', { revealed: [] }), /valid pre-bet lock/);
});
test('slot receipts are saved under betics:slot-receipt:<id>, read back, and only the newest 200 are kept', () => {
  const storage = memoryStorage();
  const first = createSlotRequest(commitment, 2000, 'demo', { revealed: [] }).receipt;
  saveSlotReceipt(first, storage);
  assert.equal(storage.getItem(`betics:slot-receipt:${first.requestId}`), JSON.stringify(first));
  assert.deepEqual(readSlotReceipt(first.requestId, storage), { ...first });
  for (let i = 0; i < MAX_SLOT_RECEIPTS + 20; i++) saveSlotReceipt(createSlotRequest(commitment, 2000, 'demo', { revealed: [] }).receipt, storage);
  assert.equal(countSlotReceipts(storage), MAX_SLOT_RECEIPTS);
  assert.equal(readSlotReceipt(first.requestId, storage), null);
  assert.equal(readSlotReceipt('missing', storage), null);
});

// Paytable: every number equals the maths; copy is clean.
test('paytable rows come from SLOT_MATH and show $TICS for the current bet', () => {
  const stake = 20000; // 200 $TICS, line bet 10 $TICS
  const rows = paytableRows(stake);
  assert.equal(rows.length, SLOT_MATH.symbols.length - 1);
  for (const r of rows) for (const p of r.pays) {
    assert.equal(p.multiple, SLOT_MATH.pays[r.code][p.count]);
    assert.equal(p.units, SLOT_MATH.pays[r.code][p.count] * (stake / SLOT_MATH.lineCount));
  }
  const sc = scatterRow(stake);
  assert.deepEqual(sc.pays.map((p) => p.units), [3, 4, 5].map((k) => SLOT_MATH.scatterPays[k] * stake));
  const copy = paytableCopy();
  assert.equal(copy.payback, 'Payback 92.0%');
  assert.equal(copy.cap, 'One round pays at most 2,000 times the bet.');
  assert.match(copy.freeSpinsRule, /start 10, 15 or 20 free spins/);
  assert.match(copy.freeSpinsRule, /add 5, 8 or 10 more/);
  assert.match(copy.freeSpinsRule, /At most 50 free spins/);
  assert.equal(maxPayoutUnits(2000, SLOT_MATH), 2000 * SLOT_MATH.capMultiplier);
});
test('player copy has no emoji, no dashes and none of the banned words', () => {
  const banned = /guaranteed|trustless|fully provably fair|\u2013|\u2014|\p{Extended_Pictographic}/iu;
  for (const s of allPlayerCopy(2000)) {
    assert.ok(!banned.test(s), `banned content in: ${s}`);
    assert.ok(!/ - /.test(s), `dash in: ${s}`);
    assert.ok(!/\$\s?\d/.test(s), `dollar amount in: ${s}`);
  }
  // Components too: the JSX text of the slot page carries no emoji or long dashes.
  for (const f of ['SlotsApp.jsx', 'Reels.jsx', 'SlotPaytable.jsx', 'SlotFairness.jsx', 'SlotSymbols.jsx']) {
    const text = src(f);
    assert.ok(!/[\u2013\u2014]|\p{Extended_Pictographic}/u.test(text), `${f} has an emoji or long dash`);
    assert.ok(!/guaranteed|trustless|fully provably fair/i.test(text), `${f} has a banned phrase`);
  }
});

// Symbols: an original SVG component for every symbol code, each with the symbol name as its label.
test('SlotSymbols has a component for every symbol code in SLOT_MATH', () => {
  const text = src('SlotSymbols.jsx');
  const block = text.match(/export const SYMBOL_COMPONENTS\s*=\s*(?:Object\.freeze\()?\{([\s\S]*?)\}/);
  assert.ok(block, 'SYMBOL_COMPONENTS export missing');
  const keys = [...block[1].matchAll(/(?:^|[,{\s])([A-Z]):/g)].map((m) => m[1]);
  for (const s of SLOT_MATH.symbols) assert.ok(keys.includes(s.code), `no component for ${s.code}`);
  for (const s of SLOT_MATH.symbols) assert.ok(text.includes(`'${s.name}'`) || text.includes(`"${s.name}"`) || text.includes('symbolName('), `no aria label source for ${s.name}`);
  assert.ok(!/<image|href=|url\((?!#)/i.test(text), 'symbols must be inline SVG, not loaded images');
});

// Route: /godsofpower renders the slot page without touching / , /terms or /how-it-works.
test('main.jsx routes /godsofpower (optional trailing slash) and keeps the other pages', () => {
  const text = fs.readFileSync(path.join(here, '..', 'src', 'main.jsx'), 'utf8');
  assert.match(text, /\/\^\\\/godsofpower\\\/\?\$\//);
  assert.match(text, /\/\^\\\/terms\\\/\?\$\//);
  assert.match(text, /\/\^\\\/how-it-works\\\/\?\$\//);
  assert.match(text, /SlotsApp/);
});

// Route: / is the lobby, /roulette (optional trailing slash) the roulette game.
test('main.jsx routes / to the Lobby and /roulette to the roulette App', () => {
  const text = fs.readFileSync(path.join(here, '..', 'src', 'main.jsx'), 'utf8');
  assert.match(text, /\/\^\\\/roulette\\\/\?\$\//);
  assert.match(text, /import Lobby from '\.\/Lobby\.jsx'/);
  assert.match(text, /roulette \? <App \/> : <Lobby \/>/, 'anything not matched above falls back to the lobby (the server 404s unknown paths)');
  // Play the regexes against real paths.
  const re = (name) => new RegExp(text.match(new RegExp(`const ${name} = /(.*?)/\\.test`))[1]);
  for (const [name, yes, no] of [['roulette', ['/roulette', '/roulette/'], ['/', '/roulette/x', '/rouletteX']], ['slots', ['/godsofpower', '/godsofpower/'], ['/', '/slots']], ['terms', ['/terms'], ['/termsx']], ['how', ['/how-it-works/'], ['/how']]]) {
    for (const p of yes) assert.ok(re(name).test(p), `${name} matches ${p}`);
    for (const p of no) assert.ok(!re(name).test(p), `${name} rejects ${p}`);
  }
});

test('in-app links: the logo and Lobby pills go to /, the games are reached at /roulette and /godsofpower', () => {
  const read = (f) => fs.readFileSync(path.join(here, '..', 'src', f), 'utf8');
  assert.match(read('LobbyLink.jsx'), /href="\/" data-testid="lobby-link"/);
  // Both games render the Lobby pill through the shared header (GameHeader.jsx, headerModel.js).
  assert.match(read('GameHeader.jsx'), /lobby: <LobbyLink key="lobby" className="gh-pill gh-lobby" \/>/);
  assert.match(read('slots/SlotsApp.jsx'), /<GameHeader page="slot"/); assert.match(read('App.jsx'), /<GameHeader page="roulette"/);
  assert.ok(!/slot-roulette-link/.test(read('slots/SlotsApp.jsx')), 'the old Roulette link is gone');
  for (const f of ['Terms.jsx', 'HowItWorks.jsx']) assert.match(read(f), /href="\/">Back to the lobby</, `${f} back link goes home`);
  const lobby = read('Lobby.jsx');
  assert.match(lobby, /href: '\/roulette'/); assert.match(lobby, /href: '\/godsofpower'/);
  assert.match(lobby, /European wheel', '97\.3% payback', 'Bets from 1 \$TICS'/);
  assert.match(lobby, /5 reels, 20 lines', 'Free spins', '92% payback', 'Bets from 20 \$TICS'/);
  assert.match(lobby, /<AgeGate onAccept=\{session\.acceptAge\} \/>/, 'the 18+ gate shows on the lobby too');
  assert.match(lobby, /data-testid=\{`play-\$\{game\.id\}`\}/);
  assert.match(lobby, /<CasinoReserve variant="card"/);
  assert.match(lobby, /<SupportLink/); assert.match(lobby, /href="\/how-it-works"/); assert.match(lobby, /href="\/terms"/);
  for (const f of ['Lobby.jsx', 'lobby.css', 'LobbyLink.jsx', 'useSession.js']) {
    const text = read(f);
    assert.ok(!/[\u2013\u2014]|\p{Extended_Pictographic}/u.test(text), `${f} has an emoji or long dash`);
    assert.ok(!/guaranteed|trustless|fully provably fair/i.test(text), `${f} has a banned phrase`);
  }
  assert.ok(!/\$\s?\d/.test(lobby), 'amounts read $TICS, never dollars');
});
