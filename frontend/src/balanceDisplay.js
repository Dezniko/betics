// Balance shown to the player. Chips merely placed on the table are shown
// separately ("On table") and do NOT reduce the balance; the stake is only
// deducted once Spin commits it, until the server's settled balance lands.
export function displayedBalanceCents({ balanceCents, committedStakeCents = 0, overrideCents = null }) {
  if (overrideCents != null) return overrideCents;
  if (balanceCents == null) return null;
  return balanceCents - committedStakeCents;
}

// Chips that stay on the table for the next round must be fully covered by
// the balance; otherwise the table is cleared rather than left unplayable.
export const tableFitsBalance = (stakeCents, balanceCents) => stakeCents <= balanceCents;
