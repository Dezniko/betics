import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes } from 'node:crypto';
import { deriveOutcome } from '../backend/src/core/fairness.js';
import { validateBet, payoutCentsFor } from '../backend/src/games/roulette.js';
import { makeLayout } from '../frontend/src/boardLayout.js';
import worker, { DemoCasino } from './index.js';

// Real in-memory SQLite adapter, not the original local database. The fetch
// integration suite separately exercises workerd's actual Durable Object API.
function harness(env = {}) {
  const db = new DatabaseSync(':memory:');
  const state = { failOn: null };
  const ctx = { storage: {
    sql: { exec(query, ...args) {
      if (state.failOn && query.includes(state.failOn)) throw new Error('injected storage failure');
      if (query.includes('CREATE TABLE')) { db.exec(query); return { toArray: () => [] }; }
      const rows = db.prepare(query).all(...args);
      return { toArray: () => rows };
    } },
    transactionSync(fn) {
      db.exec('BEGIN');
      try { const result = fn(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  } };
  const casino = new DemoCasino(ctx, env);
  casino.init({ username: '<script>unsafe\n</script>' + 'x'.repeat(80) });
  return { db, casino, state, ctx };
}
const request = () => new Request('https://casino.example/api/games/roulette/spin', { method: 'POST' });
const bets = Array.from({ length: 37 }, (_, value) => ({ type: 'straight', value, amountCents: 1 }));
const commitment = (casino) => { const c = casino.commitment(); return { serverSeedHash: c.server_seed_hash, clientSeed: c.client_seed, nonce: c.nonce }; };
const spinBody = (casino, extra = {}) => ({ bets, requestId: randomUUID(), expectedCommitment: commitment(casino), clientEntropy: randomBytes(32).toString('hex'), ...extra });
const snapshot = (db) => ['users', 'ledger', 'rounds', 'fairness_commitments', 'idempotency', 'entropy_used'].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());

test('temporary demo reset sets exactly $10,000, preserves fairness, is atomic and staging-only',()=>{
 const {db,casino,state}=harness({STAGING:'true'}),before=commitment(casino);
 assert.equal(casino.resetDemoBalance({}).balanceCents,10_000_000);
 assert.equal(db.prepare('SELECT SUM(amount_cents) AS total FROM ledger').get().total,10_000_000);
 assert.deepEqual(commitment(casino),before);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rounds').get().n,0);
 const count=db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n;
 casino.resetDemoBalance({});assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n,count);
 db.prepare('UPDATE users SET balance_cents=0 WHERE id=1').run();state.failOn='INSERT INTO ledger';
 assert.throws(()=>casino.resetDemoBalance({}));assert.equal(casino.wallet().balanceCents,0);db.close();
 const other=harness();assert.throws(()=>other.casino.resetDemoBalance({}),{status:404});assert.equal(other.casino.wallet().balanceCents,10_000_000);other.db.close();
});

test('spin requires a body UUID even when an idempotency header is supplied', () => {
  const { db, casino } = harness();
  const before = snapshot(db);
  for (const requestId of [undefined, null, 42, '', 'not-a-uuid']) {
    const req = new Request(request().url, { method: 'POST', headers: { 'Idempotency-Key': randomUUID() } });
    assert.throws(() => casino.spin(req, spinBody(casino, { requestId })), { status: 400 });
    assert.deepEqual(snapshot(db), before);
  }
  db.close();
});

test('spin binds the exact observed hash, base seed and nonce without mutation on rejection', () => {
  const { db, casino } = harness();
  const before = snapshot(db);
  const current = commitment(casino);
  const malformed = [undefined, null, [], {}, { ...current, serverSeedHash: undefined }, { ...current, clientSeed: undefined }, { ...current, nonce: undefined }, { ...current, serverSeedHash: 'BAD' }, { ...current, clientSeed: 'x'.repeat(65) }, { ...current, nonce: '0' }, { ...current, nonce: -1 }];
  for (const expectedCommitment of malformed) {
    assert.throws(() => casino.spin(request(), spinBody(casino, { expectedCommitment })), { status: 400 });
    assert.deepEqual(snapshot(db), before);
  }
  for (const expectedCommitment of [{ ...current, serverSeedHash: '0'.repeat(64) }, { ...current, clientSeed: 'substituted' }, { ...current, nonce: 1 }]) {
    assert.throws(() => casino.spin(request(), spinBody(casino, { expectedCommitment })), { status: 409 });
    assert.deepEqual(snapshot(db), before);
  }
  const old = spinBody(casino);
  casino.spin(request(), spinBody(casino));
  const after = snapshot(db);
  assert.throws(() => casino.spin(request(), old), { status: 409 });
  assert.deepEqual(snapshot(db), after);
  db.close();
});

test('fresh 256-bit entropy is mandatory, mixed into the saved base, and cannot be reused', () => {
  const { db, casino } = harness();
  const before = snapshot(db);
  for (const clientEntropy of [undefined, null, 7, 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)]) {
    assert.throws(() => casino.spin(request(), spinBody(casino, { clientEntropy })), { status: 400 });
    assert.deepEqual(snapshot(db), before);
  }
  const body = spinBody(casino, { clientSeed: 'attacker-controlled-raw-value' });
  const result = casino.spin(request(), body);
  const effective = `${body.expectedCommitment.clientSeed}:${body.clientEntropy}`;
  assert.equal(result.fairness.clientSeed, effective);
  assert.equal(result.fairness.clientSeedBase, body.expectedCommitment.clientSeed);
  assert.equal(result.fairness.clientEntropy, body.clientEntropy);
  assert.equal(result.pocket, deriveOutcome(result.fairness.serverSeed, effective, body.expectedCommitment.nonce, 37));
  assert.equal(result.fairness.nextCommitment.clientSeed, body.expectedCommitment.clientSeed);
  assert.equal(db.prepare('SELECT client_seed FROM rounds').get().client_seed, effective);
  const after = snapshot(db);
  assert.throws(() => casino.spin(request(), spinBody(casino, { clientEntropy: body.clientEntropy })), { status: 409 });
  assert.deepEqual(snapshot(db), after);
  db.close();
});

