import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { playRound } from '../../backend/src/games/slots.js';
import { SLOT_MATH } from '../../backend/src/games/slotsMath.js';
import { makeUint32At } from '../../backend/src/core/slotDraws.js';

const verifier = new URL('../public/verify-slots.mjs', import.meta.url);

test('the standalone verifier embeds the published maths exactly', async () => {
  const m = await import(verifier.href);
  assert.equal(JSON.stringify(m.MATH), JSON.stringify(SLOT_MATH));
  const src = readFileSync(verifier, 'utf8');
  assert.ok(!/from '\.\.?\//.test(src), 'no repo imports');
  assert.ok(!/eval\(|new Function|child_process|fetch\(/.test(src));
});

function proofFor(seed, clientSeed, nonce, stake = 2000) {
  const round = playRound({ stake, uint32At: makeUint32At(seed, clientSeed, nonce), math: SLOT_MATH });
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  return { game: 'slots', stake, spins: round.spins.map((s) => ({ stops: s.stops, winUnits: s.winUnits })), totalPayoutCents: round.totalPayoutUnits,
    balanceBeforeCents: 1000000, balanceAfterCents: 1000000 - stake + round.totalPayoutUnits, expected: { serverSeedHash: hash },
    fairness: { serverSeed: seed, serverSeedHash: hash, clientSeed, nonce } };
}

test('run from a clean folder: OK for an honest proof, MISMATCH for a tampered one, seeds with shell characters are data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verify-slots-'));
  copyFileSync(verifier, join(dir, 'verify-slots.mjs'));
  const seed = crypto.randomBytes(32).toString('hex');
  const honest = proofFor(seed, `it's a "word" $(echo x) \`y\`;rm:${'e'.repeat(64)}`, 0);
  writeFileSync(join(dir, 'ok.json'), JSON.stringify(honest));
  const out = execFileSync(process.execPath, ['verify-slots.mjs', 'ok.json'], { cwd: dir, encoding: 'utf8' });
  assert.match(out, /^OK: \d+ spin/);
  const bad = JSON.parse(JSON.stringify(honest)); bad.totalPayoutCents += 100; bad.balanceAfterCents += 100;
  writeFileSync(join(dir, 'bad.json'), JSON.stringify(bad));
  let code = 0, text = '';
  try { execFileSync(process.execPath, ['verify-slots.mjs', 'bad.json'], { cwd: dir, encoding: 'utf8' }); } catch (e) { code = e.status; text = e.stdout; }
  assert.equal(code, 1); assert.match(text, /MISMATCH/); assert.match(text, /Total payout differs/);
  const wrongSeed = JSON.parse(JSON.stringify(honest)); wrongSeed.fairness.serverSeed = crypto.randomBytes(32).toString('hex');
  writeFileSync(join(dir, 'seed.json'), JSON.stringify(wrongSeed));
  try { execFileSync(process.execPath, ['verify-slots.mjs', 'seed.json'], { cwd: dir, encoding: 'utf8' }); assert.fail('should exit 1'); } catch (e) { assert.match(e.stdout, /does not open the lock/); }
});

test('the verifier agrees with the engine on random rounds including free spin rounds', async () => {
  const m = await import(verifier.href);
  let sawFree = false;
  for (let i = 0; i < 1500; i++) {
    const seed = crypto.randomBytes(32).toString('hex');
    const p = proofFor(seed, 'w:' + crypto.randomBytes(32).toString('hex'), i);
    const r = m.verifyProof(p);
    assert.equal(r.ok, true, r.problems.join(' '));
    if (p.spins.length > 1) sawFree = true;
  }
  assert.ok(sawFree, 'at least one free spin round in 1500 (1 in 140 expected)');
});

test('a recorded grid that disagrees with its own reel stops is a MISMATCH; a proof without the expected block prints a WARNING', async () => {
  const { gridFor } = await import('../../backend/src/games/slots.js');
  const m = await import(verifier.href);
  const dir = mkdtempSync(join(tmpdir(), 'verify-slots-grid-'));
  copyFileSync(verifier, join(dir, 'verify-slots.mjs'));
  const seed = crypto.randomBytes(32).toString('hex');
  const honest = proofFor(seed, 'w:' + 'e'.repeat(64), 0);
  // With the honest picture: still OK.
  const withGrid = JSON.parse(JSON.stringify(honest)); withGrid.spins = withGrid.spins.map((s) => ({ ...s, grid: gridFor(s.stops, SLOT_MATH) }));
  assert.equal(m.verifyProof(withGrid).ok, true);
  // Same stops, same win, doctored picture: caught.
  const doctored = JSON.parse(JSON.stringify(withGrid)); doctored.spins[0].grid = doctored.spins[0].grid.map((row) => row.map(() => 'W'));
  const r = m.verifyProof(doctored);
  assert.equal(r.ok, false); assert.ok(r.problems.some((p) => /Spin 1: the recorded picture differs from the one the reel stops give/.test(p)), r.problems.join(' '));
  writeFileSync(join(dir, 'grid.json'), JSON.stringify(doctored));
  let code = 0, text = '';
  try { execFileSync(process.execPath, ['verify-slots.mjs', 'grid.json'], { cwd: dir, encoding: 'utf8' }); } catch (e) { code = e.status; text = e.stdout; }
  assert.equal(code, 1); assert.match(text, /MISMATCH/); assert.match(text, /recorded picture differs/);
  // No expected block: the result is OK (internal consistency) but the output says the pre-bet lock was not checked.
  const { expected, ...bare } = honest;
  assert.equal(m.verifyProof(bare).expectedChecked, false); assert.equal(m.verifyProof(honest).expectedChecked, true);
  writeFileSync(join(dir, 'bare.json'), JSON.stringify(bare));
  const out = execFileSync(process.execPath, ['verify-slots.mjs', 'bare.json'], { cwd: dir, encoding: 'utf8' });
  assert.match(out, /^OK: \d+ spin/); assert.match(out, /^WARNING: .*no "expected" block.*pre-bet lock was NOT checked/m);
  assert.equal(m.NO_EXPECTED_WARNING.startsWith('WARNING:'), true);
  writeFileSync(join(dir, 'full.json'), JSON.stringify(honest));
  assert.doesNotMatch(execFileSync(process.execPath, ['verify-slots.mjs', 'full.json'], { cwd: dir, encoding: 'utf8' }), /WARNING/, 'no warning when the expected block is there');
  // A mismatch without the expected block prints both.
  const bareBad = JSON.parse(JSON.stringify(bare)); bareBad.totalPayoutCents += 100;
  writeFileSync(join(dir, 'bare-bad.json'), JSON.stringify(bareBad));
  try { execFileSync(process.execPath, ['verify-slots.mjs', 'bare-bad.json'], { cwd: dir, encoding: 'utf8' }); assert.fail('should exit 1'); } catch (e) { assert.match(e.stdout, /MISMATCH/); assert.match(e.stdout, /WARNING/); }
});
