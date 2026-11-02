// Mirrors backend/src/games/roulette.js's payout rules, for DISPLAY purposes
// only (e.g. showing "+$X" on a winning chip the instant a spin settles).
// The backend remains the sole source of truth for actual money movement —
// this never touches balance, it only decides what to show on the felt.
const RED_NUMBERS = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

const NUMBERS_BET_TYPES = {
  straight: 1,
  split: 2,
  trio: 3,
  street: 3,
  corner: 4,
  sixline: 6,
};

export function pocketColor(n) {
  if (n === 0) return 'green';
  return RED_NUMBERS.has(n) ? 'red' : 'black';
}

// Returns the total-return multiplier for a bet against a given pocket
// (0 means it lost). Same 36/numbersCovered rule as the backend.
export function multiplierFor(bet, pocket) {
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
    case 'low':
      return pocket >= 1 && pocket <= 18 ? 2 : 0;
    case 'high':
      return pocket >= 19 && pocket <= 36 ? 2 : 0;
    case 'dozen1':
      return pocket >= 1 && pocket <= 12 ? 3 : 0;
    case 'dozen2':
      return pocket >= 13 && pocket <= 24 ? 3 : 0;
    case 'dozen3':
      return pocket >= 25 && pocket <= 36 ? 3 : 0;
    case 'column1':
      return pocket !== 0 && pocket % 3 === 1 ? 3 : 0;
    case 'column2':
      return pocket !== 0 && pocket % 3 === 2 ? 3 : 0;
    case 'column3':
      return pocket !== 0 && pocket % 3 === 0 ? 3 : 0;
    default:
      return 0;
  }
}

export function didBetWin(bet, pocket) {
  return multiplierFor(bet, pocket) > 0;
}

// The live payout table chosen in the admin panel (total return per unit,
// stake included). Until the config arrives the standard table applies.
let payoutTable = null;
// Only a table that passes checkPayoutTable is used; anything else falls back to standard for display.
export function setPayoutTable(multipliers) {
  const check = multipliers ? checkPayoutTable({ multipliers }) : null;
  payoutTable = check?.ok ? { ...check.multipliers } : null;
  return check ? check.ok : true;
}

export function payoutCentsFor(bet, pocket) {
  const standard = multiplierFor(bet, pocket);
  if (!standard) return 0;
  return payoutTable && payoutTable[bet.type] ? Math.floor(bet.amountCents * payoutTable[bet.type]) : Math.round(bet.amountCents * standard);
}

// The exact pocket numbers a bet covers — [] for outside bets (red/black/
// dozens/etc, which don't map to a small fixed set worth drawing as chips).
export function coveredNumbers(bet) {
  const { type, value } = bet;
  if (type === 'straight') return [value];
  if (['split', 'trio', 'street', 'corner', 'sixline'].includes(type)) {
    return [...value].sort((a, b) => a - b);
  }
  return [];
}

const OUTSIDE_LABELS = {
  red: 'RED', black: 'BLACK', odd: 'ODD', even: 'EVEN', low: '1 to 18', high: '19 to 36',
  dozen1: '1st 12', dozen2: '2nd 12', dozen3: '3rd 12',
  column1: 'Column', column2: 'Column', column3: 'Column',
};

// Human-readable description of what a bet covers, for the close-up
// reveal popup — e.g. "Straight on 20", "Split 17 & 20", "RED".
export function betLabel(bet) {
  const { type, value } = bet;
  if (type === 'straight') return `Straight on ${value}`;
  if (type === 'split') return `Split ${[...value].sort((a, b) => a - b).join(' & ')}`;
  if (type === 'trio' || type === 'street') return `Street ${[...value].sort((a, b) => a - b).join(' · ')}`;
  if (type === 'corner') return `Corner ${[...value].sort((a, b) => a - b).join(' · ')}`;
  if (type === 'sixline') return `Six Line ${[...value].sort((a, b) => a - b).join(' · ')}`;
  return OUTSIDE_LABELS[type] || type;
}

// Standard European payout table (total return per unit staked), used for the settlement check
// until the live table from the admin panel has loaded.
export const STANDARD_MULTIPLIERS = Object.freeze({ straight: 36, split: 18, trio: 12, street: 12, corner: 9, sixline: 6,
  red: 2, black: 2, odd: 2, even: 2, low: 2, high: 2, dozen1: 3, dozen2: 3, dozen3: 3, column1: 3, column2: 3, column3: 3 });

