// Gods of Power on the platform: config, limits, the Durable Object round, bookings and the money invariant.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes } from 'node:crypto';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { encodeAbiParameters, pad } from 'viem';
import worker, { DemoCasino } from './index.js';
import { clearConfigCache, publicConfig, loadGameConfig } from './platform.js';
import { createD1 } from '../test-support/d1shim.mjs';
import { OFFICIAL_TICS, TRANSFER_TOPIC } from './tics.js';
import { owedUnits, chainTick, sweepSpinHolds } from './wallet.js';
import { checkSlotLimits, slotLimitMessage } from './limits.js';
import { playRound, maxPayoutUnits } from '../backend/src/games/slots.js';
import { SLOT_MATH, BET_LEVELS } from '../backend/src/games/slotsMath.js';
import { makeUint32At } from '../backend/src/core/slotDraws.js';
import { pageFor, withPageHead } from './seo.js';

const MIGRATIONS = ['0001_platform.sql', '0002_payments.sql', '0003_tics.sql', '0004_spin_holds.sql', '0005_audit_fixes.sql', '0006_admin.sql', '0007_r3.sql', '0008_reaudit.sql', '0009_godsofpower.sql', '0010_unresolved_deposits.sql'].map((f) => new URL(`../migrations/${f}`, import.meta.url).pathname);
const HOST = 'betics.example';
const CASINO = '0xc0ffee0000000000000000000000000000000001';

