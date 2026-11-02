import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { explainOutcome } from './fairnessClient.js';
import { chefPocketUrl, chefLockUrl } from './fairnessLinks.js';
import { readRefusedLog, refusedSpinText } from './spinRefusal.js';

const RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const pocketColour = n => n === 0 ? '#0f8a4c' : RED.has(n) ? '#c8242a' : '#1d1d22';

// One picture (locked, you spin, opened = pocket) and one sentence. 'Check it
// yourself' opens ONE independent CyberChef link that prints the same pocket,
// with every code it needs, plus a lock check. Maths stays under 'For experts'.
// No emoji and no em or en dashes in player copy (Dez: they look AI-made).

const LockIcon = ({ open }) => <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
  <rect x="4.5" y="10.5" width="15" height="10" rx="2"/>{open ? <path d="M8 10.5V7a4 4 0 0 1 7.6-1.7"/> : <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>}<circle cx="12" cy="15.5" r="1.4" fill="currentColor"/>
</svg>;
const SpinIcon = () => <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
  <circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3"/><path d="M12 3.5v5M12 15.5v5M3.5 12h5M15.5 12h5"/>
</svg>;
const Chevron = ({ open }) => <svg className={`fair-chev${open ? ' open' : ''}`} viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6"/></svg>;

// The whole idea in one picture. Shared by the Proof sheet and How it works.
export function FairFlow({ pocket = null, states = [true, true, true] }) {
  const tile = (ok, icon, title, sub) => <div className={`fair-tile ${ok ? 'ok' : 'bad'}`}><span className="fair-icon">{icon}</span><b>{title}</b><small>{sub}</small></div>;
  return <div className="fair-picture" data-testid="fair-picture">
    {tile(states[0], <LockIcon />, 'Locked', 'before you bet')}
    <span className="fair-arrow" aria-hidden="true">›</span>
    {tile(states[1], <SpinIcon />, 'You spin', 'adds your luck')}
    <span className="fair-arrow" aria-hidden="true">›</span>
    {tile(states[2], pocket == null ? <LockIcon open /> : <span className="fair-ball" style={{ background: pocketColour(pocket) }}>{pocket}</span>, 'Opened', pocket == null ? 'after the spin' : 'gives this number')}
  </div>;
}

