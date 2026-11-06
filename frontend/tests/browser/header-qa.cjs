// Shared header QA against a real local Worker (wrangler dev) through raw CDP to a headless Chrome.
// Run: APP_URL=http://127.0.0.1:8789 node frontend/tests/browser/header-qa.cjs   (Chrome on CDP port 9354)
// For each of /, /roulette and /godsofpower at seven viewports (portrait phones 320 to 430, a landscape
// phone, a tablet and a desktop): pass the 18+ gate, no page scroll, every header item inside the
// viewport, no two header items overlapping, the logo never below 60 px wide, the header items in the
// same order on all three pages, the guest's Connect wallet pill and person icon are two controls with a
// gap, the Real/Demo switch shows for a guest and tapping Real opens the connect notice, the balance label
// reads DEMO BALANCE, the bell has no badge, the profile sheet (not connected) opens inside the viewport
// with the page locked and the three tabs, closes on Escape; then the same measurements with a connected
// header (a mocked /api/wallet/me, a long balance, REAL BALANCE, 3 unread messages: the newest pops up and
// is marked seen, the bell badge counts the other 2; tapping the bell opens the sheet on Messages and the
// badge goes). Screenshots under QA_OUT, default <tmp>/header-qa.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), os = require('node:os');
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:8789', CDP_URL = process.env.CDP_URL || 'http://localhost:9354';
const OUT = process.env.QA_OUT || path.join(process.env.TMPDIR || os.tmpdir(), 'header-qa'); fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIEWPORTS = [[320, 740], [360, 800], [390, 844], [430, 932], [844, 390], [1024, 768], [1280, 800]];
const PAGES = [['lobby', '/'], ['roulette', '/roulette'], ['slot', '/godsofpower']];
const ADDR = '0x13bd1483a1b2c3d4e5f60718293a4b5c5421b784';
// A connected header without a wallet: the profile and session calls answer as a funded wallet would.
const CONNECTED_MOCK = `(()=>{const f=window.fetch;const j=(v)=>new Response(JSON.stringify(v),{status:200,headers:{'content-type':'application/json'}});
  const profile={address:${JSON.stringify(ADDR)},chainId:1,realEnabled:true,hasDeposited:true,withdrawalsOpen:true,deposits:[],withdrawals:[],firstConnectedAt:'2026-10-28 10:00:00',minDepositCents:100000,minWithdrawalCents:1500000,withdrawalFeeCents:50000,termsAcceptedAt:'2026-10-28 10:00:00',email:null,emailConsent:false};
  window.fetch=async function(input,init){const u=new URL(String(input&&input.url||input),location.href);const p=u.pathname;
    if(p==='/api/wallet/me')return j(profile);
    if(p==='/api/inbox')return j({messages:[1,2,3].map(i=>({id:900+i,title:'Message '+i,body:'Body of message '+i,seen:false,buttonUrl:null,buttonLabel:null})),unseen:3});
    if(p.startsWith('/api/inbox/'))return j({ok:true});
    if(p==='/api/wallet'||p==='/api/session'){const r=await f.apply(this,arguments);let d={};try{d=await r.clone().json()}catch{}return j({...d,balanceCents:123456789,realTicsCents:98765432199,demoAllowed:true})}
    return f.apply(this,arguments)};})();`;

async function open(w, h, { url, mock = false } = {}) {
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
  // Page.enable must come before this, or the pre-seed never runs.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('betics:adult:v1','1');localStorage.setItem('betics:mode:v1','real');${mock ? CONNECTED_MOCK : ''}` });
  await send('Page.navigate', { url });
  const waitFor = async (expression, label, tries = 200) => {
    for (let i = 0; i < tries; i++) { await sleep(100); if (await ev(expression).catch(() => false)) return true; }
    throw new Error(`timed out waiting for ${label}`);
  };
  const screenshot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); const file = path.join(OUT, `${name}.png`); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); return file; };
  const click = async (selector) => {
    const p = await ev(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});if(!b||b.disabled)return null;b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    assert.ok(p, `${selector} present and enabled`);
    await sleep(80);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  };
  const key = async (k) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: k === 'Escape' ? 27 : 0 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: k === 'Escape' ? 27 : 0 }); };
  return { ws, send, ev, waitFor, screenshot, click, key, errors, close: async () => { await send('Page.close').catch(() => {}); ws.close(); } };
}

