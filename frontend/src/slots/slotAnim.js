// Gods of Power presentation timeline. Pure: turns a finished round (the server reply, already
// verified) into ordered steps with start times, so the reels, sounds and banners all follow one clock.
// Nothing here touches the DOM; Reels.jsx and SlotsApp.jsx play the steps back.
import { SLOT_MATH } from '../../../backend/src/games/slotsMath.js';
import { winTier, celebrationTiming } from '../winCelebration.js';

export const TIMING = Object.freeze({
  spinMs: 900,            // reels turn this long before the first one stops
  staggerMs: 220,         // reel stops left to right, this far apart
  anticipationFactor: 2.5, // remaining reels take longer once two vault doors are down
  lineMs: 350,            // one winning line traced
  lineTotalCapMs: 2800,   // all lines of one spin together never take longer than this
  scatterWinMs: 600,      // the vault doors light up together
  vaultMs: 1400,          // vault door swing before the first free spin
  retriggerMs: 700,       // extra free spins flash
  betweenSpinsMs: 250,    // pause before the next free spin starts turning
  totalMs: 1600,          // final banner after a round with free spins
  settleMs: 200,          // small pause at the end before controls return
});

// How many vault doors (scatters) a reel column shows.
const scattersIn = (grid, reel) => grid.reduce((n, row) => n + (row[reel] === 'S' ? 1 : 0), 0);

// buildTimeline(round, { turbo, pace }) -> { steps, totalMs, tier }
// turbo halves the reel times; pace (0..1) scales the win beats (auto spin uses 0.4 like roulette).
export function buildTimeline(round, { turbo = false, pace = 1, math = SLOT_MATH, timing = TIMING } = {}) {
  const reelScale = turbo ? 0.5 : 1;
  const winScale = Math.max(0.1, pace);
  const T = (ms) => Math.round(ms * reelScale);
  const W = (ms) => Math.round(ms * winScale);
  const steps = [];
  let t = 0;
  const push = (step) => { steps.push(step); return step; };
  const spins = Array.isArray(round?.spins) ? round.spins : [];
  const stake = round?.stake || 0;

  spins.forEach((spin, si) => {
    const prev = spins[si - 1];
    // Free spin intro before the first free spin, retrigger flash after a free spin that added more.
    if (si > 0 && !prev.free && spin.free) {
      push({ type: 'free-intro', at: t, duration: T(timing.vaultMs), spin: si, spinsAwarded: round.freeSpinsAwarded || prev.freeSpinsAdded || 0 });
      t += T(timing.vaultMs);
    } else if (si > 0) {
      t += T(timing.betweenSpinsMs);
    }
    // freeLeft = free spins still to come after this one (the last free spin shows 0 left).
    push({ type: 'spin-start', at: t, spin: si, free: !!spin.free, freeLeft: spin.free ? Math.max(0, freeLeftBefore(spins, si) - 1) : 0 });
    // Reel stops left to right. Once two vault doors are down and reels remain, the rest slow down.
    let stopAt = t + T(timing.spinMs);
    let seen = 0, anticipating = false;
    for (let reel = 0; reel < math.reels; reel++) {
      if (reel > 0) stopAt += T(timing.staggerMs * (anticipating ? timing.anticipationFactor : 1));
      const landed = scattersIn(spin.grid, reel);
      push({ type: 'reel-stop', at: stopAt, spin: si, reel, anticipation: anticipating });
      if (landed) {
        for (let k = 0; k < landed; k++) { seen += 1; push({ type: 'scatter', at: stopAt, spin: si, reel, count: seen }); }
      }
      if (!anticipating && seen >= 2 && reel < math.reels - 1) {
        anticipating = true;
        push({ type: 'anticipation', at: stopAt, spin: si, fromReel: reel + 1 });
      }
    }
    if (anticipating) push({ type: 'anticipation-end', at: stopAt, spin: si });
    t = stopAt;
    // Wins of this spin: lines in line order, then the vault doors, then the amount counting up.
    const lines = [...(spin.lineWins || [])].sort((a, b) => a.line - b.line);
    if (lines.length) {
      const each = Math.min(W(timing.lineMs), Math.floor(W(timing.lineTotalCapMs) / lines.length));
      lines.forEach((lw, i) => {
        const pay = lw.pay * (stake / math.lineCount) * (spin.multiplier || 1);
        push({ type: 'line-win', at: t + i * each, duration: each, spin: si, line: lw.line, symbol: lw.symbol, count: lw.count, pay, tier: winTier(pay, stake).id });
      });
      t += each * lines.length;
    }
    if (spin.scatterPay > 0) {
      push({ type: 'scatter-win', at: t, duration: W(timing.scatterWinMs), spin: si, count: spin.scatterCount, pay: spin.scatterPay * stake * (spin.multiplier || 1) });
      t += W(timing.scatterWinMs);
    }
    if (spin.winUnits > 0) {
      const tier = winTier(spin.winUnits, stake);
      const countMs = celebrationTiming(tier, winScale).countMs;
      push({ type: 'count-up', at: t, duration: countMs, spin: si, amount: spin.winUnits, tier: tier.id, multiplier: spin.multiplier || 1 });
      t += countMs;
    }
    if (spin.freeSpinsAdded > 0 && spin.free) {
      push({ type: 'retrigger', at: t, duration: T(timing.retriggerMs), spin: si, added: spin.freeSpinsAdded });
      t += T(timing.retriggerMs);
    }
  });
  const total = round?.totalPayoutCents ?? round?.totalPayoutUnits ?? 0;
  const tier = total > 0 ? winTier(total, stake) : null;
  if (spins.length > 1 && total > 0) {
    push({ type: 'total', at: t, duration: W(timing.totalMs), amount: total, tier: tier.id, freeSpins: round.freeSpinsPlayed || 0, capped: !!round.capped });
    t += W(timing.totalMs);
  }
  t += timing.settleMs;
  push({ type: 'done', at: t });
  return { steps, totalMs: t, tier: tier ? tier.id : null };
}

// Free spins still to play when spin `si` starts (the counter shown in the corner).
export function freeLeftBefore(spins, si) {
  let left = 0;
  for (let i = 0; i < si; i++) {
    const s = spins[i];
    if (!s.free) left += s.freeSpinsAdded || 0;
    else { left -= 1; left += s.freeSpinsAdded || 0; }
  }
  return Math.max(0, left); // the spin starting now still counts in "left"
}

// Reel stop times of one spin, for tests and the skip logic.
export function reelStopTimes(timeline, spin = 0) {
  return timeline.steps.filter((s) => s.type === 'reel-stop' && s.spin === spin).map((s) => s.at);
}

// The grid cells of one pay line (row per reel), for the SVG polyline and the glow.
export function lineCells(lineIndex, math = SLOT_MATH) {
  return math.lines[lineIndex].map((row, reel) => ({ reel, row }));
}
// SVG points for a pay line over a 5 x 3 grid drawn in a 500 x 300 box.
export function linePoints(lineIndex, math = SLOT_MATH, cell = 100) {
  return math.lines[lineIndex].map((row, reel) => `${reel * cell + cell / 2},${row * cell + cell / 2}`).join(' ');
}
// Cells that take part in a win of `count` symbols on `lineIndex` (left to right).
export function winningCells(lineIndex, count, math = SLOT_MATH) {
  return lineCells(lineIndex, math).slice(0, count);
}
