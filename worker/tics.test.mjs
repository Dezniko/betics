import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes } from 'node:crypto';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { encodeAbiParameters, pad } from 'viem';
import worker, { DemoCasino } from './index.js';
import { clearConfigCache } from './platform.js';
import { createD1 } from '../test-support/d1shim.mjs';
import { weiToUnits, unitsToWei, formatTics, normAddress, OFFICIAL_TICS, TRANSFER_TOPIC, decodeTransfers } from './tics.js';
import { chainTick, parseHoldings, refreshHoldings, HOLDINGS_DAILY_CAP } from './wallet.js';

const MIGRATIONS = ['0001_platform.sql', '0002_payments.sql', '0003_tics.sql', '0004_spin_holds.sql', '0005_audit_fixes.sql', '0006_admin.sql', '0007_r3.sql'].map((f) => new URL(`../migrations/${f}`, import.meta.url).pathname);
const HOST = 'betics.example';
const CASINO = '0xc0ffee0000000000000000000000000000000001';
const FAKE_TICS = '0xad34bbc446785fc7f2995578c7273f706ebea177';

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

// A tiny fake Ethereum node: blocks, logs and receipts for the tests.
function fakeChain() {
  const chain = { block: 1007, logs: [], receipts: new Map(), tokenBalance: 0n, ethBalance: 10n ** 18n };
  chain.rpc = async (method, params) => {
    if (method === 'eth_blockNumber') return `0x${chain.block.toString(16)}`;
    if (method === 'eth_getLogs') {
      const f = params[0], from = Number(f.fromBlock), to = Number(f.toBlock);
      // Like Alchemy's free plan: at most 10 blocks per log query.
      if (to - from + 1 > 10) throw new Error('Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.');
      return chain.logs.filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to && l.address === f.address && l.topics[2] === f.topics[2]);
    }
    if (method === 'eth_getTransactionReceipt') return chain.receipts.get(params[0]) || null;
    if (method === 'eth_call') return `0x${chain.tokenBalance.toString(16).padStart(64, '0')}`;
    if (method === 'eth_getBalance') return `0x${chain.ethBalance.toString(16)}`;
    throw new Error(`unexpected ${method}`);
  };
  chain.transfer = ({ token = OFFICIAL_TICS, from, to = CASINO, wei, block = chain.block }) => {
    const txHash = `0x${randomBytes(32).toString('hex')}`;
    const log = { address: token, topics: [TRANSFER_TOPIC, pad(from), pad(to)], data: encodeAbiParameters([{ type: 'uint256' }], [wei]),
      blockNumber: `0x${block.toString(16)}`, transactionHash: txHash, logIndex: '0x0', removed: false };
    chain.logs.push(log);
    chain.receipts.set(txHash, { status: '0x1', blockNumber: log.blockNumber, transactionHash: txHash, logs: [log] });
    if (token === OFFICIAL_TICS && to === CASINO) chain.tokenBalance += wei;
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
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  const rows = (q, ...a) => DB.raw.prepare(q).all(...a);
  const setTics = (patch) => {
    const cur = JSON.parse(rows("SELECT value FROM settings WHERE key = 'tics_payments'")[0].value);
    DB.raw.prepare("UPDATE settings SET value = ? WHERE key = 'tics_payments'").run(JSON.stringify({ ...cur, ...patch }));
  };
  const login = async (account = privateKeyToAccount(generatePrivateKey()), overrides = {}) => {
    const n = await call('/api/wallet/nonce', { body: {} });
    const message = createSiweMessage({ domain: HOST, address: account.address, uri: `https://${HOST}`, version: '1', chainId: 1, nonce: n.data.nonce,
      issuedAt: new Date(), statement: n.data.statement, ...overrides });
    const signature = await account.signMessage({ message });
    const r = await call('/api/wallet/verify', { body: { message, signature } });
    return { r, account, message, signature, cookie: r.headers.get('set-cookie')?.split(';')[0] };
  };
  const spin = async (cookie, bets, mode, extra = {}) => {
    const c = (await call('/api/fairness/commitment', { cookie })).data;
    return call('/api/games/roulette/spin', { cookie, body: { bets, requestId: randomUUID(), expectedCommitment: c, clientEntropy: randomBytes(32).toString('hex'), ...(mode ? { mode } : {}), ...extra } });
  };
  const restore = () => { globalThis.fetch = realFetch; };
  return { env, DB, chain, call, rows, setTics, login, spin, restore, objects };
}

test('$TICS units: wei rounds down to 0.01 $TICS, formatting and address checks', () => {
  assert.equal(weiToUnits(10n ** 18n), 100);
  assert.equal(weiToUnits(10n ** 16n - 1n), 0);
  assert.equal(weiToUnits(123456789n * 10n ** 14n), 1234567);
  assert.equal(unitsToWei(250), 25n * 10n ** 17n);
  assert.throws(() => unitsToWei(1.5));
  assert.equal(formatTics(123456789), '1,234,567.89 $TICS');
  assert.equal(normAddress('0x551ecFDBa071cB6541f642cB90a073c8c158Df05'), OFFICIAL_TICS);
  assert.equal(normAddress('0x551ecFDBa071cB6541f642cB90a073c8c158DF05'), null, 'bad checksum rejected');
  assert.equal(normAddress('0x551e'), null);
});

test('only the official $TICS contract sent to the casino wallet is decoded', () => {
  const chain = fakeChain();
  const from = '0x1111111111111111111111111111111111111111';
  chain.transfer({ from, wei: 5n * 10n ** 18n });
  chain.transfer({ token: FAKE_TICS, from, wei: 5n * 10n ** 18n });
  chain.transfer({ from, to: '0x2222222222222222222222222222222222222222', wei: 5n * 10n ** 18n });
  const out = decodeTransfers(chain.logs, OFFICIAL_TICS, CASINO);
  assert.equal(out.length, 1);
  assert.equal(out[0].from, from);
  assert.equal(out[0].amountWei, (5n * 10n ** 18n).toString());
});

test('SIWE: sign in creates a wallet player keyed by address; replays, wrong site and wrong chain are refused', async () => {
  const p = platform();
  try {
    const { r, account, message, signature, cookie } = await p.login();
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.match(r.headers.get('set-cookie'), /__Host-betics_wallet=[a-f0-9]{64}; Path=\/; HttpOnly; Secure; SameSite=Lax/);
    const address = account.address.toLowerCase();
    const [player] = p.rows('SELECT * FROM players WHERE id = ?', address);
    assert.equal(player.wallet_address, address);
    assert.ok(player.first_connected_at && player.last_connected_at);
    assert.equal(p.rows('SELECT * FROM wallet_connections WHERE player_id = ?', address).length, 1);
    assert.equal(p.rows("SELECT * FROM player_identities WHERE kind = 'wallet' AND value = ?", address).length, 1);
    // Replay of the same signed message is refused.
    assert.equal((await p.call('/api/wallet/verify', { body: { message, signature } })).status, 401);
    // Another site's message.
    assert.equal((await p.login(undefined, { domain: 'evil.example', uri: 'https://evil.example' })).r.status, 400);
    // Another chain.
    assert.equal((await p.login(undefined, { chainId: 56 })).r.status, 400);
    // Signature from a different wallet.
    const other = privateKeyToAccount(generatePrivateKey());
    const n = await p.call('/api/wallet/nonce', { body: {} });
    const msg = createSiweMessage({ domain: HOST, address: account.address, uri: `https://${HOST}`, version: '1', chainId: 1, nonce: n.data.nonce, issuedAt: new Date() });
    assert.equal((await p.call('/api/wallet/verify', { body: { message: msg, signature: await other.signMessage({ message: msg }) } })).status, 401);
    // Session works without any guest cookie; profile and wallet balances load.
    const me = await p.call('/api/wallet/me', { cookie });
    assert.equal(me.status, 200);
    assert.equal(me.data.address, account.address);
    assert.equal((await p.call('/api/session', { cookie, body: {} })).data.balanceCents, 10000000);
    // Second login keeps first_connected_at and logs a second connection.
    await p.login(account);
    assert.equal(p.rows('SELECT * FROM wallet_connections WHERE player_id = ?', address).length, 2);
    // Logout revokes the session.
    assert.equal((await p.call('/api/wallet/logout', { cookie, body: {} })).status, 200);
    assert.equal((await p.call('/api/wallet/me', { cookie })).status, 401);
  } finally { p.restore(); }
});

test('email: saved with consent, validated, and cannot be claimed by a second wallet', async () => {
  const p = platform();
  try {
    const a = await p.login();
    assert.equal((await p.call('/api/wallet/profile', { cookie: a.cookie, body: { email: 'not-an-email', consent: true } })).status, 400);
    const ok = await p.call('/api/wallet/profile', { cookie: a.cookie, body: { email: 'Fan@Example.com', consent: true } });
    assert.deepEqual(ok.data, { email: 'fan@example.com', emailConsent: true });
    const b = await p.login();
    assert.equal((await p.call('/api/wallet/profile', { cookie: b.cookie, body: { email: 'fan@example.com' } })).status, 409);
    assert.equal((await p.call('/api/wallet/me', { cookie: a.cookie })).data.email, 'fan@example.com');
  } finally { p.restore(); }
});

