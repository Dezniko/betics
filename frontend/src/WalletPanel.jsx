import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { fmtMoney } from './chips.js';
import Avatar from './Avatar.jsx';
import CasinoReserve from './CasinoReserve.jsx';
import SupportLink, { SUPPORT_URL } from './Support.jsx';
import { walletApi, shortAddress, explorerTx, parseTicsInput, nextWithdrawRequest, withdrawReviewFee, DEPOSIT_TEXT, WITHDRAW_NOTE, withdrawText, heldRowText } from './walletApi.js';
import { topUpState, DEPOSIT_PAUSED_MESSAGE, DEPOSITS_CLOSED_MESSAGE, CASINO_WALLET } from './depositTarget.js';

const when = (s) => (s ? String(s).replace('T', ' ').slice(0, 16) : '');

function TopUp({ profile, deposit, onTopUp }) {
  const [amount, setAmount] = useState('');
  const units = parseTicsInput(amount);
  const tooSmall = units != null && units < (profile.minDepositCents || 0);
  const active = deposit && !deposit.final;
  // Closed (switched off, or no casino wallet) is checked before the pinned-address check, and the
  // token and casino wallet from the server must be the ones pinned in this page.
  const state = topUpState(profile);
  const [copied, setCopied] = useState(false);
  let status = null;
  if (deposit) {
    if (deposit.status === 'confirming') status = `Confirming ${Math.min(deposit.confirmations || 0, deposit.required)} of ${deposit.required}`;
    else if (deposit.status === 'credited') status = `Credited ${fmtMoney(deposit.amountCents || 0)}`;
    else status = deposit.error || DEPOSIT_TEXT[deposit.status] || 'Checking...';
  }
  // A top up already on its way keeps showing its progress even while top ups are closed or paused.
  const statusLine = status && <p className={`wallet-status ${deposit.status === 'credited' ? 'wallet-ok' : deposit.final ? 'wallet-bad' : ''}`} data-testid="topup-status" data-status={deposit.status}>
    {status}{deposit.txHash && <> <a href={explorerTx(profile.chainId, deposit.txHash)} target="_blank" rel="noopener noreferrer">View</a></>}
  </p>;
  return <section className="fair-panel wallet-section" data-testid="wallet-topup">
    {state === 'closed' ? <><p className="fair-note" data-testid="topup-closed">{DEPOSITS_CLOSED_MESSAGE}</p>{statusLine}</>
    : state === 'paused' ? <>
      <p className="fair-note wallet-bad" data-testid="topup-paused">{DEPOSIT_PAUSED_MESSAGE}</p>
      {statusLine}
      <SupportLink testid="topup-support" />
    </> : <>
      <div className="fair-btn-row">
        <input id="topup-amount" name="topupAmount" autoComplete="off" className="fair-input" inputMode="decimal" placeholder="Amount in $TICS" aria-label="Top up amount in $TICS" value={amount}
          disabled={active} onChange={(e) => setAmount(e.target.value)} data-testid="topup-amount" />
        <button type="button" className="fair-btn" disabled={!units || tooSmall || active} onClick={() => onTopUp(units)} data-testid="topup-send">Top up</button>
      </div>
      {tooSmall && <p className="fair-note">The smallest top up is {fmtMoney(profile.minDepositCents)}.</p>}
      {statusLine}
      <p className="fair-note">You need a small amount of ETH in your wallet to send the deposit.</p>
      <p className="fair-note">Only the official $TICS token is accepted. You can also send $TICS from your connected wallet to the casino wallet.</p>
      <div className="casino-wallet-card" data-testid="casino-wallet">
        <div className="casino-wallet-head">
          <span className="casino-wallet-badge" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 10l9-6 9 6" /><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8" /><path d="M3 20h18" /></svg>
          </span>
          <div className="casino-wallet-title"><strong>Casino wallet</strong><small>Official qu-BETICS deposit address</small></div>
          <button type="button" className="profile-mini" onClick={() => navigator.clipboard?.writeText(CASINO_WALLET).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }).catch(() => {})}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
        <code className="wallet-mono casino-wallet-address">{CASINO_WALLET}</code>
        <p className="casino-wallet-warn">Send only $TICS on Ethereum, and only from your connected wallet, so it is credited to you.</p>
      </div>
    </>}
  </section>;
}