test('idempotency replays before stale checks but binds every supplied input', () => {
  const { db, casino } = harness();
  const body = spinBody(casino);
  const result = casino.spin(request(), body);
  const after = snapshot(db);
  assert.deepEqual(casino.spin(request(), body), result);
  const req = new Request(request().url, { method: 'POST', headers: { 'Idempotency-Key': body.requestId } });
  assert.deepEqual(casino.spin(req, { ...body, expectedCommitment: { nonce: body.expectedCommitment.nonce, clientSeed: body.expectedCommitment.clientSeed, serverSeedHash: body.expectedCommitment.serverSeedHash } }), result);
  const changed = [
    { bets: [{ type: 'black', amountCents: 1 }] },
    { expectedCommitment: { ...body.expectedCommitment, serverSeedHash: '0'.repeat(64) } },
    { expectedCommitment: { ...body.expectedCommitment, clientSeed: 'other' } },
    { expectedCommitment: { ...body.expectedCommitment, nonce: 1 } },
    { expectedCommitment: { ...body.expectedCommitment, extra: 'not-the-original' } },
    { clientEntropy: randomBytes(32).toString('hex') },
    { clientSeed: 'ignored-for-rng-but-not-for-retries' },
    { clientEntropy: undefined }, { expectedCommitment: undefined }, { bets: [] },
  ];
  for (const change of changed) {
    assert.throws(() => casino.spin(request(), { ...body, ...change }), { status: 409 });
    assert.deepEqual(snapshot(db), after);
  }
  assert.throws(() => casino.spin(new Request(request().url, { method: 'POST', headers: { 'Idempotency-Key': randomUUID() } }), body), { status: 400 });
  db.close();
});

test('seed changes require the observed tuple and reject both spin/seed race orders', () => {
  const { db, casino } = harness();
  const before = snapshot(db);
  assert.throws(() => casino.setSeed({ clientSeed: 'new' }), { status: 400 });
  assert.deepEqual(snapshot(db), before);
  const old = spinBody(casino);
  const update = { clientSeed: '  ' + 'x'.repeat(64) + '  ', expectedCommitment: old.expectedCommitment };
  const updated = casino.setSeed(update);
  assert.equal(updated.clientSeed, 'x'.repeat(64));
  assert.equal(updated.serverSeedHash, old.expectedCommitment.serverSeedHash);
  const afterSeed = snapshot(db);
  assert.throws(() => casino.spin(request(), old), { status: 409 });
  assert.throws(() => casino.setSeed({ ...update, clientSeed: 'other-tab' }), { status: 409 });
  assert.deepEqual(snapshot(db), afterSeed);
  const pendingUpdate = { clientSeed: 'future-seed', expectedCommitment: updated };
  casino.spin(request(), spinBody(casino));
  const afterSpin = snapshot(db);
  assert.throws(() => casino.setSeed(pendingUpdate), { status: 409 });
  assert.deepEqual(snapshot(db), afterSpin);
  db.close();
});

