import { useEffect, useRef, useSyncExternalStore } from 'react';
import { DEALER_VOICES, getAudioSettings, subscribeAudioSettings, setAudioSettings, toggleSound, previewDealerVoice } from './audioSettings.js';
import { ensureAudioContext } from './sound.js';
const useSound = () => useSyncExternalStore(subscribeAudioSettings, getAudioSettings, getAudioSettings);
function Speaker({ silent }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M11 4 6 8H3v8h3l5 4z"/>{silent ? <path d="m16 9 5 6m0-6-5 6"/> : <><path d="M15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/></>}</svg>;
}
export function SoundQuickControls({ onOpen, children }) {
  const state = useSound(), silent = state.muted || state.volume === 0;
  return <div className="sound-toolbar">
    {children}
    <button type="button" data-audio-control="true" aria-label={silent ? 'Unmute sound' : 'Mute sound'} aria-pressed={silent} onClick={() => { toggleSound(); ensureAudioContext(); }}><Speaker silent={silent}/></button>
    <button type="button" data-audio-control="true" aria-label="Sound settings" title="Sound settings" onClick={() => { ensureAudioContext(); onOpen(); }}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="#0e0e15"/><circle cx="15" cy="17" r="3" fill="#0e0e15"/></svg></button>
  </div>;
}
export function SoundSettingsDialog({ open, onClose }) {
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const state = useSound(), panel = useRef(null), silent = state.muted || state.volume === 0;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    panel.current?.querySelector('button')?.focus({preventScroll:true});
    const key = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRef.current(); }
      if (e.key === 'Tab') {
        const nodes = [...panel.current.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
        if (e.shiftKey && document.activeElement === nodes[0]) { e.preventDefault(); nodes.at(-1)?.focus(); }
        else if (!e.shiftKey && document.activeElement === nodes.at(-1)) { e.preventDefault(); nodes[0]?.focus(); }
      }
    };
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('keydown', key, true); previous?.focus?.({preventScroll:true}); };
  }, [open]);
  if (!open) return null;
  return <div className="sound-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <section className="sound-dialog" ref={panel} role="dialog" aria-modal="true" aria-labelledby="sound-title">
      <div className="sound-dialog-heading"><h3 id="sound-title">Sound settings</h3><button onClick={onClose} aria-label="Close sound settings">✕</button></div>
      <button className="mute-switch" aria-pressed={silent} onClick={() => { toggleSound(); ensureAudioContext(); }}><Speaker silent={silent}/><span>{silent ? 'Sound off. Tap to unmute' : 'Sound on. Tap to mute'}</span></button>
      <label className="volume-label" htmlFor="master-volume">Master volume <strong>{Math.round(state.volume * 100)}%</strong></label>
      <input id="master-volume" aria-label="Master volume" type="range" min="0" max="100" step="1" value={Math.round(state.volume * 100)} onChange={e => setAudioSettings({volume:Number(e.target.value)/100})}/>
      <fieldset><legend>Dealer voice</legend><div className="dealer-choices">
        {DEALER_VOICES.map(([v, label]) => <label key={v} className={state.voice === v ? 'selected' : ''}><input type="radio" name="dealer-voice" value={v} checked={state.voice === v} onChange={() => setAudioSettings({voice:v})}/>{label}</label>)}
      </div></fieldset>
      <button className="voice-preview" disabled={silent} onClick={previewDealerVoice}>Preview voice</button>
      <small>{silent ? 'Unmute to preview the selected voice.' : 'Applies to the dealer, ball and chip sounds. Saved on this browser.'}</small>
    </section>
  </div>;
}
