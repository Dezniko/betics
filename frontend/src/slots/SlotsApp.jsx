import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { SLOT_MATH, BET_LEVELS } from '../../../backend/src/games/slotsMath.js';
import { gridFor } from '../../../backend/src/games/slots.js';
import GameToast, { toastTitle } from '../GameToast.jsx';
import GameHeader from '../GameHeader.jsx';
import ProfileSheet from '../ProfileSheet.jsx';
import { useInbox } from '../Inbox.jsx';
import ConnectNotice from '../ConnectNotice.jsx';
import { AgeGate } from '../Terms.jsx';
import WinCelebration from '../WinCelebration.jsx';
import { useCasinoReserve } from '../CasinoReserve.jsx';
import { fmtMoney, fmtTics } from '../chips.js';
import { headerLayout } from '../headerModel.js';
import { displayedBalanceCents } from '../balanceDisplay.js';
import { isCommitmentValid, isNextCommitmentSafe, readRevealedHashes, rememberRevealedSeed, revealAndRetireLock, fetchPlayerRounds, verifyRevealedRound } from '../fairnessClient.js';
import { postJsonWithTimeout, classifySpinRefusal, budgetFor, recordRefusal, refusalStopMessage, refusalRetiredMessage, rememberOpenLock, updateOpenLock, forgetOpenLock, findOpenLock, findRoundForLock,
  locksToCheck, mustRetireLock, retireWaitMs, canAcceptReloadedLock, ownRoundProblems, noteSpinPosted, OPEN_LOCK_GRACE_MS,
  addRefusedSlotSpin, slotWouldHaveText, otherTabSeenRecently, waitForRoundWithLock, OTHER_TAB_MESSAGE, OTHER_TAB_UNSEEN_MESSAGE, SIGN_IN_EXPIRED_MESSAGE,
  LOST_REPLY_MESSAGE, OTHER_DEVICE_MESSAGE, OTHER_DEVICE_ALONE_MESSAGE, OWN_ROUND_SWAPPED_MESSAGE, NEVER_OPENED_MESSAGE,
  LOCK_RECHECK_MESSAGE, LOST_REPLY_RECHECK_MESSAGE, STALE_LOCK_RECHECK_MESSAGE, LOCK_CHANGED_MESSAGE, LOCK_IN_FLIGHT_MESSAGE, LOCK_CHECK_GAVE_UP_MESSAGE, EARLIER_ROUND_FAILED_MESSAGE } from '../spinRefusal.js';
import { startPresence, otherTabRecently, otherTabPlayedRecently, notePlay } from '../tabPresence.js';
import { isSignedInElsewhere } from '../walletApi.js';
import { winTier, celebrationTiming, countEase } from '../winCelebration.js';
import { ensureAudioContext } from '../sound.js';
import { verifySlotRound, recomputeSlotRound, sha256Hex } from './slotsVerify.js';
import { slotRoundFromRow, withoutSlotBalance, checkSlotHistoryRound } from './slotHistory.js';
import { SLOT_API, createSlotRequest, saveSlotReceipt, readSlotReceipt, betLevelStates, pickBetLevel, stepBetLevel, fmtBet, autoShouldStop } from './slotsApi.js';
import { buildTimeline, TIMING, winningCells, prefersReducedMotion, motionEffects } from './slotAnim.js';
import { PAGE_COPY as C } from './slotCopy.js';
import Reels from './Reels.jsx';
import SlotPaytable from './SlotPaytable.jsx';
import SlotFairness, { SlotFairnessBody } from './SlotFairness.jsx';
import SlotHistory from './SlotHistory.jsx';
import useSession from '../useSession.js';
import { usePlayGuard, PlayCover } from '../PlayGuard.jsx';
import * as sfx from './slotSound.js';
import './slots.css';

const API = '/api';
const IDLE_STOPS = [3, 11, 7, 19, 27]; // a quiet opening picture before the first spin
const IDLE_GRID = gridFor(IDLE_STOPS, SLOT_MATH);
const ALL_STOPPED = Array(SLOT_MATH.reels).fill('idle');
const BET_KEY = 'betics:slot-bet:v1';
const readStore = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const writeStore = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

function useViewport() {
  const read = () => ({ w: window.innerWidth, h: window.innerHeight });
  const [vp, setVp] = useState(read);
  useEffect(() => { const on = () => setVp(read()); window.addEventListener('resize', on); return () => window.removeEventListener('resize', on); }, []);
  return vp;
}
const Minus = () => <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true"><path d="M6 12h12" /></svg>;
const Plus = () => <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true"><path d="M12 6v12M6 12h12" /></svg>;
const SpinIcon = () => <svg className="slot-spin-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.6-5.9" /><path d="M20 4v5h-5" /></svg>;
const COIN_BURST = Array.from({ length: 14 }, (_, i) => { const a = (-90 + (i - 6.5) * 13) * Math.PI / 180, r = 70 + (i % 3) * 30; return { dx: `${Math.round(Math.cos(a) * r)}px`, dy: `${Math.round(Math.sin(a) * r - 20)}px`, rot: `${(i % 2 ? 1 : -1) * (180 + i * 25)}deg`, t: `${0.8 + (i % 4) * 0.12}s`, delay: `${(i % 5) * 0.04}s` }; });
const COIN_RAIN = Array.from({ length: 20 }, (_, i) => ({ x: `${(i * 23 + 7) % 100}%`, d: `${1.3 + (i % 4) * 0.25}s`, delay: `${-((i * 0.37) % 1.6)}s`, drift: `${(i % 2 ? 1 : -1) * (10 + (i % 3) * 12)}px`, rot: `${(i % 2 ? 1 : -1) * 540}deg` }));

