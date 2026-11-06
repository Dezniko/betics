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

// ---- the shared header on phones: no page-level header CSS fights the shared one ----
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const css = (f) => fs.readFileSync(path.join(here, '..', 'src', f), 'utf8');

test('the old per-page header rules are gone, so the shared header lays itself out alone', () => {
  const index = css('index.css');
  for (const gone of ['.mobile-game header', '.phone-portrait header', '.phone-portrait .header-right', '.mobile-history-trigger', '.demo-refill', '.sound-toolbar', '.inbox-bell', '.lobby-link {', '.history-open', '.fairness-label', '.sound-dialog']) {
    assert.ok(!index.includes(gone), `index.css still has ${gone}`);
  }
  assert.ok(!/\.lobby-header|\.lobby-brand|\.lobby-balance/.test(css('lobby.css')), 'lobby.css has no header rules');
  assert.ok(!/\.slot-header|\.slot-brand|\.slot-balance|\.slot-lock|\.slot-link/.test(css('slots/slots.css')), 'slots.css has no header rules');
  assert.match(index, /\.mobile-game \.history-panel \{ display: none; \}/, 'the desktop history panel stays hidden on phones (the sheet shows it)');
});

test('the shared header: two rows on portrait phones, one row otherwise, the logo never below its floor', () => {
  const header = css('gameHeader.css');
  assert.match(header, /\.gh-portrait \.brand-logo img \{ height: auto; width: auto; max-height: 26px; max-width: 100%; \}/, 'portrait: the logo scales down instead of sliding under its neighbours');
  assert.match(header, /\.gh-landscape \.gh-logo, \.gh-desktop \.gh-logo \{ flex: 0 0 auto; \}/, 'one row layouts never squeeze the logo');
  assert.match(header, /\.gh-portrait \.gh-profile\.connected \.wallet-chip-text \{ display: none; \}/, 'portrait: avatar only, the text stays in the DOM for the tests');
  assert.match(header, /\.gh-portrait \.wc-long \{ display: none; \} \.gh-portrait \.wc-short \{ display: inline; \}/);
  assert.match(header, /@media \(max-width: 374px\)/, 'narrow phones tighten the pills');
  assert.ok(!/commitment-label \{ display: none/.test(header), 'Next lock stays readable text on every phone (the suites wait for it)');
});
