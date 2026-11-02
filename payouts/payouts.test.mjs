import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes } from 'node:crypto';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { parseTransaction, recoverTransactionAddress, decodeFunctionData, keccak256 } from 'viem';
import payouts, { PayoutQueue, encryptKey, rowMac } from './src/index.js';
import { DemoCasino } from '../worker/index.js';
import { createD1 } from '../test-support/d1shim.mjs';
import { OFFICIAL_TICS, ERC20_ABI, TRANSFER_TOPIC } from '../worker/tics.js';

const MIGRATIONS = ['0001_platform.sql', '0002_payments.sql', '0003_tics.sql', '0004_spin_holds.sql', '0005_audit_fixes.sql', '0006_admin.sql', '0007_r3.sql'].map((f) => new URL(`../migrations/${f}`, import.meta.url).pathname);

function doStorage() {
  const db = new DatabaseSync(':memory:');
  const kv = new Map();
  return {
    db,
    sql: { exec(query, ...args) { if (/CREATE TABLE|ALTER TABLE/.test(query) && !args.length) { db.exec(query); return { toArray: () => [] }; } const rows = db.prepare(query).all(...args); return { toArray: () => rows }; } },
    transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } },
    async setAlarm() {}, async get(k) { return kv.get(k); }, async put(k, v) { kv.set(k, v); },
  };
}

