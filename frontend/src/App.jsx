import { useEffect, useLayoutEffect, useState, useCallback, useRef } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import RouletteWheel from './RouletteWheel.jsx';
import PocketCloseup from './PocketCloseup.jsx';
import MobileRoundFeedback from './MobileRoundFeedback.jsx';
import { useInbox } from './Inbox.jsx';
import GameHeader from './GameHeader.jsx';
import ProfileSheet from './ProfileSheet.jsx';
import { headerLayout } from './headerModel.js';
import { lockBackgroundScroll } from './modalScrollLock.js';
import RouletteBoard from './RouletteBoard.jsx';
import RecentNumbers from './RecentNumbers.jsx';
import RoundDetail from './RoundDetail.jsx';
import { Chip } from './ChipView.jsx';
import { DENOMS, CHIP_VALUES, fmtShort, fmtMoney, overMaxBet } from './chips.js';
import GameToast, { toastTitle } from './GameToast.jsx';
import CasinoReserve, { refreshCasinoReserve, useCasinoReserve } from './CasinoReserve.jsx';
import SupportLink from './Support.jsx';
import { AgeGate } from './Terms.jsx';
import ConnectNotice from './ConnectNotice.jsx';
import { needsConnectNotice, acceptConnectNotice } from './connectNotice.js';
import { walletApi, resolveMode, modeBalance, balanceField, STORAGE, DEPOSIT_FINAL, restoreSavedDeposit, saveDepositFor, clearDepositFor, isSignedInElsewhere } from './walletApi.js';
import { usePlayGuard, PlayCover } from './PlayGuard.jsx';
import { topUpState, DEPOSIT_PAUSED_MESSAGE, DEPOSITS_CLOSED_MESSAGE, OFFICIAL_TICS, CASINO_WALLET, CHAIN_ID } from './depositTarget.js';
import { classifySpinRefusal, budgetFor, recordRefusal, refusalStopMessage, refusalRetiredMessage, rememberOpenLock, updateOpenLock, forgetOpenLock, findOpenLock, mustRetireLock, locksToCheck, findRoundForLock,
  addRefusedSpin, readRefusedLog, canAcceptReloadedLock, isBalanceResync, OPEN_LOCK_GRACE_MS, REFUSAL_NO_LOCK_MESSAGE, SIGN_IN_EXPIRED_MESSAGE, TABLE_CHANGED_MESSAGE, LOST_REPLY_MESSAGE,
  LOST_REPLY_PAUSED_MESSAGE, OTHER_DEVICE_MESSAGE, OTHER_DEVICE_ALONE_MESSAGE, OWN_ROUND_SWAPPED_MESSAGE, STALE_LOCK_MESSAGE, NEVER_OPENED_MESSAGE, ownRoundProblems, wouldHaveWon, wouldHaveText,
  BALANCE_RESYNC_MESSAGE, shortCreditMessage, postJsonWithTimeout, checkRefusalAgainstKnown, OTHER_TAB_MESSAGE } from './spinRefusal.js';
import { startPresence, otherTabRecently, tabIdFor } from './tabPresence.js';
import WinCelebration from './WinCelebration.jsx';
import FairnessSheet, { FairFlow, RefusedSpins } from './FairnessSheet.jsx';
import { chefLockUrl } from './fairnessLinks.js';
import { winTier, celebrationTiming } from './winCelebration.js';
import { ensureAudioContext, playLose, playChaChing, playCountTick, playChip, playChipSelect, playChipRemove, playDeny } from './sound.js';
import { verifyOutcomeClientSide, verifySettlement, combineVerification, settlementFromRound, withoutBalance, settlementForProof, standaloneVerifyScript, isCommitmentValid, canStartRound, createRoundRequest, saveRoundReceipt, readRoundReceipt, readRevealedHashes, rememberRevealedSeed, isNextCommitmentSafe, sha256Hex, pocketFor, verifyRevealedRound } from './fairnessClient.js';
import { playVoice, playNumberCallout, prepareNumberCallout, setBettingOpen } from './voice.js';
import { didBetWin, payoutCentsFor, betLabel, coveredNumbers, pocketColor, setPayoutTable, maxPayoutUnits, straightMultiplier, checkPayoutTable, isTableConfirmed, confirmTable, describeTableDifferences } from './rouletteRules.js';
import { displayedBalanceCents, tableFitsBalance } from './balanceDisplay.js';

