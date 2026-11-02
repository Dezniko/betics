import { useEffect, useRef, useState } from 'react';
import { CONNECT_NOTICE } from './connectNotice.js';

// Shown when Connect wallet is pressed for the first time in this browser. Continue (after the
// tick) records it and opens the wallet picker; Not now, Escape or a tap outside closes it.
export default function ConnectNotice({ onContinue, onClose }) {
  const [checked, setChecked] = useState(false);
  // On short screens the text scrolls inside the card: fade its bottom edge while there is more below.
  const bodyRef = useRef(null);
  const [more, setMore] = useState(false);
  const measure = () => { const b = bodyRef.current; if (b) setMore(b.scrollHeight - b.scrollTop - b.clientHeight > 4); };
  useEffect(() => {
    measure();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    if (ro && bodyRef.current) ro.observe(bodyRef.current);
    window.addEventListener('resize', measure);
    return () => { ro?.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return <div className="fair-backdrop connect-notice-backdrop" data-testid="connect-notice-backdrop" onClick={onClose}>
    <div className="fair-modal connect-notice" role="dialog" aria-modal="true" aria-labelledby="connect-notice-title"
      data-testid="connect-notice" onClick={(e) => e.stopPropagation()}>
      <div className="fair-head"><h3 id="connect-notice-title">{CONNECT_NOTICE.title}</h3></div>
      <div className={`connect-notice-body${more ? ' has-more' : ''}`} ref={bodyRef} onScroll={measure} data-testid="connect-notice-body">
        {CONNECT_NOTICE.sections.map((s) => <section key={s.heading} className="connect-notice-item">
          <h4>{s.heading}</h4>
          <p>{s.text}</p>
        </section>)}
      </div>
      <div className="connect-notice-foot">
        <label className="wallet-check connect-notice-check">
          <input type="checkbox" id="connect-notice-agree" name="connectNoticeAgree" checked={checked}
            onChange={(e) => setChecked(e.target.checked)} data-testid="connect-notice-check" />
          <span>I have read and agree to the <a href="/terms" target="_blank" rel="noopener">Terms</a></span>
        </label>
        <div className="connect-notice-actions">
          <button type="button" className="fair-btn fair-btn-ghost" onClick={onClose} data-testid="connect-notice-later">Not now</button>
          <button type="button" className="fair-btn" disabled={!checked} onClick={onContinue} data-testid="connect-notice-continue">Continue</button>
        </div>
        <a className="connect-notice-link" href="/how-it-works" target="_blank" rel="noopener">How it works</a>
      </div>
    </div>
  </div>;
}
