// Tuning helper: tries compositions and pays, prints exact RTP. Run with node; edit candidates below.
import { analyse, simulate } from './slots-rtp.mjs';
import { buildStrip } from './slots-build-strips.mjs';
import { LINES, BET_LEVELS } from '../backend/src/games/slotsMath.js';

const base = { reels: 5, rows: 3, stops: 32, lineCount: 20, betLevels: BET_LEVELS, lines: LINES,
  freeSpins: { award: { 3: 10, 4: 15, 5: 20 }, retrigger: { 3: 5, 4: 8, 5: 10 }, maxSpins: 50, multiplier: 2 }, capMultiplier: 2000 };

export function makeMath(comp, pays, scatterPays) {
  return { ...base, strips: comp.map((c) => buildStrip(c)), pays, scatterPays };
}

// Exploration CLI lived here during tuning; the final figures are in backend/src/games/slotsMath.js.
