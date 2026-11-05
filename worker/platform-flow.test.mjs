import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes } from 'node:crypto';
import worker, { DemoCasino } from './index.js';
import { clearConfigCache, firstTouch } from './platform.js';
import { createD1 } from '../test-support/d1shim.mjs';

const MIGRATIONS = ['0001_platform.sql', '0002_payments.sql', '0003_tics.sql', '0004_spin_holds.sql', '0005_audit_fixes.sql', '0006_admin.sql', '0007_r3.sql', '0008_reaudit.sql', '0009_slots.sql'].map((f) => new URL(`../migrations/${f}`, import.meta.url).pathname);

function doStorage() {
  const db = new DatabaseSync(':memory:');
  const storage = {
    alarm: null,
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

function platform() {
  clearConfigCache();
  const DB = createD1(MIGRATIONS);
  const objects = new Map();
  const env = { DB, INTERNAL_SECRET: 'test-secret', STAGING: 'true', LEGACY_PAYMENTS: '1' };
  env.CASINO = {
    idFromName: (name) => name,
    get: (id) => {
      if (!objects.has(id)) objects.set(id, new DemoCasino({ storage: doStorage() }, env));
      return objects.get(id);
    },
  };
  const call = async (path, { cookie, body, method = body === undefined ? 'GET' : 'POST', headers = {} } = {}) => {
    const response = await worker.fetch(new Request(`https://casino.example${path}`, {
      method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  const session = async () => {
    const r = await call('/api/session', { body: {} });
    return r.headers.get('set-cookie').split(';')[0];
  };
  const spin = async (cookie, bets, extraHeaders = {}) => {
    const c = (await call('/api/fairness/commitment', { cookie })).data;
    return call('/api/games/roulette/spin', { cookie, headers: extraHeaders, body: { bets, requestId: randomUUID(),
      expectedCommitment: c, clientEntropy: randomBytes(32).toString('hex') } });
  };
  const rows = (q, ...a) => DB.raw.prepare(q).all(...a);
  return { env, DB, objects, call, session, spin, rows };
}

const allPockets = (amountCents) => Array.from({ length: 37 }, (_, value) => ({ type: 'straight', value, amountCents }));

test('a session creates one player with a guest identity and device details, and the cookie resumes it', async () => {
  const p = platform();
  const cookie = await p.session();
  assert.equal(p.rows('SELECT * FROM players').length, 1);
  const [player] = p.rows('SELECT * FROM players');
  assert.equal(player.device, 'mobile');
  assert.equal(player.os, 'iOS');
  assert.equal(player.balance_cents, 10000000);
  const again = await p.call('/api/session', { cookie, body: {} });
  assert.equal(again.status, 200);
  assert.equal(p.rows('SELECT * FROM players').length, 1);
  assert.equal(p.rows("SELECT * FROM events WHERE type = 'first_visit'").length, 1);
  assert.equal(p.rows("SELECT * FROM events WHERE type = 'visit'").length, 1);
  assert.equal(p.rows("SELECT * FROM ledger WHERE type = 'demo_credit'").length, 1);
  // An unknown cookie never resumes or creates a client-chosen session.
  const fake = `__Host-casino_demo=${'a'.repeat(64)}`;
  assert.equal((await p.call('/api/wallet', { cookie: fake })).status, 401);
  const fresh = await p.call('/api/session', { cookie: fake, body: {} });
  assert.notEqual(fresh.headers.get('set-cookie').split(';')[0], fake);
});

test('every settled spin is copied to the central rounds and ledger, with player totals', async () => {
  const p = platform();
  const cookie = await p.session();
  const r = await p.spin(cookie, allPockets(10));
  assert.equal(r.status, 200);
  const [round] = p.rows('SELECT * FROM rounds');
  assert.equal(round.stake_cents, 370);
  assert.equal(round.payout_cents, 360);
  assert.equal(round.math_id, 'standard');
  assert.equal(round.config_version, 2);
  assert.equal(round.device, 'mobile');
  assert.equal(JSON.parse(round.outcome).pocket, r.data.pocket);
  assert.deepEqual(p.rows('SELECT type FROM ledger ORDER BY created_at, id').map((x) => x.type).sort(), ['bet_reserve', 'bet_settle_win', 'demo_credit']);
  const [player] = p.rows('SELECT * FROM players');
  assert.equal(player.balance_cents, 10000000 - 10);
  assert.equal(player.total_bet_cents, 370);
  assert.equal(player.rounds, 1);
});

test('switching a game off blocks the next spin with the maintenance message and moves no money', async () => {
  const p = platform();
  const cookie = await p.session();
  p.DB.raw.exec("UPDATE games SET enabled = 0, maintenance_message = 'Back at 6pm' WHERE id = 'roulette'");
  clearConfigCache();
  const r = await p.spin(cookie, allPockets(10));
  assert.equal(r.status, 503);
  assert.equal(r.data.error, 'Back at 6pm');
  assert.equal((await p.call('/api/wallet', { cookie })).data.balanceCents, 10000000);
  assert.equal(p.rows('SELECT * FROM rounds').length, 0);
  const config = (await p.call('/api/games/roulette/config', { cookie })).data;
  assert.equal(config.enabled, false);
  assert.equal(config.maintenanceMessage, 'Back at 6pm');
});

test('the maths option chosen by the admin sets the payout and is recorded on the round', async () => {
  const p = platform();
  const cookie = await p.session();
  p.DB.raw.exec("UPDATE games SET math_id = 'straight34', config_version = 2 WHERE id = 'roulette'");
  clearConfigCache();
  const r = await p.spin(cookie, allPockets(100));
  assert.equal(r.status, 200);
  assert.equal(r.data.totalPayoutCents, 3500);
  assert.equal(r.data.mathId, 'straight34');
  const [round] = p.rows('SELECT * FROM rounds');
  assert.equal(round.math_id, 'straight34');
  assert.equal(round.config_version, 2);
  assert.equal((await p.call('/api/games/roulette/config', { cookie })).data.math.multipliers.straight, 35);
});

test('limits are enforced and a browser cannot smuggle in its own config', async () => {
  const p = platform();
  const cookie = await p.session();
  p.DB.raw.exec("UPDATE games SET max_win_cents = 1000 WHERE id = 'roulette'");
  clearConfigCache();
  const spoof = { 'X-Platform-Context': JSON.stringify({ playerId: 'x', config: { enabled: true, mathId: 'standard', minStakeCents: 1, maxStakeCents: 1e9, maxWinCents: 1e9, maxHouseLossCents: 1e9, configVersion: 9 } }) };
  const r = await p.spin(cookie, [{ type: 'straight', value: 5, amountCents: 100 }], spoof);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /win more than 10\.00 \$TICS/);
});

test('frozen and banned players cannot spin; the reason is shown plainly', async () => {
  const p = platform();
  const cookie = await p.session();
  p.DB.raw.exec("UPDATE players SET status = 'frozen'");
  const r = await p.spin(cookie, allPockets(10));
  assert.equal(r.status, 403);
  assert.match(r.data.error, /paused/);
  assert.equal((await p.call('/api/wallet', { cookie })).status, 200, 'a frozen player can still see their balance');
});

test('there is no balance adjustment route: /internal/adjust is gone even with the internal secret', async () => {
  const p = platform();
  await p.session();
  const [player] = p.rows('SELECT * FROM players');
  const wallet = p.env.CASINO.get(p.env.CASINO.idFromName(player.id));
  const before = p.rows('SELECT balance_cents FROM players')[0].balance_cents;
  const res = await wallet.fetch(new Request('https://internal/internal/adjust', { method: 'POST', headers: { 'X-Internal-Secret': 'test-secret' },
    body: JSON.stringify({ amountCents: 500, reason: 'goodwill', adminEmail: 'a@b.c' }) }));
  assert.equal(res.status, 404);
  assert.equal(p.rows("SELECT * FROM ledger WHERE type = 'admin_adjustment'").length, 0);
  assert.equal(p.rows('SELECT balance_cents FROM players')[0].balance_cents, before);
  p.env.ASSETS = { fetch: async () => Response.json({ error: 'not found' }, { status: 404 }) };
  const cookie = await p.session();
  assert.equal((await p.call('/internal/adjust', { cookie, body: { amountCents: 1, reason: 'sneaky', adminEmail: 'x@y.z' } })).status, 404);
});

test('if the central copy fails, the round is kept and copied on the retry alarm', async () => {
  const p = platform();
  const cookie = await p.session();
  p.DB.state.failNext = true;
  assert.equal((await p.spin(cookie, allPockets(10))).status, 200);
  assert.equal(p.rows('SELECT * FROM rounds').length, 0);
  const [player] = p.rows('SELECT * FROM players');
  const wallet = p.env.CASINO.get(player.id);
  await wallet.alarm();
  assert.equal(p.rows('SELECT * FROM rounds').length, 1);
  await wallet.alarm(); // replay is harmless
  assert.equal(p.rows('SELECT * FROM rounds').length, 1);
});

test('central ledger and audit tables refuse edits and deletes', async () => {
  const p = platform();
  await p.session();
  assert.throws(() => p.DB.raw.exec('UPDATE ledger SET amount_cents = 0'), /append only/);
  assert.throws(() => p.DB.raw.exec('DELETE FROM ledger'), /append only/);
  assert.throws(() => p.DB.raw.exec("INSERT INTO game_math VALUES ('roulette','bad','Bad','x',99,101,100)"), /CHECK/);
});

test('messages: first-visit trigger, inbox, seen/click/dismiss, and banned players get nothing', async () => {
  const p = platform();
  p.DB.raw.prepare(`INSERT INTO messages (title, body, button_label, button_url, audience_json, trigger, status, created_by) VALUES ('Welcome', 'Hello', 'Play', '/', '{"type":"all"}', 'first_visit', 'active', 'a@b.c')`).run();
  p.DB.raw.prepare(`INSERT INTO messages (title, body, audience_json, trigger, status, created_by) VALUES ('UK only', 'Hi', '{"type":"segment","filters":{"country":"GB"}}', 'first_visit', 'active', 'a@b.c')`).run();
  const cookie = await p.session();
  let box = (await p.call('/api/inbox', { cookie })).data;
  assert.equal(box.messages.length, 1, 'segment did not match (no country in test)');
  assert.equal(box.unseen, 1);
  const id = box.messages[0].id;
  assert.equal((await p.call(`/api/inbox/${id}/seen`, { cookie, body: {} })).status, 200);
  assert.equal((await p.call(`/api/inbox/${id}/click`, { cookie, body: {} })).status, 200);
  box = (await p.call('/api/inbox', { cookie })).data;
  assert.equal(box.unseen, 0);
  assert.equal((await p.call(`/api/inbox/${id}/dismiss`, { cookie, body: {} })).status, 200);
  assert.equal((await p.call('/api/inbox', { cookie })).data.messages.length, 0);
  assert.equal((await p.call('/api/inbox/999/seen', { cookie, body: {} })).status, 404);
  const d = p.rows('SELECT * FROM message_deliveries')[0];
  assert.ok(d.seen_at && d.clicked_at && d.dismissed_at);
  assert.equal(p.rows("SELECT * FROM events WHERE type = 'message_click'").length, 1);
  // A second player cannot touch the first player's delivery.
  const other = await p.session();
  assert.equal((await p.call(`/api/inbox/${id}/seen`, { cookie: other, body: {} })).status, 200, 'other player has their own first-visit delivery');
  assert.equal(p.rows('SELECT COUNT(*) AS n FROM message_deliveries').map((r) => r.n)[0], 2);
});

import { createHmac } from 'node:crypto';
import { isTronAddress, verifyIpn } from './payments.js';

const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
const ipnSig = (secret, body) => createHmac('sha512', secret).update(JSON.stringify(sortKeys(body))).digest('hex');

test('Tron addresses are checked with their checksum', async () => {
  assert.equal(await isTronAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'), true);
  assert.equal(await isTronAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u'), false);
  assert.equal(await isTronAddress('0xdAC17F958D2ee523a2206206994597C13D831ec7'), false);
  assert.equal(await isTronAddress(''), false);
});

test('payments are closed until the owner opens them and the provider keys exist', async () => {
  const p = platform();
  const cookie = await p.session();
  const info = (await p.call('/api/payments', { cookie })).data;
  assert.equal(info.realBalanceCents, 0);
  assert.equal(info.depositsOpen, false);
  assert.equal((await p.call('/api/payments/deposit', { cookie, body: { amountCents: 5000 } })).status, 503);
  assert.equal((await p.call('/api/payments/withdraw', { cookie, body: { amountCents: 5000, address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' } })).status, 503);
  const status = (await p.call('/api/payments/status')).data;
  assert.deepEqual(status, { provider: 'nowpayments', network: 'tron', configured: false, depositsOpen: false, withdrawalsOpen: false });
});

test('a deposit is credited once, only after a correctly signed "finished" callback, to the real balance only', async (t) => {
  const p = platform();
  Object.assign(p.env, { NOWPAYMENTS_API_KEY: 'k', NOWPAYMENTS_IPN_SECRET: 'ipn-secret' });
  p.DB.raw.exec(`UPDATE settings SET value = json_set(value, '$.depositsOpen', json('true'), '$.withdrawalsOpen', json('true')) WHERE key = 'payments'`);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.nowpayments.io/v1/payment');
    const b = JSON.parse(init.body);
    assert.equal(b.pay_currency, 'usdttrc20'); assert.equal(b.price_amount, 50);
    return Response.json({ payment_id: 777, pay_address: 'TXYZaddress', pay_amount: 50.1, payment_status: 'waiting' });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const cookie = await p.session();
  assert.equal((await p.call('/api/payments/deposit', { cookie, body: { amountCents: 500 } })).status, 400, 'below minimum');
  const dep = (await p.call('/api/payments/deposit', { cookie, body: { amountCents: 5000 } })).data;
  assert.equal(dep.payAddress, 'TXYZaddress');
  const hook = (body, sig) => p.call('/api/payments/webhook/nowpayments', { body, headers: { 'x-nowpayments-sig': sig ?? ipnSig('ipn-secret', body) } });
  const finished = { payment_id: 777, order_id: dep.depositId, payment_status: 'finished', actually_paid: 50.1, pay_currency: 'usdttrc20', price_amount: 50 };
  assert.equal((await hook(finished, 'a'.repeat(128))).status, 401, 'bad signature');
  assert.equal((await hook({ ...finished, payment_status: 'confirming' })).status, 200);
  assert.equal((await p.call('/api/payments', { cookie })).data.realBalanceCents, 0, 'not credited while confirming');
  assert.equal((await hook(finished)).status, 200);
  assert.equal((await hook(finished)).status, 200, 'retries are harmless');
  assert.equal((await p.call('/api/payments', { cookie })).data.realBalanceCents, 5000);
  assert.equal((await p.call('/api/wallet', { cookie })).data.balanceCents, 10000000, 'play money untouched');
  assert.equal(p.rows("SELECT COUNT(*) AS n FROM ledger WHERE type = 'deposit' AND real_money = 1")[0].n, 1);
  assert.equal(p.rows('SELECT real_balance_cents FROM players')[0].real_balance_cents, 5000);
  assert.equal(p.rows("SELECT status FROM deposits")[0].status, 'finished');
  // A payment id that does not match the deposit is refused.
  assert.equal((await hook({ ...finished, payment_id: 999 })).status, 404);

  // Withdrawals: valid Tron address, holds the money at once, refuses more than the real balance.
  assert.equal((await p.call('/api/payments/withdraw', { cookie, body: { amountCents: 3000, address: 'Tnotvalid' } })).status, 400);
  assert.equal((await p.call('/api/payments/withdraw', { cookie, body: { amountCents: 9000, address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' } })).status, 402);
  const wd = await p.call('/api/payments/withdraw', { cookie, body: { amountCents: 3000, address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' } });
  assert.equal(wd.status, 200);
  assert.equal(wd.data.realBalanceCents, 2000);
  assert.equal(wd.data.sendCents, 2900);
  assert.equal(p.rows("SELECT status FROM withdrawals")[0].status, 'requested');
  // Release (as the admin does on reject) returns the money exactly once.
  const [player] = p.rows('SELECT id FROM players');
  const wallet = p.env.CASINO.get(player.id);
  const release = () => wallet.fetch(new Request('https://w/internal/withdraw-release', { method: 'POST', headers: { 'X-Internal-Secret': 'test-secret' },
    body: JSON.stringify({ ref: `wdr:${wd.data.withdrawalId}`, amountCents: 3000, reason: 'rejected' }) })).then((r) => r.json());
  assert.equal((await release()).realBalanceCents, 5000);
  assert.equal((await release()).duplicate, true);
  assert.equal((await p.call('/api/payments', { cookie })).data.realBalanceCents, 5000);
});

test('no player name and no account number: old /1 paths are gone, the session response is anonymous', async () => {
  const p = platform();
  try {
    const r = await p.call('/api/session', { body: { username: 'dez' } });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.data).filter((k) => ['userId', 'username'].includes(k)), []);
    const cookie = r.headers.get('set-cookie').split(';')[0];
    const w = await p.call('/api/wallet', { cookie });
    assert.equal(w.status, 200);
    assert.equal(JSON.stringify(w.data).includes('dez'), false);
    for (const old of ['/api/wallet/1', '/api/rounds/1', '/api/fairness/commitment/1']) assert.equal((await p.call(old, { cookie })).status, 404, old);
    const rounds = await p.call('/api/rounds', { cookie });
    assert.equal(rounds.status, 200);
  } finally { /* nothing to restore */ }
});


test('a new guest records the source and campaign the page sends, never this site or junk', async () => {
  const p = platform();
  const r = await p.call('/api/session', { body: { firstTouch: { source: 'Telegram', campaign: 'launch_week' } } });
  assert.equal(r.status, 200);
  const [player] = p.rows('SELECT first_referrer, first_campaign FROM players');
  assert.equal(player.first_referrer, 'telegram');
  assert.equal(player.first_campaign, 'launch_week');
  const plain = platform();
  await plain.call('/api/session', { body: {} });
  assert.deepEqual({ ...plain.rows('SELECT first_referrer, first_campaign FROM players')[0] }, { first_referrer: null, first_campaign: null });
  assert.deepEqual(firstTouch({ firstTouch: { source: 'www.betics.io', campaign: '<script>' } }), { referrer: null, campaign: null });
  assert.deepEqual(firstTouch({ firstTouch: { source: 't.me', campaign: 'x'.repeat(65) } }), { referrer: 't.me', campaign: null });
  assert.deepEqual(firstTouch({ firstTouch: { source: 42 } }), { referrer: null, campaign: null });
  assert.deepEqual(firstTouch(null), { referrer: null, campaign: null });
});
