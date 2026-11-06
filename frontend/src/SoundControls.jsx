import { useSyncExternalStore } from 'react';
import { DEALER_VOICES, getAudioSettings, subscribeAudioSettings, setAudioSettings, toggleSound, previewDealerVoice } from './audioSettings.js';
import { ensureAudioContext } from './sound.js';
const useSound = () => useSyncExternalStore(subscribeAudioSettings, getAudioSettings, getAudioSettings);
export function Speaker({ silent, size = 18 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M11 4 6 8H3v8h3l5 4z"/>{silent ? <path d="m16 9 5 6m0-6-5 6"/> : <><path d="M15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/></>}</svg>;
}
// The one tap mute in the header: a round speaker button, same on every page.
export function MuteButton({ className = '', size = 18 }) {
  const state = useSound(), silent = state.muted || state.volume === 0;
  return <button type="button" className={className} data-audio-control="true" data-testid="header-mute" aria-label={silent ? 'Unmute sound' : 'Mute sound'} aria-pressed={silent}
    onClick={() => { toggleSound(); ensureAudioContext(); }}><Speaker silent={silent} size={size} /></button>;
}
// Volume, mute switch and dealer voice choice: lives inside the profile sheet's Sound row.
export function SoundSettingsPanel() {
  const state = useSound(), silent = state.muted || state.volume === 0;
  return <div className="sound-panel" data-testid="sound-settings">
    <button type="button" className="mute-switch" aria-pressed={silent} onClick={() => { toggleSound(); ensureAudioContext(); }}><Speaker silent={silent}/><span>{silent ? 'Sound off. Tap to unmute' : 'Sound on. Tap to mute'}</span></button>
    <label className="volume-label" htmlFor="master-volume">Master volume <strong>{Math.round(state.volume * 100)}%</strong></label>
    <input id="master-volume" aria-label="Master volume" type="range" min="0" max="100" step="1" value={Math.round(state.volume * 100)} onChange={e => setAudioSettings({volume:Number(e.target.value)/100})}/>
    <fieldset><legend>Dealer voice</legend><div className="dealer-choices">
      {DEALER_VOICES.map(([v, label]) => <label key={v} className={state.voice === v ? 'selected' : ''}><input type="radio" name="dealer-voice" value={v} checked={state.voice === v} onChange={() => setAudioSettings({voice:v})}/>{label}</label>)}
    </div></fieldset>
    <button type="button" className="voice-preview" disabled={silent} onClick={() => { ensureAudioContext(); previewDealerVoice(); }}>Preview voice</button>
    <small>{silent ? 'Unmute to preview the selected voice.' : 'Applies to the dealer, ball and chip sounds. Saved on this browser.'}</small>
  </div>;
}
// A one line summary for the Sound row.
export function useSoundSummary() {
  const state = useSound();
  const voice = DEALER_VOICES.find(([v]) => v === state.voice)?.[1] || '';
  const silent = state.muted || state.volume === 0;
  return silent ? `Off${voice ? `, ${voice}` : ''}` : `Volume ${Math.round(state.volume * 100)}%${voice ? `, ${voice}` : ''}`;
}
