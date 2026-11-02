import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLayout } from '../src/boardLayout.js';
import { validateBet } from '../../backend/src/games/roulette.js';

test('fitted horizontal felt fills mobile height without rotating labels or stretching chip transforms', () => {
  const base = makeLayout(false);
  for (const width of [286, 368, 401, 608, 674, 746]) for (const height of [160, 230, 328, 400]) {
    const scale = width / base.W;
    const layout = makeLayout(false, height / scale);
    assert.ok(Math.abs(layout.H * scale - height) <= 1, `${width}x${height} fits its allocated height`);
    assert.equal(layout.W, base.W);
    assert.equal(layout.vertical, false);
    assert.equal(new Set(layout.cells.map(c => c.n)).size, 37);
    assert.ok(layout.outside.every(o => !o.vertical));
    assert.equal(layout.rectOf[1].y, layout.rectOf[4].y);
    assert.ok(layout.rectOf[4].x > layout.rectOf[1].x);
    assert.equal(layout.chipSize, base.chipSize); // one uniform transform, no oval chips
  }
});

test('every mobile fitted hit zone remains physically valid and stays within the board', () => {
  for (const height of [250, 400, 650, 850]) {
    const layout = makeLayout(false, height);
    for (const z of layout.zones) {
      assert.doesNotThrow(() => validateBet({ type: z.type, value: z.value, amountCents: 100 }), z.title);
      assert.ok(z.x-z.w/2 >= -0.01 && z.x+z.w/2 <= layout.W+0.01, z.title+' fits horizontally');
      assert.ok(z.y-z.h/2 >= -0.01 && z.y+z.h/2 <= layout.H+0.01, z.title+' fits vertically');
    }
  }
});
