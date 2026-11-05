import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { SLOT_MATH, BET_LEVELS } from '../../../backend/src/games/slotsMath.js';
import { gridFor } from '../../../backend/src/games/slots.js';
import BrandLogo from '../BrandLogo.jsx';
import GameToast, { toastTitle } from '../GameToast.jsx';
import { SoundQuickControls, SoundSettingsDialog } from '../SoundControls.jsx';
import WalletPanel from '../WalletPanel.jsx';
import Avatar from '../Avatar.jsx';
import ConnectNotice from '../ConnectNotice.jsx';
import { AgeGate } from '../Terms.jsx';
import WinCelebration from '../WinCelebration.jsx';
import { useCasinoReserve } from '../CasinoReserve.jsx';
import { shortAddress } from '../walletApi.js';
import { fmtMoney, fmtShort } from '../chips.js';
import { displayedBalanceCents } from '../balanceDisplay.js';
import { isCommitmentValid, isNextCommitmentSafe, readRevealedHashes, rememberRevealedSeed } from '../fairnessClient.js';
import { postJsonWithTimeout, classifySpinRefusal } from '../spinRefusal.js';
import { winTier, celebrationTiming, countEase } from '../winCelebration.js';
import { ensureAudioContext } from '../sound.js';
import { verifySlotRound } from './slotsVerify.js';
import { SLOT_API, createSlotRequest, saveSlotReceipt, betLevelStates, pickBetLevel, stepBetLevel, fmtBet, autoShouldStop } from './slotsApi.js';
import { buildTimeline, TIMING, winningCells } from './slotAnim.js';
import { PAGE_COPY as C } from './slotCopy.js';
import Reels from './Reels.jsx';
import SlotPaytable from './SlotPaytable.jsx';
import SlotFairness from './SlotFairness.jsx';
import useSlotSession from './useSlotSession.js';
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
const LockGlyph = () => <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>;

