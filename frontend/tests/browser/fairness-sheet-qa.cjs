// Fairness UX after a real spin (phone and desktop):
// - Proof opens one picture + one sentence; no emoji, no em/en dashes.
// - "Check it yourself" and "For experts" are real dropdown buttons.
// - The CyberChef link carries every code needed and reproduces the pocket.
// - Opening Proof does not make the dealer say "place your bets" again.
// - How it works: lucky word input is open, and Get a new lock swaps the lock
//   and reveals the unused old key, which fits the old lock.
// REAL_API=1 APP_URL=http://127.0.0.1:8789 QA_OUT=dir node frontend/tests/browser/fairness-sheet-qa.cjs
const assert=require('node:assert/strict');const {createHash,createHmac}=require('node:crypto');
const {open,sleep}=require('./mobile-controls-qa.cjs');
const EMOJI=/\p{Extended_Pictographic}/u, DASH=/[\u2013\u2014]/;
const placeBets=x=>x.ev(`qaVoiceStarts.filter(v=>/place_bets/.test(v.url)).length`);
(async()=>{for(const [w,h] of [[390,844],[1440,900]]){const x=await open(w,h);
 await x.tap('[data-zone-key="straight:17"]');assert.ok(await x.click('SPIN'));
 for(let i=0;i<400;i++){await sleep(100);if(await x.ev(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='SPIN'&&!b.disabled)`))break;}
 for(let i=0;i<60&&!(await placeBets(x));i++)await sleep(100);
 await sleep(2500);const callsBefore=await placeBets(x);assert.ok(callsBefore>=1,'dealer opened betting after the spin (voice hook works)');
 const opened=await x.ev(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>/Proof|Verify this outcome/.test(b.textContent)&&b.getBoundingClientRect().width>0);if(!b)return false;b.click();return true})()`);
 assert.ok(opened,'proof button');
 for(let i=0;i<50;i++){await sleep(100);if(await x.ev(`document.querySelector('[data-testid=fairness-sheet]')?.dataset.status==='verified'`))break;}
 await sleep(2500);
 assert.equal(await placeBets(x),callsBefore,'opening Proof must not repeat "place your bets"');
 const sheet=await x.ev(`(()=>{const s=document.querySelector('[data-testid=fairness-sheet]'),r=s.getBoundingClientRect();return{status:s.dataset.status,tiles:[...s.querySelectorAll('[data-testid=fair-picture] .fair-tile')].map(l=>l.className.replace('fair-tile','').trim()),bottom:r.bottom,width:r.width,text:s.innerText,drops:[...s.querySelectorAll('.fair-drop-btn')].map(b=>{const c=getComputedStyle(b),r=b.getBoundingClientRect();return{tag:b.tagName,label:b.innerText.trim(),h:r.height,bg:c.backgroundColor,chev:!!b.querySelector('svg')}})}})()`);
 assert.equal(sheet.status,'verified',JSON.stringify(sheet));assert.deepEqual(sheet.tiles,['ok','ok','ok']);
 assert.ok(!EMOJI.test(sheet.text),'no emoji in the fairness sheet');assert.ok(!DASH.test(sheet.text),'no em or en dashes');
 assert.deepEqual(sheet.drops.map(d=>d.label),['Check it yourself','For experts']);
 for(const d of sheet.drops){assert.equal(d.tag,'BUTTON');assert.ok(d.h>=44&&d.chev&&d.bg!=='rgba(0, 0, 0, 0)','dropdown looks like a button '+JSON.stringify(d));}
 if(w<1100){assert.ok(Math.abs(sheet.bottom-h)<2&&sheet.width>=w-2,`bottom sheet spans the phone width ${JSON.stringify(sheet)}`);}
 await sleep(300);await x.shot(`fair-${w}-verdict`);
 await x.ev(`document.querySelector('[data-testid=drop-diy]').click()`);await sleep(150);
 await x.ev(`document.querySelector('[data-testid=drop-expert]').click()`);await sleep(300);
 const diy=await x.ev(`(()=>{const s=document.querySelector('[data-testid=fairness-sheet]');const ex=s.querySelectorAll('.fair-expert li');return{pocketLink:s.querySelector('[data-testid=chef-pocket]').href,lockLink:s.querySelector('[data-testid=chef-lock]').href,linkLooks:[...s.querySelectorAll('[data-testid=chef-pocket],[data-testid=chef-lock]')].map(a=>({cls:a.className,h:a.getBoundingClientRect().height})),expected:s.querySelector('[data-testid=seal-expected]').dataset.seal,big:s.querySelector('.fair-big').textContent,ball:s.querySelector('[data-testid=fair-picture] .fair-ball').textContent,codes:[...s.querySelectorAll('[data-testid=fair-diy] .fair-code code')].map(c=>c.textContent),mathText:ex[2].textContent,text:s.innerText}})()`);
 assert.ok(!EMOJI.test(diy.text)&&!DASH.test(diy.text),'opened sections have no emoji or dashes');
 for(const l of diy.linkLooks)assert.ok(/fair-btn/.test(l.cls)&&l.h>=40,'links are shown as buttons '+JSON.stringify(l));
 const [,rec,inp]=diy.pocketLink.match(/#recipe=(.*)&input=(.*)$/);const recipe=decodeURIComponent(rec),message=Buffer.from(decodeURIComponent(inp),'base64').toString('utf8');
 const key=recipe.match(/'string':'([0-9a-f]+)'/)[1];
 const hm=createHmac('sha256',key).update(message).digest('hex'),v=parseInt(hm.slice(0,8),16);const pocket=String(v%37),first8=hm.slice(0,8);
 assert.equal(diy.big,pocket);assert.equal(diy.ball,pocket,'picture shows the pocket the independent recipe gives');
 assert.deepEqual(diy.codes,[key,message,diy.expected],'every code the recipe needs is shown');
 const lockInput=Buffer.from(decodeURIComponent(diy.lockLink.split('&input=')[1]),'base64').toString();
 assert.equal(lockInput,key);assert.equal(createHash('sha256').update(key).digest('hex'),diy.expected,'lock link reproduces the lock shown before the bet');
 assert.ok(diy.mathText.includes(`37 × ${Math.floor(v/37).toLocaleString('en-US')} + ${v%37}`),'expert maths: '+diy.mathText);
 require('fs').writeFileSync(require('path').join(process.env.QA_OUT||'.',`fair-links-${w}.json`),JSON.stringify({pocket,lock:diy.expected,pocketLink:diy.pocketLink,lockLink:diy.lockLink}));
 const scroll=await x.ev(`(()=>{const s=document.querySelector('[data-testid=fairness-sheet]');const before=window.scrollY;s.scrollTop=9999;return{inner:s.scrollTop,can:s.scrollHeight>s.clientHeight,page:window.scrollY===before}})()`);
 assert.ok(scroll.page);if(scroll.can)assert.ok(scroll.inner>0);
 await x.ev(`document.querySelector('[data-testid=fairness-sheet]').scrollTop=0;document.querySelector('[data-testid=fair-diy]').scrollIntoView({block:'start'})`);await sleep(200);await x.shot(`fair-${w}-diy`);
 await x.ev(`[...document.querySelectorAll('[data-testid=fairness-sheet] button')].find(b=>b.textContent.trim()==='Done').click()`);await sleep(600);
 // How it works: open lucky word, rotate the lock.
 await x.ev(`document.querySelector('button[title^="The lock for your next spin"]').click()`);await sleep(700);
 const how=await x.ev(`(()=>{const m=document.querySelector('[data-testid=how-fair]');return{text:m.innerText,input:!!m.querySelector('input[aria-label="Your client seed"]')&&m.querySelector('input[aria-label="Your client seed"]').getBoundingClientRect().height>0,details:m.querySelectorAll('details').length,lock:m.querySelector('[data-testid=next-fingerprint]').textContent}})()`);
 assert.ok(how.input&&how.details===0,'lucky word is open without clicking');assert.ok(!EMOJI.test(how.text)&&!DASH.test(how.text),'how it works has no emoji or dashes');
 const callsBeforeRotate=await placeBets(x);
 await x.ev(`document.querySelector('[data-testid=rotate-lock]').click()`);
 for(let i=0;i<50;i++){await sleep(100);if(await x.ev(`!!document.querySelector('[data-testid=retired-lock]')`))break;}
 const rot=await x.ev(`(()=>{const m=document.querySelector('[data-testid=how-fair]'),r=m.querySelector('[data-testid=retired-lock]');return{lock:m.querySelector('[data-testid=next-fingerprint]').textContent,fits:r.dataset.fits,key:r.querySelector('code').textContent,header:document.querySelector(".commitment-button code")?.textContent}})()`);
 assert.notEqual(rot.lock,how.lock,'a new lock is shown');assert.equal(rot.fits,'yes');
 assert.equal(createHash('sha256').update(rot.key).digest('hex'),how.lock,'revealed old key fits the old lock');
 assert.equal(rot.header,rot.lock.slice(0,8),'header shows the new lock');
 await sleep(1500);assert.equal(await placeBets(x),callsBeforeRotate,'getting a new lock must not repeat "place your bets"');
 await x.shot(`how-${w}-rotated`);
 assert.deepEqual(x.errors,[]);console.log('PASS fairness sheet',w,h,{pocket,first8,newLock:rot.lock.slice(0,10)});await x.close();
}})().catch(e=>{console.error(e);process.exit(1)});
