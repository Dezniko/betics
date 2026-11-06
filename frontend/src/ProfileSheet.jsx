import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import Avatar from './Avatar.jsx';
import SupportLink from './Support.jsx';
import { WalletContent, useAnchor, memberSince } from './WalletPanel.jsx';
import { SoundSettingsPanel, useSoundSummary } from './SoundControls.jsx';
import { InboxList } from './Inbox.jsx';
import { fmtMoney } from './chips.js';
import { lockBackgroundScroll } from './modalScrollLock.js';
import './profileSheet.css';

// The one profile pop-up of the lobby, the roulette page and Gods of Power. Desktop: a drop-down
// hanging from the header profile pill with a folder tab (useAnchor). Phones: a bottom sheet with a
// grabber. Background scroll locked, Escape and the backdrop close it, the page behind is inert.
// Content: wallet card, tabs Wallet | History | Fairness (the page passes the History and Fairness
// content), then rows: Sound (inline settings), Messages (inline inbox), the page's own rows, and
// Disconnect. Foot links: How it works, Terms, Support.
export const MAIN_TABS = Object.freeze([['wallet', 'Wallet'], ['history', 'History'], ['fairness', 'Fairness']]);
const Person = () => <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>;
const Chev = () => <svg className="profile-row-chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>;
const Down = ({ open }) => <svg className={`profile-row-chev down${open ? ' open' : ''}`} viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>;

// A row under the tabs: a link, an action, or an inline expander (Sound, Messages).
function Row({ row, open, onToggle }) {
  const inner = <><span className="profile-row-label">{row.label}</span>{row.note != null && <small className="profile-row-note">{row.note}</small>}{row.expand ? <Down open={open} /> : <Chev />}</>;
  if (row.href) return <a className={`profile-row${row.danger ? ' danger' : ''}`} href={row.href} target={row.external ? '_blank' : undefined} rel={row.external ? 'noopener noreferrer' : undefined} data-testid={row.testid}>{inner}</a>;
  return <div className={`profile-row-wrap${open ? ' open' : ''}`}>
    <button type="button" className={`profile-row${row.danger ? ' danger' : ''}`} data-testid={row.testid} disabled={row.disabled} aria-expanded={row.expand ? open : undefined}
      onClick={() => (row.expand ? onToggle() : row.onClick?.())}>{inner}</button>
    {row.expand && open && <div className="profile-row-body" data-testid={`${row.testid}-body`}>{row.expand}</div>}
  </div>;
}