function doStorage() {
  const db = new DatabaseSync(':memory:');
  const storage = {
    alarm: null, db,
    sql: { exec(query, ...args) {
      if (/CREATE TABLE|ALTER TABLE/.test(query) && !args.length) { db.exec(query); return { toArray: () => [] }; }
      const rows = db.prepare(query).all(...args);
      return { toArray: () => rows };
    } },
    transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } },
    async setAlarm(at) { storage.alarm = at; },
  };
  return storage;
}
function fakeChain() {
  const chain = { block: 1007, logs: [], receipts: new Map(), tokenBalance: 0n, ethBalance: 10n ** 18n };
  chain.rpc = async (method, params) => {
    if (method === 'eth_blockNumber') return `0x${chain.block.toString(16)}`;
    if (method === 'eth_getLogs') {
      const f = params[0], from = Number(f.fromBlock), to = Number(f.toBlock);
      if (to - from + 1 > 10) throw new Error('Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.');
      return chain.logs.filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to && l.address === f.address && l.topics[2] === f.topics[2]);
    }
    if (method === 'eth_getTransactionReceipt') return chain.receipts.get(params[0]) || null;
    if (method === 'eth_getBlockByNumber') return { number: `0x${(chain.finalized ?? chain.block).toString(16)}`, baseFeePerGas: '0x3b9aca00' };
    if (method === 'eth_call') return `0x${chain.tokenBalance.toString(16).padStart(64, '0')}`;
    if (method === 'eth_getBalance') return `0x${chain.ethBalance.toString(16)}`;
    throw new Error(`unexpected ${method}`);
  };
  chain.transfer = ({ from, to = CASINO, wei, block = chain.block }) => {
    const txHash = `0x${randomBytes(32).toString('hex')}`;
    const log = { address: OFFICIAL_TICS, topics: [TRANSFER_TOPIC, pad(from), pad(to)], data: encodeAbiParameters([{ type: 'uint256' }], [wei]),
      blockNumber: `0x${block.toString(16)}`, transactionHash: txHash, logIndex: '0x0', removed: false };
    chain.logs.push(log);
    chain.receipts.set(txHash, { status: '0x1', blockNumber: log.blockNumber, transactionHash: txHash, logs: [log] });
    if (to === CASINO) chain.tokenBalance += wei;
    return txHash;
  };
  return chain;
}
function platform() {
  clearConfigCache();
  const DB = createD1(MIGRATIONS);
  const objects = new Map();
  const chain = fakeChain();
  const env = { DB, INTERNAL_SECRET: 'test-secret', STAGING: 'true', ETH_RPC_URL: 'https://rpc.test' };
  env.CASINO = { idFromName: (name) => name, get: (id) => { if (!objects.has(id)) objects.set(id, new DemoCasino({ storage: doStorage() }, env)); return objects.get(id); } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) !== 'https://rpc.test') return realFetch(url, init);
    const { id, method, params } = JSON.parse(init.body);
    try { return Response.json({ jsonrpc: '2.0', id, result: await chain.rpc(method, params) }); } catch (e) { return Response.json({ jsonrpc: '2.0', id, error: { message: e.message } }); }
  };
  const call = async (path, { cookie, body, method = body === undefined ? 'GET' : 'POST', headers = {} } = {}) => {
    const response = await worker.fetch(new Request(`https://${HOST}${path}`, {
      method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), 'User-Agent': 'Mozilla/5.0 (Macintosh) Chrome/150', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env, { waitUntil() {} });
    const ct = response.headers.get('content-type') || '';
    return { status: response.status, data: ct.includes('json') ? await response.json() : await response.text(), headers: response.headers };
  };
  const rows = (q, ...a) => DB.raw.prepare(q).all(...a);
  const setTics = (patch) => {
    const cur = JSON.parse(rows("SELECT value FROM settings WHERE key = 'tics_payments'")[0].value);
    DB.raw.prepare("UPDATE settings SET value = ? WHERE key = 'tics_payments'").run(JSON.stringify({ ...cur, ...patch }));
  };
  const login = async (account = privateKeyToAccount(generatePrivateKey())) => {
    const n = await call('/api/wallet/nonce', { body: {} });
    const message = createSiweMessage({ domain: HOST, address: account.address, uri: `https://${HOST}`, version: '1', chainId: 1, nonce: n.data.nonce, issuedAt: new Date(), statement: n.data.statement });
    const signature = await account.signMessage({ message });
    const r = await call('/api/wallet/verify', { body: { message, signature } });
    return { r, account, cookie: r.headers.get('set-cookie')?.split(';')[0] };
  };
  const guest = async () => { const r = await call('/api/session', { body: {} }); return r.headers.get('set-cookie').split(';')[0]; };
  const spin = async (cookie, stake, mode, extra = {}) => {
    const c = (await call('/api/fairness/commitment', { cookie })).data;
    return call('/api/games/godsofpower/spin', { cookie, body: { stake, requestId: randomUUID(), expectedCommitment: c, clientEntropy: randomBytes(32).toString('hex'), ...(mode ? { mode } : {}), ...extra } });
  };
  const restore = () => { globalThis.fetch = realFetch; };
  return { env, DB, chain, call, rows, setTics, login, guest, spin, restore, objects };
}
async function funded(p, tics = 5000n, house = 1000000n) {
  p.setTics({ casinoWallet: CASINO, realEnabled: true, startBlock: 990, feesEnabled: false, minWithdrawalUnits: 1000, quickDepositMaxUnits: 0 });
  const a = await p.login();
  const address = a.account.address.toLowerCase();
  await p.call('/api/session', { cookie: a.cookie, body: {} });
  p.chain.transfer({ from: address, wei: tics * 10n ** 18n, block: 990 });
  p.chain.tokenBalance += house * 10n ** 18n;
  await chainTick(p.env, { rpc: p.chain.rpc });
  return { ...a, address };
}
const liabilityGap = async (p) => {
  let truth = 0;
  for (const obj of p.objects.values()) truth += obj.ticsBalance() + (obj.heldTics()?.units || 0);
  const central = (await owedUnits(p.DB)) + p.rows('SELECT COALESCE(SUM(units), 0) AS n FROM spin_holds')[0].n;
  return { truth, central, gap: truth - central };
};
const breakCopy = (obj) => {
  const realBatch = obj.env.DB.batch.bind(obj.env.DB);
  obj.env.DB.batch = async () => { throw new Error('D1 unavailable (test)'); };
  return () => { obj.env.DB.batch = realBatch; };
};
const recoverAll = async (p) => { for (const obj of p.objects.values()) await obj.alarm(); await sweepSpinHolds(p.env, Date.now() + 5 * 60_000); };

