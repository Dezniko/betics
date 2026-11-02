// Published roulette maths options. Each one is a fixed payout table that the
// admin can choose per game; outcomes are never steered, so the provably fair
// proof is unchanged. Multipliers are TOTAL return per unit staked (stake
// included): a 35 to 1 straight up is 36.
const COVERED = { straight: 1, split: 2, trio: 3, street: 3, corner: 4, sixline: 6,
  red: 18, black: 18, odd: 18, even: 18, low: 18, high: 18,
  dozen1: 12, dozen2: 12, dozen3: 12, column1: 12, column2: 12, column3: 12 };

const STANDARD_MULT = { straight: 36, split: 18, trio: 12, street: 12, corner: 9, sixline: 6,
  red: 2, black: 2, odd: 2, even: 2, low: 2, high: 2,
  dozen1: 3, dozen2: 3, dozen3: 3, column1: 3, column2: 3, column3: 3 };

export const ROULETTE_MATH = Object.freeze({
  standard: Object.freeze({ id: 'standard', label: 'Standard European', multipliers: Object.freeze({ ...STANDARD_MULT }) }),
  straight34: Object.freeze({ id: 'straight34', label: 'Straight up 34 to 1', multipliers: Object.freeze({ ...STANDARD_MULT, straight: 35 }) }),
});
export const STANDARD = ROULETTE_MATH.standard;

export function mathOption(id) {
  const option = ROULETTE_MATH[id];
  if (!option) throw new Error(`unknown roulette maths option: ${id}`);
  return option;
}

const round2 = x => Math.round(x * 100) / 100;
// Payback per bet type = multiplier x numbers covered / 37 pockets.
export function rtpByBet(option) {
  return Object.fromEntries(Object.entries(option.multipliers).map(([type, m]) => [type, round2(m * COVERED[type] / 37 * 100)]));
}
export function rtpRange(option) {
  const values = Object.values(rtpByBet(option));
  return { min: Math.min(...values), max: Math.max(...values) };
}
