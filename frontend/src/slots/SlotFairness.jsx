import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { lockBackgroundScroll } from '../modalScrollLock.js';
import { fairnessCopy } from './slotCopy.js';

// The fairness sheet of the last round, in the same shape as the roulette one: three tiles
// (Locked > You spin > Opened), one sentence, a verdict, and a 'Check it yourself' dropdown with the
// codes and Copy buttons. Plain words, no emoji, no long dashes.
const LockIcon = ({ open }) => <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
  <rect x="4.5" y="10.5" width="15" height="10" rx="2" />{open ? <path d="M8 10.5V7a4 4 0 0 1 7.6-1.7" /> : <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />}<circle cx="12" cy="15.5" r="1.4" fill="currentColor" />
</svg>;
const SpinIcon = () => <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
  <rect x="3" y="6" width="18" height="12" rx="2" /><path d="M9 6v12M15 6v12" />
</svg>;
const DoorIcon = () => <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
  <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3.5" /><path d="M12 3v5.5M12 15.5V21M3 12h5.5M15.5 12H21" />
</svg>;
const Chevron = ({ open }) => <svg className={`fair-chev${open ? ' open' : ''}`} viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>;

function useCopy() {
  const [copied, setCopied] = useState(null);
  const copy = (id, text) => { navigator.clipboard?.writeText(text).then(() => { setCopied(id); setTimeout(() => setCopied((c) => (c === id ? null : c)), 1400); }).catch(() => {}); };
  return [copied, copy];
}

// round: the last spin reply; receipt: the pre-bet receipt; verdict: { ok, problems } from verifySlotRound.
export default function SlotFairness({ round, receipt, verdict, mobile, onClose }) {
  const c = fairnessCopy();
  const [diy, setDiy] = useState(false);
  const [copied, copy] = useCopy();
  useEffect(() => lockBackgroundScroll(true), []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const f = round?.fairness;
  const ok = !!round && !!verdict?.ok;
  const status = !round ? 'none' : ok ? 'verified' : 'mismatch';
  const states = round ? [ok || !verdict?.problems?.some((p) => /lock/i.test(p)), ok || !verdict?.problems?.some((p) => /lucky word|randomness|round number|request/i.test(p)), ok] : [true, true, true];
  const stops = round ? round.spins.map((s) => s.stops.join(' ')).join(' | ') : '';
  const Code = ({ id, label, value }) => <div className="fair-code">
    <span>{label}</span>
    <code>{value}</code>
    <button type="button" className="fair-btn fair-btn-ghost fair-btn-small" onClick={() => copy(id, String(value))}>{copied === id ? c.copied : c.copy}</button>
  </div>;
  const downloadProof = () => {
    const blob = new Blob([JSON.stringify({ version: 'slots-1', receipt, round }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `gods-of-power-round-${round?.roundId || 'last'}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const Wrapper = mobile ? 'fair-sheet' : 'fair-modal';
  return <motion.div className="fair-backdrop slot-sheet-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
    <motion.div className={`${Wrapper} slot-sheet slot-fairness`} role="dialog" aria-modal="true" aria-label="Fairness check" data-testid="slot-fairness" data-status={status}
      initial={mobile ? { y: '100%' } : { scale: 0.96, opacity: 0 }} animate={mobile ? { y: 0 } : { scale: 1, opacity: 1 }}
      exit={mobile ? { y: '100%' } : { opacity: 0 }} transition={{ type: 'spring', stiffness: 420, damping: 38 }} onClick={(e) => e.stopPropagation()}>
      {mobile && <div className="fair-grabber" aria-hidden="true" />}
      <div className="fair-head"><h3>{c.title}</h3><button type="button" onClick={onClose} aria-label="Close">✕</button></div>
      <div className={`fair-verdict fair-${status === 'none' ? 'loading' : status}`} data-testid="slot-fair-verdict">
        <span className="fair-verdict-icon">{ok ? '✓' : status === 'none' ? '' : '!'}</span>
        <div><strong>{status === 'none' ? c.noRound : ok ? c.fairVerdict : c.badVerdict}</strong>
          {status === 'mismatch' && <p>{c.badNote}</p>}</div>
      </div>
      {status === 'mismatch' && <ul className="fair-note slot-fair-problems" data-testid="slot-fair-problems">{(verdict?.problems || []).map((p) => <li key={p}>{p}</li>)}</ul>}
      <div className="fair-picture" data-testid="fair-picture">
        <div className={`fair-tile ${states[0] ? 'ok' : 'bad'}`}><span className="fair-icon"><LockIcon /></span><b>{c.locked[0]}</b><small>{c.locked[1]}</small></div>
        <span className="fair-arrow" aria-hidden="true">›</span>
        <div className={`fair-tile ${states[1] ? 'ok' : 'bad'}`}><span className="fair-icon"><SpinIcon /></span><b>{c.spin[0]}</b><small>{c.spin[1]}</small></div>
        <span className="fair-arrow" aria-hidden="true">›</span>
        <div className={`fair-tile ${states[2] ? 'ok' : 'bad'}`}><span className="fair-icon">{round ? <DoorIcon /> : <LockIcon open />}</span><b>{c.opened[0]}</b><small>{round ? c.opened[1] : 'after the spin'}</small></div>
      </div>
      {ok && <p className="fair-one-line">{c.sentence}</p>}
      {round && f && <div className={`fair-drop${diy ? ' open' : ''}`}>
        <button type="button" className="fair-drop-btn" data-testid="drop-diy" aria-expanded={diy} onClick={() => setDiy((v) => !v)}><span>{c.check}</span><Chevron open={diy} /></button>
        {diy && <div className="fair-drop-body" data-testid="slot-fair-diy">
          <p className="fair-note">{c.checkNote}</p>
          <Code id="key" label={c.keyLabel} value={f.serverSeed} />
          <Code id="lock" label={c.lockLabel} value={f.serverSeedHash} />
          <Code id="lucky" label={c.luckyLabel} value={f.clientSeed} />
          <Code id="nonce" label={c.nonceLabel} value={f.nonce} />
          <Code id="stops" label={c.stopsLabel} value={stops} />
          <div className="fair-btn-row">
            <a className="fair-btn fair-btn-ghost" href="/verify-slots.mjs" download="verify-slots.mjs">{c.verifier}</a>
            <button type="button" className="fair-btn fair-btn-ghost" onClick={downloadProof}>{c.roundData}</button>
          </div>
        </div>}
      </div>}
      <button type="button" className="fair-close" onClick={onClose}>{c.close}</button>
    </motion.div>
  </motion.div>;
}
