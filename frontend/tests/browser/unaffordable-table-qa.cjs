// After a loss leaves the balance below the stake still on the table, the table
// must be cleared with a neutral notice: no unaffordable chips, no Spin, no
// "no more bets" call or server insufficient-funds error.
// REAL_API=1 APP_URL=http://127.0.0.1:8789 node frontend/tests/browser/unaffordable-table-qa.cjs
const assert=require('node:assert/strict');const {open,sleep}=require('./mobile-controls-qa.cjs');
const cents=s=>Math.round(Number(String(s).replace(/[^0-9.]/g,''))*100);
(async()=>{const x=await open(390,844);
 const read=()=>x.ev(`[...document.querySelector('.tray-balances').querySelectorAll(':scope > div > div')].map(d=>d.textContent)`);
 const idle=async()=>{for(let i=0;i<400;i++){await sleep(100);await x.ev(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>/^Collect/.test(b.textContent.trim()));b&&b.click()})()`);if(await x.ev(`!!document.querySelector('.demo-refill')&&!document.querySelector('.demo-refill').disabled&&!document.querySelector('[data-testid=roulette-wheel]')?.dataset.phase?.includes('rolling')`))return}throw Error('never idle')};
 // $TICS scale: demo 100,000 $TICS, max bet 50,000. Bet 40,000 on red; two losses leave 20,000 < 40,000 on the table.
 for(let attempt=0;attempt<12;attempt++){
  assert.ok(await x.click('Reset demo'),'reset');await sleep(600);
  assert.equal(cents((await read())[0]),10000000);
  await x.tap('button[title="5K $TICS chip (key 8)"]');
  for(let i=0;i<8;i++)await x.tap('[data-zone-key="red:undefined"]');
  assert.equal(cents((await read())[1]),4000000,'40,000 $TICS on table');
  let bal,table,won=false;
  for(let spin=0;spin<2;spin++){
   await x.ev(`window.qaVoiceStarts.length=0`);
   assert.ok(await x.click('SPIN'));await sleep(500);await idle();await sleep(800);
   [bal,table]=await read();
   if(cents(bal)>=10000000){won=true;break}
  }
  if(won||cents(bal)!==2000000){console.log('a spin won, retrying');continue}
  assert.equal(cents(table),0,`unaffordable chips must be cleared (table ${table})`);
  assert.equal(await x.ev(`document.querySelectorAll('[data-bet-key]').length`),0);
  const notice=await x.ev(`document.querySelector('.game-notice')?.textContent||''`);
  assert.ok(/table was cleared/.test(notice),notice);await x.shot('unaffordable-notice');
  assert.equal(await x.ev(`!!document.querySelector('.game-error')`),false,'no error banner');
  assert.equal(await x.ev(`document.querySelector('button[title="Spin (Space)"]').disabled`),true,'Spin disabled with an empty table');
  // Rebet of the unaffordable bet is refused locally, never sent to the server.
  await x.click('Rebet');await sleep(200);
  assert.equal(cents((await read())[1]),0,'rebet refused');
  // A fresh affordable bet clears the notice and works.
  await x.tap('[data-zone-key="straight:17"]');
  await sleep(700); // the message card fades out
  assert.equal(await x.ev(`!!document.querySelector('.game-notice')`),false);
  assert.deepEqual(x.errors,[]);
  console.log('PASS unaffordable table cleared with notice; spin disabled; rebet refused',{bal,notice});
  await x.close();return;
 }
 throw Error('no two losses in a row in 12 attempts');
})().catch(e=>{console.error(e);process.exit(1)});
