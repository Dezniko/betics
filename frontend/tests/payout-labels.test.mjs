import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutPayoutLabels, totalPillRect } from '../src/payoutLabels.js';

const inside = (r, W, H) => r.left >= 0 && r.top >= 0 && r.left + r.width <= W + 1e-9 && r.top + r.height <= H + 1e-9;
const apart = (a, b) => a.left + a.width <= b.left || b.left + b.width <= a.left || a.top + a.height <= b.top || b.top + b.height <= a.top;

// Reproduces the reported crowding: many winners clustered at the top-left
// next to zero (straight, splits, corners, street) on a small phone scale.
test('crowded winning labels never overlap, never leave the felt, and avoid the total pill', () => {
  for (const scale of [0.35, 0.5, 1]) {
    const W = 800, H = 260;
    const total = totalPillRect('TOTAL WIN +126 $TICS', W, scale);
    const items = [[60, 20], [70, 22], [90, 20], [92, 40], [70, 45], [60, 60], [110, 30], [100, 10], [5, 5]].map(([x, y], i) => ({ key: `k${i}`, x, y, text: `+${18 * (i + 1)} $TICS` }));
    const out = layoutPayoutLabels(items, { W, H, scale, reserved: [total] });
    const shown = out.filter(o => o.shown);
    assert.ok(shown.length < items.length || scale === 1, 'crowded labels are dropped rather than stacked');
    for (const r of shown) { assert.ok(inside(r, W, H), JSON.stringify(r)); assert.ok(apart(r, total)); }
    for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) assert.ok(apart(shown[i], shown[j]), JSON.stringify([shown[i], shown[j]]));
  }
});

import { makeLayout } from '../src/boardLayout.js';
// Reported: one win showed its amount twice, and wins on 1-3 / 34-36 drifted
// over the 0 or the 2-to-1 boxes. A lone winner gets exactly one label, centred
// on its own number and kept inside the felt, in both orientations.
test('a lone winner gets one label sitting on its own number, never off the felt', () => {
  for (const vertical of [false, true]) for (const screenW of [320, 390, 874, 1440]) {
    const L = makeLayout(vertical), scale = Math.min(1, screenW / L.W);
    for (let n = 0; n <= 36; n++) {
      const a = L.anchorOf({ type: 'straight', value: n });
      const [r] = layoutPayoutLabels([{ key: 's', x: a.x, y: a.y, text: '+180 $TICS' }], { W: L.W, H: L.H, scale });
      assert.equal(r.shown, true);
      assert.ok(inside(r, L.W, L.H), `n=${n} ${JSON.stringify(r)}`);
      const coversNumber = r.left <= a.x + 1e-9 && a.x <= r.left + r.width + 1e-9 && r.top <= a.y + 1e-9 && a.y <= r.top + r.height + 1e-9;
      const centred = Math.abs(r.top + r.height / 2 - a.y) < 1e-9 || r.top === 0 || Math.abs(r.top + r.height - L.H) < 1e-9;
      assert.ok(coversNumber && centred, `label for ${n} must sit on the number (v=${vertical}, w=${screenW}) ${JSON.stringify({ r, a })}`);
    }
  }
});
