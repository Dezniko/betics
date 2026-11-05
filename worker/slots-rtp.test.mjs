import test from 'node:test';
import assert from 'node:assert/strict';
import { analyse } from '../scripts/slots-rtp.mjs';
import { SLOT_MATH } from '../backend/src/games/slotsMath.js';

test('published Gods of Power maths pays back 92.0% (exact, within 0.05)', () => {
  const a = analyse(SLOT_MATH);
  assert.ok(Math.abs(a.exact * 100 - SLOT_MATH.rtp) <= 0.05, `exact ${a.exact * 100}`);
  assert.ok(a.exact < 1, 'house edge must stay positive');
  assert.ok(a.triggerOneIn > 100 && a.triggerOneIn < 200, `free spins 1 in ${a.triggerOneIn}`);
});
test('no reel can show two scatters at once', () => {
  for (const strip of SLOT_MATH.strips) for (let s = 0; s < strip.length; s++) {
    let k = 0; for (let r = 0; r < 3; r++) if (strip[(s + r) % strip.length] === 'S') k++;
    assert.ok(k <= 1);
  }
});
