// Pure helpers for the win celebration so tiers/timing are testable.
export const WIN_TIERS = [
  { id: 'mega', min: 30, label: 'MEGA WIN', count: 2100, particles: 40 },
  { id: 'big', min: 10, label: 'BIG WIN', count: 1600, particles: 30 },
  { id: 'nice', min: 2, label: 'NICE WIN', count: 1200, particles: 20 },
  { id: 'win', min: 0, label: 'WINNER', count: 900, particles: 14 },
];

// Tier by payout relative to the total stake (a 36 TICS straight-up return on 1 TICS is a big win).
export function winTier(payoutCents, stakeCents) {
  const multiple = stakeCents > 0 ? payoutCents / stakeCents : 0;
  return WIN_TIERS.find(t => multiple >= t.min) || WIN_TIERS.at(-1);
}

export const FLY_MS = 950;

// Timing for one celebration; autoplay runs the same beats faster.
export function celebrationTiming(tier, pace = 1) {
  return { countMs: Math.round(tier.count * pace), flyMs: Math.round(FLY_MS * pace) };
}

// Fewer moving elements on small screens keeps phones at full frame rate.
export function particleBudget(tier, { mobile = false, reducedMotion = false } = {}) {
  if (reducedMotion) return { coins: 0, flyingChips: 4 };
  return {
    coins: mobile ? Math.min(24, Math.round(tier.particles * 0.6)) : tier.particles,
    flyingChips: mobile ? 12 : 20,
  };
}

// Ease-out count so the number races up then lands with weight.
export const countEase = t => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
