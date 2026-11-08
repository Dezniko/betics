import { useEffect, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import GameToast, { toastTitle } from './GameToast.jsx';
import GameHeader from './GameHeader.jsx';
import ProfileSheet from './ProfileSheet.jsx';
import { useInbox } from './Inbox.jsx';
import ConnectNotice from './ConnectNotice.jsx';
import { AgeGate } from './Terms.jsx';
import CasinoReserve from './CasinoReserve.jsx';
import SupportLink from './Support.jsx';
import { WheelDefinitions, RotorArtwork, WheelBall, wheelPoint } from './WheelArtwork.jsx';
import { pocketAngle } from './wheelMotion.js';
import { fmtMoney, fmtTics } from './chips.js';
import useSession from './useSession.js';
import { headerLayout } from './headerModel.js';
import './lobby.css';

// The casino lobby at /: the shared header (GameHeader) and profile pop-up (ProfileSheet) of the games,
// a one line welcome, one card per game with a gold Play button, the casino reserve card on desktop
// and the help links. One screen on every viewport: nothing scrolls.
export const GAMES = Object.freeze([
  Object.freeze({ id: 'roulette', href: '/roulette', name: 'Roulette', tagline: 'Classic European roulette on green felt, every spin checkable in your browser.',
    facts: Object.freeze(['European wheel', 'Provably fair', 'Bets from 1 $TICS']) }),
  Object.freeze({ id: 'godsofpower', href: '/godsofpower', name: 'Gods of Power', tagline: 'Five reels of crypto treasure, a vault of free spins, a portrait that pays.',
    facts: Object.freeze(['5 reels, 20 lines', 'Free spins', 'Provably fair', 'Bets from 20 $TICS']) }),
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
  const layout = headerLayout(vp.w, vp.h);
  const desktop = layout === 'desktop';
  const mobile = !desktop;
  const session = useSession();
  const { user, profile, mode, modeInfo, balance } = session;
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);
  const [sheet, setSheet] = useState(null); // { tab, expand } while the profile pop-up is open
  const inbox = useInbox({ ready: !!user, quiet: false });
  const openMessages = () => { setSheet({ tab: 'wallet', expand: 'messages' }); inbox.markSeen(); };
  useEffect(() => { if (session.sessionError) { setError(session.sessionError); session.clearSessionError(); } }, [session.sessionError]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (session.elsewhere) setSheet(null); }, [session.elsewhere]);
  const anyModal = !!sheet || session.connectNoticeOpen || !session.ageOk;
  const balanceText = user && balance != null ? (layout === 'portrait' ? fmtTics(balance, { decimals: Math.round(balance) % 100 === 0 ? 0 : 2 }) : fmtMoney(balance)) : '...';
  const chooseMode = (m) => { const reason = session.chooseMode(m); if (reason) setNotice(reason); else { setError(null); setNotice(null); } };
  const toasts = [
    session.elsewhere && !error && { kind: 'elsewhere', className: 'game-error game-toast-error', title: 'Wallet', text: session.elsewhere, dismissible: true, testid: 'signed-in-elsewhere', action: { label: 'Connect again', testid: 'connect-again', onClick: () => { session.clearElsewhere(); session.requestConnect(); } } },
    notice && !error && { kind: 'info', className: 'game-notice', title: toastTitle('info', notice), text: notice, dismissible: true, testid: 'lobby-notice' },
    error && { kind: 'error', className: 'game-error', title: toastTitle('error', error), text: error, dismissible: true, testid: 'lobby-error' },
  ].filter(Boolean);
  const connect = () => { setSheet(null); session.requestConnect(); };

  return <div className={`lobby casino-app noselect layout-${layout}`} data-layout={layout} data-background-locked={anyModal || undefined}>
    <GameHeader page="lobby" layout={layout} inert={anyModal}
      balanceText={balanceText} mode={mode} modeInfo={modeInfo} onMode={chooseMode}
      profile={profile} profileOpen={!!sheet} onProfile={() => setSheet({ tab: 'wallet' })} onConnect={connect} connecting={session.walletBusy}
      inbox={inbox} onBell={openMessages}>
      <GameToast toasts={toasts} onDismiss={(kind) => { if (kind === 'error') setError(null); if (kind === 'info') setNotice(null); if (kind === 'elsewhere') session.clearElsewhere(); }} />
    </GameHeader>

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

    <AnimatePresence>
      {sheet && <ProfileSheet key="profile" page="lobby" mobile={mobile} initialTab={sheet.tab} initialExpanded={sheet.expand || null} onClose={() => setSheet(null)}
        profile={profile} wallet={user} mode={mode} balance={user ? balance : null}
        onConnect={connect} connecting={session.walletBusy} onDisconnect={async () => { setSheet(null); await session.disconnectWallet(); }}
        deposit={null} onTopUp={() => setNotice('Top ups are made on the roulette page for now.')}
        onRefresh={async () => { await Promise.all([session.refreshProfile(), session.refreshWallet()]); }}
        inbox={inbox}
        historyContent={<div className="profile-guest-wallet"><p className="fair-note">Your recent rounds are listed inside each game: open Roulette or Gods of Power and tap your profile.</p></div>}
        fairnessContent={<div className="profile-guest-wallet"><p className="fair-note">Every round is locked before you bet and opened after it. Each game shows its lock and lets you check any round in your browser.</p><a className="fair-btn fair-btn-ghost" href="/how-it-works">How it works</a></div>}
        rows={[{ key: 'how', label: 'How it works', href: '/how-it-works', testid: 'profile-row-how' }]}
        onResetDemo={() => session.resetDemoBalance().catch(() => {})} resetting={session.demoResetting} />}
    </AnimatePresence>
    {inbox.popupNode}
    {!session.ageOk && <AgeGate onAccept={session.acceptAge} />}
    {session.ageOk && session.connectNoticeOpen && <ConnectNotice onContinue={session.continueConnect} onClose={session.closeConnectNotice} />}
  </div>;
}