// Checks a payout table from the server before it is used. Every multiplier must be a positive
// whole number for a known bet type and never ABOVE the standard table (a higher table is not a
// gift, it means the reply is wrong). Missing types fall back to standard. A table LOWER than
// standard is valid but the player must confirm it once before betting.
// Returns { ok, reason, lower, multipliers, key }.
const MATH_ID = /^[a-z0-9_-]{1,40}$/i;
export function checkPayoutTable(math) {
  if (math == null) return { ok: true, lower: false, multipliers: { ...STANDARD_MULTIPLIERS }, key: 'standard', differences: [] };
  if (typeof math !== 'object') return { ok: false, reason: 'payout table missing' };
  const id = math.id ?? null;
  if (id !== null && (typeof id !== 'string' || !MATH_ID.test(id))) return { ok: false, reason: 'payout table name is invalid' };
  const table = math.multipliers;
  if (table == null) return id && id !== 'standard' ? { ok: false, reason: 'payout table missing' } : { ok: true, lower: false, multipliers: { ...STANDARD_MULTIPLIERS }, key: 'standard', differences: [] };
  if (typeof table !== 'object' || Array.isArray(table)) return { ok: false, reason: 'payout table missing' };
  const merged = { ...STANDARD_MULTIPLIERS };
  for (const [type, value] of Object.entries(table)) {
    if (!(type in STANDARD_MULTIPLIERS)) return { ok: false, reason: `unknown bet type ${type}` };
    if (!Number.isSafeInteger(value) || value <= 0) return { ok: false, reason: `${type} pays an invalid amount` };
    if (value > STANDARD_MULTIPLIERS[type]) return { ok: false, reason: `${type} pays more than the standard table` };
    merged[type] = value;
  }
  const differences = Object.keys(STANDARD_MULTIPLIERS).filter((t) => merged[t] !== STANDARD_MULTIPLIERS[t])
    .map((t) => ({ type: t, multiplier: merged[t], standard: STANDARD_MULTIPLIERS[t] }));
  const lower = differences.length > 0;
  // A table called "standard" must be the standard table.
  if (lower && id === 'standard') return { ok: false, reason: 'the standard table was changed' };
  const key = `${id || 'custom'}:${Object.keys(STANDARD_MULTIPLIERS).map((t) => merged[t]).join(',')}`;
  return { ok: true, lower, multipliers: merged, key, differences };
}

// The lower tables this player has accepted, remembered per exact table (localStorage, validated).
const CONFIRMED_KEY = 'betics:payout-confirmed:v1';
const TABLE_KEY = /^[a-z0-9_-]{1,40}:\d{1,3}(,\d{1,3}){17}$/i;
export function readConfirmedTables(storage = globalThis.localStorage) {
  try {
    const list = JSON.parse(storage?.getItem(CONFIRMED_KEY) || '[]');
    return Array.isArray(list) ? list.filter((k) => typeof k === 'string' && TABLE_KEY.test(k)) : [];
  } catch { return []; }
}
export function isTableConfirmed(key, storage = globalThis.localStorage) { return readConfirmedTables(storage).includes(key); }
export function confirmTable(key, storage = globalThis.localStorage) {
  if (typeof key !== 'string' || !TABLE_KEY.test(key)) return readConfirmedTables(storage);
  const list = [...new Set([...readConfirmedTables(storage), key])].slice(-20);
  try { storage?.setItem(CONFIRMED_KEY, JSON.stringify(list)); } catch { /* private mode: confirm again next visit */ }
  return list;
}
// Plain words for a lower table, e.g. "Straight up pays 34 to 1 (standard 35 to 1)".
const TYPE_NAMES = { straight: 'Straight up', split: 'Split', trio: 'Trio', street: 'Street', corner: 'Corner', sixline: 'Six line',
  red: 'Red', black: 'Black', odd: 'Odd', even: 'Even', low: '1 to 18', high: '19 to 36',
  dozen1: '1st 12', dozen2: '2nd 12', dozen3: '3rd 12', column1: 'Column 1', column2: 'Column 2', column3: 'Column 3' };
export function describeTableDifferences(differences = []) {
  return differences.map((d) => `${TYPE_NAMES[d.type] || d.type} pays ${d.multiplier - 1} to 1 (standard ${d.standard - 1} to 1)`);
}

// Biggest total payout (stake included) these bets could get on any pocket, with the live table.
export function maxPayoutUnits(bets) {
  let worst = 0;
  for (let pocket = 0; pocket <= 36; pocket++) {
    let total = 0;
    for (const bet of bets) total += payoutCentsFor(bet, pocket);
    if (total > worst) worst = total;
  }
  return worst;
}
export function straightMultiplier() { return (payoutTable && payoutTable.straight) || 36; }