test('deposits: credited once after confirmations, unknown senders and fake tokens are not credited', async () => {
  const p = platform();
  try {
    p.setTics({ casinoWallet: CASINO, realEnabled: true, startBlock: 990, quickDepositMaxUnits: 0 });
    const a = await p.login();
    const address = a.account.address.toLowerCase();
    await p.call('/api/session', { cookie: a.cookie, body: {} });
    const good = p.chain.transfer({ from: address, wei: 1234n * 10n ** 18n, block: 995 });
    p.chain.transfer({ token: FAKE_TICS, from: address, wei: 99999n * 10n ** 18n, block: 995 });
    p.chain.transfer({ from: '0x3333333333333333333333333333333333333333', wei: 50n * 10n ** 18n, block: 996 });
    p.chain.transfer({ from: address, wei: 10n ** 17n, block: 996 }); // 0.1 $TICS, below the 1 $TICS minimum
    const late = p.chain.transfer({ from: address, wei: 7n * 10n ** 18n, block: 999 }); // not yet 12 confirmations at block 1007
    await chainTick(p.env, { rpc: p.chain.rpc });
    await chainTick(p.env, { rpc: p.chain.rpc }); // a second run changes nothing
    const deps = p.rows('SELECT tx_hash, status, amount_units, credited_at FROM chain_deposits ORDER BY block_number, status');
    assert.equal(deps.length, 3);
    assert.deepEqual(deps.map((d) => d.status).sort(), ['below_min', 'credited', 'unmatched']);
    assert.ok(deps.find((d) => d.tx_hash === good).credited_at);
    let w = (await p.call('/api/wallet', { cookie: a.cookie })).data;
    assert.equal(w.realTicsCents, 123400);
    assert.equal(w.demoAllowed, false, 'demo hidden once funded');
    assert.equal(p.rows("SELECT COUNT(*) AS n FROM alerts WHERE type = 'tics_unmatched'")[0].n, 1);
    // The fast check refuses to credit before 12 confirmations, then credits exactly once.
    assert.equal((await p.call('/api/wallet/deposit/check', { cookie: a.cookie, body: { txHash: late } })).data.status, 'confirming');
    p.chain.block = 1011;
    const checked = await p.call('/api/wallet/deposit/check', { cookie: a.cookie, body: { txHash: late } });
    assert.equal(checked.data.status, 'credited');
    await chainTick(p.env, { rpc: p.chain.rpc });
    w = (await p.call('/api/wallet', { cookie: a.cookie })).data;
    assert.equal(w.realTicsCents, 124100);
    // Float snapshot: wallet holds everything sent to it, owed = player balances.
    const float = JSON.parse(p.rows("SELECT value FROM chain_state WHERE key = 'float'")[0].value);
    assert.equal(float.owedUnits, 124100);
    assert.ok(float.freeUnits >= 5000);
  } finally { p.restore(); }
});

test('real spins use the real balance, demo is refused while funded, and the bankroll guard holds', async () => {
  const p = platform();
  try {
    p.setTics({ casinoWallet: CASINO, realEnabled: true, startBlock: 990 });
    const a = await p.login();
    const address = a.account.address.toLowerCase();
    await p.call('/api/session', { cookie: a.cookie, body: {} });
    p.chain.transfer({ from: address, wei: 1000n * 10n ** 18n, block: 980 + 10 });
    p.chain.tokenBalance += 1000n * 10n ** 18n; // house money in the casino wallet
    await chainTick(p.env, { rpc: p.chain.rpc });
    const demo = await p.spin(a.cookie, [{ type: 'red', amountCents: 1000 }], 'demo');
    assert.equal(demo.status, 403);
    const real = await p.spin(a.cookie, [{ type: 'red', amountCents: 1000 }], 'real');
    assert.equal(real.status, 200, JSON.stringify(real.data));
    assert.equal(real.data.mode, 'real');
    const w = (await p.call('/api/wallet', { cookie: a.cookie })).data;
    assert.equal(w.realTicsCents, real.data.balanceAfterCents);
    assert.equal(w.balanceCents, 10000000, 'demo balance untouched');
    const [round] = p.rows('SELECT * FROM rounds WHERE player_id = ?', address);
    assert.equal(round.real_money, 1);
    assert.equal(round.currency, 'TICS');
    // A straight-up bet whose worst case exceeds the free float is refused.
    const big = await p.spin(a.cookie, [{ type: 'straight', value: 7, amountCents: w.realTicsCents }], 'real');
    assert.ok(big.status === 503 || big.status === 400, JSON.stringify(big.data));
    // A guest (no wallet) can never spin real.
    const g = await p.call('/api/session', { body: {} });
    const gc = g.headers.get('set-cookie').split(';')[0];
    assert.equal((await p.spin(gc, [{ type: 'red', amountCents: 1000 }], 'real')).status, 403);
  } finally { p.restore(); }
});

test('withdrawals: only after a deposit from that wallet, held at once, idempotent, and refused on a ledger mismatch', async () => {
  const p = platform();
  try {
    p.setTics({ casinoWallet: CASINO, realEnabled: true, startBlock: 990, feesEnabled: false, minWithdrawalUnits: 1000 });
    const a = await p.login();
    const address = a.account.address.toLowerCase();
    await p.call('/api/session', { cookie: a.cookie, body: {} });
    const wd = (amountCents, requestId = randomUUID()) => p.call('/api/wallet/withdraw', { cookie: a.cookie, body: { amountCents, requestId } });
    assert.equal((await wd(1000)).status, 403, 'no deposit yet');
    p.chain.transfer({ from: address, wei: 500n * 10n ** 18n, block: 990 });
    await chainTick(p.env, { rpc: p.chain.rpc });
    assert.equal((await wd(50001)).status, 402, 'more than the balance');
    assert.equal((await wd(999)).status, 400, 'below the minimum');
    const id = randomUUID();
    const ok = await wd(20000, id);
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.status, 'queued');
    assert.equal(ok.data.sendCents, 20000, 'fees off: the full amount is sent');
    assert.equal(ok.data.realTicsCents, 30000);
    assert.equal((await wd(20000, id)).data.duplicate, true);
    assert.equal(p.rows('SELECT COUNT(*) AS n FROM chain_withdrawals')[0].n, 1);
    const [row] = p.rows('SELECT * FROM chain_withdrawals');
    assert.equal(row.to_address, address);
    const w = (await p.call('/api/wallet', { cookie: a.cookie })).data;
    assert.equal(w.pendingWithdrawals, 1);
    assert.equal(w.demoAllowed, false);
    // Tamper with the wallet's own ledger: the next withdrawal is refused.
    p.objects.get(address).ctx.storage.db.exec("UPDATE real_tics SET balance_cents = balance_cents + 100000");
    assert.equal((await wd(1000)).status, 409);
  } finally { p.restore(); }
});

test('holdings: native and token balances with USD values; unpriced dust is hidden', () => {
  const rows = parseHoldings({ data: { tokens: [
    { network: 'eth-mainnet', address: '0x1', tokenAddress: null, tokenBalance: '0xde0b6b3a7640000', tokenPrices: [{ currency: 'usd', value: '3000' }] },
    { network: 'base-mainnet', address: '0x1', tokenAddress: '0xAbC', tokenBalance: '2500000', tokenMetadata: { symbol: 'USDC', name: 'USD Coin', decimals: 6 }, tokenPrices: [{ currency: 'usd', value: '1' }] },
    { network: 'bnb-mainnet', address: '0x1', tokenAddress: '0xdef', tokenBalance: '0x1', tokenMetadata: { symbol: 'SCAM', decimals: 18 }, tokenPrices: [] },
    { network: 'polygon-mainnet', address: '0x1', tokenAddress: null, tokenBalance: '0x1' },
  ] } });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].symbol, 'ETH'); assert.equal(rows[0].usdValue, 3000); assert.equal(rows[0].hidden, 0);
  assert.equal(rows[1].amount, '2.5'); assert.equal(rows[1].usdValue, 2.5); assert.equal(rows[1].token, '0xabc');
  assert.equal(rows[2].hidden, 1);
});

test('withdrawal fee: the player pays the payout gas, priced in $TICS, with a margin and a quote guard', async () => {
  const p = platform();
  try {
    p.setTics({ casinoWallet: CASINO, realEnabled: true, startBlock: 990, gasFeeMarginPct: 20, fallbackFeeUnits: 50000, minWithdrawalUnits: 50000 });
    const a = await p.login();
    const address = a.account.address.toLowerCase();
    await p.call('/api/session', { cookie: a.cookie, body: {} });
    // No gas or price data yet: the fallback fee applies.
    assert.equal((await p.call('/api/wallet/withdraw/quote', { cookie: a.cookie })).data.feeCents, 50000);
    p.chain.transfer({ from: address, wei: 5000n * 10n ** 18n, block: 990 });
    const realFetch = globalThis.fetch;
    const inner = globalThis.fetch;
    globalThis.fetch = async (url, init) => String(url).startsWith('https://api.coingecko.com/api/v3/simple/price?ids=qubetics')
      ? Response.json({ qubetics: { eth: 0.000002, usd: 0.006 } }) : inner(url, init);
    try {
      p.chain.rpc.base = p.chain.rpc;
      const rpc = async (m, params) => m === 'eth_getBlockByNumber' ? { baseFeePerGas: '0x77359400' } : m === 'eth_maxPriorityFeePerGas' ? '0x3b9aca00' : p.chain.rpc(m, params);
      await chainTick(p.env, { rpc });
    } finally { globalThis.fetch = realFetch; }
    // gas = 65,000 x (2 x 2 gwei + 1 gwei) = 0.000325 ETH; / 0.000002 ETH per $TICS = 162.5 $TICS; +20% = 195 $TICS.
    const q = await p.call('/api/wallet/withdraw/quote', { cookie: a.cookie });
    assert.equal(q.data.feeCents, 10920);
    assert.equal(q.data.minWithdrawalCents, 50000);
    assert.equal((await p.call('/api/wallet/withdraw', { cookie: a.cookie, body: { amountCents: 49999, requestId: randomUUID(), maxFeeCents: 19500 } })).status, 400);
    assert.equal((await p.call('/api/wallet/me', { cookie: a.cookie })).data.withdrawalFeeCents, 10920);
    // The browser agreed to a lower fee than the current one: refused, nothing held.
    assert.equal((await p.call('/api/wallet/withdraw', { cookie: a.cookie, body: { amountCents: 100000, requestId: randomUUID(), maxFeeCents: 10000 } })).status, 409, 'fee rose above what the player saw');
    assert.equal((await p.call('/api/wallet', { cookie: a.cookie })).data.realTicsCents, 500000);
    const ok = await p.call('/api/wallet/withdraw', { cookie: a.cookie, body: { amountCents: 100000, requestId: randomUUID(), maxFeeCents: 10920 } });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.feeCents, 10920);
    assert.equal(ok.data.sendCents, 89080);
    const [row] = p.rows('SELECT fee_units, send_units FROM chain_withdrawals');
    assert.deepEqual({ ...row }, { fee_units: 10920, send_units: 89080 });
    // Fees switched off in the admin panel: no fee at all.
    p.setTics({ feesEnabled: false });
    assert.equal((await p.call('/api/wallet/withdraw/quote', { cookie: a.cookie })).data.feeCents, 0);
  } finally { p.restore(); }
});

