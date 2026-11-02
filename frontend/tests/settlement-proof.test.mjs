// Audit 2026-10-31: (1) a live settlement without a valid ending balance must fail, never skip the
// balance check; (2) the downloaded round proof carries the money too, and the offline verifier checks it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { verifySettlement, combineVerification, settlementForProof } from '../src/fairnessClient.js';
import { didBetWin, multiplierFor, STANDARD_MULTIPLIERS } from '../src/rouletteRules.js';

const bets = [{ type: 'straight', value: 17, amountCents: 10000 }];
const terms = { bets, stake: 10000, mode: 'real', mathId: 'standard', multipliers: STANDARD_MULTIPLIERS, balanceBefore: 1000000 };
// The auditor's example: 10,000 TICS, stake 100, straight win pays 3,600 gross, ends at 13,500.
const win = { pocket: 17, mode: 'real', mathId: 'standard', betResults: [{ ...bets[0], payoutCents: 360000 }],
  totalStakeCents: 10000, totalPayoutCents: 360000, balanceAfterCents: 1350000 };

test('a live settlement with a missing or malformed ending balance fails', () => {
  assert.equal(verifySettlement(terms, win, didBetWin).ok, true);
  assert.equal(verifySettlement(terms, win, didBetWin).balanceChecked, true);
  const variants = { missing: undefined, null: null, text: '1350000', fractional: 1350000.5, unsafe: 2 ** 53, negative: -1 };
  for (const [name, value] of Object.entries(variants)) {
    const data = { ...win, balanceAfterCents: value };
    if (value === undefined) delete data.balanceAfterCents;
    const r = verifySettlement(terms, data, didBetWin);
    assert.equal(r.ok, false, name);
    assert.ok(r.problems.includes('balance after the spin missing or invalid'), `${name}: ${r.problems}`);
  }
});

test('a history check (no balance in the terms) still passes but says the balance was not checked', () => {
  const { balanceBefore: _b, ...historyTerms } = terms;
  const { balanceAfterCents: _a, ...historyData } = win;
  const r = verifySettlement(historyTerms, historyData, didBetWin);
  assert.equal(r.ok, true, String(r.problems));
  assert.equal(r.balanceChecked, false);
  const outcome = { ok: true };
  assert.equal(combineVerification(outcome, historyTerms, historyData, didBetWin).settlement.balanceChecked, false);
});

test('App: a history check strips the balance from the terms and the proof file includes the settlement', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const fn = app.slice(app.indexOf('const runVerify = async'), app.indexOf('const downloadProof'));
  assert.match(fn, /settlementData \? expected\.terms : withoutBalance\(expected\.terms\)/);
  assert.match(fn, /const proof = \{ version: 1, expected, result, settlement: settlementForProof\(settlement\) \}/);
});

test('settlementForProof keeps only the money fields', () => {
  const p = settlementForProof({ ...win, fairness: { serverSeed: 'x' }, extra: 1 });
  assert.deepEqual(Object.keys(p).sort(), ['balanceAfterCents', 'betResults', 'mathId', 'mode', 'pocket', 'totalPayoutCents', 'totalStakeCents']);
  assert.equal(settlementForProof(null), null);
});

const script = fileURLToPath(new URL('../public/verify-roulette.mjs', import.meta.url));

test('offline verifier: winning rules match the site for all 18 bet types and every pocket', async () => {
  const { multiplierFor: offline } = await import(script);
  const sample = { straight: 17, split: [17, 20], trio: [0, 1, 2], street: [16, 17, 18], corner: [16, 17, 19, 20], sixline: [13, 14, 15, 16, 17, 18] };
  let cases = 0;
  for (const type of Object.keys(STANDARD_MULTIPLIERS)) for (let pocket = 0; pocket <= 36; pocket++) {
    const bet = { type, value: sample[type], amountCents: 100 };
    assert.equal(offline(bet, pocket), multiplierFor(bet, pocket), `${type} on ${pocket}`); cases++;
  }
  assert.equal(cases, 18 * 37);
});

function realProof() {
  const serverSeed = 'a'.repeat(64), clientSeed = 'lucky:' + 'b'.repeat(64);
  const limit = Math.floor(0xffffffff / 37) * 37;
  let pocket;
  for (let c = 0; ; c++) { const v = createHmac('sha256', serverSeed).update(`${clientSeed}:0:${c}`).digest().readUInt32BE(0); if (v < limit) { pocket = v % 37; break; } }
  const serverSeedHash = createHash('sha256').update(serverSeed).digest('hex');
  const bet = { type: 'straight', value: pocket, amountCents: 10000 };
  const t = { ...terms, bets: [bet] };
  const settlement = { pocket, mode: 'real', mathId: 'standard', betResults: [{ ...bet, payoutCents: 360000 }], totalStakeCents: 10000, totalPayoutCents: 360000, balanceAfterCents: 1350000 };
  return { version: 1, expected: { serverSeedHash, clientSeed, nonce: 0, requestId: 'r1', terms: t },
    result: { serverSeed, serverSeedHash, clientSeed, nonce: 0, max: 37, pocket, requestId: 'r1' }, settlement };
}

test('offline verifier checks the money in the proof file', () => {
  const dir = mkdtempSync(join((process.env.TMPDIR || '/tmp') + '/', 'settle-proof-'));
  const run = (proof) => { const f = join(dir, 'p.json'); writeFileSync(f, JSON.stringify(proof)); return spawnSync(process.execPath, [script, f], { encoding: 'utf8' }); };
  try {
    const good = realProof();
    let r = run(good);
    assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /VERIFIED/); assert.match(r.stdout, /"payoutMatches": true/); assert.match(r.stdout, /"balanceMatches": true/);
    r = run({ ...good, settlement: { ...good.settlement, betResults: [{ ...good.settlement.betResults[0], payoutCents: 36000 }], totalPayoutCents: 36000 } });
    assert.equal(r.status, 1); assert.match(r.stdout, /MISMATCH/);
    const noBalance = { ...good.settlement }; delete noBalance.balanceAfterCents;
    r = run({ ...good, settlement: noBalance });
    assert.equal(r.status, 1); assert.match(r.stdout, /MISMATCH/);
    r = run({ ...good, settlement: { ...good.settlement, balanceAfterCents: 1349999 } });
    assert.equal(r.status, 1); assert.match(r.stdout, /MISMATCH/);
    // An older proof without money still verifies the number and says the payout was not checked.
    const { settlement: _s, ...numberOnly } = good;
    r = run(numberOnly);
    assert.equal(r.status, 0, r.stdout); assert.match(r.stdout, /payout not checked/i); assert.match(r.stdout, /"payoutMatches": null/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