test('config: the slot game loads, its public config carries the published maths, and the limits are checked', async () => {
  const p = platform();
  try {
    const cfg = await loadGameConfig(p.DB, 'godsofpower');
    assert.equal(cfg.name, 'Gods of Power');
    assert.equal(cfg.minStakeCents, 2000);
    const pub = publicConfig(cfg);
    assert.equal(pub.math.rtp, 92);
    assert.deepEqual(pub.math.betLevels, BET_LEVELS);
    assert.equal(pub.math.strips.length, 5);
    const r = await p.call('/api/games/godsofpower/config', { cookie: await p.guest() });
    assert.equal(r.status, 200); assert.equal(r.data.math.capMultiplier, 2000);
    assert.equal(r.data.maxHouseLossCents, cfg.maxHouseLossCents, 'the slot public config carries the house loss cap');
    assert.ok(Number.isSafeInteger(r.data.maxHouseLossCents) && r.data.maxHouseLossCents > 0);
    assert.equal(pub.maxHouseLossCents, cfg.maxHouseLossCents);
    const roulettePub = (await p.call('/api/games/roulette/config', { cookie: await p.guest() })).data;
    assert.equal(roulettePub.math.id, 'standard', 'roulette config unchanged');
    assert.equal('maxHouseLossCents' in roulettePub, false, 'roulette public config unchanged');
    assert.equal(checkSlotLimits(2000, cfg), null);
    assert.equal(checkSlotLimits(2001, cfg).code, 'bad_stake');
    assert.equal(checkSlotLimits(100, cfg).code, 'bad_stake');
    assert.equal(checkSlotLimits(2000, { ...cfg, minStakeCents: 4000 }).code, 'min_stake');
    assert.equal(checkSlotLimits(1000000, { ...cfg, maxStakeCents: 500000 }).code, 'max_stake');
    assert.equal(checkSlotLimits(1000000, { ...cfg, maxWinCents: 1000 }).code, 'max_win');
    assert.equal(checkSlotLimits(2000, { ...cfg, enabled: false }).code, 'game_off');
    assert.equal(slotLimitMessage(2000 * 2000 * 5), 'The most you can bet on one spin right now is 100.00 $TICS.');
    assert.match(slotLimitMessage(10), /cannot cover/);
  } finally { p.restore(); }
});

test('the /godsofpower and /roulette pages are search pages with their own titles; unknown paths are not pages', () => {
  assert.match(pageFor('/godsofpower').title, /Gods of Power/);
  assert.match(pageFor('/roulette').title, /Roulette/);
  assert.match(pageFor('/').title, /Casino/);
  assert.equal(pageFor('/godsofpower').noindex, undefined);
  assert.equal(pageFor('/godsofpower/anything'), null);
  assert.ok(!withPageHead('<html><head><title>x</title></head></html>', pageFor('/godsofpower')).includes('noindex'));
});