test('holdings parse the real Alchemy response shape (public sample from the live API, 2026-10-28)', async () => {
  const fs = await import('node:fs');
  const path = new URL('./fixtures/alchemy-tokens-sample.json', import.meta.url);
  const rows = parseHoldings(JSON.parse(fs.readFileSync(path, 'utf8')));
  assert.ok(rows.length > 3);
  const natives = rows.filter((r) => r.token === 'native');
  assert.deepEqual(natives.map((r) => r.symbol).sort(), ['BNB', 'ETH', 'ETH']);
  assert.ok(natives.every((r) => r.usdValue > 0 && r.hidden === 0));
});

test('quick deposits: small ones credit after 3 confirmations, big ones wait for 12, none twice or lost', async () => {
  const p = platform();
  try {
    p.setTics({ casinoWallet: CASINO, realEnabled: true, startBlock: 990, quickConfirmations: 3, quickDepositMaxUnits: 100_000_000 });
    const a = await p.login();
    const address = a.account.address.toLowerCase();
    await p.call('/api/session', { cookie: a.cookie, body: {} });
    p.chain.block = 1000;
    const small = p.chain.transfer({ from: address, wei: 2000n * 10n ** 18n, block: 998 });      // 3 confirmations at 1000
    const big = p.chain.transfer({ from: address, wei: 2_000_000n * 10n ** 18n, block: 998 });  // above 1,000,000 $TICS
    const fresh = p.chain.transfer({ from: address, wei: 5n * 10n ** 18n, block: 999 });        // only 2 confirmations
    await chainTick(p.env, { rpc: p.chain.rpc });
    let w = (await p.call('/api/wallet', { cookie: a.cookie })).data;
    assert.equal(w.realTicsCents, 200000, 'only the small deposit with 3 confirmations');
    const check = (await p.call('/api/wallet/deposit/check', { cookie: a.cookie, body: { txHash: big } })).data;
    assert.equal(check.status, 'confirming');
    assert.equal(check.required, 12);
    assert.equal((await p.call('/api/wallet/deposit/check', { cookie: a.cookie, body: { txHash: fresh } })).data.required, 3);
    p.chain.block = 1001;
    await chainTick(p.env, { rpc: p.chain.rpc });
    w = (await p.call('/api/wallet', { cookie: a.cookie })).data;
    assert.equal(w.realTicsCents, 200500, 'the 5 $TICS one at 3 confirmations; the big one still waiting');
    p.chain.block = 1009;
    await chainTick(p.env, { rpc: p.chain.rpc });
    await chainTick(p.env, { rpc: p.chain.rpc });
    w = (await p.call('/api/wallet', { cookie: a.cookie })).data;
    assert.equal(w.realTicsCents, 200500 + 200_000_000, 'big one credited at 12 confirmations');
    assert.equal(p.rows("SELECT COUNT(*) AS n FROM chain_deposits WHERE status = 'credited'")[0].n, 3);
    assert.ok(small);
  } finally { p.restore(); }
});

test('quick deposits: a big amount split into many small transfers waits for the full depth past the daily quick cap', async () => {
  const p = platform();
  try {
    p.setTics({ casinoWallet: CASINO, realEnabled: true, startBlock: 990, quickConfirmations: 3, quickDepositMaxUnits: 100_000_000, quickDailyMaxUnits: 150_000_000 });
    const a = await p.login();
    const address = a.account.address.toLowerCase();
    await p.call('/api/session', { cookie: a.cookie, body: {} });
    p.chain.block = 1000;
    const tx = [];
    for (let i = 0; i < 3; i++) tx.push(p.chain.transfer({ from: address, wei: 900_000n * 10n ** 18n, block: 998 }));
    await chainTick(p.env, { rpc: p.chain.rpc });
    assert.equal((await p.call('/api/wallet', { cookie: a.cookie })).data.realTicsCents, 90_000_000, 'only the first fits the 1.5M quick cap');
    const check = (await p.call('/api/wallet/deposit/check', { cookie: a.cookie, body: { txHash: tx[2] } })).data;
    assert.equal(check.required, 12, 'the fast path follows the same cap');
    p.chain.block = 1009;
    await chainTick(p.env, { rpc: p.chain.rpc }); await chainTick(p.env, { rpc: p.chain.rpc });
    assert.equal((await p.call('/api/wallet', { cookie: a.cookie })).data.realTicsCents, 270_000_000, 'the rest credit at 12 confirmations, once each');
    assert.equal(p.rows("SELECT COUNT(*) AS n FROM chain_deposits WHERE status = 'credited'")[0].n, 3);
  } finally { p.restore(); }
});

test('treasury sends in flight and starting withdrawals count as owed, so they are not free float', async () => {
  const p = platform();
  try {
    const a = await funded(p, 5000n, 100000n);
    const { owedUnits, liveFloat } = await import('./wallet.js');
    const before = await owedUnits(p.env.DB);
    p.env.DB.raw.prepare(`INSERT INTO chain_withdrawals (id, kind, chain_id, to_address, amount_units, send_units, status, release_at) VALUES ('t1', 'treasury', 1, '0x3ed7eaa1ca4b5c10336c6bf88f969f5bafd730d2', 4000000, 4000000, 'queued', datetime('now'))`).run();
    p.env.DB.raw.prepare(`INSERT INTO chain_withdrawals (id, kind, player_id, chain_id, to_address, amount_units, send_units, status, release_at) VALUES ('w1', 'player', ?, 1, ?, 100000, 100000, 'holding', datetime('now'))`).run(a.address, a.address);
    assert.equal(await owedUnits(p.env.DB), before + 4000000 + 100000);
    const f = await liveFloat(p.env.DB, { ...(await (await import('./tics.js')).ticsSettings(p.env.DB)) });
    assert.equal(f.freeUnits, f.tokenUnits - f.owedUnits - f.heldUnits);
    assert.equal(f.maxWinUnits % 10_000, 0, 'published max win is rounded to whole 100 $TICS');
  } finally { p.restore(); }
});

test('guests: creating new sessions is rate limited per IP; missing build files are 404', async () => {
  const p = platform();
  try {
    let last;
    for (let i = 0; i < 62; i++) last = await p.call('/api/session', { body: {} });
    assert.equal(last.status, 429);
    p.env.ASSETS = { fetch: async () => new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } }) };
    const miss = await worker.fetch(new Request(`https://${HOST}/assets/nope.js`), p.env, { waitUntil() {} });
    assert.equal(miss.status, 404);
    const page = await worker.fetch(new Request(`https://${HOST}/how-it-works`), p.env, { waitUntil() {} });
    assert.equal(page.status, 200);
  } finally { p.restore(); }
});

test('quick cap holds against parallel deposit checks; every transfer in a transaction counts', async () => {
  const p = platform();
  try {
    p.setTics({ casinoWallet: CASINO, realEnabled: true, startBlock: 990, quickConfirmations: 3, quickDepositMaxUnits: 100_000_000, quickDailyMaxUnits: 100_000_000 });
    const a = await p.login();
    const address = a.account.address.toLowerCase();
    await p.call('/api/session', { cookie: a.cookie, body: {} });
    p.chain.block = 1000;
    const tx = [];
    for (let i = 0; i < 5; i++) tx.push(p.chain.transfer({ from: address, wei: 900_000n * 10n ** 18n, block: 998 }));
    const stub = p.env.CASINO.get(address); const orig = stub.fetch.bind(stub);
    stub.fetch = async (req) => { if (req.url.endsWith('/tics-deposit')) await new Promise((r) => setTimeout(r, 40)); return orig(req); };
    const checks = await Promise.all(tx.map((h) => p.call('/api/wallet/deposit/check', { cookie: a.cookie, body: { txHash: h } })));
    assert.equal(checks.filter((c) => c.data.status === 'credited').length, 1, JSON.stringify(checks.map((c) => c.data)));
    assert.equal((await p.call('/api/wallet', { cookie: a.cookie })).data.realTicsCents, 90_000_000);
  } finally { p.restore(); }
});

