import test from 'node:test';
import assert from 'node:assert/strict';
import { winTier, celebrationTiming, particleBudget, countEase } from '../src/winCelebration.js';

test('win tiers scale with payout relative to stake', () => {
  assert.equal(winTier(150, 100).id, 'win');
  assert.equal(winTier(300, 100).id, 'nice');
  assert.equal(winTier(3600, 100).id, 'mega');   // straight-up hit with one chip
  assert.equal(winTier(54000, 18500).id, 'nice');
  assert.equal(winTier(1200, 100).id, 'big');
});

test('autoplay runs the celebration faster; phones get a smaller particle budget', () => {
  const t = winTier(3600, 100);
  assert.ok(celebrationTiming(t, 0.4).countMs < celebrationTiming(t, 1).countMs);
  const phone = particleBudget(t, { mobile: true }), desk = particleBudget(t);
  assert.ok(phone.coins <= 24 && phone.coins < desk.coins && phone.flyingChips < desk.flyingChips);
  assert.equal(particleBudget(t, { reducedMotion: true }).coins, 0);
});

test('count-up eases out and ends exactly on the total', () => {
  assert.equal(countEase(0), 0); assert.equal(countEase(1), 1);
  assert.ok(countEase(0.5) > 0.5);
});
