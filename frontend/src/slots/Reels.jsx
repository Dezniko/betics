import { memo, useMemo } from 'react';
import { SLOT_MATH } from '../../../backend/src/games/slotsMath.js';
import { SlotSymbol } from './SlotSymbols.jsx';
import { linePath } from './slotAnim.js';

// The 5 x 3 reel window. Everything that moves is a transform or an opacity: a spinning reel is a long
// strip of tiles sliding with a CSS animation (blurred, with streaks), a landed reel is a 5 tile strip (one
// above, the three shown, one below) that drops into place with an overshoot bounce and a flash. Winning
// tiles glow, losers dim and the paying line draws itself over the grid with a glowing head.

const SPIN_TILES = 12; // 9 unique plus the first 3 again, so the loop is seamless
function spinningTiles(reel) {
  const strip = SLOT_MATH.strips[reel];
  const base = Array.from({ length: 9 }, (_, i) => strip[(i * 7 + reel * 5) % strip.length]);
  return [...base, base[0], base[1], base[2]];
}
const key = (reel, row) => `${reel}:${row}`;

// Light burst behind a landed Gods of Power portrait (gold rays) or Qubetics logo (rainbow ring).
const Burst = ({ code }) => (code === 'W' ? <span className="slot-burst gold" aria-hidden="true"><i className="rays" /><i className="halo" /></span>
  : code === 'D' ? <span className="slot-burst rainbow" aria-hidden="true"><i className="ring" /><i className="ring two" /></span> : null);

function Reel({ reel, state, stop, column, spinKey, winSet, dimming, scatterHot, anticipating }) {
  const strip = SLOT_MATH.strips[reel];
  const spinTiles = useMemo(() => spinningTiles(reel), [reel]);
  const above = strip[(stop - 1 + strip.length) % strip.length];
  const below = strip[(stop + SLOT_MATH.rows) % strip.length];
  const cls = (row, code) => {
    const parts = ['slot-tile'];
    if (row != null && winSet.has(key(reel, row))) parts.push('win');
    else if (row != null && dimming) parts.push('dim');
    if (code === 'S' && scatterHot && row != null) parts.push('scatter-hot');
    if (row == null) parts.push('edge');
    return parts.join(' ');
  };
  return <div className={`slot-reel${state === 'spinning' ? ' spinning' : ''}${anticipating ? ' anticipating' : ''}`} data-reel={reel} data-state={state} style={{ '--reel': reel }}>
    {state === 'spinning' ? (
      <div className="slot-strip spin" style={{ '--tiles': SPIN_TILES }} aria-hidden="true">
        {spinTiles.map((code, i) => <div key={i} className="slot-tile blur"><SlotSymbol code={code} /></div>)}
      </div>
    ) : (
      <div key={`${spinKey}-${reel}`} className={`slot-strip ${state === 'stopped' ? 'land' : 'still'}`}>
        <div className={cls(null, above)}><SlotSymbol code={above} /></div>
        {column.map((code, row) => <div key={row} className={cls(row, code)} data-cell={key(reel, row)} style={{ '--i': reel * 3 + row }}>
          {state === 'stopped' && <Burst code={code} />}
          <SlotSymbol code={code} />
        </div>)}
        <div className={cls(null, below)}><SlotSymbol code={below} /></div>
      </div>
    )}
    {state === 'stopped' && <span key={`flash-${spinKey}`} className="slot-reel-flash" aria-hidden="true" />}
    {state === 'spinning' && <span className="slot-streaks" aria-hidden="true" />}
  </div>;
}

// Tiny dust motes drifting over the reel window (transform and opacity only).
const DUST = Array.from({ length: 16 }, (_, i) => ({ x: (i * 37 + 11) % 100, d: 9 + (i % 5) * 1.7, delay: -((i * 1.9) % 11), s: 0.6 + (i % 3) * 0.3 }));
const Dust = ({ count }) => <div className="slot-dust" aria-hidden="true">
  {DUST.slice(0, count).map((p, i) => <i key={i} style={{ '--x': `${p.x}%`, '--d': `${p.d}s`, '--delay': `${p.delay}s`, '--s': p.s }} />)}
</div>;

function Reels({ grid, stops, reelStates, spinKey, activeLine, activeCount = 5, winCells, dimming, scatterHot, anticipationFrom, onTap, dust = 8, children }) {
  const winSet = useMemo(() => new Set((winCells || []).map((c) => key(c.reel, c.row))), [winCells]);
  const columns = useMemo(() => Array.from({ length: SLOT_MATH.reels }, (_, reel) => grid.map((row) => row[reel])), [grid]);
  const path = activeLine != null ? linePath(activeLine, activeCount) : null;
  return <div className="slot-reels-wrap" onPointerDown={onTap} data-testid="slot-reels">
    <div className="slot-reels">
      {columns.map((column, reel) => <Reel key={reel} reel={reel} state={reelStates[reel]} stop={stops ? stops[reel] : 0} column={column} spinKey={spinKey}
        winSet={winSet} dimming={!!dimming} scatterHot={!!scatterHot} anticipating={anticipationFrom != null && reel >= anticipationFrom && reelStates[reel] === 'spinning'} />)}
    </div>
    <Dust count={dust} />
    <svg className="slot-lines" viewBox="0 0 500 300" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="slot-line-gold" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#f1dcaa" /><stop offset=".5" stopColor="#fff6d8" /><stop offset="1" stopColor="#d6b06a" /></linearGradient>
      </defs>
      {path && <g key={`${spinKey}-${activeLine}`}>
        <path className="slot-line halo" d={path} fill="none" stroke="#d6b06a" strokeWidth="14" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" pathLength="1" />
        <path className="slot-line core" d={path} fill="none" stroke="url(#slot-line-gold)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" pathLength="1" />
        <path className="slot-line sparkle" d={path} fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" pathLength="1" />
      </g>}
    </svg>
    {children}
  </div>;
}
export default memo(Reels);
