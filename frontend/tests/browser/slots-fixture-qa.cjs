// Gods of Power presentation QA with a CONTROLLED fixture (labelled as such): the spin reply is a real round
// computed by the engine from a seed chosen so the base spin starts free spins, served from an in-page
// fetch stub. The browser still verifies it against the lock (the fixture's lock is the real hash of that
// seed and the browser's randomness is pinned), so the page plays it exactly as a live round. Screenshots of
// the vault door, the free spin counter, a win and the round total go to QA_OUT (default <tmp>/slots-qa).
// Run: APP_URL=http://127.0.0.1:8789 node frontend/tests/browser/slots-fixture-qa.cjs
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), os = require('node:os'), crypto = require('node:crypto');
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:8789', CDP_URL = process.env.CDP_URL || 'http://localhost:9354';
const OUT = process.env.QA_OUT || path.join(process.env.TMPDIR || os.tmpdir(), 'slots-qa'); fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function makeRound(want) {
  const { playRound } = await import('../../../backend/src/games/slots.js');
  const { SLOT_MATH } = await import('../../../backend/src/games/slotsMath.js');
  const { makeUint32At } = await import('../../../backend/src/core/slotDraws.js');
  const entropy = '1b'.repeat(32), base = 'player', clientSeed = `${base}:${entropy}`, stake = 2000;
  for (let i = 0; i < 200000; i++) {
    const seed = `fixture-slots-${want}-${i}`;
    const round = playRound({ stake, math: SLOT_MATH, uint32At: makeUint32At(seed, clientSeed, 0) });
    const ok = want === 'free' ? round.freeSpinsAwarded > 0 && round.totalPayoutUnits > 0 : want === 'big' ? !round.freeSpinsAwarded && round.totalPayoutUnits >= 10 * stake : round.totalPayoutUnits > 0 && round.totalPayoutUnits < 2 * stake && !round.freeSpinsAwarded;
    if (!ok) continue;
    const before = 100000;
    return { entropy, base, reply: { requestId: '00000000-0000-4000-8000-000000000001', roundId: 1, game: 'slots', stake, spins: round.spins, freeSpinsAwarded: round.freeSpinsAwarded, freeSpinsPlayed: round.freeSpinsPlayed, capped: round.capped,
      totalStakeCents: stake, totalPayoutCents: round.totalPayoutUnits, mathId: SLOT_MATH.id, mode: 'demo', balanceBeforeCents: before, balanceAfterCents: before - stake + round.totalPayoutUnits,
      fairness: { serverSeed: seed, serverSeedHash: sha(seed), clientSeed, clientSeedBase: base, clientEntropy: entropy, nonce: 0, nextCommitment: { serverSeedHash: sha(`${seed}-next`), clientSeed: base, nonce: 0 } } } };
  }
  throw new Error('no fixture seed found');
}

function fixtureScript({ entropy, reply }) {
  return `(()=>{
    const audio=localStorage.getItem('noir:audio:v1');localStorage.clear();if(audio!==null)localStorage.setItem('noir:audio:v1',audio);
    localStorage.setItem('betics:adult:v1','1');
    const reply=${JSON.stringify(reply)};const entropy=${JSON.stringify(entropy)};
    window.qaFixture={label:'controlled fixture (not live data)',posts:0,savedBeforePost:false};
    const grv=crypto.getRandomValues.bind(crypto);
    crypto.getRandomValues=(arr)=>{if(arr instanceof Uint8Array&&arr.length===32){for(let i=0;i<32;i++)arr[i]=parseInt(entropy.slice(i*2,i*2+2),16);return arr;}return grv(arr);};
    crypto.randomUUID=()=>reply.requestId;
    const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json'}});
    const real=window.fetch.bind(window);
    window.fetch=async(url,opt={})=>{const p=String(url);if(!p.startsWith('/api/'))return real(url,opt);
      if(p==='/api/session')return json({balanceCents:reply.balanceBeforeCents,demoAllowed:true});
      if(p==='/api/wallet/me')return json({error:'no wallet'},401);
      if(p==='/api/wallet')return json({balanceCents:reply.balanceAfterCents});
      if(p.endsWith('/fairness/commitment'))return json({serverSeedHash:reply.fairness.serverSeedHash,clientSeed:reply.fairness.clientSeedBase,nonce:0});
      if(p.endsWith('/games/slots/config'))return json({gameId:'slots',enabled:true,minStakeCents:2000,maxStakeCents:1000000,maxWinCents:200000000});
      if(p.endsWith('/casino/reserve'))return json({live:false});
      if(p.endsWith('/api/events'))return json({ok:true});
      if(p.endsWith('/games/slots/spin')){const b=JSON.parse(opt.body);qaFixture.posts++;qaFixture.savedBeforePost=!!localStorage.getItem('betics:slot-receipt:'+b.requestId);qaFixture.body=b;await new Promise(r=>setTimeout(r,250));return json(reply);}
      return json({error:'unknown fixture route'},404);};
  })()`;
}

