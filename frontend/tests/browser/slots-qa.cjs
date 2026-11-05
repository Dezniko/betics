// Gods of Power browser QA against a real local Worker (wrangler dev) through raw CDP to a headless Chrome.
// Run: APP_URL=http://127.0.0.1:8789 node frontend/tests/browser/slots-qa.cjs   (Chrome on CDP port 9354)
// Per viewport (phone portrait, phone landscape, desktop): the page never scrolls, every control is inside the
// viewport and none overlap, one demo spin settles to the balance the server returned, the pay table and the
// fairness sheet open (screenshots saved under QA_OUT, default <tmp>/slots-qa).
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), os = require('node:os');
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:8789', CDP_URL = process.env.CDP_URL || 'http://localhost:9354';
const OUT = process.env.QA_OUT || path.join(process.env.TMPDIR || os.tmpdir(), 'slots-qa'); fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const group = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const fmtTics = (units, decimals = 2) => { const abs = Math.abs(Math.round(units)); const whole = Math.floor(abs / 100), frac = String(abs % 100).padStart(2, '0'); return `${units < 0 ? '-' : ''}${group(whole)}${decimals ? `.${frac}` : ''} $TICS`; };
const fmtShort = (units) => (Math.round(units) % 100 === 0 ? fmtTics(units, 0) : fmtTics(units));