test('spin returns its requestId and exposes persisted protocol inputs in historical receipts', async () => {
  const { db, casino, ctx } = harness();
  const body = spinBody(casino);
  const result = casino.spin(request(), body);
  assert.equal(result.requestId, body.requestId);
  assert.deepEqual(casino.spin(request(), body), result);
  const restarted = new DemoCasino(ctx, {});
  const response = await restarted.fetch(new Request('https://casino.example/api/rounds'));
  const [row] = await response.json();
  assert.equal(row.request_id, body.requestId);
  assert.equal(row.client_seed_base, body.expectedCommitment.clientSeed);
  assert.equal(row.client_entropy, body.clientEntropy);
  assert.equal(row.client_seed, result.fairness.clientSeed);
  const receipt = JSON.parse(row.receipt_json);
  assert.equal(receipt.requestId, body.requestId);
  assert.deepEqual(receipt.expectedCommitment, body.expectedCommitment);
  assert.equal(receipt.clientEntropy, body.clientEntropy);
  // Recreate the pre-upgrade schema with populated rows, then run migration.
  db.exec('ALTER TABLE rounds DROP COLUMN receipt_json');
  const oldRows = db.prepare('SELECT * FROM rounds').all();
  const migrated = new DemoCasino(ctx, {});
  const migratedRows = await (await migrated.fetch(new Request('https://casino.example/api/rounds'))).json();
  assert.equal(migratedRows[0].receipt_json, null);
  assert.equal(migratedRows[0].request_id, null);
  // Every stored column survives, except the internal account number, which is never sent to the browser.
  assert.equal('user_id' in migratedRows[0], false);
  for (const [key, value] of Object.entries(oldRows[0])) if (key !== 'user_id') assert.deepEqual(migratedRows[0][key], value);
  assert.deepEqual(migrated.spin(request(), body), result, 'previous idempotent responses survive restarts/migrations');
  db.close();
});

test('inside bets require physical table adjacency while every existing board zone keeps its payout', () => {
  for (const vertical of [false, true]) for (const zone of makeLayout(vertical).zones) {
    const bet = { type: zone.type, value: zone.value, amountCents: 100 };
    assert.doesNotThrow(() => validateBet(bet), JSON.stringify(bet));
    if (Array.isArray(zone.value)) assert.equal(payoutCentsFor(bet, zone.value[0]), 3600 / zone.value.length);
  }
  for (const [type, value] of [
    ['split', [0, 1]], ['split', [0, 2]], ['split', [0, 3]], ['split', [36, 33]],
    ['trio', [0, 1, 2]], ['trio', [3, 0, 2]], ['street', [36, 34, 35]],
    ['corner', [36, 35, 33, 32]], ['sixline', [31, 32, 33, 34, 35, 36]],
  ]) assert.doesNotThrow(() => validateBet({ type, value, amountCents: 100 }));
  for (const [type, value] of [
    ['split', [1, 36]], ['split', [3, 4]], ['split', [0, 4]], ['split', [1, 3]],
    ['street', [2, 3, 4]], ['street', [0, 1, 2]], ['trio', [0, 1, 3]], ['trio', [1, 2, 3]],
    ['corner', [0, 1, 2, 3]], ['corner', [2, 3, 4, 5]], ['corner', [1, 2, 7, 8]],
    ['sixline', [2, 3, 4, 5, 6, 7]], ['sixline', [1, 2, 3, 7, 8, 9]],
  ]) assert.throws(() => validateBet({ type, value, amountCents: 100 }), /adjacen|physical/, JSON.stringify({ type, value }));
});

test('fake credit and every round are reconstructable from append-only ledger', () => {
  const { db, casino } = harness();
  // No player name or shared id is ever returned: the player is the cookie or wallet session.
  assert.equal('username' in casino.wallet(), false);
  assert.equal('userId' in casino.wallet(), false);
  for (let i = 0; i < 10; i++) casino.spin(request(), spinBody(casino));
  assert.equal(casino.wallet().balanceCents, 9999990);
  const rows = db.prepare('SELECT * FROM ledger ORDER BY id').all();
  assert.equal(rows.length, 21);
  assert.equal(rows[0].type, 'demo_credit');
  let balance = 0;
  for (const row of rows) {
    balance += row.amount_cents;
    assert.equal(balance, row.balance_after_cents);
    assert.ok(balance >= 0);
  }
  assert.equal(balance, casino.wallet().balanceCents);
  db.close();
});