test('demo round: money moves once, the round is stored, and the revealed seed reproduces every stop', async () => {
  const p = platform();
  try {
    const cookie = await p.guest();
    const before = (await p.call('/api/session', { cookie, body: {} })).data.balanceCents;
    const r = await p.spin(cookie, 2000);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const d = r.data;
    assert.equal(d.game, 'godsofpower');
    assert.equal(d.balanceAfterCents, before - 2000 + d.totalPayoutCents);
    assert.ok(Array.isArray(d.spins) && d.spins[0].stops.length === 5);
    const obj = p.objects.values().next().value;
    const round = obj.one("SELECT * FROM rounds WHERE game_id = 'godsofpower'");
    assert.equal(round.stake_cents, 2000);
    assert.equal(round.payout_cents, d.totalPayoutCents);
    assert.deepEqual(JSON.parse(round.outcome_json).spins.map((s) => s.stops), d.spins.map((s) => s.stops));
    // The central copy (what the admin reads) carries the whole slot outcome, not roulette's pocket/colour.
    const central = p.rows("SELECT outcome FROM rounds WHERE game_id = 'godsofpower'")[0];
    assert.ok(central, 'copied to the central rounds table');
    const co = JSON.parse(central.outcome);
    assert.equal(co.game, 'godsofpower');
    assert.deepEqual(co.spins.map((s) => s.stops), d.spins.map((s) => s.stops));
    const ledger = obj.sql.exec('SELECT type, amount_cents FROM ledger WHERE round_id = ?', round.id).toArray();
    assert.deepEqual(ledger.map((l) => l.type), ['bet_reserve', d.totalPayoutCents > 0 ? 'bet_settle_win' : 'bet_settle_loss']);
    const replay = playRound({ stake: 2000, uint32At: makeUint32At(d.fairness.serverSeed, d.fairness.clientSeed, d.fairness.nonce), math: SLOT_MATH });
    assert.deepEqual(replay.spins.map((s) => s.stops), d.spins.map((s) => s.stops));
    assert.equal(replay.totalPayoutUnits, d.totalPayoutCents);
    assert.equal(d.fairness.clientSeed, `${d.fairness.clientSeedBase}:${d.fairness.clientEntropy}`);
    // The next lock is new.
    assert.notEqual(d.fairness.nextCommitment.serverSeedHash, d.fairness.serverSeedHash);
  } finally { p.restore(); }
});

test('replays, reused entropy, stale locks and bad stakes', async () => {
  const p = platform();
  try {
    const cookie = await p.guest();
    const c = (await p.call('/api/fairness/commitment', { cookie })).data;
    const body = { stake: 2000, requestId: randomUUID(), expectedCommitment: c, clientEntropy: randomBytes(32).toString('hex') };
    const first = await p.call('/api/games/godsofpower/spin', { cookie, body });
    const again = await p.call('/api/games/godsofpower/spin', { cookie, body });
    assert.equal(first.status, 200); assert.deepEqual(again.data, first.data, 'same reply');
    const obj = p.objects.values().next().value;
    assert.equal(obj.one("SELECT COUNT(*) AS n FROM rounds").n, 1, 'one round');
    // Same entropy, new request: refused.
    const c2 = (await p.call('/api/fairness/commitment', { cookie })).data;
    assert.equal((await p.call('/api/games/godsofpower/spin', { cookie, body: { ...body, requestId: randomUUID(), expectedCommitment: c2 } })).status, 409);
    // Old lock: refused and nothing consumed.
    const stale = await p.call('/api/games/godsofpower/spin', { cookie, body: { stake: 2000, requestId: randomUUID(), expectedCommitment: c, clientEntropy: randomBytes(32).toString('hex') } });
    assert.equal(stale.status, 409);
    assert.equal(obj.one("SELECT COUNT(*) AS n FROM rounds").n, 1);
    assert.equal((await p.spin(cookie, 2001)).status, 400);
    assert.equal((await p.spin(cookie, 100)).status, 400);
    // A slot requestId replayed on the roulette route never returns the slot's reply.
    const slotReq = { stake: 2000, requestId: randomUUID(), expectedCommitment: (await p.call('/api/fairness/commitment', { cookie })).data, clientEntropy: randomBytes(32).toString('hex') };
    const played = await p.call('/api/games/godsofpower/spin', { cookie, body: slotReq });
    assert.equal(played.status, 200);
    const cross = await p.call('/api/games/roulette/spin', { cookie, body: { ...slotReq, bets: [{ type: 'red', amountCents: 100 }] } });
    assert.equal(cross.status, 409, JSON.stringify(cross.data));
    // The admin's max house loss applies to the slot like roulette: cap minus stake above it is refused.
    p.DB.raw.prepare("UPDATE games SET max_house_loss_cents = 3000000, config_version = config_version + 1 WHERE id = 'godsofpower'").run();
    clearConfigCache();
    const overLoss = await p.spin(cookie, 4000);
    assert.equal(overLoss.status, 400); assert.match(overLoss.data.error, /over the table limit/);
    assert.equal((await p.spin(cookie, 2001)).status, 400);
    p.DB.raw.prepare("UPDATE games SET max_house_loss_cents = 2000000000, config_version = config_version + 1 WHERE id = 'godsofpower'").run();
    clearConfigCache();
    assert.equal((await p.spin(cookie, 2000, 'demo', { mathId: 'other' })).status, 409);
    // Roulette still spins on the same session (once the one-game window has passed).
    const realNow = obj.now; obj.now = () => realNow.call(obj) + 10_000;
    const c3 = (await p.call('/api/fairness/commitment', { cookie })).data;
    const rl = await p.call('/api/games/roulette/spin', { cookie, body: { bets: [{ type: 'red', amountCents: 100 }], requestId: randomUUID(), expectedCommitment: c3, clientEntropy: randomBytes(32).toString('hex') } });
    assert.equal(rl.status, 200, JSON.stringify(rl.data));
  } finally { p.restore(); }
});

