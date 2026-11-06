import { useCallback, useEffect, useRef, useState } from 'react';
import { walletApi, resolveMode, modeBalance, STORAGE, isSignedInElsewhere } from './walletApi.js';
import { needsConnectNotice, acceptConnectNotice } from './connectNotice.js';
import { tabIdFor } from './tabPresence.js';
import { pollDelayMs, refreshOnVisibility, ME_POLL_MS } from './sessionPolling.js';
export { ME_POLL_MS };

// Session, wallet profile, Real or Demo choice and the 18+ gate, shared by the lobby and the slot page.
// The same flow as the roulette page (App.jsx): guest session by cookie, wallet sign in through the
// lazily loaded wallet bundle, the one time "Before you connect" notice, and the mode rule from
// resolveMode. While a wallet is connected the profile is read again on the schedule in sessionPolling.js
// (10 s while playing, 30 s idle, never while the tab is hidden, at once when it comes back), so a session
// closed by a sign in from another browser (401 signed_in_elsewhere) is noticed within about 15 s of play:
// the page goes back to Demo and `elsewhere` carries the server's text for a toast with "Connect again".
const readStore = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const writeStore = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } };
let walletModule = null;
const loadWalletModule = () => (walletModule ||= import('./walletConnect.js'));

export default function useSession({ busy = false } = {}) {
  const [user, setUser] = useState(null);       // session balances: { balanceCents, realTicsCents, demoAllowed, ... }
  const [profile, setProfile] = useState(null); // connected wallet, null for a guest
  const [storedMode, setStoredMode] = useState(() => readStore(STORAGE.mode));
  const [ageOk, setAgeOk] = useState(() => readStore(STORAGE.adult) === '1');
  const [walletBusy, setWalletBusy] = useState(false);
  const [connectNoticeOpen, setConnectNoticeOpen] = useState(false);
  const [error, setError] = useState(null);
  const [elsewhere, setElsewhere] = useState(null); // server text after the session was closed by another sign in
  const [identity, setIdentity] = useState(null);
  const [tabId] = useState(() => { try { return tabIdFor(); } catch { return null; } });
  const busyRef = useRef(busy); busyRef.current = busy;

  const loadSession = useCallback(async (id) => {
    const u = await walletApi.session();
    setUser({ ...u, identity: id });
    setIdentity(id);
  }, []);
  // A wallet session closed from another browser: back to a guest session, the reason kept for the page.
  const signedOutElsewhere = useCallback(async (e) => {
    setProfile(null);
    setElsewhere(e?.message || 'You connected this wallet in another browser or device. Connect again to play here.');
    await loadSession('guest').catch(() => {});
  }, [loadSession]);
  useEffect(() => {
    (async () => {
      let p = null;
      try { p = await walletApi.me(); } catch (e) { if (isSignedInElsewhere(e)) { await signedOutElsewhere(e); return; } }
      setProfile(p);
      await loadSession(p?.address || 'guest');
    })().catch((e) => setError(String(e.message || e)));
  }, [loadSession, signedOutElsewhere]);

  const refreshWallet = useCallback(async () => {
    try { const w = await walletApi.wallet(); setUser((u) => (u ? { ...u, ...w } : u)); } catch { /* keep the last known */ }
  }, []);
  const refreshProfile = useCallback(async () => {
    try { const p = await walletApi.me(); if (p) setProfile(p); }
    catch (e) { if (isSignedInElsewhere(e)) await signedOutElsewhere(e); }
  }, [signedOutElsewhere]);
  // Poll the profile while connected and visible, so a session closed elsewhere is noticed quickly during
  // play, without a background tab hitting /api/wallet/me every 10 s all day (sessionPolling.js).
  const connected = !!profile?.address;
  const lastRoundAtRef = useRef(null);
  useEffect(() => {
    if (!connected) return undefined;
    let timer = 0, stopped = false;
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const schedule = () => {
      clearTimeout(timer);
      if (stopped) return;
      const delay = pollDelayMs({ connected, visible: visible(), lastRoundAt: lastRoundAtRef.current, busy: busyRef.current });
      if (delay == null) return; // hidden: the visibilitychange handler restarts the schedule
      timer = setTimeout(async () => { await refreshProfile(); schedule(); }, delay);
    };
    const onVisible = () => { if (refreshOnVisibility({ connected, visible: visible() })) { refreshProfile(); schedule(); } else clearTimeout(timer); };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    schedule();
    return () => { stopped = true; clearTimeout(timer); window.removeEventListener('focus', onVisible); document.removeEventListener('visibilitychange', onVisible); };
  }, [connected, refreshProfile]);

  const switchIdentity = async (p) => {
    setProfile(p);
    setError(null); setElsewhere(null);
    await loadSession(p?.address || 'guest');
  };
  const connectWallet = async () => {
    if (walletBusy || busyRef.current) return;
    setWalletBusy(true); setError(null); setElsewhere(null);
    try {
      const w = await loadWalletModule();
      const p = await w.signIn();
      await walletApi.terms().catch(() => {});
      await switchIdentity(p);
      await refreshProfile();
    } catch (e) { setError(e.message || 'The wallet could not connect.'); }
    finally { setWalletBusy(false); }
  };
  const requestConnect = () => { if (walletBusy || busyRef.current) return; if (needsConnectNotice()) setConnectNoticeOpen(true); else connectWallet(); };
  const continueConnect = () => { acceptConnectNotice(); setConnectNoticeOpen(false); connectWallet(); };
  const closeConnectNotice = useCallback(() => setConnectNoticeOpen(false), []);
  const disconnectWallet = async () => {
    if (busyRef.current) return;
    await walletApi.logout().catch(() => {});
    if (walletModule) walletModule.then((m) => m.disconnectWallet()).catch(() => {});
    await switchIdentity(null).catch((e) => setError(e.message));
  };
  const acceptAge = () => { writeStore(STORAGE.adult, '1'); setAgeOk(true); if (profile) walletApi.terms().catch(() => {}); };

  const modeInfo = resolveMode({ stored: storedMode, wallet: user, profile });
  const mode = modeInfo.mode;
  const balance = modeBalance(user, mode);
  // Returns the reason when the mode cannot be chosen, else null.
  const chooseMode = (m) => {
    if (busyRef.current || m === mode) return null;
    if (m === 'real' && !modeInfo.realAvailable) return modeInfo.realReason;
    writeStore(STORAGE.mode, m); setStoredMode(m);
    return null;
  };
  // The settled balance from a spin reply, written into the mode's field.
  const applyBalance = useCallback((m, cents) => {
    lastRoundAtRef.current = Date.now(); // a round just settled: poll at the play rate for a minute
    setUser((u) => (u ? { ...u, [m === 'real' ? 'realTicsCents' : 'balanceCents']: cents } : u));
  }, []);

  // Staging only play-money reset (the server answers 404 on live). Shared by every page's profile sheet.
  const [demoResetting, setDemoResetting] = useState(false);
  const resetDemoBalance = useCallback(async () => {
    setDemoResetting(true);
    try {
      const response = await fetch('/api/demo/reset-balance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Demo balance could not be reset.');
      setUser((u) => (u ? { ...u, ...result } : u));
      return result;
    } finally { setDemoResetting(false); }
  }, []);

  return { user, profile, identity, tabId, mode, modeInfo, balance, ageOk, acceptAge, walletBusy, connectNoticeOpen, requestConnect, continueConnect, closeConnectNotice,
    disconnectWallet, refreshWallet, refreshProfile, chooseMode, applyBalance, resetDemoBalance, demoResetting, signedOutElsewhere, sessionError: error, clearSessionError: () => setError(null),
    elsewhere, clearElsewhere: () => setElsewhere(null) };
}
