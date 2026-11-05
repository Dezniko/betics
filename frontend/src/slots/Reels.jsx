import { memo, useMemo } from 'react';
import { SLOT_MATH } from '../../../backend/src/games/slotsMath.js';
import { SlotSymbol } from './SlotSymbols.jsx';
import { linePoints } from './slotAnim.js';

// The 5 x 3 reel window. Everything that moves is a transform or an opacity: a spinning reel is a long
// strip of tiles sliding with a CSS animation (blurred), a landed reel is a 5 tile strip (one above, the
// three shown, one below) that drops into place with a small bounce. Winning tiles glow, losers dim and the
// paying line is drawn as an SVG polyline over the grid.

const SPIN_TILES = 12; // 9 unique plus the first 3 again, so the loop is seamless
function spinningTiles(reel) {
  const strip = SLOT_MATH.strips[reel];
  const base = Array.from({ length: 9 }, (_, i) => strip[(i * 7 + reel * 5) % strip.length]);
  return [...base, base[0], base[1], base[2]];
}
const key = (reel, row) => `${reel}:${row}`;

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
  return <div className={`slot-reel${state === 'spinning' ? ' spinning' : ''}${anticipating ? ' anticipating' : ''}`} data-reel={reel} data-state={state}>
    {state === 'spinning' ? (
      <div className="slot-strip spin" style={{ '--tiles': SPIN_TILES }} aria-hidden="true">
        {spinTiles.map((code, i) => <div key={i} className="slot-tile blur"><SlotSymbol code={code} /></div>)}
      </div>
    ) : (
      <div key={`${spinKey}-${reel}`} className={`slot-strip ${state === 'stopped' ? 'land' : 'still'}`}>
        <div className={cls(null, above)}><SlotSymbol code={above} /></div>
        {column.map((code, row) => <div key={row} className={cls(row, code)} data-cell={key(reel, row)}><SlotSymbol code={code} /></div>)}
        <div className={cls(null, below)}><SlotSymbol code={below} /></div>
      </div>
    )}
  </div>;
}

function Reels({ grid, stops, reelStates, spinKey, activeLine, winCells, dimming, scatterHot, anticipationFrom, onTap, children }) {
  const winSet = useMemo(() => new Set((winCells || []).map((c) => key(c.reel, c.row))), [winCells]);
  const columns = useMemo(() => Array.from({ length: SLOT_MATH.reels }, (_, reel) => grid.map((row) => row[reel])), [grid]);
  return <div className="slot-reels-wrap" onPointerDown={onTap} data-testid="slot-reels">
    <div className="slot-reels">
      {columns.map((column, reel) => <Reel key={reel} reel={reel} state={reelStates[reel]} stop={stops ? stops[reel] : 0} column={column} spinKey={spinKey}
        winSet={winSet} dimming={!!dimming} scatterHot={!!scatterHot} anticipating={anticipationFrom != null && reel >= anticipationFrom && reelStates[reel] === 'spinning'} />)}
    </div>
    <svg className="slot-lines" viewBox="0 0 500 300" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="slot-line-neon" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#a63cff" /><stop offset=".5" stopColor="#5a4bff" /><stop offset="1" stopColor="#22d3ff" /></linearGradient>
      </defs>
      {activeLine != null && <polyline key={`${spinKey}-${activeLine}`} className="slot-line" points={linePoints(activeLine)} fill="none" stroke="url(#slot-line-neon)" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
    </svg>
    {children}
  </div>;
}
export default memo(Reels);
