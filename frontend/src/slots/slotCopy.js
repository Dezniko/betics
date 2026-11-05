// Every word the slot page shows, built from the published maths so the paytable can never disagree
// with the engine. Pure, no DOM. Player copy rules: plain words, no emoji, no dashes, amounts as $TICS,
// brand qu-BETICS, never "guaranteed", "trustless" or "fully provably fair".
import { SLOT_MATH, symbolName } from '../../../backend/src/games/slotsMath.js';
import { fmtMoney } from '../chips.js';

export const GAME_NAME = 'Gods of Power';
const n = (v) => Number(v).toLocaleString('en-US');

// Pay table rows for the CURRENT bet: pays in $TICS for 3, 4 and 5 of a symbol on a line.
export function paytableRows(stake, math = SLOT_MATH) {
  const lineBet = stake / math.lineCount;
  return math.symbols.filter((s) => s.role !== 'scatter').map((s) => {
    const p = math.pays[s.code] || {};
    return { code: s.code, name: s.name, role: s.role || null,
      pays: [3, 4, 5].map((k) => ({ count: k, multiple: p[k] ?? 0, units: (p[k] ?? 0) * lineBet })) };
  });
}
// Scatter row: pays in total bets, anywhere on the reels.
export function scatterRow(stake, math = SLOT_MATH) {
  const s = math.symbols.find((x) => x.role === 'scatter');
  return { code: s.code, name: s.name, role: 'scatter',
    pays: [3, 4, 5].map((k) => ({ count: k, multiple: math.scatterPays[k] ?? 0, units: (math.scatterPays[k] ?? 0) * stake })) };
}

export function paytableCopy(math = SLOT_MATH) {
  const fs = math.freeSpins;
  const wild = math.symbols.find((s) => s.role === 'wild'), scat = math.symbols.find((s) => s.role === 'scatter');
  return {
    title: `${GAME_NAME} pays`,
    betLine: (stake) => `Bet ${fmtMoney(stake)}, that is ${fmtMoney(stake / math.lineCount)} on each of the ${math.lineCount} lines.`,
    linesRule: `Wins pay from the left reel, ${math.reels} reels, ${math.rows} rows, ${math.lineCount} lines, 3 or more matching symbols on a line. Only the best win on each line is paid.`,
    wildRule: `The ${wild.name.toLowerCase()} stands in for every symbol except the ${scat.name.toLowerCase()}.`,
    scatterRule: `The ${scat.name.toLowerCase()} pays anywhere on the reels, in total bets.`,
    freeSpinsRule: `${n(3)}, ${n(4)} or ${n(5)} ${scat.name.toLowerCase()}s start ${fs.award[3]}, ${fs.award[4]} or ${fs.award[5]} free spins. During free spins ${n(3)}, ${n(4)} or ${n(5)} ${scat.name.toLowerCase()}s add ${fs.retrigger[3]}, ${fs.retrigger[4]} or ${fs.retrigger[5]} more. Every win in free spins is doubled. At most ${fs.maxSpins} free spins in one round.`,
    payback: `Payback ${Number(math.rtp).toFixed(1)}%`,
    paybackNote: 'Over a very large number of spins the game pays back this share of all bets. Any single spin can win or lose much more.',
    cap: `One round pays at most ${n(math.capMultiplier)} times the bet.`,
    capNote: 'A round is the spin you paid for plus every free spin it started. When the cap is reached the round ends there.',
    rulesTitle: 'How to play',
    rules: [
      `Pick your bet with the minus and plus buttons. The bet is split over the ${math.lineCount} lines, so each line gets one twentieth of it.`,
      'Press Spin, or the space bar. The reels stop from left to right.',
      `A line wins when 3 or more matching symbols sit on it, starting from the left reel. Only the best win on each line is paid, and all line wins are added up.`,
      `${wild.name} is wild and the top paying symbol: it stands in for every symbol except the ${scat.name.toLowerCase()}, and five in a row pay the most of any line.`,
      `The ${scat.name.toLowerCase()} pays anywhere on the reels and starts free spins. ${n(3)}, ${n(4)} or ${n(5)} of them give ${fs.award[3]}, ${fs.award[4]} or ${fs.award[5]} free spins; more ${scat.name.toLowerCase()}s during free spins add ${fs.retrigger[3]}, ${fs.retrigger[4]} or ${fs.retrigger[5]}. Free spin wins are doubled. At most ${fs.maxSpins} free spins in one round.`,
      `One round pays at most ${n(math.capMultiplier)} times the bet.`,
      'Auto plays spin after spin. It stops on a free spin round, a message from the table, or when the balance is short.',
      'Tap the reels to skip the animation and see the result at once.',
      'Every round is locked before you bet and checked in this browser after it. Open Fairness to see the check and the codes.',
      `The biggest bet allowed changes with the casino reserve: a bet is only offered when the casino can pay its highest possible win.`,
    ],
    linesTitle: `The ${math.lineCount} lines`,
    symbolsTitle: 'Symbols',
    close: 'Done',
  };
}

