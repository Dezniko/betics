import { useEffect, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import BrandLogo from './BrandLogo.jsx';
import GameToast, { toastTitle } from './GameToast.jsx';
import { SoundQuickControls, SoundSettingsDialog } from './SoundControls.jsx';
import WalletPanel from './WalletPanel.jsx';
import Avatar from './Avatar.jsx';
import ConnectNotice from './ConnectNotice.jsx';
import { AgeGate } from './Terms.jsx';
import CasinoReserve from './CasinoReserve.jsx';
import SupportLink from './Support.jsx';
import { WheelDefinitions, RotorArtwork, WheelBall, wheelPoint } from './WheelArtwork.jsx';
import { pocketAngle } from './wheelMotion.js';
import { shortAddress } from './walletApi.js';
import { fmtMoney, fmtTics } from './chips.js';
import useSession from './useSession.js';
import './lobby.css';

// The casino lobby at /: the same header family as the games (logo, sound, balance, Real or Demo,
// wallet), a one line welcome, one card per game with a gold Play button, the casino reserve card on
// desktop and the help links. One screen on every viewport: nothing scrolls.
export const GAMES = Object.freeze([
  Object.freeze({ id: 'roulette', href: '/roulette', name: 'Roulette', tagline: 'Classic European roulette on green felt, every spin checkable in your browser.',
    facts: Object.freeze(['European wheel', '97.3% payback', 'Bets from 1 $TICS']) }),
  Object.freeze({ id: 'godsofpower', href: '/godsofpower', name: 'Gods of Power', tagline: 'Five reels of crypto treasure, a vault of free spins, a portrait that pays.',
    facts: Object.freeze(['5 reels, 20 lines', 'Free spins', '92% payback', 'Bets from 20 $TICS']) }),
]);
export const WELCOME = 'Pick a game. One balance, provably fair rounds, your wallet stays yours.';

function useViewport() {
  const read = () => ({ w: window.innerWidth, h: window.innerHeight });
  const [vp, setVp] = useState(read);
  useEffect(() => { const on = () => setVp(read()); window.addEventListener('resize', on); return () => window.removeEventListener('resize', on); }, []);
  return vp;
}

// A still wheel for the roulette card: the real rotor artwork, turning slowly (transform only).
const BALL_POCKET = 17;
function LobbyWheel() {
  const id = 'lobby-wheel-';
  const [bx, by] = wheelPoint(252, pocketAngle(BALL_POCKET));
  return <div className="lobby-wheel" aria-hidden="true">
    <svg className="lobby-wheel-bowl" viewBox="0 0 1024 1024"><image href="/wheel/roulette-material.webp" width="1024" height="1024" /></svg>
    <div className="lobby-wheel-rotor">
      <svg viewBox="0 0 1024 1024"><WheelDefinitions id={id} /><RotorArtwork id={id} />
        <g transform={`translate(${bx} ${by})`}><WheelBall id={id} /></g>
      </svg>
    </div>
  </div>;
}
// The slot card: the owner portrait with a few of the rendered symbols around it.
function LobbyCollage() {
  return <div className="lobby-collage" aria-hidden="true">
    <img className="lobby-collage-sym a" src="/slots/gold-bar.webp" width="512" height="512" alt="" draggable="false" />
    <img className="lobby-collage-sym b" src="/slots/ruby.webp" width="512" height="512" alt="" draggable="false" />
    <img className="lobby-collage-sym c" src="/slots/treasure-chest.webp" width="512" height="512" alt="" draggable="false" />
    <img className="lobby-collage-hero" src="/slots/gods-of-power.webp" width="512" height="512" alt="" draggable="false" />
  </div>;
}

function GameCard({ game, children }) {
  const go = (e) => { if (e.target.closest('a')) return; window.location.assign(game.href); };
  return <article className={`game-card game-card-${game.id}`} data-testid={`card-${game.id}`} onClick={go}>
    <div className="game-card-visual">{children}</div>
    <div className="game-card-body">
      <h2 className="game-card-name">{game.name}</h2>
      <p className="game-card-tagline">{game.tagline}</p>
      <ul className="game-card-facts">{game.facts.map((f) => <li key={f}>{f}</li>)}</ul>
      <a className="game-play" href={game.href} data-testid={`play-${game.id}`} aria-label={`Play ${game.name}`}>Play</a>
    </div>
  </article>;
}

export default function Lobby() {
  const vp = useViewport();
  const landscape = vp.w > vp.h && vp.h < 560;
  const desktop = vp.w >= 1000 && !landscape;
  const layout = landscape ? 'landscape' : desktop ? 'desktop' : 'portrait';
  const mobile = !desktop;
  const session = useSession();
  const { user, profile, mode, modeInfo, balance } = session;
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);
  const [soundOpen, setSoundOpen] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  useEffect(() => { if (session.sessionError) { setError(session.sessionError); session.clearSessionError(); } }, [session.sessionError]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (session.elsewhere) setWalletOpen(false); }, [session.elsewhere]);
  const anyModal = soundOpen || walletOpen || session.connectNoticeOpen || !session.ageOk;
  const balanceText = user && balance != null ? (layout === 'portrait' ? fmtTics(balance, { decimals: Math.round(balance) % 100 === 0 ? 0 : 2 }) : fmtMoney(balance)) : '...';
  const chooseMode = (m) => { const reason = session.chooseMode(m); if (reason) setNotice(reason); else { setError(null); setNotice(null); } };
  const toasts = [
    session.elsewhere && !error && { kind: 'elsewhere', className: 'game-error game-toast-error', title: 'Wallet', text: session.elsewhere, dismissible: true, testid: 'signed-in-elsewhere', action: { label: 'Connect again', testid: 'connect-again', onClick: () => { session.clearElsewhere(); session.requestConnect(); } } },
    notice && !error && { kind: 'info', className: 'game-notice', title: toastTitle('info', notice), text: notice, dismissible: true, testid: 'lobby-notice' },
    error && { kind: 'error', className: 'game-error', title: toastTitle('error', error), text: error, dismissible: true, testid: 'lobby-error' },
  ].filter(Boolean);

  return <div className={`lobby casino-app noselect layout-${layout}`} data-layout={layout} data-background-locked={anyModal || undefined}>
    <header className="lobby-header" inert={anyModal ? true : undefined}>
      <div className="lobby-brand">
        <BrandLogo />
        <span className="brand-sub lobby-sub">CASINO</span>
        <SoundQuickControls onOpen={() => setSoundOpen(true)} />
      </div>
      <div className="header-right lobby-header-right">
        <div className="header-balance lobby-balance">
          <div className="balance-label-row lobby-balance-row">
            <span className="balance-word">BALANCE</span>
            {profile && <div className="mode-switch" role="group" aria-label="Real or Demo" data-testid="mode-switch" data-mode={mode}>
              <button type="button" aria-pressed={mode === 'real'} data-testid="mode-real" className={mode === 'real' ? 'on' : ''} aria-disabled={!modeInfo.realAvailable}
                title={modeInfo.realAvailable ? 'Play with real $TICS' : modeInfo.realReason} onClick={() => chooseMode('real')}>Real</button>
              {modeInfo.demoVisible && <button type="button" aria-pressed={mode === 'demo'} data-testid="mode-demo" className={mode === 'demo' ? 'on' : ''} title="Play with demo $TICS" onClick={() => chooseMode('demo')}>Demo</button>}
            </div>}
          </div>
          <div className="gold-text lobby-balance-amount"><span data-balance-target="header" data-testid="header-balance" data-mode={mode} className={balanceText.length > 14 ? 'long' : undefined}>{balanceText}</span></div>
        </div>
        {profile ? (
          <button type="button" className={`wallet-chip ${walletOpen ? 'open' : ''}`} data-testid="wallet-chip" aria-expanded={walletOpen} onClick={() => setWalletOpen(true)} title="Your profile">
            <span className="wallet-chip-text">{shortAddress(profile.address)}</span><Avatar address={profile.address} size={mobile ? 22 : 28} className="wallet-chip-avatar" />
          </button>
        ) : (
          <button type="button" className="wallet-connect" data-testid="wallet-connect" onClick={session.requestConnect} disabled={session.walletBusy}>
            {session.walletBusy ? 'Connecting...' : <><span className="wc-long">Connect wallet</span><span className="wc-short">Connect</span></>}
          </button>
        )}
      </div>
      <GameToast toasts={toasts} onDismiss={(kind) => { if (kind === 'error') setError(null); if (kind === 'info') setNotice(null); if (kind === 'elsewhere') session.clearElsewhere(); }} />
    </header>

    <main className="lobby-main" inert={anyModal ? true : undefined}>
      <p className="lobby-welcome" data-testid="lobby-welcome">{WELCOME}</p>
      <div className="lobby-games">
        <GameCard game={GAMES[0]}><LobbyWheel /></GameCard>
        <GameCard game={GAMES[1]}><LobbyCollage /></GameCard>
      </div>
      <div className="lobby-foot">
        {desktop && <CasinoReserve variant="card" className="lobby-reserve" />}
        <nav className="lobby-links" aria-label="Help">
          <SupportLink className="lobby-support" />
          <a className="lobby-link-pill" href="/how-it-works" data-testid="lobby-how">How it works</a>
          <a className="lobby-link-pill" href="/terms" data-testid="lobby-terms">Terms</a>
        </nav>
      </div>
    </main>

    <SoundSettingsDialog open={soundOpen} onClose={() => setSoundOpen(false)} />
    <AnimatePresence>
      {walletOpen && profile && <WalletPanel profile={profile} wallet={user} mobile={mobile} deposit={null} onTopUp={() => setNotice('Top ups are made on the roulette page for now.')}
        onRefresh={async () => { await Promise.all([session.refreshProfile(), session.refreshWallet()]); }} onDisconnect={async () => { setWalletOpen(false); await session.disconnectWallet(); }}
        onClose={() => setWalletOpen(false)} />}
    </AnimatePresence>
    {!session.ageOk && <AgeGate onAccept={session.acceptAge} />}
    {session.ageOk && session.connectNoticeOpen && <ConnectNotice onContinue={session.continueConnect} onClose={session.closeConnectNotice} />}
  </div>;
}
