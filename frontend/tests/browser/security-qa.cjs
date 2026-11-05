const fs=require('fs'),assert=require('assert/strict');
const fixture=fs.readFileSync(require('path').join(__dirname,'fixture.js'),'utf8');
const APP_URL=process.env.APP_URL||'http://127.0.0.1:5189';
const CDP_URL=process.env.CDP_URL||'http://localhost:9354';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function open(mode){
 const page=await(await fetch(CDP_URL+'/json/new?about:blank',{method:'PUT'})).json();const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);let id=0;const pending=new Map(),errors=[];
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result)}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text)};
 const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}))});
 const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value};
 await send('Runtime.enable');await send('Page.enable');await send('Page.addScriptToEvaluateOnNewDocument',{source:fixture});await send('Page.navigate',{url:APP_URL+'/roulette?mode='+mode});await sleep(1000);
 const click=txt=>ev(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>(b.textContent.trim()===${JSON.stringify(txt)}||b.getAttribute('aria-label')===${JSON.stringify(txt)}));if(!b||b.disabled)return false;b.click();return true})()`);
 const bet=()=>ev(`document.querySelector('button[title="Straight: 17"]').click()`);
 return{ws,send,ev,click,bet,errors};
}
(async()=>{
 {const x=await open('delayed');await x.bet();assert.equal(await x.ev(`document.querySelector('button[title="Spin (Space)"]').disabled`),true);assert.equal(await x.click('Auto'),false);assert.equal(await x.ev('audit.requests.length'),0);await x.ev('releaseCommitment()');await sleep(500);assert.equal(await x.ev(`document.querySelector('button[title="Spin (Space)"]').disabled`),false);assert.deepEqual(x.errors,[]);x.ws.close();console.log('PASS delayed commitment blocks manual + auto wagers');}
 {const x=await open('seed-save');await x.bet();await x.click('How is this verified as fair?');await sleep(200);await x.ev(`(()=>{const i=document.querySelector('input[aria-label="Your client seed"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,"player's updated seed");i.dispatchEvent(new Event('input',{bubbles:true}))})()`);assert.ok(await x.click('Save'));await sleep(100);assert.equal(await x.ev(`document.querySelector('button[title="Spin (Space)"]').disabled`),true);await x.ev('window.dispatchEvent(new KeyboardEvent("keydown",{key:" ",bubbles:true}))');assert.equal(await x.ev('audit.requests.length'),0);await x.ev('releaseSeed()');await sleep(500);assert.equal(await x.ev(`document.querySelector('button[title="Spin (Space)"]').disabled`),false);assert.deepEqual(x.errors,[]);x.ws.close();console.log('PASS in-flight seed save blocks Spin + Space shortcut');}
 {const x=await open('valid');await x.bet();await x.click('SPIN');for(let i=0;i<200;i++){await sleep(100);await x.click('Skip ahead');await x.click('Collect winnings');if(await x.ev(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='SPIN'&&!b.disabled)`))break;}
 const hold=()=>x.ev(`window.originalDigest=crypto.subtle.digest.bind(crypto.subtle);window.pendingDigests=[];crypto.subtle.digest=(...args)=>new Promise(r=>pendingDigests.push(()=>r(originalDigest(...args))))`);
 const release=()=>x.ev(`crypto.subtle.digest=originalDigest;pendingDigests.forEach(r=>r())`);
 await hold();await x.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Verify this outcome independently')).click()`);await sleep(150);
 const manualDisabled=await x.ev(`document.querySelector('button[title="Spin (Space)"]').disabled`);await release();await sleep(200);await x.click('Close');await sleep(250);
 await x.click('Auto');await sleep(150);await hold();await x.ev(`document.querySelector('[title="Click for the full breakdown"]').click()`);await sleep(100);await x.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Verify this outcome independently')).click()`);await sleep(100);
 const autoPaused=await x.ev(`![...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Stop')`);await x.click('Stop');await release();await sleep(200);x.ws.close();assert.ok(manualDisabled&&autoPaused,JSON.stringify({manualDisabled,autoPaused}));console.log('PASS pending manual verification blocks wagers and pauses auto immediately');}
 for(const mode of ['substitution','wrong-pocket','crypto-error']){
  const x=await open(mode);await x.bet();assert.ok(await x.click('Auto'));
  for(let i=0;i<130;i++){await sleep(100);await x.click('Skip ahead');await x.click('Collect winnings');if(await x.ev(`document.body.innerText.includes('Verify this outcome independently')`))break;}
  assert.equal(await x.ev('audit.requests.length'),1);assert.ok(await x.ev('audit.savedBeforePost'));
  assert.equal(await x.ev(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Stop')`),false);
  assert.ok(await x.ev(`document.querySelector('button[title="Spin (Space)"]').disabled`));
  const clicked=await x.ev(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Verify this outcome independently'));if(!b)return false;b.click();return true})()`);assert.ok(clicked);await sleep(300);
  const status=await x.ev(`document.querySelector('[data-testid=fairness-sheet]')?.dataset.status`);
  assert.equal(status,mode==='crypto-error'?'error':'mismatch',`fairness sheet verdict ${status}`);
  await sleep(2500);assert.equal(await x.ev('audit.requests.length'),1);assert.deepEqual(x.errors,[]);x.ws.close();console.log('PASS',mode,'=> auto stopped, betting blocked, detailed verification rejects');
 }
 for(const mode of ['bad-next','reused-next']){
  const x=await open(mode);await x.bet();assert.ok(await x.click('Auto'));
  for(let i=0;i<140;i++){await sleep(100);await x.click('Skip ahead');await x.click('Collect winnings');if(await x.ev(`document.body.innerText.includes('Verify this outcome independently')`))break;}
  assert.equal(await x.ev('audit.requests.length'),1);assert.ok(await x.ev(`document.querySelector('button[title="Spin (Space)"]').disabled`));
  assert.ok(await x.ev(`document.body.innerText.includes('This round is verified, but the next commitment')`));
  assert.ok(await x.ev(`document.body.innerText.includes('Outcome and payout verified in your browser')`));
  await x.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Verify this outcome independently')).click()`);await sleep(200);
  assert.equal(await x.ev(`document.querySelector('[data-testid=fairness-sheet]')?.dataset.status`),'verified');
  await sleep(2200);assert.equal(await x.ev('audit.requests.length'),1);assert.deepEqual(x.errors,[]);x.ws.close();console.log('PASS',mode,'=> next betting blocked; current proof stays consistently verified');
 }
 // Audit F1: the right winning number with the wrong money stops betting.
 for(const mode of ['stake-change','mode-change','short-balance']){
  const x=await open(mode);await x.bet();assert.ok(await x.click('Auto'));
  for(let i=0;i<140;i++){await sleep(100);await x.click('Skip ahead');await x.click('Collect winnings');if(await x.ev(`document.body.innerText.includes('Payout check failed')`))break;}
  assert.equal(await x.ev('audit.requests.length'),1,'auto-bet stopped after one round');
  assert.ok(await x.ev(`document.querySelector('button[title="Spin (Space)"]').disabled`),'betting blocked');
  assert.ok(await x.ev(`document.body.innerText.includes('Payout check failed')`));
  assert.equal(await x.ev(`document.body.innerText.includes('Outcome and payout verified in your browser')`),false);
  await sleep(2000);assert.equal(await x.ev('audit.requests.length'),1);x.ws.close();console.log('PASS',mode,'=> payout check fails, auto stopped, betting blocked');
 }
 // Audit F2: a new lock whose old key does not fit is refused and betting stops; a good one is accepted.
 for(const mode of ['bad-rotate','valid']){
  const x=await open(mode);await x.click('How is this verified as fair?');await sleep(300);
  assert.ok(await x.ev(`(()=>{const b=document.querySelector('[data-testid=rotate-lock]');if(!b||b.disabled)return false;b.click();return true})()`),'rotate clicked');
  await sleep(900);
  const fits=await x.ev(`document.querySelector('[data-testid=retired-lock]')?.dataset.fits`);
  const blocked=await x.ev(`document.querySelector('button[title="Spin (Space)"]').disabled`);
  if(mode==='bad-rotate'){assert.equal(fits,'no');assert.ok(blocked,'betting blocked after a bad old key');assert.ok(await x.ev(`document.body.innerText.includes('does not fit the old lock. Betting is stopped')`));}
  else{assert.equal(fits,'yes');await x.click('Close');await sleep(200);await x.bet();await sleep(200);assert.equal(await x.ev(`document.querySelector('button[title="Spin (Space)"]').disabled`),false,'good rotation keeps betting open');}
  assert.equal(await x.ev('audit.requests.length'),0);x.ws.close();console.log('PASS',mode,'rotation =>',mode==='bad-rotate'?'refused, betting stopped':'accepted');
 }
 console.log('ALL ADVERSARIAL UI REGRESSIONS PASSED (controlled fixture, not live backend)');
})().catch(e=>{console.error(e);process.exit(1)});