export function fairnessCopy() {
  return {
    title: 'Was it fair?',
    fairVerdict: 'This round was fair',
    badVerdict: 'This round does not check out',
    badNote: 'Play is paused. Reload the page to go on.',
    noRound: 'Spin once and the check of that round appears here.',
    locked: ['Locked', 'before you bet'],
    spin: ['You spin', 'adds your luck'],
    opened: ['Opened', 'gives these reels'],
    sentence: 'The reel stops were locked before you bet. After the spin the lock was opened, and this browser replayed the round from the key and got the same reels and the same payout.',
    check: 'Check it yourself',
    checkNote: 'These are the codes of this round. Paste them into any checker you trust, or run the offline verifier with the round data.',
    keyLabel: 'Key (shown after the spin)',
    lockLabel: 'Lock (shown before you bet)',
    luckyLabel: 'Your lucky word and randomness',
    nonceLabel: 'Round number',
    stopsLabel: 'Reel stops',
    verifier: 'Offline verifier',
    roundData: 'Round data',
    copy: 'Copy',
    copied: 'Copied',
    close: 'Done',
  };
}

export const PAGE_COPY = Object.freeze({
  subtitle: 'GODS OF POWER',
  spin: 'Spin',
  spinning: 'Spinning',
  auto: 'Auto',
  autoOn: 'Stop',
  paytable: 'Rules',
  fairness: 'Fairness',
  nextLock: 'Next lock',
  bet: 'Bet',
  freeSpins: (left) => `Free spins: ${left} left`,
  doubled: 'x2',
  freeIntro: (count) => `${count} free spins`,
  freeIntroSub: 'Every win doubled',
  retrigger: (added) => `${added} more free spins`,
  total: 'Round total',
  capped: 'Round cap reached',
  roulette: 'Roulette',
  verificationFailed: 'This round could not be checked against the lock. Play is paused. Reload the page to go on.',
  lostReply: 'The connection dropped before the spin was confirmed. Reload the page to see whether it was played.',
  noLock: 'The lock for your next spin could not be loaded. Please reload the page.',
  autoStoppedBalance: 'Auto spin stopped: the balance is below the bet.',
  autoStoppedFree: 'Auto spin stopped for the free spins.',
  tableChanged: 'The pay table changed. Please check it and spin again.',
  gameClosed: 'This game is having a short break. Please check back soon.',
  realUnavailable: 'Connect a wallet to play with real $TICS.',
});

// Every piece of player copy, flattened, so a test can scan it for banned words and characters.
export function allPlayerCopy(stake = 2000) {
  const pt = paytableCopy(), fc = fairnessCopy();
  const strings = [];
  const take = (v) => { if (typeof v === 'string') strings.push(v); else if (typeof v === 'function') strings.push(String(v(stake))); else if (Array.isArray(v)) v.forEach(take); };
  Object.values(pt).forEach(take); Object.values(fc).forEach(take); Object.values(PAGE_COPY).forEach(take);
  paytableRows(stake).forEach((r) => strings.push(r.name));
  strings.push(scatterRow(stake).name);
  SLOT_MATH.symbols.forEach((s) => strings.push(symbolName(s.code)));
  return strings;
}
