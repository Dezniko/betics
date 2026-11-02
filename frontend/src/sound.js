// Call ensureAudioContext() from a user gesture to unlock and preload audio.
// Chip recordings are temporary, explicitly approved Play'n GO reference assets;
// replace with owned/licensed recordings BEFORE production. Source sprite + map:
// https://cdn.playngonetwork.com/11.1.0-roulette.355/resources/games/tablegame/roulette/sounds/sounds_desktop.{mp3,json}
// Manifest offsets are decoded PCM samples at 44100 Hz (not milliseconds).
// chipSingle_1/2/3 <- placeChipSingle_1/2/3: 9136279..9147357,
//   9191457..9198998, 9243098..9249048; chipGatherSmall/Medium/Large <-
//   10481434..10501377, 10615527..10638572, 10759309..10801289.
import { connectAudioMaster, createManagedAudio, releaseManagedAudio, effectiveVolume } from './audioSettings.js';
let ctx = null, masterGain = null;
const CHIP_SINGLES = ['chipSingle_1', 'chipSingle_2', 'chipSingle_3'];
const CHIP_CLIPS = [...CHIP_SINGLES, 'chipGatherSmall', 'chipGatherMedium', 'chipGatherLarge'];
const chipBuffers = new Map();
let chipPreload = null;

function preloadChips() {
  if (chipPreload) return;
  // Cache the promise even on failure: never retry from the 55ms count loop.
  chipPreload = Promise.all(CHIP_CLIPS.map(async name => {
    try {
      const response = await fetch(`/sfx/${name}.mp3`);
      if (!response.ok) return;
      const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
      chipBuffers.set(name, buffer);
    } catch { /* Offline/unsupported audio stays silent, never blocks gameplay. */ }
  }));
}

export function ensureAudioContext() {
  try {
    if (!ctx) { ctx = new (window.AudioContext || window.webkitAudioContext)(); masterGain = connectAudioMaster(ctx); }
    if (ctx.state === 'suspended') Promise.resolve(ctx.resume()).catch(() => {});
    preloadChips();
    return ctx;
  } catch { return null; }
}

function envelope(gainNode, now, attack, decay, peak = 0.25) {
  gainNode.gain.cancelScheduledValues(now);
  gainNode.gain.setValueAtTime(0.0001, now);
  gainNode.gain.exponentialRampToValueAtTime(peak, now + attack);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, now + attack + decay);
}

// A short, sharp click — used for the ball ticking past each pocket fret
// and for chip placement.
export function playTick(volume = 0.2) {
  if (!ctx) return;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(1800, now);
  osc.frequency.exponentialRampToValueAtTime(600, now + 0.03);
  envelope(gain, now, 0.001, 0.035, volume);
  osc.connect(gain).connect(masterGain || ctx.destination);
  osc.start(now);
  osc.stop(now + 0.05);
}

// A softer, lower "clack" for the ball bouncing off a fret/divider.
export function playBounce(volume = 0.3) {
  if (!ctx) return;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(320, now);
  osc.frequency.exponentialRampToValueAtTime(140, now + 0.08);
  envelope(gain, now, 0.002, 0.09, volume);
  osc.connect(gain).connect(masterGain || ctx.destination);
  osc.start(now);
  osc.stop(now + 0.12);
}

// Filtered noise burst — the "whoosh" of the wheel spinning up.
export function playSpinWhoosh() {
  if (!ctx) return;
  const now = ctx.currentTime;
  const bufferSize = ctx.sampleRate * 0.6;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(400, now);
  filter.frequency.exponentialRampToValueAtTime(1800, now + 0.5);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.15, now + 0.15);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);

  noise.connect(filter).connect(gain).connect(masterGain || ctx.destination);
  noise.start(now);
  noise.stop(now + 0.6);
}

// Finale: a fuller recorded sweep of chips, not an electronic fanfare.
export function playWin(big = false) {
  playChipBuffer(big ? 'chipGatherLarge' : 'chipGatherMedium', big ? 0.6 : 0.5, 'payout');
}

