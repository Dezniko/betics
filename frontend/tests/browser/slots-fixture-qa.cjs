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
    return { entropy, base, reply: { requestId: '00000000-0000-4000-8000-000000000001', roundId: 1, game: 'godsofpower', stake, spins: round.spins, freeSpinsAwarded: round.freeSpinsAwarded, freeSpinsPlayed: round.freeSpinsPlayed, capped: round.capped,
      totalStakeCents: stake, totalPayoutCents: round.totalPayoutUnits, mathId: SLOT_MATH.id, mode: 'demo', balanceBeforeCents: before, balanceAfterCents: before - stake + round.totalPayoutUnits,
      fairness: { serverSeed: seed, serverSeedHash: sha(seed), clientSeed, clientSeedBase: base, clientEntropy: entropy, nonce: 0, nextCommitment: { serverSeedHash: sha(`${seed}-next`), clientSeed: base, nonce: 0 } } } };
  }
  throw new Error('no fixture seed found');
}

// mode: 'ok' (normal round) | 'refuse503' (the spin is refused, lock and balance untouched) | 'other_tab'
// (409 other_tab from the server while this browser saw no other tab) | 'lost' (the first post never answers;
// the round is in /api/rounds; the byte-identical replay returns the cached reply).
function fixtureScript({ entropy, reply }, mode = 'ok') {
  const seed = reply.fairness.serverSeed, nextLock = reply.fairness.nextCommitment.serverSeedHash;
  const row = { id: reply.roundId, game: 'godsofpower', stake_cents: reply.stake, payout_cents: reply.totalPayoutCents, server_seed: seed, server_seed_hash: reply.fairness.serverSeedHash, client_seed: reply.fairness.clientSeed, client_seed_base: reply.fairness.clientSeedBase, client_entropy: reply.fairness.clientEntropy, nonce: 0, request_id: reply.requestId, real_money: 0, math_id: reply.mathId, created_at: '2026-11-06 10:00:00', status: 'settled', revealed_at: '2026-11-06 10:00:01',
    outcome_json: JSON.stringify({ game: 'godsofpower', spins: reply.spins, freeSpinsAwarded: reply.freeSpinsAwarded, freeSpinsPlayed: reply.freeSpinsPlayed, capped: reply.capped }) };
  return `(()=>{
    const audio=localStorage.getItem('noir:audio:v1');localStorage.clear();if(audio!==null)localStorage.setItem('noir:audio:v1',audio);
    localStorage.setItem('betics:adult:v1','1');
    const reply=${JSON.stringify(reply)};const entropy=${JSON.stringify(entropy)};const mode=${JSON.stringify(mode)};const row=${JSON.stringify(row)};const nextLock=${JSON.stringify(nextLock)};const seed=${JSON.stringify(seed)};
    window.qaFixture={label:'controlled fixture (not live data)',posts:0,savedBeforePost:false,rotates:[],roundsReads:0,bodies:[]};
    let lock={serverSeedHash:reply.fairness.serverSeedHash,clientSeed:reply.fairness.clientSeedBase,nonce:0};
    const grv=crypto.getRandomValues.bind(crypto);
    crypto.getRandomValues=(arr)=>{if(arr instanceof Uint8Array&&arr.length===32){for(let i=0;i<32;i++)arr[i]=parseInt(entropy.slice(i*2,i*2+2),16);return arr;}return grv(arr);};
    crypto.randomUUID=()=>reply.requestId;
    const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json'}});
    const real=window.fetch.bind(window);
    window.fetch=async(url,opt={})=>{const p=String(url);if(!p.startsWith('/api/'))return real(url,opt);
      if(p==='/api/session')return json({balanceCents:reply.balanceBeforeCents,demoAllowed:true});
      if(p==='/api/wallet/me')return json({error:'no wallet'},401);
      if(p==='/api/wallet')return json({balanceCents:reply.balanceAfterCents});
      if(p.endsWith('/fairness/commitment'))return json(lock);
      if(p.endsWith('/fairness/rotate')){const b=JSON.parse(opt.body);qaFixture.rotates.push(b);if(b.expectedCommitment.serverSeedHash!==lock.serverSeedHash)return json({error:'stale or mismatched expectedCommitment'},409);const retired={serverSeed:seed,serverSeedHash:lock.serverSeedHash};lock={serverSeedHash:nextLock,clientSeed:lock.clientSeed,nonce:0};return json({retired,commitment:lock});}
      if(p==='/api/rounds'){qaFixture.roundsReads++;return json(mode==='lost'&&qaFixture.posts>=1?[row]:[]);}
      if(p.endsWith('/games/godsofpower/config'))return json({gameId:'godsofpower',enabled:true,minStakeCents:2000,maxStakeCents:1000000,maxWinCents:200000000});
      if(p.endsWith('/casino/reserve'))return json({live:false});
      if(p.endsWith('/api/events'))return json({ok:true});
      if(p.endsWith('/games/godsofpower/spin')){const b=JSON.parse(opt.body);qaFixture.posts++;qaFixture.bodies.push(opt.body);qaFixture.savedBeforePost=!!localStorage.getItem('betics:slot-receipt:'+b.requestId);qaFixture.openLockBeforePost=(JSON.parse(localStorage.getItem('betics:open-locks:v1')||'[]')).some(e=>e.serverSeedHash===b.expectedCommitment.serverSeedHash);qaFixture.body=b;await new Promise(r=>setTimeout(r,250));
        if(mode==='refuse503')return json({error:'Real play is paused while the casino wallet is checked. Please try again shortly.'},503);
        if(mode==='other_tab')return json({error:'You are playing in another tab or game. Finish that round first.',code:'other_tab'},409);
        if(mode==='lost'&&qaFixture.posts===1){await new Promise(r=>setTimeout(r,40000));return json({error:'never'},500);}
        lock={serverSeedHash:nextLock,clientSeed:lock.clientSeed,nonce:0};return json(reply);}
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
  await send('Page.navigate', { url: `${APP_URL}/godsofpower` });
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

  // ---- refusal protection (same protocol as roulette) ----
  const lockShown = (x) => x.ev(`document.querySelector('[data-testid="header-lock"] code')?.textContent || ''`);
  const waitIdle = async (x, ms = 60000) => { for (let i = 0; i < ms / 100; i++) { await sleep(100); if (await x.ev(`document.querySelector('.slot-app').dataset.phase`) === 'idle' && await x.ev(`qaFixture.posts`) >= 1) { await sleep(300); return; } } throw new Error('did not settle'); };
  const budget = (x, which) => x.ev(`(JSON.parse(localStorage.getItem('betics:refusals:${which}:v2')||'[]')).length`);
  const openLocks = (x) => x.ev(`JSON.parse(localStorage.getItem('betics:open-locks:v1')||'[]').length`);
  const toast = (x) => x.ev(`[...document.querySelectorAll('[data-testid="slot-error"], [data-testid="slot-notice"]')].map(e=>e.textContent).join(' | ')`);

  { // 1. a refused spin (503 after the entropy was sent) retires the lock through the reveal and shows the next lock
    const fx = await makeRound('small');
    const x = await open(1280, 800, fixtureScript(fx, 'refuse503'));
    const before = await lockShown(x);
    assert.equal(before.slice(0, 8), fx.reply.fairness.serverSeedHash.slice(0, 8), 'the lock before the spin is the fixture lock');
    await x.ev(`document.querySelector('[data-testid="slot-spin"]').click()`);
    await waitIdle(x);
    assert.ok(await x.ev('qaFixture.openLockBeforePost'), 'refuse503: the open lock was saved BEFORE the post');
    const rotates = await x.ev('qaFixture.rotates');
    assert.equal(rotates.length, 1, 'refuse503: the lock was retired through POST /api/fairness/rotate');
    assert.equal(rotates[0].expectedCommitment.serverSeedHash, fx.reply.fairness.serverSeedHash, 'refuse503: rotate carries the saved lock');
    const after = await lockShown(x);
    assert.equal(after.slice(0, 8), fx.reply.fairness.nextCommitment.serverSeedHash.slice(0, 8), `refuse503: the next lock is shown (${after})`);
    assert.equal(await budget(x, 'predicted'), 1, 'refuse503: counted once in the predicted budget');
    assert.equal(await budget(x, 'unpredicted'), 0);
    assert.equal(await openLocks(x), 0, 'refuse503: the open lock list is clear again');
    const log = await x.ev(`JSON.parse(localStorage.getItem('betics:refused-log:v1')||'[]')`);
    assert.equal(log.length, 1); assert.equal(log[0].game, 'godsofpower'); assert.equal(log[0].kind, 'predicted'); assert.deepEqual(log[0].stops, fx.reply.spins[0].stops, 'refuse503: the would-have reel stops are logged from the revealed key');
    assert.equal(log[0].won, fx.reply.totalPayoutCents, 'refuse503: and the would-have payout');
    const t = await toast(x);
    assert.match(t, /Real play is paused/, 'refuse503: the server reason is shown');
    assert.match(t, /Had it gone ahead, the reels would have stopped at/, 'refuse503: the would-have outcome is shown');
    assert.ok(!(await x.ev(`document.querySelector('[data-testid="slot-spin"]').disabled`)), 'refuse503: play goes on with the new lock');
    assert.ok(await x.ev(`JSON.parse(localStorage.getItem('noir:revealed:v1')||'[]').includes(${JSON.stringify(fx.reply.fairness.serverSeedHash)})`), 'refuse503: the retired lock is remembered as revealed');
    shots.push(await x.screenshot('fixture-refused-503'));
    assert.deepEqual(x.errors.filter((e) => !/ResizeObserver/.test(e)), [], 'refuse503: page errors');
    console.log('PASS', JSON.stringify({ label: 'refuse503', api: 'controlled fixture (not live data)', rotates: rotates.length, toast: t.slice(0, 160) }));
    await x.close();
  }
  { // 2. a 409 other_tab with NO other tab seen by this browser counts against the strict budget and retires the lock
    const fx = await makeRound('small');
    const x = await open(1280, 800, fixtureScript(fx, 'other_tab'));
    await x.ev(`document.querySelector('[data-testid="slot-spin"]').click()`);
    await waitIdle(x);
    assert.equal((await x.ev('qaFixture.rotates')).length, 1, 'other_tab unseen: the lock was retired through the reveal');
    assert.equal(await budget(x, 'unpredicted'), 1, 'other_tab unseen: counted in the strict budget');
    assert.equal((await lockShown(x)).slice(0, 8), fx.reply.fairness.nextCommitment.serverSeedHash.slice(0, 8), 'other_tab unseen: next lock shown');
    const t = await toast(x);
    assert.match(t, /this browser saw no other tab/, 'other_tab unseen: the player is told');
    const log = await x.ev(`JSON.parse(localStorage.getItem('betics:refused-log:v1')||'[]')`);
    assert.equal(log[0]?.kind, 'other_tab_unseen');
    shots.push(await x.screenshot('fixture-other-tab-unseen'));
    assert.deepEqual(x.errors.filter((e) => !/ResizeObserver/.test(e)), [], 'other_tab: page errors');
    console.log('PASS', JSON.stringify({ label: 'other_tab_unseen', api: 'controlled fixture (not live data)', unpredicted: await budget(x, 'unpredicted') }));
    await x.close();
  }
  { // 3. a lost reply whose round is in /api/rounds is recovered: the byte-identical body is re-posted and the cached reply presented
    const fx = await makeRound('small');
    const x = await open(1280, 800, fixtureScript(fx, 'lost'));
    await x.ev(`document.querySelector('[data-testid="slot-spin"]').click()`);
    let presented = false, checking = false;
    for (let i = 0; i < 700; i++) { // the page waits 30 s for the reply, then looks in /api/rounds
      await sleep(100);
      const st = await x.ev(`({phase:document.querySelector('.slot-app').dataset.phase,posts:qaFixture.posts,notice:document.querySelector('[data-testid="slot-notice"]')?.textContent||'',line:!!document.querySelector('.slot-line'),win:!!document.querySelector('[data-testid="slot-win"]')})`);
      if (/Checking whether your spin went through/.test(st.notice)) checking = true;
      if (st.phase === 'presenting' || st.line || st.win) presented = true;
      if (st.posts >= 2 && st.phase === 'idle' && presented) break;
    }
    const bodies = await x.ev('qaFixture.bodies');
    assert.equal(bodies.length, 2, 'lost: the spin was posted twice');
    assert.equal(bodies[0], bodies[1], 'lost: the replay body is byte-identical');
    assert.ok(checking, 'lost: the player saw the "checking" notice');
    assert.ok(presented, 'lost: the cached reply was presented as a normal round');
    assert.ok(await x.ev('qaFixture.roundsReads') >= 1, 'lost: /api/rounds was checked');
    assert.equal((await x.ev('qaFixture.rotates')).length, 0, 'lost: the lock was NOT retired, the round used it');
    assert.equal(await openLocks(x), 0, 'lost: the open lock is closed by the verified reply');
    const t = await toast(x);
    assert.ok(!/[Rr]eload/.test(t), `lost: no reload message (${t})`);
    assert.equal((await lockShown(x)).slice(0, 8), fx.reply.fairness.nextCommitment.serverSeedHash.slice(0, 8), 'lost: the next lock from the reply is shown');
    const bal = await x.ev(`document.querySelector('[data-testid="header-balance"]').textContent`);
    assert.equal(Number(bal.replace(/[^0-9.]/g, '')), fx.reply.balanceAfterCents / 100, `lost: settled balance shown (${bal})`);
    shots.push(await x.screenshot('fixture-lost-reply-recovered'));
    assert.deepEqual(x.errors.filter((e) => !/ResizeObserver/.test(e)), [], 'lost: page errors');
    console.log('PASS', JSON.stringify({ label: 'lost_reply_recovered', api: 'controlled fixture (not live data)', posts: bodies.length }));
    await x.close();
  }
  console.log('SLOTS FIXTURE QA PASSED (controlled fixture rounds, real engine, real browser verification). Screenshots:', shots.length, 'in', OUT);
})().catch((e) => { console.error(e); process.exit(1); });