test('real round: refused for guests and when real play is off; a funded wallet plays, books the cap, and the booking is released', async () => {
  const p = platform();
  try {
    assert.equal((await p.spin(await p.guest(), 2000, 'real')).status, 403);
    const a = await funded(p, 50000n, 10000000n); // 50,000 player, 10,000,000 house
    const obj = p.env.CASINO.get(a.address);
    const bal = obj.ticsBalance();
    const r = await p.spin(a.cookie, 2000, 'real');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(obj.ticsBalance(), bal - 2000 + r.data.totalPayoutCents);
    assert.equal(p.rows('SELECT COUNT(*) AS n FROM spin_holds')[0].n, 0, 'booking released after the copy landed');
    assert.equal(p.rows('SELECT real_tics_cents AS n FROM players WHERE id = ?', a.address)[0].n, obj.ticsBalance());
    assert.equal((await liabilityGap(p)).gap, 0);
    // A bet above the table limit share is refused as a limit, not as short funds.
    assert.equal((await p.spin(a.cookie, 1000000, 'real')).status, 503);
    // Demo is closed while funded.
    assert.equal((await p.spin(a.cookie, 2000, 'demo')).status, 403);
    // Real play off.
    p.setTics({ realEnabled: false }); clearConfigCache();
    assert.equal((await p.spin(a.cookie, 2000, 'real')).status, 503);
  } finally { p.restore(); }
});

test('table limit: a bet whose cap is above the free float share is refused with one plain figure, in demo too', async () => {
  const p = platform();
  try {
    const a = await funded(p, 5000n, 100000n); // house 100,000 free: 25% = 25,000; cap 2000x means max bet 12.5 so only 20 is above
    const r = await p.spin(a.cookie, 2000, 'real');
    assert.equal(r.status, 503); assert.match(r.data.error, /cannot cover|most you can bet/);
    assert.equal(p.rows('SELECT COUNT(*) AS n FROM spin_holds')[0].n, 0, 'nothing booked for a refused round');
    const g = await p.guest();
    const d = await p.spin(g, 2000, 'demo');
    assert.equal(d.status, 503, 'demo follows the same limit');
  } finally { p.restore(); }
  const q = platform();
  try {
    const b = await funded(q, 5000n, 1000000n); // 1,000,000 free: 250,000 max win: 125 $TICS bet fits, 100 level ok, 200 not
    assert.equal((await q.spin(b.cookie, 10000, 'real')).status, 200);
    const too = await q.spin(b.cookie, 20000, 'real');
    assert.equal(too.status, 503);
    assert.equal(too.data.error, 'The most you can bet on one spin right now is 100.00 $TICS.');
  } finally { q.restore(); }
  const s = platform();
  try {
    const c = await funded(s, 15n, 1000000n); // 15 $TICS in the wallet: below the smallest 20 $TICS bet
    assert.equal((await s.spin(c.cookie, 2000, 'real')).status, 402);
  } finally { s.restore(); }
});

