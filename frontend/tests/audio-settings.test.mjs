import test from 'node:test';
import assert from 'node:assert/strict';

let seq=0;
async function setup(){
 const map=new Map();globalThis.window={localStorage:{getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v)}};
 const clips=[];globalThis.Audio=class{constructor(src){this.src=src;this.events={};clips.push(this)}addEventListener(e,fn){this.events[e]=fn}play(){this.played=true;return Promise.resolve()}pause(){this.paused=true}};
 const api=await import(`../src/audioSettings.js?case=${seq++}`);return{api,clips,map};
}
test('audio preferences persist, clamp volume, and accept only fixed male/female choices',async()=>{
 const {api,map}=await setup();api.setAudioSettings({volume:0.35,voice:'female'});assert.equal(api.getAudioSettings().volume,0.35);assert.equal(api.getAudioSettings().voice,'female');assert.equal(JSON.parse(map.get('noir:audio:v1')).voice,'female');
 api.setAudioSettings({volume:7,voice:'../../bad'});assert.equal(api.getAudioSettings().volume,1);assert.equal(api.getAudioSettings().voice,'female');
});
test('mute and volume affect active HTML clips immediately without replaying stale audio',async()=>{
 const {api}=await setup();const a=api.createManagedAudio('/sfx/ballSpin_1.mp3',0.6);api.setAudioSettings({volume:0.5});assert.equal(a.volume,0.3);api.setAudioSettings({muted:true});assert.equal(a.volume,0);assert.ok(a.paused);assert.equal(api.createManagedAudio('/voice/1.mp3'),null);api.setAudioSettings({muted:false});assert.ok(a.paused);
});
test('Web Audio master follows mute and volume, including already playing buffers',async()=>{
 const {api}=await setup();const gain={gain:{value:1,setValueAtTime(v){this.value=v}},connect(){}};const ctx={currentTime:0,destination:{},createGain:()=>gain};assert.equal(api.connectAudioMaster(ctx),gain);api.setAudioSettings({volume:0.2});assert.equal(gain.gain.value,0.2);api.setAudioSettings({muted:true});assert.equal(gain.gain.value,0);
});
test('recorded media routes through Web Audio instead of relying on iPhone media volume',async()=>{
 const {api}=await setup();const nodes=[];const make=()=>{const n={gain:{value:1,setValueAtTime(v){this.value=v}},connect(to){this.to=to;return to},disconnect(){}};nodes.push(n);return n};
 const ctx={currentTime:0,destination:{},createGain:make,createMediaElementSource:()=>({connect(to){this.to=to;return to},disconnect(){}})};
 api.connectAudioMaster(ctx);const a=api.createManagedAudio('/voice/female/1.mp3',0.85,{kind:'voice'});api.setAudioSettings({volume:0.3});assert.equal(a.volume,1);assert.equal(nodes[0].gain.value,0.3);assert.equal(nodes[1].gain.value,0.85);assert.equal(nodes[1].to,nodes[0]);
});
test('female selection resolves to its own recorded asset set and stops an old voice',async()=>{
 const {api}=await setup();let ended=false;const a=api.createManagedAudio('/voice/1.mp3',1,{kind:'voice',onStop:()=>ended=true});api.setAudioSettings({voice:'female'});assert.ok(a.paused&&ended);assert.equal(api.voiceClipUrl('17'),'/voice/female/17.mp3');assert.equal(api.voiceClipUrl('preview'),'/voice/female/preview.mp3');
});

test('GodsPower is the default dealer voice, also for players whose settings were saved before it existed', async () => {
  const { api } = await setup();
  assert.equal(api.getAudioSettings().voice, 'godspower');
  assert.equal(api.voiceClipUrl('17'), '/voice/godspower/17.mp3');
  api.setAudioSettings({ voice: 'male' }); assert.equal(api.voiceClipUrl('17'), '/voice/17.mp3');
  api.setAudioSettings({ voice: 'female' }); assert.equal(api.voiceClipUrl('17'), '/voice/female/17.mp3');
  assert.deepEqual(api.DEALER_VOICES.map(([, l]) => l), ['GodsPower', 'Man', 'Woman']);
});

test('old saved settings keep volume but move to GodsPower; a voice chosen since is kept', async () => {
  const load = async (saved) => { const map = new Map([['noir:audio:v1', JSON.stringify(saved)]]); globalThis.window = { localStorage: { getItem: k => map.get(k) || null, setItem: (k, v) => map.set(k, v) } }; return (await import(`../src/audioSettings.js?case=${seq++}`)).getAudioSettings(); };
  const old = await load({ muted: false, volume: 0.4, voice: 'male' });
  assert.equal(old.voice, 'godspower'); assert.equal(old.volume, 0.4);
  assert.equal((await load({ muted: false, volume: 1, voice: 'male', v: 2 })).voice, 'male');
});
