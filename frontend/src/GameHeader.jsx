import BrandLogo from './BrandLogo.jsx';
import LobbyLink from './LobbyLink.jsx';
import Avatar from './Avatar.jsx';
import { MuteButton } from './SoundControls.jsx';
import { shortAddress } from './walletApi.js';
import { headerItems, phoneRows, profilePill, balanceLabel, bellBadge } from './headerModel.js';
import './gameHeader.css';

// The one header of the lobby, the roulette page and Gods of Power. Left to right: logo (to the
// lobby), Lobby pill and Next lock pill (games only), then balance (DEMO BALANCE or REAL BALANCE over
// the amount), the Real/Demo switch (always shown; a guest tapping Real starts the connect flow), the
// one tap mute, the notification bell (lit with a red count while messages are unread) and the profile
// controls: connected = the avatar + short address chip; guest = a gold Connect wallet pill and, last
// on the right, a round neon person icon that opens the profile sheet. Portrait phones split it over
// two short rows (headerModel.js). The page renders its toasts as children so they float under the
// header without moving the table.
const LockGlyph = () => <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>;
const Person = () => <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>;
const Bell = () => <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20a2 2 0 0 0 4 0" /></svg>;

export default function GameHeader({
  page, layout, inert, children,
  balanceText, balanceNote = null, mode, modeInfo, showSwitch = true, modeDisabled = false, onMode,
  lock = null, // { hash, status: 'ok' | 'bad' | '', onTap, title }
  profile = null, profileOpen = false, onProfile, onConnect, connecting = false, connectDisabled = false,
  inbox = null, onBell, // inbox.unseen lights the bell; onBell opens the sheet on Messages
}) {
  const portrait = layout === 'portrait';
  const connected = !!profile?.address;
  const items = headerItems({ page, connected: showSwitch, lock: !!lock });
  const pill = profilePill({ address: profile?.address, connecting, shortAddress });
  const avatarSize = layout === 'desktop' ? 28 : 24;
  const badge = bellBadge(inbox?.unseen);
  const iconSize = layout === 'desktop' ? 17 : 15;
  // A guest's Real is the way in: it starts the connect flow (the page shows the connect notice).
  const pickMode = (m) => { if (m === 'real' && !connected) onConnect?.(); else onMode?.(m); };
  const parts = {
    logo: <a key="logo" className="gh-logo" href="/" data-testid="header-logo" data-header-item="logo" title="qu-BETICS lobby"><BrandLogo /></a>,
    lobby: <LobbyLink key="lobby" className="gh-pill gh-lobby" />,
    lock: lock && <button key="lock" type="button" className={`commitment-button gh-pill gh-lock${lock.status ? ` ${lock.status}` : ''}`} data-testid="header-lock" data-header-item="lock"
      onClick={lock.onTap} aria-label="Next lock: open the fairness details" title={lock.title || 'The lock for your next spin, shown before you bet. Tap to see the fairness details, copy it or get a new one.'}>
      <span className={`commitment-status ${lock.status || ''}`} aria-hidden="true"><LockGlyph /></span>
      <span className="commitment-text"><span className="commitment-label">Next lock</span><code>{lock.hash ? lock.hash.slice(0, 8) : '...'}</code></span>
    </button>,
    balance: <div key="balance" className="gh-balance" data-testid="header-balance-block" data-header-item="balance">
      <small className="balance-word" data-testid="header-balance-label">{balanceLabel(mode)}</small>
      <b className="gold-text gh-amount"><span data-balance-target="header" data-testid="header-balance" data-mode={mode} className={balanceText && balanceText.length > 14 ? 'long' : undefined}>{balanceText}</span></b>
      {balanceNote && !portrait && <small className="gh-balance-note">{balanceNote}</small>}
    </div>,
    mode: <div key="mode" className="mode-switch gh-mode" role="group" aria-label="Real or Demo" data-testid="mode-switch" data-mode={mode} data-header-item="mode">
      <button type="button" aria-pressed={mode === 'real'} data-testid="mode-real" className={mode === 'real' ? 'on' : ''} disabled={modeDisabled} aria-disabled={connected && !modeInfo?.realAvailable ? true : undefined}
        title={!connected ? 'Connect your wallet to play with real $TICS' : modeInfo?.realAvailable ? 'Play with real $TICS' : modeInfo?.realReason} onClick={() => pickMode('real')}>Real</button>
      {(modeInfo?.demoVisible ?? true) && <button type="button" aria-pressed={mode === 'demo'} data-testid="mode-demo" className={mode === 'demo' ? 'on' : ''} disabled={modeDisabled} title="Play with demo $TICS" onClick={() => pickMode('demo')}>Demo</button>}
    </div>,
    mute: <span key="mute" className="gh-mute-wrap" data-header-item="mute"><MuteButton className="gh-icon" size={iconSize} /></span>,
    bell: <span key="bell" className="gh-bell-wrap" data-header-item="bell">
      <button type="button" className={`gh-icon gh-bell${badge ? ' lit' : ''}`} data-testid="header-bell" aria-haspopup="dialog" aria-expanded={profileOpen}
        aria-label={badge ? `Messages: ${badge} new` : 'Messages'} title={badge ? `${badge} new message${badge === '1' ? '' : 's'}` : 'Messages'} onClick={onBell || onProfile}>
        <Bell />
        {badge && <span className="gh-bell-count" data-testid="bell-count">{badge}</span>}
      </button>
    </span>,
    profile: <div key="profile" className={`gh-profile ${pill.kind}${profileOpen ? ' open' : ''}`} data-testid="header-profile" data-header-item="profile">
      {pill.kind === 'connected'
        ? <button type="button" className="wallet-chip gh-chip" data-testid="wallet-chip" aria-expanded={profileOpen} aria-haspopup="dialog" onClick={onProfile} title="Your profile">
          <Avatar address={profile.address} size={avatarSize} className="wallet-chip-avatar" /><span className="wallet-chip-text">{pill.text}</span>
        </button>
        : <>
          <button type="button" className="gh-connect" data-testid="wallet-connect" onClick={onConnect} disabled={connecting || connectDisabled} title="Connect your wallet">
            <span className="wc-long">{pill.text}</span><span className="wc-short">{connecting ? '...' : 'Connect'}</span>
          </button>
          <button type="button" className="gh-icon gh-person" data-testid="profile-button" aria-label="Profile and settings" aria-haspopup="dialog" aria-expanded={profileOpen} onClick={onProfile} title="Profile and settings"><Person /></button>
        </>}
    </div>,
  };
  const render = (ids) => ids.map((id) => parts[id]).filter(Boolean);
  let body;
  if (portrait) {
    const { row1, row2 } = phoneRows(items);
    body = <>
      <div className="gh-row gh-row1">{render(row1.filter((id) => id === 'logo'))}<div className="gh-group gh-right">{render(row1.filter((id) => id !== 'logo'))}</div></div>
      {row2.length > 0 && <div className="gh-row gh-row2">
        <div className="gh-group gh-left">{render(row2.filter((id) => id === 'lobby' || id === 'lock'))}</div>
        <div className="gh-group gh-right">{render(row2.filter((id) => id !== 'lobby' && id !== 'lock'))}</div>
      </div>}
    </>;
  } else {
    body = <div className="gh-row">
      <div className="gh-group gh-left">{render(items.filter((id) => ['logo', 'lobby', 'lock'].includes(id)))}</div>
      <div className="gh-group gh-right">{render(items.filter((id) => !['logo', 'lobby', 'lock'].includes(id)))}</div>
    </div>;
  }
  return <header className={`gh gh-${layout} gh-${page} noselect`} data-testid="game-header" data-layout={layout} inert={inert ? true : undefined}>
    {body}
    {children}
  </header>;
}
