// Synthetic adversarial API fixture ONLY for UI regression tests.
(()=>{
 // Every fixture tab is an isolated simulated browser/session, not live data.
 const audioPrefs=localStorage.getItem('noir:audio:v1');localStorage.clear();if(audioPrefs!==null)localStorage.setItem('noir:audio:v1',audioPrefs);
 const realFetch=window.fetch.bind(window),digest=crypto.subtle.digest.bind(crypto.subtle),sign=crypto.subtle.sign.bind(crypto.subtle),enc=new TextEncoder();
 const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
 const hash=async s=>hex(await digest('SHA-256',enc.encode(s)));
 let seed='fixture-server-0',base='player',balance=100000,round=0,rows=[];
 window.audit={requests:[],mode:new URLSearchParams(location.search).get('mode')||'valid',savedBeforePost:false};
 const promise=(async()=>{window.audit.hash=await hash(seed)})();
 const response=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json'}});
 window.fetch=async(url,options={})=>{
  const path=String(url);if(!path.startsWith('/api/'))return realFetch(url,options);
  await promise;
  const body=options.body?JSON.parse(options.body):{};
  if(path==='/api/session')return response({balanceCents:balance});
  if(path.endsWith('/fairness/commitment')){
   if(audit.mode==='delayed')await new Promise(r=>window.releaseCommitment=r);
   return response({serverSeedHash:await hash(seed),clientSeed:base,nonce:0});
  }
  if(path.endsWith('/fairness/rotate')){
   const old=seed;seed='fixture-rotated-'+(++round);
   return response({retired:{serverSeed:audit.mode==='bad-rotate'?'not-the-old-key':old,serverSeedHash:await hash(old)},commitment:{serverSeedHash:await hash(seed),clientSeed:base,nonce:0}});
  }
  if(path.includes('/client-seed')){
   if(audit.mode==='seed-save')await new Promise(r=>window.releaseSeed=r);
   base=body.clientSeed;return response({serverSeedHash:await hash(seed),clientSeed:base,nonce:0});
  }
  if(path.endsWith('/games/roulette/config'))return response({enabled:true,math:{id:'standard'}});
  if(path.endsWith('/api/events'))return response({ok:true});
  if(path.endsWith('/api/rounds'))return response(rows);
  if(path.endsWith('/api/wallet'))return response({balanceCents:balance});
  if(path.includes('/spin')){
   audit.requests.push(body);audit.savedBeforePost=!!localStorage.getItem('noir:prebet:v1:'+body.requestId);
   if(!Array.isArray(body.bets)||body.bets.length<1||body.bets.length>100)return response({error:'bets must contain 1 to 100 bets'},400);
   let usedSeed=seed;if(audit.mode==='substitution')usedSeed='fixture-substituted-secret';
   const clientSeed=base+':'+body.clientEntropy;
   const key=await crypto.subtle.importKey('raw',enc.encode(usedSeed),{name:'HMAC',hash:'SHA-256'},false,['sign']);
   let pocket;
   for(let i=0;;i++){const bytes=new Uint8Array(await sign('HMAC',key,enc.encode(`${clientSeed}:0:${i}`)));const v=new DataView(bytes.buffer).getUint32(0);if(v<Math.floor(0xffffffff/37)*37){pocket=v%37;break;}}
   if(audit.mode==='wrong-pocket')pocket=(pocket+1)%37;
   const fairness={serverSeed:usedSeed,serverSeedHash:await hash(usedSeed),clientSeed,nonce:0};
   seed='fixture-server-'+(++round);
   fairness.nextCommitment={serverSeedHash:await hash(seed),clientSeed:base,nonce:0};
   if(audit.mode==='bad-next')fairness.nextCommitment={serverSeedHash:'invalid'};
   if(audit.mode==='reused-next')fairness.nextCommitment.serverSeedHash=fairness.serverSeedHash;
   const reds=new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
   const color=pocket===0?'green':reds.has(pocket)?'red':'black';
   const betResults=body.bets.map(b=>{
    let multiple=0;
    if(b.type==='straight'&&b.value===pocket)multiple=36;
    if(Array.isArray(b.value)&&b.value.includes(pocket))multiple=({split:18,trio:12,street:12,corner:9,sixline:6})[b.type]||0;
    if(pocket>0&&((b.type==='red'&&color==='red')||(b.type==='black'&&color==='black')||(b.type==='even'&&pocket%2===0)||(b.type==='odd'&&pocket%2===1)||(b.type==='low'&&pocket<=18)||(b.type==='high'&&pocket>=19)))multiple=2;
    if(pocket>0&&b.type==='dozen'+Math.ceil(pocket/12))multiple=3;
    if(pocket>0&&b.type==='column'+((pocket-1)%3+1))multiple=3;
    return {...b,won:multiple>0,payoutCents:b.amountCents*multiple};
   });
   const stake=body.bets.reduce((a,b)=>a+b.amountCents,0),payout=betResults.reduce((a,b)=>a+b.payoutCents,0);balance+=payout-stake;
   const result={requestId:body.requestId,roundId:round,pocket,color,betResults,totalStakeCents:stake,totalPayoutCents:payout,balanceAfterCents:balance,fairness,mode:body.mode||'demo',mathId:'standard'};
   if(audit.mode==='stake-change')result.totalStakeCents+=100;
   if(audit.mode==='mode-change')result.mode=result.mode==='real'?'demo':'real';
   if(audit.mode==='short-balance'){balance-=100;result.balanceAfterCents=balance;} // a real short credit: the wallet read again shows it too
   rows.unshift({id:round,request_id:body.requestId,server_seed:usedSeed,server_seed_hash:fairness.serverSeedHash,client_seed:clientSeed,nonce:0,stake_cents:stake,payout_cents:payout,status:'settled',created_at:new Date().toISOString(),bet_json:JSON.stringify(body.bets),outcome_json:JSON.stringify({pocket,betResults:result.betResults})});
   if(audit.mode==='crypto-error')crypto.subtle.digest=()=>Promise.reject(Error('test verifier failure'));
   return response(result);
  }
  return response({error:'unknown fixture route'},404);
 };
})();
