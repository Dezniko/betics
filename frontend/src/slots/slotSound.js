// Gods of Power sound cues. Every cue is synthesised with Web Audio and plays through the shared
// master gain (audioSettings.js), so the one tap mute and the volume slider apply here too.
// Interface used by the slot page (SlotsApp.jsx / slotAnim.js):
//   spinLoopStart()           reels begin turning (looping whoosh); call spinLoopStop() when the last reel stops
//   spinLoopStop()
//   reelStop(index)           a reel has landed, index 0 to 4 (pitch rises a little per reel)
//   anticipation(on)          two scatters are down and the last reels still turn: tense riser on/off
//   scatter(count)            a vault door landed; count = how many are visible so far (1 to 5), rising chime
//   lineWin(tier)             a winning line is traced; tier 0 small, 1 nice, 2 big, 3 mega
//   coinShower(durationMs)    coins falling during a big win
//   vaultOpen()               free spins start: metal creak and boom
//   fanfare()                 free spins banner
//   retrigger()               extra free spins added
//   countTick(progress)       win amount counting up (0 to 1)
//   voice(name, {queue})      a recorded clip from /slots/voice/<name>.mp3 (optional file: missing = silent);
//                             a new voice stops the one playing unless queue is true (then it follows it)
//   portraitLand()            the Gods of Power portrait landed: gold impact hit + the POWER clip, at most once per 1.2 s
//   ambientStart() / ambientStop()  very quiet low drone while the page is open (about -24 dBFS), stops when muted
//   unlocked()                true when the audio engine exists and is not muted
// Each cue returns nothing and never throws. When the audio engine is not unlocked yet, cues are skipped.
//
// Polyphony is bounded: at most MAX_LIVE source nodes may sound at the same instant; a cue that would
// exceed it drops its extra voices instead of piling up. Peak levels are budgeted so an offline render of
// any cue, and of the busiest combination (mega line win + coin shower + fanfare), stays below -1 dBFS at
// master gain 1. frontend/tests/browser/slot-sound-render.mjs renders every cue and prints the peaks.
import { getAudioEngine, effectiveVolume, subscribeAudioSettings } from '../audioSettings.js';

export const MAX_LIVE = 24;
let getEngine = getAudioEngine;
// Test hook: inject another engine getter ({context, output} | null). Passing nothing restores the default.
export function __setEngineGetter(fn) { getEngine = typeof fn === 'function' ? fn : getAudioEngine; }

// ---- engine access and voice accounting ---------------------------------------------------------
function engine() {
  try {
    const e = getEngine();
    if (!e || !e.context || !e.output || e.context.state === 'closed') return null;
    if (effectiveVolume() === 0) return null;
    return e;
  } catch { return null; }
}

// Live voices: {node, start, end}; end = Infinity for the loops until they are stopped.
const live = new Set();
function prune(now) { for (const v of live) if (v.end <= now) live.delete(v); }
function roomFor(ctx, start, end) {
  prune(ctx.currentTime);
  let n = 0;
  for (const v of live) if (v.start < end && v.end > start) n++;
  return n < MAX_LIVE;
}
function track(node, start, end) {
  const voice = { node, start, end };
  live.add(voice);
  node.onended = () => live.delete(voice);
  return voice;
}
// Voices scheduled to sound at time t (or tracked at all when t is omitted). Test and QA hook.
export function __liveCount(t) {
  let n = 0;
  for (const v of live) if (t === undefined || (v.start <= t && v.end > t)) n++;
  return n;
}
export function __reset() {
  for (const v of live) { try { v.node.stop(); } catch { /* never started */ } }
  live.clear();
  loop = null; riser = null; ambient = null; lastTickAt = -Infinity; lastPortraitAt = -Infinity;
  current = null; queued = null; voiceCache.clear();
}
export const unlocked = () => !!engine();

// Source factories return {node, voice} or null when the polyphony budget is full for that window.
function osc(ctx, type, freq, start, end) {
  if (!roomFor(ctx, start, end)) return null;
  const node = ctx.createOscillator();
  node.type = type;
  node.frequency.setValueAtTime(freq, start);
  return { node, voice: track(node, start, end) };
}
function noise(ctx, kind, start, end, loopIt = false) {
  if (!roomFor(ctx, start, end)) return null;
  const node = ctx.createBufferSource();
  node.buffer = buffers(ctx)[kind]();
  node.loop = loopIt;
  return { node, voice: track(node, start, end) };
}
function startVoice({ node, voice }) {
  node.start(voice.start);
  if (Number.isFinite(voice.end)) node.stop(voice.end);
}
function stopVoices(voices, at) {
  for (const v of voices) { v.end = at; try { v.node.stop(at); } catch { /* already stopped */ } }
}

