// Exact RTP of the Gods of Power maths, plus a Monte Carlo check of the payout cap.
//
//   node scripts/slots-rtp.mjs            exact figures for the published maths
//   node scripts/slots-rtp.mjs --sim N    also play N random rounds (cap, hit rate, max win)
//
// Exact method. A reel stop is uniform over the strip, so the symbol a line sees on reel i is the
// symbol count on that strip over the strip length, independently per reel. Line pay is enumerated over
// every 5-symbol combination weighted by those counts (the same for all 20 lines). Scatter count per reel
// is the histogram of scatters in the 3 visible rows over every stop; the five reels are convolved.
// Free spins: dynamic programming over (spins left, spins played) with retriggers and the 50 spin limit.
// The 2,000x cap is measured by simulation, since it couples all spins of a round.
import { randomInt } from 'node:crypto';
import { evaluateGrid, playRound } from '../backend/src/games/slots.js';
import { SLOT_MATH } from '../backend/src/games/slotsMath.js';

export function analyse(math) {
  const stops = math.stops, reels = math.reels;
  const counts = math.strips.map((strip) => { const c = {}; for (const s of strip) c[s] = (c[s] || 0) + 1; return c; });
  const codes = [...new Set(math.strips.flat())];
  // Expected line pay (in line bets) for one line: enumerate symbol combinations.
  let linePay = 0;
  const walk = (reel, syms, weight) => {
    if (reel === reels) {
      const grid = [syms, syms, syms];
      const ev = evaluateGrid(grid, { ...math, lines: [[0, 0, 0, 0, 0]] });
      linePay += ev.linePay * weight;
      return;
    }
    for (const code of codes) { const n = counts[reel][code] || 0; if (n) walk(reel + 1, [...syms, code], weight * n / stops); }
  };
  walk(0, [], 1);
  // Scatter distribution.
  let dist = [1];
  for (let reel = 0; reel < reels; reel++) {
    const hist = Array(math.rows + 1).fill(0);
    for (let s = 0; s < stops; s++) { let k = 0; for (let r = 0; r < math.rows; r++) if (math.strips[reel][(s + r) % stops] === 'S') k++; hist[k] += 1 / stops; }
    const next = Array(dist.length + math.rows).fill(0);
    dist.forEach((p, i) => hist.forEach((q, k) => { next[i + k] += p * q; }));
    dist = next;
  }
  const pS = (k) => dist.slice(k).reduce((a, b) => a + b, 0);
  const scatterPay = [3, 4, 5].reduce((t, k) => t + (dist[k] || 0) * (math.scatterPays[k] || 0), 0) + (dist.slice(6).reduce((a, b) => a + b, 0)) * (math.scatterPays[5] || 0);
  // One line's expected pay is in line bets; 20 lines x (line bet = stake / 20) gives the same figure in total bets.
  const base = linePay + scatterPay;
  // Free spins DP.
  const fs = math.freeSpins, N = fs.maxSpins;
  const meanFree = base * fs.multiplier;
  const pk = (k) => (k < 5 ? dist[k] || 0 : dist.slice(5).reduce((a, b) => a + b, 0));
  const V = Array.from({ length: N + 2 }, () => Array(N + 2).fill(0));
  for (let played = N - 1; played >= 0; played--) {
    for (let left = 1; left <= N; left++) {
      let v = meanFree;
      for (let k = 0; k <= 5; k++) {
        const p = pk(k); if (!p) continue;
        const add = k >= 3 ? (fs.retrigger[k] || 0) : 0;
        const nl = Math.min(left - 1 + add, N - played - 1);
        v += p * (nl > 0 ? V[nl][played + 1] : 0);
      }
      V[left][played] = v;
    }
  }
  let freeValue = 0;
  for (let k = 3; k <= 5; k++) freeValue += pk(k) * V[Math.min(fs.award[k], N)][0];
  const trigger = pS(3);
  return { base, scatterPay, linePerLine: linePay, freeValue, exact: base + freeValue, triggerOneIn: 1 / trigger, dist };
}

export function simulate(math, rounds, uint32Factory = () => (() => randomInt(0, 0x100000000))) {
  let paid = 0, staked = 0, hits = 0, capped = 0, maxWin = 0, free = 0;
  const stake = math.lineCount * 100;
  for (let i = 0; i < rounds; i++) {
    const r = playRound({ stake, uint32At: uint32Factory(), math });
    paid += r.totalPayoutUnits; staked += stake;
    if (r.totalPayoutUnits > 0) hits++;
    if (r.capped) capped++;
    if (r.freeSpinsPlayed) free++;
    maxWin = Math.max(maxWin, r.totalPayoutUnits / stake);
  }
  return { rtp: paid / staked, hitRate: hits / rounds, cappedRate: capped / rounds, maxWinX: maxWin, freeOneIn: rounds / Math.max(1, free) };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const a = analyse(SLOT_MATH);
  const pct = (x) => (x * 100).toFixed(3) + '%';
  console.log(`base ${pct(a.base)}  (lines ${pct(a.base - a.scatterPay)}, scatter ${pct(a.scatterPay)})`);
  console.log(`free spins ${pct(a.freeValue)}  trigger 1 in ${a.triggerOneIn.toFixed(1)}`);
  console.log(`exact RTP ${pct(a.exact)}`);
  const i = process.argv.indexOf('--sim');
  if (i > 0) {
    const n = Number(process.argv[i + 1] || 1e6);
    const s = simulate(SLOT_MATH, n);
    console.log(`simulated ${n} rounds: RTP ${pct(s.rtp)} hit rate ${pct(s.hitRate)} capped ${pct(s.cappedRate)} max win ${s.maxWinX}x free 1 in ${s.freeOneIn.toFixed(1)}`);
  }
}
