// Independent, in-browser recomputation of a round's outcome using the Web
// Crypto API (built into every browser — no library, no server call).
//
// This deliberately does NOT call the backend's /api/fairness/verify route.
// Asking the same server that generated a result "was this fair?" proves
// nothing to a skeptical player, since that server is the exact party being
// checked. Recompute locally against an independently saved pre-bet receipt.
// The page's JavaScript is still delivered by the operator; a separate,
// inspectable Node verifier and JSON export support checking off-site.
//
// Mirrors backend/src/core/fairness.js exactly: HMAC-SHA256(serverSeed,
// `${clientSeed}:${nonce}:${counter}`) with rejection sampling. Node's
// crypto.createHmac/createHash treat a JS string key/message as its UTF-8
// bytes by default (not hex-decoded) — TextEncoder here does the same, so
// the two implementations agree bit-for-bit.
export function isCommitmentValid(c) {
  return !!c && /^[a-f0-9]{64}$/.test(c.serverSeedHash) && typeof c.clientSeed === 'string'
    && c.clientSeed.length > 0 && c.clientSeed.length <= 64 && Number.isSafeInteger(c.nonce) && c.nonce >= 0;
}

export function readRevealedHashes(storage = globalThis.localStorage) {
  const hashes = JSON.parse(storage.getItem('noir:revealed:v1') || '[]');
  if (!Array.isArray(hashes) || !hashes.every(h => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h))) throw new Error('Revealed-seed record is invalid.');
  return hashes;
}

// Bounded proof storage: the newest MAX_REVEALED revealed-seed fingerprints and MAX_RECEIPTS
// pre-bet receipts are kept. The server never reuses a seed (each lock is fresh 256-bit
// randomness), so this list is a second line of defence, not the only one.
export const MAX_REVEALED = 2000;
export const MAX_RECEIPTS = 500;
const RECEIPT_PREFIX = 'noir:prebet:v1:';
const RECEIPT_INDEX = 'noir:prebet:index:v1';
export function rememberRevealedSeed(hash, storage = globalThis.localStorage) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid revealed-seed fingerprint.');
  const hashes = [...new Set([...readRevealedHashes(storage), hash])].slice(-MAX_REVEALED);
  const data = JSON.stringify(hashes); storage.setItem('noir:revealed:v1', data);
  if (storage.getItem('noir:revealed:v1') !== data) throw new Error('Unable to save revealed-seed record.');
  return hashes;
}

export function isNextCommitmentSafe(next, expected, revealedHashes = []) {
  return isCommitmentValid(next) && next.serverSeedHash !== expected.serverSeedHash
    && !revealedHashes.includes(next.serverSeedHash) && next.clientSeed === expected.clientSeedBase && next.nonce === 0;
}

export function canStartRound({ commitment, busy = false, saving = false, failed = false, checking = false }) {
  return isCommitmentValid(commitment) && !busy && !saving && !failed && !checking;
}

export function createRoundRequest(commitment, bets) {
  if (!isCommitmentValid(commitment)) throw new Error('A valid pre-bet commitment is required.');
  if (typeof window !== 'undefined' && readRevealedHashes(window.localStorage).includes(commitment.serverSeedHash)) throw new Error('This server seed has already been revealed.');
  const agreed = Object.freeze({ serverSeedHash: commitment.serverSeedHash, clientSeed: commitment.clientSeed, nonce: commitment.nonce });
  // Generated ONLY after the server hash has been received and validated.
  const clientEntropy = bufToHex(crypto.getRandomValues(new Uint8Array(32)));
  const requestId = crypto.randomUUID();
  const expected = Object.freeze({ requestId, serverSeedHash: agreed.serverSeedHash,
    clientSeed: `${agreed.clientSeed}:${clientEntropy}`, nonce: agreed.nonce,
    clientSeedBase: agreed.clientSeed, clientEntropy });
  return { expected, body: { bets, requestId, expectedCommitment: agreed, clientEntropy } };
}

