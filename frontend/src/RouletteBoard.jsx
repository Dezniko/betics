import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { visibleChipSize, touchHitSize } from './touchBetting.js';
import { motion } from 'framer-motion';
import { ChipStack, stackHeight } from './ChipView.jsx';
import { makeLayout, cellColorClass, betKey, oddsText } from './boardLayout.js';
import { didBetWin, payoutCentsFor, betLabel } from './rouletteRules.js';
import { fmtShort, fmtFelt } from './chips.js';
import { layoutPayoutLabels, totalPillRect } from './payoutLabels.js';

export const VERTICAL_BELOW = 0; // keep the same horizontal felt in both phone orientations

// Measures an element's width (and re-measures on resize / rotation).
export function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => { setWidth(e.contentRect.width); setHeight(e.contentRect.height); });
    ro.observe(ref.current);
    setWidth(ref.current.getBoundingClientRect().width);
    setHeight(ref.current.getBoundingClientRect().height);
    return () => ro.disconnect();
  }, []);
  return [ref, width, height];
}

// The dolly: the marker a croupier sets ON the winning number, on top of any
// chips there. A translucent gold dome with a bright rim, so the chips under
// it stay visible around and through it. Drops in from above when it lands.
export function Dolly({ rect, size = 30, corner = false }) {
  const cx = corner ? rect.x + rect.w - size / 2 - 2 : rect.x + rect.w / 2;
  const cy = corner ? rect.y + size / 2 + 2 : rect.y + rect.h / 2;
  return (
    <motion.div
      className="absolute pointer-events-none"
      style={{ left: cx - size / 2, top: cy - size / 2, width: size, height: size, zIndex: 90 }}
      initial={{ y: -60, scale: 1.8, opacity: 0 }}
      animate={{ y: 0, scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 420, damping: 15, mass: 0.8 }}
    >
      <div
        className="w-full h-full rounded-full"
        style={{
          background: 'radial-gradient(circle at 35% 30%, rgba(255,246,214,0.95), rgba(243,217,139,0.7) 40%, rgba(212,175,55,0.55) 75%, rgba(122,94,26,0.7) 100%)',
          boxShadow: '0 0 0 2px rgba(243,217,139,0.95), 0 0 14px 4px rgba(243,217,139,0.7), 0 3px 6px rgba(0,0,0,0.6)',
        }}
      />
    </motion.div>
  );
}

// Draws the felt (number cells + outside bets + dolly). Non-interactive;
// RouletteBoard layers click zones on top and the win popup layers chips.
export function BoardSurface({ layout, pocket, highlight, children, fontScale = 1, showDolly = true, cornerPocketNumber = false, dollySize = 30, dollyCorner = false }) {
  const hl = highlight || new Set();
  return (
    <div className="absolute inset-0">
      {layout.cells.map((c) => (
        <div
          key={c.n}
          data-cell-number={c.n}
          className={`absolute flex items-center justify-center text-sm font-semibold text-[#ede9e1] rounded-none border felt-line transition-[filter,box-shadow] duration-100 ${cellColorClass(c.n)} ${
            hl.has(c.n) ? 'brightness-150 ring-2 ring-[#f3d98b]' : ''
          } ${pocket === c.n ? 'ring-2 ring-[#d6b06a]' : ''}`}
          style={{ left: c.x, top: c.y, width: c.w, height: c.h, fontSize: 14 * fontScale, ...(cornerPocketNumber && pocket === c.n ? { alignItems: 'flex-start', justifyContent: 'flex-start', padding: 4 } : {}) }}
        >
          {c.n}
        </div>
      ))}
      {layout.outside.map((o) => (
        <div
          key={o.type}
          data-outside-bet={o.type}
          className={`absolute flex items-center justify-center text-xs font-semibold text-[#ede9e1] rounded-none border felt-line ${
            o.kind === 'red' ? 'cell-red' : o.kind === 'black' ? 'cell-black' : 'cell-green'
          } ${hl.size && o.cover?.length ? '' : ''}`}
          style={{ left: o.x, top: o.y, width: o.w, height: o.h, fontSize: 12 * fontScale }}
        >
          <span style={o.vertical ? { writingMode: 'vertical-rl', transform: 'rotate(180deg)', letterSpacing: '0.08em' } : undefined}>{o.label}</span>
        </div>
      ))}
      {showDolly && pocket != null && layout.rectOf[pocket] && <Dolly key={`dolly-${pocket}`} rect={layout.rectOf[pocket]} size={dollySize} corner={dollyCorner} />}
      {children}
    </div>
  );
}