// Fake Ethereum node that really checks signatures, sender, nonce, token, recipient and amount.
function fakeChain(casino) {
  const c = { chainId: 1, block: 2000, nonce: 0, token: 10n ** 24n, eth: 10n ** 18n, baseFee: 1_000_000_000n, gasEstimate: 50_000n, mempool: new Map(), receipts: new Map(), sent: [], reject: null, mineOnSend: true, noTransferLog: false };
  c.rpc = async (method, params) => {
    switch (method) {
      case 'eth_chainId': return `0x${c.chainId.toString(16)}`;
      case 'eth_blockNumber': return `0x${c.block.toString(16)}`;
      case 'eth_call': return `0x${c.token.toString(16).padStart(64, '0')}`;
      case 'eth_getBalance': return `0x${c.eth.toString(16)}`;
      case 'eth_getTransactionCount': return `0x${(params[1] === 'pending' ? c.nonce + c.mempool.size : c.nonce).toString(16)}`;
      case 'eth_getBlockByNumber': return { baseFeePerGas: `0x${c.baseFee.toString(16)}` };
      case 'eth_maxPriorityFeePerGas': return '0x59682f00';
      case 'eth_estimateGas': return `0x${c.gasEstimate.toString(16)}`;
      case 'eth_getTransactionByHash': return c.mempool.has(params[0]) || c.receipts.has(params[0]) ? { hash: params[0] } : null;
      case 'eth_getTransactionReceipt': return c.receipts.get(params[0]) || null;
      case 'eth_sendRawTransaction': {
        if (c.reject) throw new Error(c.reject);
        const raw = params[0], tx = parseTransaction(raw), from = (await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase();
        if (tx.nonce < c.nonce) throw new Error('nonce too low');
        assert.equal(from, casino, 'signed by the casino wallet');
        assert.equal(tx.to.toLowerCase(), OFFICIAL_TICS, 'sent to the official token contract');
        assert.equal(tx.value ?? 0n, 0n);
        const call = decodeFunctionData({ abi: ERC20_ABI, data: tx.data });
        assert.equal(call.functionName, 'transfer');
        const hash = keccak256(raw);
        c.sent.push({ hash, nonce: tx.nonce, to: call.args[0].toLowerCase(), amount: call.args[1], maxFee: tx.maxFeePerGas });
        c.mempool.set(hash, tx);
        if (c.mineOnSend) c.mine(hash);
        return hash;
      }
      default: throw new Error(`unexpected ${method}`);
    }
  };
  c.mine = (hash, status = '0x1') => {
    const tx = c.mempool.get(hash); c.mempool.delete(hash);
    assert.equal(tx.nonce, c.nonce, 'nonces are used in order');
    c.nonce++; c.block++;
    const args = decodeFunctionData({ abi: ERC20_ABI, data: tx.data }).args;
    const pad = (a) => `0x${a.toLowerCase().slice(2).padStart(64, '0')}`;
    const logs = status === '0x1' && !c.noTransferLog ? [{ address: OFFICIAL_TICS, topics: [TRANSFER_TOPIC, pad(casino), pad(args[0])], data: `0x${args[1].toString(16).padStart(64, '0')}`,
      transactionHash: hash, logIndex: '0x0', blockNumber: `0x${c.block.toString(16)}` }] : [];
    c.receipts.set(hash, { status, blockNumber: `0x${c.block.toString(16)}`, transactionHash: hash, logs });
    if (status === '0x1') c.token -= args[1];
  };
  return c;
}

async function setup() {
  const pk = generatePrivateKey(), account = privateKeyToAccount(pk), casino = account.address.toLowerCase();
  const kek = Buffer.from(randomBytes(32)).toString('base64');
  const DB = createD1(MIGRATIONS);
  const chain = fakeChain(casino);
  let now = Date.parse('2026-11-01T12:00:00Z');
  const objects = new Map();
  const env = { DB, INTERNAL_SECRET: 's3cret', TREASURY_SECRET: 'tr3asury', CASINO_KEY_KEK: kek, TICS_TOKEN: OFFICIAL_TICS, CHAIN_ID: '1', __rpc: chain.rpc, __now: () => now };
  env.CASINO = { idFromName: (n) => n, get: (id) => { if (!objects.has(id)) objects.set(id, new DemoCasino({ storage: doStorage() }, env)); return objects.get(id); } };
  const q = new PayoutQueue({ storage: doStorage() }, env);
  env.QUEUE = { idFromName: (n) => n, get: () => q };
  // The signer saw the treasury address long ago (N9 starts its own 48 h clock for a new address).
  await q.ctx.storage.put('treasuryPin', { address: '0x9999999999999999999999999999999999999999', since: now - 49 * 3600000 });
  DB.raw.prepare("INSERT INTO settings (key, value) VALUES ('casino_key_ct', ?)").run(JSON.stringify(await encryptKey(pk, kek)));
  const cur = JSON.parse(DB.raw.prepare("SELECT value FROM settings WHERE key = 'tics_payments'").get().value);
  DB.raw.prepare("UPDATE settings SET value = ? WHERE key = 'tics_payments'").run(JSON.stringify({ ...cur, casinoWallet: casino, realEnabled: true, treasuryAddress: '0x9999999999999999999999999999999999999999', confirmations: 1 }));
  const call = (path, body, secret = 's3cret', treasurySecret = 'tr3asury') => payouts.fetch(new Request(`https://payouts${path}`, { method: body ? 'POST' : 'GET',
    headers: { 'X-Internal-Secret': secret, ...(treasurySecret == null ? {} : { 'X-Treasury-Secret': treasurySecret }), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env).then(async (r) => ({ status: r.status, data: await r.json() }));
  // A funded player with a held withdrawal, as the game Worker would create it.
  const addPlayer = async (units) => {
    const address = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    DB.raw.prepare("INSERT INTO players (id, wallet_address) VALUES (?, ?)").run(address, address);
    await env.CASINO.get(address).fetch(new Request('https://wallet/internal/tics-deposit', { method: 'POST', headers: { 'X-Internal-Secret': 's3cret' }, body: JSON.stringify({ ref: `td:1-0x${randomBytes(32).toString('hex')}-0`, amountCents: units, playerId: address }) }));
    return address;
  };
  const withdraw = async (address, units, fee = 0) => {
    const id = randomUUID();
    await env.CASINO.get(address).fetch(new Request('https://wallet/internal/tics-hold', { method: 'POST', headers: { 'X-Internal-Secret': 's3cret' }, body: JSON.stringify({ ref: `th:${id}`, amountCents: units }) }));
    DB.raw.prepare(`INSERT INTO chain_withdrawals (id, kind, player_id, chain_id, to_address, amount_units, fee_units, send_units, status, release_at) VALUES (?, 'player', ?, 1, ?, ?, ?, ?, 'queued', ?)`)
      .run(id, address, address, units, fee, units - fee, new Date(now + 120000).toISOString().slice(0, 19).replace('T', ' '));
    return id;
  };
  const row = (id) => DB.raw.prepare('SELECT * FROM chain_withdrawals WHERE id = ?').get(id);
  const wallet = async (address) => (await env.CASINO.get(address).fetch(new Request('https://wallet/internal/wallet', { headers: { 'X-Internal-Secret': 's3cret' } }))).json();
  const settings = () => JSON.parse(DB.raw.prepare("SELECT value FROM settings WHERE key = 'tics_payments'").get().value);
  const setSettings = (patch) => DB.raw.prepare("UPDATE settings SET value = ? WHERE key = 'tics_payments'").run(JSON.stringify({ ...settings(), ...patch }));
  const alerts = (type) => DB.raw.prepare('SELECT * FROM alerts WHERE type = ?').all(type);
  return { env, DB, chain, call, addPlayer, withdraw, row, wallet, casino, settings, setSettings, alerts, q, advance: (ms) => { now += ms; }, now: () => now };
}

test('payouts Worker refuses every request without the internal secret', async () => {
  const s = await setup();
  assert.equal((await s.call('/process', {}, 'wrong')).status, 404);
  assert.equal((await s.call('/status', undefined, '')).status, 404);
  assert.equal((await s.call('/anything', {})).status, 404);
});

test('a withdrawal waits for the cooling delay, then is signed by the casino key and paid exactly once', async () => {
  const s = await setup();
  const player = await s.addPlayer(500000);
  const id = await s.withdraw(player, 200000, 100);
  await s.call('/process', {});
  assert.equal(s.row(id).status, 'queued', 'still cooling');
  assert.equal(s.chain.sent.length, 0);
  s.advance(121000);
  await s.call('/process', {});
  assert.equal(s.chain.sent.length, 1);
  assert.equal(s.chain.sent[0].to, player);
  assert.equal(s.chain.sent[0].amount, 199900n * 10n ** 16n, '1999 TICS after the fee');
  assert.equal(s.row(id).status, 'sending');
  await s.call('/process', {});
  await s.call('/process', {});
  assert.equal(s.row(id).status, 'sent');
  assert.equal(s.chain.sent.length, 1, 'never paid twice');
  const w = await s.wallet(player);
  assert.equal(w.realTicsCents, 300000);
  assert.equal(w.pendingWithdrawals, 0);
  assert.equal(w.ticsReconciled, true);
});

test('pause stops payouts; cancel during cooling returns the money; parallel runs never double-send', async () => {
  const s = await setup();
  const a = await s.addPlayer(100000), b = await s.addPlayer(100000);
  const idA = await s.withdraw(a, 50000), idB = await s.withdraw(b, 60000);
  assert.equal((await s.call('/cancel', { id: idA, by: 'owner@x' })).status, 200);
  assert.equal(s.row(idA).status, 'cancelled');
  assert.equal((await s.wallet(a)).realTicsCents, 100000);
  const cur = JSON.parse(s.DB.raw.prepare("SELECT value FROM settings WHERE key = 'tics_payments'").get().value);
  s.DB.raw.prepare("UPDATE settings SET value = ? WHERE key = 'tics_payments'").run(JSON.stringify({ ...cur, payoutsPaused: true }));
  s.advance(200000);
  await s.call('/process', {});
  assert.equal(s.chain.sent.length, 0, 'paused');
  s.DB.raw.prepare("UPDATE settings SET value = ? WHERE key = 'tics_payments'").run(JSON.stringify({ ...cur, payoutsPaused: false }));
  s.chain.mineOnSend = false;
  await Promise.all([s.call('/process', {}), s.call('/process', {}), s.call('/process', {})]);
  assert.equal(s.chain.sent.length, 1, 'one send for one withdrawal');
  assert.equal((await s.call('/cancel', { id: idB })).status, 409, 'cannot cancel once sending');
});

test('a reverted payout refunds the player and pauses payouts; a nonce taken by a manual send frees the row without re-signing', async () => {
  const s = await setup();
  const a = await s.addPlayer(100000);
  const id = await s.withdraw(a, 40000);
  s.advance(130000);
  s.chain.mineOnSend = false;
  await s.call('/process', {});
  s.chain.mine(s.chain.sent[0].hash, '0x0');
  s.chain.block += 11; // a revert is refunded only at 12 confirmations (or finalized)
  await s.call('/process', {});
  assert.equal(s.row(id).status, 'failed');
  assert.equal((await s.wallet(a)).realTicsCents, 100000, 'money returned');
  assert.equal(JSON.parse(s.DB.raw.prepare("SELECT value FROM settings WHERE key = 'tics_payments'").get().value).payoutsPaused, true);

  const s2 = await setup();
  s2.env.__rpc2 = s2.chain.rpc; // an honest second provider (ETH_RPC_URL_2) confirms nothing of ours was mined
  const p = await s2.addPlayer(100000);
  const id2 = await s2.withdraw(p, 30000);
  s2.advance(130000);
  s2.chain.mineOnSend = false;
  await s2.call('/process', {});
  const first = s2.chain.sent[0];
  // The owner sends a manual transaction with the same nonce; ours is dropped.
  s2.chain.mempool.delete(first.hash); s2.chain.nonce++;
  s2.advance(60000); await s2.call('/process', {});
  assert.equal(s2.row(id2).status, 'sending', 'waits before deciding');
  s2.advance(200000); await s2.call('/process', {});
  assert.equal(s2.row(id2).status, 'sending', 'first run with no receipt only notes the time');
  s2.advance(5 * 60 * 1000); await s2.call('/process', {});
  // Never paid, and never re-signed at a new nonce: the row is freed and the player's money returned.
  assert.equal(s2.row(id2).status, 'failed');
  assert.equal(s2.row(id2).nonce, 0, 'the signed nonce is kept on the row');
  assert.equal(s2.chain.sent.length, 1, 'no second transaction signed');
  assert.equal((await s2.wallet(p)).realTicsCents, 100000, 'money returned');
  assert.equal(s2.alerts('tics_nonce_taken').length, 1);
  await s2.call('/process', {});
  assert.equal((await s2.wallet(p)).realTicsCents, 100000, 'refunded once');
});

test('a stuck payout is replaced with the same nonce and a higher fee', async () => {
  const s = await setup();
  const a = await s.addPlayer(100000);
  const id = await s.withdraw(a, 10000);
  s.advance(130000);
  s.chain.mineOnSend = false;
  await s.call('/process', {});
  s.advance(6 * 60 * 1000);
  await s.call('/process', {});
  assert.equal(s.chain.sent.length, 2);
  assert.equal(s.chain.sent[0].nonce, s.chain.sent[1].nonce);
  assert.ok(s.chain.sent[1].maxFee > s.chain.sent[0].maxFee);
  s.chain.mempool.delete(s.chain.sent[0].hash);
  s.chain.mine(s.chain.sent[1].hash);
  await s.call('/process', {});
  assert.equal(s.row(id).status, 'sent');
});

test('treasury send: only up to the free float, to the saved treasury address', async () => {
  const s = await setup();
  s.chain.token = 1000n * 10n ** 18n; // 1,000 TICS in the casino wallet
  await s.addPlayer(30000); // 300 TICS owed
  s.DB.raw.prepare('UPDATE players SET real_tics_cents = 30000').run();
  const st = await s.call('/status');
  assert.equal(st.data.freeUnits, 70000);
  assert.equal((await s.call('/treasury', { id: randomUUID(), amountUnits: 70001, requestedBy: 'owner' })).status, 400);
  const ok = await s.call('/treasury', { id: randomUUID(), amountUnits: 50000, requestedBy: 'owner' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(s.chain.sent.length, 1);
  assert.equal(s.chain.sent[0].to, '0x9999999999999999999999999999999999999999');
  assert.equal(s.chain.sent[0].amount, 500n * 10n ** 18n);
});

test('a key that does not match the casino wallet is never used and payouts pause', async () => {
  const s = await setup();
  const other = generatePrivateKey();
  s.DB.raw.prepare("UPDATE settings SET value = ? WHERE key = 'casino_key_ct'").run(JSON.stringify(await encryptKey(other, s.env.CASINO_KEY_KEK)));
  const a = await s.addPlayer(100000);
  const id = await s.withdraw(a, 10000);
  s.advance(130000);
  await s.call('/process', {});
  assert.equal(s.chain.sent.length, 0);
  assert.equal(s.row(id).status, 'queued');
  assert.equal(JSON.parse(s.DB.raw.prepare("SELECT value FROM settings WHERE key = 'tics_payments'").get().value).payoutsPaused, true);
});

test('if closing the hold fails, the payout stays open and the next run closes it (never stuck held)', async () => {
  const s = await setup();
  const player = await s.addPlayer(500000);
  const id = await s.withdraw(player, 200000, 100);
  s.advance(121000);
  await s.call('/process', {});
  assert.equal(s.row(id).status, 'sending');
  const realGet = s.env.CASINO.get;
  s.env.CASINO.get = (n) => { const o = realGet(n); return { fetch: async (req) => (new URL(req.url).pathname === '/internal/tics-finalise' ? Response.json({ error: 'down' }, { status: 503 }) : o.fetch(req)) }; };
  await s.call('/process', {});
  await s.call('/process', {});
  assert.equal(s.row(id).status, 'sending', 'not marked sent while the hold is still open');
  assert.equal((await s.wallet(player)).pendingWithdrawals, 1);
  s.env.CASINO.get = realGet;
  await s.call('/process', {});
  assert.equal(s.row(id).status, 'sent');
  const w = await s.wallet(player);
  assert.equal(w.pendingWithdrawals, 0);
  assert.equal(w.realTicsCents, 300000);
  assert.equal(s.chain.sent.length, 1, 'paid once');
});

test('a lost reply from the node after broadcast never leads to a second payment', async () => {
  const s = await setup();
  const player = await s.addPlayer(500000);
  const id = await s.withdraw(player, 200000);
  s.advance(121000);
  // The node accepts the transaction but the reply is lost (timeout).
  const send = s.chain.rpc;
  let lose = true;
  s.chain.rpc = async (method, params) => {
    if (method === 'eth_sendRawTransaction' && lose) { lose = false; await send(method, params); throw new Error('fetch failed: network timeout'); }
    return send(method, params);
  };
  s.env.__rpc = s.chain.rpc;
  await s.call('/process', {});
  for (let i = 0; i < 4; i++) { s.advance(60000); await s.call('/process', {}); }
  assert.equal(s.chain.sent.length, 1, 'paid exactly once');
  assert.equal(s.row(id).status, 'sent');
  const w = await s.wallet(player);
  assert.equal(w.realTicsCents, 300000);
  assert.equal(w.ticsReconciled, true);
});

test('a lost reply before the node saw it: the same signed transaction is re-sent, never a new one', async () => {
  const s = await setup();
  const player = await s.addPlayer(500000);
  const id = await s.withdraw(player, 200000);
  s.advance(121000);
  const send = s.chain.rpc;
  let fail = true;
  s.chain.rpc = async (method, params) => {
    if (method === 'eth_sendRawTransaction' && fail) { fail = false; throw new Error('fetch failed: socket hang up'); }
    return send(method, params);
  };
  s.env.__rpc = s.chain.rpc;
  await s.call('/process', {});
  const first = s.row(id);
  for (let i = 0; i < 4; i++) { s.advance(60000); await s.call('/process', {}); }
  assert.equal(s.chain.sent.length, 1, 'paid exactly once');
  assert.equal(s.chain.sent[0].hash, first.tx_hash, 'the originally signed transaction');
  assert.equal(s.row(id).status, 'sent');
});

// ---------- audit fixes (2026-10-30) ----------
const past = (s) => new Date(s.now() - 1000).toISOString().slice(0, 19).replace('T', ' ');
const insertRow = (s, r) => s.DB.raw.prepare(`INSERT INTO chain_withdrawals (id, kind, player_id, chain_id, to_address, amount_units, fee_units, send_units, status, release_at, row_mac, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(r.id, r.kind, r.player_id ?? null, r.chain_id ?? 1, r.to_address, r.amount_units, r.fee_units ?? 0, r.send_units ?? r.amount_units,
  r.status ?? 'queued', r.release_at ?? past(s), r.row_mac ?? null, r.updated_at ?? past(s));

test('H1: only one open treasury send; a reused id is "already used"; spin holds and a fresh treasury address block sends', async () => {
  const s = await setup();
  s.chain.token = 1000n * 10n ** 18n;
  s.chain.mineOnSend = false;
  const id1 = randomUUID();
  const first = await s.call('/treasury', { id: id1, amountUnits: 30000, requestedBy: 'owner' });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(s.row(id1).status, 'sending');
  const second = await s.call('/treasury', { id: randomUUID(), amountUnits: 30000, requestedBy: 'owner' });
  assert.equal(second.status, 409);
  assert.match(second.data.error, /already in progress/);
  assert.equal(s.chain.sent.length, 1, 'the second send was never signed');
  const again = await s.call('/treasury', { id: id1, amountUnits: 30000 });
  assert.equal(again.status, 409);
  assert.equal(again.data.alreadyUsed, true);
  assert.equal(again.data.sent, undefined, 'does not claim anything was sent');
  s.chain.mine(s.chain.sent[0].hash);
  await s.call('/process', {});
  assert.equal(s.row(id1).status, 'sent');
  // Spin holds are not free money: 700 TICS left, 650 booked by an open spin.
  s.DB.raw.prepare('INSERT INTO spin_holds (id, player_id, units, expires_at) VALUES (?, ?, ?, ?)').run('h1', 'x', 65000, s.now() + 60000);
  assert.equal((await s.call('/status')).data.freeUnits, 5000);
  assert.equal((await s.call('/treasury', { id: randomUUID(), amountUnits: 6000 })).status, 400);
  s.DB.raw.prepare('DELETE FROM spin_holds').run();
  s.setSettings({ treasuryAddressSetAt: new Date(s.now() - 3600000).toISOString() });
  const young = await s.call('/treasury', { id: randomUUID(), amountUnits: 1000 });
  assert.equal(young.status, 409);
  assert.match(young.data.error, /48 hours/);
  s.setSettings({ treasuryAddressSetAt: new Date(s.now() - 49 * 3600000).toISOString() });
  assert.equal((await s.call('/treasury', { id: randomUUID(), amountUnits: 1000 })).status, 200);
});

test('H1: free float is checked again right before a treasury row is signed', async () => {
  const s = await setup();
  s.chain.token = 1000n * 10n ** 18n;
  const id = randomUUID(), to = '0x9999999999999999999999999999999999999999';
  const r = { id, kind: 'treasury', to_address: to, amount_units: 80000, send_units: 80000, fee_units: 0, chain_id: 1 };
  insertRow(s, { ...r, row_mac: await rowMac(s.env, r) });
  // Players became owed 300 TICS after the row was created: 800 + 300 > 1,000.
  await s.addPlayer(30000);
  await s.call('/process', {});
  assert.equal(s.chain.sent.length, 0, 'never signed');
  assert.equal(s.row(id).status, 'blocked');
  assert.match(s.row(id).last_error, /owed to players/);
  assert.equal(s.alerts('tics_payout_refused').length, 1);
});

test('H2: a forged player row with no held money is never signed; payouts pause', async () => {
  const s = await setup();
  const player = await s.addPlayer(100000);
  const id = randomUUID();
  insertRow(s, { id, kind: 'player', player_id: player, to_address: player, amount_units: 90000 });
  // And one whose hold exists but for a smaller amount.
  const id2 = await s.withdraw(player, 1000);
  s.DB.raw.prepare('UPDATE chain_withdrawals SET amount_units = 50000, send_units = 50000 WHERE id = ?').run(id2);
  s.advance(130000);
  await s.call('/process', {});
  assert.equal(s.chain.sent.length, 0);
  assert.equal(s.row(id).status, 'blocked');
  assert.match(s.row(id).last_error, /no matching money held/);
  assert.equal(s.settings().payoutsPaused, true);
  assert.ok(s.alerts('tics_payout_refused').length >= 1);
  s.setSettings({ payoutsPaused: false });
  await s.call('/process', {});
  assert.equal(s.row(id2).status, 'blocked', 'hold amount does not match the row');
  assert.equal(s.chain.sent.length, 0);
  const w = await s.wallet(player);
  assert.equal(w.realTicsCents, 99000, 'a refused row is never refunded automatically');
  assert.equal(w.pendingWithdrawals, 1);
});

test('H2: a treasury row with a bad MAC or an old address is refused; a wrong token or chain pauses', async () => {
  const s = await setup();
  s.chain.token = 1000n * 10n ** 18n;
  const to = '0x9999999999999999999999999999999999999999';
  const forged = randomUUID();
  insertRow(s, { id: forged, kind: 'treasury', to_address: to, amount_units: 1000, row_mac: 'A'.repeat(43) });
  await s.call('/process', {});
  assert.equal(s.row(forged).status, 'blocked');
  assert.match(s.row(forged).last_error, /not authenticated/);
  assert.equal(s.settings().payoutsPaused, true);
  // A real MAC, but the address in the row is not the current treasury address.
  s.setSettings({ payoutsPaused: false });
  const old = randomUUID(), r = { id: old, kind: 'treasury', to_address: '0x8888888888888888888888888888888888888888', amount_units: 1000, send_units: 1000, fee_units: 0, chain_id: 1 };
  insertRow(s, { ...r, row_mac: await rowMac(s.env, r) });
  await s.call('/process', {});
  assert.equal(s.row(old).status, 'blocked');
  assert.match(s.row(old).last_error, /not the current treasury address/);
  // Edited amount after the MAC was made.
  s.setSettings({ payoutsPaused: false });
  const edited = randomUUID(), r2 = { id: edited, kind: 'treasury', to_address: to, amount_units: 1000, send_units: 1000, fee_units: 0, chain_id: 1 };
  insertRow(s, { ...r2, amount_units: 90000, row_mac: await rowMac(s.env, r2) });
  await s.call('/process', {});
  assert.equal(s.row(edited).status, 'blocked');
  assert.equal(s.chain.sent.length, 0);
  // Settings point at another token: nothing is signed, payouts pause.
  s.setSettings({ payoutsPaused: false, token: '0xad34bb0000000000000000000000000000a177' });
  const p = await s.addPlayer(100000), id = await s.withdraw(p, 1000);
  s.advance(130000);
  await s.call('/process', {});
  assert.equal(s.row(id).status, 'queued');
  assert.equal(s.chain.sent.length, 0);
  assert.match(s.settings().pausedReason, /pinned/);
  // A row for another chain.
  s.setSettings({ payoutsPaused: false, token: OFFICIAL_TICS });
  s.DB.raw.prepare('UPDATE chain_withdrawals SET chain_id = 5 WHERE id = ?').run(id);
  await s.call('/process', {});
  assert.equal(s.chain.sent.length, 0);
  assert.equal(s.settings().payoutsPaused, true);
});

test('H5: a reverted payout waits for the confirmations before the money is returned', async () => {
  const s = await setup();
  s.setSettings({ confirmations: 3 });
  const a = await s.addPlayer(100000);
  const id = await s.withdraw(a, 40000);
  s.advance(130000);
  s.chain.mineOnSend = false;
  await s.call('/process', {});
  s.chain.mine(s.chain.sent[0].hash, '0x0');
  await s.call('/process', {});
  assert.equal(s.row(id).status, 'sending', 'one confirmation is not enough');
  assert.equal((await s.wallet(a)).pendingWithdrawals, 1, 'still held');
  s.chain.block += 2;
  await s.call('/process', {});
  assert.equal(s.row(id).status, 'sending', 'N8: 3 confirmations are not enough to refund a revert');
  s.chain.block += 9;
  await s.call('/process', {});
  assert.equal(s.row(id).status, 'failed');
  assert.equal((await s.wallet(a)).realTicsCents, 100000);
});

test('H5: a receipt for a different hash is ignored; a 409 from the wallet alerts and does not block the queue', async () => {
  const s = await setup();
  const a = await s.addPlayer(100000), b = await s.addPlayer(100000);
  const idA = await s.withdraw(a, 10000), idB = await s.withdraw(b, 10000);
  s.advance(130000);
  s.chain.mineOnSend = false;
  await s.call('/process', {});
  assert.equal(s.chain.sent.length, 2);
  // The hold of A was already released by someone else: finalise answers 409.
  await s.env.CASINO.get(a).fetch(new Request('https://wallet/internal/tics-release', { method: 'POST', headers: { 'X-Internal-Secret': 's3cret' }, body: JSON.stringify({ ref: `th:${idA}` }) }));
  const real = s.chain.rpc;
  let lie = true;
  s.env.__rpc = async (m, p) => { const r = await real(m, p); return lie && m === 'eth_getTransactionReceipt' && r ? { ...r, transactionHash: `0x${'ab'.repeat(32)}` } : r; };
  s.chain.mine(s.chain.sent[0].hash); s.chain.mine(s.chain.sent[1].hash);
  await s.call('/process', {});
  assert.equal(s.row(idA).status, 'sending', 'a mismatched receipt is not trusted');
  assert.equal(s.alerts('tics_rpc_mismatch').length >= 1, true);
  lie = false;
  await s.call('/process', {});
  assert.equal(s.row(idA).status, 'blocked', 'conflict left for a person (still owed)');
  assert.equal(s.alerts('tics_hold_conflict').length, 1);
  assert.equal(s.row(idB).status, 'sent', 'the next row was still processed');
});

test('M1: fees above the cap wait with a warning; the cap can be raised in settings; a huge gas estimate is refused', async () => {
  const s = await setup();
  const a = await s.addPlayer(100000);
  const id = await s.withdraw(a, 10000);
  s.advance(130000);
  s.chain.baseFee = 60_000_000_000n; // 60 gwei, cap 50
  await s.call('/process', {});
  await s.call('/process', {});
  assert.equal(s.chain.sent.length, 0);
  assert.equal(s.row(id).status, 'queued');
  assert.equal(s.alerts('tics_gas_cap').length, 1, 'one warning per hour');
  s.setSettings({ maxFeeGwei: 100, maxTipGwei: 1 });
  s.chain.mineOnSend = false;
  await s.call('/process', {});
  assert.equal(s.chain.sent.length, 1);
  assert.ok(s.chain.sent[0].maxFee <= 100_000_000_000n);
  const tx = parseTransaction(s.DB.raw.prepare('SELECT raw_tx FROM chain_withdrawals WHERE id = ?').get(id).raw_tx);
  assert.ok(tx.maxPriorityFeePerGas <= 1_000_000_000n, 'tip capped');
  // The bump is capped too: at the cap nothing new is signed and an alert is raised.
  s.setSettings({ maxFeeGwei: 100 });
  s.chain.baseFee = 90_000_000_000n;
  s.advance(6 * 60 * 1000);
  await s.call('/process', {});
  s.advance(11 * 60 * 1000);
  await s.call('/process', {});
  for (const t of s.chain.sent) assert.ok(t.maxFee <= 100_000_000_000n);
  assert.ok(s.alerts('tics_bump_failed').length >= 1);
  // Gas limit cap.
  const s2 = await setup();
  const p = await s2.addPlayer(100000), id2 = await s2.withdraw(p, 10000);
  s2.advance(130000);
  s2.chain.gasEstimate = 150_000n;
  await s2.call('/process', {});
  assert.equal(s2.chain.sent.length, 0);
  assert.equal(s2.row(id2).status, 'queued');
  assert.equal(s2.alerts('tics_gas_limit').length, 1);
});

test('M2/L2/L5: a clear rejection is replaced at the SAME nonce with >=10% more; nonce too low refreshes from the chain', async () => {
  const s = await setup();
  const a = await s.addPlayer(100000), id = await s.withdraw(a, 10000);
  s.advance(130000);
  const real = s.chain.rpc;
  let once = true;
  s.env.__rpc = async (m, p) => { if (m === 'eth_sendRawTransaction' && once) { once = false; throw new Error('RPC eth_sendRawTransaction: transaction underpriced'); } return real(m, p); };
  await s.call('/process', {});
  const r = s.row(id);
  assert.equal(JSON.parse(r.tx_hashes).length, 2, 'signed twice');
  assert.equal(s.chain.sent.length, 1, 'only the replacement reached the chain');
  assert.equal(s.chain.sent[0].nonce, 0, 'same nonce');
  const [t1, t2] = JSON.parse(r.tx_hashes);
  assert.notEqual(t1, t2);
  await s.call('/process', {});
  assert.equal(s.row(id).status, 'sent');

  // R3-P1: 'nonce too low' is not proof the bytes were refused, so the row is never signed again at a new nonce.
  const s2 = await setup();
  const p = await s2.addPlayer(100000), id2 = await s2.withdraw(p, 10000);
  s2.advance(130000);
  s2.chain.nonce = 3; // three manual sends happened, but the node's first 'pending' answer is stale
  const real2 = s2.chain.rpc;
  let stale = true;
  s2.env.__rpc = async (m, p) => { if (m === 'eth_getTransactionCount' && p[1] === 'pending' && stale) { stale = false; return '0x0'; } return real2(m, p); };
  await s2.call('/process', {});
  assert.equal(JSON.parse(s2.row(id2).tx_hashes).length, 1, 'signed once at 0 and never again at a new nonce');
  assert.equal(s2.chain.sent.length, 0);
  assert.equal(s2.row(id2).status, 'sending');
  assert.equal(s2.row(id2).nonce, 0);
  assert.equal(await s2.q.ctx.storage.get('nextNonce'), 3, 'later rows use the fresh nonce');
  // No second provider: once the nonce is final and nothing shows on two runs, a person decides.
  s2.advance(4 * 60000); await s2.call('/process', {});
  s2.advance(5 * 60000); await s2.call('/process', {});
  assert.equal(s2.row(id2).status, 'blocked');
  assert.equal(s2.chain.sent.length, 0);
  assert.equal((await s2.wallet(p)).pendingWithdrawals, 1, 'not refunded automatically');
  assert.equal(s2.settings().payoutsPaused, false, 'one unconfirmed row does not pause the rest');
  // The owner checked Etherscan: Return to player re-checks the chain, then refunds.
  const back = await s2.call('/resolve', { id: id2, by: 'owner' });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  assert.equal(s2.row(id2).status, 'cancelled');
  assert.equal((await s2.wallet(p)).realTicsCents, 100000);
});

test('M3: a mined receipt without the expected Transfer log is never finalised or refunded', async () => {
  const s = await setup();
  const a = await s.addPlayer(100000);
  const id = await s.withdraw(a, 10000);
  s.advance(130000);
  s.chain.noTransferLog = true;
  await s.call('/process', {});
  await s.call('/process', {});
  await s.call('/process', {});
  assert.equal(s.row(id).status, 'blocked', 'stopped for review, still counted as owed');
  assert.match(s.row(id).last_error, /without the expected Transfer/);
  assert.equal(s.settings().payoutsPaused, true);
  assert.equal(s.alerts('tics_no_transfer').length, 1);
  const w = await s.wallet(a);
  assert.equal(w.pendingWithdrawals, 1, 'not finalised');
  assert.equal(w.realTicsCents, 90000, 'not refunded');
});

test('M4: a row stuck in signing for 5 minutes goes back to the queue and is paid once; a fresh one is left alone', async () => {
  const s = await setup();
  const a = await s.addPlayer(100000);
  const id = await s.withdraw(a, 10000);
  s.advance(130000);
  const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  s.DB.raw.prepare("UPDATE chain_withdrawals SET status = 'signing', updated_at = ? WHERE id = ?").run(stamp(s.now() - 60000), id);
  await s.call('/process', {});
  assert.equal(s.row(id).status, 'signing', 'too recent to sweep');
  s.advance(5 * 60 * 1000);
  await s.call('/process', {});
  assert.equal(s.chain.sent.length, 1);
  await s.call('/process', {});
  assert.equal(s.row(id).status, 'sent');
});

test('L3/L6: a refund that failed at cancel time is retried until done; a cron tick during a run is skipped', async () => {
  const s = await setup();
  const a = await s.addPlayer(100000);
  const id = await s.withdraw(a, 10000);
  const realGet = s.env.CASINO.get;
  s.env.CASINO.get = (n) => { const o = realGet(n); return { fetch: async (req) => (new URL(req.url).pathname === '/internal/tics-release' ? Response.json({ error: 'down' }, { status: 503 }) : o.fetch(req)) }; };
  const c = await s.call('/cancel', { id });
  assert.equal(c.status, 200);
  assert.equal(c.data.refundPending, true);
  s.env.CASINO.get = realGet;
  s.advance(2 * 60 * 60 * 1000); // long after any time window
  await s.call('/process', {});
  assert.equal((await s.wallet(a)).realTicsCents, 100000);
  // L6
  let release;
  const real = s.chain.rpc;
  s.env.__rpc = async (m, p) => { if (m === 'eth_getBlockByNumber' && !release) await new Promise((r) => { release = r; }); return real(m, p); };
  const b = await s.addPlayer(100000); await s.withdraw(b, 1000); s.advance(130000);
  s.chain.mineOnSend = false;
  const first = s.call('/process', {});
  await new Promise((r) => setTimeout(r, 20));
  const cron = await s.q.fetch(new Request('https://queue/process', { method: 'POST', body: JSON.stringify({ cron: true }) })).then((r) => r.json());
  assert.match(cron.skipped || '', /in progress/);
  release?.();
  await first;
  s.env.__rpc = real;
});

test('L4: pause only sets the pause fields and keeps the first reason', async () => {
  const s = await setup();
  s.setSettings({ token: '0x0000000000000000000000000000000000000001', minWithdrawalUnits: 4242 });
  await s.call('/process', {});
  const first = s.settings();
  assert.equal(first.payoutsPaused, true);
  assert.equal(first.minWithdrawalUnits, 4242);
  assert.match(first.pausedReason, /pinned/);
});

// ---------- re-audit fixes (2026-10-30, round 2) ----------
const owedNow = async (s) => (await s.call('/status')).data.owedUnits;
const failWallet = (s, address, op, status) => {
  const real = s.env.CASINO.get(address), orig = real.fetch.bind(real);
  const state = { on: true };
  real.fetch = (req) => (state.on && req.url.endsWith(`/${op}`) ? Promise.resolve(Response.json({ error: 'down' }, { status })) : orig(req));
  return state;
};

test('N1: a lagging node with no receipt never frees a paid row; hashes come from the signer, not D1', async () => {
  const s = await setup();
  s.chain.mineOnSend = false;
  const p = await s.addPlayer(500000);
  const id = await s.withdraw(p, 200000);
  s.advance(121000);
  await s.call('/process', {});
  const h = s.chain.sent[0].hash;
  s.chain.mine(h); s.chain.block += 5;
  const rc = s.chain.receipts.get(h);
  s.chain.receipts.delete(h); // the node behind the load balancer has not indexed the receipt yet
  s.DB.raw.prepare("UPDATE chain_withdrawals SET tx_hashes = '[]', tx_hash = NULL WHERE id = ?").run(id); // and D1 lost the hashes
  s.advance(4 * 60 * 1000);
  await s.call('/process', {});
  assert.equal(s.row(id).status, 'sending', 'one run without a receipt is not proof');
  s.advance(60 * 1000);
  await s.call('/process', {});
  assert.equal(s.row(id).status, 'sending', 'two runs only 1 minute apart are not proof either');
  s.chain.receipts.set(h, rc);
  await s.call('/process', {});
  assert.equal(s.row(id).status, 'sent', 'found through the hash kept by the signer');
  const w = await s.wallet(p);
  assert.equal(w.realTicsCents, 300000, 'never refunded');
  assert.equal(w.pendingWithdrawals, 0);
});

test('N1: a row failed as "nonce taken" whose hash later shows up mined raises a critical alert and pauses', async () => {
  const s = await setup();
  s.env.__rpc2 = s.chain.rpc;
  const p = await s.addPlayer(100000);
  const id = await s.withdraw(p, 30000);
  s.advance(130000);
  s.chain.mineOnSend = false;
  await s.call('/process', {});
  const first = s.chain.sent[0];
  s.chain.mempool.delete(first.hash); s.chain.nonce++;
  s.advance(4 * 60 * 1000); await s.call('/process', {});
  s.advance(5 * 60 * 1000); await s.call('/process', {});
  assert.equal(s.row(id).status, 'failed');
  assert.equal(s.settings().payoutsPaused, false);
  // A reorg (or a lying node earlier) - our transaction is mined after all.
  s.chain.receipts.set(first.hash, { status: '0x1', blockNumber: `0x${s.chain.block.toString(16)}`, transactionHash: first.hash, logs: [] });
  await s.call('/process', {});
  assert.equal(s.alerts('tics_failed_but_mined').length, 1);
  assert.equal(s.settings().payoutsPaused, true);
});

test('N2/N4: a row is never signed again at a new nonce: sent treasury row flipped back, player row flipped back while pending', async () => {
  const s = await setup();
  const t = randomUUID();
  assert.equal((await s.call('/treasury', { id: t, amountUnits: 1000, requestedBy: 'owner' })).status, 200);
  await s.call('/process', {});
  assert.equal(s.row(t).status, 'sent');
  s.DB.raw.prepare("UPDATE chain_withdrawals SET status = 'queued', nonce = NULL, raw_tx = NULL, tx_hash = NULL WHERE id = ?").run(t);
  await s.call('/process', {});
  assert.equal(s.chain.sent.length, 1, 'the sent treasury row is never signed again');
  assert.equal(s.row(t).status, 'blocked');
  assert.equal(s.settings().payoutsPaused, true);

  const s2 = await setup();
  s2.chain.mineOnSend = false;
  const p = await s2.addPlayer(500000);
  const id = await s2.withdraw(p, 200000);
  s2.advance(121000);
  await s2.call('/process', {});
  assert.equal(s2.row(id).status, 'sending');
  s2.DB.raw.prepare("UPDATE chain_withdrawals SET status = 'queued', nonce = NULL, raw_tx = NULL, tx_hash = NULL, tx_hashes = '[]' WHERE id = ?").run(id);
  await s2.call('/process', {});
  assert.equal(s2.chain.sent.length, 1, 'not signed at a second nonce');
  assert.equal(s2.row(id).status, 'blocked');
  assert.equal(s2.settings().payoutsPaused, true);
  assert.equal(s2.alerts('tics_payout_refused').length, 1);
  assert.equal((await s2.wallet(p)).pendingWithdrawals, 1, 'money still held');
});

test('N2: a bump never trusts the nonce, address or amount in D1', async () => {
  const s = await setup();
  s.chain.mineOnSend = false;
  const p = await s.addPlayer(100000);
  const id = await s.withdraw(p, 10000);
  s.advance(130000);
  await s.call('/process', {});
  s.DB.raw.prepare("UPDATE chain_withdrawals SET to_address = '0x7777777777777777777777777777777777777777', send_units = 90000 WHERE id = ?").run(id);
  s.advance(6 * 60 * 1000);
  await s.call('/process', {});
  assert.equal(s.chain.sent.length, 1, 'no replacement signed');
  assert.equal(s.row(id).status, 'blocked');
  // A forged 'sending' row this signer never signed is never bumped either.
  const s2 = await setup();
  const q = await s2.addPlayer(100000);
  const fid = await s2.withdraw(q, 10000);
  const any = await s.DB.raw.prepare('SELECT raw_tx FROM chain_withdrawals WHERE id = ?').get(id).raw_tx;
  s2.DB.raw.prepare("UPDATE chain_withdrawals SET status = 'sending', nonce = 0, raw_tx = ?, tx_hash = ?, tx_hashes = ?, max_fee_wei = '1', broadcast_at = '2026-11-01 11:00:00' WHERE id = ?")
    .run(any, keccak256(any), JSON.stringify([keccak256(any)]), fid);
  await s2.call('/process', {});
  assert.equal(s2.chain.sent.length, 0, 'nothing signed or re-broadcast for a row with no signing record');
  assert.equal(s2.row(fid).status, 'blocked');
});

test('N3: the MAC covers send_units and fee_units; a treasury row must send its whole amount with no fee', async () => {
  const s = await setup();
  s.chain.baseFee = 60_000_000_000n; // above the cap: the row goes back to the queue unsigned
  const id = randomUUID();
  assert.equal((await s.call('/treasury', { id, amountUnits: 1000, requestedBy: 'owner' })).status, 200);
  assert.equal(s.row(id).status, 'queued');
  s.DB.raw.prepare('UPDATE chain_withdrawals SET send_units = ? WHERE id = ?').run(5_000_000, id);
  s.chain.baseFee = 1_000_000_000n;
  await s.call('/process', {});
  assert.equal(s.chain.sent.length, 0, 'edited send amount is never signed');
  assert.equal(s.row(id).status, 'blocked');
  assert.match(s.row(id).last_error, /not authenticated/);
  // Even with a valid MAC over it, a treasury row with a fee or a short send is refused.
  s.setSettings({ payoutsPaused: false });
  await s.q.ctx.storage.put('securityPause', null);
  const id2 = randomUUID(), r = { id: id2, kind: 'treasury', to_address: '0x9999999999999999999999999999999999999999', amount_units: 1000, send_units: 900, fee_units: 100, chain_id: 1 };
  insertRow(s, { ...r, row_mac: await rowMac(s.env, r) });
  await s.call('/process', {});
  assert.equal(s.chain.sent.length, 0);
  assert.equal(s.row(id2).status, 'blocked');
  assert.match(s.row(id2).last_error, /whole amount with no fee/);
});

test('N5: a double cancel keeps the refund retry; the row is "cancelling" (owed) until the money is back', async () => {
  const s = await setup();
  const p = await s.addPlayer(500000);
  const id = await s.withdraw(p, 200000);
  const owedBefore = await owedNow(s);
  const down = failWallet(s, p, 'tics-release', 503);
  const c1 = await s.call('/cancel', { id, by: 'a' });
  assert.equal(c1.status, 200);
  assert.equal(c1.data.refundPending, true);
  assert.equal(s.row(id).status, 'cancelling');
  const c2 = await s.call('/cancel', { id, by: 'a' });
  assert.equal(c2.status, 200);
  assert.equal(c2.data.alreadyCancelled, true);
  assert.equal(await owedNow(s), owedBefore, 'still owed while the refund is pending');
  down.on = false;
  s.advance(60000);
  await s.call('/process', {});
  assert.equal(s.row(id).status, 'cancelled');
  const w = await s.wallet(p);
  assert.equal(w.realTicsCents, 500000, 'refunded once');
  assert.equal(w.pendingWithdrawals, 0);
  assert.equal((await s.call('/cancel', { id })).data.alreadyCancelled, true);
  await s.call('/process', {});
  assert.equal((await s.wallet(p)).realTicsCents, 500000);
});

test('N6: a refused player row is "blocked" and stays counted as owed', async () => {
  const s = await setup();
  const p = await s.addPlayer(500000);
  const id = await s.withdraw(p, 200000);
  const before = await owedNow(s);
  s.DB.raw.prepare('UPDATE chain_withdrawals SET fee_units = 5 WHERE id = ?').run(id); // send + fee != amount
  s.advance(121000);
  await s.call('/process', {});
  assert.equal(s.row(id).status, 'blocked');
  assert.equal(await owedNow(s), before, 'the held money is still owed');
});

test('N7: money already on its way is not spent twice when the wallet is short', async () => {
  const s = await setup();
  s.chain.mineOnSend = false;
  s.chain.token = 1500n * 10n ** 16n; // 15 TICS
  const a = await s.addPlayer(100000), b = await s.addPlayer(100000);
  const idA = await s.withdraw(a, 1000), idB = await s.withdraw(b, 1000);
  s.advance(130000);
  await s.call('/process', {});
  assert.equal(s.row(idA).status, 'sending');
  assert.equal(s.row(idB).status, 'queued', '10 + 10 TICS do not fit in 15');
  assert.equal(s.chain.sent.length, 1);
  assert.equal(s.alerts('tics_low_float').length, 1);
});

test('N8: a revert at a finalized block is refunded before 12 confirmations', async () => {
  const s = await setup();
  const a = await s.addPlayer(100000);
  const id = await s.withdraw(a, 40000);
  s.advance(130000);
  s.chain.mineOnSend = false;
  await s.call('/process', {});
  s.chain.mine(s.chain.sent[0].hash, '0x0');
  let finalized = s.chain.block - 1;
  const real = s.chain.rpc;
  s.env.__rpc = (m, prm) => (m === 'eth_getBlockByNumber' && prm[0] === 'finalized' ? Promise.resolve({ number: `0x${finalized.toString(16)}` }) : real(m, prm));
  await s.call('/process', {});
  assert.equal(s.row(id).status, 'sending', 'not finalized yet');
  finalized = s.chain.block;
  await s.call('/process', {});
  assert.equal(s.row(id).status, 'failed');
  assert.equal((await s.wallet(a)).realTicsCents, 100000);
});

test('N9: the signer keeps its own first-seen time for a treasury address', async () => {
  const s = await setup();
  s.chain.token = 1000n * 10n ** 18n;
  // An address changed without treasuryAddressSetAt (written straight into D1).
  s.setSettings({ treasuryAddress: '0x6666666666666666666666666666666666666666', treasuryAddressSetAt: null });
  const young = await s.call('/treasury', { id: randomUUID(), amountUnits: 1000 });
  assert.equal(young.status, 409);
  assert.match(young.data.error, /48 hours/);
  s.advance(47 * 3600000);
  assert.equal((await s.call('/treasury', { id: randomUUID(), amountUnits: 1000 })).status, 409);
  s.advance(2 * 3600000);
  const ok = await s.call('/treasury', { id: randomUUID(), amountUnits: 1000 });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(s.chain.sent[0].to, '0x6666666666666666666666666666666666666666');
});

test('N10: a 409 from tics-finalise blocks the row once; after the owner resumes, later runs do not pause again', async () => {
  const s = await setup();
  const a = await s.addPlayer(100000);
  const id = await s.withdraw(a, 10000);
  s.advance(130000);
  const st = failWallet(s, a, 'tics-finalise', 409);
  await s.call('/process', {});
  await s.call('/process', {});
  assert.equal(s.row(id).status, 'blocked');
  assert.match(s.row(id).last_error, /tics-finalise answered/);
  assert.equal(s.settings().payoutsPaused, true);
  s.setSettings({ payoutsPaused: false, pausedReason: null });
  st.on = false;
  for (let i = 0; i < 3; i++) await s.call('/process', {});
  assert.equal(s.settings().payoutsPaused, false, 'not paused again');
  assert.equal(s.alerts('tics_hold_conflict').length, 1, 'alerted once');
});

test('N11: a new treasury row goes first; a security pause refuses treasury sends, a manual pause does not', async () => {
  const s = await setup();
  s.chain.token = 1000n * 10n ** 18n;
  for (let i = 0; i < 6; i++) { const p = await s.addPlayer(1000); await s.withdraw(p, 100); }
  s.advance(130000);
  s.setSettings({ payoutsPaused: true, pausedReason: 'owner pause' });
  const t = randomUUID();
  const r = await s.call('/treasury', { id: t, amountUnits: 1000 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(s.row(t).status, 'sending', 'signed by id although 6 older rows wait');
  assert.equal(s.chain.sent.length, 1, 'no player row was paid while paused');
  assert.equal(s.chain.sent[0].to, '0x9999999999999999999999999999999999999999');
  await s.call('/process', {});
  assert.equal(s.row(t).status, 'sent');
  // A security pause (a forged row) stops the owner's treasury sends too.
  s.setSettings({ payoutsPaused: false, pausedReason: null });
  insertRow(s, { id: randomUUID(), kind: 'treasury', to_address: '0x9999999999999999999999999999999999999999', amount_units: 1000, row_mac: 'A'.repeat(43), release_at: '2000-01-01 00:00:00' });
  s.chain.mineOnSend = false;
  await s.call('/process', {});
  assert.equal(s.settings().payoutsPaused, true);
  const refused = await s.call('/treasury', { id: randomUUID(), amountUnits: 1000 });
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /security reason/);
  // Once the owner resumes, the security flag clears.
  s.setSettings({ payoutsPaused: false, pausedReason: null });
  await s.call('/process', {});
  assert.equal((await s.call('/status')).data.securityPaused, false);
});

test('N13: the outbox never releases a cancelled row that was turned into blocked or failed in D1', async () => {
  const s = await setup();
  const p = await s.addPlayer(500000);
  const id = await s.withdraw(p, 200000);
  const down = failWallet(s, p, 'tics-release', 503);
  await s.call('/cancel', { id });
  down.on = false;
  s.DB.raw.prepare("UPDATE chain_withdrawals SET status = 'failed' WHERE id = ?").run(id);
  await s.call('/process', {});
  let w = await s.wallet(p);
  assert.equal(w.pendingWithdrawals, 1, 'not released: the signer never saw it fail on chain');
  assert.equal(s.alerts('tics_hold_conflict').length, 1);
  const id2 = await s.withdraw(p, 1000);
  const down2 = failWallet(s, p, 'tics-release', 503);
  await s.call('/cancel', { id: id2 });
  down2.on = false;
  s.DB.raw.prepare("UPDATE chain_withdrawals SET status = 'blocked' WHERE id = ?").run(id2);
  await s.call('/process', {});
  w = await s.wallet(p);
  assert.equal(w.pendingWithdrawals, 2, 'a blocked row is never released automatically');
});

test('owed: matches the game Worker rule (blocked and cancelling player rows count, blocked treasury rows do not)', async () => {
  const s = await setup();
  for (const [status, kind] of [['blocked', 'player'], ['cancelling', 'player'], ['holding', 'player'], ['failed', 'player'], ['blocked', 'treasury'], ['sending', 'treasury']]) {
    insertRow(s, { id: randomUUID(), kind, player_id: kind === 'player' ? 'x' : null, to_address: '0x9999999999999999999999999999999999999999', amount_units: 100, status });
  }
  assert.equal(await owedNow(s), 400);
});

test('resolve: a stopped withdrawal that was never signed goes back to the player; a signed one is refused', async () => {
  const s = await setup();
  const p = await s.addPlayer(500000);
  const id = await s.withdraw(p, 200000);
  s.DB.raw.prepare('UPDATE chain_withdrawals SET fee_units = 5 WHERE id = ?').run(id);
  s.advance(121000);
  await s.call('/process', {});
  assert.equal(s.row(id).status, 'blocked');
  const r = await s.call('/resolve', { id, by: 'owner@example.com' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(s.row(id).status, 'cancelled');
  const again = await s.call('/resolve', { id });
  assert.equal(again.status, 409);
  // A row that was signed (it may be on chain) is never returned automatically.
  const id2 = await s.withdraw(p, 100000);
  s.DB.raw.prepare("UPDATE chain_withdrawals SET status = 'blocked', tx_hash = ? WHERE id = ?").run('0x' + 'ab'.repeat(32), id2);
  const signed = await s.call('/resolve', { id: id2 });
  assert.equal(signed.status, 409);
  assert.equal(s.row(id2).status, 'blocked');
});

// ---------- re-audit round 3 (lying node, D1 edits, head-of-line, treasury) ----------
const hideTx = (s, which = ['eth_getTransactionReceipt', 'eth_getTransactionByHash']) => {
  const orig = s.chain.rpc, hidden = new Set();
  s.env.__rpc = async (m, p) => (which.includes(m) && hidden.has(String(p[0]).toLowerCase()) ? null : orig(m, p));
  return { hidden, orig };
};

test('R3-P1: a node that broadcasts but answers "nonce too low" and hides the receipt never gets a second payment', async () => {
  for (const second of [false, true]) {
    const s = await setup();
    const a = await s.addPlayer(500000);
    const id = await s.withdraw(a, 200000);
    s.advance(130000);
    const { hidden, orig } = hideTx(s);
    let lied = false;
    const hide = s.env.__rpc;
    s.env.__rpc = async (m, p) => {
      if (m === 'eth_sendRawTransaction' && !lied) { lied = true; hidden.add(String(await orig(m, p)).toLowerCase()); throw new Error('RPC eth_sendRawTransaction: nonce too low'); }
      return hide(m, p);
    };
    if (second) s.env.__rpc2 = s.chain.rpc; // an honest second provider
    await s.call('/process', {});
    assert.equal(s.chain.sent.length, 1, 'not signed again at a new nonce');
    assert.equal(s.row(id).status, 'sending');
    for (let i = 0; i < 4; i++) { s.advance(4 * 60000); await s.call('/process', {}); }
    assert.equal(s.chain.sent.length, 1, 'paid exactly once');
    assert.equal(s.row(id).status, 'blocked', 'left for a person, never refunded or re-signed');
    const w = await s.wallet(a);
    assert.equal(w.realTicsCents, 300000, 'never refunded');
    assert.equal(w.pendingWithdrawals, 1);
    if (second) {
      assert.equal(s.alerts('tics_rpc_mismatch').length, 1, 'the second provider exposed the hidden receipt');
      assert.equal((await s.call('/resolve', { id })).status, 409, 'cannot be returned to the player');
    }
  }
});

test('R3-P1: a row signed earlier is signed again at a new nonce only with proof from a second provider', async () => {
  for (const second of [false, true]) {
    const s = await setup();
    s.chain.mineOnSend = false;
    const a = await s.addPlayer(500000);
    const id = await s.withdraw(a, 200000);
    s.advance(130000);
    await s.call('/process', {});
    const first = s.chain.sent[0];
    // The owner's manual send used the nonce; ours was dropped. Then the row is flipped back to queued in D1.
    s.chain.mempool.delete(first.hash); s.chain.nonce++;
    s.DB.raw.prepare("UPDATE chain_withdrawals SET status = 'queued', nonce = NULL, raw_tx = NULL, tx_hash = NULL WHERE id = ?").run(id);
    if (second) s.env.__rpc2 = s.chain.rpc;
    s.chain.mineOnSend = true;
    await s.call('/process', {});
    assert.equal(s.row(id).status, 'queued', 'first run without a receipt only notes the time');
    s.advance(6 * 60000);
    await s.call('/process', {});
    if (second) {
      assert.equal(s.chain.sent.length, 2);
      assert.equal(s.chain.sent[1].nonce, 1);
      await s.call('/process', {});
      assert.equal(s.row(id).status, 'sent');
    } else {
      assert.equal(s.chain.sent.length, 1, 'never signed again without a second provider');
      assert.equal(s.row(id).status, 'blocked');
      assert.match(s.row(id).last_error, /ETH_RPC_URL_2/);
    }
  }
});

test('R3-P2: a hidden receipt never leads to a refund of a mined payout', async () => {
  // Receipt hidden but the node still knows the transaction: wait forever, critical alert.
  const s = await setup();
  const a = await s.addPlayer(500000);
  const id = await s.withdraw(a, 200000);
  s.advance(130000);
  await s.call('/process', {});
  const { hidden } = hideTx(s, ['eth_getTransactionReceipt']);
  hidden.add(s.chain.sent[0].hash.toLowerCase());
  for (let i = 0; i < 4; i++) { s.advance(4 * 60000); await s.call('/process', {}); }
  assert.equal(s.row(id).status, 'sending');
  assert.equal((await s.wallet(a)).realTicsCents, 300000, 'not refunded');
  assert.equal(s.alerts('tics_rpc_inconsistent').length, 1);
  // Receipt and transaction both hidden, no second provider: blocked for a person, not refunded.
  for (const second of [false, true]) {
    const t = await setup();
    const p = await t.addPlayer(500000);
    const tid = await t.withdraw(p, 200000);
    t.advance(130000);
    await t.call('/process', {});
    hideTx(t).hidden.add(t.chain.sent[0].hash.toLowerCase());
    if (second) t.env.__rpc2 = t.chain.rpc;
    for (let i = 0; i < 4; i++) { t.advance(4 * 60000); await t.call('/process', {}); }
    assert.equal(t.row(tid).status, 'blocked');
    const w = await t.wallet(p);
    assert.equal(w.realTicsCents, 300000, 'never refunded');
    assert.equal(w.pendingWithdrawals, 1);
    assert.equal(t.alerts('tics_nonce_taken').length, 0);
    if (second) assert.equal(t.alerts('tics_rpc_mismatch').length, 1);
  }
});

test('R3-P3: /cancel and /resolve refuse a row that was ever signed (registry, tx_hash, raw_tx or tx_hashes)', async () => {
  const s = await setup();
  const a = await s.addPlayer(500000);
  const id = await s.withdraw(a, 200000);
  s.advance(130000); s.chain.mineOnSend = false;
  await s.call('/process', {});
  s.DB.raw.prepare("UPDATE chain_withdrawals SET status = 'queued', nonce = NULL, raw_tx = NULL, tx_hash = NULL, tx_hashes = '[]' WHERE id = ?").run(id);
  const r = await s.call('/cancel', { id, by: 'x' });
  assert.equal(r.status, 409);
  assert.equal(s.alerts('tics_cancel_refused').length, 1);
  s.chain.mine(s.chain.sent[0].hash);
  for (let i = 0; i < 3; i++) await s.call('/process', {});
  const w = await s.wallet(a);
  assert.equal(w.realTicsCents, 300000, 'never refunded while paid on chain');
  assert.equal(s.chain.sent.length, 1);
  // A row with only tx_hashes in D1 (no registry entry): cancel and resolve both refuse.
  const id2 = await s.withdraw(a, 1000);
  s.DB.raw.prepare('UPDATE chain_withdrawals SET tx_hashes = ? WHERE id = ?').run(JSON.stringify([`0x${'cd'.repeat(32)}`]), id2);
  assert.equal((await s.call('/cancel', { id: id2 })).status, 409);
  s.DB.raw.prepare("UPDATE chain_withdrawals SET status = 'blocked' WHERE id = ?").run(id2);
  assert.equal((await s.call('/resolve', { id: id2 })).status, 409);
  assert.equal(s.row(id2).status, 'blocked');
});

test('R3-P4: a player row whose address was edited in D1 (with players.wallet_address) is never paid', async () => {
  const s = await setup();
  const a = await s.addPlayer(500000);
  const id = await s.withdraw(a, 200000);
  const evil = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
  s.DB.raw.prepare('UPDATE players SET wallet_address = ? WHERE id = ?').run(evil, a);
  s.DB.raw.prepare('UPDATE chain_withdrawals SET to_address = ? WHERE id = ?').run(evil, id);
  s.advance(130000);
  await s.call('/process', {}); await s.call('/process', {});
  assert.equal(s.chain.sent.length, 0);
  assert.equal(s.row(id).status, 'blocked');
  assert.match(s.row(id).last_error, /not the player's own wallet/);
  assert.equal(s.alerts('tics_payout_refused').length, 1);
  assert.equal(s.settings().payoutsPaused, true);
});

test('R3-P5: one row that keeps failing does not hold up the rest; it is blocked after 5 failures; a node outage blocks nothing', async () => {
  const s = await setup();
  const a = await s.addPlayer(500000), b = await s.addPlayer(500000);
  const idA = await s.withdraw(a, 100000);
  s.advance(1000);
  const idB = await s.withdraw(b, 100000);
  const orig = s.chain.rpc;
  s.env.__rpc = async (m, p) => { if (m === 'eth_estimateGas' && p[0].data.toLowerCase().includes(a.slice(2))) throw new Error('RPC eth_estimateGas: execution reverted'); return orig(m, p); };
  s.advance(130000);
  await s.call('/process', {});
  assert.equal(s.row(idB).status, 'sending', 'the next row is paid in the same run');
  assert.equal(s.chain.sent[0].nonce, 0, 'no nonce gap: the failed row never used one');
  for (let i = 0; i < 20; i++) { s.advance(60000); await s.call('/process', {}); }
  assert.equal(s.row(idB).status, 'sent');
  assert.equal(s.row(idA).status, 'blocked');
  assert.match(s.row(idA).last_error, /failed \d+ times in a row/);
  assert.equal(s.alerts('tics_payout_failing').length, 1);
  assert.equal(s.settings().payoutsPaused, false);
  assert.equal((await s.wallet(a)).pendingWithdrawals, 1, 'still held for review');
  assert.equal((await s.call('/resolve', { id: idA })).status, 200, 'never signed, so the owner can return it');
  // A node outage is not counted against the row.
  const t = await setup();
  const p = await t.addPlayer(500000), tid = await t.withdraw(p, 1000);
  const o2 = t.chain.rpc;
  t.env.__rpc = async (m, prm) => { if (m === 'eth_estimateGas') throw new Error('RPC eth_estimateGas failed with HTTP 503'); return o2(m, prm); };
  t.advance(130000);
  for (let i = 0; i < 30; i++) { t.advance(60000); await t.call('/process', {}); }
  assert.equal(t.row(tid).status, 'queued');
  t.env.__rpc = o2;
  await t.call('/process', {});
  assert.equal(t.row(tid).status, 'sending');
});

test('R3-P6: a new treasury address raises a critical alert; /treasury needs X-Treasury-Secret; owed respects the ledger', async () => {
  const s = await setup();
  const a = await s.addPlayer(500000);
  const evil = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
  s.setSettings({ treasuryAddress: evil, treasuryAddressSetAt: null });
  await s.call('/process', {});
  const al = s.alerts('tics_treasury_address');
  assert.equal(al.length, 1);
  assert.equal(al[0].severity, 'critical');
  assert.match(al[0].details, new RegExp(evil));
  s.advance(49 * 3600000);
  // Without the treasury secret header (only INTERNAL_SECRET, as the game Worker has): refused.
  assert.equal((await s.call('/treasury', { id: randomUUID(), amountUnits: 1000 }, 's3cret', null)).status, 403);
  assert.equal((await s.call('/treasury', { id: randomUUID(), amountUnits: 1000 }, 's3cret', 'wrong')).status, 403);
  // Players' balances zeroed in D1 only: the ledger still shows the money is owed.
  assert.ok(s.DB.raw.prepare("SELECT COUNT(*) AS n FROM ledger WHERE player_id = ? AND real_money = 1").get(a).n > 0, 'the wallet copied its ledger to D1');
  s.DB.raw.prepare('UPDATE players SET real_tics_cents = 0').run();
  const free = (await s.call('/status')).data.freeUnits;
  const r = await s.call('/treasury', { id: randomUUID(), amountUnits: free });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.equal(s.chain.sent.length, 0, 'nothing sent to the swapped address');
  const ok = await s.call('/treasury', { id: randomUUID(), amountUnits: free - 500000 });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  // Not set up at all: a clear 503.
  delete s.env.TREASURY_SECRET;
  const off = await s.call('/treasury', { id: randomUUID(), amountUnits: 1000 });
  assert.equal(off.status, 503);
  assert.match(off.data.error, /not set up/);
});

test('R3-7: a node on another chain is refused: nothing confirmed or signed, payouts pause', async () => {
  const s = await setup();
  const a = await s.addPlayer(100000);
  const id = await s.withdraw(a, 10000);
  s.advance(130000);
  s.chain.chainId = 5;
  const r = await s.call('/process', {});
  assert.match(r.data.refused, /chain id 5/);
  assert.equal(s.chain.sent.length, 0);
  assert.equal(s.row(id).status, 'queued');
  assert.equal(s.settings().payoutsPaused, true);
  assert.equal(s.alerts('tics_wrong_chain').length, 1);
  s.setSettings({ payoutsPaused: false });
  const t = await s.call('/treasury', { id: randomUUID(), amountUnits: 1000 });
  assert.equal(t.status, 409);
  assert.match(t.data.error, /chain id 5/);
  assert.equal(s.chain.sent.length, 0);
});

test('R3-8: a payout marked sent is checked again 64 blocks later; a vanished receipt alerts and pauses', async () => {
  const s = await setup();
  const a = await s.addPlayer(100000), b = await s.addPlayer(100000);
  const idA = await s.withdraw(a, 10000), idB = await s.withdraw(b, 10000);
  s.advance(130000);
  await s.call('/process', {}); await s.call('/process', {});
  assert.equal(s.row(idA).status, 'sent'); assert.equal(s.row(idB).status, 'sent');
  s.chain.receipts.delete(s.chain.sent[0].hash); // reorged away (or hidden)
  s.chain.block += 30;
  await s.call('/process', {});
  assert.equal(s.alerts('tics_sent_vanished').length, 0, 'not checked before 64 blocks');
  s.chain.block += 40;
  await s.call('/process', {});
  assert.equal(s.alerts('tics_sent_vanished').length, 0, 'one empty answer (a lagging node) is not enough');
  assert.equal(s.settings().payoutsPaused, false);
  s.advance(2 * 60 * 1000); await s.call('/process', {});
  assert.equal(s.alerts('tics_sent_vanished').length, 0, 'still under 5 minutes');
  s.advance(4 * 60 * 1000); await s.call('/process', {});
  assert.equal(s.alerts('tics_sent_vanished').length, 1, 'only the vanished one');
  assert.equal(s.settings().payoutsPaused, true);
  await s.call('/process', {});
  assert.equal(s.alerts('tics_sent_vanished').length, 1, 'checked once');
});

test('R4-1: a node or wallet outage blocks nothing, whatever the node says; a lone failing row with nothing else moving is not blocked', async () => {
  for (const fail of [
    (m) => m === 'eth_estimateGas' ? new Error('RPC eth_estimateGas: Internal error') : null,
    (m) => m === 'eth_getTransactionCount' ? new Error('RPC eth_getTransactionCount: rate limited') : null,
  ]) {
    const t = await setup();
    const ids = [];
    for (let i = 0; i < 3; i++) { const p = await t.addPlayer(500000); ids.push(await t.withdraw(p, 1000)); t.advance(1000); }
    const o2 = t.chain.rpc;
    t.env.__rpc = async (m, prm) => { const e = fail(m); if (e) throw e; return o2(m, prm); };
    t.advance(130000);
    for (let i = 0; i < 30; i++) { t.advance(60000); await t.call('/process', {}); }
    for (const id of ids) assert.equal(t.row(id).status, 'queued', 'outage: still waiting, not blocked');
    assert.equal(t.alerts('tics_payout_failing').length, 0);
    t.env.__rpc = o2;
    await t.call('/process', {});
    assert.ok(ids.every((id) => ['sending', 'queued'].includes(t.row(id).status)));
    assert.equal(t.row(ids[0]).status, 'sending');
  }
  // Every row reverting (for example the casino is out of tokens): nothing moves, so nothing is blocked.
  const u = await setup();
  const q = await u.addPlayer(500000), qid = await u.withdraw(q, 1000);
  const o3 = u.chain.rpc;
  u.env.__rpc = async (m, prm) => { if (m === 'eth_estimateGas') throw new Error('RPC eth_estimateGas: execution reverted: transfer amount exceeds balance'); return o3(m, prm); };
  u.advance(130000);
  for (let i = 0; i < 30; i++) { u.advance(60000); await u.call('/process', {}); }
  assert.equal(u.row(qid).status, 'queued');
  assert.equal(u.alerts('tics_payout_failing').length, 0);
});