function pruneReceipts(storage, keepKey) {
  let index = [];
  try { index = JSON.parse(storage.getItem(RECEIPT_INDEX) || '[]'); } catch { index = []; }
  if (!Array.isArray(index)) index = [];
  if (!index.length) for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k && k.startsWith(RECEIPT_PREFIX)) index.push(k); }
  index = [...index.filter((k) => k !== keepKey), keepKey];
  while (index.length > MAX_RECEIPTS) storage.removeItem(index.shift());
  storage.setItem(RECEIPT_INDEX, JSON.stringify(index));
}
export function saveRoundReceipt(expected, roundId = null, storage = globalThis.localStorage) {
  const key = `${RECEIPT_PREFIX}${expected.requestId}`;
  const data = JSON.stringify({ expected, roundId });
  const write = () => { storage.setItem(key, data); return storage.getItem(key) === data; };
  let ok = false;
  try { ok = write(); } catch { ok = false; }
  if (!ok) { // storage full: drop the oldest receipts and try once more
    try { pruneReceipts(storage, key); const idx = JSON.parse(storage.getItem(RECEIPT_INDEX) || '[]'); for (const k of idx.slice(0, Math.ceil(idx.length / 2))) if (k !== key) storage.removeItem(k); ok = write(); } catch { ok = false; }
  }
  if (!ok) throw new Error('Pre-bet receipt could not be saved.');
  try { pruneReceipts(storage, key); } catch { /* pruning is best effort */ }
}

// Settlement check: the server's bets, stake, mode, payout table and balance movement must match
// what this browser sent and the payout table it was shown before the bet. Returns every mismatch.
export function verifySettlement(terms, data, didBetWin) {
  const problems = [];
  if (!terms || !data) return { ok: false, problems: ['missing settlement data'] };
  const results = Array.isArray(data.betResults) ? data.betResults : [];
  if (data.mode !== terms.mode) problems.push('play mode changed');
  if (terms.mathId && data.mathId !== terms.mathId) problems.push('payout table changed');
  if (results.length !== terms.bets.length) problems.push('bets changed');
  let stake = 0, payout = 0;
  terms.bets.forEach((bet, i) => {
    const r = results[i] || {};
    const sameValue = JSON.stringify(r.value ?? null) === JSON.stringify(bet.value ?? null);
    if (r.type !== bet.type || !sameValue || r.amountCents !== bet.amountCents) problems.push(`bet ${i + 1} changed`);
    stake += bet.amountCents;
    const mult = terms.multipliers?.[bet.type];
    if (Number.isFinite(mult)) {
      const expectedPayout = didBetWin(bet, data.pocket) ? Math.floor(bet.amountCents * mult) : 0;
      payout += expectedPayout;
      if (r.payoutCents !== expectedPayout) problems.push(`bet ${i + 1} paid ${r.payoutCents} instead of ${expectedPayout}`);
    } else problems.push('payout table missing');
  });
  if (data.totalStakeCents !== stake) problems.push('total stake differs');
  if (data.totalPayoutCents !== payout) problems.push('total payout differs');
  // When the terms carry the balance before the bet (a live spin), the reply MUST carry a valid
  // ending balance: missing, null, text, fractional, unsafe or negative fails instead of skipping.
  // It can be higher (a top up landed meanwhile) but never lower than before - stake + payout.
  // History rounds have no ending balance; their terms come without balanceBefore (withoutBalance).
  const balanceChecked = Number.isSafeInteger(terms.balanceBefore);
  if (balanceChecked) {
    const after = data.balanceAfterCents;
    if (!Number.isSafeInteger(after) || after < 0) problems.push('balance after the spin missing or invalid');
    else if (after < terms.balanceBefore - stake + payout) problems.push('balance credited too little');
  }
  return { ok: problems.length === 0, problems, stake, payout, balanceChecked };
}

// Terms for a check that has no ending balance to compare (history rounds).
export function withoutBalance(terms) {
  if (!terms) return terms;
  const { balanceBefore: _unused, ...rest } = terms;
  return rest;
}

// The money part of a settlement, as written into the downloadable round proof.
export function settlementForProof(data) {
  if (!data) return null;
  const { pocket, mode, mathId, betResults, totalStakeCents, totalPayoutCents, balanceAfterCents } = data;
  return { pocket, mode, mathId, betResults, totalStakeCents, totalPayoutCents, balanceAfterCents };
}

// The settlement fields of a round from /api/rounds, in the shape verifySettlement reads. The
// history has no balance after the spin, so the balance line is skipped there.
export function settlementFromRound(round) {
  if (!round) return null;
  let outcome = null, receipt = null;
  try { outcome = JSON.parse(round.outcome_json || 'null'); } catch { outcome = null; }
  try { receipt = round.receipt_json ? JSON.parse(round.receipt_json) : null; } catch { receipt = null; }
  if (!outcome || !Array.isArray(outcome.betResults)) return null;
  const mode = round.real_money === 1 || round.real_money === true ? 'real' : round.real_money === 0 || round.real_money === false ? 'demo' : receipt?.mode ?? null;
  return { pocket: outcome.pocket, mode, mathId: round.math_id ?? null, betResults: outcome.betResults,
    totalStakeCents: round.stake_cents, totalPayoutCents: round.payout_cents ?? 0 };
}

