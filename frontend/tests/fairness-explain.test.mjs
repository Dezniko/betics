import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { explainOutcome } from '../src/fairnessClient.js';
import { deriveOutcome } from '../../backend/src/core/fairness.js';

// The step-by-step values shown to players (for checking on any third-party
// HMAC tool and calculator) must reproduce the real outcome exactly.
test('plain-language calculation steps reproduce the backend outcome', async () => {
  for (let i = 0; i < 60; i++) {
    const serverSeed = `secret-${i}-${'x'.repeat(i % 7)}`, clientSeed = `player's seed:${i.toString(16).padStart(64, 'a')}`;
    const steps = await explainOutcome({ serverSeed, clientSeed, nonce: 0, max: 37 });
    assert.equal(steps.pocket, deriveOutcome(serverSeed, clientSeed, 0, 37));
    assert.equal(steps.message, `${clientSeed}:0:${steps.counter}`);
    assert.equal(steps.hmacHex, createHmac('sha256', serverSeed).update(steps.message).digest('hex'));
    assert.equal(steps.first8, steps.hmacHex.slice(0, 8));
    assert.equal(steps.value, parseInt(steps.first8, 16));
    assert.equal(steps.limit, Math.floor(0xffffffff / 37) * 37);
    assert.ok(steps.value < steps.limit);
    assert.equal(steps.value % 37, steps.pocket);
  }
});
