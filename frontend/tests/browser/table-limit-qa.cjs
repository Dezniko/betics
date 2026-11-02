// Table limit in the browser: chips that would let one spin pay more than the casino can cover
// right now are refused while placing them, with the max bet on one number in plain words.
// APP_URL=http://127.0.0.1:8789 QA_OUT=dir node frontend/tests/browser/table-limit-qa.cjs
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { open, sleep } = require('./mobile-controls-qa.cjs');
const APP = process.env.APP_URL || 'http://127.0.0.1:8789';
const OUT = process.env.QA_OUT || '/tmp/table-limit-qa'; fs.mkdirSync(OUT, { recursive: true });
const cents = (t) => Math.round(Number(String(t).replace(/[^0-9.]/g, '')) * 100);
(async () => {
  await sleep(21000); // the server caches the reserve figure for 20 seconds
  const reserve = await (await fetch(`${APP}/api/casino/reserve`)).json();
  assert.equal(reserve.live, true, 'reserve figure is live');
  assert.ok(reserve.maxStraightUnits > 0);
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const x = await open(w, h);
    await sleep(1500);
    // The reserve shows the max bet on one number.
    if (w > 900) assert.equal(cents(await x.ev(`document.querySelector('[data-testid=casino-reserve-maxstraight]')?.textContent||''`)), reserve.maxStraightUnits);
    // Pick the biggest chip that still fits under the per-number limit a few times, then keep adding 1K chips.
    await x.ev(`document.querySelector('button[title^="1K $TICS chip"]').click()`);
    let refused = null;
    for (let i = 0; i < 400 && !refused; i++) {
      await x.tap('[data-zone-key="straight:17"]');
      refused = await x.ev(`(()=>{const e=document.querySelector('.game-error');return e&&/most you can bet on one number/.test(e.textContent)?e.textContent:null})()`);
    }
    assert.ok(refused, 'the table refused the chip that broke the limit');
    const onNumber = await x.ev(`[...document.querySelectorAll('[data-bet-key]')].filter(e=>e.dataset.betKey.startsWith('straight:17')).map(e=>Number(e.dataset.amount||0))[0]||0`);
    const staked = cents(await x.ev(`[...document.querySelectorAll('*')].map(e=>e.childElementCount===0?e.textContent:'').find(t=>/in play$/.test(t.trim()))||'0'`));
    assert.ok(staked > 0 && staked * 36 <= reserve.maxWinUnits, `on the number ${staked} pays ${staked * 36} <= ${reserve.maxWinUnits}`);
    assert.ok((staked + 100000) * 36 > reserve.maxWinUnits, 'one more 1K chip would break the limit');
    assert.match(refused, /Table limit/i);
    assert.ok(refused.includes((reserve.maxStraightUnits / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })), refused);
    await x.shot(`table-limit-${w}`);
    console.log('PASS', w, h, { staked, maxWin: reserve.maxWinUnits, maxStraight: reserve.maxStraightUnits, onNumber });
    await x.close?.();
  }
  console.log('TABLE LIMIT QA PASSED');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