// Shared buffers per context: white noise, pink noise (Paul Kellet's filter) and a looping click rhythm.
const bufferCache = new WeakMap();
function buffers(ctx) {
  let set = bufferCache.get(ctx);
  if (set) return set;
  const rate = ctx.sampleRate || 44100;
  const lazy = fill => {
    let buffer = null;
    return () => {
      if (!buffer) { buffer = ctx.createBuffer(1, Math.round(rate * 2), rate); fill(buffer.getChannelData(0)); }
      return buffer;
    };
  };
  set = {
    white: lazy(d => { for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }),
    pink: lazy(d => {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < d.length; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
    }),
    // 12 soft clicks per second, each a 3 ms decaying burst: loops seamlessly and playbackRate sets the tempo.
    clicks: lazy(d => {
      const per = d.length / 24, len = Math.round(rate * 0.003);
      for (let c = 0; c < 24; c++) {
        const at = Math.round(c * per);
        for (let i = 0; i < len && at + i < d.length; i++) d[at + i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
      }
    }),
  };
  bufferCache.set(ctx, set);
  return set;
}

// Linear attack to `peak`, optional hold, linear release to silence; linear ramps are click free and reach 0 exactly.
function env(gainNode, t, attack, decay, peak, hold = 0) {
  const g = gainNode.gain;
  g.cancelScheduledValues(t);
  g.setValueAtTime(0, t);
  g.linearRampToValueAtTime(peak, t + attack);
  if (hold > 0) g.setValueAtTime(peak, t + attack + hold);
  g.linearRampToValueAtTime(0, t + attack + hold + decay);
}
function gainAt(ctx, value, t) { const g = ctx.createGain(); g.gain.setValueAtTime(value, t); return g; }
function filter(ctx, type, freq, q, t) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t);
  if (q !== undefined) f.Q.setValueAtTime(q, t);
  return f;
}
function fadeTo0(gainNode, now, end) {
  const g = gainNode.gain;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(0, end);
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
const semis = (base, n) => base * 2 ** (n / 12);
const safe = fn => (...args) => { try { fn(...args); } catch { /* A sound must never break a spin. */ } };

// ---- spin loop ------------------------------------------------------------------------------------
let loop = null;
function stopLoop(fade) {
  if (!loop) return;
  const { ctx, voices, gains } = loop;
  loop = null;
  const now = ctx.currentTime, end = now + fade;
  for (const g of gains) fadeTo0(g, now, end);
  stopVoices(voices, end + 0.01);
}
export const spinLoopStart = safe(() => {
  if (loop) return;
  const e = engine(); if (!e) return;
  const ctx = e.context, now = ctx.currentTime, voices = [], gains = [];
  // Whoosh: pink noise through a bandpass whose centre breathes with a slow LFO.
  const whoosh = noise(ctx, 'pink', now, Infinity, true); if (!whoosh) return;
  const band = filter(ctx, 'bandpass', 700, 1.2, now);
  const whooshGain = gainAt(ctx, 0, now);
  whooshGain.gain.linearRampToValueAtTime(0.3, now + 0.25);
  whoosh.node.connect(band); band.connect(whooshGain); whooshGain.connect(e.output);
  voices.push(whoosh); gains.push(whooshGain);
  const lfo = osc(ctx, 'sine', 0.8, now, Infinity);
  if (lfo) {
    const depth = gainAt(ctx, 350, now);
    lfo.node.connect(depth); depth.connect(band.frequency);
    voices.push(lfo);
  }
  // Click rhythm: looping click buffer, tempo rising from relaxed to busy over the first 2 s.
  const clicks = noise(ctx, 'clicks', now, Infinity, true);
  if (clicks) {
    clicks.node.playbackRate.setValueAtTime(0.8, now);
    clicks.node.playbackRate.linearRampToValueAtTime(1.35, now + 2);
    const hp = filter(ctx, 'highpass', 2500, 0.7, now);
    const clickGain = gainAt(ctx, 0, now);
    clickGain.gain.linearRampToValueAtTime(0.22, now + 0.3);
    clicks.node.connect(hp); hp.connect(clickGain); clickGain.connect(e.output);
    voices.push(clicks); gains.push(clickGain);
  }
  loop = { ctx, voices: voices.map(v => v.voice), gains };
  for (const v of voices) startVoice(v);
});
export const spinLoopStop = safe(() => stopLoop(0.12));

// ---- reel stop ------------------------------------------------------------------------------------
export const reelStop = safe((index, { sparkle = false } = {}) => {
  const e = engine(); if (!e) return;
  const ctx = e.context, now = ctx.currentTime, i = clamp(Math.round(index), 0, 4);
  const base = semis(95, i * 1.5);
  // Low thunk: triangle dropping onto its pitch through a lowpass for weight.
  const thunk = osc(ctx, 'triangle', base * 1.7, now, now + 0.3);
  if (thunk) {
    thunk.node.frequency.exponentialRampToValueAtTime(base, now + 0.06);
    const g = ctx.createGain(); env(g, now, 0.004, 0.24, 0.4);
    const lp = filter(ctx, 'lowpass', 900, 0.8, now);
    thunk.node.connect(lp); lp.connect(g); g.connect(e.output);
    startVoice(thunk);
  }
  // Tiny metallic tick on top.
  const tick = osc(ctx, 'square', semis(3600, i), now, now + 0.03);
  if (tick) {
    const g = ctx.createGain(); env(g, now, 0.001, 0.022, 0.07);
    const hp = filter(ctx, 'highpass', 2000, 0.7, now);
    tick.node.connect(hp); hp.connect(g); g.connect(e.output);
    startVoice(tick);
  }
  // Metallic click: a short noise burst through a resonant bandpass (the reel's latch).
  const click = noise(ctx, 'white', now, now + 0.06);
  if (click) {
    const bp = filter(ctx, 'bandpass', 2600 + i * 180, 9, now);
    const g = ctx.createGain(); env(g, now, 0.001, 0.055, 0.16);
    click.node.connect(bp); bp.connect(g); g.connect(e.output);
    startVoice(click);
  }
  // Sparkle when the reel shows a special symbol: three quick rising sine partials.
  if (sparkle) {
    [0, 0.045, 0.09].forEach((off, k) => {
      const f = semis(1760, 7 * k + i);
      const o = osc(ctx, 'sine', f, now + off, now + off + 0.22); if (!o) return;
      const g = ctx.createGain(); env(g, now + off, 0.003, 0.21, 0.09);
      o.node.connect(g); g.connect(e.output);
      startVoice(o);
    });
  }
});

// ---- Gods of Power portrait: gold impact hit under the POWER clip, debounced ----------------------
let lastPortraitAt = -Infinity;
export const PORTRAIT_GAP = 1.2;
export const portraitLand = safe(() => {
  const e = engine(); if (!e) return;
  const ctx = e.context, now = ctx.currentTime;
  if (now - lastPortraitAt < PORTRAIT_GAP) return;
  lastPortraitAt = now;
  // Impact: sub drop plus a bright gold chord stab.
  const sub = osc(ctx, 'sine', 160, now, now + 0.5);
  if (sub) {
    sub.node.frequency.exponentialRampToValueAtTime(52, now + 0.18);
    const g = ctx.createGain(); env(g, now, 0.005, 0.45, 0.28);
    sub.node.connect(g); g.connect(e.output);
    startVoice(sub);
  }
  const lp = filter(ctx, 'lowpass', 900, 1.2, now);
  lp.frequency.linearRampToValueAtTime(4200, now + 0.06);
  lp.frequency.linearRampToValueAtTime(1200, now + 0.6);
  const cg = ctx.createGain(); env(cg, now, 0.01, 0.5, 0.075, 0.1);
  lp.connect(cg); cg.connect(e.output);
  [0, 7, 12, 19].forEach((n, i) => {
    const o = osc(ctx, 'sawtooth', semis(A4, n - 12), now, now + 0.62); if (!o) return;
    o.node.detune.setValueAtTime(i % 2 ? 7 : -7, now);
    o.node.connect(lp);
    startVoice(o);
  });
  const shimmer = noise(ctx, 'white', now, now + 0.3);
  if (shimmer) {
    const hp = filter(ctx, 'highpass', 5000, 0.8, now);
    const g = ctx.createGain(); env(g, now, 0.002, 0.28, 0.08);
    shimmer.node.connect(hp); hp.connect(g); g.connect(e.output);
    startVoice(shimmer);
  }
  voice('power');
});

// ---- anticipation riser ---------------------------------------------------------------------------
let riser = null;
function stopRiser(fade) {
  if (!riser) return;
  const { ctx, voices, gain } = riser;
  riser = null;
  const now = ctx.currentTime, end = now + fade;
  fadeTo0(gain, now, end);
  stopVoices(voices, end + 0.01);
}
function anticipationHit(e) {
  // The tension resolves in a bright hit: a cymbal-like noise splash and a high chime.
  const ctx = e.context, now = ctx.currentTime;
  const splash = noise(ctx, 'white', now, now + 0.5);
  if (splash) {
    const hp = filter(ctx, 'highpass', 3200, 0.7, now);
    const g = ctx.createGain(); env(g, now, 0.003, 0.48, 0.14);
    splash.node.connect(hp); hp.connect(g); g.connect(e.output);
    startVoice(splash);
  }
  [semis(A4, 24), semis(A4, 31)].forEach((f, i) => {
    const o = osc(ctx, 'sine', f, now, now + 0.6); if (!o) return;
    const g = ctx.createGain(); env(g, now, 0.004, 0.59, 0.14 - i * 0.05);
    o.node.connect(g); g.connect(e.output);
    startVoice(o);
  });
}
export const anticipation = safe(on => {
  if (!on) { const had = !!riser; stopRiser(0.25); if (had) { const e = engine(); if (e) anticipationHit(e); } return; }
  if (riser) return;
  const e = engine(); if (!e) return;
  const ctx = e.context, now = ctx.currentTime;
  const saw = osc(ctx, 'sawtooth', 110, now, Infinity); if (!saw) return;
  saw.node.frequency.exponentialRampToValueAtTime(330, now + 4);
  const lp = filter(ctx, 'lowpass', 350, 6, now);
  lp.frequency.exponentialRampToValueAtTime(2600, now + 4);
  const trem = gainAt(ctx, 0.12, now);              // tremolo carrier: base 0.12, LFO depth 0.08
  const gain = gainAt(ctx, 0, now);
  gain.gain.linearRampToValueAtTime(1, now + 0.2);
  saw.node.connect(lp); lp.connect(trem); trem.connect(gain); gain.connect(e.output);
  const voices = [saw];
  const lfo = osc(ctx, 'sine', 5, now, Infinity);
  if (lfo) {
    lfo.node.frequency.linearRampToValueAtTime(14, now + 4);
    const depth = gainAt(ctx, 0.08, now);
    lfo.node.connect(depth); depth.connect(trem.gain);
    voices.push(lfo);
  }
  // Tick tick tick: the click loop, accelerating, through a bright bandpass.
  const ticks = noise(ctx, 'clicks', now, Infinity, true);
  if (ticks) {
    ticks.node.playbackRate.setValueAtTime(0.5, now);
    ticks.node.playbackRate.linearRampToValueAtTime(1.6, now + 4);
    const bp = filter(ctx, 'bandpass', 3200, 4, now);
    bp.frequency.linearRampToValueAtTime(5200, now + 4);
    const tg = gainAt(ctx, 0.3, now);
    ticks.node.connect(bp); bp.connect(tg); tg.connect(gain);
    voices.push(ticks);
  }
  riser = { ctx, voices: voices.map(v => v.voice), gain };
  for (const v of voices) startVoice(v);
});

// ---- scatter bell -----------------------------------------------------------------------------------
export const scatter = safe(count => {
  const e = engine(); if (!e) return;
  const ctx = e.context, now = ctx.currentTime, n = clamp(Math.round(count), 1, 5);
  const f = 392 * 1.5 ** (n - 1), length = 0.8 + n * 0.1;
  // FM bell: sine carrier, inharmonic modulator (ratio 1.4) whose index decays with the strike.
  const carrier = osc(ctx, 'sine', f, now, now + length); if (!carrier) return;
  const mod = osc(ctx, 'sine', f * 1.4, now, now + length);
  if (mod) {
    const index = ctx.createGain(); env(index, now, 0.002, length * 0.6, f * 1.6);
    mod.node.connect(index); index.connect(carrier.node.frequency);
    startVoice(mod);
  }
  const g = ctx.createGain(); env(g, now, 0.004, length - 0.004, 0.28 - n * 0.02);
  carrier.node.connect(g); g.connect(e.output);
  startVoice(carrier);
  // A quieter detuned partial gives the shimmer of a real bell.
  const partial = osc(ctx, 'sine', f * 2.756, now, now + length * 0.6);
  if (partial) {
    const pg = ctx.createGain(); env(pg, now, 0.002, length * 0.6 - 0.002, 0.07);
    partial.node.connect(pg); pg.connect(e.output);
    startVoice(partial);
  }
});

// ---- line win jingle --------------------------------------------------------------------------------
const A4 = 440;
const TIERS = [
  { notes: [0, 4, 7], gap: 0.08, note: 0.25, chord: null, shimmer: false, glitter: 0, peak: 0.16 },
  { notes: [0, 4, 7, 12, 16], gap: 0.085, note: 0.3, chord: [0, 4, 7], shimmer: false, glitter: 4, peak: 0.15 },
  { notes: [0, 4, 7, 12, 16, 19], gap: 0.09, note: 0.34, chord: [-12, 0, 4, 7], shimmer: true, glitter: 6, peak: 0.14 },
  { notes: [0, 4, 7, 12, 16, 19, 24, 28, 31], gap: 0.1, note: 0.4, chord: [-12, 0, 4, 7, 12], shimmer: true, glitter: 9, peak: 0.13 },
];
export const lineWin = safe(tier => {
  const e = engine(); if (!e) return;
  const ctx = e.context, now = ctx.currentTime, t = TIERS[clamp(Math.round(tier), 0, 3)];
  const bright = filter(ctx, 'lowpass', 1800 + t.notes.length * 500, 0.7, now);
  bright.connect(e.output);
  t.notes.forEach((n, i) => {
    const at = now + i * t.gap, f = semis(A4, n);
    const o = osc(ctx, 'triangle', f, at, at + t.note); if (!o) return;
    const g = ctx.createGain(); env(g, at, 0.006, t.note - 0.006, t.peak);
    o.node.connect(g); g.connect(bright);
    startVoice(o);
    // A sine an octave up adds sparkle on the higher tiers.
    if (t.notes.length >= 5) {
      const s = osc(ctx, 'sine', f * 2, at, at + t.note); if (!s) return;
      const sg = ctx.createGain(); env(sg, at, 0.006, t.note - 0.006, t.peak * 0.35);
      s.node.connect(sg); sg.connect(bright);
      startVoice(s);
    }
  });
  const chordAt = now + t.notes.length * t.gap;
  if (t.chord) {
    const hold = t.shimmer ? 1.6 - t.notes.length * t.gap : 0.5;
    const lp = filter(ctx, 'lowpass', 700, 1, chordAt);
    lp.frequency.linearRampToValueAtTime(3200, chordAt + 0.12);
    lp.frequency.linearRampToValueAtTime(900, chordAt + hold);
    const cg = ctx.createGain(); env(cg, chordAt, 0.02, hold * 0.6, 0.09, hold * 0.4);
    lp.connect(cg); cg.connect(e.output);
    t.chord.forEach(n => {
      const o = osc(ctx, 'sawtooth', semis(A4, n), chordAt, chordAt + hold); if (!o) return;
      o.node.detune.setValueAtTime(n % 2 ? 6 : -6, chordAt);
      o.node.connect(lp);
      startVoice(o);
    });
  }
  if (t.shimmer) {
    const len = 1.2;
    [semis(A4, 31), semis(A4, 36)].forEach((f, i) => {
      const s = osc(ctx, 'sine', f, chordAt, chordAt + len); if (!s) return;
      s.node.detune.setValueAtTime(i ? 9 : -9, chordAt);
      const sg = ctx.createGain(); env(sg, chordAt, 0.15, len - 0.15, 0.045);
      s.node.connect(sg); sg.connect(e.output);
      startVoice(s);
    });
  }
  // Glitter: tiny high sine pings scattered over the arpeggio.
  for (let k = 0; k < t.glitter; k++) {
    const at = now + 0.05 + (k / Math.max(1, t.glitter)) * (t.notes.length * t.gap + 0.4), f = semis(A4, 31 + ((k * 5) % 12));
    const o = osc(ctx, 'sine', f, at, at + 0.12); if (!o) break;
    const g = ctx.createGain(); env(g, at, 0.002, 0.118, 0.05);
    o.node.connect(g); g.connect(e.output);
    startVoice(o);
  }
});

// ---- coin shower ---------------------------------------------------------------------------------------
export const coinShower = safe(durationMs => {
  const e = engine(); if (!e) return;
  const ctx = e.context, now = ctx.currentTime, span = clamp(durationMs, 150, 8000) / 1000;
  const count = Math.min(48, Math.max(4, Math.round(span * 18)));
  const times = Array.from({ length: count }, () => Math.random() * span).sort((a, b) => a - b);
  times.forEach((offset, i) => {
    const at = now + offset, len = 0.07 + Math.random() * 0.05;
    if (i % 3 === 2) {
      // Every third coin is a bandpassed noise "tink".
      const n = noise(ctx, 'white', at, at + len); if (!n) return;
      const bp = filter(ctx, 'bandpass', 4000 + Math.random() * 4000, 14, at);
      const g = ctx.createGain(); env(g, at, 0.002, len - 0.002, 0.24);
      n.node.connect(bp); bp.connect(g); g.connect(e.output);
      startVoice(n);
      return;
    }
    const low = i % 7 === 5; // every so often a heavier coin lands
    const f = low ? 1100 + Math.random() * 500 : 2400 + Math.random() * 3600;
    const o = osc(ctx, low ? 'square' : 'triangle', f, at, at + len * (low ? 1.6 : 1)); if (!o) return;
    o.node.frequency.exponentialRampToValueAtTime(f * 0.94, at + len);
    const g = ctx.createGain(); env(g, at, 0.002, len * (low ? 1.6 : 1) - 0.002, low ? 0.07 : 0.13);
    o.node.connect(g); g.connect(e.output);
    startVoice(o);
  });
});

// ---- vault open ------------------------------------------------------------------------------------------
export const vaultOpen = safe(() => {
  const e = engine(); if (!e) return;
  const ctx = e.context, now = ctx.currentTime, creakLen = 0.9, boomAt = now + creakLen;
  // Reverb-like tail: a short feedback delay that the creak and the boom both send into.
  const delay = ctx.createDelay(1); delay.delayTime.setValueAtTime(0.11, now);
  const feedback = gainAt(ctx, 0.38, now), tail = gainAt(ctx, 0.3, now), send = gainAt(ctx, 0.35, now);
  delay.connect(feedback); feedback.connect(delay); delay.connect(tail); tail.connect(e.output); send.connect(delay);
  // Creak: slow saw wobbled by an LFO, squeezed through a resonant bandpass that climbs as the door swings.
  const creak = osc(ctx, 'sawtooth', 72, now, boomAt + 0.05);
  if (creak) {
    const lfo = osc(ctx, 'sine', 1.1, now, boomAt + 0.05);
    if (lfo) { const depth = gainAt(ctx, 22, now); lfo.node.connect(depth); depth.connect(creak.node.frequency); startVoice(lfo); }
    const bp = filter(ctx, 'bandpass', 320, 11, now);
    bp.frequency.exponentialRampToValueAtTime(1500, boomAt);
    const g = ctx.createGain(); env(g, now, 0.05, 0.15, 0.26, creakLen - 0.2);
    creak.node.connect(bp); bp.connect(g); g.connect(e.output); g.connect(send);
    startVoice(creak);
  }
  // Sub boom with a fast decay, plus a soft noise thud so it still reads on small speakers.
  const boom = osc(ctx, 'sine', 95, boomAt, boomAt + 0.8);
  if (boom) {
    boom.node.frequency.exponentialRampToValueAtTime(48, boomAt + 0.25);
    const g = ctx.createGain(); env(g, boomAt, 0.008, 0.75, 0.45);
    boom.node.connect(g); g.connect(e.output); g.connect(send);
    startVoice(boom);
  }
  const thud = noise(ctx, 'white', boomAt, boomAt + 0.25);
  if (thud) {
    const lp = filter(ctx, 'lowpass', 400, 1, boomAt);
    const g = ctx.createGain(); env(g, boomAt, 0.004, 0.24, 0.2);
    thud.node.connect(lp); lp.connect(g); g.connect(e.output); g.connect(send);
    startVoice(thud);
  }
  // Sub layer: a slow 38 Hz swell under the boom, felt more than heard.
  const sub = osc(ctx, 'sine', 38, boomAt, boomAt + 1.3);
  if (sub) {
    const g = ctx.createGain(); env(g, boomAt, 0.03, 1.0, 0.18, 0.25);
    sub.node.connect(g); g.connect(e.output);
    startVoice(sub);
  }
});

// ---- fanfare ----------------------------------------------------------------------------------------------
const BRASS = [-12, -5, 0, 4, 7, 12];
function brassChord(ctx, out, at, length, peak, detuned) {
  const lp = filter(ctx, 'lowpass', 500, 1.5, at);
  lp.frequency.linearRampToValueAtTime(2800, at + 0.05);
  lp.frequency.linearRampToValueAtTime(1300, at + length);
  const g = ctx.createGain(); env(g, at, 0.012, length * 0.45, peak, length * 0.55);
  lp.connect(g); g.connect(out);
  BRASS.forEach((n, i) => {
    const o = osc(ctx, 'sawtooth', semis(A4, n), at, at + length); if (!o) return;
    if (detuned) o.node.detune.setValueAtTime(i % 2 ? 8 : -8, at);
    o.node.connect(lp);
    startVoice(o);
  });
}
export const fanfare = safe(() => {
  const e = engine(); if (!e) return;
  const ctx = e.context, now = ctx.currentTime;
  [0, 0.2, 0.4].forEach(off => brassChord(ctx, e.output, now + off, 0.15, 0.085, false));
  brassChord(ctx, e.output, now + 0.66, 1.3, 0.075, true);
});

// ---- retrigger ---------------------------------------------------------------------------------------------
export const retrigger = safe(() => {
  const e = engine(); if (!e) return;
  const ctx = e.context, now = ctx.currentTime;
  [semis(A4, 19), semis(A4, 26)].forEach((f, i) => {
    const at = now + i * 0.11, len = 0.35;
    const o = osc(ctx, 'sine', f, at, at + len);
    if (o) { const g = ctx.createGain(); env(g, at, 0.004, len - 0.004, 0.22); o.node.connect(g); g.connect(e.output); startVoice(o); }
    const t = osc(ctx, 'triangle', f * 2, at, at + len * 0.6);
    if (t) { const g = ctx.createGain(); env(g, at, 0.004, len * 0.6 - 0.004, 0.08); t.node.connect(g); g.connect(e.output); startVoice(t); }
  });
});

// ---- count tick ---------------------------------------------------------------------------------------------
let lastTickAt = -Infinity;
export const countTick = safe(progress => {
  const e = engine(); if (!e) return;
  const ctx = e.context, now = ctx.currentTime;
  if (now - lastTickAt < 0.05) return;       // at most ~20 ticks per second
  const p = clamp(progress, 0, 1);
  const o = osc(ctx, 'square', 900 + p * 1500, now, now + 0.03); if (!o) return;
  lastTickAt = now;
  o.node.frequency.exponentialRampToValueAtTime(600 + p * 900, now + 0.025);
  const hp = filter(ctx, 'highpass', 700, 0.7, now);
  const g = ctx.createGain(); env(g, now, 0.001, 0.024, 0.09 + p * 0.04);
  o.node.connect(hp); hp.connect(g); g.connect(e.output);
  startVoice(o);
});

// ---- ambient bed ----------------------------------------------------------------------------------------------
// Two detuned low tones and a slow filtered pink wash, peaking around -24 dBFS: felt as room tone, not music.
export const AMBIENT_PEAK = 0.06;
let ambient = null;
function stopAmbient(fade) {
  if (!ambient) return;
  const { ctx, voices, gain } = ambient;
  ambient = null;
  const now = ctx.currentTime, end = now + fade;
  fadeTo0(gain, now, end);
  stopVoices(voices, end + 0.01);
}
export const ambientStart = safe(() => {
  if (ambient) return;
  const e = engine(); if (!e) return;
  const ctx = e.context, now = ctx.currentTime, voices = [];
  const gain = gainAt(ctx, 0, now);
  gain.gain.linearRampToValueAtTime(1, now + 2.5);
  gain.connect(e.output);
  const lp = filter(ctx, 'lowpass', 180, 0.7, now);
  lp.connect(gain);
  [[55, -4], [82.41, 5]].forEach(([f, det]) => {
    const o = osc(ctx, 'triangle', f, now, Infinity); if (!o) return;
    o.node.detune.setValueAtTime(det, now);
    const g = gainAt(ctx, AMBIENT_PEAK * 0.35, now);
    o.node.connect(g); g.connect(lp);
    voices.push(o);
  });
  const wash = noise(ctx, 'pink', now, Infinity, true);
  if (wash) {
    const bp = filter(ctx, 'bandpass', 420, 0.9, now);
    const wg = gainAt(ctx, AMBIENT_PEAK * 0.3, now);
    wash.node.connect(bp); bp.connect(wg); wg.connect(gain);
    voices.push(wash);
    const lfo = osc(ctx, 'sine', 0.07, now, Infinity);
    if (lfo) { const depth = gainAt(ctx, 160, now); lfo.node.connect(depth); depth.connect(bp.frequency); voices.push(lfo); }
  }
  if (!voices.length) return;
  ambient = { ctx, voices: voices.map(v => v.voice), gain };
  for (const v of voices) startVoice(v);
});
export const ambientStop = safe(() => stopAmbient(0.6));

// ---- recorded voice clips ------------------------------------------------------------------------------------------
// Clips are optional: a missing or undecodable file is remembered as null and never fetched again.
export const VOICE_DIR = '/slots/voice/';
export const VOICE_GAIN = 0.9;
const voiceCache = new Map(); // name -> Promise<AudioBuffer | null>
let voiceLoader = defaultVoiceLoader;
async function defaultVoiceLoader(name, ctx) {
  const r = await fetch(`${VOICE_DIR}${name}.mp3`);
  if (!r.ok || !/audio|octet/.test(r.headers.get('content-type') || 'audio')) return null;
  return ctx.decodeAudioData(await r.arrayBuffer());
}
// Test hook: inject a loader (name, ctx) => Promise<buffer | null>. Passing nothing restores fetch + decode.
export function __setVoiceLoader(fn) { voiceLoader = typeof fn === 'function' ? fn : defaultVoiceLoader; voiceCache.clear(); }
function loadVoice(name, ctx) {
  if (!voiceCache.has(name)) {
    voiceCache.set(name, Promise.resolve().then(() => voiceLoader(name, ctx)).then(b => (b && b.duration > 0 ? b : null)).catch(() => null));
  }
  return voiceCache.get(name);
}
let current = null; // { voice, node, name } playing now
let queued = null;  // name waiting for the current clip to end
let voiceSeq = 0;
function stopCurrentVoice() {
  if (!current) return;
  const { voice, node } = current;
  current = null;
  try { voice.end = voice.ctx.currentTime; node.stop(); } catch { /* already finished */ }
}
function playVoiceBuffer(e, name, buffer) {
  const ctx = e.context, now = ctx.currentTime, end = now + buffer.duration;
  if (!roomFor(ctx, now, end)) return;
  const node = ctx.createBufferSource();
  node.buffer = buffer;
  const g = gainAt(ctx, VOICE_GAIN, now);
  node.connect(g); g.connect(e.output);
  const voice = track(node, now, end);
  voice.ctx = ctx;
  current = { voice, node, name };
  node.onended = () => {
    live.delete(voice);
    if (current && current.node === node) current = null;
    if (queued) { const next = queued; queued = null; voice_(next); }
  };
  node.start(now);
}
function voice_(name, { queue = false } = {}) {
  if (typeof name !== 'string' || !/^[a-z0-9_]+$/i.test(name)) return;
  const e = engine(); if (!e) return;
  if (queue && current) { queued = name; return; }
  const seq = ++voiceSeq;
  stopCurrentVoice(); queued = null;
  loadVoice(name, e.context).then(buffer => {
    if (!buffer || seq !== voiceSeq) return; // a newer voice took over while this one loaded
    const live_ = engine(); if (!live_) return;
    stopCurrentVoice();
    playVoiceBuffer(live_, name, buffer);
  });
}
export const voice = safe((name, opts) => voice_(name, opts));
// Test and QA hook: the name of the clip playing now, or null.
export const __currentVoice = () => (current ? current.name : null);

// Mute or volume 0: nothing new is scheduled (engine() returns null) and everything running stops at once.
try {
  subscribeAudioSettings(() => {
    if (effectiveVolume() !== 0) return;
    stopLoop(0.005);
    stopRiser(0.005);
    stopAmbient(0.005);
    stopCurrentVoice(); queued = null;
  });
} catch { /* Settings module unavailable: cues simply follow the engine getter. */ }