function Withdraw({ profile, wallet, onDone }) {
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [frozenFee, setFrozenFee] = useState(null); // the fee shown when the review opened
  const [confirming, setConfirming] = useState(false); // the confirm step before anything is sent
  const pendingRequest = useRef(null); // { id, amount }: retried after a network error with the same id
  const allowed = profile.hasDeposited && profile.withdrawalsOpen;
  const loadQuote = async () => { try { const q = await walletApi.withdrawQuote(); setQuote(q); return q; } catch { return null; } };
  useEffect(() => {
    if (!allowed) return;
    loadQuote();
    const t = setInterval(loadQuote, 30000);
    return () => clearInterval(t);
  }, [allowed]);
  const units = parseTicsInput(amount);
  const fee = quote ? (quote.feesEnabled === false ? 0 : quote.feeCents) : profile.withdrawalFeeCents || 0;
  const min = quote ? quote.minWithdrawalCents : profile.minWithdrawalCents;
  const real = wallet?.realTicsCents || 0;
  const feesOff = quote?.feesEnabled === false;
  // The review freezes the fee it shows. If the quote changes while the review is open, the new fee
  // is shown and the button reads 'Confirm new fee X', so only a fee the player saw is ever sent.
  const { shownFee, feeChanged } = withdrawReviewFee({ confirming, frozenFee, fee });
  const problem = !units ? null : units > real ? 'That is more than your real balance.' : units < min ? `The smallest withdrawal is ${fmtMoney(min)}.` : shownFee > 0 && units <= shownFee ? 'The amount must be more than the network fee.' : null;
  // Step 1: Withdraw opens the confirm view. Step 2: Confirm sends, with the shown fee as maxFeeCents.
  const review = () => { if (!units || problem || busy) return; setMessage(null); setFrozenFee(fee); setConfirming(true); };
  const send = async () => {
    if (!units || problem || busy || !confirming) return;
    const agreedFee = shownFee;
    setFrozenFee(agreedFee);
    // Same amount after a failed try: same request id, so a request that did land is never doubled.
    const request = nextWithdrawRequest(pendingRequest.current, units);
    pendingRequest.current = request;
    setBusy(true); setMessage(null);
    try {
      await walletApi.withdraw(units, agreedFee, request.id);
      pendingRequest.current = null;
      setAmount(''); setFrozenFee(null); setConfirming(false);
      setMessage({ ok: true, text: 'Withdrawal queued. It goes to your connected wallet.' });
      await onDone();
    } catch (e) {
      // A new fee keeps the confirm view open so the player sees and confirms the new amount.
      if (e.status === 409 && /fee/i.test(e.message)) { await loadQuote(); setMessage({ ok: false, text: `${e.message}` }); }
      else if (!e.status) setMessage({ ok: false, text: 'The connection dropped. Your request may already be on its way. Tap Confirm to try again safely, it will not be sent twice.' });
      else { setConfirming(false); setFrozenFee(null); setMessage({ ok: false, text: e.message }); }
    } finally { setBusy(false); }
  };
  return <section className="fair-panel wallet-section" data-testid="wallet-withdraw">
    {!profile.hasDeposited ? <p className="fair-note" data-testid="withdraw-locked">You can withdraw after your first top up. Withdrawals always go to the wallet you topped up from.</p>
      : !profile.withdrawalsOpen ? <p className="fair-note" data-testid="withdraw-locked">Withdrawals are closed right now. Your balance stays in your account.</p>
      : confirming ? <div className="withdraw-confirm" data-testid="withdraw-review">
        <p className="fair-note"><b>Check your withdrawal</b></p>
        <dl className="wallet-lines">
          <div><dt>Amount</dt><dd data-testid="withdraw-confirm-amount">{units ? fmtMoney(units) : '-'}</dd></div>
          {!feesOff && <div><dt>Network fee (paid by you)</dt><dd data-testid="withdraw-confirm-fee">{fmtMoney(shownFee || 0)}</dd></div>}
          <div><dt>You receive</dt><dd data-testid="withdraw-confirm-receive">{units && units > shownFee ? fmtMoney(units - shownFee) : '-'}</dd></div>
        </dl>
        {feeChanged && <p className="fair-note wallet-bad" data-testid="withdraw-fee-changed">The network fee changed from {fmtMoney(frozenFee || 0)} to {fmtMoney(fee || 0)} while you were checking.</p>}
        <p className="fair-note">Sent to your connected wallet:</p>
        <code className="wallet-mono" data-testid="withdraw-confirm-address">{profile.address}</code>
        {problem && <p className="fair-note wallet-bad">{problem}</p>}
        <div className="fair-btn-row">
          <button type="button" className="fair-btn fair-btn-ghost" disabled={busy} onClick={() => { setConfirming(false); setFrozenFee(null); }} data-testid="withdraw-back">Back</button>
          <button type="button" className="fair-btn" disabled={!units || !!problem || busy} onClick={send} data-testid="withdraw-confirm">
            {busy ? 'Sending request...' : feeChanged ? `Confirm new fee ${fmtMoney(fee)}` : 'Confirm'}</button>
        </div>
        {message && <p className={`wallet-status ${message.ok ? 'wallet-ok' : 'wallet-bad'}`} data-testid="withdraw-message">{message.text}</p>}
      </div> : <>
      <div className="fair-btn-row">
        <input id="withdraw-amount" name="withdrawAmount" autoComplete="off" className="fair-input" inputMode="decimal" placeholder="Amount in $TICS" aria-label="Withdraw amount in $TICS" value={amount}
          onChange={(e) => setAmount(e.target.value)} data-testid="withdraw-amount" />
        <button type="button" className="fair-btn fair-btn-ghost fair-btn-small" onClick={() => setAmount(String(real / 100))} disabled={!real}>Max</button>
      </div>
      <dl className="wallet-lines">
        {!feesOff && <div><dt>Network fee (paid by you)</dt><dd data-testid="withdraw-fee">{quote || profile.withdrawalFeeCents != null ? fmtMoney(fee || 0) : '...'}</dd></div>}
        <div><dt>You receive</dt><dd data-testid="withdraw-receive">{units && units > fee ? fmtMoney(units - fee) : '-'}</dd></div>
      </dl>
      <p className="fair-note" data-testid="withdraw-min">Smallest withdrawal: {fmtMoney(min || 0)}</p>
      {problem && <p className="fair-note wallet-bad">{problem}</p>}
      <button type="button" className="fair-btn fair-btn-wide" disabled={!units || !!problem || busy} onClick={review} data-testid="withdraw-send">Withdraw</button>
      {message && <p className={`wallet-status ${message.ok ? 'wallet-ok' : 'wallet-bad'}`} data-testid="withdraw-message">{message.text}</p>}
    </>}
  </section>;
}