const READY = {
  lobby: '!!document.querySelector("[data-testid=\\"play-godsofpower\\"]") && /\\$TICS/.test(document.querySelector("[data-testid=\\"header-balance\\"]")?.textContent||"")',
  roulette: '/Next lock[^a-f0-9]*[a-f0-9]{8}/.test(document.body.innerText) && /\\$TICS/.test(document.querySelector("[data-testid=\\"header-balance\\"]")?.textContent||"")',
  slot: '!!document.querySelector("[data-testid=\\"slot-spin\\"]") && /Next lock[^a-f0-9]*[a-f0-9]{8}/.test(document.body.innerText) && /\\$TICS/.test(document.querySelector("[data-testid=\\"header-balance\\"]")?.textContent||"")',
};

// Every header item on screen, inside the viewport, none overlapping another, logo wide enough, no page scroll.
const MEASURE = `(()=>{const items=[...document.querySelectorAll('header [data-header-item]')].filter(e=>e.checkVisibility()).map(e=>{const r=e.getBoundingClientRect();return {id:e.dataset.headerItem,testid:e.dataset.testid||e.querySelector('[data-testid]')?.dataset.testid||'',l:r.left,t:r.top,r:r.right,b:r.bottom,w:r.width,h:r.height}});
  const over=[];for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++){const a=items[i],b=items[j];const ix=Math.min(a.r,b.r)-Math.max(a.l,b.l),iy=Math.min(a.b,b.b)-Math.max(a.t,b.t);if(ix>0.5&&iy>0.5)over.push(a.id+' x '+b.id+' '+Math.round(ix)+'x'+Math.round(iy))}
  const outside=items.filter(a=>a.l<-0.5||a.t<-0.5||a.r>innerWidth+0.5||a.b>innerHeight+0.5).map(a=>a.id);
  const logo=document.querySelector('header .brand-logo img').getBoundingClientRect();
  const header=document.querySelector('header').getBoundingClientRect();
  const connect=document.querySelector('[data-testid=wallet-connect]'),chip=document.querySelector('[data-testid=wallet-chip]');
  return {items,over,outside,logoW:logo.width,headerH:header.height,headerW:header.width,order:items.map(i=>i.id),scrollH:document.scrollingElement.scrollHeight,scrollW:document.scrollingElement.scrollWidth,
    pill:(connect||chip)?.innerText.trim()||null,chipText:chip?.textContent||null,balance:document.querySelector('[data-testid=header-balance]').textContent,mode:document.querySelector('[data-testid=mode-switch]')?.dataset.mode||null,
    label:document.querySelector('[data-testid=header-balance-label]')?.textContent||null,bell:!!document.querySelector('[data-testid=header-bell]'),badge:document.querySelector('[data-testid=bell-count]')?.textContent||null,
    guest:(()=>{const p=document.querySelector('[data-testid=profile-button]');if(!connect||!p)return null;const a=connect.getBoundingClientRect(),b=p.getBoundingClientRect();return {gap:b.left-a.right,connectH:a.height,connectW:a.width,personW:b.width,personH:b.height,personLast:b.right>a.right}})(),
    labelFits:(()=>{const l=document.querySelector('[data-testid=header-balance-label]'),blk=document.querySelector('[data-testid=header-balance-block]');if(!l)return false;const a=l.getBoundingClientRect(),b=blk.getBoundingClientRect();return l.scrollWidth<=l.clientWidth+0.5&&a.left>=b.left-0.5&&a.right<=b.right+0.5})()}})()`;