export default function SlotsApp() {
  const vp = useViewport();
  const layout = headerLayout(vp.w, vp.h);
  const desktop = layout === 'desktop';
  const mobile = !desktop;

  const [phase, setPhase] = useState('idle'); // idle | spinning | presenting
  const busy = phase !== 'idle';
  const session = useSession({ busy });
  const { user, profile, mode, modeInfo, balance } = session;
  // One tab at a time: this tab announces its spins; another tab's spin covers the reels for 8 s.
  const guard = usePlayGuard({ game: 'godsofpower', tabId: session.tabId });
  // Heartbeat of this tab (tabPresence): a 409 other_tab is only believed when another tab was really seen.
  useEffect(() => { const p = startPresence(); return () => p.stop(); }, []);

  // Live game settings and the lock for the next round.
  const [config, setConfig] = useState(null);
  const [commitment, setCommitment] = useState(null);
  const commitmentRef = useRef(null); commitmentRef.current = commitment;
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [blocked, setBlocked] = useState(false); // a round failed the fairness check: no more spins until reload
  const blockedRef = useRef(false);
  const loadConfig = useCallback(async () => {
    try { const r = await fetch(`${SLOT_API}/config`); if (r.ok) setConfig(await r.json()); } catch { /* keep the last known */ }
  }, []);
  // The lock is loaded (and the saved open locks reconciled with the round history) by recoverLock, defined with
  // the refusal helpers below; the effect reaches it through a ref so it always runs the latest closure.
  const recoverRef = useRef(null);
  const checkOpenLocksRef = useRef(null);
  const busyRef = useRef(false); busyRef.current = busy;
  const recoverTimerRef = useRef(0);
  const recoveringRef = useRef(false);
  const pendingHashRef = useRef(null); // the lock a failed request left behind, for the next recovery attempt
  const lockErrorRef = useRef(false); // the shown error is a lock recovery message (cleared when recovery succeeds)
  useEffect(() => {
    if (!user) return;
    loadConfig(); recoverRef.current?.();
    const t = setInterval(loadConfig, 30000);
    // Locks another tab may still have been spinning on are looked at once they are old enough.
    const grace = setTimeout(() => { if (!busyRef.current && commitmentRef.current) checkOpenLocksRef.current?.(commitmentRef.current.serverSeedHash).catch(() => {}); }, OPEN_LOCK_GRACE_MS + 1000);
    const onFocus = () => { loadConfig(); if (!commitmentRef.current && !blockedRef.current && !busyRef.current) recoverRef.current?.(pendingHashRef.current); };
    window.addEventListener('focus', onFocus);
    fetch(`${API}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'game_open', game: 'godsofpower', screen: `${window.screen.width}x${window.screen.height}` }) }).catch(() => {});
    return () => { clearInterval(t); clearTimeout(grace); clearTimeout(recoverTimerRef.current); window.removeEventListener('focus', onFocus); };
  }, [session.identity, loadConfig]);
  useEffect(() => { if (session.sessionError) { setError(session.sessionError); session.clearSessionError(); } }, [session.sessionError]); // eslint-disable-line react-hooks/exhaustive-deps
  // The wallet signed in from another browser: the server closed this session. Auto stops, the page is in Demo.
  useEffect(() => { if (session.elsewhere) { autoRef.current = false; setAutoSpin(false); setSheet(null); } }, [session.elsewhere]);
  const gameClosed = config?.enabled === false;

  // Bet level, the table limit and the balance.
  const reserve = useCasinoReserve();
  const tableLimit = reserve?.live && reserve.maxWinUnits > 0 ? reserve.maxWinUnits : null;
  const [bet, setBet] = useState(() => { const v = Number(readStore(BET_KEY)); return BET_LEVELS.includes(v) ? v : BET_LEVELS[0]; });
  const [committedStake, setCommittedStake] = useState(0);
  const [balanceOverride, setBalanceOverride] = useState(null);
  const shownBalance = displayedBalanceCents({ balanceCents: balance, committedStakeCents: committedStake, overrideCents: balanceOverride });
  // Portrait phones show whole $TICS when the settled balance is whole, and keep that width while a win
  // counts up (a count-up value with cents must not widen the header mid-animation).
  const portraitDecimals = balance != null && Math.round(balance) % 100 === 0 ? 0 : 2;
  const balanceText = user && shownBalance != null ? (layout === 'portrait' ? fmtTics(balanceOverride != null ? Math.round(shownBalance / (portraitDecimals ? 1 : 100)) * (portraitDecimals ? 1 : 100) : shownBalance, { decimals: portraitDecimals }) : fmtMoney(shownBalance)) : '...';
  const levelStates = useMemo(() => betLevelStates({ tableLimit, balance, minStakeCents: config?.minStakeCents ?? null, maxStakeCents: config?.maxStakeCents ?? null, maxHouseLossCents: config?.maxHouseLossCents ?? null }), [tableLimit, balance, config?.minStakeCents, config?.maxStakeCents, config?.maxHouseLossCents]);
  const betState = levelStates.find((s) => s.stake === bet) || { allowed: true, reason: null };
  // When the limit or the balance drops, the selected bet follows (never silently above a limit).
  useEffect(() => {
    if (busy || balance == null) return;
    const next = pickBetLevel(levelStates, bet);
    if (next !== bet) { setBet(next); writeStore(BET_KEY, String(next)); }
  }, [levelStates, busy]); // eslint-disable-line react-hooks/exhaustive-deps
  const changeBet = (dir) => {
    if (busy) return;
    const next = stepBetLevel(BET_LEVELS, bet, dir);
    if (next == null) return;
    const st = levelStates.find((s) => s.stake === next);
    if (st && !st.allowed) { setNotice(st.reason); return; }
    setNotice(null); setBet(next); writeStore(BET_KEY, String(next));
  };

  // What the reels show.
  const [grid, setGrid] = useState(IDLE_GRID);
  const [stops, setStops] = useState(IDLE_STOPS);
  const [reelStates, setReelStates] = useState(ALL_STOPPED);
  const [spinKey, setSpinKey] = useState(0);
  const [activeLine, setActiveLine] = useState(null);
  const [activeCount, setActiveCount] = useState(5);
  const [winCells, setWinCells] = useState([]);
  const [dimming, setDimming] = useState(false);
  const [scatterHot, setScatterHot] = useState(false);
  const [anticipationFrom, setAnticipationFrom] = useState(null);
  const [freeMode, setFreeMode] = useState(false);
  const [freeLeft, setFreeLeft] = useState(0);
  const [banner, setBanner] = useState(null); // { kind: 'win' | 'free-intro' | 'retrigger' | 'total', ... }
  const [door, setDoor] = useState(false);
  const [celebration, setCelebration] = useState(null); // big and mega wins: WinCelebration overlay
  const [winShown, setWinShown] = useState(0);
  const [burstKey, setBurstKey] = useState(0); // coin burst from the win amount
  const [counterFlash, setCounterFlash] = useState(0); // retrigger flashes the free spin counter
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
  const [reducedMotion, setReducedMotion] = useState(() => prefersReducedMotion());
  const [lastRound, setLastRound] = useState(null);
  const [lastReceipt, setLastReceipt] = useState(null);
  const [lastVerdict, setLastVerdict] = useState(null);
  const [autoSpin, setAutoSpin] = useState(false);
  const autoRef = useRef(false);
  const skipRef = useRef(false);
  const skipWakers = useRef(new Set());
  const rafRef = useRef(0);
  const spinRef = useRef(null);

  const [paytableOpen, setPaytableOpen] = useState(false);
  const [fairnessOpen, setFairnessOpen] = useState(false);
  const [sheet, setSheet] = useState(null); // { tab } while the profile pop-up is open
  const inbox = useInbox({ ready: !!user, quiet: busy || autoSpin });
  const anyModal = paytableOpen || fairnessOpen || !!sheet || session.connectNoticeOpen || !session.ageOk;

  const ready = !!user && !busy && !blocked && !gameClosed && !!config && isCommitmentValid(commitment) && betState.allowed && balance != null && balance >= bet;

  const stopAuto = () => { autoRef.current = false; setAutoSpin(false); };
  const stopForVerification = (message) => {
    fetch(`${API}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'fairness_fail', game: 'godsofpower', detail: String(message || 'verification failed') }) }).catch(() => {});
    blockedRef.current = true; setBlocked(true); stopAuto(); setError(message);
  };

  // One clock for the whole presentation; a tap on the reels wakes every waiting step at once.
  const waitUntil = (at) => new Promise((resolve) => {
    const d = at - performance.now();
    if (skipRef.current || d <= 0) { resolve(); return; }
    const id = setTimeout(() => { skipWakers.current.delete(wake); resolve(); }, d);
    const wake = () => { clearTimeout(id); resolve(); };
    skipWakers.current.add(wake);
  });
  const skip = () => { if (phase !== 'presenting') return; skipRef.current = true; skipWakers.current.forEach((w) => w()); skipWakers.current.clear(); };
  const tween = (ms, onFrame) => new Promise((resolve) => {
    const start = performance.now();
    const step = (now) => {
      const t = skipRef.current ? 1 : Math.max(0, Math.min(1, (now - start) / Math.max(1, ms))); // rAF time can predate start
      onFrame(t);
      if (t < 1) rafRef.current = requestAnimationFrame(step); else resolve();
    };
    rafRef.current = requestAnimationFrame(step);
  });

  // Plays a verified round back: reels, wins, free spins, then the settled balance.
  const present = async (data, startedAt) => {
    const pace = autoRef.current ? 0.4 : 1;
    const reduced = prefersReducedMotion();
    const tl = buildTimeline(data, { pace, reduced });
    // The reels show the picture the VERIFIED stops give (gridFor), never a grid the server sent on its own.
    const shownGrid = (spin) => gridFor(spin.stops, SLOT_MATH);
    // The network time already spent counts as spinning time; the stagger between reels is kept.
    const origin = Math.max(startedAt, performance.now() - TIMING.spinMs);
    skipRef.current = false;
    const effects = motionEffects({ reduced });
    const base = data.balanceBeforeCents - data.stake;
    let paid = 0;
    for (const step of tl.steps) {
      await waitUntil(origin + step.at);
      const spin = data.spins[step.spin];
      switch (step.type) {
        case 'spin-start': {
          setBanner((b) => (b && b.kind === 'win' ? null : b)); setDoor(false); setCelebration(null);
          setActiveLine(null); setWinCells([]); setDimming(false); setScatterHot(false); setAnticipationFrom(null);
          setGrid(shownGrid(spin)); setStops(spin.stops); setFreeMode(step.free); setFreeLeft(step.freeLeft);
          setSpinKey((k) => k + 1); setReelStates(Array(SLOT_MATH.reels).fill('spinning'));
          if (step.spin > 0) { setBanner(null); }
          sfx.spinLoopStart();
          break;
        }
        case 'reel-stop': {
          setReelStates((s) => s.map((v, i) => (i === step.reel ? 'stopped' : v)));
          const column = shownGrid(spin).map((row) => row[step.reel]);
          sfx.reelStop(step.reel, { sparkle: column.includes('W') || column.includes('S') || column.includes('D') });
          if (column.includes('W')) sfx.portraitLand();
          if (step.reel === SLOT_MATH.reels - 1) { sfx.spinLoopStop(); sfx.anticipation(false); }
          break;
        }
        case 'scatter': setScatterHot(true); sfx.scatter(step.count); break;
        case 'anticipation': setAnticipationFrom(step.fromReel); sfx.anticipation(true); break;
        case 'anticipation-end': setAnticipationFrom(null); sfx.anticipation(false); break;
        case 'line-win': {
          setActiveLine(step.line); setActiveCount(step.count); setWinCells(winningCells(step.line, step.count)); setDimming(true);
          sfx.lineWin(['win', 'nice', 'big', 'mega'].indexOf(step.tier));
          if (step.symbol === 'W') sfx.voice('gods_of_power');
          break;
        }
        case 'scatter-win': {
          setActiveLine(null); setDimming(true);
          const cells = []; shownGrid(spin).forEach((row, r) => row.forEach((code, reel) => { if (code === 'S') cells.push({ reel, row: r }); }));
          setWinCells(cells);
          break;
        }
        case 'count-up': {
          setActiveLine(null);
          const bigWin = step.tier === 'big' || step.tier === 'mega';
          const from = base + paid, to = from + step.amount;
          paid += step.amount;
          setBanner({ kind: 'win', amount: step.amount, tier: step.tier, multiplier: step.multiplier });
          if (effects.coinBurst) setBurstKey((k) => k + 1);
          if (step.tier === 'nice') sfx.voice('nice_win');
          if (bigWin) { setCelebration({ total: step.amount, stake: data.stake, phase: 'totaling', pace, reduced }); sfx.coinShower(step.duration); sfx.voice(step.tier === 'mega' ? 'mega_win' : 'big_win'); }
          await tween(step.duration, (t) => {
            const e = countEase(t);
            setWinShown(Math.round(step.amount * e));
            setBalanceOverride(Math.round(from + (to - from) * e));
            sfx.countTick(t);
          });
          if (bigWin) { setCelebration((c) => (c ? { ...c, phase: 'transferring' } : c)); await waitUntil(performance.now() + celebrationTiming(winTier(step.amount, data.stake), pace).flyMs); setCelebration(null); }
          break;
        }
        case 'free-intro':
          setBanner({ kind: 'free-intro', count: step.spinsAwarded }); setDoor(true);
          sfx.vaultOpen(); sfx.fanfare(); sfx.voice('free_spins'); sfx.voice('vault_open', { queue: true });
          break;
        case 'retrigger':
          setBanner({ kind: 'retrigger', added: step.added }); setFreeLeft((n) => n + step.added); setCounterFlash((k) => k + 1);
          sfx.retrigger(); sfx.voice('more_spins');
          break;
        case 'total':
          setBanner({ kind: 'total', amount: step.amount, freeSpins: step.freeSpins, capped: step.capped });
          break;
        case 'done': {
          setDoor(false); setCelebration(null); setFreeMode(false); setAnticipationFrom(null);
          setBanner((b) => (b && (b.kind === 'free-intro' || b.kind === 'retrigger') ? null : b));
          // The settled balance replaces the count-up value and the committed stake in one render.
          session.applyBalance(data.mode, data.balanceAfterCents);
          setBalanceOverride(null); setCommittedStake(0);
          setPhase('idle');
          break;
        }
        default: break;
      }
    }
  };

  // ---- refused spins and lost replies: the same protection as roulette (spinRefusal.js) ----
  // Once this browser has sent its random value for a lock, ANY refusal could be the server dropping a round
  // it did not like. So the lock is saved as "open" BEFORE the post; a refusal retires it through the reveal
  // (rotate with expectedCommitment, the revealed key must open the saved lock), the round it would have
  // given is worked out with the saved randomness and logged, and it counts in the rolling refusal budgets.
  const identity = () => session.identity || user?.identity || 'guest';
  const fetchRounds = () => fetchPlayerRounds();
  // Opens the lock through the reveal and logs what the refused round would have shown and paid.
  // `current` is the lock as the server holds it now (after a reload the lucky word may have changed).
  const openAndLog = async (entry, kind, reason, stake, current = null) => {
    let swap;
    try { swap = await revealAndRetireLock(current || { serverSeedHash: entry.serverSeedHash, clientSeed: entry.clientSeed, nonce: entry.nonce }); } catch (e) { swap = { ok: false, error: e.message }; }
    if (swap.fits && typeof swap.retired?.serverSeed === 'string') {
      let stops = null, won = null;
      try {
        const r = await recomputeSlotRound({ serverSeed: swap.retired.serverSeed, clientSeed: `${entry.clientSeed}:${entry.clientEntropy}`, nonce: entry.nonce, stake });
        stops = r.spins[0]?.stops || null; won = r.totalPayoutUnits;
      } catch { stops = null; won = null; }
      addRefusedSlotSpin({ lock: entry.serverSeedHash, stops, won, kind, reason });
      swap = { ...swap, wouldHave: slotWouldHaveText(stops, won) };
    }
    if (swap.ok) forgetOpenLock(entry.serverSeedHash);
    return swap;
  };
  // Takes the server's current lock after the old one was used elsewhere or settled. Throws when it is not fresh.
  const adoptCurrentLock = async (oldHash, clientSeedBase) => {
    const r = await fetch(`${API}/fairness/commitment`);
    const c = await r.json();
    let revealed = []; try { revealed = readRevealedHashes(); } catch { revealed = []; }
    const ok = r.ok && isCommitmentValid(c) && c.serverSeedHash !== oldHash && !revealed.includes(c.serverSeedHash)
      && isNextCommitmentSafe(c, { serverSeedHash: oldHash, clientSeedBase }, revealed);
    if (!ok) throw new Error(C.noLock);
    setCommitment(Object.freeze({ ...c }));
  };
  // The lock was used by a round this page did not make (another tab or device, or a server voiding the spin):
  // counted in the strict budget, the would-have round logged from the revealed key, then the new lock is taken.
  // adopt: take the server's current lock afterwards. checkAlone: apply the "no other tab" rule (only right
  // after the spin; after a reload the timing is no longer known).
  const acceptOtherDeviceRound = async (hit, entry, stake, { adopt = true, checkAlone = true } = {}) => {
    const row = hit.round;
    const seedOk = typeof row.server_seed === 'string' && (await sha256Hex(row.server_seed)) === row.server_seed_hash;
    if (!seedOk) { stopForVerification('A spin played with this lock in another tab or on another device does not check out. Betting is stopped. Inspect the round before continuing.'); return false; }
    let stops = null, won = null;
    try { const r = await recomputeSlotRound({ serverSeed: row.server_seed, clientSeed: `${entry.clientSeed}:${entry.clientEntropy}`, nonce: entry.nonce, stake }); stops = r.spins[0]?.stops || null; won = r.totalPayoutUnits; } catch { stops = null; }
    addRefusedSlotSpin({ lock: entry.serverSeedHash, stops, won, kind: 'other_device', reason: 'The lock was used by a spin this page did not make' });
    try { rememberRevealedSeed(row.server_seed_hash); } catch { /* storage full: the server never reuses a seed */ }
    forgetOpenLock(entry.serverSeedHash);
    const alone = checkAlone && !otherTabRecently(session.tabId);
    if (!entry.counted) {
      const r = recordRefusal('unpredicted');
      if (r.reached) { stopForVerification(refusalStopMessage('unpredicted', r.count)); return false; }
    }
    if (adopt) {
      try { await adoptCurrentLock(entry.serverSeedHash, entry.clientSeed); } catch (e) { setError(e.message); lockErrorRef.current = true; recoverLock(); return false; }
      session.refreshWallet();
    }
    const extra = slotWouldHaveText(stops, won);
    setNotice(`${alone ? OTHER_DEVICE_ALONE_MESSAGE : OTHER_DEVICE_MESSAGE}${extra ? ` ${extra}` : ''}`);
    return true;
  };
  // ---- mount-time reconciliation (the roulette page's reloadCommitment and checkOpenLocks, for the slot) ----
  // One saved open lock against the round history. 'settled': this page's own round, verified with the slot
  // checker and cleared; 'other': used by a round this page did not make (counted); 'missing': no round uses
  // it; 'unknown': the history could not be read; 'stopped': a check failed and betting is stopped.
  const settleOpenLock = async (entry, rounds = null) => {
    let list = rounds;
    if (!list) { try { list = await fetchRounds(); } catch { return 'unknown'; } }
    const hit = findRoundForLock(list, entry);
    if (!hit) return 'missing';
    if (!hit.own) return (await acceptOtherDeviceRound(hit, entry, readSlotReceipt(entry.requestId)?.stake ?? null, { adopt: false, checkAlone: false })) ? 'other' : 'stopped';
    const swapped = ownRoundProblems(hit.round, entry);
    if (swapped.length) { stopForVerification(`${OWN_ROUND_SWAPPED_MESSAGE} (${swapped.join(', ')})`); return 'stopped'; }
    const round = slotRoundFromRow(hit.round);
    if (round) {
      // The slot's own check: the saved receipt (stake, mode, maths, randomness) plus the full recomputation.
      const check = await checkSlotHistoryRound(round);
      setLastRound(round); setLastReceipt(readSlotReceipt(entry.requestId)); setLastVerdict(check);
      if (!check.ok) { setCommitment(null); stopForVerification(`${EARLIER_ROUND_FAILED_MESSAGE} (${check.problems.join(', ')})`); return 'stopped'; }
      setNotice(`Your earlier spin went through and paid ${fmtMoney(round.totalPayoutCents)}. It was checked in your browser.`);
    } else {
      // Not a slot round after all (a roulette round on a lock this page sent a value for): only the roulette check applies.
      const v = await verifyRevealedRound(hit.round);
      if (!v.ok) { setCommitment(null); stopForVerification(`${EARLIER_ROUND_FAILED_MESSAGE} (${v.reason})`); return 'stopped'; }
    }
    try { rememberRevealedSeed(hit.round.server_seed_hash); } catch { /* storage full: the server never reuses a seed */ }
    forgetOpenLock(entry.serverSeedHash);
    return 'settled';
  };
  // Every saved slot lock of this player that is no longer the current lock: settled rounds are verified and
  // cleared, a lock no round ever used is logged as never opened and counted (the server dropped a spin whose
  // random value it had).
  const checkOpenLocks = async (currentHash) => {
    if (!currentHash || blockedRef.current) return;
    const list = locksToCheck(identity(), currentHash, Date.now(), undefined, { game: 'godsofpower', tab: session.tabId || null });
    if (!list.length) return;
    let rounds;
    try { rounds = await fetchRounds(); } catch { return; } // again on the next load or focus
    let warn = false;
    for (const entry of list) {
      const result = await settleOpenLock(entry, rounds);
      if (result === 'stopped') return;
      if (result !== 'missing') continue;
      forgetOpenLock(entry.serverSeedHash);
      addRefusedSlotSpin({ lock: entry.serverSeedHash, stops: null, kind: 'never_opened', reason: 'The server never showed this key' });
      warn = true;
      if (!entry.counted) {
        const r = recordRefusal('unpredicted');
        if (r.reached) { stopForVerification(refusalStopMessage('unpredicted', r.count)); return; }
      }
    }
    if (warn && !blockedRef.current) setNotice(NEVER_OPENED_MESSAGE);
  };
  checkOpenLocksRef.current = checkOpenLocks;
  // Loads the current lock. `previousHash` is the lock a failed request left behind: a different lock is only
  // taken when the old key was shown (a settled round in the history that checks out). A lock this page sent a
  // random value for and that saw a refusal, or whose spin never got a reply, is retired through the reveal
  // BEFORE it is accepted (the would-have round logged, counted once). Returns the accepted lock's hash, or
  // null when betting was stopped. Throws when no lock could be accepted (the caller retries).
  const loadCommitment = async (previousHash = null) => {
    const r = await fetch(`${API}/fairness/commitment`);
    const c = await r.json();
    let revealed = []; try { revealed = readRevealedHashes(); } catch { revealed = []; }
    if (!r.ok || !isCommitmentValid(c) || revealed.includes(c.serverSeedHash)) throw new Error(C.noLock);
    if (!canAcceptReloadedLock(c, previousHash)) {
      const prev = findOpenLock(previousHash, identity());
      const result = prev ? await settleOpenLock(prev) : 'missing';
      if (result === 'stopped') return null;
      if (result !== 'settled' && result !== 'other') throw new Error(LOCK_CHANGED_MESSAGE);
    }
    const open = findOpenLock(c.serverSeedHash, identity());
    if (open && !mustRetireLock(open, Date.now(), session.tabId || null)) {
      // Another tab of this browser sent a random value for this very lock seconds ago and may still be waiting
      // for the reply: the lock is NOT accepted as it is; the recovery comes back once the grace has passed.
      const wait = new Error(LOCK_IN_FLIGHT_MESSAGE); wait.retryInMs = retireWaitMs(open, Date.now(), session.tabId || null); throw wait;
    }
    if (open) {
      const swap = await openAndLog(open, 'lost', open.refused ? 'Refused before this page was reloaded' : 'The page closed before the reply',
        readSlotReceipt(open.requestId)?.stake ?? null, { serverSeedHash: c.serverSeedHash, clientSeed: c.clientSeed, nonce: c.nonce });
      if (swap.problem) { setCommitment(null); stopForVerification(swap.problem); return null; }
      if (!swap.ok) throw new Error(LOCK_RECHECK_MESSAGE);
      if (!open.counted) {
        const counted = recordRefusal('unpredicted');
        if (counted.reached) { setCommitment(null); stopForVerification(refusalStopMessage('unpredicted', counted.count)); return null; }
      }
      setCommitment(swap.commitment);
      setNotice(`${LOST_REPLY_MESSAGE}${swap.wouldHave ? ` ${swap.wouldHave}` : ''}`);
      session.refreshWallet();
      return swap.commitment.serverSeedHash;
    }
    setCommitment(Object.freeze({ ...c }));
    return c.serverSeedHash;
  };
  // Automatic recovery for every state that used to say "reload the page": the lock is loaded again and the
  // open locks are checked, with a few spaced retries (and again on focus). Betting is blocked only by a failed
  // check or a reached budget, never by a request that merely failed.
  const RECOVER_DELAYS_MS = [2000, 5000, 10000, 20000];
  const recoverLock = async (previousHash = null, attempt = 0) => {
    if (blockedRef.current) return;
    if (recoveringRef.current) { pendingHashRef.current = previousHash; return; }
    recoveringRef.current = true; pendingHashRef.current = previousHash;
    clearTimeout(recoverTimerRef.current);
    try {
      const hash = await loadCommitment(previousHash);
      if (hash) {
        pendingHashRef.current = null;
        if (lockErrorRef.current) { lockErrorRef.current = false; setError(null); }
        await checkOpenLocks(hash);
      }
    } catch (e) {
      setCommitment(null);
      lockErrorRef.current = true;
      if (Number.isFinite(e.retryInMs)) { // a timed wait (another tab's fresh lock): not one of the retries
        setError(e.message);
        recoverTimerRef.current = setTimeout(() => recoverRef.current?.(previousHash, attempt), e.retryInMs);
      } else if (attempt < RECOVER_DELAYS_MS.length) {
        setError(e.message);
        recoverTimerRef.current = setTimeout(() => recoverRef.current?.(previousHash, attempt + 1), RECOVER_DELAYS_MS[attempt]);
      } else setError(`${e.message} ${LOCK_CHECK_GAVE_UP_MESSAGE}`);
    } finally { recoveringRef.current = false; }
  };
  recoverRef.current = recoverLock;
  // This browser's own round is in the history although its reply was lost: asking again with the byte-identical
  // body returns the server's cached reply, which is verified and presented like any other round (no reload).
  const settleFoundRound = async ({ hit, request, bodyText, entry, startedAt }) => {
    const { resp, data } = await postJsonWithTimeout(`${SLOT_API}/spin`, bodyText);
    if (resp?.ok && data && data.requestId === request.receipt.requestId) { await processReply(data, request, entry, startedAt); return; }
    // The replay failed: check the round from the history itself (no ending balance there) and tell the player.
    settleReelsRef.current();
    const round = slotRoundFromRow(hit.round);
    const verdict = round ? await verifySlotRound(withoutSlotBalance(request.receipt), round) : { ok: false, problems: ['The round could not be read back.'] };
    setLastRound(round); setLastReceipt(request.receipt); setLastVerdict(verdict);
    if (!verdict.ok) { setCommitment(null); stopForVerification(C.verificationFailed); return; }
    try { rememberRevealedSeed(hit.round.server_seed_hash); } catch { /* storage full */ }
    forgetOpenLock(entry.serverSeedHash);
    try { await adoptCurrentLock(entry.serverSeedHash, entry.clientSeed); } catch (e) { setError(e.message); lockErrorRef.current = true; recoverLock(); }
    session.refreshWallet();
    setNotice(`Your spin went through and paid ${fmtMoney(round.totalPayoutCents)}. It was checked in your browser.`);
  };
  // No reply at all. The round history is checked for this lock for about 20 s: found and ours, the cached reply
  // is fetched and presented; found and not ours, it is treated as another device's round; not found, the lock
  // is opened through the reveal so the spin can never land later, and the player goes on with a new lock.
  const recoverLostReply = async ({ entry, request, bodyText, startedAt }) => {
    setNotice(C.lostReplyChecking);
    let hit = await waitForRoundWithLock(entry, fetchRounds);
    if (!hit) {
      const swap = await openAndLog(entry, 'lost', 'The connection dropped before the reply', request.receipt.stake);
      if (swap.problem) { settleReelsRef.current(); setNotice(null); setCommitment(null); stopForVerification(swap.problem); return; }
      if (swap.ok) {
        settleReelsRef.current(); setCommitment(swap.commitment);
        const r = recordRefusal('unpredicted'); updateOpenLock(entry.serverSeedHash, { counted: true });
        if (r.reached) { setNotice(null); stopForVerification(refusalStopMessage('unpredicted', r.count)); return; }
        setNotice(`${LOST_REPLY_MESSAGE}${swap.wouldHave ? ` ${swap.wouldHave}` : ''}`); session.refreshWallet(); return;
      }
      try { hit = findRoundForLock(await fetchRounds(), entry); } catch { hit = null; } // one last look: maybe it landed meanwhile
      if (!hit) {
        // The lock could not be opened and no round used it: the lock is marked refused so the recovery retires it
        // through the reveal before any lock is accepted again (or finds the round if it lands meanwhile).
        settleReelsRef.current(); setCommitment(null); updateOpenLock(entry.serverSeedHash, { refused: true });
        setNotice(LOST_REPLY_RECHECK_MESSAGE); recoverLock(entry.serverSeedHash); return;
      }
    }
    setNotice(null);
    if (!hit.own) { settleReelsRef.current(); setCommitment(null); await acceptOtherDeviceRound(hit, entry, request.receipt.stake); return; }
    await settleFoundRound({ hit, request, bodyText, entry, startedAt });
  };
  // Any refusal after the random value was sent. The lock always counts as used (opened through the reveal, the
  // would-have round logged) and the refusal counts in its budget: predicted ones in the larger budget,
  // unpredicted ones in the strict one. The only uncounted cases never used the lock: a 409 other_tab when this
  // browser itself saw the other tab play, and an expired sign in.
  const handleRefusal = async ({ kind, reason, code = null, entry, request, bodyText, startedAt }) => {
    const stake = request.receipt.stake;
    if (kind === 'other_tab') { forgetOpenLock(entry.serverSeedHash); settleReelsRef.current(); setNotice(reason || OTHER_TAB_MESSAGE); return; }
    if (kind === 'auth' && isSignedInElsewhere({ status: 401, code })) { forgetOpenLock(entry.serverSeedHash); settleReelsRef.current(); session.signedOutElsewhere({ message: reason }); return; }
    updateOpenLock(entry.serverSeedHash, { refused: true, counted: !budgetFor(kind) });
    if (kind === 'stale_lock') {
      // The lock moved on: a round used it, either this very spin (lost reply) or another tab or device.
      let hit = null;
      try { hit = findRoundForLock(await fetchRounds(), entry); } catch { hit = null; }
      if (hit?.own) { await settleFoundRound({ hit, request, bodyText, entry, startedAt }); return; }
      settleReelsRef.current(); setCommitment(null);
      if (hit) { await acceptOtherDeviceRound(hit, entry, stake); return; }
      const r = recordRefusal('unpredicted'); updateOpenLock(entry.serverSeedHash, { counted: true });
      if (r.reached) { stopForVerification(refusalStopMessage('unpredicted', r.count)); return; }
      // No round used the lock yet: the recovery keeps looking for it and only takes a new lock once the old key was shown.
      setError(STALE_LOCK_RECHECK_MESSAGE); lockErrorRef.current = true; recoverLock(entry.serverSeedHash);
      return;
    }
    settleReelsRef.current(); setCommitment(null);
    const swap = await openAndLog(entry, kind, reason, stake);
    const wouldHave = swap.wouldHave || '';
    if (swap.problem) { stopForVerification(swap.problem); return; }
    if (swap.ok) setCommitment(swap.commitment);
    const budget = budgetFor(kind);
    if (budget) {
      const r = recordRefusal(budget); updateOpenLock(entry.serverSeedHash, { counted: true });
      if (r.reached) { stopForVerification(`${refusalStopMessage(budget, r.count)}${wouldHave ? ` ${wouldHave}` : ''}`); return; }
    }
    session.refreshWallet();
    if (kind === 'auth') { setError(SIGN_IN_EXPIRED_MESSAGE); return; }
    // The reveal failed (the lock is marked refused): the recovery retires it before any lock is accepted again.
    if (!swap.ok) { setError(`${reason ? `${reason.replace(/[.!?]?$/, '.')} ` : ''}${LOCK_RECHECK_MESSAGE}`); lockErrorRef.current = true; recoverLock(entry.serverSeedHash); return; }
    if (kind === 'table_changed') { loadConfig(); setNotice(C.tableChanged); return; }
    if (kind === 'other_tab_unseen') { setError(`${OTHER_TAB_UNSEEN_MESSAGE}${wouldHave ? ` ${wouldHave}` : ''}`); return; }
    if (kind === 'transient') { setError(`The game is busy for a moment${reason && reason !== 'internal error' ? ` (${reason.replace(/[.!?]$/, '')})` : ''}. Your bet was not taken.${wouldHave ? ` ${wouldHave}` : ''} Please try again.`); return; }
    if (kind === 'predicted') { setError(`${reason ? reason.replace(/[.!?]?$/, '.') : 'The spin was refused.'}${wouldHave ? ` ${wouldHave}` : ''}`); loadConfig(); return; }
    setError(refusalRetiredMessage(reason, { wouldHave }));
  };
  // A full reply: verified in this browser BEFORE anything is shown, then presented.
  const processReply = async (data, request, entry, startedAt) => {
    const verdict = await verifySlotRound(request.receipt, data);
    setLastRound(data); setLastReceipt(request.receipt); setLastVerdict(verdict);
    if (!verdict.ok) { settleReelsRef.current(); setCommitment(null); updateOpenLock(entry.serverSeedHash, { refused: true, counted: true }); stopForVerification(C.verificationFailed); return; }
    try { rememberRevealedSeed(data.fairness.serverSeedHash); } catch { /* storage full: the server never reuses a seed */ }
    forgetOpenLock(entry.serverSeedHash);
    const next = data.fairness.nextCommitment;
    let revealed = []; try { revealed = readRevealedHashes(); } catch { revealed = []; }
    if (isNextCommitmentSafe(next, { serverSeedHash: request.receipt.serverSeedHash, clientSeedBase: request.receipt.clientSeedBase }, revealed)) setCommitment(Object.freeze({ ...next }));
    else { setCommitment(null); stopAuto(); }
    setPhase('presenting');
    await present(data, startedAt);
    // Auto spin: again after a short pause unless something says stop.
    const reason = autoShouldStop({ freeSpins: data.freeSpinsAwarded, balance: data.balanceAfterCents, stake: bet, verified: true });
    if (autoRef.current) {
      if (reason === 'balance') { stopAuto(); setNotice(C.autoStoppedBalance); }
      else if (reason === 'free_spins') { stopAuto(); setNotice(C.autoStoppedFree); }
      else setTimeout(() => { if (autoRef.current && !blockedRef.current) spinRef.current?.(); }, 400);
    }
  };
  const settleReelsRef = useRef(() => {});

  // The spin: receipt and open lock saved BEFORE the post, verified in this browser BEFORE anything is shown.
  const spin = async () => {
    const c = commitmentRef.current;
    if (!ready || !isCommitmentValid(c)) return;
    ensureAudioContext();
    let request, entry;
    try {
      request = createSlotRequest(c, bet, mode, { balanceBefore: balance }); saveSlotReceipt(request.receipt);
      // ...and the lock with the random value about to be sent, so it is checked even if this page closes.
      entry = rememberOpenLock({ identity: identity(), serverSeedHash: c.serverSeedHash, clientSeed: c.clientSeed, nonce: c.nonce, clientEntropy: request.body.clientEntropy, requestId: request.receipt.requestId, game: 'godsofpower', ...(session.tabId ? { tab: session.tabId } : {}) });
    } catch (e) { setError(e.message); stopAuto(); return; }
    setError(null); setNotice(null);
    setPhase('spinning'); setCommittedStake(bet); setBanner(null); setCelebration(null); setDoor(false);
    setActiveLine(null); setWinCells([]); setDimming(false); setScatterHot(false); setAnticipationFrom(null); setFreeMode(false);
    setSpinKey((k) => k + 1); setReelStates(Array(SLOT_MATH.reels).fill('spinning'));
    sfx.spinLoopStart();
    guard.announce();
    // Play signals for the other-tab check: this tab's play stamp (heartbeat) and its last posted spin (session).
    notePlay(session.tabId);
    const ownSpin = noteSpinPosted('godsofpower');
    const startedAt = performance.now();
    settleReelsRef.current = () => { setReelStates(ALL_STOPPED); sfx.spinLoopStop(); setCommittedStake(0); setPhase('idle'); };
    const bodyText = JSON.stringify(request.body);
    const { resp, data } = await postJsonWithTimeout(`${SLOT_API}/spin`, bodyText);
    if (!resp || (resp.ok && !data)) { // lost reply: the server may or may not have played it
      stopAuto();
      await recoverLostReply({ entry, request, bodyText, startedAt });
      return;
    }
    if (!resp.ok) {
      stopAuto();
      const reason = typeof data?.error === 'string' ? data.error : '';
      // A 409 other_tab is only predicted on a PLAY signal this browser has itself: another tab announced a spin
      // (BroadcastChannel), another tab's play stamp in the heartbeat, or this very tab posted a spin on the other
      // game just now. On the server's word alone it is counted and the lock retired, like any other refusal.
      const otherTabSeen = otherTabSeenRecently({ lastForeignAt: guard.foreignAt(), ownSpin, game: 'godsofpower', otherTabRecently: (now, w) => otherTabPlayedRecently(session.tabId, now, undefined, w) });
      const kind = classifySpinRefusal(resp.status, reason, data?.code, { otherTabSeen });
      await handleRefusal({ kind, reason, code: data?.code, entry, request, bodyText, startedAt });
      return;
    }
    await processReply(data, request, entry, startedAt);
  };
  spinRef.current = spin;
  const toggleAuto = () => {
    if (autoSpin) { stopAuto(); return; }
    if (!ready) return;
    autoRef.current = true; setAutoSpin(true);
    spin();
  };
  useEffect(() => () => { cancelAnimationFrame(rafRef.current); sfx.spinLoopStop(); sfx.ambientStop(); }, []);
  // The OS motion setting can change while the page is open.
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq?.addEventListener) return undefined;
    const on = () => setReducedMotion(mq.matches);
    mq.addEventListener('change', on); return () => mq.removeEventListener('change', on);
  }, []);
  // Hidden tab: particles pause and the ambient bed stops; back in view they resume.
  useEffect(() => {
    const on = () => { setHidden(document.hidden); if (document.hidden) sfx.ambientStop(); else if (sfx.unlocked()) sfx.ambientStart(); };
    document.addEventListener('visibilitychange', on); return () => document.removeEventListener('visibilitychange', on);
  }, []);
  // The first gesture of the session unlocks audio, starts the quiet ambient bed and says welcome once per session.
  useEffect(() => {
    const once = () => {
      window.removeEventListener('pointerdown', once); window.removeEventListener('keydown', once);
      ensureAudioContext(); sfx.ambientStart();
      try { if (!sessionStorage.getItem('betics:slot-welcome')) { sessionStorage.setItem('betics:slot-welcome', '1'); sfx.voice('welcome'); } } catch { sfx.voice('welcome'); }
    };
    window.addEventListener('pointerdown', once); window.addEventListener('keydown', once);
    return () => { window.removeEventListener('pointerdown', once); window.removeEventListener('keydown', once); };
  }, []);

  // Space spins, Escape stops auto.
  const keysRef = useRef({}); keysRef.current = { spin, ready, anyModal, autoSpin, stopAuto };
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
      const k = keysRef.current;
      if (k.anyModal) return;
      if (e.key === ' ') { e.preventDefault(); if (k.ready && !k.autoSpin) k.spin(); }
      if (e.key === 'Escape' && k.autoSpin) k.stopAuto();
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, []);

  const chooseMode = (m) => { if (busy || autoSpin) return; const reason = session.chooseMode(m); if (reason) setNotice(reason); else { setError(null); setNotice(null); } };
  const connect = () => { setSheet(null); session.requestConnect(); };
  const openMessages = () => { setSheet({ tab: 'wallet', expand: 'messages' }); inbox.markSeen(); };
  const spinLabel = phase === 'idle' ? C.spin : C.spinning;
  const toasts = [
    gameClosed && { kind: 'closed', className: 'game-notice', testid: 'game-closed', title: toastTitle('closed'), text: config.maintenanceMessage || C.gameClosed },
    session.elsewhere && !error && { kind: 'elsewhere', className: 'game-error game-toast-error', title: 'Wallet', text: session.elsewhere, dismissible: true, testid: 'signed-in-elsewhere', action: { label: 'Connect again', testid: 'connect-again', onClick: () => { session.clearElsewhere(); session.requestConnect(); } } },
    notice && !error && { kind: 'info', className: 'game-notice', title: toastTitle('info', notice), text: notice, dismissible: true, testid: 'slot-notice' },
    error && { kind: 'error', className: 'game-error', title: toastTitle('error', error, blocked), text: error, dismissible: !blocked, testid: 'slot-error' },
  ].filter(Boolean);

  return <div className={`slot-app casino-app noselect layout-${layout}`} data-layout={layout} data-phase={phase} data-background-locked={anyModal || undefined} data-hidden={hidden || undefined} data-reduced-motion={reducedMotion || undefined}>
    <GameHeader page="slot" layout={layout} inert={anyModal}
      balanceText={balanceText} mode={mode} modeInfo={modeInfo} modeDisabled={busy || autoSpin} onMode={chooseMode}
      lock={{ hash: commitment?.serverSeedHash || null, status: lastVerdict ? (lastVerdict.ok ? 'ok' : 'bad') : '', onTap: () => setSheet({ tab: 'fairness' }), title: 'The lock for your next spin, shown before you bet. Tap to see the fairness details.' }}
      profile={profile} profileOpen={!!sheet} onProfile={() => setSheet({ tab: 'wallet' })} onConnect={connect} connecting={session.walletBusy} connectDisabled={busy || autoSpin}
      inbox={inbox} onBell={openMessages}>
      <GameToast toasts={toasts} onDismiss={(kind) => { if (kind === 'error') setError(null); if (kind === 'info') setNotice(null); if (kind === 'elsewhere') session.clearElsewhere(); }} />
    </GameHeader>

    <main className="slot-main" inert={anyModal ? true : undefined}>
      <section className="slot-stage">
        {/* felt-table: the shared win celebration centres its banner on this element */}
        <div className={`slot-vault felt-table${freeMode ? ' free' : ''}${anticipationFrom != null ? ' tense' : ''}`} data-testid="slot-vault">
          <div className="slot-vault-bar">
            {freeMode ? <><span key={`fc-${counterFlash}`} className={`slot-free-count${counterFlash ? ' flash' : ''}`} data-testid="slot-free-count">{C.freeSpins(freeLeft)}</span><span className="slot-x2" data-testid="slot-x2">{C.doubled}</span></>
              : banner?.kind === 'win' || banner?.kind === 'total' ? <span className="slot-last-win">{banner.kind === 'total' ? C.total : 'Win'} <b>{fmtMoney(banner.kind === 'total' ? banner.amount : winShown)}</b></span>
                : <span className="slot-vault-title">{C.subtitle}</span>}
          </div>
          <Reels grid={grid} stops={stops} reelStates={reelStates} spinKey={spinKey} activeLine={activeLine} activeCount={activeCount} winCells={winCells} dimming={dimming} scatterHot={scatterHot} anticipationFrom={anticipationFrom} onTap={skip} dust={mobile ? 8 : 16}>
            <AnimatePresence>
              {door && <motion.div key="door" className="slot-door" initial={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }} aria-hidden="true">
                <div className="slot-door-leaf left" /><div className="slot-door-leaf right" />
                <div className="slot-door-seam" /><div className="slot-door-dust" /><div className="slot-door-dust two" /><div className="slot-door-dust three" />
              </motion.div>}
              {burstKey > 0 && phase === 'presenting' && banner?.kind === 'win' && <div key={`coins-${burstKey}`} className="slot-coins" aria-hidden="true">
                {COIN_BURST.slice(0, mobile ? 8 : 14).map((c, i) => <i key={i} style={{ '--dx': c.dx, '--dy': c.dy, '--rot': c.rot, '--t': c.t, '--delay': c.delay }} />)}
              </div>}
              {celebration && !celebration.reduced && <div key={`rain-${spinKey}`} className="slot-rain" aria-hidden="true">
                {COIN_RAIN.slice(0, mobile ? 10 : 20).map((c, i) => <i key={i} style={{ '--x': c.x, '--d': c.d, '--delay': c.delay, '--drift': c.drift, '--rot': c.rot }} />)}
              </div>}
              {banner && banner.kind !== 'win' && <motion.div key={`${banner.kind}-${spinKey}`} className={`slot-banner slot-banner-${banner.kind}`} data-testid="slot-banner" role="status"
                initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={{ type: 'spring', stiffness: 380, damping: 30 }}>
                <div className="slot-banner-box">
                  {banner.kind === 'free-intro' && <><b>{C.freeIntro(banner.count)}</b><small>{C.freeIntroSub}</small></>}
                  {banner.kind === 'retrigger' && <b>{C.retrigger(banner.added)}</b>}
                  {banner.kind === 'total' && <><small>{C.total}{banner.freeSpins ? `, ${banner.freeSpins} free spins` : ''}</small><b>{fmtMoney(banner.amount)}</b>{banner.capped && <small>{C.capped}</small>}</>}
                </div>
              </motion.div>}
              {banner && banner.kind === 'win' && phase === 'presenting' && !celebration && <motion.div key={`win-${spinKey}`} className={`slot-win-pop tier-${banner.tier}`} data-testid="slot-win" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
                <div className="slot-win-box"><small>{winTier(banner.amount, bet).label}{banner.multiplier > 1 ? ` ${C.doubled}` : ''}</small><b>{fmtMoney(winShown)}</b></div>
              </motion.div>}
            </AnimatePresence>
          </Reels>
          <PlayCover covered={guard.covered} onDismiss={guard.dismiss} />
        </div>
      </section>

      <section className="slot-controls" data-testid="slot-controls">
        <div className="slot-bet" data-testid="slot-bet">
          <button type="button" className="slot-step" aria-label="Lower bet" data-testid="slot-bet-down" onClick={() => changeBet(-1)} disabled={busy || stepBetLevel(BET_LEVELS, bet, -1) == null}><Minus /></button>
          <div className="slot-bet-value"><span className="slot-bet-label">{C.bet}</span><strong data-testid="slot-bet-value" data-stake={bet}>{fmtBet(bet)}</strong></div>
          <button type="button" className={`slot-step${levelStates.find((s) => s.stake === stepBetLevel(BET_LEVELS, bet, 1))?.allowed === false ? ' capped' : ''}`} aria-label="Raise bet" data-testid="slot-bet-up" onClick={() => changeBet(1)} disabled={busy || stepBetLevel(BET_LEVELS, bet, 1) == null}><Plus /></button>
        </div>
        <button type="button" className="slot-btn slot-pays" data-testid="slot-paytable-btn" onClick={() => setPaytableOpen(true)}>{C.paytable}</button>
        <button type="button" className={`slot-btn slot-auto${autoSpin ? ' on' : ''}`} data-testid="slot-auto" aria-pressed={autoSpin} onClick={toggleAuto} disabled={!autoSpin && !ready}>{autoSpin ? C.autoOn : C.auto}</button>
        <button type="button" className="slot-spin" data-testid="slot-spin" onClick={spin} disabled={!ready || autoSpin} aria-label="Spin (Space)">
          <SpinIcon /><span>{spinLabel}</span>
        </button>
        <button type="button" className="slot-btn slot-fair" data-testid="slot-fairness-btn" onClick={() => setFairnessOpen(true)}>{C.fairness}</button>
      </section>
    </main>

    <AnimatePresence>
      {celebration && <motion.div key={`celebrate-${spinKey}`} initial={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
        <WinCelebration total={celebration.total} stake={celebration.stake} phase={celebration.phase} pace={celebration.pace} mobile={mobile} onSkip={skip} />
      </motion.div>}
    </AnimatePresence>
    <AnimatePresence>
      {sheet && <ProfileSheet key="profile" page="slot" mobile={mobile} initialTab={sheet.tab} initialExpanded={sheet.expand || null} onClose={() => setSheet(null)}
        profile={profile} wallet={user} mode={mode} balance={user ? shownBalance : null}
        onConnect={connect} connecting={session.walletBusy} onDisconnect={async () => { setSheet(null); await session.disconnectWallet(); }} disconnectDisabled={busy || autoSpin}
        deposit={null} onTopUp={() => setNotice('Top ups are made on the roulette page for now.')}
        onRefresh={async () => { await Promise.all([session.refreshProfile(), session.refreshWallet()]); }}
        inbox={inbox}
        historyContent={<SlotHistory refreshKey={lastRound?.roundId || 0} />}
        fairnessContent={<div className="profile-fairness"><SlotFairnessBody round={lastRound} receipt={lastReceipt} verdict={lastVerdict} idPrefix="profile" />
          <section className="fair-panel"><h4>{C.nextLock}</h4><code className="fair-mono" data-testid="next-fingerprint">{commitment ? commitment.serverSeedHash : '...'}</code>
            <p className="fair-note">Shown before you bet. After the spin the key that opens it is revealed, so you can check the reels yourself.</p></section></div>}
        rows={[{ key: 'pays', label: 'Rules and pays', testid: 'profile-row-pays', onClick: () => { setSheet(null); setPaytableOpen(true); } }]}
        onResetDemo={() => session.resetDemoBalance().catch((e) => setError(e.message))} resetDisabled={busy || autoSpin} resetting={session.demoResetting} />}
    </AnimatePresence>
    {inbox.popupNode}
    <AnimatePresence>{paytableOpen && <SlotPaytable stake={bet} mobile={mobile} onClose={() => setPaytableOpen(false)} />}</AnimatePresence>
    <AnimatePresence>{fairnessOpen && <SlotFairness round={lastRound} receipt={lastReceipt} verdict={lastVerdict} mobile={mobile} onClose={() => setFairnessOpen(false)} />}</AnimatePresence>
    {!session.ageOk && <AgeGate onAccept={session.acceptAge} />}
    {session.ageOk && session.connectNoticeOpen && <ConnectNotice onContinue={session.continueConnect} onClose={session.closeConnectNotice} />}
  </div>;
}