function EmailBox({ profile, onSaved }) {
  const [email, setEmail] = useState(profile.email || '');
  const [consent, setConsent] = useState(!!profile.emailConsent);
  const [state, setState] = useState(null);
  const save = async () => {
    setState({ busy: true });
    try { await walletApi.saveProfile(email.trim(), consent); setState({ ok: true, text: 'Saved' }); onSaved(); }
    catch (e) { setState({ ok: false, text: e.message }); }
  };
  return <section className="profile-email" data-testid="wallet-email">
    <p className="profile-email-title">Enter your email for receipts and the latest updates.</p>
    <form className="profile-email-field" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <input type="email" id="profile-email" name="email" autoComplete="email" placeholder="Your email" aria-label="Email" value={email} onChange={(e) => { setEmail(e.target.value); setState(null); }} data-testid="email-input" />
      <button type="submit" disabled={state?.busy} data-testid="email-save">{state?.busy ? '...' : 'Save'}</button>
    </form>
    <div className="profile-email-foot">
      <label className="wallet-check"><input type="checkbox" id="email-updates" name="emailUpdates" checked={consent} onChange={(e) => { setConsent(e.target.checked); setState(null); }} data-testid="email-consent" /> Send me updates</label>
      {state?.text && <span className={`wallet-status ${state.ok ? 'wallet-ok' : 'wallet-bad'}`} data-testid="email-status">{state.text}</span>}
    </div>
  </section>;
}