function RouletteBoard({
  bets, onAddBet, onRemoveBet, disabled, settledPocket, showResults, onHoverInfo, chipValue, fitHeight, portrait = null, fill = false, payouts = [],
}) {
  const [wrapRef, avail, availHeight] = useWidth();
  const vertical = portrait ?? (!fitHeight && avail > 0 && avail < VERTICAL_BELOW);
  const targetHeight = fill && avail > 0 && availHeight > 0 ? availHeight / (avail / makeLayout(false).W) : null;
  const layout = useMemo(() => makeLayout(vertical, targetHeight), [vertical, targetHeight]);
  const scale = avail > 0 ? fill ? avail / layout.W : Math.min(1, avail / layout.W, fitHeight ? fitHeight / layout.H : 1) : 1;
  const [hoverKey, setHoverKey] = useState(null);
  const hoverTimer = useRef(null);
  const longPress = useRef(null);
  const suppressClick = useRef(false);
  const lastPointer = useRef('mouse');

  const hoverZone = hoverKey ? layout.zoneByKey[hoverKey] : null;
  const highlight = useMemo(() => new Set(hoverZone ? hoverZone.cover : []), [hoverZone]);

  const betOf = (z) => bets.find((b) => betKey(b.type, b.value) === z.key);

  useEffect(() => {
    if (!onHoverInfo) return;
    if (!hoverZone) { onHoverInfo(null); return; }
    const bet = { type: hoverZone.type, value: hoverZone.value };
    const staked = betOf(hoverZone)?.amountCents || 0;
    onHoverInfo({
      label: hoverZone.outside ? hoverZone.title : betLabel(bet),
      odds: oddsText(hoverZone.type),
      staked,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoverKey, bets, chipValue]);

  const flashHover = (key) => {
    setHoverKey(key);
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHoverKey(null), 1600);
  };

  const place = (z) => {
    if (disabled) return;
    onAddBet({ type: z.type, value: z.value });
  };

  const startLongPress = (z) => {
    clearTimeout(longPress.current);
    suppressClick.current = false;
    longPress.current = setTimeout(() => {
      if (!disabled && betOf(z)) {
        suppressClick.current = true;
        onRemoveBet({ type: z.type, value: z.value });
      }
    }, 550);
  };
  const cancelLongPress = () => clearTimeout(longPress.current);

  const settled = showResults && settledPocket != null;

  const payoutView = useMemo(() => {
    const pops = payouts.map((p) => {
      const b = bets.find((x) => betKey(x.type, x.value) === p.key);
      return b ? { ...p, ...layout.anchorOf(b), text: fmtFelt(p.amountCents) } : null;
    }).filter(Boolean);
    if (!pops.length) return { pops, labels: [], total: null };
    const totalCents = pops.reduce((s, p) => s + p.amountCents, 0), totalText = `+${fmtShort(totalCents)}`;
    // One winner: one amount, on its number. Several: each on its chip plus a total.
    const total = pops.length > 1 ? totalPillRect(`TOTAL WIN ${totalText}`, layout.W, scale) : null;
    const placed = layoutPayoutLabels(pops, { W: layout.W, H: layout.H, scale, reserved: total ? [total] : [] });
    const labels = placed.filter((l) => l.shown).map((l) => ({ ...l, text: pops.find((p) => p.key === l.key).text }));
    return { pops, labels, total, totalCents, totalText };
  }, [payouts, bets, layout, scale]);

  return (
    <div ref={wrapRef} data-testid="roulette-board" data-orientation={vertical ? 'portrait' : 'landscape'} className="w-full noselect" style={fill ? { height: '100%', minHeight: 0 } : undefined}>
      <div style={{ width: layout.W * scale, height: layout.H * scale, margin: '0 auto' }}>
        <div
          style={{ width: layout.W, height: layout.H, transform: `scale(${scale})`, transformOrigin: 'top left', position: 'relative' }}
          onMouseDown={(e) => e.preventDefault()}
          onDoubleClick={(e) => e.preventDefault()}
          onMouseLeave={() => setHoverKey(null)}
        >
          <BoardSurface layout={layout} pocket={settledPocket} highlight={highlight} dollySize={fill?12/scale:30} dollyCorner={fill} fontScale={fill ? Math.max(1, 11 / (14 * scale)) : 1} />

          {/* click zones — big ones underneath, small gap zones on top */}
          {layout.zones.map((z) => {
            const staked = betOf(z);
            const hit = touchHitSize(layout,z,scale,fill);
            return (
              <button
                key={z.key}
                type="button"
                tabIndex={-1}
                disabled={disabled}
                title={z.title}
                data-zone-key={z.key}
                onMouseDown={(e) => e.preventDefault()}
                onPointerDown={(e) => { lastPointer.current = e.pointerType; startLongPress(z); }}
                onPointerUp={cancelLongPress}
                onPointerLeave={cancelLongPress}
                onPointerCancel={cancelLongPress}
                onPointerEnter={(e) => { if (e.pointerType === 'mouse') setHoverKey(z.key); }}
                onClick={(e) => {
                  if (suppressClick.current) { suppressClick.current = false; return; }
                  place(z);
                  if (lastPointer.current !== 'mouse') flashHover(z.key);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!disabled && staked) onRemoveBet({ type: z.type, value: z.value });
                }}
                className={`absolute outline-none select-none ${z.round ? 'rounded-full' : 'rounded-sm'} ${
                  hoverKey === z.key ? 'bg-[#f3d98b]/25 ring-1 ring-[#f3d98b]/80' : ''
                } disabled:cursor-not-allowed`}
                style={{ left: z.x - hit.w / 2, top: z.y - hit.h / 2, width: hit.w, height: hit.h, borderRadius: fill && ['split','corner'].includes(z.type) ? 0 : undefined, zIndex: 10 + z.z, WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation' }}
              />
            );
          })}

          {/* the chips actually placed */}
          {bets.map((b) => {
            const a = layout.anchorOf(b);
            const size = visibleChipSize(layout,scale,b.type,fill);
            const chips = b.chips && b.chips.length ? b.chips : [b.amountCents];
            const stackH = stackHeight(chips, size);
            const won = settled && didBetWin(b, settledPocket);
            const lost = settled && !won;
            return (
              <div key={betKey(b.type, b.value)} data-bet-key={betKey(b.type, b.value)} data-staked-cents={b.amountCents} className="absolute pointer-events-none" style={{ left: Math.max(0,Math.min(layout.W-size,a.x-size/2)), top: Math.max(0,Math.min(layout.H-stackH,a.y+size/2-stackH)), zIndex: won ? 70 : 60 }}>
                <ChipStack chips={chips} size={size} glow={won} dim={lost} animateNewest={!fill} />
              </div>
            );
          })}

          {/* Winning chips burst; "+X TICS" labels are placed so none overlap
              or leave the felt, and a running total pill always shows the money. */}
          {payoutView.pops.map((p) => (
            <div key={`pop-${p.key}`} className="felt-payout-pop" data-payout-key={p.key} data-payout-cents={p.amountCents}
              style={{ left: p.x, top: p.y, '--pop-scale': 1 / scale }}>
              <span className="felt-payout-burst" aria-hidden="true" />
            </div>
          ))}
          {payoutView.labels.map((l) => (
            <div key={`label-${l.key}`} className="felt-payout-label" data-payout-label={l.key}
              style={{ left: l.left, top: l.top, width: l.width * scale, height: l.height * scale, transform: `scale(${1 / scale})` }}>
              {l.text}
            </div>
          ))}
          {payoutView.total && (
            <div className="felt-payout-total" data-testid="felt-payout-total" data-total-cents={payoutView.totalCents}
              style={{ left: payoutView.total.left, top: payoutView.total.top, width: payoutView.total.width * scale, height: payoutView.total.height * scale, transform: `scale(${1 / scale})` }}>
              <span>TOTAL WIN</span> {payoutView.totalText}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
export default memo(RouletteBoard);
