// One layout description of the roulette felt, in plain board-pixel
// coordinates, for BOTH orientations:
//   horizontal (desktop/tablet): 12 columns x 3 rows, zero on the left
//   vertical (legacy/reference only): 3 columns x 12 rows, zero on top.
// The live game stays horizontal in both phone orientations.
// The interactive board and the win-popup snapshot both draw from this, so
// they can never drift apart.
import { multiplierFor } from './rouletteRules.js';

const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

// Logical grid: ROWS[r][c] — same as the original board (row 0 = 3,6,9…).
export const ROWS = [
  [3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36],
  [2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35],
  [1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34],
];

export function cellColorClass(n) {
  if (n === 0) return 'cell-zero';
  return RED_NUMBERS.has(n) ? 'cell-red' : 'cell-black';
}

export function betKey(type, value) {
  const v = Array.isArray(value) ? [...value].sort((a, b) => a - b).join(',') : value;
  return `${type}:${v}`;
}

const OUTSIDE_LABELS = {
  dozen1: '1st 12', dozen2: '2nd 12', dozen3: '3rd 12',
  column1: '2 to 1', column2: '2 to 1', column3: '2 to 1',
  low: '1-18', even: 'EVEN', red: 'RED', black: 'BLACK', odd: 'ODD', high: '19-36',
};

function coverOf(type, value) {
  const out = [];
  for (let n = 0; n <= 36; n++) if (multiplierFor({ type, value }, n) > 0) out.push(n);
  return out;
}

const cache = {};