function Activity({ profile }) {
  const rows = [
    ...profile.deposits.map((d) => ({ key: `d${d.txHash}`, kind: 'Top up', amount: d.amountCents, status: d.status === 'credited' ? 'Credited' : d.status === 'below_min' ? 'Below minimum' : d.status === 'unmatched' ? 'Not linked' : d.status, at: d.creditedAt || d.createdAt, tx: d.txHash })),
    ...profile.withdrawals.map((w) => ({ key: `w${w.id}`, kind: 'Withdrawal', amount: w.amountCents, status: withdrawText(w.status), note: WITHDRAW_NOTE[w.status] || null, review: w.status === 'blocked', at: w.sentAt || w.createdAt, tx: w.txHash })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 12);
  return <section className="fair-panel wallet-section" data-testid="wallet-activity">
    {rows.length === 0 ? <p className="fair-note">Nothing yet.</p> : <ul className="wallet-activity">
      {rows.map((r) => <li key={r.key} data-kind={r.kind} data-status={r.status}>
        <span><strong>{r.kind}</strong> <small>{when(r.at)}</small></span>
        <span>{fmtMoney(r.amount)}</span>
        <span className="wallet-activity-status">{r.status}{r.tx && <> <a href={explorerTx(profile.chainId, r.tx)} target="_blank" rel="noopener noreferrer">Etherscan</a></>}</span>
        {r.note && <span className={`wallet-activity-note${r.review ? ' review' : ''}`} data-testid="wallet-activity-note">{r.note}{r.review && <> <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer">Contact support</a></>}</span>}
      </li>)}
    </ul>}
  </section>;
}

const TABS = [['topup', 'Top up'], ['withdraw', 'Withdraw'], ['activity', 'Activity']];
const since = (s) => {
  if (!s) return null;
  const d = new Date(String(s).replace(' ', 'T') + (String(s).includes('Z') ? '' : 'Z'));
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
};

// Desktop: a drop-down hanging from the header profile button, with a folder tab in the
// button's place. Phones: the same card as a bottom sheet.
function useAnchor(enabled) {
  const [rect, setRect] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    const read = () => {
      const el = document.querySelector('[data-testid=wallet-chip]');
      const r = el?.getBoundingClientRect();
      setRect(r && r.width ? { top: r.top, bottom: r.bottom, right: r.right, left: r.left, width: r.width, height: r.height } : null);
    };
    read();
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  }, [enabled]);
  return rect;
}

export default function WalletPanel({ profile, wallet, mobile, deposit, onTopUp, onRefresh, onDisconnect, onClose, disconnectDisabled }) {
  const [disconnecting, setDisconnecting] = useState(false);
  const pending = profile.withdrawals.some((w) => ['queued', 'signing', 'sending'].includes(w.status));
  const refreshRef = useRef(onRefresh); refreshRef.current = onRefresh;
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => refreshRef.current(), 10000);
    return () => clearInterval(t);
  }, [pending]);
  const [tab, setTab] = useState(deposit && !deposit.final ? 'topup' : pending ? 'activity' : 'topup');
  const member = since(profile.firstConnectedAt);
  const activityCount = profile.deposits.length + profile.withdrawals.length;
  const held = heldRowText(profile.withdrawals);
  const anchor = useAnchor(!mobile);
  const dropdown = !mobile && !!anchor;
  const tabW = dropdown ? Math.max(150, Math.round(anchor.width + 16)) : 0;
  const panelW = dropdown ? Math.min(440, window.innerWidth - 24) : 0;
  const right = dropdown ? Math.max(12, Math.round(window.innerWidth - anchor.right - 8)) : 0;
  const top = dropdown ? Math.max(8, Math.round(anchor.top - 6)) : 0;
  const tabH = dropdown ? Math.round(anchor.height + 12) : 0;
  const style = dropdown ? { position: 'fixed', top, right, width: panelW, '--tab-w': `${tabW}px`, '--tab-h': `${tabH}px`, maxHeight: `calc(100dvh - ${top + 16}px)` } : undefined;
  const motionProps = mobile
    ? { initial: { y: '100%' }, animate: { y: 0 }, exit: { y: '100%' } }
    : { initial: { opacity: 0, y: -8, scale: 0.98 }, animate: { opacity: 1, y: 0, scale: 1 }, exit: { opacity: 0, y: -6 } };
  return <motion.div className={`fair-backdrop ${dropdown ? 'profile-backdrop' : ''}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
    <motion.div className={`${mobile ? 'fair-sheet' : 'fair-modal'} wallet-panel profile-panel ${dropdown ? 'profile-dropdown' : ''}`} style={style} role="dialog" aria-modal="true" aria-label="My profile" data-testid="wallet-panel"
      {...motionProps} transition={{ type: 'spring', stiffness: 460, damping: 38 }} onClick={(e) => e.stopPropagation()}>
      {mobile && <div className="fair-grabber" aria-hidden="true" />}
      <div className="profile-folder-tab"><span>My profile</span><button type="button" className="profile-close" onClick={onClose} aria-label="Close">✕</button></div>
      <div className="profile-body">
        <div className="profile-card">
          <p className="profile-eyebrow">My balance</p>
          <div className="profile-card-balance">
            <strong data-testid="panel-real-balance">{fmtMoney(wallet?.realTicsCents || 0)}</strong>
            <Avatar address={profile.address} size={mobile ? 44 : 52} className="profile-avatar" />
          </div>
          <code className="wallet-mono profile-card-address" data-testid="wallet-address">{profile.address}</code>
          <p className="profile-meta"><span className="profile-online"><span className="wallet-dot" aria-hidden="true" />Connected</span><span>Ethereum</span>{member && <span>Member since {member}</span>}</p>
        </div>
        <dl className="profile-rows">
          <div><dt>Balance<small>Ready to play or withdraw</small></dt><dd>{fmtMoney(wallet?.realTicsCents || 0)}</dd></div>
          {wallet?.heldCents > 0 && <div data-testid="panel-held"><dt>{held.title}<small>{held.note}</small></dt><dd>{fmtMoney(wallet.heldCents)}</dd></div>}
          {wallet?.demoAllowed !== false && <div><dt>Practice<small>Free play, no value</small></dt><dd data-testid="panel-demo-balance">{fmtMoney(wallet?.balanceCents || 0)}</dd></div>}
        </dl>
        <div className="profile-tabs" role="tablist" aria-label="Profile sections">
          {TABS.map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'on' : ''} data-testid={`tab-${key}`} onClick={() => setTab(key)}>
            {label}{key === 'activity' && activityCount > 0 && <span className="profile-tab-count">{Math.min(activityCount, 99)}</span>}
          </button>)}
        </div>
        <div className="profile-tab-body" role="tabpanel">
          {tab === 'topup' && <TopUp profile={profile} deposit={deposit} onTopUp={onTopUp} />}
          {tab === 'withdraw' && <><CasinoReserve variant="compact" /><Withdraw profile={profile} wallet={wallet} onDone={onRefresh} /></>}
          {tab === 'activity' && <Activity profile={profile} />}
        </div>
        <EmailBox profile={profile} onSaved={onRefresh} />
        <div className="profile-logout-row">
          <button type="button" className="profile-logout" data-testid="wallet-disconnect" disabled={disconnecting || disconnectDisabled}
            onClick={async () => { setDisconnecting(true); try { await onDisconnect(); } finally { setDisconnecting(false); } }}>{disconnecting ? 'Disconnecting...' : 'Disconnect'}</button>
        </div>
        <SupportLink testid="profile-support" />
        <p className="fair-foot"><a href="/how-it-works" target="_blank" rel="noopener">How it works</a> · <a href="/terms" target="_blank" rel="noopener">Terms</a>. Play at your own risk. Blockchain transfers cannot be reversed.</p>
      </div>
    </motion.div>
  </motion.div>;
}
