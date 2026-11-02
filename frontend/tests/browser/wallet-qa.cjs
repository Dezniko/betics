// Real-browser QA for the $TICS wallet features against the LOCAL backend.
// Needs: fake chain (node scripts/fake-chain.mjs 8545), wrangler dev on APP_URL with
// ETH_RPC_URL=http://127.0.0.1:8545 and local settings (casinoWallet set, realEnabled, confirmations 2),
// and headless Chrome on CDP_URL. A mock EIP-1193 wallet is injected before page scripts; signing and
// the ERC-20 transfer are done in Node (viem test key + the fake chain's test_transfer).
//   APP_URL=http://127.0.0.1:8789 node frontend/tests/browser/wallet-qa.cjs
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');
const { decodeFunctionData, parseAbi } = require('viem');
const APP = process.env.APP_URL || 'http://127.0.0.1:8789', CDP = process.env.CDP_URL || 'http://localhost:9354', CHAIN = process.env.CHAIN_URL || 'http://127.0.0.1:8545';
const OUT = process.env.QA_OUT || require('os').tmpdir()+'/wallet-qa'; fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN = '0x551ecfdba071cb6541f642cb90a073c8c158df05', CASINO = (process.env.CASINO_WALLET || '0xc0ffee0000000000000000000000000000000001').toLowerCase();
const ERC20 = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);
const account = privateKeyToAccount(generatePrivateKey()); // fresh player every run
const ADDR = account.address;
const short = `${ADDR.slice(0, 6)}...${ADDR.slice(-4)}`;
const chain = async (method, params = []) => { const r = await (await fetch(CHAIN, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (r.error) throw Error(r.error.message); return r.result; };
// wrangler dev's /__scheduled is swallowed by the SPA assets fallback here; this is the same trigger.
const scheduled = () => fetch(`${APP}/cdn-cgi/handler/scheduled?cron=*+*+*+*+*`).then((r) => r.text());
const $TICS = (n) => (BigInt(n) * 10n ** 18n).toString();

const mockWallet = `(()=>{const ADDR=${JSON.stringify(ADDR)};let chainId='0x1';const L={},pend={};let n=0;window.qaCalls=[];
window.__qaResolve=(id,res,err)=>{const p=pend[id];delete pend[id];if(!p)return;err?p.reject(Object.assign(new Error(err),{code:4001})):p.resolve(res)};
const viaNode=(method,params)=>new Promise((resolve,reject)=>{const id=++n;pend[id]={resolve,reject};window.qaWallet(JSON.stringify({id,method,params}))});
const rpc=async(method,params)=>{const r=await fetch(${JSON.stringify(CHAIN)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});const j=await r.json();if(j.error)throw new Error(j.error.message);return j.result};
window.ethereum={isMetaMask:true,request:async({method,params=[]})=>{qaCalls.push(method);switch(method){
 case 'eth_requestAccounts':case 'eth_accounts':return [ADDR];case 'eth_chainId':return chainId;case 'net_version':return String(parseInt(chainId,16));
 case 'wallet_switchEthereumChain':chainId=params[0].chainId;(L.chainChanged||[]).forEach(f=>f(chainId));return null;
 case 'wallet_requestPermissions':case 'wallet_getPermissions':return [{parentCapability:'eth_accounts'}];case 'wallet_revokePermissions':return null;
 case 'personal_sign':case 'eth_sendTransaction':return viaNode(method,params);default:return rpc(method,params)}},
 on:(e,f)=>{(L[e]||=[]).push(f)},removeListener:(e,f)=>{L[e]=(L[e]||[]).filter(x=>x!==f)}};})()`;

async function open(w, h, { fresh = false } = {}) {
  const t = await (await fetch(CDP + '/json/new?about:blank', { method: 'PUT' })).json(), ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map(), errors = [], signed = [];
  const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  ws.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(m.error) : p.resolve(m.result); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description || ''));
    if (m.method === 'Runtime.bindingCalled' && m.params.name === 'qaWallet') {
      const req = JSON.parse(m.params.payload); let result = null, error = null;
      try {
        if (req.method === 'personal_sign') { result = await account.signMessage({ message: { raw: req.params[0] } }); signed.push('personal_sign'); }
        else {
          const tx = req.params[0];
          assert.equal(tx.to.toLowerCase(), TOKEN, 'transfer goes to the official $TICS contract');
          const call = decodeFunctionData({ abi: ERC20, data: tx.data });
          assert.equal(call.functionName, 'transfer');
          result = await chain('test_transfer', [{ from: ADDR, to: call.args[0], amountWei: call.args[1].toString() }]);
          signed.push({ transfer: call.args[0], wei: call.args[1].toString(), hash: result });
        }
      } catch (err) { error = String(err.message || err); }
      ev(`window.__qaResolve(${req.id},${JSON.stringify(result)},${JSON.stringify(error)})`).catch(() => {});
    }
  };
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  if (fresh) { await send('Network.clearBrowserCookies'); await send('Network.clearBrowserCache'); await send('Storage.clearDataForOrigin', { origin: APP, storageTypes: 'all' }); }
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 1100 });
  if (w < 1100) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Runtime.addBinding', { name: 'qaWallet' });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: mockWallet });
  await send('Page.navigate', { url: APP + '/' });
  const waitFor = async (expr, ms = 15000, label = expr) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await ev(expr)) return; } catch { /* page loading */ } await sleep(100); } throw Error('Timed out waiting for ' + label); };
  const click = (sel) => ev(`(()=>{const b=document.querySelector(${JSON.stringify(sel)});if(!b||b.disabled)return false;b.click();return true})()`);
  const type = (sel, text) => ev(`(()=>{const i=document.querySelector(${JSON.stringify(sel)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(text)});i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent.trim()??null`);
  const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); const f = path.join(OUT, name + '.png'); fs.writeFileSync(f, Buffer.from(r.data, 'base64')); return f; };
  const close = async () => { await send('Page.close').catch(() => {}); ws.close(); };
  return { send, ev, waitFor, click, type, text, shot, close, errors, signed };
}
const ready = (x) => x.waitFor(`/Next lock[^a-f0-9]*[a-f0-9]{8}/.test(document.body.innerText)`, 20000, 'fairness lock');
const api = (x, p, body) => x.ev(`fetch(${JSON.stringify(p)},${body ? `{method:'POST',headers:{'content-type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}` : '{}'}).then(async r=>({status:r.status,body:await r.json()}))`);
// Every header control on screen, inside the viewport, and none overlapping another.
const layoutCheck = (x) => x.ev(`(()=>{const q=s=>[...document.querySelectorAll(s)].filter(e=>e.checkVisibility()).map(e=>{const r=e.getBoundingClientRect();return{s,l:r.left,t:r.top,r:r.right,b:r.bottom}});
 const items=[...q('header h1'),...q('header .mobile-history-trigger'),...q('header button[aria-label="How is this verified as fair?"]'),...q('header .commitment-button'),...q('.sound-toolbar'),...q('[data-testid=mode-switch]'),...q('[data-testid=header-balance]'),...q('.demo-refill'),...q('[data-testid=wallet-chip],[data-testid=wallet-connect]')];
 const over=[];for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++){const a=items[i],b=items[j];if(a.s==='.sound-toolbar'&&b.s==='.sound-toolbar')continue;if(a.l<b.r-0.5&&b.l<a.r-0.5&&a.t<b.b-0.5&&b.t<a.b-0.5)over.push(a.s+' x '+b.s)}
 const outside=items.filter(a=>a.l<-0.5||a.t<-0.5||a.r>innerWidth+0.5||a.b>innerHeight+0.5).map(a=>a.s);
 return{over,outside,docW:document.documentElement.scrollWidth,docH:document.documentElement.scrollHeight,w:innerWidth,h:innerHeight}})()`);
const pass = (msg) => console.log('PASS', msg);

(async () => {
  const shots = [];
  await chain('test_setBalance', [{ address: ADDR, wei: $TICS(10000) }]);
  await chain('test_setBalance', [{ address: CASINO, wei: $TICS(1000000) }]); // float so real spins are covered by the bankroll guard

  let x;
  if (process.env.MODE === 'layout') { x = await open(1440, 900); await x.ev(`localStorage.setItem('betics:adult:v1','1')`); await x.send('Page.reload'); await ready(x); await x.click('[data-testid=wallet-connect]'); await x.waitFor(`!!document.querySelector('[data-testid=wallet-chip]')`, 20000, 'connect'); await x.click('[data-testid=wallet-chip]'); await x.waitFor(`!!document.querySelector('[data-testid=wallet-disconnect]')`); await x.click('[data-testid=wallet-disconnect]'); await x.waitFor(`!!document.querySelector('[data-testid=wallet-connect]')`, 10000, 'disconnect'); }
  else {
  // 1. 18+ gate on first visit, remembered.
  x = await open(1440, 900, { fresh: true });
  await x.waitFor(`!!document.querySelector('[data-testid=age-gate]')`, 15000, 'age gate');
  assert.equal(await x.ev(`document.body.style.position`), 'fixed', 'gate locks background scroll');
  assert.equal(await x.ev(`document.querySelector('[data-testid=age-continue]').disabled`), true);
  assert.ok(await x.ev(`[...document.querySelectorAll('[data-testid=age-gate] a')].some(a=>a.getAttribute('href')==='/terms')`), 'gate links to /terms');
  shots.push(await x.shot('gate-desktop'));
  await x.click('[data-testid=age-check]'); await x.click('[data-testid=age-continue]');
  await x.waitFor(`!document.querySelector('[data-testid=age-gate]')&&localStorage.getItem('betics:adult:v1')==='1'`);
  await x.send('Page.reload'); await ready(x);
  assert.equal(await x.ev(`!!document.querySelector('[data-testid=age-gate]')`), false, 'gate remembered');
  pass('18+ gate blocks first visit, needs the checkbox, links to Terms, remembered after reload');

  // 2. Guest: Demo, 100,000 demo $TICS, Real unavailable with a reason, $TICS everywhere.
  await x.waitFor(`document.querySelector('[data-testid=header-balance]').textContent.includes('$TICS')`);
  assert.equal(await x.text('[data-testid=header-balance]'), '100,000.00 $TICS');
  assert.equal(await x.ev(`document.querySelector('[data-testid=mode-switch]').dataset.mode`), 'demo');
  assert.equal(await x.ev(`document.querySelector('[data-testid=mode-real]').getAttribute('aria-disabled')`), 'true');
  await x.click('[data-testid=mode-real]');
  await x.waitFor(`document.body.innerText.includes('Connect a wallet to play with real $TICS.')`, 3000, 'real reason');
  assert.equal(await x.ev(`document.querySelector('[data-testid=mode-switch]').dataset.mode`), 'demo');
  assert.equal(await x.ev(`/\\$\\d/.test(document.body.innerText)`), false, 'no dollar amounts');
  assert.ok(await x.ev(`!!document.querySelector('button[title="100 $TICS chip (key 5)"]')`), 'chips are $TICS');
  assert.equal(await x.ev(`document.querySelector('[data-testid=wallet-connect]').innerText.trim()`), 'Connect wallet');
  shots.push(await x.shot('header-guest-desktop'));
  pass('guest shows Demo with 100,000.00 $TICS, Real unavailable with a plain reason, $TICS chips, Connect wallet');

  // 3. Connect + SIWE sign-in; the __Host- Secure wallet cookie sticks on http://127.0.0.1.
  // The first Connect in this browser shows the custody / fairness / beta notice; Continue needs the tick.
  await x.click('[data-testid=wallet-connect]');
  await x.waitFor(`!!document.querySelector('[data-testid=connect-notice]')`, 5000, 'connect notice');
  assert.equal(await x.ev(`document.querySelector('[data-testid=connect-notice-continue]').disabled`), true, 'Continue needs the tick');
  assert.equal(await x.ev(`!!document.querySelector('[data-testid=wallet-chip]')`), false, 'no wallet before Continue');
  await x.click('[data-testid=connect-notice-check]'); await x.click('[data-testid=connect-notice-continue]');
  await x.waitFor(`!!document.querySelector('[data-testid=wallet-chip]')`, 20000, 'wallet chip');
  assert.equal(await x.ev(`localStorage.getItem('betics:connect-notice:v1')`), '1');
  assert.equal(await x.text('[data-testid=wallet-chip]'), short);
  assert.ok(x.signed.includes('personal_sign'), 'signed in with personal_sign');
  const cookies = (await x.send('Network.getCookies', { urls: [APP] })).cookies;
  const wc = cookies.find((c) => c.name === '__Host-betics_wallet');
  assert.ok(wc && wc.secure && wc.httpOnly, 'wallet cookie stored: ' + JSON.stringify(cookies.map((c) => c.name)));
  const me = await api(x, '/api/wallet/me');
  assert.equal(me.status, 200); assert.equal(me.body.address, ADDR); assert.ok(me.body.termsAcceptedAt, 'terms recorded after connect');
  await ready(x);
  pass('connect + SIWE sign-in, short address chip ' + short + ', Secure HttpOnly __Host- cookie kept on 127.0.0.1, terms recorded');

  // 4. Profile panel: address, balances, email save.
  await x.click('[data-testid=wallet-chip]');
  await x.waitFor(`!!document.querySelector('[data-testid=wallet-panel]')`);
  assert.equal(await x.ev(`document.body.style.position`), 'fixed', 'panel locks background');
  assert.equal(await x.text('[data-testid=wallet-address]'), ADDR);
  assert.equal(await x.ev(`document.querySelector('[data-testid=profile-support]')?.href`), 'https://t.me/Betics_casino', 'support link in the profile');
  assert.equal(await x.ev(`document.querySelector('[data-testid=profile-support]')?.target`), '_blank');
  assert.equal(await x.text('[data-testid=panel-real-balance]'), '0.00 $TICS');
  assert.equal(await x.text('[data-testid=panel-demo-balance]'), '100,000.00 $TICS');
  assert.equal(await x.ev(`document.querySelector('[data-testid=tab-topup]').getAttribute('aria-selected')`), 'true', 'profile opens on Top up');
  await x.click('[data-testid=tab-withdraw]'); await x.waitFor(`!!document.querySelector('[data-testid=withdraw-locked]')`);
  assert.ok(await x.ev(`document.querySelector('[data-testid=withdraw-locked]').textContent.includes('after your first top up')`));
  await x.ev(`document.querySelector('[data-testid=wallet-panel]').scrollTop=400;void 0`); await sleep(100);
  assert.ok(await x.ev(`(()=>{const p=document.querySelector('[data-testid=wallet-panel]');return p.scrollHeight<=p.clientHeight+1||p.scrollTop>0})()`), 'panel fits or scrolls itself');
  await x.ev(`document.querySelector('[data-testid=wallet-panel]').scrollTop=0;void 0`);
  await x.click('[data-testid=tab-topup]'); await sleep(150);
  shots.push(await x.shot('panel-desktop'));
  await x.ev(`document.querySelector('[data-testid=wallet-email]').scrollIntoView();void 0`); await sleep(150);
  shots.push(await x.shot('panel-email'));
  const email = `qa${Date.now()}@example.com`;
  await x.type('[data-testid=email-input]', email); await x.click('[data-testid=email-consent]'); await x.click('[data-testid=email-save]');
  await x.waitFor(`document.querySelector('[data-testid=email-status]')?.textContent==='Saved'`, 8000, 'email saved');
  const me2 = await api(x, '/api/wallet/me'); assert.equal(me2.body.email, email); assert.equal(me2.body.emailConsent, true);
  pass('profile panel shows full address, real 0.00 and demo 100,000.00 $TICS, scrolls, email + updates saved');

  // 5. Top up 5,000 $TICS (the fallback fee is 500 $TICS, so the smallest withdrawal is 2,500) -> Confirming x of 2 -> Credited; Demo hidden once funded.
  await x.click('[data-testid=tab-topup]'); await x.waitFor(`!!document.querySelector('[data-testid=topup-amount]')`);
  await x.type('[data-testid=topup-amount]', '5000'); await x.click('[data-testid=topup-send]');
  await x.waitFor(`['pending','confirming'].includes(document.querySelector('[data-testid=topup-status]')?.dataset.status)`, 15000, 'deposit sent');
  const sent = x.signed.find((s) => s.transfer);
  assert.equal(sent.transfer.toLowerCase(), CASINO); assert.equal(sent.wei, $TICS(5000));
  await x.waitFor(`/^Confirming 1 of 2/.test(document.querySelector('[data-testid=topup-status]').textContent)`, 15000, 'Confirming 1 of 2');
  shots.push(await x.shot('panel-topup-confirming'));
  await chain('test_mine', [{ blocks: 2 }]);
  await x.waitFor(`document.querySelector('[data-testid=topup-status]')?.dataset.status==='credited'`, 25000, 'credited');
  assert.match(await x.text('[data-testid=topup-status]'), /^Credited 5,000\.00 \$TICS/);
  assert.match(await x.text('[data-testid=topup-status]'), /Credited 5,000\.00 \$TICS\. You can play now\. Withdrawals open in about 15 minutes\./);
  assert.match(await x.text('[data-testid=topup-wait-note]'), /^You can play as soon as your top up is credited\. Withdrawals open about 15 minutes after it arrives/);
  await x.waitFor(`document.querySelector('[data-testid=panel-real-balance]').textContent==='5,000.00 $TICS'`, 10000, 'real balance refreshed');
  await x.waitFor(`!document.querySelector('[data-testid=panel-demo-balance]')`, 5000, 'demo row hidden');
  shots.push(await x.shot('panel-topup-credited'));
  // Not final on Ethereum yet (the cron has not run): the Withdraw tab explains the wait and Withdraw is greyed out.
  await x.click('[data-testid=tab-withdraw]');
  await x.waitFor(`/^Your latest top up is still being confirmed on Ethereum\\. Withdrawals open in about 1[45] minutes\\. You can keep playing in the meantime\\.$/.test(document.querySelector('[data-testid=withdraw-wait]')?.textContent || '')`, 10000, 'withdraw wait note');
  await x.type('[data-testid=withdraw-amount]', '3000');
  assert.ok(await x.ev(`document.querySelector('[data-testid=withdraw-send]').disabled`), 'Withdraw greyed out while the top up is not final');
  shots.push(await x.shot('panel-withdraw-waiting'));
  await x.type('[data-testid=withdraw-amount]', '');
  await x.click('[data-testid=tab-topup]'); await sleep(300);
  await x.click('.wallet-panel .fair-head button'); await sleep(400);
  await x.waitFor(`document.querySelector('[data-testid=mode-switch]').dataset.mode==='real'&&!document.querySelector('[data-testid=mode-demo]')&&!document.querySelector('.demo-refill')`, 5000, 'real forced');
  assert.equal(await x.text('[data-testid=header-balance]'), '5,000.00 $TICS');
  shots.push(await x.shot('header-funded-desktop'));
  pass('top up sent as ERC-20 transfer of 5000e18 to the casino wallet, Confirming 1 of 2, Credited, Demo hidden, Real forced');

  // 6. A Real spin changes the real balance.
  await scheduled(); await sleep(16000); // float snapshot, the Worker caches it for 15 s
  await x.click('button[title="100 $TICS chip (key 5)"]');
  await x.click('button[title="RED"]');
  await x.waitFor(`document.body.innerText.includes('100.00 $TICS in play')`, 3000, 'chip on table');
  let spinBody = null;
  await x.ev(`(()=>{const f=window.fetch;window.fetch=async(...a)=>{if(String(a[0]).includes('/spin')){window.qaSpinBody=JSON.parse(a[1].body);const r=await f(...a);window.qaSpinResp={status:r.status,body:await r.clone().json()};return r}return f(...a)}})()`);
  await x.click('button[title="Spin (Space)"]');
  await x.waitFor(`!!window.qaSpinBody`, 5000, 'spin sent');
  spinBody = await x.ev('window.qaSpinBody');
  assert.equal(spinBody.mode, 'real');
  for (let i = 0; i < 300; i++) { await sleep(100); await x.ev(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Skip ahead');b&&b.click()})()`); if (await x.ev(`!document.querySelector('button[title="Spin (Space)"]').disabled&&document.querySelector('[data-testid=round-stage]').dataset.roundStage==='idle'`)) break; }
  const after = (await api(x, '/api/wallet')).body;
  if (after.realTicsCents === 250000) console.log('spin response', JSON.stringify(await x.ev('window.qaSpinResp')).slice(0, 400), await x.text('.game-error'));
  assert.ok(after.realTicsCents === 490000 || after.realTicsCents === 510000, 'real balance moved by the 100 $TICS bet: ' + after.realTicsCents);
  assert.equal(after.balanceCents, 10000000, 'demo balance untouched');
  await x.waitFor(`document.querySelector('[data-testid=header-balance]').textContent===${JSON.stringify(after.realTicsCents === 490000 ? '4,900.00 $TICS' : '5,100.00 $TICS')}`, 8000, 'header shows the real balance');
  pass(`real spin (mode real) moved the real balance to ${after.realTicsCents / 100} $TICS, demo balance untouched`);

  // 7. Withdraw: fee paid by the player, amount received, queued.
  await x.click('[data-testid=wallet-chip]'); await x.waitFor(`!!document.querySelector('[data-testid=tab-withdraw]')`);
  await x.click('[data-testid=tab-withdraw]'); await x.waitFor(`!!document.querySelector('[data-testid=withdraw-amount]')`);
  await sleep(800); // quote loads when the form opens
  // The top up is final once the cron has seen it in a final block (the local test chain finalizes at once);
  // the tab re-reads the profile, so the 'still being confirmed' note goes and Withdraw works.
  await scheduled();
  await x.click('[data-testid=tab-topup]'); await sleep(300); await x.click('[data-testid=tab-withdraw]');
  await x.waitFor(`!document.querySelector('[data-testid=withdraw-wait]')`, 25000, 'withdraw wait note gone once final');
  const quote = (await api(x, '/api/wallet/withdraw/quote')).body;
  await x.ev(`window.qaWithdraw=null;(()=>{const f=window.fetch;window.fetch=async(...a)=>{if(String(a[0]).endsWith('/wallet/withdraw'))window.qaWithdraw=JSON.parse(a[1].body);return f(...a)}})()`);
  const fmt = (u) => `${Math.floor(u / 100).toLocaleString('en-US')}.${String(u % 100).padStart(2, '0')} $TICS`;
  const fee = quote.feesEnabled === false ? 0 : quote.feeCents;
  assert.equal(await x.text('[data-testid=withdraw-min]'), `Smallest withdrawal: ${fmt(quote.minWithdrawalCents)}`);
  assert.equal(await x.ev(`!!document.querySelector('[data-testid=withdraw-fee]')`), quote.feesEnabled !== false, 'fee line only when fees are on');
  if (quote.feesEnabled !== false) assert.equal(await x.text('[data-testid=withdraw-fee]'), fmt(fee));
  if (quote.minWithdrawalCents > 100) { await x.type('[data-testid=withdraw-amount]', String(quote.minWithdrawalCents / 100 - 0.01)); assert.ok(await x.ev(`document.querySelector('[data-testid=withdraw-send]').disabled`), 'below the live minimum is refused'); }
  const wAmount = Math.max(10000, quote.minWithdrawalCents, fee + 100);
  assert.ok(wAmount <= after.realTicsCents, 'test balance covers the minimum withdrawal');
  await x.type('[data-testid=withdraw-amount]', String(wAmount / 100));
  const recv = await x.text('[data-testid=withdraw-receive]');
  assert.equal(recv, fmt(wAmount - fee), 'you receive = amount minus fee');
  await x.click('[data-testid=withdraw-send]');
  // Review step: amount, fee, you receive and the full destination (the connected wallet) before anything is sent.
  await x.waitFor(`!!document.querySelector('[data-testid=withdraw-confirm]')`, 10000, 'withdraw review');
  assert.equal(await x.ev('window.qaWithdraw || null'), null, 'nothing sent before confirming');
  assert.equal((await x.text('[data-testid=withdraw-confirm-address]')).toLowerCase(), ADDR.toLowerCase(), 'review shows the destination wallet');
  assert.equal(await x.text('[data-testid=withdraw-confirm-receive]'), fmt(wAmount - fee));
  shots.push(await x.shot('panel-withdraw-review'));
  await x.click('[data-testid=withdraw-confirm]');
  await x.waitFor(`document.querySelector('[data-testid=withdraw-message]')?.textContent.includes('queued')`, 10000, 'withdraw queued');
  const wbody = await x.ev('window.qaWithdraw');
  assert.equal(wbody.amountCents, wAmount); assert.equal(wbody.maxFeeCents, fee); assert.ok(/^[0-9a-f-]{36}$/.test(wbody.requestId)); assert.equal(typeof wbody.maxFeeCents, 'number');
  await sleep(300); await x.click('[data-testid=tab-activity]');
  await x.waitFor(`[...document.querySelectorAll('.wallet-activity li')].some(li=>li.dataset.kind==='Withdrawal'&&li.dataset.status==='Queued')`, 10000, 'withdrawal in list');
  shots.push(await x.shot('panel-withdraw-queued'));
  pass(`withdraw (fees ${quote.feesEnabled === false ? 'off, no fee line' : 'on, fee ' + fmt(fee)}, smallest ${fmt(quote.minWithdrawalCents)}) shows You receive ${recv}, sends maxFeeCents + uuid, shows Queued`);

  // 8. Disconnect returns to the guest Demo session.
  await x.click('[data-testid=wallet-disconnect]');
  await x.waitFor(`!!document.querySelector('[data-testid=wallet-connect]')&&!document.querySelector('[data-testid=wallet-panel]')`, 10000, 'disconnected');
  await x.waitFor(`document.querySelector('[data-testid=mode-switch]').dataset.mode==='demo'&&!!document.querySelector('[data-testid=mode-demo]')`, 8000, 'demo after disconnect');
  assert.equal(await x.text('[data-testid=header-balance]'), '100,000.00 $TICS');
  assert.equal((await api(x, '/api/wallet/me')).status, 401);
  await ready(x);
  assert.deepEqual(x.errors, []);
  pass('disconnect logs out, wallet cookie gone, back to guest Demo 100,000.00 $TICS');

  }
  // 9. Layout: header + panel on desktop and phones, no overlap / overflow, no page scroll on phones.
  const lc = await layoutCheck(x); assert.deepEqual(lc.over, [], JSON.stringify(lc)); assert.deepEqual(lc.outside, []);
  await x.close();
  for (const [w, h] of [[390, 844], [844, 390]]) {
    const p = await open(w, h); await ready(p);
    shots.push(await p.shot(`header-guest-${w}x${h}`));
    let m = await layoutCheck(p); assert.ok(!m.over.length && !m.outside.length && m.docW <= w + 1 && m.docH <= h + 1, `${w}x${h} guest ${JSON.stringify(m)}`);
    await p.click('[data-testid=wallet-connect]');
    await new Promise((r) => setTimeout(r, 400));
    if (await p.ev(`!!document.querySelector('[data-testid=connect-notice]')`)) { await p.click('[data-testid=connect-notice-check]'); await p.click('[data-testid=connect-notice-continue]'); }
    await p.waitFor(`!!document.querySelector('[data-testid=wallet-chip]')`, 20000, 'mobile connect'); await ready(p);
    if (process.env.MODE !== 'layout') await p.waitFor(`document.querySelector('[data-testid=mode-switch]').dataset.mode==='real'`, 8000, 'funded real on phone');
    shots.push(await p.shot(`header-connected-${w}x${h}`));
    m = await layoutCheck(p); assert.ok(!m.over.length && !m.outside.length && m.docW <= w + 1 && m.docH <= h + 1, `${w}x${h} connected ${JSON.stringify(m)}`);
    await p.click('[data-testid=wallet-chip]'); await p.waitFor(`!!document.querySelector('[data-testid=wallet-panel]')`); await sleep(600);
    const panel = await p.ev(`(()=>{const r=document.querySelector('[data-testid=wallet-panel]').getBoundingClientRect(),e=document.querySelector('[data-testid=wallet-panel]');return{l:r.left,r:r.right,t:r.top,b:r.bottom,scrolls:e.scrollHeight>e.clientHeight,locked:document.body.style.position==='fixed',wide:[...e.querySelectorAll('*')].filter(c=>c.getBoundingClientRect().right>r.right+1).map(c=>c.className).slice(0,5)}})()`);
    assert.ok(panel.l >= 0 && panel.r <= w + 0.5 && panel.t >= 0 && panel.b <= h + 0.5 && panel.locked && !panel.wide.length, `${w}x${h} panel ${JSON.stringify(panel)}`);
    shots.push(await p.shot(`panel-${w}x${h}`));
    await p.click('[data-testid=wallet-disconnect]'); await p.waitFor(`!!document.querySelector('[data-testid=wallet-connect]')`, 10000, 'mobile disconnect');
    assert.deepEqual(p.errors, []); await p.close();
    pass(`${w}x${h}: header (guest + connected) and wallet panel fit, no overlap, no page scroll, panel locks the page`);
  }
  // 10. Terms page.
  const tp = await open(1440, 900); await tp.send('Page.navigate', { url: APP + '/terms' });
  await tp.waitFor(`document.body.innerText.includes('0x551ecFDBa071cB6541f642cB90a073c8c158Df05')`, 10000, 'terms');
  const tt = await tp.ev('document.body.innerText');
  for (const s of ['own risk', 'flaws, errors or interruptions', 'no guarantee of availability', 'cannot be reversed', 'is not credited', 'may pause play', 'wallet address', 'marketing']) assert.ok(tt.includes(s), 'terms: ' + s);
  assert.ok(!/[\u2013\u2014]/.test(tt), 'no en or em dashes');
  shots.push(await tp.shot('terms-desktop')); await tp.close();
  for (const s of ['not been audited by an independent', 'as is and as available', 'hack', 'loss of funds', 'malfunction voids', 'total liability', 'for fun', 't.me/Betics_casino']) assert.ok(tt.toLowerCase().includes(s.toLowerCase()), 'terms: ' + s);
  pass('/terms page has every required clause, the official contract, and no dashes');
  const hp = await open(1440, 900); await hp.send('Page.navigate', { url: APP + '/how-it-works' });
  await hp.waitFor(`document.body.textContent.includes('When lots of people play at the same time')`, 10000, 'how it works');
  const ht = await hp.ev('document.body.textContent');
  for (const s of ['How your balance is covered', 'designed to always hold enough', 'The table limit', 'While funds last', 'never touches your balance', 'not been audited by a third party']) assert.ok(ht.includes(s), 'how it works: ' + s);
  assert.ok(!/[\u2013\u2014]/.test(ht), 'how it works: no en or em dashes');
  assert.equal(await hp.ev(`document.querySelector('[data-testid=how-support]')?.href`), 'https://t.me/Betics_casino');
  await hp.waitFor(`!!document.querySelector('[data-testid=how-maxstraight]')`, 25000, 'how it works live figures');
  shots.push(await hp.shot('how-it-works'));
  pass('/how-it-works explains coverage, the table limit, many players and while funds last, with live figures and support');
  fs.writeFileSync(path.join(OUT, 'shots.json'), JSON.stringify(shots, null, 2));
  await hp.close?.(); await tp.close?.();
  console.log('WALLET QA PASSED', ADDR, 'screenshots in', OUT);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
