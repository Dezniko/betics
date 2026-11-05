// Gods of Power: published maths. Five reels, three rows, 20 lines, wild (W), scatter (S) and free spins.
// Payback 92.0% (scripts/slots-rtp.mjs prints the exact figure from these strips and pays).
// Pays are whole multiples of the line bet (stake / 20); scatter pays are multiples of the total bet.
// Every number here is public: the Worker, the browser verifier and the RTP calculator read this file.

export const BET_LEVELS = Object.freeze([2000, 4000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000]);

export const SYMBOLS = Object.freeze([
  { code: 'W', name: 'Gods of Power', role: 'wild' },
  { code: 'S', name: 'Vault door', role: 'scatter' },
  { code: 'D', name: 'Qubetics' },
  { code: 'B', name: 'Gold bar' },
  { code: 'R', name: 'Ruby' },
  { code: 'C', name: 'Coins' },
  { code: 'A', name: 'A' },
  { code: 'K', name: 'K' },
  { code: 'Q', name: 'Q' },
  { code: 'J', name: 'J' },
]);

export const LINES = Object.freeze([
  [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2], [0, 1, 2, 1, 0], [2, 1, 0, 1, 2],
  [0, 0, 1, 2, 2], [2, 2, 1, 0, 0], [1, 0, 0, 0, 1], [1, 2, 2, 2, 1], [0, 1, 1, 1, 0],
  [2, 1, 1, 1, 2], [1, 0, 1, 2, 1], [1, 2, 1, 0, 1], [0, 1, 0, 1, 0], [2, 1, 2, 1, 2],
  [1, 1, 0, 1, 1], [1, 1, 2, 1, 1], [0, 0, 2, 0, 0], [2, 2, 0, 2, 2], [0, 2, 2, 2, 0],
].map((l) => Object.freeze(l)));

// Reel strips (32 stops each). Built by scripts/slots-build-strips.mjs from these symbol counts:
// reel 1: S1 D2 B3 R4 C5 A5 K5 Q3 J4 (no wild on reel 1); reels 2 to 5: W3 S1 D2 B2 or 3 R3 C4 A4 K4 or 5 Q4 J4.
const STRIPS = Object.freeze([
  Object.freeze(['A', 'K', 'K', 'C', 'R', 'B', 'Q', 'J', 'D', 'A', 'C', 'A', 'R', 'J', 'K', 'K', 'S', 'B', 'Q', 'C', 'R', 'J', 'C', 'A', 'D', 'A', 'K', 'B', 'Q', 'R', 'J', 'C']),
  Object.freeze(['K', 'Q', 'J', 'J', 'C', 'W', 'B', 'R', 'D', 'A', 'K', 'Q', 'C', 'A', 'K', 'Q', 'S', 'W', 'B', 'R', 'C', 'A', 'K', 'Q', 'D', 'J', 'J', 'W', 'B', 'R', 'C', 'A']),
  Object.freeze(['J', 'K', 'K', 'K', 'C', 'W', 'R', 'A', 'D', 'B', 'Q', 'J', 'C', 'A', 'Q', 'J', 'S', 'W', 'R', 'K', 'C', 'A', 'Q', 'J', 'D', 'B', 'K', 'W', 'R', 'C', 'A', 'Q']),
  Object.freeze(['J', 'K', 'K', 'K', 'C', 'W', 'R', 'A', 'D', 'B', 'Q', 'J', 'C', 'A', 'Q', 'J', 'S', 'W', 'R', 'K', 'C', 'A', 'Q', 'J', 'D', 'B', 'K', 'W', 'R', 'C', 'A', 'Q']),
  Object.freeze(['J', 'K', 'K', 'K', 'C', 'W', 'R', 'A', 'D', 'B', 'Q', 'J', 'C', 'A', 'Q', 'J', 'S', 'W', 'R', 'K', 'C', 'A', 'Q', 'J', 'D', 'B', 'K', 'W', 'R', 'C', 'A', 'Q']),
]);

// Line pays in line bets for 3, 4 and 5 in a row from the left.
const PAYS = Object.freeze({
  W: Object.freeze({ 3: 50, 4: 250, 5: 1000 }),
  D: Object.freeze({ 3: 30, 4: 150, 5: 600 }),
  B: Object.freeze({ 3: 20, 4: 100, 5: 400 }),
  R: Object.freeze({ 3: 15, 4: 60, 5: 250 }),
  C: Object.freeze({ 3: 10, 4: 40, 5: 150 }),
  A: Object.freeze({ 3: 5, 4: 30, 5: 100 }),
  K: Object.freeze({ 3: 4, 4: 25, 5: 80 }),
  Q: Object.freeze({ 3: 3, 4: 20, 5: 55 }),
  J: Object.freeze({ 3: 2, 4: 12, 5: 50 }),
});
// Scatter pays in total bets for 3, 4 and 5 vault doors anywhere.
const SCATTER_PAYS = Object.freeze({ 3: 2, 4: 10, 5: 50 });

export const SLOT_MATH = Object.freeze({
  id: 'gods92',
  label: 'Gods of Power 92',
  rtp: 92,
  reels: 5,
  rows: 3,
  stops: 32,
  lineCount: 20,
  betLevels: BET_LEVELS,
  symbols: SYMBOLS,
  lines: LINES,
  strips: STRIPS,
  pays: PAYS,
  scatterPays: SCATTER_PAYS,
  freeSpins: Object.freeze({ award: Object.freeze({ 3: 10, 4: 15, 5: 20 }), retrigger: Object.freeze({ 3: 5, 4: 8, 5: 10 }), maxSpins: 50, multiplier: 2 }),
  capMultiplier: 2000,
});

export function symbolName(code) { return SYMBOLS.find((s) => s.code === code)?.name || code; }
