// Real win (every straight covered) on a phone viewport: the celebration must
// appear over the felt with the wheel still visible, count up to the exact
// payout, fly chips into the on-screen balance, end with the settled balance,
// and keep a healthy frame rate under 4x CPU throttling.
// REAL_API=1 APP_URL=http://127.0.0.1:8789 QA_OUT=dir node frontend/tests/browser/win-celebration-qa.cjs
const assert=require('node:assert/strict');const {open,sleep}=require('./mobile-controls-qa.cjs');
const cents=s=>Math.round(Number(String(s).replace(/[^0-9.]/g,''))*100);
(async()=>{for(const [w,h] of [[390,844],[874,402],[1440,900]]){const x=await open(w,h);
 if(await x.ev(`!!document.querySelector('.demo-refill')`)){await x.click('Reset demo');await sleep(500);}
 await x.tap('button[title="10 $TICS chip (key 3)"]');
 for(let n=0;n<=36;n++)await x.tap(`[data-zone-key="straight:${n}"]`);
 const before=await x.ev(`fetch('/api/session',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.json()).then(u=>u.balanceCents)`);
 await x.send('Emulation.setCPUThrottlingRate',{rate:4});
 // Baseline: idle main-thread frame rate in this same tab/throttle (headless rAF is itself capped).
 await x.ev(`window.qaFrames=0;(function f(){window.qaFrames++;requestAnimationFrame(f)})();window.qaStart=performance.now()`);
 for(let i=0;i<30;i++){await sleep(50);await x.ev('1')}
 const idle=await x.ev(`({frames:window.qaFrames,ms:performance.now()-window.qaStart})`);const idleFps=idle.frames/(idle.ms/1000);
 assert.ok(await x.click('SPIN'));
 let seen={totaling:false,transferring:false},frames=null,shots=0;
 for(let i=0;i<600;i++){await sleep(50);
  await x.ev(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>/^(Collect|Skip)/.test(b.textContent.trim())&&b.textContent.includes('Collect'));b&&b.click()})()`);
  const st=await x.ev(`(()=>{const c=document.querySelector('[data-testid=win-celebration]');if(!c)return null;const s=c.querySelector('.celebrate-stage').getBoundingClientRect(),wh=document.querySelector('[data-testid=roulette-wheel]').getBoundingClientRect();return{phase:c.dataset.phase,tier:c.dataset.tier,amount:c.querySelector('[data-testid=celebrate-amount]').textContent,stageTop:s.top,wheelBottom:wh.bottom,wheelH:wh.height,chips:c.querySelectorAll('.fly-chip').length}})()`);
  if(st&&!seen[st.phase]){seen[st.phase]=true;
   if(st.phase==='totaling'){await x.ev(`window.qaFrames=0;(function f(){window.qaFrames++;requestAnimationFrame(f)})();window.qaStart=performance.now()`);}
   if(process.env.SHOTS){await sleep(st.phase==='totaling'?500:300);await x.shot(`celebration-${w}x${h}-${st.phase}`);shots++;}
   assert.ok(st.wheelH>80,'wheel stays visible');
   if(st.phase==='transferring')assert.ok(st.chips>0,'chips fly to balance');
   if(st.phase==='totaling'){await sleep(450);const mid=cents(await x.ev(`document.querySelector('[data-testid=celebrate-amount]').textContent`));assert.ok(mid>0,'amount counts up');}
  }
  if(seen.transferring&&!st){frames=await x.ev(`({frames:window.qaFrames,ms:performance.now()-window.qaStart})`);break;}
 }
 await x.send('Emulation.setCPUThrottlingRate',{rate:1});
 assert.ok(seen.totaling&&seen.transferring,'celebration phases shown');
 await sleep(400);
 const after=await x.ev(`fetch('/api/session',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.json()).then(u=>u.balanceCents)`);
 const shown=cents(await x.ev(`[...document.querySelectorAll('[data-balance-target]')].find(e=>e.getBoundingClientRect().width>0).textContent`));
 assert.equal(after,before-37000+36000,'server settled one straight win');assert.equal(shown,after,'balance shows settled amount');
 const fps=frames.frames/(frames.ms/1000);if(!process.env.SHOTS)assert.ok(fps>=idleFps*0.8,`celebration fps ${fps.toFixed(0)} vs idle ${idleFps.toFixed(0)} under 4x CPU`);
 assert.deepEqual(x.errors,[]);
 console.log('PASS win celebration',w,h,{fps:+fps.toFixed(0),idleFps:+idleFps.toFixed(0),shots,after});await x.close();
}})().catch(e=>{console.error(e);process.exit(1)});
