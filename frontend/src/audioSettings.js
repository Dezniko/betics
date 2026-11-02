const KEY = 'noir:audio:v1';
// Dealer voices: GodsPower (default), Man, Woman. Folder per voice under /voice (Man is the root set).
export const DEALER_VOICES = Object.freeze([['godspower', 'GodsPower'], ['male', 'Man'], ['female', 'Woman']]);
const VOICE_IDS = DEALER_VOICES.map(([id]) => id);
const VOICE_DIR = { godspower: 'godspower/', male: '', female: 'female/' };
const SETTINGS_VERSION = 2;
const defaults = Object.freeze({ muted: false, volume: 1, voice: 'godspower' });
function normalize(value, previous = defaults) {
  return Object.freeze({
    muted: typeof value?.muted === 'boolean' ? value.muted : previous.muted,
    volume: Number.isFinite(value?.volume) ? Math.max(0, Math.min(1, value.volume)) : previous.volume,
    voice: VOICE_IDS.includes(value?.voice) ? value.voice : previous.voice,
  });
}
let settings = defaults;
try {
  const saved = JSON.parse(globalThis.window?.localStorage?.getItem(KEY) || '{}');
  // Settings saved before GodsPower existed: keep volume and mute, start on the new default voice.
  if (saved && saved.v !== SETTINGS_VERSION) delete saved.voice;
  settings = normalize(saved);
} catch { /* Audio preferences must never block a wager. */ }
const listeners = new Set(), clips = new Map(), masters = new Set();
let mediaContext = null, mediaMaster = null, engineContext = null, engineMaster = null;
export const getAudioEngine = () => engineContext ? { context: engineContext, output: engineMaster } : null;
// iPhone Safari does not reliably honor HTMLMediaElement.volume. Route recorded
// voices and ball clips through the same Web Audio master as the chip buffers.
function routeMedia(entry) {
  if (entry.source || !mediaContext?.createMediaElementSource) return;
  try {
    entry.source = mediaContext.createMediaElementSource(entry.audio);
    entry.gain = mediaContext.createGain();
    entry.gain.gain.setValueAtTime(entry.base, mediaContext.currentTime);
    entry.source.connect(entry.gain).connect(mediaMaster);
    entry.audio.volume = 1;
  } catch { /* Native audio remains the fallback when media routing is unsupported. */ }
}
export const getAudioSettings = () => settings;
export const subscribeAudioSettings = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export const effectiveVolume = () => settings.muted ? 0 : settings.volume;
export const voiceClipUrl = name => `/voice/${VOICE_DIR[settings.voice] ?? ''}${name}.mp3`;

export function setAudioSettings(value) {
  const previous = settings;
  settings = normalize(value, settings);
  try { globalThis.window?.localStorage?.setItem(KEY, JSON.stringify({ ...settings, v: SETTINGS_VERSION })); } catch { /* Keep working in memory. */ }
  const level = effectiveVolume();
  for (const entry of [...clips.values()]) {
    entry.audio.volume = level === 0 ? 0 : entry.source ? 1 : entry.base * level;
    if (level === 0 || (entry.kind === 'voice' && previous.voice !== settings.voice)) {
      entry.audio.pause?.(); releaseManagedAudio(entry.audio); entry.onStop?.();
    }
  }
  for (const entry of masters) {
    if (entry.ctx.state === 'closed') { masters.delete(entry); continue; }
    entry.node.gain.setValueAtTime(level, entry.ctx.currentTime);
  }
  for (const notify of listeners) notify();
  return settings;
}
export function toggleSound() {
  const silent = settings.muted || settings.volume === 0;
  return setAudioSettings({ muted: !silent, volume: silent && settings.volume === 0 ? 0.7 : settings.volume });
}
export function connectAudioMaster(ctx) {
  const node = ctx.createGain();
  node.gain.setValueAtTime(effectiveVolume(), ctx.currentTime);
  node.connect(ctx.destination); masters.add({ctx, node});
  engineContext = ctx; engineMaster = node;
  if (ctx.createMediaElementSource) {
    mediaContext = ctx; mediaMaster = node;
    for (const entry of clips.values()) routeMedia(entry);
  }
  return node;
}
export function createManagedAudio(url, base = 1, { kind = 'effect', onStop } = {}) {
  if (effectiveVolume() === 0) return null;
  const audio = new Audio(url);
  audio.volume = Math.max(0, Math.min(1, base)) * effectiveVolume();
  const entry = { audio, base: Math.max(0, Math.min(1, base)), kind, onStop };
  clips.set(audio, entry); routeMedia(entry);
  const release = () => releaseManagedAudio(audio);
  audio.addEventListener?.('ended', release, {once:true});
  audio.addEventListener?.('error', release, {once:true});
  return audio;
}
export function releaseManagedAudio(audio) {
  const entry = clips.get(audio);
  if (!entry) return;
  entry.source?.disconnect(); entry.gain?.disconnect(); clips.delete(audio);
}
export function previewDealerVoice() {
  const audio = createManagedAudio(voiceClipUrl('preview'), 0.85, {kind:'voice'});
  audio?.play().catch(() => releaseManagedAudio(audio));
}
