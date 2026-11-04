import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeFirstTouch, rememberFirstTouch, readFirstTouch } from '../src/firstTouch.js';

const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };

test('first touch: utm_source wins, else the referring host, never this site', () => {
  assert.deepEqual(computeFirstTouch('https://www.betics.io/?utm_source=Telegram&utm_campaign=launch', 'https://t.me/x'), { source: 'telegram', campaign: 'launch' });
  assert.deepEqual(computeFirstTouch('https://www.betics.io/terms', 'https://www.google.com/'), { source: 'google.com', campaign: null });
  assert.deepEqual(computeFirstTouch('https://www.betics.io/', 'https://betics.io/how-it-works'), { source: null, campaign: null });
  assert.deepEqual(computeFirstTouch('https://www.betics.io/', ''), { source: null, campaign: null });
  assert.deepEqual(computeFirstTouch('https://www.betics.io/', 'not a url'), { source: null, campaign: null });
});

test('first touch: saved once, later visits do not overwrite it', () => {
  const s = store();
  rememberFirstTouch(s, 'https://www.betics.io/?utm_source=x', '');
  rememberFirstTouch(s, 'https://www.betics.io/', 'https://www.google.com/');
  assert.deepEqual(readFirstTouch(s), { source: 'x', campaign: null });
  assert.equal(readFirstTouch(store()), null);
});
