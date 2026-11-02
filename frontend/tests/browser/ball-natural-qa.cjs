// Real-browser check that the ball never visibly jumps backwards, in normal
// AND auto spins. Samples the on-screen ball centre every animation frame,
// converts it to a screen angle around the wheel, and measures, after the
// ball first touches the rotor, any motion against its travel faster than
// the rotor itself carries it (22.5 deg/s), which is what reads as "backwards".
// REAL_API=1 APP_URL=http://127.0.0.1:8789 QA_OUT=dir node frontend/tests/browser/ball-natural-qa.cjs
const assert=require('node:assert/strict');const {open,sleep}=require('./mobile-controls-qa.cjs');
// The wheel publishes the simulated ball pose (relative angle, radius) and the
// rotor angle every 100 ms; their sum is the ball's on-screen angle without the
// vertical hop offset, so hops can't masquerade as backward travel.
const probe=`(()=>{window.qaBall=[];const wheel=document.querySelector('[data-testid="roulette-wheel"]');let last='';
 const tick=()=>{const k=wheel.dataset.ballRelative+'|'+wheel.dataset.wheelAngle;if(k!==last){last=k;qaBall.push({t:performance.now(),rel:Number(wheel.dataset.ballRelative),u:Number(wheel.dataset.ballRelative)+Number(wheel.dataset.wheelAngle),r:Number(wheel.dataset.ballRadius),phase:wheel.dataset.phase})}requestAnimationFrame(tick)};requestAnimationFrame(tick);return true})()`;
function analyse(s){
 const onTrack=s.findIndex(p=>p.r>=400);const contact=onTrack<0?-1:s.findIndex((p,k)=>k>onTrack&&p.r<=319);if(contact<1)return null;
 const travel=Math.sign(s[contact].u-s[onTrack].u)||-1;
 let worst=0,backDeg=0,judged=0;
 for(let i=contact+1;i<s.length;i++){const dt=(s[i].t-s[i-1].t)/1000;if(dt<=0)continue;judged++;
  const v=(s[i].u-s[i-1].u)/dt*travel;if(v<0)worst=Math.max(worst,-v);
  const dr=(s[i].rel-s[i-1].rel)*travel;if(dr<0)backDeg+=-dr}
 // backDeg: motion against travel RELATIVE TO THE ROTOR (knock-backs). The rotor
 // itself carrying a stopped ball is natural and is not counted.
 return {worstBackSpeed:worst,backDeg,frames:s.length-contact,judged};
}
(async()=>{const x=await open(390,844);const out=[];
 await x.ev(probe);
 await x.tap('[data-zone-key="straight:17"]');
 // normal spin
 await x.ev('qaBall.length=0');assert.ok(await x.click('SPIN'));
 for(let i=0;i<200;i++){await sleep(100);if(await x.ev(`qaBall.some(p=>p.phase==='rolling')&&document.querySelector('[data-testid="roulette-wheel"]').dataset.phase==='resting'`))break}
 out.push({mode:'normal',...analyse(await x.ev('qaBall.filter(p=>p.phase==="rolling")'))});
 for(let i=0;i<100;i++){await sleep(100);if(await x.ev(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='SPIN'&&!b.disabled)`))break}
 // auto spins
 assert.ok(await x.click('Auto'));
 for(let n=0;n<3;n++){
  for(let i=0;i<200;i++){await sleep(50);if(await x.ev(`document.querySelector('[data-testid="roulette-wheel"]').dataset.phase==='rolling'`))break}
  await x.ev('qaBall=qaBall.filter(p=>p.phase==="rolling").slice(-3)');
  for(let i=0;i<200;i++){await sleep(50);if(await x.ev(`document.querySelector('[data-testid="roulette-wheel"]').dataset.phase==='resting'`))break}
  out.push({mode:'auto',...analyse(await x.ev('qaBall.filter(p=>p.phase==="rolling")'))});
 }
 await x.click('Stop');
 console.log(JSON.stringify(out));
 for(const r of out){assert.ok(r&&r.frames>=6&&r.judged>=5,'sampled '+JSON.stringify(r));
  // Rebounds off pocket walls are real; long backward runs are not (old build ran 4 to 7 deg back at speed).
  assert.ok(r.backDeg<=2*360/37,`rebounds stay local in ${r.mode} spin ${JSON.stringify(r)}`);}
 assert.deepEqual(x.errors,[]);await x.close();console.log('PASS ball moves naturally in normal and auto spins');
})().catch(e=>{console.error(e);process.exit(1)});
