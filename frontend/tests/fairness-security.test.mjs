import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as api from '../src/fairnessClient.js';
const {verifyOutcomeClientSide,standaloneVerifyScript}=api;
import { deriveOutcome } from '../../backend/src/core/fairness.js';
const hash=s=>createHash('sha256').update(s).digest('hex');
const original='original secret committed before wager';
const expected={requestId:'123e4567-e89b-42d3-a456-426614174000',serverSeedHash:hash(original),clientSeed:"player's seed:browser-entropy",nonce:0};
const input={serverSeed:original,serverSeedHash:expected.serverSeedHash,clientSeed:expected.clientSeed,nonce:0,max:37,requestId:expected.requestId};
input.pocket=deriveOutcome(input.serverSeed,input.clientSeed,0,37);
test('reject internally consistent replacement seed/hash/outcome against pre-bet receipt',async()=>{
 const seed='substituted secret';const forged={...input,serverSeed:seed,serverSeedHash:hash(seed)};
 forged.pocket=deriveOutcome(seed,forged.clientSeed,0,37);
 const verdict=await verifyOutcomeClientSide({...forged,expected});
 assert.equal(verdict.ok,false);
});
test('one verdict checks original inputs AND recorded pocket; old rounds remain unrecorded',async()=>{
 assert.equal((await verifyOutcomeClientSide({...input,expected})).ok,true);
 for(const change of [{pocket:(input.pocket+1)%37},{clientSeed:'changed'},{nonce:1},{requestId:'another-request'}]){
  assert.equal((await verifyOutcomeClientSide({...input,...change,expected})).ok,false);
 }
 const old=await verifyOutcomeClientSide(input);assert.equal(old.ok,false);assert.equal(old.status,'unrecorded');
});
test('copied command never embeds seed data or shell-interpretable input',()=>{
 const command=standaloneVerifyScript({...input,clientSeed:"player's seed; $(printf INJECTED)"});
 assert.equal(command,'node verify-roulette.mjs round-proof.json');
});
test('round request requires a valid commitment and freezes fresh browser inputs before posting',()=>{
 assert.equal(typeof api.createRoundRequest,'function');
 const commitment={serverSeedHash:hash(original),clientSeed:'chosen seed',nonce:0};
 assert.throws(()=>api.createRoundRequest(null,[],1),/commitment/i);
 const a=api.createRoundRequest(commitment,[{type:'red',amountCents:100}],1);
 const b=api.createRoundRequest(commitment,[{type:'red',amountCents:100}],1);
 assert.notEqual(a.body.requestId,b.body.requestId);assert.notEqual(a.body.clientEntropy,b.body.clientEntropy);
 assert.match(a.body.clientEntropy,/^[a-f0-9]{64}$/);
 assert.equal(a.expected.clientSeed,'chosen seed:'+a.body.clientEntropy);
 commitment.serverSeedHash=hash('changed');
 assert.equal(a.expected.serverSeedHash,hash(original));
 assert.equal(a.body.expectedCommitment.serverSeedHash,hash(original));
 assert.ok(Object.isFrozen(a.expected));
});
test('browser receipt survives reload and cannot be confused with another request/round',()=>{
 assert.equal(typeof api.saveRoundReceipt,'function');assert.equal(typeof api.readRoundReceipt,'function');
 const map=new Map(),storage={setItem:(k,v)=>map.set(k,v),getItem:k=>map.get(k)??null};
 api.saveRoundReceipt(expected,null,storage);
 assert.deepEqual(api.readRoundReceipt(expected.requestId,9,storage),expected);
 api.saveRoundReceipt(expected,9,storage);
 assert.deepEqual(api.readRoundReceipt(expected.requestId,9,storage),expected);
 assert.equal(api.readRoundReceipt(expected.requestId,10,storage),null);
 assert.equal(api.readRoundReceipt('unknown',9,storage),null);
 assert.throws(()=>api.saveRoundReceipt(expected,null,{setItem(){throw Error('blocked')},getItem:()=>null,removeItem(){},key:()=>null,length:0}),/could not be saved/);
});
test('downloadable verifier executes safely on quoted data and rejects wrong pockets and missing receipts',()=>{
 const script=fileURLToPath(new URL('../public/verify-roulette.mjs',import.meta.url));assert.ok(existsSync(script));
 const dir=mkdtempSync(join((process.env.TMPDIR||'/tmp')+'/','fairness-proof-'));
 try {
  const file=join(dir,'round-proof.json');
  const proof={version:1,expected,result:{...input}};
  writeFileSync(file,JSON.stringify(proof));
  let run=spawnSync(process.execPath,[script,file],{encoding:'utf8'});assert.equal(run.status,0,run.stdout+run.stderr);assert.match(run.stdout,/VERIFIED/);
  writeFileSync(file,JSON.stringify({...proof,result:{...input,pocket:(input.pocket+1)%37}}));
  run=spawnSync(process.execPath,[script,file],{encoding:'utf8'});assert.equal(run.status,1);assert.match(run.stdout,/MISMATCH/);
  writeFileSync(file,JSON.stringify({...proof,expected:null}));
  run=spawnSync(process.execPath,[script,file],{encoding:'utf8'});assert.equal(run.status,1);assert.match(run.stdout,/UNRECORDED/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('next-round readiness rejects exposed secrets without changing current-round proof validity',async()=>{
 assert.equal(typeof api.isNextCommitmentSafe,'function');
 assert.equal(typeof api.rememberRevealedSeed,'function');
 const prior={...expected,clientSeedBase:'base'};
 const next={serverSeedHash:hash('new secret'),clientSeed:'base',nonce:0};
 const map=new Map(),storage={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v)};
 const seen=api.rememberRevealedSeed(prior.serverSeedHash,storage);
 assert.ok(api.isNextCommitmentSafe(next,prior,seen));
 assert.equal(api.isNextCommitmentSafe({...next,serverSeedHash:prior.serverSeedHash},prior,seen),false);
 const older=hash('older revealed secret');api.rememberRevealedSeed(older,storage);
 assert.equal(api.isNextCommitmentSafe({...next,serverSeedHash:older},prior,api.readRevealedHashes(storage)),false);
 assert.equal(api.isNextCommitmentSafe({...next,clientSeed:'changed'},prior,seen),false);
 assert.equal((await verifyOutcomeClientSide({...input,expected})).ok,true);
});
test('round gate blocks unloaded commitments, pending seed saves and verification failures',()=>{
 assert.equal(typeof api.canStartRound,'function');
 const c={serverSeedHash:hash(original),clientSeed:'seed',nonce:0};
 assert.equal(api.canStartRound({commitment:c}),true);
 for(const extra of [{commitment:null},{busy:true},{saving:true},{failed:true},{checking:true}]){
  assert.equal(api.canStartRound({commitment:c,...extra}),false);
 }
});