// A single low thud for a loss.
export function playLose() {
  if (!ctx) return;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(220, now);
  osc.frequency.exponentialRampToValueAtTime(110, now + 0.3);
  envelope(gain, now, 0.01, 0.35, 0.18);
  osc.connect(gain).connect(masterGain || ctx.destination);
  osc.start(now);
  osc.stop(now + 0.4);
}

// Physical table-chip recordings, kept behind the existing public API.
export function playChip(cents = 500) {
  if (!ensureAudioContext()) return;
  const heavy = Math.min(1, Math.log10(Math.max(50, cents / 20)) / 4); // units of 0.01 TICS, chips 10 to 5K TICS
  playChipBuffer(nextChip(), 0.5, 'table', 1.02 - heavy * 0.06 + Math.random() * 0.02);
}

export function playChipSelect() {
  if (!ensureAudioContext()) return;
  playChipBuffer(nextChip(), 0.32);
}

export function playChipRemove() {
  if (!ensureAudioContext()) return;
  playChipBuffer('chipGatherSmall', 0.32);
}

// A short low "nope" for things like not enough balance.
export function playDeny() {
  const c = ensureAudioContext();
  if (!c) return;
  const now = c.currentTime;
  [200, 150].forEach((f, i) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(f, now + i * 0.09);
    envelope(gain, now + i * 0.09, 0.003, 0.08, 0.12);
    osc.connect(gain).connect(masterGain || c.destination);
    osc.start(now + i * 0.09);
    osc.stop(now + i * 0.09 + 0.1);
  });
}

// A small recorded stack gathered for each revealed winning bet.
export function playChaChing() {
  playChipBuffer('chipGatherSmall', 0.42, 'payout', 0.98 + Math.random() * 0.04);
}

// Celebration count-up: rapid real chip clicks that rise in pitch as the
// number climbs, then a big recorded gather when it lands.
let lastCelebrateAt = -Infinity;
export function playCelebrationTick(progress = 0) {
  if (!ctx || ctx.currentTime - lastCelebrateAt < 0.065) return;
  if (playChipBuffer(nextChip(), 0.2 + progress * 0.12, 'count', 0.92 + progress * 0.5)) lastCelebrateAt = ctx.currentTime;
}
export function playCelebrationHit(big = false) {
  playChipBuffer(big ? 'chipGatherLarge' : 'chipGatherMedium', big ? 0.7 : 0.6, 'payout', 1);
  if (big) setTimeout(() => playChipBuffer('chipGatherMedium', 0.45, 'payout', 1.08), 140);
}
// Each flying chip dropping onto the balance stack.
export function playChipLand() {
  playChipBuffer(nextChip(), 0.24, 'table', 1.05 + Math.random() * 0.1);
}

// Each call mixes an already-decoded recording, never another network request.
// onended releases both nodes; voice caps prevent loud overlap on rapid calls.
const chipVoices = { count: 0, payout: 0, table: 0 };
let singleIndex = 0;
let lastCountAt = -Infinity;

function nextChip() {
  return CHIP_SINGLES[singleIndex++ % CHIP_SINGLES.length];
}

function playChipBuffer(name, volume, group = 'table', rate = 1) {
  if (!ctx || ctx.state !== 'running' || effectiveVolume() === 0) return false;
  const buffer = chipBuffers.get(name);
  const limit = group === 'count' ? 2 : 3;
  if (!buffer || chipVoices[group] >= limit) return false;
  let source, gain;
  try {
    source = ctx.createBufferSource();
    gain = ctx.createGain();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    source.connect(gain).connect(masterGain || ctx.destination);
    source.onended = () => {
      chipVoices[group]--;
      source.disconnect();
      gain.disconnect();
    };
    source.start(ctx.currentTime);
    chipVoices[group]++;
    return true;
  } catch {
    source?.disconnect();
    gain?.disconnect();
    return false;
  }
}

