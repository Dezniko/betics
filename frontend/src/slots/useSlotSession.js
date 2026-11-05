import { useCallback, useEffect, useRef, useState } from 'react';
import { walletApi, resolveMode, modeBalance, STORAGE } from '../walletApi.js';
import { needsConnectNotice, acceptConnectNotice } from '../connectNotice.js';

// Session, wallet profile, Real or Demo choice and the 18+ gate for the slot page. The same flow as
// the roulette page (App.jsx): guest session by cookie, wallet sign in through the lazily loaded wallet
// bundle, the one time "Before you connect" notice, and the mode rule from resolveMode.
const readStore = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const writeStore = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } };
let walletModule = null;
const loadWalletModule = () => (walletModule ||= import('../walletConnect.js'));

export default function useSlotSession({ busy = false } = {}) {
  const [user, setUser] = useState(null);       // session balances: { balanceCents, realTicsCents, demoAllowed, ... }
  const [profile, setProfile] = useState(null); // connected wallet, null for a guest
  const [storedMode, setStoredMode] = useState(() => readStore(STORAGE.mode));
  const [ageOk, setAgeOk] = useState(() => readStore(STORAGE.adult) === '1');
  const [walletBusy, setWalletBusy] = useState(false);
  const [connectNoticeOpen, setConnectNoticeOpen] = useState(false);
  const [error, setError] = useState(null);
  const [identity, setIdentity] = useState(null);
  const busyRef = useRef(busy); busyRef.current = busy;

  const loadSession = useCallback(async (id) => {
    const u = await walletApi.session();
    setUser({ ...u, identity: id });
    setIdentity(id);
  }, []);
  useEffect(() => {
    (async () => {
      const p = await walletApi.me().catch(() => null);
      setProfile(p);
      await loadSession(p?.address || 'guest');
    })().catch((e) => setError(String(e.message || e)));
  }, [loadSession]);

  const refreshWallet = useCallback(async () => {
    try { const w = await walletApi.wallet(); setUser((u) => (u ? { ...u, ...w } : u)); } catch { /* keep the last known */ }
  }, []);
  const refreshProfile = useCallback(async () => { const p = await walletApi.me().catch(() => null); if (p) setProfile(p); }, []);

  const switchIdentity = async (p) => {
    setProfile(p);
    setError(null);
    await loadSession(p?.address || 'guest');
  };
  const connectWallet = async () => {
    if (walletBusy || busyRef.current) return;
    setWalletBusy(true); setError(null);
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
    setUser((u) => (u ? { ...u, [m === 'real' ? 'realTicsCents' : 'balanceCents']: cents } : u));
  }, []);

  return { user, profile, identity, mode, modeInfo, balance, ageOk, acceptAge, walletBusy, connectNoticeOpen, requestConnect, continueConnect, closeConnectNotice,
    disconnectWallet, refreshWallet, refreshProfile, chooseMode, applyBalance, sessionError: error, clearSessionError: () => setError(null) };
}