export default function ProfileSheet({
  open = true, onClose, mobile, page = 'lobby', initialTab = 'wallet', initialExpanded = null, // a row key open from the start (the bell opens 'messages')
  profile = null, wallet = null, mode = 'demo', balance = null,
  onConnect, connecting = false, onDisconnect, disconnectDisabled = false,
  deposit = null, onTopUp, onRefresh,
  historyContent = null, fairnessContent = null, rows = [], inbox = null,
  onResetDemo = null, resetDisabled = false, resetting = false, // staging play-money reset, shown in Demo on every page
}) {
  const connected = !!profile?.address;
  const [tab, setTab] = useState(MAIN_TABS.some(([k]) => k === initialTab) ? initialTab : 'wallet');
  const [expanded, setExpanded] = useState(initialExpanded);
  const [disconnecting, setDisconnecting] = useState(false);
  const rowsRef = useRef(null);
  // Opened on a row (the bell opens Messages): bring that row and its body into view inside the sheet.
  useEffect(() => {
    if (!initialExpanded || !rowsRef.current) return undefined;
    const t = setTimeout(() => rowsRef.current?.querySelector('.profile-row-wrap.open')?.scrollIntoView({ block: 'start', behavior: 'auto' }), 60);
    return () => clearTimeout(t);
  }, [initialExpanded]);
  const soundSummary = useSoundSummary();
  useLayoutEffect(() => lockBackgroundScroll(open), [open]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey, true); return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const anchor = useAnchor(!mobile);
  const dropdown = !mobile && !!anchor;
  const tabW = dropdown ? Math.max(150, Math.round(anchor.width + 16)) : 0;
  const panelW = dropdown ? Math.min(420, window.innerWidth - 24) : 0;
  const right = dropdown ? Math.max(12, Math.round(window.innerWidth - anchor.right - 8)) : 0;
  const top = dropdown ? Math.max(8, Math.round(anchor.top - 6)) : 0;
  const tabH = dropdown ? Math.round(anchor.height + 12) : 0;
  const style = dropdown ? { position: 'fixed', top, right, width: panelW, '--tab-w': `${tabW}px`, '--tab-h': `${tabH}px`, maxHeight: `calc(100dvh - ${top + 16}px)` } : undefined;
  const motionProps = mobile
    ? { initial: { y: '100%' }, animate: { y: 0 }, exit: { y: '100%' } }
    : { initial: { opacity: 0, y: -8, scale: 0.98 }, animate: { opacity: 1, y: 0, scale: 1 }, exit: { opacity: 0, y: -6 } };
  const member = connected ? memberSince(profile.firstConnectedAt) : null;
  const toggle = (key) => setExpanded((e) => (e === key ? null : key));
  const allRows = [
    { key: 'sound', label: 'Sound', note: soundSummary, testid: 'profile-sound', expand: <SoundSettingsPanel /> },
    inbox && { key: 'messages', label: 'Messages', note: inbox.unseen > 0 ? `${inbox.unseen} new` : inbox.messages.length ? `${inbox.messages.length}` : 'None', testid: 'profile-messages', expand: <InboxList inbox={inbox} />, onExpand: inbox.markSeen },
    ...rows,
    onResetDemo && wallet && mode === 'demo' && { key: 'reset', label: resetting ? 'Resetting...' : 'Reset demo balance', note: 'Back to the demo start', testid: 'demo-refill', disabled: resetting || resetDisabled,
      onClick: () => { onClose(); onResetDemo(); } },
    connected && { key: 'disconnect', label: disconnecting ? 'Disconnecting...' : 'Disconnect', testid: 'wallet-disconnect', danger: true, disabled: disconnecting || disconnectDisabled,
      onClick: async () => { setDisconnecting(true); try { await onDisconnect(); } finally { setDisconnecting(false); } } },
  ].filter(Boolean);
  return <motion.div className={`fair-backdrop profile-sheet-backdrop ${dropdown ? 'profile-backdrop' : ''}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} data-testid="profile-backdrop">
    <motion.div className={`${mobile ? 'fair-sheet' : 'fair-modal'} wallet-panel profile-panel profile-sheet ${dropdown ? 'profile-dropdown' : ''}`} style={style} role="dialog" aria-modal="true" aria-label="My profile" data-testid="wallet-panel" data-page={page} data-connected={connected ? 'yes' : 'no'}
      {...motionProps} transition={{ type: 'spring', stiffness: 460, damping: 38 }} onClick={(e) => e.stopPropagation()}>
      {mobile && <div className="fair-grabber" aria-hidden="true" />}
      <div className="profile-folder-tab"><span>My profile</span><button type="button" className="profile-close" data-testid="profile-close" onClick={onClose} aria-label="Close">✕</button></div>
      <div className="profile-body">
        {connected ? <div className="profile-wallet-card" data-testid="profile-card">
          <Avatar address={profile.address} size={mobile ? 40 : 44} className="profile-avatar" />
          <div className="profile-wallet-text">
            <strong className="profile-wallet-balance" data-testid="profile-balance" data-mode={mode}>{balance != null ? fmtMoney(balance) : '...'}</strong>
            <span className="profile-wallet-meta"><code className="wallet-mono profile-wallet-address" data-testid="wallet-address">{profile.address}</code></span>
            <span className="profile-wallet-tags"><span className="profile-tag"><span className="wallet-dot" aria-hidden="true" />Ethereum</span><span className={`profile-tag mode-${mode}`} data-testid="profile-mode-tag">{mode === 'real' ? 'Real' : 'Demo'}</span>{member && <span className="profile-tag">Since {member}</span>}</span>
          </div>
        </div> : <div className="profile-wallet-card guest" data-testid="profile-card">
          <span className="profile-avatar profile-guest-avatar" aria-hidden="true"><Person /></span>
          <div className="profile-wallet-text">
            <strong className="profile-wallet-balance" data-testid="profile-balance" data-mode={mode}>{balance != null ? fmtMoney(balance) : 'Not connected'}</strong>
            <span className="profile-wallet-meta">{balance != null ? 'Demo balance. Not connected.' : 'Connect a wallet to play with real $TICS.'}</span>
            <button type="button" className="fair-btn profile-connect" data-testid="sheet-connect" disabled={connecting} onClick={onConnect}>{connecting ? 'Connecting...' : 'Connect wallet'}</button>
          </div>
        </div>}
        <div className="profile-tabs profile-main-tabs" role="tablist" aria-label="Profile sections">
          {MAIN_TABS.map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'on' : ''} data-testid={`tab-${key}`} onClick={() => setTab(key)}>{label}</button>)}
        </div>
        <div className="profile-main-body" role="tabpanel" data-testid={`profile-${tab}`}>
          {tab === 'wallet' && (connected
            ? <WalletContent profile={profile} wallet={wallet} deposit={deposit} onTopUp={onTopUp} onRefresh={onRefresh} />
            : <div className="profile-guest-wallet" data-testid="guest-wallet">
              <p className="fair-note">You are playing with demo $TICS. Connect your wallet to top up, play with real $TICS and withdraw your winnings to the same wallet.</p>
            </div>)}
          {tab === 'history' && (historyContent || <p className="fair-note">Your recent rounds show here inside each game.</p>)}
          {tab === 'fairness' && (fairnessContent || <p className="fair-note">Every round is locked before you bet and opened after it, so you can check the result yourself.</p>)}
        </div>
        <div className="profile-rows-list" data-testid="profile-rows" ref={rowsRef}>
          {allRows.map((row) => <Row key={row.key} row={row} open={expanded === row.key} onToggle={() => { toggle(row.key); if (expanded !== row.key) row.onExpand?.(); }} />)}
        </div>
        <div className="profile-foot-links">
          <a href="/how-it-works" target="_blank" rel="noopener" data-testid="profile-how">How it works</a>
          <a href="/terms" target="_blank" rel="noopener" data-testid="profile-terms">Terms</a>
          <SupportLink testid="profile-support" className="profile-foot-support" label="Telegram" />
        </div>
      </div>
    </motion.div>
  </motion.div>;
}
