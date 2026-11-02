// Standalone Node.js verifier. No packages, shell interpolation, eval, network
// requests or operator API. Keep this file and the JSON proof separate.
// Usage: node verify-roulette.mjs round-proof.json
// Checks the winning number and, when the proof carries the bet terms and the settlement,
// the money too: every bet's payout, the totals and the ending balance.
import { createHash, createHmac } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const NUMBER_BETS = { straight: 1, split: 2, trio: 3, street: 3, corner: 4, sixline: 6 };

// Standard total-return multiplier of a bet on a pocket (0 = lost). Same rules as the site.
export function multiplierFor(bet, pocket) {
  if (bet.type in NUMBER_BETS) {
    const nums = bet.type === 'straight' ? [bet.value] : bet.value;
    return Array.isArray(nums) && nums.includes(pocket) ? 36 / nums.length : 0;
  }
  const p = pocket, n = p !== 0;
  switch (bet.type) {
    case 'red': return n && RED.has(p) ? 2 : 0;
    case 'black': return n && !RED.has(p) ? 2 : 0;
    case 'odd': return n && p % 2 === 1 ? 2 : 0;
    case 'even': return n && p % 2 === 0 ? 2 : 0;
    case 'low': return p >= 1 && p <= 18 ? 2 : 0;
    case 'high': return p >= 19 && p <= 36 ? 2 : 0;
    case 'dozen1': return p >= 1 && p <= 12 ? 3 : 0;
    case 'dozen2': return p >= 13 && p <= 24 ? 3 : 0;
    case 'dozen3': return p >= 25 && p <= 36 ? 3 : 0;
    case 'column1': return n && p % 3 === 1 ? 3 : 0;
    case 'column2': return n && p % 3 === 2 ? 3 : 0;
    case 'column3': return n && p % 3 === 0 ? 3 : 0;
    default: return 0;
  }
}

// The money check: null when the proof has no bet terms or no settlement (older proof files).
export function checkSettlement(terms, s, pocket) {
  if (!terms || !Array.isArray(terms.bets) || !s) return null;
  const problems = [];
  const results = Array.isArray(s.betResults) ? s.betResults : [];
  if (s.pocket !== pocket) problems.push('settlement pocket differs');
  if (s.mode !== terms.mode) problems.push('play mode changed');
  if (terms.mathId && s.mathId !== terms.mathId) problems.push('payout table changed');
  if (results.length !== terms.bets.length) problems.push('bets changed');
  let stake = 0, payout = 0;
  terms.bets.forEach((bet, i) => {
    const r = results[i] || {};
    if (r.type !== bet.type || JSON.stringify(r.value ?? null) !== JSON.stringify(bet.value ?? null) || r.amountCents !== bet.amountCents) problems.push(`bet ${i + 1} changed`);
    stake += bet.amountCents;
    const mult = terms.multipliers?.[bet.type];
    if (!Number.isFinite(mult)) { problems.push('payout table missing'); return; }
    const expected = multiplierFor(bet, pocket) > 0 ? Math.floor(bet.amountCents * mult) : 0;
    payout += expected;
    if (r.payoutCents !== expected) problems.push(`bet ${i + 1} paid ${r.payoutCents} instead of ${expected}`);
  });
  if (s.totalStakeCents !== stake) problems.push('total stake differs');
  if (s.totalPayoutCents !== payout) problems.push('total payout differs');
  const payoutMatches = problems.length === 0;
  // The balance may be higher (a top up landed meanwhile) but never lower than before - stake + payout.
  let balanceMatches = null;
  if (Number.isSafeInteger(terms.balanceBefore)) {
    const after = s.balanceAfterCents;
    balanceMatches = Number.isSafeInteger(after) && after >= 0 && after >= terms.balanceBefore - stake + payout;
    if (!balanceMatches) problems.push('balance after the spin missing, invalid or too low');
  }
  return { payoutMatches, balanceMatches, problems, expectedPayoutCents: payout };
}

function main() {
  try {
    const proof = JSON.parse(readFileSync(process.argv[2] || 'round-proof.json', 'utf8'));
    if (proof.version !== 1 || !proof.result) throw Error('Unsupported or incomplete proof file');
    const r = proof.result, e = proof.expected;
    if (typeof r.serverSeed !== 'string' || typeof r.clientSeed !== 'string' || !Number.isSafeInteger(r.nonce)) throw Error('Invalid round inputs');
    const recorded = !!e && /^[a-f0-9]{64}$/.test(e.serverSeedHash) && typeof e.clientSeed === 'string'
      && e.clientSeed.length > 0 && Number.isSafeInteger(e.nonce) && e.nonce >= 0 && typeof e.requestId === 'string' && e.requestId.length > 0;
    const hash = createHash('sha256').update(r.serverSeed).digest('hex');
    const hashMatches = hash === (recorded ? e.serverSeedHash : r.serverSeedHash);
    const inputsMatch = recorded && r.serverSeedHash === e.serverSeedHash && r.clientSeed === e.clientSeed
      && r.nonce === e.nonce && r.requestId === e.requestId;
    const seed = recorded ? e.clientSeed : r.clientSeed, nonce = recorded ? e.nonce : r.nonce;
    const limit = Math.floor(0xffffffff / 37) * 37;
    let outcome;
    for (let counter = 0; ; counter++) {
      const value = createHmac('sha256', r.serverSeed).update(`${seed}:${nonce}:${counter}`).digest().readUInt32BE(0);
      if (value < limit) { outcome = value % 37; break; }
    }
    const outcomeMatches = Number.isInteger(r.pocket) && outcome === r.pocket;
    const money = recorded ? checkSettlement(e.terms, proof.settlement, outcome) : null;
    const ok = recorded && hashMatches && inputsMatch && outcomeMatches && (!money || money.problems.length === 0);
    console.log(!recorded ? 'UNRECORDED: original pre-bet receipt unavailable; commitment timing cannot be verified.'
      : !ok ? 'MISMATCH: do not treat this round as verified.'
      : money ? `VERIFIED: pre-bet commitment, agreed inputs, recorded pocket and payout match${money.balanceMatches === null ? ' (balance not part of this proof)' : ' (ending balance too)'}.`
      : 'VERIFIED: pre-bet commitment, agreed inputs and recorded pocket match (payout not checked: this proof has no bet terms or settlement).');
    console.log(JSON.stringify({ commitmentRecorded: recorded, hashMatches, inputsMatch, outcomeMatches, recomputedPocket: outcome, recordedPocket: r.pocket,
      payoutMatches: money ? money.payoutMatches : null, balanceMatches: money ? money.balanceMatches : null,
      expectedPayoutCents: money ? money.expectedPayoutCents : null, problems: money ? money.problems : [] }, null, 2));
    process.exitCode = ok ? 0 : 1;
  } catch (error) {
    console.error('VERIFICATION ERROR:', error.message);
    process.exitCode = 1;
  }
}

// Runs when started with node; importing the file (tests) only loads the functions.
const self = (() => { try { return realpathSync(fileURLToPath(import.meta.url)); } catch { return null; } })();
const started = (() => { try { return process.argv[1] ? realpathSync(process.argv[1]) : null; } catch { return null; } })();
if (self && self === started) main();