async function open(w, h) {
  const page = await (await fetch(`${CDP_URL}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map(), errors = [], responses = [];
  const bodies = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(m.error) : p.resolve(m.result); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description || ''));
    if (m.method === 'Network.responseReceived' && m.params.response.url.includes('/api/games/slots/spin')) responses.push(m.params.requestId);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 1100 });
  await send('Emulation.setTouchEmulationEnabled', { enabled: w < 1100, maxTouchPoints: 5 });
  // Page.enable must come before this, or the pre-seed never runs and the 18+ gate blocks every step.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('betics:adult:v1','1');" });
  await send('Page.navigate', { url: `${APP_URL}/slots` });
  const ready = async () => {
    for (let i = 0; i < 200; i++) {
      await sleep(100);
      const ok = await ev(`(()=>{const s=document.querySelector('[data-testid="slot-spin"]');return !!s&&!s.disabled&&/Next lock[^a-f0-9]*[a-f0-9]{8}/.test(document.body.innerText)})()`).catch(() => false);
      if (ok) return true;
    }
    return false;
  };
  const screenshot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); const file = path.join(OUT, `${name}.png`); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); return file; };
  const tap = async (selector) => {
    const p = await ev(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});if(!b||b.disabled)return null;b.scrollIntoView({block:'center',inline:'nearest'});const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    assert.ok(p, `${selector} present and enabled`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  };
  const lastSpinReply = async () => {
    const rid = responses.at(-1); if (!rid) return null;
    if (!bodies.has(rid)) { const r = await send('Network.getResponseBody', { requestId: rid }); bodies.set(rid, JSON.parse(r.body)); }
    return bodies.get(rid);
  };
  return { ws, send, ev, ready, screenshot, tap, errors, lastSpinReply, close: async () => { await send('Page.close').catch(() => {}); ws.close(); } };
}

const CONTROLS = ['[data-testid="slot-spin"]', '[data-testid="slot-bet"]', '[data-testid="slot-paytable-btn"]', '[data-testid="slot-fairness-btn"]', '[data-testid="slot-auto"]', '[data-testid="header-balance"]', '[data-testid="slot-lock"]', '[data-testid="slot-reels"]', '[data-testid="wallet-connect"]'];
async function layoutChecks(x, w, h, label) {
  const m = await x.ev(`(()=>{const sel=${JSON.stringify(CONTROLS)};const rects=sel.map(s=>{const e=document.querySelector(s);if(!e)return null;const r=e.getBoundingClientRect();return {s,x:r.x,y:r.y,r:r.right,b:r.bottom,w:r.width,h:r.height}});
    const overlaps=[];for(let i=0;i<rects.length;i++)for(let j=i+1;j<rects.length;j++){const a=rects[i],b=rects[j];if(!a||!b)continue;const ix=Math.min(a.r,b.r)-Math.max(a.x,b.x),iy=Math.min(a.b,b.b)-Math.max(a.y,b.y);if(ix>1&&iy>1)overlaps.push([a.s,b.s,Math.round(ix),Math.round(iy)])}
    const spin=document.querySelector('[data-testid="slot-spin"]'),sr=spin.getBoundingClientRect(),hit=document.elementFromPoint(sr.x+sr.width/2,sr.y+sr.height/2);
    return {viewport:[innerWidth,innerHeight],scrollHeight:document.scrollingElement.scrollHeight,scrollWidth:document.scrollingElement.scrollWidth,rects,overlaps,spinHit:!!hit&&spin.contains(hit),phase:document.querySelector('.slot-app').dataset.phase,tiles:document.querySelectorAll('.slot-reel [data-cell]').length,tile:(()=>{const t=document.querySelector('.slot-reel [data-cell]');if(!t)return [0,0];const r=t.getBoundingClientRect();return [Math.round(r.width),Math.round(r.height)]})()}})()`);
  assert.ok(m.scrollHeight <= h + 1, `${label}: page scrolls (scrollHeight ${m.scrollHeight} > ${h})`);
  assert.ok(m.scrollWidth <= w + 1, `${label}: page scrolls sideways (${m.scrollWidth} > ${w})`);
  for (const r of m.rects) { assert.ok(r, `${label}: a control is missing`); assert.ok(r.x >= -0.5 && r.y >= -0.5 && r.r <= w + 0.5 && r.b <= h + 0.5, `${label}: ${r.s} outside the viewport ${JSON.stringify(r)}`); assert.ok(r.w > 0 && r.h > 0, `${label}: ${r.s} has no size`); }
  assert.deepEqual(m.overlaps, [], `${label}: controls overlap`);
  assert.ok(m.spinHit, `${label}: Spin is covered by another element`);
  if (m.phase === 'idle') {
    assert.equal(m.tiles, 15, `${label}: 5 x 3 symbols visible`);
    assert.ok(m.tile[0] >= 36 && m.tile[1] >= 36, `${label}: symbols too small to read (${m.tile})`);
  }
  return m;
}

(async () => {
  const cases = [[390, 844], [844, 390], [1280, 800]];
  const report = [];
  for (const [w, h] of cases) {
    const label = `${w}x${h}`;
    const x = await open(w, h);
    assert.ok(await x.ready(), `${label}: page not ready (Spin enabled with a lock)`);
    await x.ev('document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))');
    const layout = await layoutChecks(x, w, h, label);
    const shots = [await x.screenshot(`${label}-idle`)];
    const balanceBefore = await x.ev(`document.querySelector('[data-testid="header-balance"]').textContent`);
    const stake = await x.ev(`Number(document.querySelector('[data-testid="slot-bet-value"]').dataset.stake)`);
    // One demo spin against the real Worker.
    await x.tap('[data-testid="slot-spin"]');
    let spinningShot = false, settled = false;
    for (let i = 0; i < 400; i++) {
      await sleep(100);
      const phase = await x.ev(`document.querySelector('.slot-app').dataset.phase`);
      if (!spinningShot && phase !== 'idle' && i >= 3) { spinningShot = true; shots.push(await x.screenshot(`${label}-spinning`)); await layoutChecks(x, w, h, `${label} while spinning`); }
      if (phase === 'idle' && i > 5) { settled = true; break; }
    }
    assert.ok(settled, `${label}: the round did not settle`);
    const reply = await x.lastSpinReply();
    assert.ok(reply && Number.isSafeInteger(reply.balanceAfterCents), `${label}: no spin reply captured`);
    assert.equal(reply.game, 'slots');
    assert.equal(reply.stake, stake);
    await sleep(350);
    const balanceAfter = await x.ev(`document.querySelector('[data-testid="header-balance"]').textContent`);
    const expected = w < h ? fmtShort(reply.balanceAfterCents) : fmtTics(reply.balanceAfterCents);
    assert.equal(balanceAfter, expected, `${label}: header balance after the spin`);
    assert.equal(reply.balanceAfterCents, reply.balanceBeforeCents - reply.stake + reply.totalPayoutCents, `${label}: server balance arithmetic`);
    const receiptSaved = await x.ev(`!!localStorage.getItem('betics:slot-receipt:'+${JSON.stringify(reply.requestId)})`);
    assert.ok(receiptSaved, `${label}: pre-bet receipt saved under betics:slot-receipt:<requestId>`);
    const lockOk = await x.ev(`document.querySelector('[data-testid="slot-lock"] .commitment-status').classList.contains('ok')`);
    assert.ok(lockOk, `${label}: the round was verified in the browser`);
    shots.push(await x.screenshot(`${label}-settled`));
    await layoutChecks(x, w, h, `${label} after the spin`);
    // Pay table.
    await x.tap('[data-testid="slot-paytable-btn"]'); await sleep(600);
    const pt = await x.ev(`(()=>{const p=document.querySelector('[data-testid="slot-paytable"]');if(!p)return null;const r=p.getBoundingClientRect();return {inside:r.x>=0&&r.y>=0&&r.right<=innerWidth+0.5&&r.bottom<=innerHeight+0.5,rows:p.querySelectorAll('[data-testid="paytable-rows"] .slot-pt-row[data-symbol]').length,lines:p.querySelectorAll('[data-testid="paytable-lines"] .slot-line-diagram').length,rtp:p.querySelector('[data-testid="paytable-rtp"]').textContent,text:p.textContent,bodyLocked:getComputedStyle(document.body).overflow==='hidden',scrolls:p.scrollHeight>p.clientHeight||p.clientHeight<=innerHeight}})()`);
    assert.ok(pt && pt.inside, `${label}: pay table inside the viewport`);
    assert.equal(pt.rows, 10, `${label}: 10 symbol rows`); assert.equal(pt.lines, 20, `${label}: 20 line diagrams`);
    assert.equal(pt.rtp, 'Payback 92.0%'); assert.ok(pt.text.includes('One round pays at most 2,000 times the bet.'));
    assert.ok(pt.bodyLocked, `${label}: background locked while the sheet is open`);
    shots.push(await x.screenshot(`${label}-paytable`));
    await x.tap('[data-testid="slot-paytable"] .fair-close'); await sleep(500);
    assert.ok(!(await x.ev(`!!document.querySelector('[data-testid="slot-paytable"]')`)), `${label}: pay table closes`);
    // Fairness sheet of the round just played.
    await x.tap('[data-testid="slot-fairness-btn"]'); await sleep(600);
    const fair = await x.ev(`(()=>{const p=document.querySelector('[data-testid="slot-fairness"]');if(!p)return null;const r=p.getBoundingClientRect();return {status:p.dataset.status,verdict:p.querySelector('[data-testid="slot-fair-verdict"]').textContent,inside:r.x>=0&&r.y>=0&&r.right<=innerWidth+0.5&&r.bottom<=innerHeight+0.5}})()`);
    assert.ok(fair && fair.inside, `${label}: fairness sheet inside the viewport`);
    assert.equal(fair.status, 'verified', `${label}: verdict ${fair.verdict}`);
    assert.ok(fair.verdict.includes('This round was fair'));
    await x.tap('[data-testid="drop-diy"]'); await sleep(300);
    const diy = await x.ev(`(()=>{const d=document.querySelector('[data-testid="slot-fair-diy"]');return d?d.textContent:''})()`);
    assert.ok(diy.includes(reply.fairness.serverSeed) && diy.includes(reply.fairness.serverSeedHash), `${label}: the seeds are shown`);
    shots.push(await x.screenshot(`${label}-fairness`));
    await x.tap('[data-testid="slot-fairness"] .fair-close'); await sleep(500);
    assert.ok(await x.ev(`!document.querySelector('[data-testid="slot-spin"]').disabled`), `${label}: ready to spin again`);
    const pageErrors = x.errors.filter((e) => !/ResizeObserver loop/.test(e));
    assert.deepEqual(pageErrors, [], `${label}: page errors`);
    report.push({ viewport: label, balanceBefore, balanceAfter, stake: reply.stake, payout: reply.totalPayoutCents, spins: reply.spins.length, freeSpins: reply.freeSpinsPlayed, tile: layout.tile, screenshots: shots });
    console.log('PASS', label, JSON.stringify({ stake: reply.stake, payout: reply.totalPayoutCents, spins: reply.spins.length, balanceAfter }));
    await x.close();
  }
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ api: APP_URL, at: new Date().toISOString(), cases: report }, null, 2));
  console.log('SLOTS QA PASSED', cases.length, 'viewports against', APP_URL, '(headless Chrome emulation, not physical hardware). Screenshots in', OUT);
})().catch((e) => { console.error(e); process.exit(1); });
