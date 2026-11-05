import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { SLOT_MATH } from '../../../backend/src/games/slotsMath.js';
import { fmtMoney } from '../chips.js';
import { lockBackgroundScroll } from '../modalScrollLock.js';
import { SlotSymbol } from './SlotSymbols.jsx';
import { paytableRows, scatterRow, paytableCopy } from './slotCopy.js';
import { fmtBet } from './slotsApi.js';

// Pay table built from the published maths for the CURRENT bet. Bottom sheet on phones, centred
// modal on desktop; the sheet scrolls inside while the page behind stays put.
const amount = (units) => (units % 100 === 0 ? Math.round(units / 100).toLocaleString('en-US') : fmtMoney(units).replace(' $TICS', ''));

function LineDiagram({ index }) {
  const line = SLOT_MATH.lines[index];
  return <div className="slot-line-diagram" aria-label={`Line ${index + 1}`}>
    <span className="slot-line-no">{index + 1}</span>
    <svg viewBox="0 0 50 30" aria-hidden="true">
      {Array.from({ length: SLOT_MATH.rows }, (_, row) => Array.from({ length: SLOT_MATH.reels }, (_, reel) => <rect key={`${row}-${reel}`} x={reel * 10 + 1} y={row * 10 + 1} width="8" height="8" rx="1.5" className={line[reel] === row ? 'on' : ''} />))}
      <polyline points={line.map((row, reel) => `${reel * 10 + 5},${row * 10 + 5}`).join(' ')} fill="none" stroke="#22d3ff" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  </div>;
}

export default function SlotPaytable({ stake, mobile, onClose }) {
  const copy = paytableCopy();
  const rows = paytableRows(stake);
  const scatter = scatterRow(stake);
  useEffect(() => lockBackgroundScroll(true), []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const Wrapper = mobile ? 'fair-sheet' : 'fair-modal';
  return <motion.div className="fair-backdrop slot-sheet-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
    <motion.div className={`${Wrapper} slot-sheet slot-paytable`} role="dialog" aria-modal="true" aria-label={copy.title} data-testid="slot-paytable"
      initial={mobile ? { y: '100%' } : { scale: 0.96, opacity: 0 }} animate={mobile ? { y: 0 } : { scale: 1, opacity: 1 }}
      exit={mobile ? { y: '100%' } : { opacity: 0 }} transition={{ type: 'spring', stiffness: 420, damping: 38 }} onClick={(e) => e.stopPropagation()}>
      {mobile && <div className="fair-grabber" aria-hidden="true" />}
      <div className="fair-head"><h3>{copy.title}</h3><button type="button" onClick={onClose} aria-label="Close">✕</button></div>
      <p className="slot-pt-bet" data-testid="paytable-bet">{copy.betLine(stake)}</p>
      <div className="slot-pt-facts">
        <span className="slot-pt-pill" data-testid="paytable-rtp">{copy.payback}</span>
        <span className="slot-pt-pill">{copy.cap}</span>
      </div>
      <h4>{copy.rulesTitle}</h4>
      <ol className="slot-pt-rules" data-testid="paytable-rules">{copy.rules.map((r, i) => <li key={i}>{r}</li>)}</ol>
      <h4>{copy.symbolsTitle}</h4>
      <div className="slot-pt-grid" data-testid="paytable-rows">
        <div className="slot-pt-row slot-pt-head"><span /><span>Symbol</span><span>3</span><span>4</span><span>5</span></div>
        {rows.map((r) => <div className={`slot-pt-row${r.role ? ` slot-pt-${r.role}` : ''}`} key={r.code} data-symbol={r.code}>
          <span className="slot-pt-sym"><SlotSymbol code={r.code} /></span>
          <span className="slot-pt-name">{r.name}{r.role === 'wild' && <small>Wild</small>}</span>
          {r.pays.map((p) => <span key={p.count} className="slot-pt-pay" data-units={p.units}>{amount(p.units)}</span>)}
        </div>)}
        <div className="slot-pt-row slot-pt-scatter" data-symbol={scatter.code}>
          <span className="slot-pt-sym"><SlotSymbol code={scatter.code} /></span>
          <span className="slot-pt-name">{scatter.name}<small>Anywhere</small></span>
          {scatter.pays.map((p) => <span key={p.count} className="slot-pt-pay" data-units={p.units}>{amount(p.units)}</span>)}
        </div>
      </div>
      <p className="slot-pt-note">All pays in $TICS at a bet of {fmtBet(stake)}. {copy.linesRule}</p>
      <p className="slot-pt-note">{copy.wildRule} {copy.scatterRule}</p>
      <h4>Free spins</h4>
      <p className="slot-pt-note">{copy.freeSpinsRule}</p>
      <h4>{copy.linesTitle}</h4>
      <div className="slot-lines-grid" data-testid="paytable-lines">
        {SLOT_MATH.lines.map((_, i) => <LineDiagram key={i} index={i} />)}
      </div>
      <h4>{copy.payback}</h4>
      <p className="slot-pt-note">{copy.paybackNote}</p>
      <h4>Round cap</h4>
      <p className="slot-pt-note">{copy.cap} {copy.capNote}</p>
      <button type="button" className="fair-close" onClick={onClose}>{copy.close}</button>
    </motion.div>
  </motion.div>;
}