const API = '/api';
const CHIPS = CHIP_VALUES; // units of 0.01 TICS: 1, 5, 10, 50, 100, 500, 1K, 5K TICS
const fmt = fmtMoney; // 1,234.50 TICS
const readStore = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const writeStore = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } };
const local = () => { try { return localStorage; } catch { return null; } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const WALLET_STALE_MS = 10000; // older than this, the balance is fetched again right before a spin
const LOST_REPLY_WAIT_MS = 20000; // how long a spin with no reply is looked for in the round history
const LOST_REPLY_POLL_MS = 2000;
let walletModule = null; // lazily imported wallet bundle (wagmi + viem + AppKit)
const loadWalletModule = () => (walletModule ||= import('./walletConnect.js'));

function betKey(type, value) {
  const v = Array.isArray(value) ? [...value].sort((a, b) => a - b).join(',') : value;
  return `${type}:${v}`;
}

// Reveal order for the theatrical payout sequence: the number itself first,
// then bets that cover it in progressively wider groups — mirrors how a
// real dealer pays the "closest" bets first. Ties (e.g. two splits) just
// keep their original order.
const TYPE_PRIORITY = {
  straight: 0,
  split: 1,
  trio: 2,
  street: 2,
  corner: 3,
  sixline: 4,
};
// The server's own payout for a bet (it already used the live payout table).
function serverPayout(data, bet) {
  const key = betKey(bet.type, bet.value);
  const hit = (data.betResults || []).find((r) => betKey(r.type, r.value) === key);
  return hit ? hit.payoutCents : null;
}

function typePriority(type) {
  return type in TYPE_PRIORITY ? TYPE_PRIORITY[type] : 5; // outside bets reveal last
}

export default function App() {
  const [user, setUser] = useState(null);
  const [refilling, setRefilling] = useState(false);
  const [chip, setChip] = useState(500);
  const [bets, setBets] = useState([]);
  const [betHistory, setBetHistory] = useState([]); // for Undo — one entry per chip placed, in order
  const [spinning, setSpinning] = useState(false);
  const [landingPocket, setLandingPocket] = useState(null);
  const reduceMotion = useReducedMotion();
  const [spinToken, setSpinToken] = useState(null);
  const [lastPocket, setLastPocket] = useState(0);
  const [settledPocket, setSettledPocket] = useState(null); // only set once a spin settles — drives the dolly + win highlights on the felt
  const [lastResult, setLastResult] = useState(null);
  const [showResults, setShowResults] = useState(false); // true once the win popup is done: winners glow on the felt, losers dim
  const [lockCopied, setLockCopied] = useState(false);
  const [retiredLock, setRetiredLock] = useState(null); // { serverSeed, serverSeedHash, fits } after a player-requested new lock
  const [payoutPops, setPayoutPops] = useState([]); // winning wagers whose "+$" pop is showing on the felt
  const winPopup = null; // the per-bet payout card was replaced by on-felt pops
  const [hoverInfo, setHoverInfo] = useState(null);
  const [recentNumbers, setRecentNumbers] = useState([]); // last pockets, newest first — wins AND losses
  const recentSeeded = useRef(false);
  const [detailRound, setDetailRound] = useState(null); // round opened from Recent Rounds
  const [revealPhase, setRevealPhase] = useState('idle'); // 'idle' | 'revealing' | 'totaling'
  const [revealTotalCents, setRevealTotalCents] = useState(0);
  const [transferAmountCents, setTransferAmountCents] = useState(null); // counts down from the win total to 0 while the balance counts up by the same amount
  const [balanceOverrideCents, setBalanceOverrideCents] = useState(null); // transient count-up value shown while animating into the balance
  const [committedStakeCents, setCommittedStakeCents] = useState(0); // stake deducted from the shown balance from Spin until the settled balance arrives
  const [history, setHistory] = useState([]);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [verifyResult, setVerifyResult] = useState(null);
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [sheet, setSheet] = useState(null); // { tab } while the profile pop-up is open
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null); // neutral info (e.g. table cleared), not an error
  const [lastBets, setLastBets] = useState([]);
  const pendingResultRef = useRef(null);
  const skipReveal = useRef(false); // set true by the Skip button during the payout popup
  const continueRef = useRef(false); // set true by the Collect button once every winner is shown
  const controlsRef = useRef(null);
  const [controlsHeight, setControlsHeight] = useState(0);
  useEffect(() => {
    const node = controlsRef.current;
    if (!node) return;
    const measure = () => setControlsHeight(Math.ceil(node.getBoundingClientRect().height));
    const observer = new ResizeObserver(measure); observer.observe(node); measure();
    return () => observer.disconnect();
  }, []);
  const [autoSpin, setAutoSpin] = useState(false);
  const autoSpinRef = useRef(false); // mirrors autoSpin for use inside the async handleSettled loop, which closes over state at call time otherwise

  // Wallet profile (null = not connected), 18+ gate, Real/Demo choice and the top up being tracked.
  const [profile, setProfile] = useState(null);
  const [ageOk, setAgeOk] = useState(() => readStore(STORAGE.adult) === '1');
  const [connectNoticeOpen, setConnectNoticeOpen] = useState(false); // shown once per browser before the wallet picker
  const [storedMode, setStoredMode] = useState(() => readStore(STORAGE.mode));
  const [walletBusy, setWalletBusy] = useState(false);
  const [deposit, setDeposit] = useState(null);
  const walletAtRef = useRef(0); // when the balances were last read from the server
  const loadSession = useCallback(async (identity) => {
    const u = await walletApi.session();
    walletAtRef.current = Date.now();
    setUser({ ...u, identity });
  }, []);
  // The top up being tracked for THIS wallet (saved per wallet; other wallets' entries stay).
  const restoreDeposit = (p) => {
    const d = p?.address ? restoreSavedDeposit(local(), p.address) : null;
    setDeposit(d ? { txHash: d.txHash, address: p.address, status: 'pending', confirmations: 0, required: p.confirmations } : null);
  };
  const [elsewhere, setElsewhere] = useState(null); // server text after this wallet signed in from another browser
  useEffect(() => {
    (async () => {
      let p = null;
      try { p = await walletApi.me(); } catch (e) { if (isSignedInElsewhere(e)) { setElsewhere(e.message); p = null; } }
      setProfile(p);
      await loadSession(p?.address || 'guest');
      // Only a well-formed tx hash for this wallet is tracked.
      if (p) restoreDeposit(p);
    })().catch((e) => setError(String(e.message || e)));
  }, [loadSession]);

  // Provably-fair commitment: the hash of the server seed the NEXT spin will
  // use, visible before a single bet is placed — plus the player's own
  // editable client seed. Fetched once the user is known, then kept in sync
  // from each spin's response (`fairness.nextCommitment`) with no extra
  // round-trip.
  const [commitment, setCommitment] = useState(null); // { serverSeedHash, clientSeed, nonce }
  const commitmentRef = useRef(null);
  commitmentRef.current = commitment;
  const [clientSeedDraft, setClientSeedDraft] = useState('');
  const [clientSeedSaving, setClientSeedSaving] = useState(false);
  const [autoVerify, setAutoVerify] = useState(null);
  const [verificationBlocked, setVerificationBlocked] = useState(false);
  const verificationBlockedRef = useRef(false);
  const manualCheckingRef = useRef(false);
  const verifyGenerationRef = useRef(0);
  const operationRef = useRef(null); // synchronous exclusion for seed saves / wager requests
  const autoTimerRef = useRef(null);

  // This tab's heartbeat, so a lock "used by another tab" can be checked against the tabs really open.
  const presenceRef = useRef(null);
  const [tabId] = useState(() => { try { return tabIdFor(); } catch { return null; } }); // the same id startPresence keeps
  useEffect(() => { const p = startPresence(); presenceRef.current = p; return () => p.stop(); }, []);
  // One tab at a time: this tab announces its spins; another tab's spin covers the felt for 8 s.
  const guard = usePlayGuard({ game: 'roulette', tabId });

  const stopForVerification = (message) => {
    // Tell the operator: fairness failures raise an alert in the admin panel.
    fetch(`${API}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'fairness_fail', detail: String(message || 'verification failed') }) }).catch(() => {});
    verificationBlockedRef.current = true;
    setVerificationBlocked(true);
    autoSpinRef.current = false;
    setAutoSpin(false);
    clearTimeout(autoTimerRef.current);
    setError(message || 'Verification failed. Auto-bet stopped and further bets are blocked. Inspect the round proof before continuing.');
  };

  // Swap a lock for a fresh one through the reveal: the server shows the old key, this browser
  // checks it fits the old lock, and only then accepts the new lock. Used by "Get a new lock",
  // after a refused spin and for a lock that saw a refused spin before a reload.
  // Returns { ok, commitment, retired, fits, problem } where problem means "stop betting".
  const retireLock = async (expectedCommitment) => {
    const resp = await fetch(`${API}/fairness/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedCommitment }),
    });
    let data = {};
    try { data = await resp.json(); } catch { data = {}; }
    if (!resp.ok || !isCommitmentValid(data.commitment)) return { ok: false, error: data.error || 'A new lock could not be made.' };
    const fits = typeof data.retired?.serverSeed === 'string' && await sha256Hex(data.retired.serverSeed) === expectedCommitment.serverSeedHash
      && data.retired.serverSeedHash === expectedCommitment.serverSeedHash;
    if (/^[a-f0-9]{64}$/.test(data.retired?.serverSeedHash || '')) rememberRevealedSeed(data.retired.serverSeedHash); // a retired lock must never come back
    setRetiredLock({ ...data.retired, fits });
    // The new lock is only accepted when the old key fits the old lock and the new lock is fresh,
    // with the same lucky word and a nonce of 0. Anything else stops betting.
    const fresh = isNextCommitmentSafe(data.commitment, { serverSeedHash: expectedCommitment.serverSeedHash, clientSeedBase: expectedCommitment.clientSeed }, readRevealedHashes());
    if (!fits) return { ok: false, problem: 'The old key the server revealed does not fit the old lock. Betting is stopped. Inspect the proof before continuing.' };
    if (!fresh) return { ok: false, problem: 'The new lock from the server is not a fresh lock. Betting is stopped. Inspect the proof before continuing.', retired: data.retired, fits };
    forgetOpenLock(expectedCommitment.serverSeedHash);
    return { ok: true, commitment: Object.freeze({ ...data.commitment }), retired: data.retired, fits };
  };

  // Opens a lock whose random value was sent (refused spin, lost reply, reload) through the reveal,
  // then works out where that spin would have landed and keeps it in the refused-spins log.
  // `current` is the lock as the server holds it now (the lucky word may have been changed since).
  // `terms` are the bets this browser sent (else read from the saved pre-bet receipt), so the log and
  // the toast can say what the refused spin would have won.
  const openAndLog = async (entry, kind, reason, current = null, terms = null) => {
    let swap;
    try { swap = await retireLock(current || { serverSeedHash: entry.serverSeedHash, clientSeed: entry.clientSeed, nonce: entry.nonce }); } catch (e) { swap = { ok: false, error: e.message }; }
    if (swap.fits && typeof swap.retired?.serverSeed === 'string') {
      let pocket = null;
      try { pocket = await pocketFor({ serverSeed: swap.retired.serverSeed, clientSeed: `${entry.clientSeed}:${entry.clientEntropy}`, nonce: entry.nonce, max: 37 }); } catch { pocket = null; }
      const t = terms || readRoundReceipt(entry.requestId, null)?.terms || null;
      const won = pocket === null ? null : wouldHaveWon(t?.bets, pocket, t?.multipliers);
      addRefusedSpin({ lock: entry.serverSeedHash, pocket, won, kind, reason });
      swap = { ...swap, wouldHave: wouldHaveText(pocket, won) };
    }
    return swap;
  };

  // Takes the server's current lock after the old one was shown to be used elsewhere (or settled).
  const adoptCurrentLock = async (oldHash, expected = null) => {
    const r = await fetch(`${API}/fairness/commitment`);
    const c = await r.json();
    const revealed = readRevealedHashes();
    const ok = r.ok && isCommitmentValid(c) && c.serverSeedHash !== oldHash && !revealed.includes(c.serverSeedHash)
      && (!expected || isNextCommitmentSafe(c, expected, revealed));
    if (!ok) throw new Error('Unable to load a valid pre-bet commitment. Betting remains disabled.');
    setCommitment(Object.freeze({ ...c }));
    setClientSeedDraft(c.clientSeed);
  };

  const fetchRounds = async () => {
    const r = await fetch(`${API}/rounds`);
    if (!r.ok) throw new Error('The round history could not be loaded.');
    const rows = await r.json();
    return Array.isArray(rows) ? rows : [];
  };

  // Another device or tab may have used this lock while this page sat idle. No bet of ours was on it (our
  // random value for it was never sent), so the server learned nothing from us: when the history shows the
  // old key really opens the old lock, move to the new lock without counting anything. Anything unusual is
  // left alone, so the next spin's own checks decide.
  const syncIdleLock = async () => {
    if (!user || busyRef.current || operationRef.current || verificationBlockedRef.current) return;
    const cur = commitmentRef.current;
    if (!cur || findOpenLock(cur.serverSeedHash, user.identity || 'guest')) return;
    const r = await fetch(`${API}/fairness/commitment`);
    if (!r.ok) return;
    const c = await r.json();
    if (!isCommitmentValid(c) || c.serverSeedHash === cur.serverSeedHash) return;
    const round = (await fetchRounds()).find((x) => x && x.server_seed_hash === cur.serverSeedHash);
    if (!round || !(await verifyRevealedRound(round)).ok) return;
    if (busyRef.current || operationRef.current || commitmentRef.current !== cur) return;
    try { rememberRevealedSeed(cur.serverSeedHash); } catch { /* storage full: the server never reuses a seed */ }
    await adoptCurrentLock(cur.serverSeedHash);
    refreshHistory(); walletAtRef.current = 0; pendingRefreshRef.current = true;
  };
  const syncIdleLockRef = useRef(null);
  syncIdleLockRef.current = syncIdleLock;

  // Locks whose random value was sent but whose key this browser never checked (page closed, a
  // refusal whose lock could not be opened, a lock the server swapped). Each one is looked up in the
  // round history: a settled round is verified and cleared, a missing one counts as an unexpected
  // refusal and the player is told.
  const checkOpenLocks = async (identity, currentHash) => {
    if (!currentHash || verificationBlockedRef.current) return;
    const list = locksToCheck(identity, currentHash);
    if (!list.length) return;
    let rounds;
    try { rounds = await fetchRounds(); } catch { return; } // try again on the next load
    let warn = false;
    for (const entry of list) {
      const hit = findRoundForLock(rounds, entry);
      if (hit && !hit.own) {
        // Used by a spin this browser did not make: counted, and its would-have pocket logged.
        if (!(await acceptOtherDeviceRound(hit.round, entry, null, { adopt: false, checkAlone: false }))) return;
        warn = false;
        continue;
      }
      if (hit) {
        // This browser's own spin: it must use exactly the lucky word, random value and nonce that
        // were sent, and pay what the saved pre-bet receipt says.
        const swapped = ownRoundProblems(hit.round, entry);
        if (swapped.length) { stopForVerification(`${OWN_ROUND_SWAPPED_MESSAGE} (${swapped.join(', ')})`); return; }
        const v = await verifyRevealedRound(hit.round);
        if (!v.ok) { stopForVerification(`An earlier spin does not check out (${v.reason}). Betting is stopped. Inspect the round before continuing.`); return; }
        const receipt = readRoundReceipt(entry.requestId, hit.round.id);
        if (receipt?.terms) {
          // The history has no balance after the spin, so the balance line is not checked here.
          const { balanceBefore: _unused, ...terms } = receipt.terms;
          const paid = verifySettlement(terms, settlementFromRound(hit.round), didBetWin);
          if (!paid.ok) { stopForVerification(`An earlier spin does not check out (Payout check failed: ${paid.problems.join(', ')}). Betting is stopped. Inspect the round before continuing.`); return; }
          try { saveRoundReceipt(receipt, hit.round.id); } catch { /* storage full */ }
        }
        try { rememberRevealedSeed(hit.round.server_seed_hash); } catch { /* storage full: the server never reuses a seed */ }
        forgetOpenLock(entry.serverSeedHash);
        continue;
      }
      forgetOpenLock(entry.serverSeedHash);
      addRefusedSpin({ lock: entry.serverSeedHash, pocket: null, kind: 'never_opened', reason: 'The server never showed this key' });
      warn = true;
      if (!entry.counted) {
        const r = recordRefusal('unpredicted');
        if (r.reached) { stopForVerification(refusalStopMessage('unpredicted', r.count)); return; }
      }
    }
    if (warn && !verificationBlockedRef.current) setNotice(NEVER_OPENED_MESSAGE);
  };

  // Loads the current lock. After a failed request `previousHash` is the lock the browser had: a
  // different lock without the old key being shown is never accepted. A lock that saw a refused
  // spin is only replaced through the reveal.
  const reloadCommitment = async (previousHash = null) => {
    if (!user) return;
    const r = await fetch(`${API}/fairness/commitment`);
    const c = await r.json();
    if (!r.ok || !isCommitmentValid(c) || readRevealedHashes().includes(c.serverSeedHash)) throw new Error('Unable to load a valid pre-bet commitment. Betting remains disabled.');
    if (!canAcceptReloadedLock(c, previousHash)) throw new Error('The server changed the lock without showing the old key, so betting stays paused. Reload the page or contact support.');
    // A lock that saw a refused spin, or whose spin never got a reply, is only replaced through the reveal.
    const open = findOpenLock(c.serverSeedHash, user.identity || 'guest');
    if (open && mustRetireLock(open)) {
      const swap = await openAndLog(open, 'lost', open.refused ? 'Refused before this page was reloaded' : 'The page closed before the reply',
        { serverSeedHash: c.serverSeedHash, clientSeed: c.clientSeed, nonce: c.nonce });
      if (swap.problem) { setCommitment(null); stopForVerification(swap.problem); return null; }
      if (!swap.ok) throw new Error(REFUSAL_NO_LOCK_MESSAGE);
      setCommitment(swap.commitment);
      setClientSeedDraft(swap.commitment.clientSeed);
      return swap.commitment.serverSeedHash;
    }
    setCommitment(Object.freeze({ ...c }));
    setClientSeedDraft(c.clientSeed);
    return c.serverSeedHash;
  };
  useEffect(() => {
    if (!user) return undefined;
    const identity = user.identity || 'guest';
    reloadCommitment().then((hash) => checkOpenLocks(identity, hash)).catch((e) => setError(e.message));
    // Locks another tab may still have been spinning on are looked at once they are old enough.
    const timer = setTimeout(() => {
      if (!operationRef.current) checkOpenLocks(identity, commitmentRef.current?.serverSeedHash || null).catch(() => {});
    }, OPEN_LOCK_GRACE_MS + 1000);
    return () => clearTimeout(timer);
  }, [user?.identity]);

  // Live game settings from the admin panel: open or closed, limits, payout table.
  const [gameConfig, setGameConfig] = useState(null);
  const loadGameConfig = useCallback(async () => {
    try {
      const r = await fetch(`${API}/games/roulette/config`);
      if (!r.ok) return;
      const c = await r.json();
      // Only a valid table is used for display; an invalid one pauses betting (see tableCheck).
      const check = checkPayoutTable(c.math);
      setPayoutTable(check.ok ? check.multipliers : null);
      setGameConfig(c);
    } catch { /* keep the last known settings */ }
  }, []);
  useEffect(() => {
    if (!user) return;
    loadGameConfig();
    const timer = setInterval(loadGameConfig, 30000);
    const onFocus = () => { loadGameConfig(); syncIdleLockRef.current?.().catch(() => {}); };
    window.addEventListener('focus', onFocus);
    // Analytics: screen size once per visit (device and country come from the request).
    fetch(`${API}/events`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'screen', screen: `${window.screen.width}x${window.screen.height}` }) }).catch(() => {});
    // Session length for analytics, sent when the player leaves the page.
    const started = Date.now();
    const onHide = () => navigator.sendBeacon?.(`${API}/events`, new Blob([JSON.stringify({ type: 'session_end', seconds: Math.round((Date.now() - started) / 1000) })], { type: 'application/json' }));
    window.addEventListener('pagehide', onHide);
    return () => { clearInterval(timer); window.removeEventListener('focus', onFocus); window.removeEventListener('pagehide', onHide); };
  }, [user?.identity, loadGameConfig]);
  const gameClosed = gameConfig?.enabled === false;
  // Payout table: never above standard. A lower table must be accepted once (per exact table).
  const tableCheck = checkPayoutTable(gameConfig?.math);
  const tableInvalid = !tableCheck.ok;
  const [confirmedTableKey, setConfirmedTableKey] = useState(null);
  // tableRecheck: the server said the table changed while betting, so the player confirms again.
  const [tableRecheck, setTableRecheck] = useState(false);
  const tableNeedsConfirm = tableCheck.ok && ((tableCheck.lower && confirmedTableKey !== tableCheck.key && !isTableConfirmed(tableCheck.key)) || (tableRecheck && !!gameConfig));
  const [tableNoticeOpen, setTableNoticeOpen] = useState(false);
  useEffect(() => { if (tableNeedsConfirm) setTableNoticeOpen(true); }, [tableNeedsConfirm, tableCheck.key]);
  const acceptTable = () => { if (tableCheck.lower) confirmTable(tableCheck.key); setConfirmedTableKey(tableCheck.key); setTableRecheck(false); setTableNoticeOpen(false); };

  // Swap in a brand-new lock before the next spin. The old key was never used,
  // so the server reveals it and the player can check it fits the old lock.
  const rotateLock = async () => {
    if (!user || busy || manualCheckingRef.current || autoSpinRef.current || operationRef.current || verificationBlockedRef.current || !isCommitmentValid(commitment)) return;
    operationRef.current = 'rotate';
    setClientSeedSaving(true);
    const expectedCommitment = { ...commitment };
    try {
      const swap = await retireLock(expectedCommitment);
      if (swap.problem) { setCommitment(null); stopForVerification(swap.problem); return; }
      if (!swap.ok) throw new Error(swap.error);
      setCommitment(swap.commitment);
      setError(null);
    } catch (e) {
      setError(e.message);
      setCommitment(null);
      try { await reloadCommitment(expectedCommitment.serverSeedHash); } catch (err) { setError(err.message); }
    } finally {
      operationRef.current = null;
      setClientSeedSaving(false);
    }
  };

  const saveClientSeed = async () => {
    if (!user || busy || manualCheckingRef.current || autoSpinRef.current || operationRef.current || verificationBlockedRef.current || !isCommitmentValid(commitment)
      || !clientSeedDraft.trim() || clientSeedDraft.trim() === commitment.clientSeed) return;
    operationRef.current = 'seed';
    setClientSeedSaving(true);
    const expectedCommitment = { ...commitment };
    try {
      const resp = await fetch(`${API}/fairness/client-seed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientSeed: clientSeedDraft.trim(), expectedCommitment }),
      });
      const c = await resp.json();
      if (!resp.ok || !isCommitmentValid(c)) throw new Error(c.error || 'Client seed could not be saved.');
      // Changing the lucky word must keep the same lock and nonce, and the lock must never be a revealed one.
      if (c.serverSeedHash !== expectedCommitment.serverSeedHash || c.nonce !== expectedCommitment.nonce || c.clientSeed !== clientSeedDraft.trim()
        || readRevealedHashes().includes(c.serverSeedHash)) {
        setCommitment(null);
        stopForVerification('The server changed the lock while saving your lucky word. Betting is stopped. Inspect the proof before continuing.');
        return;
      }
      setCommitment(Object.freeze({ ...c }));
      setClientSeedDraft(c.clientSeed);
      setError(null);
    } catch (e) {
      setError(e.message);
      setCommitment(null);
      try { await reloadCommitment(expectedCommitment.serverSeedHash); } catch (err) { setError(err.message); }
    } finally {
      operationRef.current = null;
      setClientSeedSaving(false);
    }
  };

  const refreshHistory = useCallback(() => {
    fetch(`${API}/rounds`)
      .then((r) => r.json())
      .then(setHistory)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (user) refreshHistory();
  }, [user?.identity, refreshHistory]);

  // Seed the "last 20 numbers" strip from past rounds once; after that it's
  // updated live the moment each spin settles.
  useEffect(() => {
    if (recentSeeded.current || history.length === 0) return;
    recentSeeded.current = true;
    const nums = history
      .map((r) => { try { return r.outcome_json ? { id: `r${r.id}`, n: JSON.parse(r.outcome_json).pocket } : null; } catch { return null; } })
      .filter((x) => x && x.n != null)
      .slice(0, 20);
    setRecentNumbers((prev) => (prev.length ? prev : nums));
  }, [history]);

  // Nothing may start while a spin is running, the win popup is open, or the
  // payout finale is still playing — covers buttons, keyboard and Space on a focused button.
  const busy = refilling || spinning || revealPhase !== 'idle' || !!winPopup;
  // A loaded game config (limits and the payout table) is needed before any spin.
  const readyToSpin = canStartRound({ commitment, busy, saving: clientSeedSaving, failed: verificationBlocked || !gameConfig || gameClosed || tableInvalid, checking: verifyLoading });
  // The dealer's "place your bets" follows the round only. Opening Proof, saving a
  // seed or rotating the lock briefly pauses Spin but must not re-announce it.
  const roundOpen = !!user && !busy && !verificationBlocked && !autoSpin && !gameClosed;
  useEffect(() => {
    setBettingOpen(false);
    if (!roundOpen) return;
    // Allow AnimatePresence's outgoing transfer/result panels to finish
    // fading before the opening call. Any new spin cancels this handoff.
    const timer = setTimeout(() => setBettingOpen(true), 350);
    return () => clearTimeout(timer);
  }, [roundOpen]);
  useEffect(() => () => setBettingOpen(false), []);
  const totalStaked = bets.reduce((sum, b) => sum + b.amountCents, 0);
  // Synchronous mirror of what's staked, so a burst of rapid clicks (several
  // inside one render) can never spend the same balance twice.
  const stakedRef = useRef(0);
  stakedRef.current = totalStaked;
  // Chips on the table are shown under "On table" and do not reduce the
  // balance; the stake comes off only when Spin is pressed. While the
  // win-reveal transfer animates, `balanceOverrideCents` takes over.
  // Real or Demo: one balance at a time, the one the next spin uses.
  const modeInfo = resolveMode({ stored: storedMode, wallet: user, profile });
  const mode = modeInfo.mode;
  const balanceNow = modeBalance(user, mode);
  const displayBalanceCents = displayedBalanceCents({ balanceCents: balanceNow, committedStakeCents, overrideCents: balanceOverrideCents });
  const busyRef = useRef(false);
  busyRef.current = busy || autoSpin;
  const pendingRefreshRef = useRef(false);
  // Balances from the server, never applied in the middle of a round (it would double count the stake).
  const refreshWallet = useCallback(async () => {
    if (busyRef.current) { pendingRefreshRef.current = true; return; }
    pendingRefreshRef.current = false;
    try { const w = await walletApi.wallet(); walletAtRef.current = Date.now(); setUser((u) => (u ? { ...u, ...w } : u)); } catch { /* keep the last known */ }
  }, []);
  const switchIdentityRef = useRef(null);
  // The wallet signed in from another browser: the server closed this session. Auto stops, the page goes back to Demo.
  const signedOutElsewhere = useCallback(async (e) => {
    setElsewhere(e?.message || 'You connected this wallet in another browser or device. Connect again to play here.');
    setSheet(null); setDeposit(null);
    await switchIdentityRef.current?.(null).catch(() => {});
  }, []);
  const refreshProfile = useCallback(async () => {
    try { const p = await walletApi.me(); if (p) setProfile(p); }
    catch (e) { if (isSignedInElsewhere(e)) await signedOutElsewhere(e); }
  }, [signedOutElsewhere]);
  useEffect(() => { if (!busy && !autoSpin && pendingRefreshRef.current) refreshWallet(); }, [busy, autoSpin, refreshWallet]);
  // Poll the profile while connected, so a session closed elsewhere is noticed within about 15 s.
  const connected = !!profile?.address;
  useEffect(() => {
    if (!connected) return undefined;
    const t = setInterval(() => { refreshProfile(); }, 10000);
    return () => clearInterval(t);
  }, [connected, refreshProfile]);
  // Changing mode (or being moved to Real by a top up) clears the table: chips belong to one balance.
  const lastModeRef = useRef(mode);
  useEffect(() => {
    if (lastModeRef.current === mode) return;
    lastModeRef.current = mode;
    setBets([]); setBetHistory([]); stakedRef.current = 0; setShowResults(false); setLastBets([]);
  }, [mode]);
  const chooseMode = (m) => {
    if (busy || autoSpin || m === mode) return;
    if (m === 'real' && !modeInfo.realAvailable) { setNotice(modeInfo.realReason); return; }
    writeStore(STORAGE.mode, m); setStoredMode(m); setError(null); setNotice(null);
  };

  // A different player (wallet connected or disconnected): new balances, lock and history.
  const switchIdentity = async (p) => {
    clearTimeout(autoTimerRef.current); autoSpinRef.current = false; setAutoSpin(false);
    setBets([]); setBetHistory([]); stakedRef.current = 0; setLastBets([]); setLastResult(null); setSettledPocket(null);
    setShowResults(false); setRecentNumbers([]); recentSeeded.current = false; setHistory([]); setCommitment(null); setAutoVerify(null);
    setNotice(null); setError(null); setRetiredLock(null);
    setProfile(p);
    await loadSession(p?.address || 'guest');
  };
  switchIdentityRef.current = switchIdentity;
  const connectWallet = async () => {
    if (walletBusy || busy || autoSpin) return;
    setWalletBusy(true); setError(null); setElsewhere(null);
    try {
      const w = await loadWalletModule();
      const p = await w.signIn();
      await walletApi.terms().catch(() => {});
      await switchIdentity(p);
      restoreDeposit(p);
      await refreshProfile();
    } catch (e) { setError(e.message || 'The wallet could not connect.'); }
    finally { setWalletBusy(false); }
  };
  // Connect wallet: the first time in this browser, the custody / fairness / beta notice comes first.
  const requestConnect = () => { if (walletBusy || busy || autoSpin) return; if (needsConnectNotice()) setConnectNoticeOpen(true); else connectWallet(); };
  const continueConnect = () => { acceptConnectNotice(); setConnectNoticeOpen(false); connectWallet(); };
  const closeConnectNotice = useCallback(() => setConnectNoticeOpen(false), []);
  const disconnectWallet = async () => {
    if (busy || autoSpin) return;
    await walletApi.logout().catch(() => {});
    if (walletModule) walletModule.then((m) => m.disconnectWallet()).catch(() => {});
    setSheet(null); setDeposit(null); // the saved top up stays with that wallet
    await switchIdentity(null).catch((e) => setError(e.message));
  };
  const topUp = async (units) => {
    if (!profile) return;
    // Never send while top ups are closed, or unless the server's token and casino wallet are the
    // ones pinned in this page. The network is pinned too (VITE_CHAIN_ID), never the server's.
    const state = topUpState(profile);
    if (state !== 'open') { setDeposit({ status: 'error', error: state === 'closed' ? DEPOSITS_CLOSED_MESSAGE : DEPOSIT_PAUSED_MESSAGE, final: true }); return; }
    setDeposit({ status: 'sending' });
    try {
      const w = await loadWalletModule();
      const txHash = await w.sendTics({ token: OFFICIAL_TICS, to: CASINO_WALLET, units, chainId: CHAIN_ID, from: profile.address });
      saveDepositFor(local(), profile.address, txHash);
      setDeposit({ txHash, address: profile.address, status: 'pending', confirmations: 0, required: profile.confirmations });
    } catch (e) { setDeposit({ status: 'error', error: e.message, final: true }); }
  };
  // Poll the top up every 10 s until it is credited (or clearly will not be).
  useEffect(() => {
    if (!deposit?.txHash || deposit.final) return;
    let stopped = false;
    const hash = deposit.txHash, owner = deposit.address;
    const check = async () => {
      try {
        const r = await walletApi.depositCheck(hash);
        if (stopped) return;
        const final = DEPOSIT_FINAL.has(r.status);
        setDeposit((d) => (d && d.txHash === hash ? { ...d, ...r, final } : d));
        if (final) { if (owner) clearDepositFor(local(), owner); refreshProfile(); refreshWallet(); }
      } catch { /* network hiccup: try again next tick */ }
    };
    check();
    const t = setInterval(check, 10000);
    return () => { stopped = true; clearInterval(t); };
  }, [deposit?.txHash, deposit?.final, refreshProfile, refreshWallet]);
  const acceptAge = () => { writeStore(STORAGE.adult, '1'); setAgeOk(true); if (profile) walletApi.terms().catch(() => {}); };

  // TEMPORARY staging-only play-money reset. Clear reservations so the
  // displayed available balance is exactly the demo start, not that less old bets.
  const resetDemoBalance = async () => {
    if (busy || autoSpin || !user || operationRef.current) return;
    operationRef.current = 'demo-reset'; setRefilling(true);
    try {
      const response = await fetch(`${API}/demo/reset-balance`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Demo balance could not be reset.');
      setUser(u=>({...u,...result})); setBets([]);setBetHistory([]);stakedRef.current=0;setShowResults(false);setError(null);setNotice(null);
    } catch(e) { setError(e.message); }
    finally { operationRef.current=null;setRefilling(false); }
  };

  // Table limit: the biggest payout the bets on the table could get must fit what the casino can pay
  // on one spin right now (same rule the server enforces, in Demo and Real).
  const reserve = useCasinoReserve();
  const tableLimit = reserve?.live && reserve.maxWinUnits > 0 ? reserve.maxWinUnits : null;
  const overTableLimit = (nextBets) => {
    if (!tableLimit) return null;
    const worst = maxPayoutUnits(nextBets);
    if (worst <= tableLimit) return null;
    const straight = Math.floor(tableLimit / straightMultiplier());
    return `The most you can bet on one number right now is ${fmt(straight)}.`;
  };

  const addBet = ({ type, value }) => {
    if (busy || autoSpin || !user) return;
    if (balanceNow - stakedRef.current < chip) {
      setError('Not enough balance for that chip.');
      playDeny();
      return;
    }
    const overMax = overMaxBet(stakedRef.current, chip, gameConfig?.maxStakeCents);
    if (overMax) { setError(overMax); playDeny(); return; }
    {
      const k = betKey(type, value);
      const found = bets.some((b) => betKey(b.type, b.value) === k);
      const next = found ? bets.map((b) => (betKey(b.type, b.value) === k ? { ...b, amountCents: b.amountCents + chip } : b)) : [...bets, { type, value, amountCents: chip }];
      const overLimit = overTableLimit(next);
      if (overLimit) { setError(overLimit); playDeny(); return; }
    }
    stakedRef.current += chip;
    setError(null);setNotice(null);
    setShowResults(false);
    playChip(chip);
    const key = betKey(type, value);
    setBets((prev) => {
      const idx = prev.findIndex((b) => betKey(b.type, b.value) === key);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], amountCents: next[idx].amountCents + chip, chips: [...(next[idx].chips || [next[idx].amountCents]), chip] };
        return next;
      }
      return [...prev, { type, value, amountCents: chip, chips: [chip] }];
    });
    setBetHistory((prev) => [...prev, { type, value, amountCents: chip }]);
  };

  // Right-click / long-press a bet to remove it entirely — the staked amount
  // returns to the displayed balance immediately, same as Clear, just for one bet.
  const removeBet = ({ type, value }) => {
    if (busy || autoSpin) return;
    const key = betKey(type, value);
    playChipRemove();
    setBets((prev) => prev.filter((b) => betKey(b.type, b.value) !== key));
    // Any undo steps referring to this now-deleted bet would be meaningless.
    setBetHistory((prev) => prev.filter((a) => betKey(a.type, a.value) !== key));
  };

  // Undo removes exactly the last chip placed — one click back, not the
  // whole table — same idea as a real online roulette "undo" button.
  const undoLastBet = () => {
    if (busy || betHistory.length === 0) return;
    const last = betHistory[betHistory.length - 1];
    const key = betKey(last.type, last.value);
    playChipRemove();
    setBets((prev) => {
      const idx = prev.findIndex((b) => betKey(b.type, b.value) === key);
      if (idx === -1) return prev;
      const chips = [...(prev[idx].chips || [prev[idx].amountCents])];
      const at = chips.lastIndexOf(last.amountCents);
      if (at >= 0) chips.splice(at, 1);
      const remaining = prev[idx].amountCents - last.amountCents;
      if (remaining <= 0) return prev.filter((_, i) => i !== idx);
      const next = [...prev];
      next[idx] = { ...next[idx], amountCents: remaining, chips };
      return next;
    });
    setBetHistory((prev) => prev.slice(0, -1));
  };

  const clearBets = () => {
    if (busy) return;
    if (bets.length) playChipRemove();
    setBets([]);
    setBetHistory([]);
    setShowResults(false);
  };

  const repeatBet = () => {
    if (busy || lastBets.length === 0) return;
    const cost = lastBets.reduce((sum, b) => sum + b.amountCents, 0);
    if (user && cost > balanceNow) {
      setError('Not enough balance to repeat that bet.');
      playDeny();
      return;
    }
    const overMax = overMaxBet(0, cost, gameConfig?.maxStakeCents) || overTableLimit(lastBets);
    if (overMax) { setError(overMax); playDeny(); return; }
    playChip(500);
    setNotice(null);
    setShowResults(false);
    setBets(lastBets.map((b) => ({ ...b, chips: [...(b.chips || [b.amountCents])] })));
    setBetHistory([]);
  };

  // Double every bet on the table (same chips again on each spot).
  const doubleBets = () => {
    if (busy || bets.length === 0 || !user) return;
    if (totalStaked * 2 > balanceNow) {
      setError('Not enough balance to double.');
      playDeny();
      return;
    }
    const overMax = overMaxBet(totalStaked, totalStaked, gameConfig?.maxStakeCents) || overTableLimit(bets.map((b) => ({ ...b, amountCents: b.amountCents * 2 })));
    if (overMax) { setError(overMax); playDeny(); return; }
    setError(null);setNotice(null);
    setShowResults(false);
    playChip(1000);
    setBets((prev) => prev.map((b) => ({ ...b, amountCents: b.amountCents * 2, chips: [...(b.chips || [b.amountCents]), ...(b.chips || [b.amountCents])] })));
    setBetHistory([]);
  };

  // The money "transfer": a big winnings counter visibly drains to zero
  // while the header balance climbs by the exact same amount, in lockstep
  // — makes the payout feel like it's physically moving into the
  // balance rather than just appearing there. Returns a promise that
  // resolves once the animation (and its settling sound) finishes.
  const animateTransfer = (amountCents, fromBalance, toBalance, pace = 1, durationMs = null) =>
    new Promise((resolve) => {
      const duration = durationMs ?? Math.max(350, Math.round(1000 * pace));
      const start = performance.now();
      let lastTickAt = 0;
      setTransferAmountCents(amountCents);
      const step = (now) => {
        const elapsed = now - start;
        // rAF timestamps can predate `start`; a negative t eased the balance below its start.
        const t = skipReveal.current ? 1 : Math.max(0, Math.min(1, elapsed / duration));
        const eased = 1 - (1 - t) * (1 - t); // easeOutQuad
        setTransferAmountCents(Math.round(amountCents * (1 - eased)));
        setBalanceOverrideCents(Math.round(fromBalance + (toBalance - fromBalance) * eased));
        if (now - lastTickAt > 110) {
          playCountTick();
          lastTickAt = now;
        }
        if (t < 1) {
          requestAnimationFrame(step);
        } else {
          setTransferAmountCents(null);
          // Keep showing the final value until the caller commits the settled
          // balance; clearing here flashed the pre-win balance for ~250 ms.
          playChaChing();
          resolve();
        }
      };
      requestAnimationFrame(step);
    });

  // Sleeps for `ms`, but returns early (resolving `true`) the moment
  // `skipReveal.current` is set — used only for the per-bet close-up
  // reveal loop, so "Skip" jumps straight to the full total instead of
  // waiting out every remaining bet's hold time.
  const sleepUnlessSkipped = (ms) =>
    new Promise((resolve) => {
      const start = Date.now();
      const poll = () => {
        if (skipReveal.current || Date.now() - start >= ms) {
          resolve(skipReveal.current);
        } else {
          setTimeout(poll, 30);
        }
      };
      poll();
    });

  // Called by RouletteWheel once its spin animation finishes. The dolly lands
  // on the felt immediately; if anything won, ONE popup zooms in on the
  // winning spots and shows only the winning chips, adding them one at a
  // time while the total climbs. "Skip ahead" shows them all at once and
  // "Collect winnings" closes the popup — the finale (banner + confetti +
  // transfer into the balance) always plays, since that's the payoff.
  // Chips persist between rounds, but never more than the new balance covers.
  // If the settled balance can't pay for them, sweep the table (Rebet still
  // remembers the bet) instead of leaving an unplayable stake on the felt.
  const clearTableIfUnaffordable = (balanceAfterCents) => {
    const stake = stakedRef.current;
    if (tableFitsBalance(stake, balanceAfterCents)) return;
    setBets([]); setBetHistory([]); stakedRef.current = 0;
    if (autoSpinRef.current) { autoSpinRef.current = false; setAutoSpin(false); clearTimeout(autoTimerRef.current); }
    setNotice(`Your balance (${fmt(balanceAfterCents)}) can't cover the ${fmt(stake)} bet, so the table was cleared. Place a new bet.`);
  };

  const handleSettled = useCallback(async () => {
    const data = pendingResultRef.current;
    if (!data) return;
    pendingResultRef.current = null;
    pendingRefreshRef.current = true; // pick up demoAllowed / real funds once the round is over
    setSpinning(false);
    setRevealPhase('landed');
    setLandingPocket(data.pocket);
    setSettledPocket(data.pocket); // dolly lands now, immediately
    recentSeeded.current = true;
    setRecentNumbers((prev) => [{ id: `s${Date.now()}`, n: data.pocket }, ...prev].slice(0, 20));
    skipReveal.current = false;
    continueRef.current = false;

    // The hash for the NEXT spin was already minted server-side and handed
    // back with this result — show it right away, no extra round-trip, so
    // there's never a moment without a visible pre-commitment.
    if (data.verification?.ok && data.nextReady) {
      setCommitment(Object.freeze({ ...data.fairness.nextCommitment }));
    }

    // Announce the result now. The betting-open effect announces "Place
    // your bets" only AFTER the popup and the balance transfer finish.
    const resultVoice = playNumberCallout(data.pocket);

    // Silent, automatic, client-side re-check of THIS round — no click, no
    // backend call. This is the ambient trust signal; the manual "Verify
    // this outcome independently" link below is only for players who want
    // to see the actual math.
    setAutoVerify(data.verification || { ok: false, status: 'error' });

    // Auto-bet runs the whole reveal noticeably faster, but never skips it
    // outright — every winner still shows, just on a tighter clock.
    const pace = autoSpinRef.current ? 0.4 : 1;
    const ms = (base) => Math.round(base * pace);

    // Confirm the actual pocket first, before any winning chips obscure it.
    // The live wheel remains mounted and turns at its original constant speed.
    await new Promise((resolve) => setTimeout(resolve, autoSpinRef.current ? 700 : 1350));
    setLandingPocket(null);

    // If auto-bet is still on, queues the next spin a beat after this one
    // fully wraps up — stops itself (with a reason shown as an error toast)
    // the moment the current bet can no longer be afforded.
    const continueAutoIfReady = () => {
      if (!autoSpinRef.current || manualCheckingRef.current || verificationBlockedRef.current || !data.verification?.ok) return;
      const nextStake = bets.reduce((sum, b) => sum + b.amountCents, 0);
      if (data.balanceAfterCents < nextStake) {
        autoSpinRef.current = false;
        setAutoSpin(false);
        setError('Auto-bet stopped. Not enough balance to repeat this bet.');
        return;
      }
      autoTimerRef.current = setTimeout(() => {
        if (autoSpinRef.current && !manualCheckingRef.current && !verificationBlockedRef.current) spinRef.current?.();
      }, ms(600));
    };

    const winningBets = bets
      .filter((b) => didBetWin(b, data.pocket))
      .map((b) => ({ bet: b, key: betKey(b.type, b.value), amount: serverPayout(data, b) ?? payoutCentsFor(b, data.pocket) }))
      .sort((a, b) => typePriority(a.bet.type) - typePriority(b.bet.type));

    if (winningBets.length === 0) {
      setShowResults(true);
      setLastResult(data);
      setUser((u) => ({ ...u, [balanceField(data.mode)]: data.balanceAfterCents }));
      setCommittedStakeCents(0);
      clearTableIfUnaffordable(data.balanceAfterCents);
      playLose();
      refreshHistory();
      await resultVoice;
      setRevealPhase('idle');
      setTimeout(continueAutoIfReady, ms(1800));
      return;
    }

    // Pay out right on the real felt: losers dim, winners glow, and a
    // "+$amount" pops over each winning chip in quick succession. No
    // calculator card or Collect step; the celebration banner follows.
    setRevealPhase('revealing');
    setShowResults(true);
    setPayoutPops([]);
    await sleepUnlessSkipped(ms(300));
    const popMs = Math.max(180, Math.min(420, Math.round(1300 / winningBets.length)));
    for (const w of winningBets) {
      if (skipReveal.current) break;
      setPayoutPops((p) => [...p, { key: w.key, amountCents: w.amount }]);
      playChaChing();
      await sleepUnlessSkipped(ms(popMs));
    }
    setPayoutPops(winningBets.map((w) => ({ key: w.key, amountCents: w.amount })));
    await sleepUnlessSkipped(ms(550));

    // Casino finale: the amount races up in a full celebration (WinCelebration),
    // then real chips fly into the balance while it counts up in lockstep.
    skipReveal.current = false; // a Skip used in the popup must not skip the celebration
    setShowResults(true);
    setRevealPhase('totaling');
    setLastResult(data);
    const timing = celebrationTiming(winTier(data.totalPayoutCents, data.totalStakeCents), pace);
    await sleepUnlessSkipped(timing.countMs + ms(350));

    setRevealPhase('transferring');
    // Count up from the server's post-debit balance, never a possibly stale client copy.
    const fromBalance = data.balanceAfterCents - data.totalPayoutCents;
    await sleepUnlessSkipped(Math.round(timing.flyMs * 0.3));
    await animateTransfer(data.totalPayoutCents, fromBalance, data.balanceAfterCents, pace, Math.round(timing.flyMs * 0.75));
    await sleepUnlessSkipped(ms(250));

    setUser((u) => ({ ...u, [balanceField(data.mode)]: data.balanceAfterCents }));
    setCommittedStakeCents(0);
    setBalanceOverrideCents(null);
    clearTableIfUnaffordable(data.balanceAfterCents);
    await resultVoice;
    setPayoutPops([]);
    setRevealPhase('idle');
    refreshHistory();
    setTimeout(continueAutoIfReady, ms(1800));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshHistory, bets, user]);

  const spinRef = useRef(null); // lets the auto-bet loop call the latest spin() without being a dependency of handleSettled

  const stopAuto = () => { autoSpinRef.current = false; setAutoSpin(false); clearTimeout(autoTimerRef.current); };
  const endSpinWithoutResult = () => { setSpinning(false); setCommittedStakeCents(0); };

  // A reply from the server for this spin (first try, or the saved reply asked for again): number
  // proof first, then the money, then the next lock. Starts the wheel.
  const processSpinReply = async (data, request, entry) => {
    walletAtRef.current = Date.now(); // balanceAfterCents is the server's balance right now
    let verification;
    try {
      verification = await verifyOutcomeClientSide({ ...data.fairness, max: 37, pocket: data.pocket,
        requestId: data.requestId, expected: request.expected });
    } catch (e) { verification = { ok: false, status: 'error', error: e.message }; }
    // Outcome proof first, then the money: bets, stake, mode, payout table and balance must match the terms.
    if (verification.ok) {
      const terms = request.expected.terms;
      let settlement = verifySettlement(terms, data, didBetWin);
      // A lower balance is only accepted when the balance read again now is at least what it should be
      // after this spin. Otherwise it is always flagged, never blamed on another device.
      let shortCredit = null;
      if (!settlement.ok && settlement.problems.length === 1 && settlement.problems[0] === 'balance credited too little') {
        let fresh = null;
        if (!terms.balanceFresh) { try { fresh = modeBalance(await walletApi.wallet(), terms.mode); } catch { fresh = null; } }
        if (isBalanceResync({ terms, data, settlement, freshBalance: fresh })) {
          settlement = { ...settlement, ok: true, problems: [], resynced: true };
          data = { ...data, balanceAfterCents: fresh };
          setNotice(BALANCE_RESYNC_MESSAGE);
        } else shortCredit = shortCreditMessage(terms.balanceBefore - settlement.stake + settlement.payout, Number.isSafeInteger(fresh) ? fresh : data.balanceAfterCents);
      }
      verification = { ...verification, settlement };
      if (!settlement.ok) verification = { ...verification, ok: false, status: 'settlement', error: `Payout check failed: ${settlement.problems.join(', ')}.`, shortCredit };
    }
    let nextReady = false;
    if (!verification.ok) stopForVerification(verification.shortCredit || (verification.status === 'settlement' ? `${verification.error} Betting is stopped. Inspect the round before continuing.` : undefined));
    else {
      saveRoundReceipt(request.expected, data.roundId);
      const revealed = rememberRevealedSeed(verification.recomputedHash);
      forgetOpenLock(entry.serverSeedHash);
      nextReady = isNextCommitmentSafe(data.fairness?.nextCommitment, request.expected, revealed);
      if (!nextReady) stopForVerification('This round is verified, but the next commitment is invalid or reuses a revealed seed. Further betting has been stopped.');
    }
    if (!Number.isInteger(data.pocket) || data.pocket < 0 || data.pocket > 36) throw new Error('Invalid pocket in round response.');
    pendingResultRef.current = { ...data, expected: request.expected, verification, nextReady };
    // Wheel component owns the recorded rolling/drop audio; no extra synthetic layer.
    prepareNumberCallout(data.pocket); // fetch/decode during flight, before the delayed result call
    setSpinToken(Date.now());
    setLastPocket(data.pocket);
  };

  // The lock was used by a round this browser did not play (another tab or device, or a round the
  // server made up to void this spin). That round is verified on its own, the key it reveals is used
  // to work out where THIS browser's spin would have landed (logged, with what it would have won),
  // and it counts as an unexpected refusal. With no other tab of the game open it is a fairness stop.
  // adopt: take the server's current lock afterwards. checkAlone: apply the "no other tab" rule (only
  // right after the spin; after a reload the timing is no longer known).
  const acceptOtherDeviceRound = async (round, entry, terms = null, { adopt = true, checkAlone = true } = {}) => {
    const v = await verifyRevealedRound(round);
    if (!v.ok) { stopForVerification(`A spin played with this lock in another tab or on another device does not check out (${v.reason}). Betting is stopped. Inspect the round before continuing.`); return false; }
    let pocket = null;
    try { pocket = await pocketFor({ serverSeed: round.server_seed, clientSeed: `${entry.clientSeed}:${entry.clientEntropy}`, nonce: entry.nonce, max: 37 }); } catch { pocket = null; }
    const t = terms || readRoundReceipt(entry.requestId, null)?.terms || null;
    const won = pocket === null ? null : wouldHaveWon(t?.bets, pocket, t?.multipliers);
    addRefusedSpin({ lock: entry.serverSeedHash, pocket, won, kind: 'other_device', reason: 'The lock was used by a spin this page did not make' });
    try { rememberRevealedSeed(round.server_seed_hash); } catch { /* storage full: the server never reuses a seed */ }
    forgetOpenLock(entry.serverSeedHash);
    const extra = wouldHaveText(pocket, won);
    // No other tab seen: could be another device, or a server voiding the spin. A browser cannot tell
    // these apart, so it is never silent: it is counted (betting stops at the strict limit) and the
    // player is told where the spin would have landed.
    const alone = checkAlone && !otherTabRecently(presenceRef.current?.id ?? null);
    if (!entry.counted) {
      const r = recordRefusal('unpredicted');
      if (r.reached) { stopForVerification(refusalStopMessage('unpredicted', r.count)); return false; }
    }
    if (adopt) {
      try { await adoptCurrentLock(entry.serverSeedHash); } catch (e) { setError(e.message); return false; }
      refreshHistory(); walletAtRef.current = 0; pendingRefreshRef.current = true;
      setError(null);
    }
    setNotice(`${alone ? OTHER_DEVICE_ALONE_MESSAGE : OTHER_DEVICE_MESSAGE}${extra ? ` ${extra}` : ''}`);
    return true;
  };

  // This browser's spin is in the round history although its reply was lost (or refused). Asking
  // again with the identical request returns the server's saved reply, which plays as a normal spin.
  // If that fails, the round itself is checked and the player is told the result.
  const settleFoundRound = async ({ round, request, bodyText, entry }) => {
    let data = null;
    const { resp, data: d } = await postJsonWithTimeout(`${API}/games/roulette/spin`, bodyText);
    if (resp?.ok && d && d.requestId === request.expected.requestId) data = d;
    if (data) { await processSpinReply(data, request, entry); return; }
    endSpinWithoutResult();
    let pocket;
    try { pocket = JSON.parse(round.outcome_json || '{}').pocket; } catch { pocket = undefined; }
    let outcome;
    try {
      outcome = await verifyOutcomeClientSide({ serverSeed: round.server_seed, serverSeedHash: round.server_seed_hash, clientSeed: round.client_seed,
        nonce: round.nonce, max: 37, pocket, requestId: round.request_id, expected: request.expected });
    } catch (e) { outcome = { ok: false, status: 'error', error: e.message }; }
    // The history has no balance after the spin, so the balance line is not checked here.
    const { balanceBefore: _unused, ...terms } = request.expected.terms;
    const result = combineVerification(outcome, terms, settlementFromRound(round), didBetWin);
    setAutoVerify(result);
    if (!result.ok) { stopForVerification(result.status === 'settlement' ? `${result.error} Betting is stopped. Inspect the round before continuing.` : 'Your spin could not be verified. Betting is stopped. Inspect the round before continuing.'); return; }
    saveRoundReceipt(request.expected, round.id);
    try { rememberRevealedSeed(round.server_seed_hash); } catch { /* storage full */ }
    forgetOpenLock(entry.serverSeedHash);
    try { await adoptCurrentLock(entry.serverSeedHash, request.expected); } catch (e) { setError(e.message); }
    refreshHistory(); walletAtRef.current = 0; pendingRefreshRef.current = true;
    setNotice(`Your spin went through and landed on ${pocket}. It was checked in your browser.`);
  };

  // No reply at all (network blip): no fairness alert. The round history is checked for this
  // request for about 20 s. Found: it continues as a normal settled spin. Not found: the lock is
  // opened through the reveal (so the spin can never land later) and the player goes on.
  const recoverLostReply = async ({ entry, request, bodyText }) => {
    setNotice('The connection dropped. Checking whether your spin went through...');
    let hit = null;
    const deadline = Date.now() + LOST_REPLY_WAIT_MS;
    while (!hit && Date.now() < deadline) {
      await sleep(LOST_REPLY_POLL_MS);
      try { hit = findRoundForLock(await fetchRounds(), entry); } catch { /* still offline */ }
    }
    if (!hit) {
      const swap = await openAndLog(entry, 'lost', 'The connection dropped before the reply', null, request.expected.terms);
      if (swap.problem) { endSpinWithoutResult(); setNotice(null); setCommitment(null); stopForVerification(swap.problem); return; }
      if (swap.ok) { endSpinWithoutResult(); setCommitment(swap.commitment); setNotice(LOST_REPLY_MESSAGE); return; }
      // The lock could not be opened: maybe the spin landed meanwhile. One last look.
      try { hit = findRoundForLock(await fetchRounds(), entry); } catch { hit = null; }
      if (!hit) { endSpinWithoutResult(); setCommitment(null); setNotice(LOST_REPLY_PAUSED_MESSAGE); return; }
    }
    setNotice(null);
    if (!hit.own) { endSpinWithoutResult(); setCommitment(null); await acceptOtherDeviceRound(hit.round, entry, request.expected.terms); return; }
    await settleFoundRound({ round: hit.round, request, bodyText, entry });
  };

  // Any refusal after the random value was sent. The lock always counts as used: it is opened through
  // the reveal (retireLock) and the pocket it would have given goes into the refused-spins log.
  // Predicted refusals count in the larger budget, unpredicted ones in the strict one.
  // checked: the page's own balance and limits said this bet was allowed, so a "predicted" refusal was
  // counted as unexpected instead.
  const handleRefusal = async ({ kind, reason, code = null, entry, request, bodyText, checked = false }) => {
    if (kind === 'other_tab') {
      // Refused before anything was read: nothing consumed, the lock is still ours and not counted.
      forgetOpenLock(entry.serverSeedHash);
      endSpinWithoutResult();
      setNotice(reason || OTHER_TAB_MESSAGE);
      return;
    }
    if (kind === 'auth' && isSignedInElsewhere({ status: 401, code })) { forgetOpenLock(entry.serverSeedHash); endSpinWithoutResult(); await signedOutElsewhere({ message: reason }); return; }
    updateOpenLock(entry.serverSeedHash, { refused: true, counted: !budgetFor(kind) });
    if (kind === 'stale_lock') {
      // The lock moved on. If a round used it, it was either this very spin or another tab/device.
      let hit = null;
      try { hit = findRoundForLock(await fetchRounds(), entry); } catch { hit = null; }
      if (hit?.own) { await settleFoundRound({ round: hit.round, request, bodyText, entry }); return; }
      endSpinWithoutResult();
      setCommitment(null);
      if (hit) { await acceptOtherDeviceRound(hit.round, entry, request.expected.terms); return; }
      const r = recordRefusal('unpredicted');
      updateOpenLock(entry.serverSeedHash, { counted: true });
      if (r.reached) { stopForVerification(refusalStopMessage('unpredicted', r.count)); return; }
      setError(STALE_LOCK_MESSAGE);
      return;
    }
    endSpinWithoutResult();
    setCommitment(null);
    const swap = await openAndLog(entry, kind, reason, null, request.expected.terms);
    const wouldHave = swap.wouldHave || '';
    if (swap.problem) { stopForVerification(swap.problem); return; }
    if (swap.ok) setCommitment(swap.commitment);
    const budget = budgetFor(kind);
    if (budget) {
      const r = recordRefusal(budget);
      updateOpenLock(entry.serverSeedHash, { counted: true });
      if (r.reached) { stopForVerification(`${refusalStopMessage(budget, r.count)}${wouldHave ? ` ${wouldHave}` : ''}`); return; }
    }
    if (kind === 'auth') { setError(SIGN_IN_EXPIRED_MESSAGE); return; }
    if (!swap.ok) { setError(`${reason ? `${reason.replace(/[.!?]?$/, '.')} ` : ''}${REFUSAL_NO_LOCK_MESSAGE}`); return; }
    if (kind === 'table_changed') {
      setTableRecheck(true);
      await loadGameConfig();
      setTableNoticeOpen(true);
      setError(TABLE_CHANGED_MESSAGE);
      return;
    }
    if (kind === 'transient') { setError(`The game is busy for a moment${reason && reason !== 'internal error' ? ` (${reason.replace(/[.!?]$/, '')})` : ''}. Your bet was not taken.${wouldHave ? ` ${wouldHave}` : ''} Please try again.`); return; }
    if (kind === 'predicted') {
      // Limits, balance, mode and pause switches the page already knows about: the server's reason.
      setError(`${reason ? reason.replace(/[.!?]?$/, '.') : 'The spin was refused.'}${wouldHave ? ` ${wouldHave}` : ''}`);
      loadGameConfig();
      refreshCasinoReserve();
      return;
    }
    setError(refusalRetiredMessage(reason, { checked, wouldHave }));
  };

  const spin = async () => {
    if (bets.length === 0 || !readyToSpin || manualCheckingRef.current || operationRef.current || verificationBlockedRef.current || !user) return;
    if (tableNeedsConfirm) { setTableNoticeOpen(true); if (autoSpinRef.current) { autoSpinRef.current = false; setAutoSpin(false); } return; }
    if (!tableFitsBalance(stakedRef.current, balanceNow)) { clearTableIfUnaffordable(balanceNow); return; }
    operationRef.current = 'spin';
    setNotice(null);
    ensureAudioContext();
    setBettingOpen(false); // cancel a queued/in-progress opening call synchronously
    setError(null);
    setSpinning(true);
    setCommittedStakeCents(totalStaked);
    setBalanceOverrideCents(null);
    setLastResult(null);
    setAutoVerify(null);
    setSettledPocket(null); // hide the previous round's dolly/win highlights while this one is in flight
    setPayoutPops([]);
    if (!autoSpinRef.current) playVoice('no_more_bets');
    setShowResults(false);
    setLastBets(bets.map((b) => ({ ...b })));
    setBetHistory([]); // undo only applies to chips placed since the last spin
    // Mobile presents the same continuously mounted wheel above the felt;
    // never move the user's scroll position to another part of the page.
    let sent = false, entry = null;
    try {
      const sentBets = bets.map(({ type, value, amountCents }) => ({ type, value, amountCents }));
      const stake = sentBets.reduce((t, b) => t + b.amountCents, 0);
      // Another device may have moved money: read the balance again when the last read is old.
      let balanceBefore = balanceNow, balanceFresh = false;
      if (Date.now() - walletAtRef.current > WALLET_STALE_MS) {
        try {
          const w = await walletApi.wallet();
          walletAtRef.current = Date.now();
          balanceBefore = modeBalance({ ...user, ...w }, mode);
          balanceFresh = true;
          setUser((u) => (u ? { ...u, ...w } : u));
        } catch { /* keep the last known balance */ }
      }
      if (!tableFitsBalance(stake, balanceBefore)) { endSpinWithoutResult(); clearTableIfUnaffordable(balanceBefore); return; }
      const request = createRoundRequest(commitment, sentBets);
      // The settlement terms this browser agreed to: bets, stake, mode, the published payout table and the balance before.
      const mathId = gameConfig?.math?.id || null;
      const terms = Object.freeze({ bets: sentBets.map((b) => ({ ...b })), stake, mode,
        mathId, multipliers: tableCheck.multipliers, balanceBefore, balanceFresh });
      request.expected = Object.freeze({ ...request.expected, terms });
      // Persist the independent receipt BEFORE any wager is transmitted.
      saveRoundReceipt(request.expected);
      const agreed = request.body.expectedCommitment;
      // ...and the lock with the random value about to be sent, so it is checked even if this page closes.
      entry = rememberOpenLock({ identity: user.identity || 'guest', serverSeedHash: agreed.serverSeedHash, clientSeed: agreed.clientSeed,
        nonce: agreed.nonce, clientEntropy: request.body.clientEntropy, requestId: request.expected.requestId });
      // mathId: the payout table the player confirmed. A changed table is refused before anything is used.
      const bodyText = JSON.stringify({ ...request.body, mode, ...(mathId ? { mathId } : {}) });
      sent = true; // from here the server has seen this lock's random value
      guard.announce();
      // Timed out after SPIN_TIMEOUT_MS: handled as a lost reply, the lock stays in the open locks list.
      const { resp, data } = await postJsonWithTimeout(`${API}/games/roulette/spin`, bodyText);
      if (!resp || (resp.ok && !data)) { // no usable reply: a network blip, not a fairness alert
        stopAuto();
        await recoverLostReply({ entry, request, bodyText });
        return;
      }
      if (!resp.ok) {
        stopAuto();
        const reason = typeof data?.error === 'string' ? data.error : '';
        const first = classifySpinRefusal(resp.status, reason, data?.code);
        // The server alone does not decide a refusal was expected: the page's own figures are checked.
        const known = { balance: balanceBefore, stake, worstPayout: maxPayoutUnits(sentBets), minStake: gameConfig?.minStakeCents,
          maxStake: gameConfig?.maxStakeCents, maxWin: gameConfig?.maxWinCents, tableLimit };
        if (first === 'predicted' && resp.status === 402 && !balanceFresh) {
          try { known.balance = modeBalance(await walletApi.wallet(), mode); } catch { known.balance = null; }
        }
        const kind = checkRefusalAgainstKnown(first, resp.status, reason, known);
        await handleRefusal({ kind, reason, code: data?.code, entry, request, bodyText, checked: kind !== first });
        return;
      }
      await processSpinReply(data, request, entry);
    } catch (e) {
      endSpinWithoutResult();
      setAutoVerify({ ok: false, status: 'error' });
      if (sent && entry) updateOpenLock(entry.serverSeedHash, { refused: true, counted: true }); // after a reload this lock is only swapped through the reveal
      stopForVerification(`Round could not be confirmed: ${e.message}. Auto-bet stopped; review history before continuing.`);
    } finally { operationRef.current = null; }
  };
  spinRef.current = spin;

  // Auto-bet: repeats whatever is currently on the table, a little faster
  // than a manual spin, until the player presses Stop or the balance can no
  // longer cover the bet (handled inside handleSettled's continueAutoIfReady).
  const toggleAutoSpin = () => {
    if (autoSpin) {
      clearTimeout(autoTimerRef.current);
      autoSpinRef.current = false;
      setAutoSpin(false);
      return;
    }
    if (bets.length === 0 || !readyToSpin || manualCheckingRef.current || operationRef.current || !user) return;
    autoSpinRef.current = true;
    setAutoSpin(true);
    spin();
  };

  // Runs the fairness check entirely in THIS browser via Web Crypto —
  // never asks our own backend "was this fair?", since that would just be
  // the operator vouching for itself. See fairnessClient.js for why.

  const runVerify = async (round, locallyCapturedExpected = null, settlementData = null) => {
    const generation = ++verifyGenerationRef.current;
    manualCheckingRef.current = true;
    autoSpinRef.current = false; setAutoSpin(false); clearTimeout(autoTimerRef.current);
    setVerifyLoading(true);
    setVerifyOpen(true);
    setVerifyResult(null);
    const expected = locallyCapturedExpected || readRoundReceipt(round.request_id, round.id);
    let pocket;
    try { pocket = JSON.parse(round.outcome_json || '{}').pocket; } catch { /* malformed record fails verification */ }
    const result = { serverSeed: round.server_seed, serverSeedHash: round.server_seed_hash,
      clientSeed: round.client_seed, nonce: round.nonce, max: 37, pocket, requestId: round.request_id };
    // A live reply carries the ending balance; a history round does not, so its terms drop balanceBefore.
    const settlement = settlementData || settlementFromRound(round);
    const terms = expected?.terms ? (settlementData ? expected.terms : withoutBalance(expected.terms)) : null;
    const proof = { version: 1, expected, result, settlement: settlementForProof(settlement) };
    try {
      const outcome = await verifyOutcomeClientSide({ ...result, expected });
      // Then the money, against the terms this browser saved before the bet (when it has them).
      const data = combineVerification(outcome, terms, settlement, didBetWin);
      if (generation !== verifyGenerationRef.current) return;
      setVerifyResult({ ...data, round, expected, proof, script: standaloneVerifyScript() });
      if (!data.ok) {
        autoSpinRef.current = false; setAutoSpin(false); clearTimeout(autoTimerRef.current);
        if (data.status === 'settlement') stopForVerification(`${data.error} Betting is stopped. Inspect the round before continuing.`);
        else if (data.status !== 'unrecorded') stopForVerification();
      }
    } catch (e) {
      if (generation !== verifyGenerationRef.current) return;
      setVerifyResult({ ok: false, status: 'error', error: e.message, round, expected, proof, script: standaloneVerifyScript() });
      stopForVerification('Verification could not be completed. Further betting has been stopped.');
    } finally {
      if (generation === verifyGenerationRef.current) { manualCheckingRef.current = false; setVerifyLoading(false); }
    }
  };

  const downloadProof = () => {
    if (!verifyResult?.proof) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(verifyResult.proof, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'round-proof.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const [vp, setVp] = useState({ w: typeof window !== 'undefined' ? window.innerWidth : 1200, h: typeof window !== 'undefined' ? window.innerHeight : 800 });
  useEffect(() => {
    const on = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    window.addEventListener('orientationchange', on);
    return () => { window.removeEventListener('resize', on); window.removeEventListener('orientationchange', on); };
  }, []);
  // A phone held sideways: a compact, no-scroll table layout like other mobile roulette games.
  const landscape = vp.w > vp.h && vp.h < 560;
  const portraitPhone = vp.w < vp.h && vp.w < 700;
  const mobileGame = vp.w < 1100 || landscape;
  const headerLayoutName = headerLayout(vp.w, vp.h);
  const inbox = useInbox({ ready: !!user, quiet: busy || autoSpin });
  const openProfile = (tab = 'wallet') => setSheet({ tab });
  const connectFromHeader = () => { setSheet(null); requestConnect(); };
  const blockShortcuts = verifyOpen || !!detailRound || !!sheet || connectNoticeOpen || !ageOk;
  const anyModalOpen = blockShortcuts || (!mobileGame && !!winPopup);
  useLayoutEffect(() => lockBackgroundScroll(anyModalOpen), [anyModalOpen]);
  const stageVisible = spinning || landingPocket !== null || revealPhase === 'totaling' || revealPhase === 'transferring';
  const stageState = spinning ? 'rolling' : landingPocket !== null ? 'landed' : revealPhase;
  const verifyLastOutcome = () => lastResult && runVerify({
    id: lastResult.roundId, request_id: lastResult.requestId,
    outcome_json: JSON.stringify({ pocket: lastResult.pocket }),
    server_seed: lastResult.fairness.serverSeed, server_seed_hash: lastResult.fairness.serverSeedHash,
    client_seed: lastResult.fairness.clientSeed, nonce: lastResult.fairness.nonce,
  }, lastResult.expected, lastResult);

  // Keyboard shortcuts (latest handlers via ref so the listener registers once)
  const actionsRef = useRef({});
  actionsRef.current = {
    spin, undoLastBet, clearBets, repeatBet, doubleBets, setChip, busy, blockShortcuts,
    popup: winPopup ? { done: winPopup.done } : null,
    skip: () => { skipReveal.current = true; },
    collect: () => { continueRef.current = true; },
  };
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const a = actionsRef.current;
      const k = e.key.toLowerCase();
      if (a.blockShortcuts || e.target?.closest?.('[data-audio-control]')) return;
      if (a.popup) {
        // while the winnings popup is open Space/Enter only skip or collect — never spin
        if (k === ' ' || k === 'enter') { e.preventDefault(); if (a.popup.done) a.collect(); else a.skip(); }
        return;
      }
      if (a.busy) { if (k === ' ') e.preventDefault(); return; }
      if (k >= '1' && k <= String(CHIPS.length)) { a.setChip(CHIPS[Number(k) - 1]); playChipSelect(); }
      else if (k === ' ' || k === 'enter') { if (tag === 'BUTTON' && k === 'enter') return; e.preventDefault(); a.spin(); }
      else if (k === 'u' || k === 'z') a.undoLastBet();
      else if (k === 'c') a.clearBets();
      else if (k === 'r') a.repeatBet();
      else if (k === 'd') a.doubleBets();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The Fairness tab of the profile sheet: the How we keep it fair content (lock pill opens it here).
  const fairnessTab = <div className="profile-fairness" data-testid="how-fair">
    {lastResult && <button type="button" className="fair-btn fair-btn-wide" data-testid="check-last-spin" onClick={() => { setSheet(null); verifyLastOutcome(); }}>Check the last spin</button>}
      <FairFlow />
      <section className="fair-panel" data-testid="next-fingerprint-box">
        <h4>Lock for your next spin</h4>
        <code className="fair-mono" data-testid="next-fingerprint">{commitment ? commitment.serverSeedHash : 'loading...'}</code>
        <div className="fair-btn-row">
          <button type="button" className="fair-btn" disabled={!commitment} onClick={() => { navigator.clipboard?.writeText(commitment.serverSeedHash).then(() => { setLockCopied(true); setTimeout(() => setLockCopied(false), 1400); }).catch(() => {}); }}>{lockCopied ? 'Copied' : 'Copy lock'}</button>
          <button type="button" className="fair-btn fair-btn-ghost" data-testid="rotate-lock" disabled={busy || verifyLoading || autoSpin || verificationBlocked || !commitment || clientSeedSaving} onClick={rotateLock}>{clientSeedSaving && operationRef.current === 'rotate' ? 'Making new lock...' : 'Get a new lock'}</button>
        </div>
        <p className="fair-note">A new lock is made after every spin. Tap Get a new lock if you want a fresh one now.</p>
        {retiredLock && <div className="fair-retired" data-testid="retired-lock" data-fits={retiredLock.fits ? 'yes' : 'no'}>
          <p>{retiredLock.fits ? 'Done. The old lock was never used, so here is its key. It fits the old lock.' : 'The old key does not fit the old lock.'}</p>
          <code className="fair-mono">{retiredLock.serverSeed}</code>
          <a className="fair-btn fair-btn-ghost" href={chefLockUrl(retiredLock.serverSeed)} target="_blank" rel="noopener noreferrer">Check the old key yourself</a>
        </div>}
      </section>
      <RefusedSpins entries={readRefusedLog()} />
      <section className="fair-panel">
        <h4>Your lucky word</h4>
        <p className="fair-note">Mixed into every spin together with fresh randomness from your device. Change it to anything you like.</p>
        <div className="fair-btn-row">
          <input
            id="client-seed" name="clientSeed" autoComplete="off"
            value={clientSeedDraft}
            aria-label="Your client seed"
            disabled={busy || verifyLoading || autoSpin || clientSeedSaving || verificationBlocked || !commitment}
            onChange={(e) => setClientSeedDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') saveClientSeed(); }}
            maxLength={64}
            className="fair-input"
          />
          <button
            type="button"
            className="fair-btn"
            onClick={saveClientSeed}
            disabled={busy || verifyLoading || autoSpin || verificationBlocked || !commitment || clientSeedSaving || !clientSeedDraft.trim() || clientSeedDraft.trim() === commitment?.clientSeed}
          >
            {clientSeedSaving && operationRef.current === 'seed' ? 'Saving...' : 'Save'}
          </button>
        </div>
      </section>
      <p className="fair-foot">This proves how each spin’s number was produced. It isn’t an external audit of the casino.</p>
  </div>;
  // Recent rounds, shared by the desktop panel and the profile sheet's History tab.
  const historyRows = history.filter((r) => r.outcome_json && (!r.game || r.game === 'roulette'));
  const historyList = <div className="space-y-1 max-h-72 overflow-y-auto" data-testid="roulette-history">
    {historyRows.map((r) => {
      const outcome = JSON.parse(r.outcome_json);
      const net = (r.payout_cents || 0) - r.stake_cents;
      const col = pocketColor(outcome.pocket);
      return (
        <div
          key={r.id}
          role="button"
          tabIndex={0}
          onClick={() => { setSheet(null); setDetailRound(r); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { setSheet(null); setDetailRound(r); } }}
          className="flex items-center gap-3 text-xs py-2 px-2.5 rounded-lg bg-black/20 hover:bg-white/5 cursor-pointer transition-colors border border-transparent hover:border-[#d6b06a]/30"
          title="Click for the full breakdown"
        >
          <span className={`w-7 h-7 rounded-full flex items-center justify-center text-[12px] font-bold text-white shrink-0 ${col === 'red' ? 'bg-red-700' : col === 'green' ? 'bg-emerald-600' : 'bg-zinc-800 border border-white/10'}`}>{outcome.pocket}</span>
          <span className="flex-1 min-w-0">
            <span className="text-[#ede9e1]">Round #{r.id}</span>
            <span className="text-[#9b98ab]"> · bet {fmt(r.stake_cents)}</span>
          </span>
          <span className={`font-bold ${net > 0 ? 'text-emerald-400' : net < 0 ? 'text-red-400' : 'text-[#9b98ab]'}`}>{net > 0 ? '+' : net < 0 ? '-' : ''}{fmt(Math.abs(net))}</span>
          <span className="text-[#d6b06a] text-[11px] shrink-0">check this round ›</span>
        </div>
      );
    })}
    {historyRows.length === 0 && <div className="text-xs text-[#63607a]">No rounds yet. Place a bet and spin.</div>}
  </div>;

  const boardActionsRef=useRef({});
  boardActionsRef.current={addBet,removeBet};
  const boardAdd=useCallback(b=>boardActionsRef.current.addBet(b),[]);
  const boardRemove=useCallback(b=>boardActionsRef.current.removeBet(b),[]);

  return (
    <div data-background-locked={anyModalOpen} style={controlsHeight ? { '--controls-height': `${controlsHeight}px` } : undefined} className={`casino-app min-h-screen text-[#ede9e1] ${mobileGame ? 'mobile-game' : ''} ${landscape ? 'phone-landscape' : ''} ${portraitPhone ? 'phone-portrait' : ''} ${landscape ? 'px-3 py-1.5' : 'px-3 sm:px-6 py-4 sm:py-8'}`}>
      <GameHeader page="roulette" layout={headerLayoutName} inert={anyModalOpen}
        balanceText={user ? (portraitPhone ? fmtShort(displayBalanceCents) : fmt(displayBalanceCents)) : '-'} balanceNote={totalStaked > 0 ? `${fmt(totalStaked)} in play` : null}
        mode={mode} modeInfo={modeInfo} showSwitch={!!profile} modeDisabled={busy || autoSpin} onMode={chooseMode}
        lock={{ hash: commitment?.serverSeedHash || null, status: autoVerify ? (autoVerify.ok ? 'ok' : 'bad') : '', onTap: () => openProfile('fairness'), title: 'The lock for your next spin, shown before you bet. Tap to copy it, get a new one, or change your lucky word.' }}
        profile={profile} profileOpen={!!sheet} onProfile={() => openProfile('wallet')} onConnect={connectFromHeader} connecting={walletBusy} connectDisabled={busy || autoSpin}>
        <GameToast onDismiss={(kind) => { if (kind === 'error') setError(null); if (kind === 'info') setNotice(null); if (kind === 'elsewhere') setElsewhere(null); }} toasts={[
          gameClosed && { kind: 'closed', className: 'game-notice', testid: 'game-closed', title: toastTitle('closed'), text: gameConfig.maintenanceMessage || 'This game is having a short break. Please check back soon.' },
          !gameClosed && tableInvalid && { kind: 'closed', className: 'game-error', testid: 'payout-table-invalid', title: 'Betting paused', text: 'The payout table from the server does not look right, so betting is paused. Please reload the page or contact support.' },
          elsewhere && !error && { kind: 'elsewhere', className: 'game-error game-toast-error', title: 'Wallet', text: elsewhere, dismissible: true, testid: 'signed-in-elsewhere', action: { label: 'Connect again', testid: 'connect-again', onClick: () => { setElsewhere(null); requestConnect(); } } },
          notice && !error && { kind: 'info', className: 'game-notice', title: toastTitle('info', notice), text: notice, dismissible: true },
          error && { kind: 'error', className: 'game-error', title: toastTitle('error', error, verificationBlocked), text: error, dismissible: !verificationBlocked },
        ].filter(Boolean)} />
      </GameHeader>

      <AnimatePresence>
        {(revealPhase === 'totaling' || revealPhase === 'transferring') && lastResult?.totalPayoutCents > 0 && (
          <motion.div key={`celebrate-${spinToken}`} initial={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
            <WinCelebration total={lastResult.totalPayoutCents} stake={lastResult.totalStakeCents} phase={revealPhase}
              pace={autoSpin ? 0.4 : 1} mobile={mobileGame} onSkip={() => { skipReveal.current = true; }} />
          </motion.div>
        )}
      </AnimatePresence>

      <main inert={anyModalOpen ? true : undefined}
        className={`game-main max-w-[1280px] mx-auto grid noselect ${mobileGame ? 'grid-cols-1 gap-3' : 'grid-cols-[360px_minmax(0,1fr)] gap-8'}`}
      >
        <div data-testid="round-stage" data-round-stage={stageState}
          className={`wheel-column flex flex-col items-center gap-4 min-w-0 ${mobileGame ? 'mobile-stage' : ''} ${stageVisible ? 'stage-visible' : ''}`}
        >
          <div className={`wheel-camera ${!mobileGame && landingPocket !== null ? 'camera-closeup' : ''}` } >
            <div className="wheel-live">
              <RouletteWheel spinToken={spinToken} pocket={lastPocket} onSettled={handleSettled} spinDuration={autoSpin ? 4.4 : 5.2} />
            </div>
            <AnimatePresence>
              {!mobileGame && landingPocket !== null && <motion.div className="closeup-overlay" key={`landed-${spinToken}`}
                initial={{ opacity: 0, transform: reduceMotion ? 'none' : 'scale(0.96)' }}
                animate={{ opacity: 1, transform: 'scale(1)' }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
                <PocketCloseup pocket={landingPocket} />
              </motion.div>}
            </AnimatePresence>
          </div>
          <AnimatePresence>
            {!mobileGame && lastResult && (
              <motion.div
                initial={{ opacity: 0, y: 10, scale: 0.92 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0 }}
                transition={{ type: 'spring', stiffness: 340, damping: 22 }}
                className={`round-result-panel w-full rounded-xl p-4 border text-center ${
                  lastResult.totalPayoutCents > 0
                    ? 'bg-emerald-900/30 border-emerald-500 pulse-win'
                    : 'bg-zinc-900/60 border-zinc-700'
                }`}
              >
                <div className="text-sm text-[#9b98ab]">Pocket {lastResult.pocket} · {lastResult.color.toUpperCase()}</div>
                <motion.div
                  initial={lastResult.totalPayoutCents > 0 ? { scale: 1.3 } : { scale: 1 }}
                  animate={{ scale: 1 }}
                  transition={{ type: 'spring', stiffness: 260, damping: 14 }}
                  className={lastResult.totalPayoutCents > 0 ? 'text-2xl font-extrabold text-emerald-300 tracking-wide' : 'text-lg font-bold'}
                >
                  {lastResult.totalPayoutCents > 0
                    ? `WON ${fmt(lastResult.totalPayoutCents)}`
                    : `LOST ${fmt(lastResult.totalStakeCents)}`}
                </motion.div>
                {autoVerify && (
                  <div className={`mt-1 text-[11px] flex items-center justify-center gap-1 ${autoVerify.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                    <span className={`inline-block w-1.5 h-1.5 rounded-full ${autoVerify.ok ? 'bg-emerald-400' : 'bg-red-500'}`} />
                    {autoVerify.ok ? 'Outcome and payout verified in your browser' : 'Verification mismatch. See details below.'}
                  </div>
                )}
                <button
                  onClick={verifyLastOutcome}
                  className="mt-2 text-xs text-[#d6b06a] underline underline-offset-2"
                >
                  Verify this outcome independently →
                </button>
              </motion.div>
            )}
          </AnimatePresence>
          {!mobileGame && <CasinoReserve variant="card" />}
          {!mobileGame && <SupportLink className="support-under-reserve" />}
          {mobileGame && <MobileRoundFeedback spinning={spinning} landingPocket={landingPocket} settledPocket={settledPocket}
            lastResult={lastResult} winPopup={winPopup} phase={revealPhase} amount={transferAmountCents} balance={displayBalanceCents}
            autoVerify={autoVerify} onVerify={verifyLastOutcome} onSkip={() => { skipReveal.current = true; }} onContinue={() => { continueRef.current = true; }} mode={mode} />}
        </div>

        <div className="table-column flex flex-col gap-3 min-w-0">
          <div className="recent-strip"><RecentNumbers numbers={recentNumbers} compact={mobileGame} />
            {mobileGame && lastResult && <div className="inline-round-result">
              <div><strong>{lastResult.totalPayoutCents ? `WON ${fmt(lastResult.totalPayoutCents)}` : `LOST ${fmt(lastResult.totalStakeCents)}`}</strong><button onClick={verifyLastOutcome}><span className="sr-only">Verify this outcome independently </span>Proof ↗</button></div>
              <span className={autoVerify?.ok ? 'text-emerald-300' : 'text-red-300'}>{autoVerify?.ok ? 'Outcome and payout verified in your browser' : 'Verification mismatch. Review the proof.'}</span>
            </div>}
          </div>
          <div className={`felt-table brand-felt rounded-xl relative ${landscape ? 'p-1.5' : 'p-2 sm:p-4'}`}>
            <PlayCover covered={guard.covered} onDismiss={guard.dismiss} />
            <RouletteBoard
              bets={bets}
              portrait={false}
              fill={mobileGame}
              onAddBet={boardAdd}
              onRemoveBet={boardRemove}
              disabled={busy || autoSpin}
              settledPocket={settledPocket}
              showResults={showResults}
              payouts={payoutPops}
              chipValue={chip}
              onHoverInfo={setHoverInfo}
              fitHeight={undefined}
            />
          </div>
          <div className={`table-help h-5 -mt-1 text-center text-xs text-[#d6b06a]/90 ${landscape ? 'hidden' : ''}`}>
            {hoverInfo ? (
              <span>
                <span className="font-semibold text-[#ede9e1]">{hoverInfo.label}</span> · pays {hoverInfo.odds}
                {hoverInfo.staked > 0 && <span> · your bet {fmtShort(hoverInfo.staked)}</span>}
              </span>
            ) : (
              <span className="text-[#63607a]">Tap or click the felt to place the selected chip · hold / right-click to remove</span>
            )}
          </div>

          <div ref={controlsRef} className={`bet-controls brand-panel rounded-xl flex flex-col gap-3 p-3 sm:p-4 ${mobileGame ? 'mobile-controls' : ''}`}>
            <div className="chip-balance-row flex items-center gap-2 justify-between min-w-0">
              <div className="chip-rail flex gap-1.5 sm:gap-2 min-w-0">
                {DENOMS.map((d, i) => (
                  <motion.button
                    key={d.cents}
                    type="button"
                    tabIndex={-1}
                    onClick={() => { setChip(d.cents); playChipSelect(); }}
                    whileTap={{ scale: 0.88 }}
                    animate={{ y: chip === d.cents ? -8 : 0, scale: chip === d.cents ? 1.12 : 1 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 20 }}
                    title={`${d.name} chip (key ${i + 1})`}
                    className="denom-button rounded-full shrink-0"
                    data-selected={chip === d.cents ? 'true' : undefined}
                  >
                    <Chip cents={d.cents} size={mobileGame ? 32 : 46} selected={chip === d.cents} />
                  </motion.button>
                ))}
              </div>
              <div className="tray-balances flex items-center gap-2.5 shrink-0">
                <div className="text-right text-[10px] sm:text-xs text-[#9b98ab]">
                  Balance
                  <div className="font-bold gold-text text-sm sm:text-base leading-tight"><span data-balance-target="tray">{user ? fmt(displayBalanceCents) : '-'}</span></div>
                </div>
                <div className="text-right text-[10px] sm:text-xs text-[#9b98ab]">
                  On table
                  <div className={`font-bold text-[#ede9e1] leading-tight ${landscape ? 'text-sm' : 'text-sm sm:text-base'}`}>{fmt(totalStaked)}</div>
                </div>
              </div>
            </div>
            <div className="bet-actions grid grid-cols-6 gap-1.5 min-w-0">
              <button onClick={undoLastBet} disabled={busy || autoSpin || betHistory.length === 0} className={`${landscape ? 'py-1.5' : 'py-2.5'} rounded-lg brand-btn text-sm disabled:opacity-40 active:scale-95 transition-transform`} title="Remove the last chip you placed (U)">Undo</button>
              <button onClick={repeatBet} disabled={busy || autoSpin || lastBets.length === 0} className={`${landscape ? 'py-1.5' : 'py-2.5'} rounded-lg brand-btn text-sm disabled:opacity-40 active:scale-95 transition-transform`} title="Put your previous bet back (R)">Rebet</button>
              <button onClick={doubleBets} disabled={busy || autoSpin || bets.length === 0} className={`${landscape ? 'py-1.5' : 'py-2.5'} rounded-lg brand-btn text-sm disabled:opacity-40 active:scale-95 transition-transform`} title="Double every bet (D)">2x</button>
              <button onClick={clearBets} disabled={busy || autoSpin || bets.length === 0} className={`${landscape ? 'py-1.5' : 'py-2.5'} rounded-lg brand-btn text-sm disabled:opacity-40 active:scale-95 transition-transform`} title="Clear the table (C)">Clear</button>
              <button
                onClick={toggleAutoSpin}
                disabled={!autoSpin && (!readyToSpin || bets.length === 0)}
                className={`${landscape ? 'py-1.5' : 'py-2.5'} rounded-lg text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 transition-transform ${autoSpin ? 'brand-stop' : 'brand-btn'}`}
                title="Repeat this bet automatically until you stop it or run out of balance"
              >
                {autoSpin ? 'Stop' : 'Auto'}
              </button>
              <button
                onClick={spin}
                disabled={!readyToSpin || autoSpin || bets.length === 0 || (user && totalStaked > balanceNow)}
                className={`${landscape ? 'py-1.5' : 'py-2.5'} rounded-lg brand-spin text-sm disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 transition-transform`}
                title="Spin (Space)"
              >
                {autoSpin ? 'Auto on' : verificationBlocked ? 'BLOCKED' : tableNeedsConfirm ? 'CHECK PAYOUTS' : !commitment || !gameConfig ? 'Loading…' : clientSeedSaving ? 'Saving…' : busy ? '…' : 'SPIN'}
              </button>
            </div>
            {autoSpin && (
              <div className="auto-status text-[11px] text-red-300 text-center animate-pulse">Auto-bet running. Press Stop to end it</div>
            )}
            <div className={`keyboard-hint ${landscape ? 'hidden' : 'hidden sm:block'} text-[11px] text-[#63607a]`}>Shortcuts: 1 to 8 pick a chip · Space spin · U undo · R rebet · D double · C clear</div>
          </div>

          {!mobileGame && <div className="history-panel brand-panel rounded-xl p-4">
            <h2 className="text-sm font-semibold text-[#9b98ab] mb-2">RECENT ROUNDS <span className="text-[11px] font-normal text-[#63607a]">· tap one for the breakdown</span></h2>
            {historyList}
            <p className="site-foot"><a href="/terms" target="_blank" rel="noopener">Terms</a> · 18+ only · Play at your own risk</p>
          </div>}
        </div>
      </main>

      {tableNeedsConfirm && tableNoticeOpen && ageOk && (
        <div className="fair-backdrop" onClick={() => setTableNoticeOpen(false)}>
          <div className="fair-modal" role="dialog" aria-modal="true" aria-label="Payouts at this table" data-testid="payout-table-notice" onClick={(e) => e.stopPropagation()}>
            <div className="fair-head"><h3>Payouts at this table</h3><button type="button" onClick={() => setTableNoticeOpen(false)} aria-label="Close">✕</button></div>
            {tableRecheck && <p className="fair-note" data-testid="payout-table-changed">{TABLE_CHANGED_MESSAGE}</p>}
            {tableCheck.lower ? <>
              <p className="fair-note">This table pays less than standard European roulette on some bets{gameConfig?.math?.label ? <> ({gameConfig.math.label})</> : null}:</p>
              <ul className="fair-note" data-testid="payout-table-differences">
                {describeTableDifferences(tableCheck.differences).map((line) => <li key={line}>{line}</li>)}
              </ul>
              <p className="fair-note">Every other bet pays the standard amount. Please accept this once before you bet.</p>
            </> : <p className="fair-note">This table now pays the standard European roulette amount on every bet.</p>}
            <div className="fair-btn-row">
              <button type="button" className="fair-btn fair-btn-ghost" onClick={() => setTableNoticeOpen(false)}>Not now</button>
              <button type="button" className="fair-btn" onClick={acceptTable} data-testid="payout-table-accept">Accept and play</button>
            </div>
          </div>
        </div>
      )}
      <AnimatePresence>
        {sheet && <ProfileSheet key="profile" page="roulette" mobile={mobileGame} initialTab={sheet.tab} onClose={() => setSheet(null)}
          profile={profile} wallet={user} mode={mode} balance={user ? displayBalanceCents : null}
          onConnect={connectFromHeader} connecting={walletBusy} onDisconnect={async () => { setSheet(null); await disconnectWallet(); }} disconnectDisabled={busy || autoSpin}
          deposit={deposit} onTopUp={topUp} onRefresh={async () => { await Promise.all([refreshProfile(), refreshWallet()]); }}
          inbox={inbox}
          historyContent={<div className="profile-history-wrap">{mobileGame && <CasinoReserve variant="compact" className="mb-3" />}{historyList}</div>}
          fairnessContent={fairnessTab}
          rows={[
            { key: 'how', label: 'How it works', href: '/how-it-works', testid: 'profile-row-how' },
            mode === 'demo' && { key: 'reset', label: refilling ? 'Resetting...' : 'Reset demo balance', note: 'Back to the demo start', testid: 'demo-refill', disabled: busy || autoSpin || !user || refilling, onClick: () => { setSheet(null); resetDemoBalance(); } },
          ].filter(Boolean)} />}
      </AnimatePresence>
      {!ageOk && <AgeGate onAccept={acceptAge} />}
      {ageOk && connectNoticeOpen && <ConnectNotice onContinue={continueConnect} onClose={closeConnectNotice} />}
      <AnimatePresence>
        {verifyOpen && (
          <FairnessSheet result={verifyResult} loading={verifyLoading} mobile={mobileGame}
            onClose={() => setVerifyOpen(false)} onDownloadProof={downloadProof} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {detailRound && (
          <RoundDetail
            round={detailRound}
            onClose={() => setDetailRound(null)}
            onVerify={(r) => { setDetailRound(null); runVerify(r); }}
          />
        )}
      </AnimatePresence>


      {inbox.popupNode}
    </div>
  );
}