test('storage failure after settlement rolls back balance, round, ledger and seed', () => {
  const { db, casino, state } = harness();
  const before = snapshot(db);
  const body = spinBody(casino);
  state.failOn = 'UPDATE fairness_commitments SET server_seed';
  assert.throws(() => casino.spin(request(), body), /injected storage failure/);
  assert.deepEqual(snapshot(db), before);
  state.failOn = null;
  const result = casino.spin(request(), body);
  assert.equal(result.balanceAfterCents, 9999999);
  assert.equal(result.fairness.serverSeedHash, before[3][0].server_seed_hash);
  assert.notEqual(result.fairness.nextCommitment.serverSeedHash, before[3][0].server_seed_hash);
  db.close();
});

test('idempotency persistence failure rolls back already rotated commitment too', () => {
  const { db, casino, state } = harness();
  const before = snapshot(db);
  state.failOn = 'INSERT INTO idempotency';
  assert.throws(() => casino.spin(request(), spinBody(casino)), /injected storage failure/);
  assert.deepEqual(snapshot(db), before);
  db.close();
});

test('insufficient funds and invalid seeds leave all storage unchanged', () => {
  const { db, casino } = harness();
  const before = snapshot(db);
  assert.throws(() => casino.spin(request(), spinBody(casino, { bets: [{ type: 'red', amountCents: 10000001 }] })), /insufficient balance/);
  assert.throws(() => casino.setSeed({ clientSeed: 'x'.repeat(65) }), /clientSeed/);
  assert.deepEqual(snapshot(db), before);
  db.close();
});

test('HTTP edge rejects chunked oversized body before invoking Durable Object', async () => {
  let forwarded = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(32769)); controller.close(); } });
  const response = await worker.fetch(new Request('https://casino.example/api/session', { method: 'POST', body: stream, duplex: 'half' }), {
    CASINO: { idFromName() { forwarded = true; throw new Error('unexpected DO invocation'); } },
  });
  assert.equal(response.status, 413);
  assert.equal(forwarded, false);
});

test('player pages are indexable and carry their own head tags; unknown paths are 404', async () => {
  const indexHtml = '<html><head><title>old</title></head><body></body></html>';
  const ASSETS = { async fetch(req) {
    assert.equal(req.headers.get('if-none-match'), null, 'page requests reach the asset store without conditional headers');
    return new Response(req.method === 'HEAD' ? null : indexHtml, { status: 200, headers: { 'Content-Type': 'text/html', ETag: 'assets-etag' } });
  } };
  for (const [path, canonical] of [['/', '/'], ['/terms', '/terms'], ['/how-it-works/', '/how-it-works']]) {
    const response = await worker.fetch(new Request(`https://www.betics.io${path}`, { headers: { 'If-None-Match': 'assets-etag' } }), { ASSETS });
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('x-robots-tag'), null, path);
    assert.equal(response.headers.get('etag'), null, 'the rewritten page has no stale ETag');
    const html = await response.text();
    assert.equal((html.match(/<title>/g) || []).length, 1);
    assert.match(html, new RegExp(`<link rel="canonical" href="https://www\\.betics\\.io${canonical.replace(/\//g, '\\/')}" />`));
    assert.match(html, /<meta name="description" content="[^"]*Qubetics[^"]*" \/>/);
    assert.doesNotMatch(html, /noindex|18\+|[\u2013\u2014]/);
  }
  const home = await (await worker.fetch(new Request('https://www.betics.io/'), { ASSETS })).text();
  assert.match(home, /<title>Qubetics Casino · Roulette and Slots with \$TICS \| qu-BETICS<\/title>/);
  const roulette = await (await worker.fetch(new Request('https://www.betics.io/roulette'), { ASSETS })).text();
  assert.match(roulette, /<title>Qubetics Roulette · Play with \$TICS \| qu-BETICS<\/title>/);
  for (const path of ['/blackjack', '/sitemap.xm', '/voice/missing.mp3', '/terms/extra']) {
    const response = await worker.fetch(new Request(`https://www.betics.io${path}`), { ASSETS });
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive', path);
    assert.match(await response.text(), /Page not found/);
  }
  const head = await worker.fetch(new Request('https://www.betics.io/terms', { method: 'HEAD' }), { ASSETS });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('non-page asset responses pass through without losing response fields', async () => {
  const response = await worker.fetch(new Request('https://casino.example/robots.txt'), {
    ASSETS: { async fetch() { return new Response('robots', { status: 200, headers: { 'Content-Type': 'text/plain', ETag: 'assets-etag' } }); } },
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'robots');
  assert.equal(response.headers.get('etag'), 'assets-etag');
  assert.equal(response.headers.get('x-robots-tag'), null);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});