test('invariant: when the central copy fails, the booking stays and the bank never counts less than it owes; recovery clears it', async () => {
  const p = platform();
  try {
    const a = await funded(p, 50000n, 10000000n);
    const obj = p.env.CASINO.get(a.address);
    const restore = breakCopy(obj);
    const r = await p.spin(a.cookie, 2000, 'real');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const holds = p.rows('SELECT units FROM spin_holds');
    assert.equal(holds.length, 1, 'booking kept while the copy is pending');
    assert.equal(holds[0].units, 2000 * 2000 - 2000, 'booked the worst net win: the cap minus the stake');
    const { gap } = await liabilityGap(p);
    assert.ok(gap <= 0, `gap ${gap}`);
    restore(); await recoverAll(p);
    assert.equal(p.rows('SELECT COUNT(*) AS n FROM spin_holds')[0].n, 0);
    assert.equal((await liabilityGap(p)).gap, 0);
    assert.equal(p.rows('SELECT real_tics_cents AS n FROM players WHERE id = ?', a.address)[0].n, obj.ticsBalance());
  } finally { p.restore(); }
});

test('a round that reaches the cap pays exactly the cap', () => {
  // A maths where every stop is a wild on reels 2 to 5 and A on reel 1: every line pays W x4? no: first symbol A so A x5 = 100, all 20 lines each spin.
  const m = { ...SLOT_MATH, strips: [Array(32).fill('S'), Array(32).fill('W'), Array(32).fill('W'), Array(32).fill('W'), Array(32).fill('W')], capMultiplier: 50 };
  const r = playRound({ stake: 2000, uint32At: makeUint32At('s', 'c', 0), math: m });
  assert.equal(r.totalPayoutUnits, maxPayoutUnits(2000, m));
  assert.equal(r.capped, true);
});

test('one browser at a time: a new wallet sign in closes the other session, which is told why', async () => {
  const p = platform();
  try {
    const a = await p.login();
    assert.equal((await p.call('/api/wallet/me', { cookie: a.cookie })).status, 200);
    const b = await p.login(a.account); // same wallet, another browser
    assert.equal((await p.call('/api/wallet/me', { cookie: b.cookie })).status, 200, 'the new browser is in');
    const old = await p.call('/api/wallet/me', { cookie: a.cookie });
    assert.equal(old.status, 401);
    assert.equal(old.data.code, 'signed_in_elsewhere');
    assert.match(old.data.error, /another browser or device/);
    // A plain logout is not "elsewhere".
    await p.call('/api/wallet/logout', { cookie: b.cookie, body: {} });
    const out = await p.call('/api/wallet/me', { cookie: b.cookie });
    assert.equal(out.status, 401); assert.equal(out.data.code, undefined);
  } finally { p.restore(); }
});

