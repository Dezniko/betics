import test from 'node:test';
import assert from 'node:assert/strict';

test('opening call waits for phase reopening; stale opening calls are cancelled',async()=>{
 const log=[],clips=[];
 globalThis.Audio=class {
  constructor(src){this.src=src;this.events={};clips.push(this);}
  addEventListener(name,fn){this.events[name]=fn;}
  play(){log.push(this.src);return Promise.resolve();}
  pause(){this.paused=true;}
  end(){this.events.ended?.();}
 };
 const {playVoice,setBettingOpen}=await import('../src/voice.js');
 const flush=()=>new Promise(r=>setImmediate(r));
 setBettingOpen(false);
 const result=playVoice('20');await flush();
 assert.deepEqual(log,['/voice/godspower/20.mp3']);
 clips.at(-1).end();await result;await flush();
 assert.deepEqual(log,['/voice/godspower/20.mp3'],'no place-bets while popup/transfer remain busy');
 setBettingOpen(true);await flush();assert.equal(log.at(-1),'/voice/godspower/place_bets.mp3');
 setBettingOpen(false);assert.ok(clips.at(-1).paused,'new spin cuts off opening voice');
 const next=playVoice('no_more_bets');await flush();
 setBettingOpen(true);setBettingOpen(false); // a new spin before queue becomes free
 clips.at(-1).end();await next;await flush();
 assert.deepEqual(log,['/voice/godspower/20.mp3','/voice/godspower/place_bets.mp3','/voice/godspower/no_more_bets.mp3']);
});

test('selected female dealer uses recorded female lines, obeys volume and stops immediately on mute',async()=>{
 const clips=[];globalThis.Audio=class{constructor(src){this.src=src;this.events={};clips.push(this)}addEventListener(n,fn){this.events[n]=fn}play(){return Promise.resolve()}pause(){this.paused=true}};
 const {setAudioSettings}=await import('../src/audioSettings.js');const {playVoice}=await import('../src/voice.js');
 setAudioSettings({voice:'female',volume:0.5,muted:false});const p=playVoice('17');await new Promise(r=>setImmediate(r));assert.equal(clips.at(-1).src,'/voice/female/17.mp3');assert.equal(clips.at(-1).volume,0.425);setAudioSettings({muted:true});await p;assert.ok(clips.at(-1).paused);setAudioSettings({voice:'male',volume:1,muted:false});
});
