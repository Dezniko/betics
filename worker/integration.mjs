import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID, randomBytes } from 'node:crypto';

const base = process.argv[2] || 'http://127.0.0.1:8791';
const origin = new URL(base).origin;
async function call(path, options = {}) {
  // The game limits spins per player (a burst of 10, then 5 a second); a refused spin changed nothing, so wait and resend.
  for (let attempt = 0; ; attempt++) {
    const r = await callOnce(path, options);
    if (r.status !== 429 || !/Slow down/.test(r.data?.error || '') || attempt >= 30) return r;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
async function callOnce(path, { cookie, body, method = body === undefined ? 'GET' : 'POST', headers = {} } = {}) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  return { status: response.status, data, headers: response.headers };
}

const health = await call('/api/health');
assert.equal(health.status, 200);
assert.equal(health.data.mode, 'demo');
assert.equal(health.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
console.log('PASS public demo health');

if (process.env.SMOKE_ONLY) process.exit(0);

const unauth = await call('/api/wallet');
assert.equal(unauth.status, 401);
const a = await call('/api/session', { body: {} });
const b = await call('/api/session', { body: {} });
assert.equal(a.status, 200);
assert.equal('userId' in a.data || 'username' in a.data, false, 'no shared account number or name');
assert.equal(a.data.balanceCents, 10000000);
const cookieA = a.headers.get('set-cookie').split(';')[0];
const cookieB = b.headers.get('set-cookie').split(';')[0];
assert.notEqual(cookieA, cookieB);
assert.match(a.headers.get('set-cookie'), /HttpOnly/);
assert.match(a.headers.get('set-cookie'), /Secure/);
assert.match(a.headers.get('set-cookie'), /SameSite=Lax/);
assert.match(a.headers.get('set-cookie'), /Path=\//);
// No account numbers in paths: asking for "another" account by number is not a route at all.
for (const other of ['/api/wallet/2', '/api/rounds/2', '/api/fairness/commitment/2']) assert.equal((await call(other, { cookie: cookieA })).status, 404, other);
assert.equal((await call('/api/session', { body: {}, headers: { Origin: 'https://attacker.invalid' } })).status, 403);
assert.equal((await call('/api/session', { body: {}, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
assert.equal((await call('/api/session', { body: { username: 'x'.repeat(40000) } })).status, 413);
console.log('PASS opaque cookie isolation, user scope, origin and size guards');

let commitment = (await call('/api/fairness/commitment', { cookie: cookieA })).data;
assert.equal(commitment.serverSeed, undefined);
assert.match(commitment.serverSeedHash, /^[a-f0-9]{64}$/);
const clientSeed = 'integration-' + randomUUID();
const updated = await call('/api/fairness/client-seed', { cookie: cookieA, body: { clientSeed, expectedCommitment: commitment } });
assert.equal(updated.status, 200);
assert.equal(updated.data.clientSeed, clientSeed);
assert.equal(updated.data.serverSeedHash, commitment.serverSeedHash);
commitment = updated.data;
// A player can ask for a fresh lock before betting; the unused old key is revealed and fits the old lock.
assert.equal((await call('/api/fairness/rotate', { cookie: cookieA, body: {} })).status, 400);
const rotated = await call('/api/fairness/rotate', { cookie: cookieA, body: { expectedCommitment: commitment } });
assert.equal(rotated.status, 200);
assert.equal(rotated.data.retired.serverSeedHash, commitment.serverSeedHash);
assert.equal(createHash('sha256').update(rotated.data.retired.serverSeed).digest('hex'), commitment.serverSeedHash);
assert.notEqual(rotated.data.commitment.serverSeedHash, commitment.serverSeedHash);
assert.equal(rotated.data.commitment.serverSeed, undefined);
assert.equal(rotated.data.commitment.clientSeed, clientSeed);
assert.equal((await call('/api/fairness/rotate', { cookie: cookieA, body: { expectedCommitment: commitment } })).status, 409, 'stale lock cannot be rotated');
commitment = rotated.data.commitment;
console.log('PASS player can rotate the lock; old key revealed and verified');
// Capture the observed tuple BEFORE generating the fresh per-round entropy.
const protocol = () => ({ expectedCommitment: { ...commitment }, clientEntropy: randomBytes(32).toString('hex'), requestId: randomUUID() });
const originalReceipts = new Map();
const spin = async (bets, extra = {}) => {
  const body = { bets, ...protocol(), ...extra };
  if (!originalReceipts.has(body.requestId)) originalReceipts.set(body.requestId, structuredClone(body));
  return call('/api/games/roulette/spin', { cookie: cookieA, body });
};
const initialBets = [{ type: 'straight', value: 7, amountCents: 100 }];
const invalid = [[], Array(101).fill(initialBets[0]), [{ type: 'corner', value: [1, 2], amountCents: 100 }], [{ type: 'straight', value: 37, amountCents: 100 }], [{ type: 'split', value: [1, 1], amountCents: 100 }], [{ type: 'red', amountCents: -1 }], [{ type: 'red', amountCents: 1.5 }], [{ type: 'red', amountCents: Number.MAX_SAFE_INTEGER }], [{ type: 'toString', amountCents: 1 }], [{ type: ['red'], amountCents: 1 }], [null]];
for (const bets of invalid) assert.equal((await spin(bets)).status, 400, JSON.stringify(bets));
for (const extra of [
  { requestId: undefined }, { requestId: 'not-a-uuid' }, { expectedCommitment: undefined },
  { clientEntropy: undefined }, { clientEntropy: 'A'.repeat(64) },
  ...['serverSeedHash', 'clientSeed', 'nonce'].map((field) => ({ expectedCommitment: { ...commitment, [field]: undefined } })),
]) assert.equal((await spin(initialBets, extra)).status, 400);
for (const extra of [
  { expectedCommitment: { ...commitment, serverSeedHash: '0'.repeat(64) } },
  { expectedCommitment: { ...commitment, clientSeed: 'substituted' } },
  { expectedCommitment: { ...commitment, nonce: commitment.nonce + 1 } },
]) assert.equal((await spin(initialBets, extra)).status, 409);
assert.equal((await call('/api/fairness/client-seed', { cookie: cookieA, body: { clientSeed: 'missing-observation' } })).status, 400);
// The account is the cookie: old /1 paths are gone and there is no id to change.
for (const old of ['/api/wallet/1', '/api/wallet/2', '/api/rounds/1', '/api/fairness/commitment/1']) assert.equal((await call(old, { cookie: cookieA })).status, 404, old);
assert.ok([400, 402].includes((await spin([{ type: 'red', amountCents: 10000001 }])).status), 'over the balance or the table limit');
assert.deepEqual((await call('/api/fairness/commitment', { cookie: cookieA })).data, commitment);
assert.equal((await call('/api/wallet', { cookie: cookieA })).data.balanceCents, 10000000);
assert.deepEqual((await call('/api/rounds', { cookie: cookieA })).data, []);
console.log('PASS invalid bets and insufficient funds preserve balance, history and commitment');

function recompute(fairness) {
  assert.equal(createHash('sha256').update(fairness.serverSeed).digest('hex'), fairness.serverSeedHash);
  const limit = Math.floor(0xffffffff / 37) * 37;
  for (let counter = 0; ; counter++) {
    const value = createHmac('sha256', fairness.serverSeed).update(`${fairness.clientSeed}:${fairness.nonce}:${counter}`).digest().readUInt32BE(0);
    if (value < limit) return value % 37;
  }
}
const firstProtocol = protocol();
const requestId = firstProtocol.requestId;
const first = await spin(initialBets, firstProtocol);
assert.equal(first.status, 200);
const result = first.data;
assert.equal(result.fairness.serverSeedHash, commitment.serverSeedHash);
assert.equal(result.requestId, requestId);
assert.equal(result.fairness.clientSeed, `${clientSeed}:${firstProtocol.clientEntropy}`);
assert.equal(recompute(result.fairness), result.pocket);
const payout = result.pocket === 7 ? 3600 : 0;
assert.equal(result.totalStakeCents, 100);
assert.equal(result.totalPayoutCents, payout);
assert.equal(result.balanceAfterCents, 10000000 - 100 + payout);
assert.notEqual(result.fairness.nextCommitment.serverSeedHash, commitment.serverSeedHash);
assert.equal(result.fairness.nextCommitment.serverSeed, undefined);
assert.equal(result.fairness.nextCommitment.clientSeed, clientSeed);
assert.deepEqual((await spin(initialBets, firstProtocol)).data, result);
assert.equal((await spin([{ type: 'black', amountCents: 100 }], { requestId })).status, 409);
assert.deepEqual((await call('/api/fairness/commitment', { cookie: cookieA })).data, result.fairness.nextCommitment);
assert.equal((await call('/api/wallet', { cookie: cookieB })).data.balanceCents, 10000000);
assert.deepEqual((await call('/api/rounds', { cookie: cookieB })).data, []);
const resumed = await call('/api/session', { cookie: cookieA, body: {} });
assert.equal(resumed.data.balanceCents, result.balanceAfterCents);
console.log('PASS settlement arithmetic, independent HMAC verification, seed persistence and idempotency');
commitment = result.fairness.nextCommitment;

let expectedBalance = result.balanceAfterCents;
const allPockets = Array.from({ length: 37 }, (_, value) => ({ type: 'straight', value, amountCents: 10 }));
// Guaranteed return 360 against stake 370, avoiding probabilistic failures.
for (let n = 0; n < 27; n++) {
  const next = await spin(allPockets);
  assert.equal(next.status, 200);
  expectedBalance -= 10;
  assert.equal(next.data.balanceAfterCents, expectedBalance);
  assert.equal(recompute(next.data.fairness), next.data.pocket);
  assert.equal(next.data.fairness.clientSeedBase, clientSeed);
  assert.equal(next.data.fairness.clientSeed, `${clientSeed}:${next.data.fairness.clientEntropy}`);
  commitment = next.data.fairness.nextCommitment;
}
const history = await call('/api/rounds', { cookie: cookieA });
assert.equal(history.data.length, 25);
for (const [i, row] of history.data.entries()) {
  assert.equal(row.status, 'settled');
  assert.equal(row.user_id, undefined, 'internal account number is not sent');
  assert.equal(row.stake_cents, 370);
  assert.equal(row.payout_cents, 360);
  assert.ok(row.revealed_at);
  assert.ok(row.created_at);
  assert.match(row.request_id, /^[0-9a-f-]{36}$/);
  assert.equal(row.client_seed_base, clientSeed);
  assert.equal(row.client_seed, `${row.client_seed_base}:${row.client_entropy}`);
  assert.equal(JSON.parse(row.receipt_json).requestId, row.request_id);
  const original = originalReceipts.get(row.request_id);
  assert.ok(original, 'history must match our pre-bet receipt, not a server-provided proof');
  assert.equal(row.server_seed_hash, original.expectedCommitment.serverSeedHash);
  assert.equal(row.nonce, original.expectedCommitment.nonce);
  assert.equal(row.client_seed, `${original.expectedCommitment.clientSeed}:${original.clientEntropy}`);
  assert.equal(JSON.parse(row.bet_json).length, 37);
  assert.equal(JSON.parse(row.outcome_json).pocket, recompute({ serverSeed: row.server_seed, serverSeedHash: row.server_seed_hash, clientSeed: row.client_seed, nonce: row.nonce }));
  if (i) assert.ok(history.data[i - 1].id > row.id);
}
// Concurrent repeated request must settle exactly once.
const concurrentId = randomUUID();
const concurrentProtocol = { ...protocol(), requestId: concurrentId };
const concurrent = await Promise.all(Array.from({ length: 8 }, () => spin(allPockets, concurrentProtocol)));
for (const response of concurrent) { assert.equal(response.status, 200); assert.deepEqual(response.data, concurrent[0].data); }
assert.equal(concurrent[0].data.balanceAfterCents, expectedBalance - 10);
assert.equal((await call('/api/wallet', { cookie: cookieA })).data.balanceCents, expectedBalance - 10);
commitment = concurrent[0].data.fairness.nextCommitment;
const headerKey = randomUUID();
const headerOptions = { cookie: cookieA, body: { bets: allPockets, ...protocol(), requestId: headerKey }, headers: { 'Idempotency-Key': headerKey } };
const byHeader = await call('/api/games/roulette/spin', headerOptions);
assert.equal(byHeader.status, 200);
assert.equal(byHeader.data.balanceAfterCents, expectedBalance - 20);
assert.deepEqual((await call('/api/games/roulette/spin', headerOptions)).data, byHeader.data);
assert.equal((await call('/api/games/roulette/spin', { ...headerOptions, body: { ...headerOptions.body, requestId: 'different-key' } })).status, 400);
assert.equal((await call('/api/wallet', { cookie: `__Host-casino_demo=${createHash('sha256').update(randomUUID()).digest('hex')}` })).status, 401);
assert.equal((await call('/api/deposit', { cookie: cookieA, body: { amountCents: 100000 } })).status, 404);
console.log('PASS newest-25 snake_case history, concurrent/header idempotency, forged-cookie rejection, no deposit route');
commitment = byHeader.data.fairness.nextCommitment;
const stableState = async () => (await Promise.all(['/api/wallet', '/api/rounds', '/api/fairness/commitment'].map((path) => call(path, { cookie: cookieA })))).map((res) => res.data);
const beforeRejected = await stableState();
assert.equal((await spin(allPockets, { clientEntropy: firstProtocol.clientEntropy })).status, 409);
assert.equal((await spin(allPockets, { expectedCommitment: firstProtocol.expectedCommitment })).status, 409);
for (const changed of [
  { clientEntropy: randomBytes(32).toString('hex') },
  { expectedCommitment: { ...firstProtocol.expectedCommitment, clientSeed: 'other' } },
  { expectedCommitment: undefined }, { clientEntropy: undefined },
]) assert.equal((await spin(initialBets, { ...firstProtocol, ...changed })).status, 409);
assert.equal((await call('/api/games/roulette/spin', { ...headerOptions, body: { ...headerOptions.body, requestId: undefined } })).status, 400);
assert.equal((await call('/api/fairness/client-seed', { cookie: cookieA, body: { clientSeed: 'must-not-apply-to-future-round', expectedCommitment: firstProtocol.expectedCommitment } })).status, 409);
assert.deepEqual(await stableState(), beforeRejected);

// Same tuple, distinct request IDs: only one wager may consume it, even if
// multiple reservations would overspend the wallet. Guaranteed payout avoids luck.
const bigBets = allPockets.map((bet) => ({ ...bet, amountCents: 2700 }));
const observedB = (await call('/api/fairness/commitment', { cookie: cookieB })).data;
const spendBodies = Array.from({ length: 4 }, () => ({ bets: bigBets, requestId: randomUUID(), expectedCommitment: observedB, clientEntropy: randomBytes(32).toString('hex') }));
const spends = await Promise.all(spendBodies.map((body) => call('/api/games/roulette/spin', { cookie: cookieB, body })));
assert.deepEqual(spends.map((response) => response.status).sort(), [200, 409, 409, 409]);
assert.equal((await call('/api/wallet', { cookie: cookieB })).data.balanceCents, 10000000 - 2700 * 37 + 2700 * 36);
assert.equal((await call('/api/rounds', { cookie: cookieB })).data.length, 1);
const nextB = (await call('/api/fairness/commitment', { cookie: cookieB })).data;
assert.equal((await call('/api/games/roulette/spin', { cookie: cookieB, body: { ...spendBodies[0], requestId: randomUUID(), expectedCommitment: nextB, clientEntropy: randomBytes(32).toString('hex') } })).status, 200, 'a fresh tuple can be used once more');

// An actual concurrent seed/spin race must have precisely one winner.
const raceProtocol = protocol();
const race = await Promise.all([
  spin(allPockets, raceProtocol),
  call('/api/fairness/client-seed', { cookie: cookieA, body: { clientSeed: 'racing-new-base', expectedCommitment: raceProtocol.expectedCommitment } }),
]);
assert.deepEqual(race.map((response) => response.status).sort(), [200, 409]);
commitment = (await call('/api/fairness/commitment', { cookie: cookieA })).data;
assert.equal(commitment.clientSeed, race[0].status === 200 ? clientSeed : 'racing-new-base');
console.log('PASS strict observed tuple, mandatory UUID/entropy, entropy replay guard, stale seed/spin race and distinct concurrent overspend');
console.log(`ALL INTEGRATION CHECKS PASSED against ${base}`);