test('one game and one tab at a time: a spin from another tab or game within a few seconds is refused, nothing used', async () => {
  const p = platform();
  try {
    const cookie = await p.guest();
    const spinWith = async (path, body, tab) => p.call(path, { cookie, body, headers: tab ? { 'X-Play-Tab': tab } : {} });
    const c1 = (await p.call('/api/fairness/commitment', { cookie })).data;
    const r1 = await spinWith('/api/games/godsofpower/spin', { stake: 2000, requestId: randomUUID(), expectedCommitment: c1, clientEntropy: randomBytes(32).toString('hex') }, 'tab-A');
    assert.equal(r1.status, 200, JSON.stringify(r1.data));
    // Another tab, same game, straight away: refused.
    const c2 = (await p.call('/api/fairness/commitment', { cookie })).data;
    const e2 = randomBytes(32).toString('hex');
    const r2 = await spinWith('/api/games/godsofpower/spin', { stake: 2000, requestId: randomUUID(), expectedCommitment: c2, clientEntropy: e2 }, 'tab-B');
    assert.equal(r2.status, 409); assert.equal(r2.data.code, 'other_tab'); assert.match(r2.data.error, /another tab or game/);
    // Nothing was consumed: the same lock and entropy still work from the first tab.
    const r3 = await spinWith('/api/games/godsofpower/spin', { stake: 2000, requestId: randomUUID(), expectedCommitment: c2, clientEntropy: e2 }, 'tab-A');
    assert.equal(r3.status, 200, JSON.stringify(r3.data));
    // Roulette from the same tab while the slot round is fresh: refused too (one game at a time).
    const c4 = (await p.call('/api/fairness/commitment', { cookie })).data;
    const r4 = await spinWith('/api/games/roulette/spin', { bets: [{ type: 'red', amountCents: 100 }], requestId: randomUUID(), expectedCommitment: c4, clientEntropy: randomBytes(32).toString('hex') }, 'tab-A');
    assert.equal(r4.status, 409); assert.equal(r4.data.code, 'other_tab');
    // After the window the other tab may play.
    const obj = p.objects.values().next().value;
    const realNow = obj.now; obj.now = () => realNow.call(obj) + 10_000;
    const c5 = (await p.call('/api/fairness/commitment', { cookie })).data;
    const r5 = await spinWith('/api/games/roulette/spin', { bets: [{ type: 'red', amountCents: 100 }], requestId: randomUUID(), expectedCommitment: c5, clientEntropy: randomBytes(32).toString('hex') }, 'tab-B');
    assert.equal(r5.status, 200, JSON.stringify(r5.data));
    obj.now = realNow;
    // Replays of an answered request are never refused by the guard.
    const again = await spinWith('/api/games/godsofpower/spin', { stake: 2000, requestId: r1.data.requestId, expectedCommitment: c1, clientEntropy: r1.data.fairness.clientEntropy }, 'tab-Z');
    assert.equal(again.status, 200); assert.equal(again.data.roundId, r1.data.roundId);
  } finally { p.restore(); }
});

test('staging gate: with STAGING_GATE set every page and API needs the password cookie; live (no var) is untouched', async () => {
  const p = platform();
  try {
    p.env.STAGING_GATE = 'open-sesame';
    const page = await worker.fetch(new Request(`https://${HOST}/godsofpower`), p.env, { waitUntil() {} });
    assert.equal(page.status, 401); assert.match(await page.text(), /Staging/);
    assert.equal((await p.call('/api/session', { body: {} })).status, 401);
    const bad = await worker.fetch(new Request(`https://${HOST}/staging-gate`, { method: 'POST', body: new URLSearchParams({ password: 'nope', back: '/godsofpower' }) }), p.env, { waitUntil() {} });
    assert.equal(bad.status, 401);
    const ok = await worker.fetch(new Request(`https://${HOST}/staging-gate`, { method: 'POST', body: new URLSearchParams({ password: 'open-sesame', back: '/godsofpower' }) }), p.env, { waitUntil() {} });
    assert.equal(ok.status, 303); assert.equal(ok.headers.get('location'), '/godsofpower');
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    assert.equal((await p.call('/api/session', { body: {}, cookie })).status, 200);
    const openRedirect = await worker.fetch(new Request(`https://${HOST}/staging-gate`, { method: 'POST', body: new URLSearchParams({ password: 'open-sesame', back: '//evil.example/x' }) }), p.env, { waitUntil() {} });
    assert.equal(openRedirect.headers.get('location'), '/', 'protocol relative back is ignored');
    assert.match(page.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    delete p.env.STAGING_GATE;
    assert.equal((await p.call('/api/session', { body: {} })).status, 200, 'no gate without the var');
  } finally { p.restore(); }
});
