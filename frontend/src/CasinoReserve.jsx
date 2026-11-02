import { useEffect, useState } from 'react';
import { fmtMoney } from './chips.js';
import { etherscanAddress, PINNED_WALLET_URL, reserveWalletMatches } from './depositTarget.js';

// Casino reserve: what the casino wallet holds on-chain (read from Ethereum by the server),
// whether it covers every player balance, and the most a single spin can win right now.
// Polled every minute; the server caches the figure for 20 seconds.
let shared = null, listeners = new Set(), timer = null;
async function load() {
  try {
    const r = await fetch('/api/casino/reserve');
    const d = await r.json();
    shared = r.ok ? d : { live: false };
  } catch { shared = shared || { live: false }; }
  listeners.forEach((fn) => fn(shared));
}
export function useCasinoReserve() {
  const [value, setValue] = useState(shared);
  useEffect(() => {
    listeners.add(setValue);
    if (!timer) { load(); timer = setInterval(load, 60000); }
    else if (shared) setValue(shared);
    return () => { listeners.delete(setValue); if (!listeners.size) { clearInterval(timer); timer = null; } };
  }, []);
  return value;
}
export const refreshCasinoReserve = load;

export { etherscanAddress, PINNED_WALLET_URL, reserveWalletMatches };
const ShieldIcon = () => <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z" /><path d="M9 12l2 2 4-4" /></svg>;

// variant: 'card' (desktop, under the wheel), 'compact' (phone history sheet, profile)
export default function CasinoReserve({ variant = 'card', className = '' }) {
  const r = useCasinoReserve();
  if (!r || !r.live) return null;
  // "Covered" is only shown for the casino wallet pinned in this page; the link always opens that wallet.
  const pinned = reserveWalletMatches(r);
  const ok = r.covered && pinned;
  return <section className={`casino-reserve casino-reserve-${variant} ${ok ? 'ok' : 'warn'} ${className}`} data-testid="casino-reserve" aria-label="Casino reserve">
    <div className="casino-reserve-head">
      <span className="casino-reserve-icon"><ShieldIcon /></span>
      <span className="casino-reserve-title">Casino reserve</span>
      <span className={`casino-reserve-badge ${ok ? 'ok' : 'warn'}`}>{!pinned ? 'Wallet not confirmed' : ok ? 'All balances covered' : 'Being topped up'}</span>
    </div>
    <strong className="casino-reserve-amount" data-testid="casino-reserve-amount">{fmtMoney(r.tokenUnits)}</strong>
    <div className="casino-reserve-lines">
      <span>Max win per spin <b data-testid="casino-reserve-maxwin">{r.maxWinUnits > 0 ? fmtMoney(r.maxWinUnits) : 'paused'}</b></span>
      {r.maxWinUnits > 0 && Number.isSafeInteger(r.maxStraightUnits) && <span>Max bet on one number <b data-testid="casino-reserve-maxstraight">{fmtMoney(r.maxStraightUnits)}</b></span>}
      <a href={PINNED_WALLET_URL} target="_blank" rel="noopener noreferrer">Live on Etherscan</a>
      <a href="/how-it-works" target="_blank" rel="noopener" data-testid="how-it-works-link">How your balance is covered</a>
    </div>
    {!pinned && <p className="casino-reserve-note" data-testid="casino-reserve-mismatch">The server reported a different casino wallet than the one this page knows, so these figures cannot be confirmed. Check the wallet on Etherscan.</p>}
    {variant === 'card' && <p className="casino-reserve-note">Held in the casino wallet on Ethereum. Max win per spin is the most one spin can pay, stake included. The table will not take a bet that could pay more, in Demo or Real.</p>}
  </section>;
}