async function measure(x, w, h, label, page) {
  await x.ev('document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))');
  await sleep(150);
  const m = await x.ev(MEASURE);
  assert.ok(m.scrollH <= h + 1, `${label}: page scrolls (${m.scrollH} > ${h})`);
  assert.ok(m.scrollW <= w + 1, `${label}: page scrolls sideways (${m.scrollW} > ${w})`);
  assert.deepEqual(m.outside, [], `${label}: header items outside the viewport ${JSON.stringify(m.items)}`);
  assert.deepEqual(m.over, [], `${label}: header items overlap ${JSON.stringify(m.items)}`);
  assert.ok(m.logoW >= 60, `${label}: logo squeezed to ${m.logoW}px`);
  assert.ok(m.items.every((i) => i.w > 0 && i.h > 0), `${label}: an item has no size`);
  assert.ok(m.headerW <= (page === 'roulette' && w >= 1100 ? 1280 : 1100) + 1, `${label}: header too wide (${m.headerW})`);
  return m;
}

(async () => {
  const orders = {};
  for (const [w, h] of VIEWPORTS) {
    for (const [page, route] of PAGES) {
      const label = `${page} ${w}x${h}`;
      // 1. guest
      let x = await open(w, h, { url: APP_URL + route });
      await x.waitFor(READY[page], label);
      const m = await measure(x, w, h, label, page);
      assert.equal(m.pill, w < 1000 && !(w > h) ? 'Connect' : 'Connect wallet', `${label}: guest pill text`);
      assert.equal(m.mode, 'demo', `${label}: a guest sees the Real/Demo switch on Demo`);
      assert.equal(m.label, 'DEMO BALANCE', `${label}: guest balance label`);
      assert.ok(m.labelFits, `${label}: the balance label is clipped`);
      assert.ok(m.guest && m.guest.gap >= 6, `${label}: Connect pill and person icon need a 6 px gap ${JSON.stringify(m.guest)}`);
      assert.ok(m.guest.connectH >= 28 && m.guest.personLast && Math.abs(m.guest.personW - m.guest.personH) < 1, `${label}: Connect pill tappable, round person icon last ${JSON.stringify(m.guest)}`);
      assert.ok(m.bell && m.badge === null, `${label}: bell present without a badge (${m.badge})`);
      (orders[`${w}x${h}`] ||= {})[page] = m.order;
      await x.screenshot(`${page}-${w}x${h}-guest`);
      // a guest tapping Real starts the connect flow: the connect notice opens, the mode stays Demo
      await x.click('[data-testid=mode-real]');
      await x.waitFor('!!document.querySelector("[data-testid=connect-notice]")', `${label} connect notice from Real`);
      assert.equal(await x.ev('document.querySelector("[data-testid=mode-switch]").dataset.mode'), 'demo', `${label}: Real as a guest must not switch`);
      assert.ok(!(await x.ev('!!document.querySelector("w3m-modal.open")')), `${label}: no wallet modal before Continue`);
      await x.screenshot(`${page}-${w}x${h}-guest-real`);
      await x.key('Escape');
      await x.waitFor('!document.querySelector("[data-testid=connect-notice]")', `${label} connect notice closed`);
      await sleep(300);
      // 2. profile sheet for a guest
      await x.click('[data-testid=profile-button]');
      await x.waitFor('!!document.querySelector("[data-testid=wallet-panel]")', `${label} sheet`);
      await sleep(600);
      const sheet = await x.ev(`(()=>{const e=document.querySelector('[data-testid=wallet-panel]'),r=e.getBoundingClientRect();return {l:r.left,t:r.top,r:r.right,b:r.bottom,locked:document.body.style.position==='fixed',tabs:['wallet','history','fairness'].map(t=>!!document.querySelector('[data-testid=tab-'+t+']')),connect:!!document.querySelector('[data-testid=sheet-connect]'),sound:!!document.querySelector('[data-testid=profile-sound]'),inertMain:document.querySelector('main')?.inert===true,wide:[...e.querySelectorAll('*')].filter(c=>c.getBoundingClientRect().right>r.right+1).map(c=>c.className).slice(0,5),text:e.innerText}})()`);
      assert.ok(sheet.l >= -0.5 && sheet.t >= -0.5 && sheet.r <= w + 0.5 && sheet.b <= h + 0.5, `${label}: sheet outside the viewport ${JSON.stringify(sheet)}`);
      assert.ok(sheet.locked, `${label}: body not locked behind the sheet`);
      assert.deepEqual(sheet.tabs, [true, true, true], `${label}: tabs`);
      assert.ok(sheet.connect && sheet.sound && sheet.inertMain, `${label}: sheet content ${JSON.stringify(sheet)}`);
      assert.deepEqual(sheet.wide, [], `${label}: sheet content spills ${JSON.stringify(sheet.wide)}`);
      assert.ok(!/[\u2013\u2014]|\p{Extended_Pictographic}/u.test(sheet.text), `${label}: sheet copy has a long dash or emoji`);
      await x.screenshot(`${page}-${w}x${h}-sheet`);
      // tabs switch
      await x.click('[data-testid=tab-history]'); await sleep(200);
      assert.ok(await x.ev('!!document.querySelector("[data-testid=profile-history]")'), `${label}: History tab`);
      await x.click('[data-testid=tab-fairness]'); await sleep(200);
      assert.ok(await x.ev('!!document.querySelector("[data-testid=profile-fairness]")'), `${label}: Fairness tab`);
      await x.screenshot(`${page}-${w}x${h}-sheet-fairness`);
      // Sound row expands inline
      await x.click('[data-testid=profile-sound]'); await sleep(200);
      assert.ok(await x.ev('!!document.querySelector("#master-volume")'), `${label}: Sound row shows the volume slider`);
      await x.key('Escape');
      await x.waitFor('!document.querySelector("[data-testid=wallet-panel]")', `${label} sheet closed`);
      assert.notEqual(await x.ev('document.body.style.position'), 'fixed', `${label}: body still locked after Escape`);
      await x.close();
      // 3. connected header with a long balance
      x = await open(w, h, { url: APP_URL + route, mock: true });
      await x.waitFor(READY[page] + ' && !!document.querySelector("[data-testid=wallet-chip]")', `${label} connected`);
      // 3 unread: the newest pops up (and is marked seen), the bell counts the other two
      await x.waitFor('!!document.querySelector("[data-testid=inbox-popup]")', `${label} inbox popup`);
      await sleep(300);
      const c = await measure(x, w, h, `${label} connected`, page);
      assert.equal(c.chipText, '0x13bd...b784', `${label}: wallet-chip text is the short address`);
      assert.equal(c.mode, 'real', `${label}: connected header shows the Real/Demo switch in Real`);
      assert.equal(c.label, 'REAL BALANCE', `${label}: connected balance label`);
      assert.ok(c.labelFits, `${label}: the balance label is clipped`);
      assert.equal(c.badge, '2', `${label}: bell badge counts the unread messages not shown in the popup`);
      assert.ok(await x.ev('document.querySelector("[data-testid=header-bell]").classList.contains("lit")'), `${label}: bell lit`);
      const badgeBox = await x.ev('(()=>{const b=document.querySelector("[data-testid=header-bell]").getBoundingClientRect(),c=document.querySelector("[data-testid=bell-count]").getBoundingClientRect();return {w:c.width,h:c.height,topRight:c.right>b.right-b.width/2&&c.top<b.top+b.height/2,inside:c.left>=0&&c.top>=0&&c.right<=innerWidth}})()');
      assert.ok(badgeBox.w >= 14 && badgeBox.h >= 14 && badgeBox.topRight && badgeBox.inside, `${label}: badge geometry ${JSON.stringify(badgeBox)}`);
      await x.screenshot(`${page}-${w}x${h}-connected-popup`);
      await x.click('[data-testid=inbox-popup] .inbox-btn');
      await x.waitFor('!document.querySelector("[data-testid=inbox-popup]")', `${label} popup closed`);
      await sleep(300);
      assert.equal(await x.ev('document.querySelector("[data-testid=bell-count]")?.textContent||null'), '2', `${label}: badge after closing the popup`);
      assert.ok(/987,654,321\.99|987\.7M|987,654,322/.test(c.balance), `${label}: long balance shown (${c.balance})`);
      assert.ok(orders[`${w}x${h}`][page].filter((i) => i !== 'mode').join() === c.order.filter((i) => i !== 'mode').join(), `${label}: connected order differs`);
      await x.screenshot(`${page}-${w}x${h}-connected`);
      // the bell opens the sheet on Messages and marks them seen
      await x.click('[data-testid=header-bell]');
      await x.waitFor('!!document.querySelector("[data-testid=wallet-panel]") && !!document.querySelector("[data-testid=profile-messages-body]")', `${label} bell opens Messages`);
      await sleep(600);
      const bell = await x.ev('(()=>{const b=document.querySelector("[data-testid=profile-messages-body]"),p=document.querySelector("[data-testid=wallet-panel]").getBoundingClientRect(),r=b.getBoundingClientRect();return {visible:b.checkVisibility()&&r.height>20&&r.top>=p.top-0.5&&r.top<p.bottom,count:b.querySelectorAll(".inbox-card").length,badge:document.querySelector("[data-testid=bell-count]")?.textContent||null,note:document.querySelector("[data-testid=profile-messages] .profile-row-note")?.textContent||null,expanded:document.querySelector("[data-testid=profile-messages]").getAttribute("aria-expanded")}})()');
      assert.ok(bell.visible && bell.count === 3 && bell.badge === null && bell.expanded === 'true' && bell.note === '3', `${label}: Messages body ${JSON.stringify(bell)}`);
      await x.screenshot(`${page}-${w}x${h}-bell-sheet`);
      await x.key('Escape');
      await x.waitFor('!document.querySelector("[data-testid=wallet-panel]")', `${label} bell sheet closed`);
      await sleep(400);
      await x.click('[data-testid=wallet-chip]');
      await x.waitFor('!!document.querySelector("[data-testid=wallet-panel]") && !!document.querySelector("[data-testid=tab-topup]")', `${label} connected sheet`);
      await sleep(600);
      const cs = await x.ev(`(()=>{const e=document.querySelector('[data-testid=wallet-panel]'),r=e.getBoundingClientRect();return {inside:r.left>=-0.5&&r.top>=-0.5&&r.right<=innerWidth+0.5&&r.bottom<=innerHeight+0.5,address:document.querySelector('[data-testid=wallet-address]')?.textContent,disconnect:!!document.querySelector('[data-testid=wallet-disconnect]'),wide:[...e.querySelectorAll('*')].filter(c=>c.getBoundingClientRect().right>r.right+1).map(c=>c.className).slice(0,5)}})()`);
      assert.ok(cs.inside && cs.disconnect && cs.address === ADDR && !cs.wide.length, `${label}: connected sheet ${JSON.stringify(cs)}`);
      await x.screenshot(`${page}-${w}x${h}-connected-sheet`);
      await x.key('Escape');
      assert.deepEqual(x.errors.filter((e) => !/ResizeObserver/.test(e)), [], `${label}: page errors`);
      await x.close();
      console.log('  ok', label, 'order', m.order.join('>'), 'logo', Math.round(m.logoW), 'header', Math.round(m.headerH));
    }
    // Same order on all three pages (the common items).
    const o = orders[`${w}x${h}`];
    const common = (a, b) => a.filter((i) => b.includes(i)).join();
    assert.equal(common(o.lobby, o.roulette), common(o.roulette, o.lobby), `${w}x${h}: lobby and roulette order`);
    assert.equal(common(o.slot, o.roulette), common(o.roulette, o.slot), `${w}x${h}: slot and roulette order`);
    assert.equal(o.roulette.join(), o.slot.join(), `${w}x${h}: the two games show the same items`);
  }
  fs.writeFileSync(path.join(OUT, 'orders.json'), JSON.stringify(orders, null, 2));
  console.log('header-qa OK', VIEWPORTS.map(([w, h]) => `${w}x${h}`).join(', '), 'screenshots in', OUT);
})().catch((e) => { console.error('header-qa FAILED', e); process.exit(1); });
