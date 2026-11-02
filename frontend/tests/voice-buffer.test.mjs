import test from 'node:test';
import assert from 'node:assert/strict';
import {connectAudioMaster} from '../src/audioSettings.js';
import * as voice from '../src/voice.js';

test('delayed result call uses decoded audio after gesture unlock, not a new Safari-blocked media element',async()=>{
 const starts=[],fetches=[];
 globalThis.Audio=class{constructor(){throw Error('New delayed media element is not gesture-authorized')}};
 globalThis.fetch=async url=>{fetches.push(url);return{ok:true,arrayBuffer:async()=>({url})}};
 const gain=()=>({gain:{setValueAtTime(){}},connect(){return this},disconnect(){}});
 const ctx={state:'running',currentTime:0,destination:{},createGain:gain,decodeAudioData:async b=>({duration:.01,url:b.url}),createBufferSource(){return{connect(){return this},disconnect(){},start(){starts.push(this.buffer.url);queueMicrotask(()=>this.onended?.())},stop(){}}}};
 connectAudioMaster(ctx);
 assert.equal(typeof voice.prepareNumberCallout,'function');
 await voice.prepareNumberCallout(17);await voice.playNumberCallout(17);
 assert.deepEqual(starts,['/voice/godspower/17.mp3']);assert.deepEqual(fetches,['/voice/godspower/17.mp3']);
});