async function open(w, h, script) {
  const page = await (await fetch(`${CDP_URL}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map(), errors = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(m.error) : p.resolve(m.result); } if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 1100 });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: script });
  await send('Page.navigate', { url: `${APP_URL}/slots` });
  for (let i = 0; i < 150; i++) { await sleep(100); if (await ev(`(()=>{const s=document.querySelector('[data-testid="slot-spin"]');return !!s&&!s.disabled})()`).catch(() => false)) break; }
  const screenshot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); const f = path.join(OUT, `${name}.png`); fs.writeFileSync(f, Buffer.from(r.data, 'base64')); return f; };
  return { send, ev, screenshot, errors, close: async () => { await send('Page.close').catch(() => {}); ws.close(); } };
}

(async () => {
  const shots = [];
  for (const [want, w, h] of [['free', 390, 844], ['big', 844, 390], ['small', 1280, 800]]) {
    const fx = await makeRound(want);
    const x = await open(w, h, fixtureScript(fx));
    const label = `fixture-${want}-${w}x${h}`;
    assert.ok(await x.ev(`!document.querySelector('[data-testid="slot-spin"]').disabled`), `${label}: ready`);
    await x.ev(`document.querySelector('[data-testid="slot-spin"]').click()`);
    const seen = new Set(); let settled = false; const states = [];
    for (let i = 0; i < 1200; i++) {
      await sleep(80);
      const s = await x.ev(`(()=>{const app=document.querySelector('.slot-app');const b=document.querySelector('[data-testid="slot-banner"]');return {phase:app.dataset.phase,door:!!document.querySelector('.slot-door'),free:document.querySelector('[data-testid="slot-free-count"]')?.textContent||null,x2:!!document.querySelector('[data-testid="slot-x2"]'),banner:b?b.className.replace('slot-banner ','').split(' ')[0]:null,win:document.querySelector('[data-testid="slot-win"]')?.textContent||null,celebration:document.querySelector('[data-testid="win-celebration"]')?.dataset.tier||null,line:!!document.querySelector('.slot-line'),anticipating:document.querySelectorAll('.slot-reel.anticipating').length,balance:document.querySelector('[data-testid="header-balance"]').textContent,noScroll:document.scrollingElement.scrollHeight<=innerHeight+1}})()`);
      states.push(s);
      assert.ok(s.noScroll, `${label}: page scrolled during the presentation`);
      const keys = [s.door && 'door', s.banner, s.celebration && `celebration-${s.celebration}`, s.win && 'win', s.line && 'line', s.anticipating && 'anticipation', s.free && s.x2 && 'free-counter'].filter(Boolean);
      for (const key of keys) if (!seen.has(key)) { seen.add(key); shots.push(await x.screenshot(`${label}-${key}`)); }
      if (s.phase === 'idle' && i > 10) { settled = true; break; }
    }
    assert.ok(settled, `${label}: the round did not settle`);
    assert.equal(await x.ev('qaFixture.posts'), 1); assert.ok(await x.ev('qaFixture.savedBeforePost'), `${label}: receipt saved before the post`);
    const summary = { label, api: 'controlled fixture (not live data)', payout: fx.reply.totalPayoutCents, freeSpins: fx.reply.freeSpinsPlayed, seen: [...seen], finalBalance: states.at(-1).balance, errors: x.errors };
    if (want === 'free') { assert.ok(seen.has('door'), 'vault door shown'); assert.ok(states.some((s) => s.free && s.x2), 'free spin counter and x2 badge shown'); assert.ok(seen.has('slot-banner-free-intro') && seen.has('slot-banner-total'), 'free intro and total banners'); }
    if (want === 'big') assert.ok(seen.has('celebration-big') || seen.has('celebration-mega'), 'big win celebration');
    if (want === 'small') assert.ok(seen.has('win') || seen.has('line'), 'small win shown inline');
    assert.ok(states.some((s) => s.line), `${label}: a winning line was traced`);
    const expectedBalance = fx.reply.balanceAfterCents;
    assert.ok(/\d/.test(summary.finalBalance) && Number(summary.finalBalance.replace(/[^0-9.]/g, '')) === expectedBalance / 100, `${label}: final balance ${summary.finalBalance} vs ${expectedBalance}`);
    assert.deepEqual(x.errors.filter((e) => !/ResizeObserver/.test(e)), [], `${label}: page errors`);
    shots.push(await x.screenshot(`${label}-end`));
    console.log('PASS', JSON.stringify(summary));
    await x.close();
  }
  console.log('SLOTS FIXTURE QA PASSED (controlled fixture rounds, real engine, real browser verification). Screenshots:', shots.length, 'in', OUT);
})().catch((e) => { console.error(e); process.exit(1); });