// Spins the server refused after this browser had sent its random value. Each lock was opened
// afterwards, so this browser worked out where that spin would have landed (kept in this browser only).
const whenShort = (t) => { try { return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
export function RefusedSpins({ entries }) {
  const list = (entries || []).slice(-10).reverse();
  if (!list.length) return null;
  return <section className="fair-panel" data-testid="refused-spins">
    <h4>Refused spins</h4>
    <p className="fair-note">These spins were turned down after your device added its luck. Each lock was opened afterwards, so you can see where the ball would have landed.</p>
    <ul className="fair-note">
      {list.map((e) => <li key={`${e.lock}-${e.at}`} data-testid="refused-spin" data-pocket={e.pocket ?? ''}>
        <b>{refusedSpinText(e)}</b> <small>{whenShort(e.at)}{e.reason ? ` · ${e.reason}` : ''}</small>
      </li>)}
    </ul>
  </section>;
}

const Drop = ({ id, label, open, onToggle, children }) => <div className={`fair-drop${open ? ' open' : ''}`}>
  <button type="button" className="fair-drop-btn" data-testid={`drop-${id}`} aria-expanded={open} onClick={onToggle}><span>{label}</span><Chevron open={open} /></button>
  {open && <div className="fair-drop-body">{children}</div>}
</div>;

function useCopy() {
  const [copied, setCopied] = useState(null);
  const copy = (id, text) => { navigator.clipboard?.writeText(text).then(() => { setCopied(id); setTimeout(() => setCopied(c => c === id ? null : c), 1400); }).catch(() => {}); };
  return [copied, copy];
}
export default function FairnessSheet({ result, loading, mobile, onClose, onDownloadProof }) {
  const [steps, setSteps] = useState(null);
  const [diy, setDiy] = useState(false);
  const [expert, setExpert] = useState(false);
  const [copied, copy] = useCopy();
  const round = result?.round, expected = result?.expected;
  const serverSeed = round?.server_seed;
  const fingerprint = expected?.serverSeedHash || round?.server_seed_hash;
  const clientSeed = expected?.clientSeed || round?.client_seed;
  const nonce = expected?.nonce ?? round?.nonce;
  const pocket = result?.proof?.result?.pocket;

  useEffect(() => {
    let live = true; setSteps(null);
    if (serverSeed && clientSeed != null && Number.isSafeInteger(nonce)) {
      explainOutcome({ serverSeed, clientSeed, nonce, max: 37 }).then(s => live && setSteps(s)).catch(() => live && setSteps(null));
    }
    return () => { live = false; };
  }, [serverSeed, clientSeed, nonce]);

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const status = loading ? 'loading' : result?.ok ? 'verified' : result?.status || 'error';
  const verdict = {
    loading: { title: 'Checking...', text: '' },
    // Without the bet terms saved in this browser only the number can be checked, not the payout.
    verified: result?.numberOnly ? { title: 'Number verified', text: 'The payout could not be checked here because the bet details are not stored in this browser.' }
      // History rounds carry no ending balance, so say so instead of implying it was checked.
      : { title: 'Fair spin', text: result?.settlement?.balanceChecked === false ? 'Number and payout checked. The balance is not part of this check.' : '' },
    settlement: { title: 'Payout doesn’t match', text: 'Betting is paused.' },
    unrecorded: { title: 'Can’t check here', text: 'This spin was played on another device, so its lock isn’t stored here.' },
    mismatch: { title: 'Doesn’t match', text: 'Betting is paused.' },
    error: { title: 'Check failed', text: 'Betting is paused.' },
  }[status] || { title: 'Check failed', text: '' };
  const ok = status === 'verified';
  const shownPocket = steps?.pocket ?? result?.outcome ?? pocket;

  const Code = ({ id, label, value }) => <div className="fair-code">
    <span>{label}</span>
    <code>{value}</code>
    <button type="button" className="fair-btn fair-btn-ghost fair-btn-small" onClick={() => copy(id, String(value))}>{copied === id ? 'Copied' : 'Copy'}</button>
  </div>;

  const Wrapper = mobile ? 'fair-sheet' : 'fair-modal';
  return <motion.div className="fair-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
    <motion.div className={Wrapper} role="dialog" aria-modal="true" aria-label="Fairness check" data-testid="fairness-sheet" data-status={status}
      initial={mobile ? { y: '100%' } : { scale: 0.96, opacity: 0 }} animate={mobile ? { y: 0 } : { scale: 1, opacity: 1 }}
      exit={mobile ? { y: '100%' } : { opacity: 0 }} transition={{ type: 'spring', stiffness: 420, damping: 38 }}
      onClick={e => e.stopPropagation()}>
      {mobile && <div className="fair-grabber" aria-hidden="true"/>}
      <div className="fair-head"><h3>Was it fair?</h3><button type="button" onClick={onClose} aria-label="Close">✕</button></div>

      <div className={`fair-verdict fair-${status}`} data-testid="fair-verdict">
        <span className="fair-verdict-icon">{ok ? '✓' : status === 'loading' ? '' : '!'}</span>
        <div><strong>{verdict.title}</strong>{verdict.text && <p>{verdict.text}</p>}</div>
      </div>

      {result && !loading && <FairFlow pocket={shownPocket} states={[result.hashMatches && result.commitmentRecorded, result.inputsMatch, result.outcomeMatches]} />}
      {ok && <p className="fair-one-line">The number was locked before you bet. After the spin the lock was opened, and it gives {shownPocket}.</p>}

      {result && !loading && serverSeed && steps && <>
        <Drop id="diy" label="Check it yourself" open={diy} onToggle={() => setDiy(v => !v)}>
          <div data-testid="fair-diy">
            <p className="fair-step">Tap the button. A free checker made by GCHQ, not by us, opens with everything filled in. Look at <b>Output</b> at the bottom. It should say <b className="fair-big">{steps.pocket}</b></p>
            <a className="fair-btn fair-btn-wide" data-testid="chef-pocket" href={chefPocketUrl(serverSeed, steps.message)} target="_blank" rel="noopener noreferrer">Open the checker</a>
            <p className="fair-note">It uses these codes. You can also paste them into any checker you trust.</p>
            <Code id="secret" label="Key (shown after the spin)" value={serverSeed} />
            <Code id="lucky" label="Your lucky word and spin number" value={steps.message} />
            <div data-testid="seal-expected" data-seal={fingerprint}>
              <Code id="lock" label="Lock (shown before you bet)" value={fingerprint} />
            </div>
            <p className="fair-step">Want to be sure the lock wasn’t swapped? Tap below. Its Output should be the same lock.</p>
            <a className="fair-btn fair-btn-wide fair-btn-ghost" data-testid="chef-lock" href={chefLockUrl(serverSeed)} target="_blank" rel="noopener noreferrer">Check the lock</a>
          </div>
        </Drop>

        <Drop id="expert" label="For experts" open={expert} onToggle={() => setExpert(v => !v)}>
          <ol className="fair-expert">
            <li>Lock = SHA-256(key).</li>
            <li>HMAC-SHA256(key, <code>{steps.message}</code>) starts with <code>{steps.first8}</code>.</li>
            <li><code>{steps.first8}</code> in decimal is {steps.value.toLocaleString('en-US')} = 37 × {Math.floor(steps.value / 37).toLocaleString('en-US')} + <strong>{steps.pocket}</strong>, so the pocket is <strong>{steps.pocket}</strong>.</li>
            {steps.counter > 0 && <li>The last number in the message is a retry count. Values of {steps.limit.toLocaleString('en-US')} or more are skipped so every pocket is equally likely.</li>}
          </ol>
          <div className="fair-mono-list"><div>request ID: {round.request_id || 'none'} · nonce: {nonce}</div></div>
          <div className="fair-btn-row">
            <a className="fair-btn fair-btn-ghost" href="/verify-roulette.mjs" download="verify-roulette.mjs">Offline verifier</a>
            <button type="button" className="fair-btn fair-btn-ghost" onClick={onDownloadProof}>Round data</button>
          </div>
        </Drop>
      </>}

      <RefusedSpins entries={readRefusedLog()} />

      <button type="button" className="fair-close" onClick={onClose}>Done</button>
    </motion.div>
  </motion.div>;
}