// Gentle ceramic chip ticks; a 55ms animation caller produces ~110ms audio.
export function playCountTick() {
  if (!ctx || ctx.currentTime - lastCountAt < 0.105) return;
  if (playChipBuffer(nextChip(), 0.16, 'count', 0.98 + Math.random() * 0.04)) {
    lastCountAt = ctx.currentTime;
  }
}

// Real Play'n GO ball-spin/drop clips (sliced from their public CDN asset,
// per Dez — a deliberate placeholder swap item, tracked in the skill
// notes as NOT safe to ship to production as-is). playBallRoll/playBounce
// above are the from-scratch synthesized versions; these play the actual
// extracted samples instead, with the same random-variant idea their own
// sounds_desktop.json already used (ballSpin_1/2/3, ballDrop_1/2/3).
const BALL_SPIN_VARIANTS = ['ballSpin_1', 'ballSpin_2', 'ballSpin_3'];
const BALL_DROP_VARIANTS = ['ballDrop_1', 'ballDrop_2', 'ballDrop_3'];

function playSfxClip(name, volume = 0.5) {
  try {
    const audio = createManagedAudio(`/sfx/${name}.mp3`, volume);
    audio?.play().catch(() => releaseManagedAudio(audio));
  } catch (e) {
    // ignore — never let a sound effect failure break gameplay
  }
}

export function playRealBallRoll(volume = 0.5) {
  const name = BALL_SPIN_VARIANTS[Math.floor(Math.random() * BALL_SPIN_VARIANTS.length)];
  playSfxClip(name, volume);
}

export function playRealBallDrop(volume = 0.5) {
  const name = BALL_DROP_VARIANTS[Math.floor(Math.random() * BALL_DROP_VARIANTS.length)];
  playSfxClip(name, volume);
}

// The continuous rattly "whirr" of the ball rolling around the outer
// track, the way a real wheel's ball sound is one continuous texture
// rather than isolated clicks — a noise bed whose filter sweeps from a
// bright fast rattle down to a low slow rumble over the spin, amplitude-
// modulated by a slowing LFO so it audibly "clatters" rather than just
// hisses. Synthesized (no external sample) — same effect as a real wheel's
// ball-spin sound, not a copy of any specific site's recording. Returns a
// stop() you can call early if the spin is skipped/interrupted.
export function playBallRoll(durationSec) {
  const c = ensureAudioContext();
  if (!c) return () => {};
  const now = c.currentTime;
  const bufferSize = Math.max(1, Math.floor(c.sampleRate * durationSec));
  const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

  const noise = c.createBufferSource();
  noise.buffer = buffer;
  const filter = c.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = 5;
  filter.frequency.setValueAtTime(2600, now);
  filter.frequency.exponentialRampToValueAtTime(260, now + durationSec);

  // LFO rattle: fast "brrrr" early on, slowing to a lazy rumble by the end
  // — this is what makes it read as a ball bouncing over frets rather than
  // a plain volume-swept hiss.
  const lfo = c.createOscillator();
  lfo.frequency.setValueAtTime(50, now);
  lfo.frequency.exponentialRampToValueAtTime(5, now + durationSec);
  const lfoDepth = c.createGain();
  lfoDepth.gain.value = 0.5;
  const modGain = c.createGain();
  modGain.gain.value = 0.5;
  lfo.connect(lfoDepth).connect(modGain.gain);

  const gain = c.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.2, now + 0.3);
  gain.gain.setValueAtTime(0.2, now + durationSec * 0.55);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);

  noise.connect(filter).connect(modGain).connect(gain).connect(masterGain || c.destination);
  noise.start(now);
  noise.stop(now + durationSec);
  lfo.start(now);
  lfo.stop(now + durationSec);

  return () => {
    try { noise.stop(); } catch (e) { /* already stopped */ }
    try { lfo.stop(); } catch (e) { /* already stopped */ }
  };
}