test('a big treasury send that is mined but not yet confirmed does not look like insolvency', async () => {
  const p = platform();
  try {
    await funded(p, 5000n, 1_000_000n);
    // 600,000 $TICS has left the wallet; the row is still 'sending' and counted as owed.
    p.env.DB.raw.prepare(`INSERT INTO chain_withdrawals (id, kind, chain_id, to_address, amount_units, send_units, status, release_at) VALUES ('t1', 'treasury', 1, '0x3ed7eaa1ca4b5c10336c6bf88f969f5bafd730d2', 60000000, 60000000, 'sending', datetime('now'))`).run();
    p.chain.tokenBalance -= 600_000n * 10n ** 18n;
    await chainTick(p.env, { rpc: p.chain.rpc });
    await chainTick(p.env, { rpc: p.chain.rpc });
    const settings = JSON.parse(p.rows("SELECT value FROM settings WHERE key = 'tics_payments'")[0].value);
    assert.notEqual(settings.payoutsPaused, true);
    assert.equal(p.rows("SELECT COUNT(*) AS n FROM alerts WHERE type = 'tics_insolvent'")[0].n, 0);
  } finally { p.restore(); }
});

test('a spin made under an old payout table is refused before anything is used, with a code', async () => {
  const p = platform();
  try {
    const g = await p.call('/api/session', { body: {} });
    const cookie = g.headers.get('set-cookie').split(';')[0];
    const r = await p.spin(cookie, [{ type: 'red', amountCents: 10000 }], 'demo', { mathId: 'straight34' });
    assert.equal(r.status, 409);
    assert.equal(r.data.code, 'table_changed');
    assert.equal((await p.spin(cookie, [{ type: 'red', amountCents: 10000 }], 'demo', { mathId: 'standard' })).status, 200);
  } finally { p.restore(); }
});

test('deposit scan catches up after a pause using 10-block log queries (provider limit)', async () => {
  const p = platform();
  try {
    p.setTics({ casinoWallet: CASINO, realEnabled: true, startBlock: 900 });
    const a = await p.login();
    const address = a.account.address.toLowerCase();
    await p.call('/api/session', { cookie: a.cookie, body: {} });
    p.chain.transfer({ from: address, wei: 3n * 10n ** 18n, block: 905 });
    p.chain.transfer({ from: address, wei: 4n * 10n ** 18n, block: 1001 });
    await chainTick(p.env, { rpc: p.chain.rpc }); // 100+ blocks behind: needs many 10-block steps
    assert.equal((await p.call('/api/wallet', { cookie: a.cookie })).data.realTicsCents, 700);
  } finally { p.restore(); }
});

// ---------- adversarial checks (security review 2026-10-29) ----------
async function funded(p, tics = 5000n, house = 1000000n) {
  p.setTics({ casinoWallet: CASINO, realEnabled: true, startBlock: 990, feesEnabled: false, minWithdrawalUnits: 1000, quickDepositMaxUnits: 0 });
  const a = await p.login();
  const address = a.account.address.toLowerCase();
  await p.call('/api/session', { cookie: a.cookie, body: {} });
  p.chain.transfer({ from: address, wei: tics * 10n ** 18n, block: 990 });
  p.chain.tokenBalance += house * 10n ** 18n; // house money
  await chainTick(p.env, { rpc: p.chain.rpc });
  return { ...a, address, wd: (amountCents, extra = {}) => p.call('/api/wallet/withdraw', { cookie: a.cookie, body: { amountCents, requestId: randomUUID(), ...extra } }) };
}
const realOf = async (p, cookie) => (await p.call('/api/wallet', { cookie })).data.realTicsCents;

test('adversarial: two withdrawals of the whole balance at the same moment pay out once', async () => {
  const p = platform();
  try {
    const a = await funded(p);
    const results = await Promise.all([a.wd(500000), a.wd(500000), a.wd(500000)]);
    assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results.map((r) => [r.status, r.data.error])));
    assert.equal(p.rows('SELECT COUNT(*) AS n FROM chain_withdrawals')[0].n, 1);
    assert.equal(await realOf(p, a.cookie), 0);
  } finally { p.restore(); }
});

