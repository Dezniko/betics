// European roulette bet resolution — original implementation, informed by
// the bet-type patterns in Townsy45/simply-roulette and the provably-fair
// roulette strategy in matthewlilley/provably-fair-framework, but no code
// copied verbatim. Payout table verified against standard casino rules
// (Wizard of Odds / Casino.org): straight 35:1, split 17:1, street 11:1,
// corner 8:1, six-line 5:1, dozen/column 2:1, even-money 1:1 — every
// "numbers" bet (straight/split/street/corner/six-line/trio) follows the
// same rule: total-return multiplier = 36 / numbersCovered.
import { STANDARD } from './rouletteMath.js';

export const POCKET_COUNT = 37; // European wheel: 0-36

const RED_NUMBERS = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

export function pocketColor(n) {
  if (n === 0) return 'green';
  return RED_NUMBERS.has(n) ? 'red' : 'black';
}

const NUMBERS_BET_TYPES = {
  straight: 1,
  split: 2,
  trio: 3,
  street: 3,
  corner: 4,
  sixline: 6,
};

// Throws if a bet is malformed for its declared type — e.g. a client
// claiming a 'corner' payout (4 numbers) while only supplying 2. This is
// a server-side integrity check: payout correctness must never depend on
// the client sending an honest bet shape.
export function validateBet(bet) {
  if (!bet || typeof bet !== 'object') throw new Error('bet must be an object');
  if (!Number.isInteger(bet.amountCents) || bet.amountCents <= 0) {
    throw new Error('amountCents must be a positive integer');
  }

  if (bet.type in NUMBERS_BET_TYPES) {
    const expectedCount = NUMBERS_BET_TYPES[bet.type];
    const nums = bet.type === 'straight' ? [bet.value] : bet.value;
    if (!Array.isArray(nums) || nums.length !== expectedCount) {
      throw new Error(`bet type '${bet.type}' requires exactly ${expectedCount} number(s)`);
    }
    const unique = new Set(nums);
    if (unique.size !== nums.length) throw new Error('duplicate numbers in bet');
    for (const n of nums) {
      if (!Number.isInteger(n) || n < 0 || n > 36) throw new Error(`invalid pocket number: ${n}`);
    }
    const sorted = [...nums].sort((a, b) => a - b);
    const [a, b] = sorted;
    const consecutive = sorted.every((n, i) => n === a + i);
    let adjacent = true;
    switch (bet.type) {
      case 'split':
        adjacent = a === 0 ? b >= 1 && b <= 3
          : b - a === 3 || (b - a === 1 && Math.floor((a - 1) / 3) === Math.floor((b - 1) / 3));
        break;
      case 'street':
      case 'sixline':
        adjacent = a > 0 && a % 3 === 1 && consecutive;
        break;
      case 'trio':
        adjacent = a === 0 && ((b === 1 && sorted[2] === 2) || (b === 2 && sorted[2] === 3));
        break;
      case 'corner':
        adjacent = a > 0 && a % 3 !== 0 && b === a + 1 && sorted[2] === a + 3 && sorted[3] === a + 4;
        break;
    }
    if (!adjacent) throw new Error(`bet type '${bet.type}' requires physical table adjacency`);
    return;
  }

  const OUTSIDE_TYPES = new Set([
    'red', 'black', 'odd', 'even', 'low', 'high', 'dozen1', 'dozen2', 'dozen3',
    'column1', 'column2', 'column3',
  ]);
  if (!OUTSIDE_TYPES.has(bet.type)) {
    throw new Error(`unknown bet type: ${bet.type}`);
  }
}

// A bet is { type, value, amountCents }. For 'straight', value is a single
// number; for split/trio/street/corner/sixline, value is an array of the
// numbers it covers. Returns the total-return multiplier (0 means loss).
export function resolveBet(bet, pocket) {
  if (bet.type in NUMBERS_BET_TYPES) {
    const nums = bet.type === 'straight' ? [bet.value] : bet.value;
    return nums.includes(pocket) ? 36 / nums.length : 0;
  }

  switch (bet.type) {
    case 'red':
      return pocketColor(pocket) === 'red' ? 2 : 0;
    case 'black':
      return pocketColor(pocket) === 'black' ? 2 : 0;
    case 'odd':
      return pocket !== 0 && pocket % 2 === 1 ? 2 : 0;
    case 'even':
      return pocket !== 0 && pocket % 2 === 0 ? 2 : 0;
    case 'low': // 1-18
      return pocket >= 1 && pocket <= 18 ? 2 : 0;
    case 'high': // 19-36
      return pocket >= 19 && pocket <= 36 ? 2 : 0;
    case 'dozen1': // 1-12
      return pocket >= 1 && pocket <= 12 ? 3 : 0;
    case 'dozen2': // 13-24
      return pocket >= 13 && pocket <= 24 ? 3 : 0;
    case 'dozen3': // 25-36
      return pocket >= 25 && pocket <= 36 ? 3 : 0;
    case 'column1': // numbers where n % 3 === 1
      return pocket !== 0 && pocket % 3 === 1 ? 3 : 0;
    case 'column2': // n % 3 === 2
      return pocket !== 0 && pocket % 3 === 2 ? 3 : 0;
    case 'column3': // n % 3 === 0 (and not 0 itself)
      return pocket !== 0 && pocket % 3 === 0 ? 3 : 0;
    default:
      throw new Error(`unknown bet type: ${bet.type}`);
  }
}

// Whole cents only, rounded down so a fractional table never overpays.
export function payoutCentsFor(bet, pocket, option = STANDARD) {
  if (resolveBet(bet, pocket) === 0) return 0;
  return Math.floor(bet.amountCents * option.multipliers[bet.type]);
}

// The most the house could pay out on these bets, over every possible pocket.
export function maxPayoutCents(bets, option = STANDARD) {
  let worst = 0;
  for (let pocket = 0; pocket < POCKET_COUNT; pocket++) {
    let total = 0;
    for (const bet of bets) total += payoutCentsFor(bet, pocket, option);
    if (total > worst) worst = total;
  }
  return worst;
}
