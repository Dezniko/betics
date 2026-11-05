// Gods of Power slot engine. Pure and synchronous: the Worker, the browser verifier and the RTP
// calculator all run this same code, so a result can be recomputed anywhere from the revealed seed.
//
// Randomness comes in through `uint32At(draw, counter)`: a 32-bit value for draw number `draw`
// (the Worker builds it from HMAC-SHA256(serverSeed, `${clientSeed}:${nonce}:slots:${draw}:${counter}`)).
// A reel stop is that value mod the strip length, with rejection sampling so every stop is equally likely.
// Base spin reels use draws 0 to 4; free spin k (from 1) uses draws 5k to 5k+4.
//
// Money: `stake` is the total bet in units (0.01 $TICS), always a multiple of the line count. Line pays are
// whole multiples of the line bet, scatter pays whole multiples of the total bet, so every payout is an integer.

export const MAX_COUNTERS = 8;

export function drawStop(uint32At, draw, stops) {
  const limit = Math.floor(0xffffffff / stops) * stops;
  for (let counter = 0; counter < MAX_COUNTERS; counter++) {
    const v = uint32At(draw, counter);
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new Error('draw value must be a 32-bit unsigned integer');
    if (v < limit) return v % stops;
  }
  throw new Error('draw ran out of counters');
}

// grid[row][reel]: the symbol shown at each position when reel `reel` stops at index stops[reel].
export function gridFor(stops, math) {
  const rows = [];
  for (let r = 0; r < math.rows; r++) rows.push(stops.map((s, reel) => math.strips[reel][(s + r) % math.stops]));
  return rows;
}

// Line wins pay left to right from reel 1. Wild (W) stands in for every symbol except the scatter (S).
// A line of wilds is scored both as wilds and as the first real symbol; the better pay counts once.
export function evaluateGrid(grid, math) {
  const lineWins = [];
  let linePay = 0;
  math.lines.forEach((line, li) => {
    const syms = line.map((row, reel) => grid[row][reel]);
    const candidates = new Set();
    if (math.pays.W) candidates.add('W');
    const first = syms.find((s) => s !== 'W');
    if (first && first !== 'S') candidates.add(first);
    let best = null;
    for (const target of candidates) {
      let n = 0;
      while (n < syms.length && (syms[n] === target || (target !== 'W' && syms[n] === 'W'))) n++;
      const pay = math.pays[target]?.[n] ?? 0;
      if (n >= 3 && pay > 0 && (!best || pay > best.pay)) best = { line: li, symbol: target, count: n, pay };
    }
    if (best) { lineWins.push(best); linePay += best.pay; }
  });
  let scatterCount = 0;
  for (const row of grid) for (const s of row) if (s === 'S') scatterCount++;
  const scatterPay = scatterCount >= 3 ? (math.scatterPays[Math.min(scatterCount, 5)] ?? 0) : 0;
  return { lineWins, linePay, scatterCount, scatterPay };
}

// The most one round can pay in total, stake included. The round stops at this figure.
export function maxPayoutUnits(stake, math) { return stake * math.capMultiplier; }

export function validStake(stake, math) {
  return Number.isSafeInteger(stake) && stake > 0 && stake % math.lineCount === 0 && (!math.betLevels || math.betLevels.includes(stake));
}

export function playRound({ stake, uint32At, math }) {
  if (!validStake(stake, math)) throw new Error('invalid stake');
  const lineBet = stake / math.lineCount;
  const cap = maxPayoutUnits(stake, math);
  const fs = math.freeSpins;
  const spins = [];
  let total = 0, capped = false, freeLeft = 0, freeAwarded = 0, freePlayed = 0, draw = 0;
  const play = (free) => {
    const stops = [];
    for (let r = 0; r < math.reels; r++) stops.push(drawStop(uint32At, draw + r, math.stops));
    draw += math.reels;
    const grid = gridFor(stops, math);
    const ev = evaluateGrid(grid, math);
    const multiplier = free ? fs.multiplier : 1;
    let win = (ev.linePay * lineBet + ev.scatterPay * stake) * multiplier;
    if (total + win >= cap) { win = cap - total; capped = true; }
    total += win;
    const table = free ? fs.retrigger : fs.award;
    const added = ev.scatterCount >= 3 ? (table[Math.min(ev.scatterCount, 5)] ?? 0) : 0;
    spins.push({ index: spins.length, free, stops, grid, lineWins: ev.lineWins, scatterCount: ev.scatterCount,
      scatterPay: ev.scatterPay, multiplier, winUnits: win, freeSpinsAdded: added });
    return added;
  };
  freeLeft = play(false);
  freeAwarded = freeLeft;
  while (!capped && freeLeft > 0 && freePlayed < fs.maxSpins) {
    freeLeft -= 1; freePlayed += 1;
    const more = play(true);
    const room = fs.maxSpins - freePlayed - freeLeft;
    const added = Math.max(0, Math.min(more, room));
    spins[spins.length - 1].freeSpinsAdded = added;
    freeLeft += added; freeAwarded += added;
  }
  return { stake, spins, freeSpinsAwarded: freeAwarded, freeSpinsPlayed: freePlayed, capped, totalPayoutUnits: total };
}

// Compact summary used in the browser and the admin: what a round showed and paid.
export function roundSummary(round) {
  return { stake: round.stake, spins: round.spins.length, freeSpins: round.freeSpinsPlayed, payout: round.totalPayoutUnits, capped: round.capped };
}