test('adversarial: the same withdrawal sent several times at once holds and pays once, and never refunds the paid one', async () => {
  const p = platform();
  try {
    const a = await funded(p);
    const id = randomUUID();
    const stub = p.env.CASINO.get(a.address); const orig = stub.fetch.bind(stub);
    stub.fetch = async (req) => { if (req.url.endsWith('/tics-hold')) await new Promise((r) => setTimeout(r, 50)); return orig(req); };
    const body = { amountCents: 500000, requestId: id };
    const results = await Promise.all([1, 2, 3].map(() => p.call('/api/wallet/withdraw', { cookie: a.cookie, body })));
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200], JSON.stringify(results.map((r) => r.data)));
    assert.equal(results.filter((r) => !r.data.duplicate).length, 1, 'only one call did the work');
    const rows = p.rows('SELECT status, amount_units FROM chain_withdrawals');
    assert.deepEqual(rows.map((r) => [r.status, r.amount_units]), [['queued', 500000]]);
    assert.equal(await realOf(p, a.cookie), 0, 'the money is set aside exactly once');
    const hold = await (await orig(new Request('https://wallet/internal/tics-hold-check', { method: 'POST', headers: { 'X-Internal-Secret': 'test-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: `th:${id}` }) }))).json();
    assert.deepEqual(hold, { status: 'held', units: 500000 });
    // A different amount under the same id is refused.
    const other = await p.call('/api/wallet/withdraw', { cookie: a.cookie, body: { amountCents: 100000, requestId: id } });
    assert.equal(other.status, 409);
  } finally { p.restore(); }
});

test('a withdrawal whose hold reply was lost is finished by the sweep, and a failed hold leaves nothing behind', async () => {
  const p = platform();
  try {
    const a = await funded(p);
    const stub = p.env.CASINO.get(a.address); const orig = stub.fetch.bind(stub);
    // Hold succeeds inside the wallet but the reply is lost.
    stub.fetch = async (req) => { if (req.url.endsWith('/tics-hold')) { await orig(req); throw new Error('network'); } return orig(req); };
    const id = randomUUID();
    const lost = await p.call('/api/wallet/withdraw', { cookie: a.cookie, body: { amountCents: 200000, requestId: id } });
    assert.equal(lost.status, 500);
    assert.equal(p.rows('SELECT status FROM chain_withdrawals WHERE id = ?', id)[0].status, 'holding');
    stub.fetch = orig;
    const { settleHoldingRows } = await import('./wallet.js');
    await settleHoldingRows(p.env, Date.now() + 5 * 60_000);
    assert.equal(p.rows('SELECT status FROM chain_withdrawals WHERE id = ?', id)[0].status, 'queued');
    // Not enough balance: the claim is removed again.
    const big = await p.call('/api/wallet/withdraw', { cookie: a.cookie, body: { amountCents: 99_000_000, requestId: randomUUID() } });
    assert.equal(big.status, 402);
    assert.equal(p.rows('SELECT COUNT(*) AS n FROM chain_withdrawals')[0].n, 1);
  } finally { p.restore(); }
});

test('adversarial: a spin and a withdrawal racing for the same funds never both spend them', async () => {
  const p = platform();
  try {
    const a = await funded(p);
    const [spin, wd] = await Promise.all([p.spin(a.cookie, [{ type: 'red', amountCents: 500000 }], 'real'), a.wd(500000)]);
    assert.ok(!(spin.status === 200 && wd.status === 200), `both succeeded: ${spin.status} ${wd.status}`);
    const balance = await realOf(p, a.cookie);
    assert.ok(balance >= 0);
    const queued = p.rows('SELECT COALESCE(SUM(amount_units),0) AS n FROM chain_withdrawals')[0].n;
    const stake = spin.status === 200 ? spin.data.totalStakeCents : 0;
    const won = spin.status === 200 ? spin.data.totalPayoutCents : 0;
    assert.equal(balance + queued + stake - won, 500000, 'every unit is accounted for');
  } finally { p.restore(); }
});

test('adversarial: one deposit credits once, cannot be claimed by another wallet, and fake tokens never credit', async () => {
  const p = platform();
  try {
    const a = await funded(p);
    const tx = p.rows('SELECT tx_hash FROM chain_deposits')[0].tx_hash;
    for (let i = 0; i < 3; i++) { await chainTick(p.env, { rpc: p.chain.rpc }); await p.call('/api/wallet/deposit/check', { cookie: a.cookie, body: { txHash: tx } }); }
    assert.equal(await realOf(p, a.cookie), 500000);
    const b = await p.login();
    await p.call('/api/session', { cookie: b.cookie, body: {} });
    // Asking about someone else's transfer only reports its public on-chain status; credit follows the sender.
    await p.call('/api/wallet/deposit/check', { cookie: b.cookie, body: { txHash: tx } });
    assert.equal(await realOf(p, b.cookie), 0);
    const fake = p.chain.transfer({ token: FAKE_TICS, from: b.account.address.toLowerCase(), wei: 10n ** 24n, block: 995 });
    await chainTick(p.env, { rpc: p.chain.rpc });
    await p.call('/api/wallet/deposit/check', { cookie: b.cookie, body: { txHash: fake } });
    assert.equal(await realOf(p, b.cookie), 0);
    assert.equal(p.rows('SELECT COUNT(*) AS n FROM chain_deposits WHERE tx_hash = ?', tx)[0].n, 1);
  } finally { p.restore(); }
});

test('adversarial: demo money never becomes real money', async () => {
  const p = platform();
  try {
    p.setTics({ casinoWallet: CASINO, realEnabled: true, startBlock: 990, feesEnabled: false, minWithdrawalUnits: 1000 });
    const a = await p.login();
    const address = a.account.address.toLowerCase();
    await p.call('/api/session', { cookie: a.cookie, body: {} });
    for (let i = 0; i < 3; i++) await p.spin(a.cookie, [{ type: 'red', amountCents: 100000 }], 'demo');
    const w = (await p.call('/api/wallet', { cookie: a.cookie })).data;
    assert.ok(w.balanceCents > 0);
    assert.equal(w.realTicsCents, 0);
    assert.equal((await p.call('/api/wallet/withdraw', { cookie: a.cookie, body: { amountCents: 100000, requestId: randomUUID() } })).status, 403, 'no deposit, no withdrawal');
    // After a small real deposit, the demo balance still cannot be withdrawn or spent as real.
    p.chain.transfer({ from: address, wei: 20n * 10n ** 18n, block: 990 });
    p.chain.tokenBalance += 100000n * 10n ** 18n;
    await chainTick(p.env, { rpc: p.chain.rpc });
    assert.equal((await p.call('/api/wallet/withdraw', { cookie: a.cookie, body: { amountCents: 100000, requestId: randomUUID() } })).status, 402);
    assert.equal((await p.spin(a.cookie, [{ type: 'red', amountCents: 100000 }], 'real')).status, 402);
    assert.equal((await p.spin(a.cookie, [{ type: 'red', amountCents: 1000 }], 'demo')).status, 403, 'demo is closed while funded');
    assert.equal(p.rows("SELECT COALESCE(SUM(amount_cents),0) AS n FROM ledger WHERE player_id = ? AND real_money = 1", address)[0].n, 2000);
  } finally { p.restore(); }
});

test('adversarial: malformed bets are refused and move no money', async () => {
  const p = platform();
  try {
    const a = await funded(p);
    const before = await realOf(p, a.cookie);
    const bad = [
      [{ type: 'red', amountCents: -100 }], [{ type: 'red', amountCents: 0 }], [{ type: 'red', amountCents: 1.5 }],
      [{ type: 'red', amountCents: 1e20 }], [{ type: 'red', amountCents: '100' }], [{ type: 'jackpot', amountCents: 100 }],
      [{ type: 'straight', value: 37, amountCents: 100 }], [{ type: 'straight', value: -1, amountCents: 100 }], [{ type: 'split', value: [1, 9], amountCents: 100 }],
      [{ type: 'corner', value: [1, 2], amountCents: 100 }], [], Array.from({ length: 500 }, () => ({ type: 'red', amountCents: 100 })),
      [{ type: 'red', amountCents: Number.MAX_SAFE_INTEGER }, { type: 'black', amountCents: Number.MAX_SAFE_INTEGER }],
    ];
    for (const bets of bad) {
      const r = await p.spin(a.cookie, bets, 'real');
      assert.ok(r.status >= 400 && r.status < 500 || r.status === 503, `${JSON.stringify(bets).slice(0, 80)} -> ${r.status}`);
    }
    assert.equal(await realOf(p, a.cookie), before);
    assert.equal(p.rows('SELECT COUNT(*) AS n FROM rounds')[0].n, 0);
  } finally { p.restore(); }
});

test('adversarial: replaying a spin returns the same result and settles once', async () => {
  const p = platform();
  try {
    const a = await funded(p);
    const c = (await p.call('/api/fairness/commitment', { cookie: a.cookie })).data;
    const body = { bets: [{ type: 'red', amountCents: 1000 }], requestId: randomUUID(), expectedCommitment: c, clientEntropy: randomBytes(32).toString('hex'), mode: 'real' };
    const first = await p.call('/api/games/roulette/spin', { cookie: a.cookie, body });
    const again = await Promise.all([1, 2, 3].map(() => p.call('/api/games/roulette/spin', { cookie: a.cookie, body })));
    assert.equal(first.status, 200);
    for (const r of again) assert.deepEqual(r.data, first.data);
    const settles = p.objects.get(a.address).ctx.storage.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE type LIKE 'bet_settle%'").get().n;
    assert.equal(settles, 1);
    assert.equal(await realOf(p, a.cookie), first.data.balanceAfterCents);
  } finally { p.restore(); }
});

test('adversarial: a withdrawal always goes to the depositing wallet, whatever the request says', async () => {
  const p = platform();
  try {
    const a = await funded(p);
    const r = await a.wd(10000, { toAddress: '0x000000000000000000000000000000000000dead', address: '0x000000000000000000000000000000000000dead', to: '0x000000000000000000000000000000000000dead' });
    assert.equal(r.status, 200);
    assert.equal(p.rows('SELECT to_address FROM chain_withdrawals')[0].to_address, a.address);
  } finally { p.restore(); }
});

test('liability: one spin may pay at most the set share of the free float; demo follows the same limit', async () => {
  const p = platform();
  try {
    const a = await funded(p, 5000n, 100000n); // player 5,000 $TICS, house 100,000 $TICS free
    // 25% of 100,000 = 25,000 $TICS total payout. A 1,000 straight pays 36,000: refused, in plain words.
    const big = await p.spin(a.cookie, [{ type: 'straight', value: 7, amountCents: 100000 }], 'real');
    assert.equal(big.status, 503);
    assert.match(big.data.error, /^The most you can bet on one number right now is 694\.44 \$TICS\.$/);
    // 694.44 on one number pays 24,999.84: allowed.
    const ok = await p.spin(a.cookie, [{ type: 'straight', value: 7, amountCents: 69444 }], 'real');
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(p.rows('SELECT COUNT(*) AS n FROM spin_holds')[0].n, 0, 'booking released after the spin');
    const reserve = (await p.call('/api/casino/reserve')).data;
    assert.equal(reserve.live, true);
    assert.equal(reserve.maxStraightUnits, Math.floor(reserve.maxWinUnits / 36));
    assert.equal('owedUnits' in reserve, false, 'what players are owed is not published');
    // Demo: same table limit for a guest.
    const g = await p.call('/api/session', { body: {} });
    const gc = g.headers.get('set-cookie').split(';')[0];
    const demoBig = await p.spin(gc, [{ type: 'straight', value: 7, amountCents: 5000000 }], 'demo');
    assert.equal(demoBig.status, 503);
    assert.match(demoBig.data.error, /most you can bet on one number/);
    assert.equal((await p.spin(gc, [{ type: 'straight', value: 7, amountCents: 10000 }], 'demo')).status, 200);
  } finally { p.restore(); }
});

test('liability: many players spinning at the same moment can never be owed more than the wallet holds', async () => {
  const p = platform();
  try {
    p.setTics({ casinoWallet: CASINO, realEnabled: true, startBlock: 990, feesEnabled: false, minWithdrawalUnits: 1000, quickDepositMaxUnits: 0, maxSpinExposurePct: 100 });
    const players = [];
    for (let i = 0; i < 10; i++) {
      const a = await p.login();
      await p.call('/api/session', { cookie: a.cookie, body: {} });
      p.chain.transfer({ from: a.account.address.toLowerCase(), wei: 1000n * 10n ** 18n, block: 990 });
      players.push(a);
    }
    p.chain.tokenBalance += 20000n * 10n ** 18n; // house money: 20,000 $TICS free
    await chainTick(p.env, { rpc: p.chain.rpc });
    // Each bet: 500 on one number, worst net win 17,500. Free float 20,000: at most one can be in play at a time.
    // Hold the Durable Objects so all ten requests overlap while their bookings are open.
    let release; const gate = new Promise((r) => { release = r; });
    for (const a of players) { const obj = p.env.CASINO.get(a.account.address.toLowerCase()); const f = obj.fetch.bind(obj); obj.fetch = async (req) => { await gate; return f(req); }; }
    const pending = players.map((a) => p.spin(a.cookie, [{ type: 'straight', value: 7, amountCents: 50000 }], 'real'));
    await new Promise((r) => setTimeout(r, 300));
    const held = p.rows('SELECT COALESCE(SUM(units),0) AS n, COUNT(*) AS c FROM spin_holds')[0];
    assert.ok(held.n <= 2000000, `booked ${held.n} > free float`);
    release();
    const results = await Promise.all(pending);
    const okCount = results.filter((r) => r.status === 200).length;
    const busy = results.filter((r) => r.status === 503 && /Several big bets|most you can bet on one number/.test(r.data.error)).length; // refused while booked, or after earlier wins shrank the float
    assert.ok(okCount >= 1, 'at least one ran');
    assert.equal(okCount + busy, 10, JSON.stringify(results.map((r) => [r.status, r.data.error])));
    assert.equal(p.rows('SELECT COUNT(*) AS n FROM spin_holds')[0].n, 0, 'every booking released');
    // Whatever happened, the wallet still covers every player balance.
    await chainTick(p.env, { rpc: p.chain.rpc });
    const float = JSON.parse(p.rows("SELECT value FROM chain_state WHERE key = 'float'")[0].value);
    assert.ok(float.tokenUnits >= float.owedUnits, `wallet ${float.tokenUnits} < owed ${float.owedUnits}`);
  } finally { p.restore(); }
});

test('security headers: HSTS everywhere and a CSP on the HTML page', async () => {
  const p = platform();
  try {
    p.env.ASSETS = { fetch: async () => new Response('<!doctype html><title>x</title>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) };
    const page = await worker.fetch(new Request(`https://${HOST}/`), p.env, { waitUntil() {} });
    const csp = page.headers.get('Content-Security-Policy');
    assert.match(csp, /script-src 'self' https:\/\/static\.cloudflareinsights\.com(;|$)/);
    assert.doesNotMatch(csp, /unsafe-eval/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(page.headers.get('Strict-Transport-Security'), /max-age=31536000/);
    const api = await p.call('/api/health');
    assert.match(api.headers.get('Strict-Transport-Security'), /max-age/);
    // Static pages are served straight from assets, so the same policy must be in _headers.
    const { readFileSync } = await import('node:fs');
    const headersFile = readFileSync(new URL('../frontend/public/_headers', import.meta.url), 'utf8');
    assert.ok(headersFile.includes(`Content-Security-Policy: ${csp}`), '_headers carries the same CSP as the Worker');
    assert.match(headersFile, /Strict-Transport-Security: max-age=31536000; includeSubDomains/);
  } finally { p.restore(); }
});

// ---------- re-audit round 3 (2026-10-30) ----------
const internal = (p, address, name, body, fetchImpl) => (fetchImpl || ((req) => p.env.CASINO.get(address).fetch(req)))(new Request(`https://wallet/internal/${name}`, {
  method: 'POST', headers: { 'X-Internal-Secret': 'test-secret', 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).then((r) => r.json());
const sqlTimeOf = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

test('r3 table limit: a payout marked sent after the wallet snapshot still comes off that snapshot', async () => {
  const { liveFloat, reserveSpinExposure } = await import('./wallet.js');
  const DB = createD1(MIGRATIONS);
  const T = Date.parse('2031-01-01T00:00:00Z'); // own clock, far from any other test's cache
  DB.raw.prepare("INSERT INTO chain_state (key, value) VALUES ('float', ?)").run(JSON.stringify({ at: T, chainId: 1, wallet: CASINO, tokenUnits: 100_000_000 })); // 1,000,000 $TICS
  DB.raw.prepare("INSERT INTO players (id, real_tics_cents) VALUES ('p1', 20000000)").run(); // owed 200,000
  const id = randomUUID();
  DB.raw.prepare("INSERT INTO chain_withdrawals (id, kind, chain_id, to_address, amount_units, send_units, status, release_at) VALUES (?, 'treasury', 1, '0xabc', 60000000, 60000000, 'sending', '2000-01-01')").run(id);
  const settings = { casinoWallet: CASINO, maxSpinExposurePct: 25 };
  const before = await liveFloat(DB, settings, T + 1);
  assert.equal(before.freeUnits, 20_000_000, 'true free float: 1,000,000 - 200,000 owed - 600,000 sending');
  // The treasury send is confirmed and marked sent; the snapshot is not refreshed yet.
  DB.raw.prepare("UPDATE chain_withdrawals SET status = 'sent', sent_at = ? WHERE id = ?").run(sqlTimeOf(T + 40_000), id);
  const after = await liveFloat(DB, settings, T + 60_000);
  assert.equal(after.freeUnits, 20_000_000, 'the free float does not jump when a payout is marked sent');
  assert.equal(after.maxWinUnits, before.maxWinUnits);
  let booked = 0;
  for (let i = 0; i < 8; i++) if (await reserveSpinExposure(DB, { id: `h${i}`, playerId: 'p2', units: 10_000_000, now: T + 60_000 })) booked += 10_000_000;
  assert.equal(booked, 20_000_000, 'bookings never pass the true free float');
  // Once a newer snapshot (after the send) exists, the payout is not taken off twice.
  DB.raw.prepare("DELETE FROM spin_holds").run();
  DB.raw.prepare("UPDATE chain_state SET value = ? WHERE key = 'float'").run(JSON.stringify({ at: T + 120_000, chainId: 1, wallet: CASINO, tokenUnits: 40_000_000 }));
  const fresh = await liveFloat(DB, settings, T + 140_000);
  assert.equal(fresh.freeUnits, 20_000_000);
  assert.equal(await reserveSpinExposure(DB, { id: 'h9', playerId: 'p2', units: 20_000_000, now: T + 140_000 }), true);
  // The lookup uses the partial index, not a scan of every payout ever sent.
  const plan = DB.raw.prepare("EXPLAIN QUERY PLAN SELECT COALESCE(SUM(send_units), 0) FROM chain_withdrawals WHERE status = 'sent' AND sent_at >= ?").all('2031-01-01 00:00:00').map((r) => r.detail).join(' | ');
  assert.match(plan, /chain_withdrawals_sent_at \(status=\? AND sent_at>\?\)/, plan);
  const { OWED_SQL } = await import('./wallet.js');
  const booking = DB.raw.prepare(`EXPLAIN QUERY PLAN SELECT (SELECT COALESCE(SUM(send_units), 0) FROM chain_withdrawals WHERE status = 'sent' AND sent_at >= (SELECT datetime(CAST(json_extract(value, '$.at') AS INTEGER) / 1000 - 30, 'unixepoch') FROM chain_state WHERE key = 'float')) - (${OWED_SQL})`).all().map((r) => r.detail).join(' | ');
  assert.match(booking, /chain_withdrawals_sent_at \(status=\? AND sent_at>\?\)/, booking);
});

test('r3 table limit: the wallet snapshot is refreshed even when the deposit scan fails', async () => {
  const p = platform();
  try {
    await funded(p);
    const first = JSON.parse(p.rows("SELECT value FROM chain_state WHERE key = 'float'")[0].value);
    await new Promise((r) => setTimeout(r, 5));
    const rpc = async (m, a) => { if (m === 'eth_getLogs' || m === 'eth_blockNumber') throw new Error('node down for logs'); return p.chain.rpc(m, a); };
    p.chain.block += 30;
    await assert.rejects(() => chainTick(p.env, { rpc }), /node down/);
    const second = JSON.parse(p.rows("SELECT value FROM chain_state WHERE key = 'float'")[0].value);
    assert.ok(second.at > first.at, 'snapshot refreshed');
  } finally { p.restore(); }
});

test('r3 rate limit: spins are limited per player (burst 10, then 5 a second); a refused spin changes nothing', async () => {
  const p = platform();
  try {
    const a = await p.login();
    const address = a.account.address.toLowerCase();
    await p.call('/api/session', { cookie: a.cookie, body: {} });
    const obj = p.env.CASINO.get(address);
    let clock = Date.now(); obj.now = () => clock;
    let last;
    for (let i = 0; i < 10; i++) { last = await p.spin(a.cookie, [{ type: 'red', amountCents: 100 }], 'demo'); assert.equal(last.status, 200, JSON.stringify(last.data)); }
    const before = (await p.call('/api/wallet', { cookie: a.cookie })).data.balanceCents;
    const lock = (await p.call('/api/fairness/commitment', { cookie: a.cookie })).data;
    const limited = await p.spin(a.cookie, [{ type: 'red', amountCents: 100 }], 'demo');
    assert.equal(limited.status, 429);
    assert.equal(limited.data.error, 'Slow down a little. Your bet was not taken.');
    assert.equal((await p.call('/api/wallet', { cookie: a.cookie })).data.balanceCents, before, 'no money moved');
    assert.deepEqual((await p.call('/api/fairness/commitment', { cookie: a.cookie })).data, lock, 'the lock was not used');
    clock += 200; // one more token after 0.2 s
    assert.equal((await p.spin(a.cookie, [{ type: 'red', amountCents: 100 }], 'demo')).status, 200);
    assert.equal((await p.spin(a.cookie, [{ type: 'red', amountCents: 100 }], 'demo')).status, 429);
  } finally { p.restore(); }
});

test('r3 rate limit: analytics events are limited per player', async () => {
  const p = platform();
  try {
    const g = await p.call('/api/session', { body: {} });
    const cookie = g.headers.get('set-cookie').split(';')[0];
    const statuses = [];
    for (let i = 0; i < 130; i++) statuses.push((await p.call('/api/events', { cookie, body: { type: 'screen', screen: '390x844' } })).status);
    assert.ok(statuses.filter((s) => s === 200).length <= 120, 'at most 60 a minute');
    assert.ok(statuses.includes(429));
    assert.ok(p.rows("SELECT COUNT(*) AS n FROM events WHERE type = 'screen'")[0].n <= 120);
  } finally { p.restore(); }
});

test('r3 demo spins share one table limit reading for a few seconds', async () => {
  const { liveFloatCached } = await import('./wallet.js');
  const DB = createD1(MIGRATIONS);
  const T = Date.parse('2032-01-01T00:00:00Z');
  DB.raw.prepare("INSERT INTO chain_state (key, value) VALUES ('float', ?)").run(JSON.stringify({ at: T, chainId: 1, wallet: CASINO, tokenUnits: 100_000_000 }));
  const settings = { casinoWallet: CASINO, maxSpinExposurePct: 25 };
  let reads = 0; const prepare = DB.prepare; DB.prepare = (q) => { reads++; return prepare(q); };
  const a = await liveFloatCached(DB, settings, T + 1);
  const used = reads;
  const b = await liveFloatCached(DB, settings, T + 3000);
  assert.equal(reads, used, 'second demo spin reads nothing');
  assert.deepEqual(a, b);
  await liveFloatCached(DB, settings, T + 6000);
  assert.ok(reads > used, 'refreshed after 5 s');
});

test('r3 spin booking is kept when the wallet call fails with no reply (the spin may have settled)', async () => {
  const p = platform();
  try {
    const a = await funded(p);
    const obj = p.env.CASINO.get(a.address); const orig = obj.fetch.bind(obj);
    obj.fetch = async (req) => { if (new URL(req.url).pathname === '/api/games/roulette/spin') { await orig(req); throw new Error('Durable Object reset'); } return orig(req); };
    const r = await p.spin(a.cookie, [{ type: 'straight', value: 7, amountCents: 1000 }], 'real');
    assert.equal(r.status, 500);
    assert.equal(p.rows('SELECT COUNT(*) AS n FROM spin_holds')[0].n, 1, 'booking left to expire');
    obj.fetch = orig;
    assert.equal((await p.spin(a.cookie, [{ type: 'straight', value: 7, amountCents: 1000 }], 'real')).status, 200);
    assert.equal(p.rows('SELECT COUNT(*) AS n FROM spin_holds')[0].n, 1, 'a normal spin still frees its own booking');
  } finally { p.restore(); }
});

test('r3 central copy: demo ledger rows stay demo even when the game is set to real money', async () => {
  const DB = createD1(MIGRATIONS);
  DB.raw.prepare("INSERT INTO players (id) VALUES ('guest1')").run();
  const obj = new DemoCasino({ storage: doStorage() }, { DB, STAGING: 'true' });
  obj.setMeta('player_id', 'guest1');
  obj.setMeta('real_money', 1); // stored when the game config says realMoney
  obj.init({}, 1000);
  await obj.flushOnce();
  const rows = DB.raw.prepare("SELECT type, real_money FROM ledger WHERE player_id = 'guest1'").all();
  assert.deepEqual(rows.map((r) => [r.type, r.real_money]), [['demo_credit', 0]]);
});

test('r3 replay records older than a day are pruned by the wallet', async () => {
  const p = platform();
  try {
    const a = await p.login();
    const address = a.account.address.toLowerCase();
    await p.call('/api/session', { cookie: a.cookie, body: {} });
    const db = p.env.CASINO.get(address).ctx.storage.db;
    db.prepare("INSERT INTO idempotency (request_key, fingerprint, response_json, created_at) VALUES ('old', 'x', '{}', datetime('now', '-2 days'))").run();
    db.prepare("INSERT INTO entropy_used (client_entropy, created_at) VALUES ('old', datetime('now', '-2 days'))").run();
    assert.equal((await p.spin(a.cookie, [{ type: 'red', amountCents: 100 }], 'demo')).status, 200);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM idempotency WHERE request_key = 'old'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM entropy_used WHERE client_entropy = 'old'").get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM idempotency').get().n, 1, 'the new spin is still protected');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entropy_used').get().n, 1);
  } finally { p.restore(); }
});

test('r3 deposits: a transfer moved to another block by a reorg is credited once; identical transfers in one tx credit each', async () => {
  const p = platform();
  try {
    const a = await funded(p);
    assert.equal(await realOf(p, a.cookie), 500000);
    // Reorg: the same transaction comes back in a later block at another log index.
    const log = p.chain.logs[0];
    const tx = log.transactionHash;
    log.blockNumber = '0x3e8'; log.logIndex = '0x5'; // block 1000, log 5
    p.chain.receipts.set(tx, { status: '0x1', blockNumber: log.blockNumber, transactionHash: tx, logs: [log] });
    p.chain.block = 1040;
    await chainTick(p.env, { rpc: p.chain.rpc });
    await p.call('/api/wallet/deposit/check', { cookie: a.cookie, body: { txHash: tx } });
    assert.equal(await realOf(p, a.cookie), 500000, 'not credited twice');
    assert.equal(p.rows('SELECT COUNT(*) AS n FROM chain_deposits WHERE tx_hash = ?', tx)[0].n, 1);
    assert.equal(p.rows("SELECT COUNT(*) AS n FROM alerts WHERE type = 'tics_reorg'")[0].n, 1);
    // Two identical transfers in one transaction are two deposits.
    const tx2 = p.chain.transfer({ from: a.address, wei: 10n * 10n ** 18n, block: 1041 });
    const second = { ...p.chain.logs.at(-1), logIndex: '0x1' };
    p.chain.logs.push(second);
    p.chain.receipts.get(tx2).logs.push(second);
    p.chain.tokenBalance += 10n * 10n ** 18n;
    p.chain.block = 1060;
    await chainTick(p.env, { rpc: p.chain.rpc });
    assert.equal(await realOf(p, a.cookie), 502000);
    assert.deepEqual(p.rows('SELECT tx_ordinal FROM chain_deposits WHERE tx_hash = ? ORDER BY log_index', tx2).map((r) => r.tx_ordinal), [0, 1]);
  } finally { p.restore(); }
});

test('r3 migration 0007 is safe on existing deposits', async () => {
  const { readFileSync } = await import('node:fs');
  const DB = createD1(MIGRATIONS.slice(0, 6));
  const ins = DB.raw.prepare("INSERT INTO chain_deposits (id, chain_id, tx_hash, log_index, block_number, from_address, to_address, amount_wei, amount_units, status) VALUES (?, 1, ?, ?, 1, ?, '0xc', ?, 100, 'credited')");
  ins.run('1:0xa:0', '0xa', 0, '0x1', '1000'); ins.run('1:0xa:3', '0xa', 3, '0x1', '1000'); ins.run('1:0xa:4', '0xa', 4, '0x2', '1000'); ins.run('1:0xb:0', '0xb', 0, '0x1', '1000');
  DB.raw.exec(readFileSync(MIGRATIONS[6], 'utf8'));
  assert.deepEqual(DB.raw.prepare('SELECT id, tx_ordinal FROM chain_deposits ORDER BY id').all().map((r) => [r.id, r.tx_ordinal]),
    [['1:0xa:0', 0], ['1:0xa:3', 1], ['1:0xa:4', 0], ['1:0xb:0', 0]]);
});

test('r3 withdrawals: a hold that lands after the sweep removed its claim moves no money', async () => {
  const p = platform();
  try {
    const a = await funded(p);
    const stub = p.env.CASINO.get(a.address); const orig = stub.fetch.bind(stub);
    let open; const gate = new Promise((r) => { open = r; });
    stub.fetch = async (req) => { if (req.url.endsWith('/tics-hold')) await gate; return orig(req); };
    const id = randomUUID();
    const pending = p.call('/api/wallet/withdraw', { cookie: a.cookie, body: { amountCents: 200000, requestId: id } });
    while (!p.rows('SELECT 1 FROM chain_withdrawals WHERE id = ?', id).length) await new Promise((r) => setTimeout(r, 5));
    const { settleHoldingRows } = await import('./wallet.js');
    await settleHoldingRows(p.env, Date.now() + 5 * 60_000); // the hold has not landed: claim removed, ref closed
    assert.equal(p.rows('SELECT COUNT(*) AS n FROM chain_withdrawals')[0].n, 0);
    open();
    const r = await pending;
    assert.equal(r.status, 409);
    assert.equal(r.data.error, 'This withdrawal request was closed before it went through. Your balance was not changed. Please start a new withdrawal.');
    const w = (await p.call('/api/wallet', { cookie: a.cookie })).data;
    assert.equal(w.realTicsCents, 500000, 'nothing held');
    assert.equal(w.pendingWithdrawals, 0);
    assert.equal(p.rows('SELECT COUNT(*) AS n FROM chain_withdrawals')[0].n, 0);
  } finally { p.restore(); }
});

test('r3 withdrawals: if the claim vanished and the refund fails, the request is kept, never "balance not changed"', async () => {
  const p = platform();
  try {
    const a = await funded(p);
    const stub = p.env.CASINO.get(a.address); const orig = stub.fetch.bind(stub);
    stub.fetch = async (req) => {
      if (req.url.endsWith('/tics-hold')) { const res = await orig(req); p.DB.raw.prepare('DELETE FROM chain_withdrawals').run(); return res; }
      if (req.url.endsWith('/tics-release')) throw new Error('network');
      return orig(req);
    };
    const id = randomUUID();
    const r = await p.call('/api/wallet/withdraw', { cookie: a.cookie, body: { amountCents: 200000, requestId: id } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.status, 'pending');
    assert.equal(p.rows('SELECT status FROM chain_withdrawals WHERE id = ?', id)[0].status, 'holding', 'still counted as owed');
    stub.fetch = orig;
    const { settleHoldingRows } = await import('./wallet.js');
    await settleHoldingRows(p.env, Date.now() + 5 * 60_000);
    assert.equal(p.rows('SELECT status FROM chain_withdrawals WHERE id = ?', id)[0].status, 'queued');
  } finally { p.restore(); }
});

test('r3 withdrawals: a retry under an id whose hold was given back is closed cleanly, a held one is queued, never a phantom block', async () => {
  const p = platform();
  try {
    const a = await funded(p);
    // Released under this id before (no row left): a clear message, no blocked row, balance intact.
    const gone = randomUUID();
    await internal(p, a.address, 'tics-hold', { ref: `th:${gone}`, amountCents: 100000 });
    await internal(p, a.address, 'tics-release', { ref: `th:${gone}` });
    const r1 = await p.call('/api/wallet/withdraw', { cookie: a.cookie, body: { amountCents: 100000, requestId: gone } });
    assert.equal(r1.status, 409);
    assert.match(r1.data.error, /Your balance was not changed/);
    assert.equal(p.rows('SELECT COUNT(*) AS n FROM chain_withdrawals')[0].n, 0);
    assert.equal(await realOf(p, a.cookie), 500000);
    // Held under this id with no row: the retry queues it.
    const kept = randomUUID();
    await internal(p, a.address, 'tics-hold', { ref: `th:${kept}`, amountCents: 100000 });
    const r2 = await p.call('/api/wallet/withdraw', { cookie: a.cookie, body: { amountCents: 100000, requestId: kept } });
    assert.equal(r2.status, 200, JSON.stringify(r2.data));
    assert.equal(r2.data.status, 'queued');
    assert.equal(p.rows('SELECT status FROM chain_withdrawals WHERE id = ?', kept)[0].status, 'queued');
    // The sweep never turns a given-back hold into 'blocked'.
    const back = randomUUID();
    p.DB.raw.prepare("INSERT INTO chain_withdrawals (id, kind, player_id, chain_id, to_address, amount_units, send_units, status, release_at, created_at) VALUES (?, 'player', ?, 1, ?, 50000, 50000, 'holding', '2000-01-01', '2000-01-01 00:00:00')").run(back, a.address, a.address);
    await internal(p, a.address, 'tics-hold', { ref: `th:${back}`, amountCents: 50000 });
    await internal(p, a.address, 'tics-release', { ref: `th:${back}` });
    const { settleHoldingRows } = await import('./wallet.js');
    await settleHoldingRows(p.env);
    assert.equal(p.rows('SELECT COUNT(*) AS n FROM chain_withdrawals WHERE id = ?', back)[0].n, 0);
    assert.equal(p.rows("SELECT COUNT(*) AS n FROM alerts WHERE type = 'tics_hold_mismatch'")[0].n, 0);
  } finally { p.restore(); }
});

test('r3 withdrawals: a repeated request for a claim still being set aside says pending', async () => {
  const p = platform();
  try {
    const a = await funded(p);
    const stub = p.env.CASINO.get(a.address); const orig = stub.fetch.bind(stub);
    stub.fetch = async (req) => { if (req.url.endsWith('/tics-hold')) { await orig(req); throw new Error('network'); } return orig(req); };
    const id = randomUUID();
    assert.equal((await p.call('/api/wallet/withdraw', { cookie: a.cookie, body: { amountCents: 200000, requestId: id } })).status, 500);
    const again = await p.call('/api/wallet/withdraw', { cookie: a.cookie, body: { amountCents: 200000, requestId: id } });
    assert.equal(again.status, 200);
    assert.equal(again.data.status, 'pending');
  } finally { p.restore(); }
});

test('r3 deposits: turning the quick path off never skips a big deposit the full lane had not reached', async () => {
  const p = platform();
  try {
    p.setTics({ casinoWallet: CASINO, realEnabled: true, startBlock: 995, confirmations: 12, quickConfirmations: 3, quickDepositMaxUnits: 1000 });
    const a = await p.login();
    const address = a.account.address.toLowerCase();
    await p.call('/api/session', { cookie: a.cookie, body: {} });
    p.chain.transfer({ from: address, wei: 500n * 10n ** 18n, block: 1000 }); // big: full lane only
    p.chain.block = 1005;
    await chainTick(p.env, { rpc: p.chain.rpc }); // quick lane passes block 1000, full lane does not
    assert.equal(await realOf(p, a.cookie), 0);
    p.setTics({ quickDepositMaxUnits: 0 }); // one lane from now on
    p.chain.block = 1030;
    await chainTick(p.env, { rpc: p.chain.rpc });
    assert.equal(await realOf(p, a.cookie), 50000, 'credited at the full depth');
  } finally { p.restore(); }
});

test('r3 deposits: top ups from house wallets are recorded as ignored, never credited', async () => {
  const p = platform();
  try {
    const treasury = '0x3ed7eaa1ca4b5c10336c6bf88f969f5bafd730d2';
    const a = await p.login();
    const address = a.account.address.toLowerCase();
    await p.call('/api/session', { cookie: a.cookie, body: {} });
    p.setTics({ casinoWallet: CASINO, realEnabled: true, startBlock: 990, quickDepositMaxUnits: 0, treasuryAddress: treasury, houseAddresses: [address] });
    p.chain.transfer({ from: treasury, wei: 1000n * 10n ** 18n, block: 990 });
    p.chain.transfer({ from: address, wei: 1000n * 10n ** 18n, block: 991 }); // a house wallet that also signed in
    await chainTick(p.env, { rpc: p.chain.rpc });
    assert.deepEqual(p.rows('SELECT status, player_id, credited_at FROM chain_deposits ORDER BY block_number').map((r) => [r.status, r.player_id, r.credited_at]),
      [['ignored', null, null], ['ignored', null, null]]);
    assert.equal(await realOf(p, a.cookie), 0);
    assert.equal(p.rows("SELECT COUNT(*) AS n FROM alerts WHERE type = 'tics_unmatched'")[0].n, 0);
  } finally { p.restore(); }
});

test('r3 deposits: a fast check only undoes the quick-lane bookings it made itself', async () => {
  const p = platform();
  try {
    p.setTics({ casinoWallet: CASINO, realEnabled: true, startBlock: 990, confirmations: 12, quickConfirmations: 3, quickDepositMaxUnits: 300000, quickDailyMaxUnits: 150000 });
    const a = await p.login();
    const address = a.account.address.toLowerCase();
    await p.call('/api/session', { cookie: a.cookie, body: {} });
    const tx = p.chain.transfer({ from: address, wei: 1000n * 10n ** 18n, block: 1000 }); // 100,000 units, fits
    const second = { ...p.chain.logs.at(-1), logIndex: '0x1' }; // another 100,000 in the same tx: over the cap
    p.chain.logs.push(second); p.chain.receipts.get(tx).logs.push(second);
    p.chain.block = 1004;
    // A parallel check already booked the first transfer.
    p.DB.raw.prepare('INSERT INTO quick_lane (deposit_id, from_address, units, at_ms) VALUES (?, ?, 100000, ?)').run(`1:${tx}:0`, address, Date.now());
    const r = await p.call('/api/wallet/deposit/check', { cookie: a.cookie, body: { txHash: tx } });
    assert.equal(r.data.status, 'confirming');
    assert.equal(p.rows('SELECT COUNT(*) AS n FROM quick_lane WHERE deposit_id = ?', `1:${tx}:0`)[0].n, 1, 'the other call\'s booking stays');
  } finally { p.restore(); }
});

test('r3 plain http is redirected to https; local development is not', async () => {
  const p = platform();
  try {
    p.env.ASSETS = { fetch: async () => new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } }) };
    const go = (url, headers = {}) => worker.fetch(new Request(url, { headers }), p.env, { waitUntil() {} });
    let r = await go('http://www.betics.io/how-it-works?x=1');
    assert.equal(r.status, 301); assert.equal(r.headers.get('Location'), 'https://www.betics.io/how-it-works?x=1');
    r = await go('http://betics.io/');
    assert.equal(r.status, 301); assert.equal(r.headers.get('Location'), 'https://www.betics.io/');
    r = await go('https://www.betics.io/api/health', { 'X-Forwarded-Proto': 'http' });
    assert.equal(r.status, 301); assert.equal(r.headers.get('Location'), 'https://www.betics.io/api/health');
    assert.equal((await go('https://www.betics.io/api/health')).status, 200);
    assert.equal((await go('http://127.0.0.1:8789/api/health')).status, 200);
    const { readFileSync } = await import('node:fs');
    const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
    assert.match(toml, /^workers_dev = false$/m);
    assert.match(toml, /^preview_urls = false$/m);
  } finally { p.restore(); }
});

test('alchemy budget: holdings are looked up only for wallets that deposited, and never more than the daily cap', async () => {
  const DB = createD1(MIGRATIONS);
  const env = { DB, ALCHEMY_API_KEY: 'k' };
  let calls = 0;
  const fetchImpl = async () => { calls++; return Response.json({ data: { tokens: [] } }); };
  const addr = (i) => `0x${i.toString(16).padStart(40, '0')}`;
  const player = (i) => { DB.raw.prepare("INSERT INTO players (id, wallet_address) VALUES (?, ?)").run(addr(i), addr(i)); return { id: addr(i), wallet_address: addr(i), holdings_updated_at: null }; };
  const deposit = (i) => DB.raw.prepare("INSERT INTO chain_deposits (id, chain_id, tx_hash, log_index, block_number, from_address, to_address, amount_wei, amount_units, status) VALUES (?, 1, ?, 0, 1, ?, '0xc', '1', 100, 'credited')").run(`d${i}`, `0x${i}`, addr(i));
  const now = Date.parse('2026-11-01T10:00:00Z');
  // A brand new wallet that never deposited costs nothing.
  const fresh = player(1);
  assert.deepEqual(await refreshHoldings(env, fresh, { fetchImpl, now }), { skipped: 'no deposit' });
  assert.equal(calls, 0);
  // After a credited deposit it is looked up.
  deposit(1);
  assert.equal((await refreshHoldings(env, fresh, { fetchImpl, now })).count, 0);
  assert.equal(calls, 1);
  // The whole site never goes over the daily cap, even with many depositors at once.
  const many = Array.from({ length: HOLDINGS_DAILY_CAP + 25 }, (_, k) => { const p = player(100 + k); deposit(100 + k); return p; });
  calls = 0;
  const results = await Promise.all(many.map((p) => refreshHoldings(env, p, { fetchImpl, now })));
  assert.equal(calls, HOLDINGS_DAILY_CAP - 1, 'one lookup was already used today');
  assert.equal(results.filter((r) => r?.skipped === 'daily cap').length, 26);
  // The next day the budget starts again.
  calls = 0;
  await refreshHoldings(env, many[0], { fetchImpl, now: now + 86400000, force: true });
  assert.equal(calls, 1);
});
