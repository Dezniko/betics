// The slot's round history for the profile sheet: /api/rounds rows turned back into the shape the
// browser verifier checks, with the pre-bet receipt this browser saved (when it still has it).
import { readSlotReceipt } from './slotsApi.js';
import { verifySlotRound } from './slotsVerify.js';

export const SLOT_GAME = 'godsofpower';

// A /api/rounds row of the slot -> the spin reply shape verifySlotRound expects. Null for other games
// or rows without an outcome.
export function slotRoundFromRow(row) {
  if (!row || row.game !== SLOT_GAME || !row.outcome_json) return null;
  let outcome;
  try { outcome = typeof row.outcome_json === 'string' ? JSON.parse(row.outcome_json) : row.outcome_json; } catch { return null; }
  if (!outcome || !Array.isArray(outcome.spins)) return null;
  const clientSeedBase = row.client_seed_base ?? null, clientEntropy = row.client_entropy ?? null;
  return {
    roundId: row.id, requestId: row.request_id ?? null, at: row.created_at || null,
    mode: row.real_money ? 'real' : 'demo', mathId: row.math_id ?? null,
    stake: row.stake_cents, totalPayoutCents: row.payout_cents || 0,
    spins: outcome.spins, freeSpinsAwarded: outcome.freeSpinsAwarded || 0, freeSpinsPlayed: outcome.freeSpinsPlayed || 0, capped: !!outcome.capped,
    fairness: { serverSeed: row.server_seed, serverSeedHash: row.server_seed_hash, clientSeed: row.client_seed, clientSeedBase, clientEntropy, nonce: row.nonce },
  };
}

// The rows the History tab lists, newest first.
export function slotHistoryRows(rows, limit = 15) {
  return (Array.isArray(rows) ? rows : []).map(slotRoundFromRow).filter(Boolean).slice(0, limit);
}

// Checks one listed round in this browser: the saved receipt (if any) plus the full recomputation.
// `receipt: false` says this browser never saw the bet (another device, or the receipt was pruned), so
// only the reveal itself is checked: the missing-receipt note is not a failure then.
export const NO_RECEIPT = 'No pre-bet receipt was saved for this spin.';
export async function checkSlotHistoryRound(round, { read = readSlotReceipt, verify = verifySlotRound } = {}) {
  const saved = round.requestId ? read(round.requestId) : null;
  // A history row has no ending balance, so the balance pinned in the receipt is not part of this check.
  const receipt = saved ? withoutSlotBalance(saved) : null;
  const verdict = await verify(receipt || null, round);
  const problems = (verdict.problems || []).filter((p) => receipt || p !== NO_RECEIPT);
  return { ok: problems.length === 0, problems, receipt: !!receipt };
}
export function withoutSlotBalance(receipt) {
  if (!receipt) return receipt;
  const { balanceBefore: _unused, ...rest } = receipt;
  return rest;
}