// History check: the number proof first, then (when this browser kept the bet terms) the money.
// Without terms only the number can be confirmed, which the sheet says plainly.
export function combineVerification(outcome, terms, settlementData, didBetWin) {
  if (!outcome || !outcome.ok) return outcome;
  if (!terms || !settlementData) return { ...outcome, numberOnly: true };
  const settlement = verifySettlement(terms, settlementData, didBetWin);
  if (settlement.ok) return { ...outcome, numberOnly: false, settlement };
  return { ...outcome, ok: false, numberOnly: false, status: 'settlement', settlement, error: `Payout check failed: ${settlement.problems.join(', ')}.` };
}

export function readRoundReceipt(requestId, roundId, storage = globalThis.localStorage) {
  if (!requestId) return null;
  try {
    const data = JSON.parse(storage.getItem(`noir:prebet:v1:${requestId}`));
    if (!data || data.expected?.requestId !== requestId || (data.roundId != null && data.roundId !== roundId)) return null;
    return Object.freeze(data.expected);
  } catch { return null; }
}

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(str) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return bufToHex(digest);
}

async function hmacSha256Bytes(keyStr, msgStr) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(keyStr),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msgStr));
  return new Uint8Array(sig);
}

async function deriveOutcome(serverSeed, clientSeed, nonce, max) {
  const limit = Math.floor(0xffffffff / max) * max;
  let counter = 0;
  for (;;) {
    const bytes = await hmacSha256Bytes(serverSeed, `${clientSeed}:${nonce}:${counter}`);
    const value = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
    if (value < limit) return value % max;
    counter += 1;
  }
}

// The pocket a spin lands on for these inputs (same derivation the verifier uses). Used to show what
// a refused spin would have landed on once its lock has been opened: clientSeed is the full
// `${luckyWord}:${clientEntropy}` that was sent.
export async function pocketFor({ serverSeed, clientSeed, nonce, max = 37 }) {
  if (typeof serverSeed !== 'string' || !serverSeed || typeof clientSeed !== 'string' || !Number.isSafeInteger(nonce) || nonce < 0) throw new Error('missing inputs');
  return deriveOutcome(serverSeed, clientSeed, nonce, max);
}