export function makeLayout(vertical, horizontalHeight = null) {
  const targetHeight = !vertical && Number.isFinite(horizontalHeight) ? Math.round(horizontalHeight) : null;
  const key = vertical ? 'v' : `h:${targetHeight ?? 'default'}`;
  if (cache[key]) return cache[key];

  const cells = [];
  const zones = [];
  const outside = [];
  const rectOf = {}; // number -> rect

  let W;
  let H;
  let chipSize;
  let G;
  let cellRect; // (c, r) -> rect
  let zeroRect;
  let stripAnchor; // for streets / six-lines

  if (!vertical) {
    // Landscape table, laid out like a live casino felt: 0 on the left, the
    // 12x3 number grid, the three "2 to 1" column bets at the right end of
    // each row, then dozens and the six even-money bets underneath.
    const CW = 58; // absorb the old six-pixel gutters into continuous cells
    const baseCH = targetHeight == null ? 44 : 52;
    const baseOutside = targetHeight == null ? 42 : 30; // dozens and even-money rows: thick enough to read and hit
    const stretch = targetHeight == null ? 1 : Math.max(0.35, targetHeight / (3 * baseCH + 2 * baseOutside));
    const CH = baseCH * stretch;
    G = 0;
    const ZW = 44;
    const SS = 20; // street hit area straddles the shared edge; never an extra row
    const COLW = 46; // the 2-to-1 column bets
    chipSize = 24;
    const GRIDW = ZW + 12 * CW + 11 * G;
    W = GRIDW + G + COLW;
    const BH = 3 * CH + 2 * G;
    cellRect = (c, r) => ({ x: ZW + c * (CW + G), y: r * (CH + G), w: CW, h: CH });
    zeroRect = { x: 0, y: 0, w: ZW, h: BH };
    stripAnchor = {
      street: (c) => ({ x: ZW + c * (CW + G) + CW / 2, y: BH, w: CW - 8, h: SS }),
      sixline: (c) => ({ x: ZW + c * (CW + G) + CW + G / 2, y: BH, w: 16, h: SS }),
    };
    // column1 = 1,4,7… (bottom row), column3 = 3,6,9… (top row)
    ['column3', 'column2', 'column1'].forEach((t, r) => {
      outside.push({ type: t, label: OUTSIDE_LABELS[t], x: GRIDW + G, y: r * (CH + G), w: COLW, h: CH, kind: 'plain' });
    });
    const y0 = BH; // dozens share the street/six-line edge of the number grid
    const rowH = baseOutside * stretch;
    ['dozen1', 'dozen2', 'dozen3'].forEach((t, i) => {
      outside.push({ type: t, label: OUTSIDE_LABELS[t], x: ZW + i * 4 * (CW + G), y: y0, w: 4 * CW + 3 * G, h: rowH, kind: 'plain' });
    });
    ['low', 'even', 'red', 'black', 'odd', 'high'].forEach((t, i) => {
      outside.push({
        type: t, label: OUTSIDE_LABELS[t], x: ZW + i * 2 * (CW + G), y: y0 + rowH + G, w: 2 * CW + G, h: rowH,
        kind: t === 'red' ? 'red' : t === 'black' ? 'black' : 'plain',
      });
    });
    H = y0 + 2 * rowH;
  } else {
    const VW = 76;
    const VH = 44; // portrait rows stay finger-sized instead of shrinking a horizontal felt
    G = 5;
    const DZ = 46; // dozens column (incl. gap)
    const ZH = 42; // zero band (incl. gap)
    const SS = 26;
    chipSize = 26;
    const NW = 3 * VW + 2 * G;
    W = DZ + NW + 6 + SS;
    const NB = 12 * VH + 11 * G;
    cellRect = (c, r) => ({ x: DZ + (2 - r) * (VW + G), y: ZH + c * (VH + G), w: VW, h: VH });
    zeroRect = { x: DZ, y: 0, w: NW, h: ZH - G };
    const sx = DZ + NW + 6 + SS / 2;
    stripAnchor = {
      street: (c) => ({ x: sx, y: ZH + c * (VH + G) + VH / 2, w: SS, h: VH - 8 }),
      sixline: (c) => ({ x: sx, y: ZH + c * (VH + G) + VH + G / 2, w: SS, h: 16 }),
    };
    ['dozen1', 'dozen2', 'dozen3'].forEach((t, i) => {
      const h = 4 * VH + 3 * G;
      outside.push({ type: t, label: OUTSIDE_LABELS[t], x: 0, y: ZH + i * (h + G), w: DZ - 6, h, kind: 'plain', vertical: true });
    });
    const y0 = ZH + NB + 8;
    ['column1', 'column2', 'column3'].forEach((t, i) => {
      outside.push({ type: t, label: OUTSIDE_LABELS[t], x: DZ + i * (VW + G), y: y0, w: VW, h: 34, kind: 'plain' });
    });
    const y1 = y0 + 34 + 8;
    ['low', 'even', 'red', 'black', 'odd', 'high'].forEach((t, i) => {
      const w = (W - 5 * 4) / 6;
      outside.push({
        type: t, label: OUTSIDE_LABELS[t], x: i * (w + 4), y: y1, w, h: 38,
        kind: t === 'red' ? 'red' : t === 'black' ? 'black' : 'plain',
      });
    });
    H = y1 + 38 + 8;
  }

  // ---- number cells ----
  cells.push({ n: 0, ...zeroRect });
  rectOf[0] = zeroRect;
  ROWS.forEach((row, r) =>
    row.forEach((n, c) => {
      const rc = cellRect(c, r);
      rectOf[n] = rc;
      cells.push({ n, ...rc });
    })
  );
  const centre = (rc) => ({ x: rc.x + rc.w / 2, y: rc.y + rc.h / 2 });
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const hit = vertical ? 12 : 8; // extra tap room on the thin gap zones

  // ---- straight-up zones ----
  zones.push({
    type: 'straight', value: 0, cover: [0], z: 1,
    x: zeroRect.x + zeroRect.w / 2, y: zeroRect.y + zeroRect.h / 2, w: zeroRect.w - 6, h: zeroRect.h - 6,
    title: 'Straight: 0',
  });
  ROWS.forEach((row, r) =>
    row.forEach((n, c) => {
      const cc = centre(cellRect(c, r));
      zones.push({ type: 'straight', value: n, cover: [n], z: 1, x: cc.x, y: cc.y, w: cellRect(c, r).w - 12, h: cellRect(c, r).h - 12, title: `Straight: ${n}` });
    })
  );
  // ---- zero splits (0 with 1, 2, 3) ----
  [0, 1, 2].forEach((r) => {
    const n = ROWS[r][0];
    const rc = cellRect(0, r);
    const cc = centre(rc);
    const pos = vertical ? { x: cc.x, y: ZH_EDGE(rc) } : { x: rc.x, y: cc.y };
    zones.push({ type: 'split', value: [0, n], cover: [0, n], z: 3, ...pos, w: 18, h: 18, round: true, title: `Split: 0 / ${n}` });
  });
  function ZH_EDGE(rc) { return rc.y - G / 2 - 1; }

  // ---- vertical splits (rows r, r+1 in same column) and horizontal splits ----
  const pairSplit = (a, b) => {
    const ra = rectOf[a];
    const rb = rectOf[b];
    const m = mid(centre(ra), centre(rb));
    const horizontalNeighbours = Math.abs(centre(ra).x - centre(rb).x) > Math.abs(centre(ra).y - centre(rb).y);
    const w = horizontalNeighbours ? G + hit : ra.w * 0.5;
    const h = horizontalNeighbours ? ra.h * 0.5 : G + hit;
    zones.push({ type: 'split', value: [a, b], cover: [a, b], z: 2, ...m, w, h, title: `Split: ${a} / ${b}` });
  };
  for (let r = 0; r < 2; r++) for (let c = 0; c < 12; c++) pairSplit(ROWS[r][c], ROWS[r + 1][c]);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 11; c++) pairSplit(ROWS[r][c], ROWS[r][c + 1]);

  // ---- corners ----
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 11; c++) {
      const nums = [ROWS[r][c], ROWS[r][c + 1], ROWS[r + 1][c], ROWS[r + 1][c + 1]];
      const cs = nums.map((n) => centre(rectOf[n]));
      zones.push({
        type: 'corner', value: nums, cover: nums, z: 4,
        x: cs.reduce((a, p) => a + p.x, 0) / 4, y: cs.reduce((a, p) => a + p.y, 0) / 4,
        w: vertical ? 22 : 18, h: vertical ? 22 : 18, round: true, title: `Corner: ${nums.join('/')}`,
      });
    }
  }
  // ---- streets + six lines ----
  for (let c = 0; c < 12; c++) {
    const street = [ROWS[0][c], ROWS[1][c], ROWS[2][c]];
    const a = stripAnchor.street(c);
    zones.push({ type: 'street', value: street, cover: street, z: 2, ...a, title: `Street: ${street.join('/')}` });
  }
  for (let c = 0; c < 11; c++) {
    const six = [ROWS[0][c], ROWS[1][c], ROWS[2][c], ROWS[0][c + 1], ROWS[1][c + 1], ROWS[2][c + 1]];
    const a = stripAnchor.sixline(c);
    zones.push({ type: 'sixline', value: six, cover: six, z: 3, ...a, title: `Six line: ${six.join('/')}` });
  }
  // ---- outside bets become zones too ----
  outside.forEach((o) => {
    zones.push({
      type: o.type, value: undefined, cover: coverOf(o.type), z: 1, outside: true,
      x: o.x + o.w / 2, y: o.y + o.h / 2, w: o.w, h: o.h, title: o.label === '2 to 1' ? `Column ${o.type.slice(-1)} (2 to 1)` : o.label,
    });
  });
  zones.forEach((z) => { z.key = betKey(z.type, z.value); });

  const zoneByKey = Object.fromEntries(zones.map((z) => [z.key, z]));
  const layout = {
    vertical, W, H, G, chipSize, sizeFor: (type) => (type === 'straight' || ['red','black','odd','even','low','high','dozen1','dozen2','dozen3','column1','column2','column3'].includes(type) ? chipSize : Math.round(chipSize * 0.8)), cells, outside, zones, zoneByKey, rectOf,
    anchorOf(bet) {
      const z = zoneByKey[betKey(bet.type, bet.value)];
      if (z) return { x: z.x, y: z.y };
      const cs = coverOf(bet.type, bet.value).map((n) => centre(rectOf[n]));
      return { x: cs.reduce((a, p) => a + p.x, 0) / cs.length, y: cs.reduce((a, p) => a + p.y, 0) / cs.length };
    },
  };
  cache[key] = layout;
  return layout;
}

// Human-readable odds for tooltips
export function oddsText(type) {
  const map = { straight: '35 to 1', split: '17 to 1', street: '11 to 1', trio: '11 to 1', corner: '8 to 1', sixline: '5 to 1',
    red: '1 to 1', black: '1 to 1', odd: '1 to 1', even: '1 to 1', low: '1 to 1', high: '1 to 1',
    dozen1: '2 to 1', dozen2: '2 to 1', dozen3: '2 to 1', column1: '2 to 1', column2: '2 to 1', column3: '2 to 1' };
  return map[type] || '';
}
