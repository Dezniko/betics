// The downloadable round proof for Gods of Power, in the flat shape frontend/public/verify-slots.mjs
// reads: the spin reply itself plus `expected`, the terms this browser saved BEFORE the bet (lock, lucky
// word, randomness, round number, stake, mode, maths table). Pure, so tests feed the exact file the
// page writes through the generated verifier.
export const SLOT_PROOF_VERSION = 'slots-1';

// receipt -> the `expected` block of a proof (null when this browser has no receipt for the round).
export function slotExpectedFromReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') return null;
  const { serverSeedHash, clientSeedBase, clientEntropy, nonce, stake, mode, mathId } = receipt;
  return { serverSeedHash, clientSeedBase, clientEntropy, nonce, stake, mode, mathId };
}

// The whole file: { ...round, expected, version }. Nothing from the receipt other than the terms (no
// local timestamps, no balance) goes into the proof.
export function buildSlotProof(round, receipt) {
  if (!round || typeof round !== 'object') throw new Error('No round to export.');
  const { expected: _ignored, version: _v, ...rest } = round;
  const expected = slotExpectedFromReceipt(receipt);
  return { ...rest, ...(expected ? { expected } : {}), version: SLOT_PROOF_VERSION };
}

export function slotProofFileName(round) {
  return `gods-of-power-round-${round?.roundId || 'last'}.json`;
}
