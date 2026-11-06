// Lobby browser QA against a real local Worker (wrangler dev) through raw CDP to a headless Chrome.
// Run: APP_URL=http://127.0.0.1:8789 node frontend/tests/browser/lobby-qa.cjs   (Chrome on CDP port 9354)
// Per viewport (phone portrait, phone landscape, desktop): the 18+ gate shows once and not again, the page
// never scrolls, both game cards and their Play buttons are inside the viewport without overlapping, Play on
// Gods of Power lands on /godsofpower (no gate again), Play on Roulette loads the felt, and both game headers
// carry the shared header's Lobby pill that leads back to /. Screenshots under QA_OUT, default <tmp>/lobby-qa.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), os = require('node:os');
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:8789', CDP_URL = process.env.CDP_URL || 'http://localhost:9354';
const OUT = process.env.QA_OUT || path.join(process.env.TMPDIR || os.tmpdir(), 'lobby-qa'); fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(w, h, { adult = true, url = `${APP_URL}/` } = {}) {
  const page = await (await fetch(`${CDP_URL}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map(), errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(m.error) : p.resolve(m.result); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description || ''));
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 1000 });
  await send('Emulation.setTouchEmulationEnabled', { enabled: w < 1000, maxTouchPoints: 5 });
  // Page.enable must come before this, or the pre-seed never runs. A fresh profile per viewport: the gate check needs a clean store.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: adult ? "localStorage.setItem('betics:adult:v1','1');" : "localStorage.removeItem('betics:adult:v1');" });
  await send('Page.navigate', { url });
  const waitFor = async (expression, label, tries = 200) => {
    for (let i = 0; i < tries; i++) { await sleep(100); if (await ev(expression).catch(() => false)) return true; }
    throw new Error(`timed out waiting for ${label}`);
  };
  const screenshot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); const file = path.join(OUT, `${name}.png`); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); return file; };
  const tap = async (selector) => {
    const p = await ev(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});if(!b||b.disabled)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    assert.ok(p, `${selector} present and enabled`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  };
  const rect = (selector) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,r:r.right,b:r.bottom,w:r.width,h:r.height}})()`);
  const location = () => ev('location.pathname');
  return { ws, send, ev, waitFor, screenshot, tap, rect, location, errors, close: async () => { await send('Page.close').catch(() => {}); ws.close(); } };
}

const CARD_PARTS = ['[data-testid="card-roulette"]', '[data-testid="card-godsofpower"]', '[data-testid="play-roulette"]', '[data-testid="play-godsofpower"]', '[data-testid="header-balance"]', '[data-testid="wallet-connect"]', '[data-testid="lobby-welcome"]', '[data-testid="lobby-how"]', '[data-testid="lobby-terms"]', '[data-testid="support-link"]'];
async function lobbyLayout(x, w, h, label) {
  await x.ev('document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))');
  const m = await x.ev(`(()=>{const sel=${JSON.stringify(CARD_PARTS)};const rects=sel.map(s=>{const e=document.querySelector(s);if(!e)return null;const r=e.getBoundingClientRect();return {s,x:r.x,y:r.y,r:r.right,b:r.bottom,w:r.width,h:r.height}});
    const boxes=rects.filter(r=>r&&!/play-|card-/.test(r.s)).concat(rects.filter(r=>r&&/card-/.test(r.s)));
    const overlaps=[];for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){const a=boxes[i],b=boxes[j];const ix=Math.min(a.r,b.r)-Math.max(a.x,b.x),iy=Math.min(a.b,b.b)-Math.max(a.y,b.y);if(ix>1&&iy>1)overlaps.push([a.s,b.s,Math.round(ix),Math.round(iy)])}
    const inside=(inner,outer)=>inner.x>=outer.x-0.5&&inner.y>=outer.y-0.5&&inner.r<=outer.r+0.5&&inner.b<=outer.b+0.5;
    const card=(id)=>rects.find(r=>r&&r.s.includes('card-'+id)),play=(id)=>rects.find(r=>r&&r.s.includes('play-'+id));
    const hit=(id)=>{const p=play(id);const e=document.elementFromPoint(p.x+p.w/2,p.y+p.h/2);return !!e&&document.querySelector('[data-testid="play-'+id+'"]').contains(e)};
    return {viewport:[innerWidth,innerHeight],scrollHeight:document.scrollingElement.scrollHeight,scrollWidth:document.scrollingElement.scrollWidth,rects,overlaps,
      playInCard:{roulette:inside(play('roulette'),card('roulette')),godsofpower:inside(play('godsofpower'),card('godsofpower'))},playHit:{roulette:hit('roulette'),godsofpower:hit('godsofpower')},
      layout:document.querySelector('.lobby').dataset.layout,wheel:!!document.querySelector('.lobby-wheel svg'),hero:(()=>{const i=document.querySelector('.lobby-collage-hero');return i?i.naturalWidth:0})(),
      playSize:{roulette:[Math.round(play('roulette').w),Math.round(play('roulette').h)],godsofpower:[Math.round(play('godsofpower').w),Math.round(play('godsofpower').h)]},gate:!!document.querySelector('[data-testid="age-gate"]')}})()`);
  assert.ok(m.scrollHeight <= h + 1, `${label}: page scrolls (scrollHeight ${m.scrollHeight} > ${h})`);
  assert.ok(m.scrollWidth <= w + 1, `${label}: page scrolls sideways (${m.scrollWidth} > ${w})`);
  for (const r of m.rects) { assert.ok(r, `${label}: a lobby element is missing`); assert.ok(r.x >= -0.5 && r.y >= -0.5 && r.r <= w + 0.5 && r.b <= h + 0.5, `${label}: ${r.s} outside the viewport ${JSON.stringify(r)}`); assert.ok(r.w > 0 && r.h > 0, `${label}: ${r.s} has no size`); }
  assert.deepEqual(m.overlaps, [], `${label}: lobby elements overlap`);
  assert.ok(m.playInCard.roulette && m.playInCard.godsofpower, `${label}: Play sits inside its card`);
  assert.ok(m.playHit.roulette && m.playHit.godsofpower, `${label}: Play is covered by another element`);
  for (const g of ['roulette', 'godsofpower']) assert.ok(m.playSize[g][1] >= 32 && m.playSize[g][0] >= 60, `${label}: Play ${g} too small to tap ${m.playSize[g]}`);
  assert.ok(m.wheel, `${label}: roulette card has its wheel`);
  assert.ok(m.hero > 0, `${label}: Gods of Power portrait loaded`);
  return m;
}

const VIEWPORTS = [[390, 844, 'portrait', 'phone portrait'], [844, 390, 'landscape', 'phone landscape'], [1280, 800, 'desktop', 'desktop']];
(async () => {
  const results = [];
  for (const [w, h, expected, label] of VIEWPORTS) {
    console.log(`== ${label} ${w}x${h}`);
    // 1. First visit: the 18+ gate shows; after Continue it is gone and stays gone on the next load.
    let x = await open(w, h, { adult: false });
    await x.waitFor('!!document.querySelector("[data-testid=\\"age-gate\\"]")', 'age gate');
    await x.screenshot(`lobby-${w}x${h}-gate`);
    const gateRect = await x.rect('[data-testid="age-gate"] .age-gate');
    assert.ok(gateRect.x >= 0 && gateRect.r <= w + 0.5 && gateRect.y >= 0 && gateRect.b <= h + 0.5, `${label}: age gate inside the viewport`);
    await x.tap('[data-testid="age-check"]'); await x.tap('[data-testid="age-continue"]');
    await sleep(300);
    assert.equal(await x.ev('!!document.querySelector("[data-testid=\\"age-gate\\"]")'), false, `${label}: gate closes`);
    assert.equal(await x.ev("localStorage.getItem('betics:adult:v1')"), '1');
    await x.close();
    // 2. Accepted: no gate, one screen, cards and Play buttons in place.
    x = await open(w, h);
    await x.waitFor('!!document.querySelector("[data-testid=\\"play-godsofpower\\"]") && /\\$TICS|\\.\\.\\./.test(document.querySelector("[data-testid=\\"header-balance\\"]")?.textContent||"")', 'lobby');
    await x.waitFor('!/\\.\\.\\./.test(document.querySelector("[data-testid=\\"header-balance\\"]").textContent)', 'balance', 100).catch(() => {});
    await sleep(400);
    assert.equal(await x.ev('!!document.querySelector("[data-testid=\\"age-gate\\"]")'), false, `${label}: no gate once accepted`);
    const m = await lobbyLayout(x, w, h, label);
    assert.equal(m.layout, expected, `${label}: layout class`);
    const shot = await x.screenshot(`lobby-${w}x${h}`);
    console.log('  layout', m.layout, 'scroll', m.scrollHeight, 'play', JSON.stringify(m.playSize), 'balance', await x.ev('document.querySelector("[data-testid=\\"header-balance\\"]").textContent'), shot);
    // Hover: the card lifts (transform only).
    if (w >= 1000) {
      const c = await x.rect('[data-testid="card-roulette"]');
      await x.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x + c.w / 2, y: c.y + c.h / 2 }); await sleep(350);
      const t = await x.ev('getComputedStyle(document.querySelector("[data-testid=\\"card-roulette\\"]")).transform');
      assert.notEqual(t, 'none', `${label}: card hover motion`);
      await x.screenshot(`lobby-${w}x${h}-hover`);
    }
    // 3. Play on Gods of Power: /godsofpower, no gate, Lobby pill back to /.
    await x.tap('[data-testid="play-godsofpower"]');
    await x.waitFor('location.pathname === "/godsofpower" && !!document.querySelector("[data-testid=\\"slot-spin\\"]")', 'slot page');
    assert.equal(await x.ev('!!document.querySelector("[data-testid=\\"age-gate\\"]")'), false, `${label}: no gate on the slot after the lobby`);
    const slotPill = await x.rect('[data-testid="lobby-link"]');
    assert.ok(slotPill && slotPill.w > 0 && slotPill.r <= w + 0.5 && slotPill.b <= h + 0.5, `${label}: slot Lobby pill inside the viewport`);
    const slotOverlap = await x.ev(`(()=>{const p=document.querySelector('[data-testid="lobby-link"]').getBoundingClientRect();const hit=document.elementFromPoint(p.x+p.width/2,p.y+p.height/2);return !!hit&&document.querySelector('[data-testid="lobby-link"]').contains(hit)})()`);
    assert.ok(slotOverlap, `${label}: slot Lobby pill is tappable`);
    await x.screenshot(`slot-${w}x${h}-lobby-pill`);
    await x.tap('[data-testid="lobby-link"]');
    await x.waitFor('location.pathname === "/" && !!document.querySelector("[data-testid=\\"play-roulette\\"]")', 'back in the lobby');
    // 4. Play on Roulette: /roulette loads the felt and its header balance; Lobby pill back to /.
    await x.tap('[data-testid="play-roulette"]');
    await x.waitFor('location.pathname === "/roulette" && !!document.querySelector("[data-testid=\\"header-balance\\"]") && /Next lock[^a-f0-9]*[a-f0-9]{8}/.test(document.body.innerText)', 'roulette page');
    assert.equal(await x.ev('!!document.querySelector("[data-testid=\\"age-gate\\"]")'), false, `${label}: no gate on roulette after the lobby`);
    const pill = await x.ev(`(()=>{const a=document.querySelector('[data-testid="lobby-link"]');if(!a)return null;const r=a.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      const others=['.brand-logo img','.commitment-button','[data-testid="header-balance"]','[data-testid="wallet-connect"]','[data-testid="profile-button"]','[data-testid="mode-switch"]','[data-testid="header-mute"]'].flatMap(s=>[...document.querySelectorAll(s)]).map(e=>{const o=e.getBoundingClientRect();const ix=Math.min(r.right,o.right)-Math.max(r.x,o.x),iy=Math.min(r.bottom,o.bottom)-Math.max(r.y,o.y);return ix>1&&iy>1?e.className||e.tagName:null}).filter(Boolean);
      const header=document.querySelector('header').getBoundingClientRect();
      return {x:r.x,y:r.y,r:r.right,b:r.bottom,w:r.width,h:r.height,href:a.getAttribute('href'),tappable:!!hit&&a.contains(hit),others,inHeader:r.y>=header.y-0.5&&r.bottom<=header.bottom+0.5,headerH:Math.round(header.height),scrollHeight:document.scrollingElement.scrollHeight}})()`);
    assert.ok(pill, `${label}: roulette Lobby pill present`);
    assert.equal(pill.href, '/');
    assert.ok(pill.r <= w + 0.5 && pill.b <= h + 0.5 && pill.x >= -0.5, `${label}: roulette Lobby pill inside the viewport ${JSON.stringify(pill)}`);
    assert.deepEqual(pill.others, [], `${label}: roulette Lobby pill collides with header controls`);
    assert.ok(pill.tappable, `${label}: roulette Lobby pill tappable`);
    if (w < 1000) assert.ok(pill.scrollHeight <= h + 1, `${label}: roulette page scrolls with the pill (${pill.scrollHeight})`);
    await x.screenshot(`roulette-${w}x${h}-lobby-pill`);
    console.log('  roulette pill', JSON.stringify(pill));
    await x.tap('[data-testid="lobby-link"]');
    await x.waitFor('location.pathname === "/" && !!document.querySelector("[data-testid=\\"play-roulette\\"]")', 'back in the lobby from roulette');
    assert.deepEqual(x.errors.filter((e) => !/ResizeObserver/.test(e)), [], `${label}: page errors`);
    await x.close();
    results.push(label);
  }
  console.log('lobby-qa OK', results.join(', '), 'screenshots in', OUT);
})().catch((e) => { console.error('lobby-qa FAILED', e); process.exit(1); });
