import test from 'node:test';
import assert from 'node:assert/strict';
import { maxPayoutUnits, setPayoutTable, straightMultiplier } from '../src/rouletteRules.js';
import { maxPayoutCents } from '../../backend/src/games/roulette.js';
import { ROULETTE_MATH } from '../../backend/src/games/rouletteMath.js';

test('the table limit maths in the browser matches the server for mixed bets', () => {
  setPayoutTable(ROULETTE_MATH.standard.multipliers);
  const sets = [
    [{ type: 'straight', value: 17, amountCents: 69444 }],
    [{ type: 'straight', value: 17, amountCents: 10000 }, { type: 'straight', value: 18, amountCents: 10000 }, { type: 'red', amountCents: 50000 }],
    [{ type: 'split', value: [17, 18], amountCents: 20000 }, { type: 'dozen2', amountCents: 30000 }, { type: 'odd', amountCents: 5000 }],
    [{ type: 'corner', value: [1, 2, 4, 5], amountCents: 12345 }, { type: 'column1', amountCents: 999 }],
  ];
  for (const bets of sets) assert.equal(maxPayoutUnits(bets), maxPayoutCents(bets, ROULETTE_MATH.standard), JSON.stringify(bets));
  assert.equal(straightMultiplier(), 36);
  setPayoutTable(ROULETTE_MATH.straight34.multipliers);
  assert.equal(maxPayoutUnits(sets[0]), maxPayoutCents(sets[0], ROULETTE_MATH.straight34));
  assert.equal(straightMultiplier(), 35);
  setPayoutTable(null);
});
