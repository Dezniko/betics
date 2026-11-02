// Placing chips must not reduce the shown Balance (they show under "On table");
// Spin deducts the stake; after settlement Balance equals the server balance
// even though the chips stay on the table for the next round.
// REAL_API=1 APP_URL=http://127.0.0.1:8789 node frontend/tests/browser/balance-display-qa.cjs
const assert=require('node:assert/strict');const {open}=require('./mobile-controls-qa.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const cents=s=>Math.round(Number(String(s).replace(/[^0-9.]/g,''))*100);
(async()=>{for(const[w,h]of [[390,844],[1440,900]]){const x=await open(w,h);
  const read=()=>x.ev(`(()=>{const t=document.querySelector('.tray-balances');const v=[...t.querySelectorAll(':scope > div > div')].map(d=>d.textContent);return v})()`);
  const server=()=>x.ev(`fetch('/api/session',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.json()).then(u=>u.balanceCents)`);
  const start=await server();let [bal,table]=await read();
  const onTable0=cents(table);assert.equal(cents(bal),start,'idle balance = server balance');
  // Pass 1 (phone) covers every straight so the win/transfer path runs; pass 2 a likely loss.
  const keys=w<1100?Array.from({length:37},(_,n)=>`straight:${n}`):['straight:17','straight:17','straight:17'];
  for(const k of keys)await x.tap(`[data-zone-key="${k}"]`);
  [bal,table]=await read();const stake=cents(table)-onTable0;
  assert.ok(stake>0,'chips were placed');
  assert.equal(cents(bal),start,`Balance must not drop when chips are placed (shown ${bal})`);
  assert.ok(await x.click('SPIN'),'spin pressed');await sleep(150);
  [bal,table]=await read();
  assert.equal(cents(bal),start-cents(table),`Spin deducts the stake (shown ${bal})`);
  // wait for the round to settle and return to idle
  const seen=[];
  for(let i=0;i<300;i++){await sleep(100);seen.push(cents((await read())[0]));const ready=await x.ev(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='SPIN'&&!b.disabled)`);if(ready)break;await x.click('Collect winnings').catch(()=>{});await x.ev(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>/^Collect/.test(b.textContent.trim()));b&&b.click()})()`)}
  await sleep(300);
  const after=await server();[bal,table]=await read();
  assert.ok(cents(table)>0,'chips persist on the table');
  assert.equal(cents(bal),after,`settled Balance = server ${after} with chips on table (shown ${bal})`);
  const low=Math.min(...seen);const li=seen.indexOf(low);for(let i=li+1;i<seen.length;i++)assert.ok(seen[i]>=seen[i-1],`balance only counts up once the win starts paying (no flash back down): ${seen.slice(li)}`);assert.ok(low>=start-stake,`balance never deducted twice during the round (low ${low}, start ${start}, stake ${stake}, seen ${[...new Set(seen)].slice(0,40)})`);
  assert.deepEqual(x.errors,[]);await x.close();
  console.log('PASS balance display',w,h,{start,stake,after,won:after>start-stake,onTable:table});
}})().catch(e=>{console.error(e);process.exit(1)});
