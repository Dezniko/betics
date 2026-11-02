// Dealer recordings include number, colour and parity in ONE complete clip.
// Decode into the gesture-unlocked context: delayed new HTML media elements
// are not reliably autoplay-authorized on iPhone Safari.
import { createManagedAudio, releaseManagedAudio, voiceClipUrl, getAudioEngine, effectiveVolume, getAudioSettings, subscribeAudioSettings } from './audioSettings.js';
let queue=Promise.resolve(),bettingOpen=false,openingGeneration=0,current=null,preferenceGeneration=0;
const buffers=new Map();
let previousPreferences=getAudioSettings();
subscribeAudioSettings(()=>{const now=getAudioSettings();if(effectiveVolume()===0||now.voice!==previousPreferences.voice){preferenceGeneration++;current?.stop()}previousPreferences=now});
function prepare(name){
 const engine=getAudioEngine();if(!engine?.context?.decodeAudioData)return Promise.resolve(null);
 const url=voiceClipUrl(name);
 if(!buffers.has(url))buffers.set(url,(async()=>{const response=await fetch(url);if(!response.ok)throw Error('Dealer recording unavailable');return engine.context.decodeAudioData(await response.arrayBuffer())})().catch(()=>{buffers.delete(url);return null}));
 return buffers.get(url);
}
export const prepareNumberCallout=pocket=>prepare(String(pocket));
function playOne(name){
 return new Promise(resolve=>{
  let timer,audio,source,gain,finished=false;const generation=preferenceGeneration;
  const finish=()=>{if(finished)return;finished=true;clearTimeout(timer);if(audio){audio.pause?.();releaseManagedAudio(audio)}if(source){source.onended=null;try{source.stop()}catch{}source.disconnect()}gain?.disconnect();if(current?.stop===finish)current=null;resolve()};
  current={name,stop:finish};
  if(effectiveVolume()===0){finish();return}
  const native=()=>{try{audio=createManagedAudio(voiceClipUrl(name),.85,{kind:'voice',onStop:finish});if(!audio){finish();return}audio.addEventListener('ended',finish,{once:true});audio.addEventListener('error',finish,{once:true});timer=setTimeout(finish,10000);audio.play().catch(finish)}catch{finish()}};
  const engine=getAudioEngine();
  if(!engine?.context?.decodeAudioData){native();return}
  timer=setTimeout(finish,5000);
  (async()=>{
   const buffer=await prepare(name);
   if(finished||generation!==preferenceGeneration||effectiveVolume()===0){finish();return}
   if(!buffer){clearTimeout(timer);native();return}
   const ctx=engine.context;if(ctx.state!=='running')await ctx.resume?.();if(finished)return;
   gain=ctx.createGain();gain.gain.setValueAtTime(.85,ctx.currentTime);gain.connect(engine.output);
   source=ctx.createBufferSource();source.buffer=buffer;source.connect(gain);source.onended=finish;
   clearTimeout(timer);timer=setTimeout(finish,Math.max(1000,(buffer.duration+.75)*1000));source.start();
  })().catch(finish);
 });
}
export function playVoice(...names){queue=queue.then(async()=>{for(const name of names)await playOne(name)});return queue}
export function setBettingOpen(open){
 if(open===bettingOpen)return;bettingOpen=open;const generation=++openingGeneration;
 if(!open){if(current?.name==='place_bets')current.stop();return}
 queue=queue.then(()=>{if(bettingOpen&&generation===openingGeneration)return playOne('place_bets')});
}
export const playNumberCallout=pocket=>playVoice(String(pocket));
