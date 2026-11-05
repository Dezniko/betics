const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const OUT=process.env.QA_OUT||require('os').tmpdir()+'/mobile5-performance';fs.mkdirSync(OUT,{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const target=await(await fetch('http://localhost:9354/json/new?about:blank',{method:'PUT'})).json(),ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
 let id=0;const pending=new Map(),frames=[],errors=[];
 const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}))});
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result)}if(m.method==='Page.screencastFrame'){frames.push({time:Date.now(),data:m.params.data});send('Page.screencastFrameAck',{sessionId:m.params.sessionId})}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text)};
 const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value};
 await send('Page.enable');await send('Runtime.enable');await send('Emulation.setDeviceMetricsOverride',{width:874,height:298,deviceScaleFactor:2,mobile:true});await send('Emulation.setCPUThrottlingRate',{rate:4});
 if(!process.env.REAL_API)await send('Page.addScriptToEvaluateOnNewDocument',{source:fs.readFileSync(path.join(__dirname,'fixture.js'),'utf8')});
 await send('Page.navigate',{url:(process.env.APP_URL||'http://127.0.0.1:5189')+'/roulette?mode=valid'});
 for(let i=0;i<120;i++){await sleep(100);if(await ev(`!!document.querySelector('[data-testid="wheel-rotor"]')`))break}
 await sleep(600);
 await ev(`window.qaRotorChanges=0;new MutationObserver(ms=>{qaRotorChanges+=ms.length}).observe(document.querySelector('[data-testid="wheel-rotor"]'),{attributes:true})`);await sleep(650);const changes=await ev('qaRotorChanges');
 await send('Page.startScreencast',{format:'jpeg',quality:45,maxWidth:600,maxHeight:300,everyNthFrame:1});await sleep(400);
 const start=Date.now();await ev(`(()=>{const end=performance.now()+450;while(performance.now()<end){}return true})()`);const end=Date.now();await sleep(150);await send('Page.stopScreencast');
 const during=frames.filter(f=>f.time>start+50&&f.time<end-25);during.slice(0,8).forEach((f,i)=>fs.writeFileSync(path.join(OUT,`compositor-during-js-block-${i}.jpg`),Buffer.from(f.data,'base64')));
 const report={cpuThrottle:4,rotorAttributeChangesIn650ms:changes,mainThreadBlockMs:end-start,compositorFramesDuringBlock:during.length,framesTotal:frames.length,errors};fs.writeFileSync(path.join(OUT,'performance.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));await send('Emulation.setCPUThrottlingRate',{rate:1});await fetch('http://localhost:9354/json/close/'+target.id);ws.close();
 if(!process.env.BASELINE){assert.ok(changes<=1,'Rotor must not be redrawn through per-frame SVG attribute mutation');assert.ok(during.length>=3,'Wheel must keep compositing while the JS main thread is blocked');assert.deepEqual(errors,[])}
})().catch(e=>{console.error(e);process.exit(1)});