export default function SlotsApp() {
  const vp = useViewport();
  const landscape = vp.w > vp.h && vp.h < 560;
  const desktop = vp.w >= 1100 && !landscape;
  const mobile = !desktop;
  const layout = landscape ? 'landscape' : desktop ? 'desktop' : 'portrait';

  const [phase, setPhase] = useState('idle'); // idle | spinning | presenting
  const busy = phase !== 'idle';
  const session = useSlotSession({ busy });
  const { user, profile, mode, modeInfo, balance } = session;

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
  const loadCommitment = useCallback(async () => {
    try {
      const r = await fetch(`${API}/fairness/commitment`);
      const c = await r.json();
      let revealed = []; try { revealed = readRevealedHashes(); } catch { revealed = []; }
      if (!r.ok || !isCommitmentValid(c) || revealed.includes(c.serverSeedHash)) throw new Error(C.noLock);
      setCommitment(Object.freeze({ ...c }));
    } catch (e) { setCommitment(null); setError(e.message || C.noLock); }
  }, []);
  useEffect(() => {
    if (!user) return;
    loadConfig(); loadCommitment();
    const t = setInterval(loadConfig, 30000);
    const onFocus = () => loadConfig();
    window.addEventListener('focus', onFocus);
    fetch(`${API}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'game_open', game: 'slots', screen: `${window.screen.width}x${window.screen.height}` }) }).catch(() => {});
    return () => { clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, [session.identity, loadConfig, loadCommitment]);
  useEffect(() => { if (session.sessionError) { setError(session.sessionError); session.clearSessionError(); } }, [session.sessionError]); // eslint-disable-line react-hooks/exhaustive-deps
  const gameClosed = config?.enabled === false;

  // Bet level, the table limit and the balance.
  const reserve = useCasinoReserve();
  const tableLimit = reserve?.live && reserve.maxWinUnits > 0 ? reserve.maxWinUnits : null;
  const [bet, setBet] = useState(() => { const v = Number(readStore(BET_KEY)); return BET_LEVELS.includes(v) ? v : BET_LEVELS[0]; });
  const [committedStake, setCommittedStake] = useState(0);
  const [balanceOverride, setBalanceOverride] = useState(null);
  const shownBalance = displayedBalanceCents({ balanceCents: balance, committedStakeCents: committedStake, overrideCents: balanceOverride });
  const levelStates = useMemo(() => betLevelStates({ tableLimit, balance, minStakeCents: config?.minStakeCents ?? null, maxStakeCents: config?.maxStakeCents ?? null }), [tableLimit, balance, config?.minStakeCents, config?.maxStakeCents]);
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
  const [soundOpen, setSoundOpen] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const anyModal = paytableOpen || fairnessOpen || soundOpen || walletOpen || session.connectNoticeOpen || !session.ageOk;

  const ready = !!user && !busy && !blocked && !gameClosed && !!config && isCommitmentValid(commitment) && betState.allowed && balance != null && balance >= bet;

  const stopAuto = () => { autoRef.current = false; setAutoSpin(false); };
  const stopForVerification = (message) => {
    fetch(`${API}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'fairness_fail', game: 'slots', detail: String(message || 'verification failed') }) }).catch(() => {});
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
    const tl = buildTimeline(data, { pace });
    // The network time already spent counts as spinning time; the stagger between reels is kept.
    const origin = Math.max(startedAt, performance.now() - TIMING.spinMs);
    skipRef.current = false;
    const base = data.balanceBeforeCents - data.stake;
    let paid = 0;
    for (const step of tl.steps) {
      await waitUntil(origin + step.at);
      const spin = data.spins[step.spin];
      switch (step.type) {
        case 'spin-start': {
          setBanner((b) => (b && b.kind === 'win' ? null : b)); setDoor(false); setCelebration(null);
          setActiveLine(null); setWinCells([]); setDimming(false); setScatterHot(false); setAnticipationFrom(null);
          setGrid(spin.grid); setStops(spin.stops); setFreeMode(step.free); setFreeLeft(step.freeLeft);
          setSpinKey((k) => k + 1); setReelStates(Array(SLOT_MATH.reels).fill('spinning'));
          if (step.spin > 0) { setBanner(null); }
          sfx.spinLoopStart();
          break;
        }
        case 'reel-stop': {
          setReelStates((s) => s.map((v, i) => (i === step.reel ? 'stopped' : v)));
          const column = spin.grid.map((row) => row[step.reel]);
          sfx.reelStop(step.reel, { sparkle: column.includes('W') || column.includes('S') || column.includes('D') });
          if (column.includes('W')) sfx.portraitLand();
          if (step.reel === SLOT_MATH.reels - 1) { sfx.spinLoopStop(); sfx.anticipation(false); }
          break;
        }
        case 'scatter': setScatterHot(true); sfx.scatter(step.count); break;
        case 'anticipation': setAnticipationFrom(step.fromReel); sfx.anticipation(true); break;
        case 'anticipation-end': setAnticipationFrom(null); sfx.anticipation(false); break;
        case 'line-win': {
          setActiveLine(step.line); setWinCells(winningCells(step.line, step.count)); setDimming(true);
          sfx.lineWin(['win', 'nice', 'big', 'mega'].indexOf(step.tier));
          if (step.symbol === 'W') sfx.voice('gods_of_power');
          break;
        }
        case 'scatter-win': {
          setActiveLine(null); setDimming(true);
          const cells = []; spin.grid.forEach((row, r) => row.forEach((code, reel) => { if (code === 'S') cells.push({ reel, row: r }); }));
          setWinCells(cells);
          break;
        }
        case 'count-up': {
          setActiveLine(null);
          const bigWin = step.tier === 'big' || step.tier === 'mega';
          const from = base + paid, to = from + step.amount;
          paid += step.amount;
          setBanner({ kind: 'win', amount: step.amount, tier: step.tier, multiplier: step.multiplier });
          setBurstKey((k) => k + 1);
          if (step.tier === 'nice') sfx.voice('nice_win');
          if (bigWin) { setCelebration({ total: step.amount, stake: data.stake, phase: 'totaling', pace }); sfx.coinShower(step.duration); sfx.voice(step.tier === 'mega' ? 'mega_win' : 'big_win'); }
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

  // The spin: receipt saved BEFORE the post, verified in this browser BEFORE anything is shown.
  const spin = async () => {
    const c = commitmentRef.current;
    if (!ready || !isCommitmentValid(c)) return;
    ensureAudioContext();
    let request;
    try { request = createSlotRequest(c, bet, mode); saveSlotReceipt(request.receipt); }
    catch (e) { setError(e.message); stopAuto(); return; }
    setError(null); setNotice(null);
    setPhase('spinning'); setCommittedStake(bet); setBanner(null); setCelebration(null); setDoor(false);
    setActiveLine(null); setWinCells([]); setDimming(false); setScatterHot(false); setAnticipationFrom(null); setFreeMode(false);
    setSpinKey((k) => k + 1); setReelStates(Array(SLOT_MATH.reels).fill('spinning'));
    sfx.spinLoopStart();
    const startedAt = performance.now();
    const { resp, data } = await postJsonWithTimeout(`${SLOT_API}/spin`, JSON.stringify(request.body));
    const settleReels = () => { setReelStates(ALL_STOPPED); sfx.spinLoopStop(); setCommittedStake(0); setPhase('idle'); };
    if (!resp) { // lost reply: the server may or may not have played it, so the lock is not reused here
      settleReels(); stopAuto(); setCommitment(null); setError(C.lostReply); session.refreshWallet(); return;
    }
    if (!resp.ok) {
      settleReels(); stopAuto();
      const kind = classifySpinRefusal(resp.status, data?.error, data?.code);
      if (kind === 'table_changed') { loadConfig(); setNotice(C.tableChanged); }
      else setError(data?.error || 'Something went wrong. Please try again.');
      // A refused spin may have moved the lock on; take the server's current one if it is still fresh.
      loadCommitment(); session.refreshWallet();
      return;
    }
    const verdict = await verifySlotRound(request.receipt, data);
    setLastRound(data); setLastReceipt(request.receipt); setLastVerdict(verdict);
    if (!verdict.ok) { settleReels(); setCommitment(null); stopForVerification(C.verificationFailed); return; }
    try { rememberRevealedSeed(data.fairness.serverSeedHash); } catch { /* storage full: the server never reuses a seed */ }
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
  spinRef.current = spin;
  const toggleAuto = () => {
    if (autoSpin) { stopAuto(); return; }
    if (!ready) return;
    autoRef.current = true; setAutoSpin(true);
    spin();
  };
  useEffect(() => () => { cancelAnimationFrame(rafRef.current); sfx.spinLoopStop(); sfx.ambientStop(); }, []);
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
  const spinLabel = phase === 'idle' ? C.spin : C.spinning;
  const toasts = [
    gameClosed && { kind: 'closed', className: 'game-notice', testid: 'game-closed', title: toastTitle('closed'), text: config.maintenanceMessage || C.gameClosed },
    notice && !error && { kind: 'info', className: 'game-notice', title: toastTitle('info', notice), text: notice, dismissible: true, testid: 'slot-notice' },
    error && { kind: 'error', className: 'game-error', title: toastTitle('error', error, blocked), text: error, dismissible: !blocked, testid: 'slot-error' },
  ].filter(Boolean);

  return <div className={`slot-app casino-app noselect layout-${layout}`} data-layout={layout} data-phase={phase} data-background-locked={anyModal || undefined} data-hidden={hidden || undefined}>
    <header className="slot-header" inert={anyModal ? true : undefined}>
      <div className="slot-brand">
        <BrandLogo />
        <span className="brand-sub slot-sub">{C.subtitle}</span>
        <button type="button" className="commitment-button slot-lock" onClick={() => setFairnessOpen(true)} aria-label="Next lock: open the fairness details" title="The lock for your next spin, shown before you bet." data-testid="slot-lock">
          <span className={`commitment-status ${lastVerdict ? (lastVerdict.ok ? 'ok' : 'bad') : ''}`} aria-hidden="true"><LockGlyph /></span>
          <span className="commitment-text"><span className="commitment-label">{C.nextLock}</span><code>{commitment ? commitment.serverSeedHash.slice(0, 8) : '…'}</code></span>
        </button>
        <a className="slot-link" href="/" data-testid="slot-roulette-link">{C.roulette}</a>
        <SoundQuickControls onOpen={() => setSoundOpen(true)} />
      </div>
      <div className="header-right slot-header-right">
        <div className="header-balance slot-balance">
          <div className="balance-label-row slot-balance-row">
            <span className="balance-word">BALANCE</span>
            {profile && <div className="mode-switch" role="group" aria-label="Real or Demo" data-testid="mode-switch" data-mode={mode}>
              <button type="button" aria-pressed={mode === 'real'} data-testid="mode-real" className={mode === 'real' ? 'on' : ''} disabled={busy || autoSpin} aria-disabled={!modeInfo.realAvailable}
                title={modeInfo.realAvailable ? 'Play with real $TICS' : modeInfo.realReason} onClick={() => chooseMode('real')}>Real</button>
              {modeInfo.demoVisible && <button type="button" aria-pressed={mode === 'demo'} data-testid="mode-demo" className={mode === 'demo' ? 'on' : ''} disabled={busy || autoSpin} title="Play with demo $TICS" onClick={() => chooseMode('demo')}>Demo</button>}
            </div>}
          </div>
          <div className="gold-text slot-balance-amount"><span data-balance-target="header" data-testid="header-balance" data-mode={mode}>{user && shownBalance != null ? (layout === 'portrait' ? fmtShort(shownBalance) : fmtMoney(shownBalance)) : '...'}</span></div>
        </div>
        {profile ? (
          <button type="button" className={`wallet-chip ${walletOpen ? 'open' : ''}`} data-testid="wallet-chip" aria-expanded={walletOpen} onClick={() => setWalletOpen(true)} title="Your profile">
            <span className="wallet-chip-text">{shortAddress(profile.address)}</span><Avatar address={profile.address} size={mobile ? 22 : 28} className="wallet-chip-avatar" />
          </button>
        ) : (
          <button type="button" className="wallet-connect" data-testid="wallet-connect" onClick={session.requestConnect} disabled={session.walletBusy || busy || autoSpin}>
            {session.walletBusy ? 'Connecting...' : <><span className="wc-long">Connect wallet</span><span className="wc-short">Connect</span></>}
          </button>
        )}
      </div>
      <GameToast toasts={toasts} onDismiss={(kind) => { if (kind === 'error') setError(null); if (kind === 'info') setNotice(null); }} />
    </header>

    <main className="slot-main" inert={anyModal ? true : undefined}>
      <section className="slot-stage">
        {/* felt-table: the shared win celebration centres its banner on this element */}
        <div className={`slot-vault felt-table${freeMode ? ' free' : ''}${anticipationFrom != null ? ' tense' : ''}`} data-testid="slot-vault">
          <div className="slot-vault-bar">
            {freeMode ? <><span key={`fc-${counterFlash}`} className={`slot-free-count${counterFlash ? ' flash' : ''}`} data-testid="slot-free-count">{C.freeSpins(freeLeft)}</span><span className="slot-x2" data-testid="slot-x2">{C.doubled}</span></>
              : banner?.kind === 'win' || banner?.kind === 'total' ? <span className="slot-last-win">{banner.kind === 'total' ? C.total : 'Win'} <b>{fmtMoney(banner.kind === 'total' ? banner.amount : winShown)}</b></span>
                : <span className="slot-vault-title">{C.subtitle}</span>}
          </div>
          <Reels grid={grid} stops={stops} reelStates={reelStates} spinKey={spinKey} activeLine={activeLine} winCells={winCells} dimming={dimming} scatterHot={scatterHot} anticipationFrom={anticipationFrom} onTap={skip} dust={mobile ? 8 : 16}>
            <AnimatePresence>
              {door && <motion.div key="door" className="slot-door" initial={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }} aria-hidden="true">
                <div className="slot-door-leaf left" /><div className="slot-door-leaf right" />
                <div className="slot-door-seam" /><div className="slot-door-dust" /><div className="slot-door-dust two" /><div className="slot-door-dust three" />
              </motion.div>}
              {burstKey > 0 && phase === 'presenting' && banner?.kind === 'win' && <div key={`coins-${burstKey}`} className="slot-coins" aria-hidden="true">
                {COIN_BURST.slice(0, mobile ? 8 : 14).map((c, i) => <i key={i} style={{ '--dx': c.dx, '--dy': c.dy, '--rot': c.rot, '--t': c.t, '--delay': c.delay }} />)}
              </div>}
              {celebration && <div key={`rain-${spinKey}`} className="slot-rain" aria-hidden="true">
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
    <SoundSettingsDialog open={soundOpen} onClose={() => setSoundOpen(false)} />
    <AnimatePresence>
      {walletOpen && profile && <WalletPanel profile={profile} wallet={user} mobile={mobile} deposit={null} onTopUp={() => setNotice('Top ups are made on the roulette page for now.')}
        onRefresh={async () => { await Promise.all([session.refreshProfile(), session.refreshWallet()]); }} onDisconnect={async () => { setWalletOpen(false); await session.disconnectWallet(); }}
        disconnectDisabled={busy || autoSpin} onClose={() => setWalletOpen(false)} />}
    </AnimatePresence>
    <AnimatePresence>{paytableOpen && <SlotPaytable stake={bet} mobile={mobile} onClose={() => setPaytableOpen(false)} />}</AnimatePresence>
    <AnimatePresence>{fairnessOpen && <SlotFairness round={lastRound} receipt={lastReceipt} verdict={lastVerdict} mobile={mobile} onClose={() => setFairnessOpen(false)} />}</AnimatePresence>
    {!session.ageOk && <AgeGate onAccept={session.acceptAge} />}
    {session.ageOk && session.connectNoticeOpen && <ConnectNotice onContinue={session.continueConnect} onClose={session.closeConnectNotice} />}
  </div>;
}
