// Gods of Power: the request a spin sends, the pre-bet receipt saved BEFORE posting, and the bet
// level rules the page enforces (the same ones the server enforces). Pure, no DOM, no React.
import { SLOT_MATH, BET_LEVELS } from '../../../backend/src/games/slotsMath.js';
import { maxPayoutUnits } from '../../../backend/src/games/slots.js';
import { fmtMoney } from '../chips.js';
import { isCommitmentValid, readRevealedHashes } from '../fairnessClient.js';

export const SLOT_API = '/api/games/godsofpower';
export const RECEIPT_PREFIX = 'betics:slot-receipt:';
export const RECEIPT_INDEX = 'betics:slot-receipt:index:v1';
export const MAX_SLOT_RECEIPTS = 200;

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

// The request for one round. The browser's 32 random bytes are generated ONLY after the server's
// lock (commitment) is known, so neither side can pick its value knowing the other's.
export function createSlotRequest(commitment, stake, mode = 'demo', {
  random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
  uuid = () => globalThis.crypto.randomUUID(),
  revealed = null,
  math = SLOT_MATH,
  balanceBefore = null, // the settled balance shown when the spin is sent (pinned in the receipt, checked against balanceAfterCents)
} = {}) {
  if (!isCommitmentValid(commitment)) throw new Error('A valid pre-bet lock is required.');
  if (!math.betLevels.includes(stake)) throw new Error('Please pick one of the bet amounts shown.');
  if (mode !== 'demo' && mode !== 'real') throw new Error('mode must be demo or real');
  const seen = revealed || (typeof localStorage !== 'undefined' ? safeRevealed() : []);
  if (seen.includes(commitment.serverSeedHash)) throw new Error('This lock was already opened.');
  const agreed = Object.freeze({ serverSeedHash: commitment.serverSeedHash, clientSeed: commitment.clientSeed, nonce: commitment.nonce });
  const clientEntropy = hex(random(32));
  const requestId = uuid();
  const receipt = Object.freeze({ requestId, serverSeedHash: agreed.serverSeedHash, clientSeedBase: agreed.clientSeed, clientEntropy, nonce: agreed.nonce,
    stake, mode, mathId: math.id, balanceBefore: Number.isSafeInteger(balanceBefore) && balanceBefore >= 0 ? balanceBefore : null, at: Date.now() });
  return { receipt, body: { stake, requestId, expectedCommitment: agreed, clientEntropy, mode, mathId: math.id } };
}
function safeRevealed() { try { return readRevealedHashes(localStorage); } catch { return []; } }

function readIndex(storage) {
  try { const i = JSON.parse(storage.getItem(RECEIPT_INDEX) || '[]'); return Array.isArray(i) ? i.filter((k) => typeof k === 'string') : []; } catch { return []; }
}
// Saves the receipt and keeps only the newest MAX_SLOT_RECEIPTS. Throws when it cannot be saved
// (the spin must not be sent without its receipt).
export function saveSlotReceipt(receipt, storage = globalThis.localStorage) {
  const key = `${RECEIPT_PREFIX}${receipt.requestId}`;
  const data = JSON.stringify(receipt);
  const write = () => { storage.setItem(key, data); return storage.getItem(key) === data; };
  let index = readIndex(storage).filter((k) => k !== key);
  index.push(key);
  while (index.length > MAX_SLOT_RECEIPTS) { const old = index.shift(); try { storage.removeItem(old); } catch { /* ignore */ } }
  let ok = false;
  try { ok = write(); } catch { ok = false; }
  if (!ok) { // storage full: drop the older half and try once more
    const drop = index.slice(0, Math.ceil(index.length / 2)).filter((k) => k !== key);
    for (const k of drop) { try { storage.removeItem(k); } catch { /* ignore */ } }
    index = index.filter((k) => !drop.includes(k));
    try { ok = write(); } catch { ok = false; }
  }
  if (!ok) throw new Error('The pre-bet receipt could not be saved, so the spin was not sent.');
  try { storage.setItem(RECEIPT_INDEX, JSON.stringify(index)); } catch { /* best effort */ }
  return key;
}
export function readSlotReceipt(requestId, storage = globalThis.localStorage) {
  try { const raw = storage.getItem(`${RECEIPT_PREFIX}${requestId}`); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
export function countSlotReceipts(storage = globalThis.localStorage) { return readIndex(storage).length; }

// The same sentence the server sends for the table limit: one figure, the biggest bet level allowed.
export function slotTableLimitMessage(maxWinUnits, math = SLOT_MATH) {
  const allowed = math.betLevels.filter((b) => maxPayoutUnits(b, math) <= maxWinUnits);
  if (!allowed.length) return 'The casino wallet cannot cover a round at the smallest bet right now. Please try again later.';
  return `The most you can bet on one spin right now is ${fmtMoney(allowed[allowed.length - 1])}.`;
}
export const NOT_ENOUGH_BALANCE_MESSAGE = 'Not enough balance for that bet.';

// Every bet level with whether it may be played now and, if not, the one-line reason shown on tap.
// tableLimit = the live max win (reserve.maxWinUnits); a level is allowed only when cap x level fits it.
export function betLevelStates({ levels = BET_LEVELS, tableLimit = null, balance = null, minStakeCents = null, maxStakeCents = null, math = SLOT_MATH } = {}) {
  return levels.map((stake) => {
    let reason = null;
    if (Number.isSafeInteger(tableLimit) && tableLimit > 0 && maxPayoutUnits(stake, math) > tableLimit) reason = slotTableLimitMessage(tableLimit, math);
    else if (Number.isSafeInteger(maxStakeCents) && maxStakeCents > 0 && stake > maxStakeCents) reason = `The bet can be at most ${fmtMoney(maxStakeCents)}.`;
    else if (Number.isSafeInteger(minStakeCents) && stake < minStakeCents) reason = `The bet must be at least ${fmtMoney(minStakeCents)}.`;
    else if (Number.isSafeInteger(balance) && stake > balance) reason = NOT_ENOUGH_BALANCE_MESSAGE;
    return { stake, allowed: reason === null, reason };
  });
}
// The level to show selected: the current one when allowed, else the biggest allowed one below it,
// else the smallest allowed one, else the current one (greyed).
export function pickBetLevel(states, current) {
  const cur = states.find((s) => s.stake === current);
  if (cur?.allowed) return current;
  const below = states.filter((s) => s.allowed && s.stake < current);
  if (below.length) return below[below.length - 1].stake;
  const any = states.find((s) => s.allowed);
  return any ? any.stake : current;
}
// Next level up or down from `current` (null when there is none).
export function stepBetLevel(levels, current, dir) {
  const i = levels.indexOf(current);
  const j = i < 0 ? (dir > 0 ? 0 : levels.length - 1) : i + dir;
  return j >= 0 && j < levels.length ? levels[j] : null;
}

// Short bet label for the stepper: 20 $TICS, 1,000 $TICS (whole amounts carry no decimals).
export const fmtBet = (units) => (units % 100 === 0 ? `${Math.round(units / 100).toLocaleString('en-US')} $TICS` : fmtMoney(units));

// Balance shown while a round is in flight: the settled balance minus the stake already committed.
export const balanceDuringSpin = (balanceCents, stake) => (balanceCents == null ? null : balanceCents - stake);

// Auto spin stops on its own in these cases (the player can always stop it by hand).
export function autoShouldStop({ error = false, verified = true, freeSpins = 0, balance = 0, stake = 0 }) {
  if (error) return 'error';
  if (!verified) return 'verification';
  if (freeSpins > 0) return 'free_spins';
  if (balance < stake) return 'balance';
  return null;
}
