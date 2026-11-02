// Chip denominations in units of 0.01 TICS (the *Cents fields) and their casino-style colours. Every
// denomination has its own colour so a player can read a stack at a glance.
export const DENOMS = [
  { cents: 100, label: '1', name: '1 $TICS', base: '#d4d4d8', edge: '#52525b', text: '#18181b' },
  { cents: 500, label: '5', name: '5 $TICS', base: '#ea580c', edge: '#ffedd5', text: '#ffffff' },
  { cents: 1000, label: '10', name: '10 $TICS', base: '#7e22ce', edge: '#f5e9ff', text: '#ffffff' },
  { cents: 5000, label: '50', name: '50 $TICS', base: '#f4f1e8', edge: '#2563eb', text: '#1b1b1b' },
  { cents: 10000, label: '100', name: '100 $TICS', base: '#dc2626', edge: '#fde8e8', text: '#ffffff' },
  { cents: 50000, label: '500', name: '500 $TICS', base: '#2563eb', edge: '#e6efff', text: '#ffffff' },
  { cents: 100000, label: '1K', name: '1K $TICS', base: '#15803d', edge: '#e4f7ea', text: '#ffffff' },
  { cents: 500000, label: '5K', name: '5K $TICS', base: '#18181b', edge: '#d4af37', text: '#f3d98b' },
];

export const CHIP_VALUES = DENOMS.map((d) => d.cents);

const BY_CENTS = Object.fromEntries(DENOMS.map((d) => [d.cents, d]));

export function denomFor(cents) {
  return BY_CENTS[cents] || DENOMS[0];
}

// Splits an arbitrary amount (e.g. a payout of 1,750 TICS) into the fewest real
// chips, biggest first — what a dealer would push across the felt.
export function decompose(cents, maxChips = 12) {
  const out = [];
  let left = Math.round(cents);
  for (let i = DENOMS.length - 1; i >= 0 && left > 0; i--) {
    const d = DENOMS[i].cents;
    while (left >= d && out.length < maxChips) {
      out.push(d);
      left -= d;
    }
  }
  return out;
}

const group = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
// Amounts are integers of 0.01 TICS. Always two decimals: 1,234.50 TICS
export function fmtTics(units, { decimals = 2 } = {}) {
  const neg = units < 0, abs = Math.abs(Math.round(units));
  const whole = Math.floor(abs / 100), frac = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}${group(whole)}${decimals ? `.${frac}` : ''} $TICS`;
}
export const fmtMoney = (units) => fmtTics(units);

// Short form for tags and history: 1,250 TICS, 12.50 TICS
export function fmtShort(units) {
  return Math.round(units) % 100 === 0 ? fmtTics(units, { decimals: 0 }) : fmtTics(units);
}

// Compact amount for felt labels: 540, 12.50, 12.5K, 1.25M (no currency word)
export function fmtCompact(units) {
  const t = Math.round(units) / 100;
  const trim = (v, d) => { const s = v.toFixed(d); return s.includes('.') ? s.replace(/\.?0+$/, '') : s; };
  if (t >= 1e6) return `${trim(t / 1e6, 2)}M`;
  if (t >= 1e4) return `${trim(t / 1e3, t >= 1e5 ? 0 : 1)}K`;
  return Number.isInteger(t) ? group(t) : t.toFixed(2);
}

// Felt payout label: '+540 TICS', '+12.5K TICS'
export const fmtFelt = (units) => `+${fmtCompact(units)} $TICS`;

// Compact amount for a chip face / tight spots: 0.5, 2.5, 17.5, 120, 1.2K
export function faceLabel(units) {
  const d = Math.round(units) / 100;
  if (d >= 1000) return `${(d / 1000).toFixed(d >= 10000 ? 0 : 1).replace(/\.0$/, '')}K`;
  return Number.isInteger(d) ? String(d) : d.toFixed(2).replace(/0$/, '');
}

// Greedy denomination groups retain the exact amount without allocating huge arrays.
export function chipGroups(cents) {
  let left = Math.max(0, Math.round(cents));
  const groups = [];
  for (let i = DENOMS.length - 1; i >= 0; i--) {
    const d = DENOMS[i].cents;
    const count = Math.floor(left / d);
    if (count) { groups.push({ cents: d, count }); left -= count * d; }
  }
  return groups;
}

// Biggest chips sit below the remainder. Only the upper layers need rendering;
// the original placement array stays untouched so Undo still removes one action.
export function consolidatedLayers(chips, maxLayers = 3) {
  const total = Array.isArray(chips) ? chips.reduce((sum, c) => sum + c, 0) : chips;
  const groups = chipGroups(total), topFirst = [];
  for (let i = groups.length - 1; i >= 0 && topFirst.length < maxLayers; i--) {
    const copies = Math.min(groups[i].count, maxLayers - topFirst.length);
    for (let n = 0; n < copies; n++) topFirst.push(groups[i].cents);
  }
  return topFirst.reverse();
}

// Biggest denomination among a set of chips (legacy helper).
export function topDenom(chips) {
  return chips.reduce((m, c) => (c > m ? c : m), 0);
}

// The table limit for one spin (the game's max bet set in the admin panel).
// Returns a plain message when adding `addCents` would go over it, else null.
export function overMaxBet(currentCents, addCents, maxStakeCents) {
  if (!Number.isSafeInteger(maxStakeCents) || maxStakeCents <= 0) return null;
  return currentCents + addCents > maxStakeCents ? `The most you can bet on one spin is ${fmtMoney(maxStakeCents)}.` : null;
}
