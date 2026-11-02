import test from 'node:test';
import assert from 'node:assert/strict';
import { chefPocketUrl, chefLockUrl, pocketRecipe } from '../src/fairnessLinks.js';
test('CyberChef links carry the exact key, message and recipe', () => {
  const key = "ab'c\\d", msg = "lucky's:7:0";
  const u = chefPocketUrl(key, msg);
  assert.ok(u.startsWith('https://gchq.github.io/CyberChef/#recipe='));
  const [, rec, inp] = u.match(/#recipe=(.*)&input=(.*)$/);
  assert.equal(decodeURIComponent(rec), pocketRecipe(key));
  assert.ok(pocketRecipe(key).includes("'string':'ab\\'c\\\\d'"));
  assert.equal(Buffer.from(decodeURIComponent(inp), 'base64').toString('utf8'), msg);
  const l = chefLockUrl('k1');
  assert.equal(Buffer.from(decodeURIComponent(l.split('&input=')[1]), 'base64').toString(), 'k1');
});
