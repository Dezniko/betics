import PocketCloseup from './PocketCloseup.jsx';
import { betLabel } from './rouletteRules.js';
import { chipGroups, fmtMoney } from './chips.js';

export default function MobileRoundFeedback({ spinning, landingPocket, settledPocket, lastResult, winPopup, phase,
  amount, balance, autoVerify, onVerify, onSkip, onContinue, mode }) {
  const celebrating=phase==='totaling'||phase==='transferring'; // WinCelebration owns the screen
  const active=landingPocket!==null;
  const confirmed=landingPocket??settledPocket;
  return <aside className="mobile-feedback" data-testid="mobile-feedback" data-active={active} data-phase={phase}>
    {celebrating ? null : !spinning&&confirmed!==null ? <div className="feedback-camera">
      <PocketCloseup pocket={confirmed} compact/>
      {lastResult&&<div className="feedback-last-result">
        <span>{lastResult.totalPayoutCents?`WON ${fmtMoney(lastResult.totalPayoutCents)}`:`LOST ${fmtMoney(lastResult.totalStakeCents)}`}</span>
        <button onClick={onVerify} title="Verify this outcome independently"><span className="sr-only">Verify this outcome independently </span>Proof ↗</button>
        <span className="feedback-proof-status">{autoVerify?.ok?'Outcome and payout verified':'Verification mismatch. Review the proof.'}</span>
      </div>}
    </div> : <section className="feedback-card feedback-placeholder">
      <div className="feedback-eyebrow">EUROPEAN ROULETTE</div><strong>{spinning?'Ball in play':'Place your bets'}</strong>
      <span>{spinning?'No more bets for this round':'Tap the felt to place your chips'}</span><small>{mode==='real'?'REAL $TICS':'DEMO $TICS'}</small>
    </section>}
  </aside>;
}
