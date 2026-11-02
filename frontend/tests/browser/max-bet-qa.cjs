// QA: 1 and 5 $TICS chips, max bet per spin blocks extra chips, no dollar text anywhere.
const fs = require('node:fs');
const APP = process.env.APP_URL || 'http://127.0.0.1:8789', CDP = 'http://localhost:9354';
const OUT = `${process.env.HOME}/.hermes/cache/scratch/chips-qa`; fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  for (const [w, h, name] of [[1440, 900, 'desktop'], [390, 844, 'portrait'], [844, 390, 'landscape']]) {
    const t = await (await fetch(CDP + '/json/new?about:blank', { method: 'PUT' })).json(); const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r)); let id = 0; const pend = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
    const send = (method, params = {}) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
    const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.result.value;
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 900 });
    if (w < 900) await send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await send('Network.clearBrowserCache');
    await send('Page.navigate', { url: APP }); await sleep(3500);
    await ev(`localStorage.setItem('betics:adult:v1','1'); localStorage.setItem('betics:mode:v1','demo'); location.reload()`); await sleep(5000);
    const chips = await ev(`[...document.querySelectorAll('.denom-button')].map(b=>{const r=b.getBoundingClientRect();return {t:b.title,x:r.x,r:r.right,vis:r.right<=innerWidth&&r.x>=0}})`);
    const titles = chips.map((c) => c.t.split(' chip')[0]);
    if (JSON.stringify(titles) !== JSON.stringify(['1 $TICS', '5 $TICS', '10 $TICS', '50 $TICS', '100 $TICS', '500 $TICS', '1K $TICS', '5K $TICS'])) throw new Error(`chips ${titles}`);
    if (!chips.every((c) => c.vis)) throw new Error(`${name}: a chip is off screen ${JSON.stringify(chips)}`);
    const noScroll = await ev(`document.documentElement.scrollHeight <= innerHeight + 1 || ${w >= 900}`);
    // Pick 5K and click red 11 times: the 11th chip would pass 50,000 $TICS.
    await ev(`[...document.querySelectorAll('.denom-button')].find(b=>b.title.startsWith('5K $TICS')).click()`); await sleep(300);
    // Red (an even-money bet stays well inside the table limit; a straight-up 5K chip would hit it first).
    const target = 'red';
    for (let i = 0; i < 11; i++) { await ev(`document.querySelector('[data-zone-key="red:undefined"]').click()`); await sleep(120); }
    await sleep(400);
    const text = await ev('document.body.innerText');
    const onTable = (text.match(/On table\s*\n?\s*([\d,.]+ \$TICS)/) || text.match(/([\d,.]+ \$TICS) in play/) || [])[1];
    const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.result.data, 'base64'));
    const ok = text.includes('The most you can bet on one spin is 50,000.00 $TICS.') && onTable === '50,000.00 $TICS' && !/\$\s?\d/.test(text) && noScroll;
    console.log(ok ? 'PASS' : 'FAIL', name, { target, onTable, maxMsg: text.includes('The most you can bet on one spin is 50,000.00 $TICS.'), dollar: /\$\s?\d/.test(text), noScroll });
    // Server message also in $TICS (bypass the UI limit with a direct request).
    if (name === 'desktop') {
      const msg = await ev(`(async()=>{const c=await (await fetch('/api/fairness/commitment')).json();const r=await fetch('/api/games/roulette/spin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'demo',bets:[{type:'red',amountCents:5000100}],requestId:crypto.randomUUID(),expectedCommitment:c,clientEntropy:[...crypto.getRandomValues(new Uint8Array(32))].map(b=>b.toString(16).padStart(2,'0')).join('')})});return (await r.json()).error})()`);
      console.log(/^The total bet can be at most 50,000\.00 \$TICS\.$/.test(msg) ? 'PASS' : 'FAIL', 'server message:', msg);
    }
    ws.close();
  }
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