// A settled round from GET /api/rounds checked on its own: the key fits the lock, the lucky word +
// random value add up to the seed used, and the key gives the recorded pocket.
export async function verifyRevealedRound(round, max = 37) {
  try {
    if (!round || typeof round.server_seed !== 'string' || !/^[a-f0-9]{64}$/.test(round.server_seed_hash || '')) return { ok: false, reason: 'missing key' };
    if (await sha256Hex(round.server_seed) !== round.server_seed_hash) return { ok: false, reason: 'key does not fit the lock' };
    if (round.client_seed_base != null && round.client_entropy != null && round.client_seed !== `${round.client_seed_base}:${round.client_entropy}`) return { ok: false, reason: 'inputs differ' };
    let pocket;
    try { pocket = JSON.parse(round.outcome_json || 'null')?.pocket; } catch { pocket = undefined; }
    if (!Number.isInteger(pocket) || pocket < 0 || pocket >= max || !Number.isSafeInteger(round.nonce)) return { ok: false, reason: 'missing pocket' };
    const outcome = await deriveOutcome(round.server_seed, String(round.client_seed), round.nonce, max);
    return outcome === pocket ? { ok: true, pocket } : { ok: false, reason: 'pocket differs', pocket, outcome };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// The exact intermediate values behind a pocket, so a player can repeat the
// calculation with any independent HMAC-SHA256 tool and a calculator:
// HMAC(key = server seed, message = "clientSeed:nonce:counter") → first 8 hex
// characters → decimal → (if below the fairness limit) remainder after ÷ max.
export async function explainOutcome({ serverSeed, clientSeed, nonce, max = 37 }) {
  const limit = Math.floor(0xffffffff / max) * max;
  for (let counter = 0; ; counter++) {
    const message = `${clientSeed}:${nonce}:${counter}`;
    const hmacHex = bufToHex(await hmacSha256Bytes(serverSeed, message));
    const first8 = hmacHex.slice(0, 8), value = parseInt(first8, 16);
    if (value < limit) return { message, hmacHex, first8, value, limit, counter, max, pocket: value % max };
  }
}

// Runs entirely client-side. Returns the same shape the old server endpoint
// did, so callers didn't need to change, but every byte of the check now
// happens in the verifier's own browser.
export async function verifyOutcomeClientSide({ serverSeed, serverSeedHash, clientSeed, nonce, max = 37, pocket, requestId, expected }) {
  const commitmentRecorded = !!expected && /^[a-f0-9]{64}$/.test(expected.serverSeedHash)
    && typeof expected.clientSeed === 'string' && expected.clientSeed.length > 0
    && Number.isSafeInteger(expected.nonce) && expected.nonce >= 0
    && typeof expected.requestId === 'string' && expected.requestId.length > 0;
  const recomputedHash = await sha256Hex(serverSeed);
  // Never promote response self-consistency into proof of an earlier promise.
  const hashMatches = recomputedHash === (commitmentRecorded ? expected.serverSeedHash : serverSeedHash);
  const inputsMatch = commitmentRecorded && serverSeedHash === expected.serverSeedHash
    && clientSeed === expected.clientSeed && nonce === expected.nonce && requestId === expected.requestId;
  const outcome = await deriveOutcome(serverSeed, commitmentRecorded ? expected.clientSeed : clientSeed,
    commitmentRecorded ? expected.nonce : nonce, max);
  const outcomeMatches = Number.isInteger(pocket) && pocket >= 0 && pocket < max && outcome === pocket;
  const ok = commitmentRecorded && hashMatches && inputsMatch && outcomeMatches;
  return { ok, commitmentRecorded, hashMatches, inputsMatch, outcomeMatches, outcome, recomputedHash,
    status: !commitmentRecorded ? 'unrecorded' : ok ? 'verified' : 'mismatch' };
}

// A standalone Node.js one-liner a technically-inclined player can run on
// their own machine — fully independent of this site's frontend code too,
// for players who don't want to trust our JavaScript either.
export function standaloneVerifyScript() {
  // Data is downloaded separately as JSON, never interpolated into shell/code.
  return 'node verify-roulette.mjs round-proof.json';
}

// ---- the reveal path, shared by roulette and the slot ----
// Swaps a lock for a fresh one through POST /api/fairness/rotate: the server shows the old key, this
// browser checks it fits the old lock (sha256(key) == lock), remembers the retired fingerprint so the
// lock can never come back, and only accepts the new lock when it is fresh (same lucky word, nonce 0,
// never revealed). Used by "Get a new lock", after a refused spin and after a lost reply.
// Returns { ok, commitment, retired, fits, problem?, error? }; `problem` means "stop betting".
export const RETIRED_KEY_MISFIT_MESSAGE = 'The old key the server revealed does not fit the old lock. Betting is stopped. Inspect the proof before continuing.';
export const RETIRED_LOCK_NOT_FRESH_MESSAGE = 'The new lock from the server is not a fresh lock. Betting is stopped. Inspect the proof before continuing.';
export async function revealAndRetireLock(expectedCommitment, { fetchFn = globalThis.fetch, storage = globalThis.localStorage, apiBase = '/api' } = {}) {
  const resp = await fetchFn(`${apiBase}/fairness/rotate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedCommitment }),
  });
  let data = {};
  try { data = await resp.json(); } catch { data = {}; }
  if (!resp.ok || !isCommitmentValid(data.commitment)) return { ok: false, error: data.error || 'A new lock could not be made.' };
  const fits = typeof data.retired?.serverSeed === 'string' && await sha256Hex(data.retired.serverSeed) === expectedCommitment.serverSeedHash
    && data.retired.serverSeedHash === expectedCommitment.serverSeedHash;
  if (/^[a-f0-9]{64}$/.test(data.retired?.serverSeedHash || '')) { try { rememberRevealedSeed(data.retired.serverSeedHash, storage); } catch { /* storage full: the server never reuses a seed */ } }
  let revealed = []; try { revealed = readRevealedHashes(storage); } catch { revealed = []; }
  const fresh = isNextCommitmentSafe(data.commitment, { serverSeedHash: expectedCommitment.serverSeedHash, clientSeedBase: expectedCommitment.clientSeed }, revealed);
  if (!fits) return { ok: false, problem: RETIRED_KEY_MISFIT_MESSAGE, retired: data.retired, fits };
  if (!fresh) return { ok: false, problem: RETIRED_LOCK_NOT_FRESH_MESSAGE, retired: data.retired, fits };
  return { ok: true, commitment: Object.freeze({ ...data.commitment }), retired: data.retired, fits };
}

// GET /api/rounds: the player's recent settled rounds with their fairness fields.
export async function fetchPlayerRounds({ fetchFn = globalThis.fetch, apiBase = '/api' } = {}) {
  const r = await fetchFn(`${apiBase}/rounds`);
  if (!r.ok) throw new Error('The round history could not be loaded.');
  const rows = await r.json();
  return Array.isArray(rows) ? rows : [];
}
