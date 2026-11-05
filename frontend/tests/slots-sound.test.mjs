// Gods of Power sound cues: every cue reaches the shared master output, nothing happens without an
// unlocked engine or when muted, the loops stop, polyphony stays bounded, and the count tick is rate limited.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { localStorage: { getItem: () => null, setItem() {} } };
const settings = await import('../src/audioSettings.js');
const sound = await import('../src/slots/slotSound.js');

function param(value = 0) {
  const calls = [];
  const p = { value, calls };
  for (const m of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime', 'cancelScheduledValues']) {
    p[m] = (...args) => { calls.push([m, ...args]); if (m === 'setValueAtTime') p.value = args[0]; return p; };
  }
  return p;
}
function fakeContext() {
  const ctx = { currentTime: 0, sampleRate: 44100, state: 'running', destination: { kind: 'destination', inputs: [] }, nodes: [], sources: [] };
  const node = kind => {
    const n = { kind, inputs: [], outputs: [], connect(to) { n.outputs.push(to); (to.inputs ||= []).push(n); return to; }, disconnect() {} };
    ctx.nodes.push(n);
    return n;
  };
  const source = kind => {
    const s = node(kind);
    s.started = null; s.stopped = null;
    s.start = at => { if (s.started !== null) throw Error('start twice'); s.started = at ?? ctx.currentTime; };
    s.stop = at => { s.stopped = at ?? ctx.currentTime; };
    ctx.sources.push(s);
    return s;
  };
  ctx.createOscillator = () => Object.assign(source('oscillator'), { frequency: param(440), detune: param(0), type: 'sine' });
  ctx.createBufferSource = () => Object.assign(source('buffer'), { playbackRate: param(1), buffer: null, loop: false });
  ctx.createGain = () => Object.assign(node('gain'), { gain: param(1) });
  ctx.createBiquadFilter = () => Object.assign(node('filter'), { frequency: param(350), Q: param(1), gain: param(0), type: 'lowpass' });
  ctx.createDelay = () => Object.assign(node('delay'), { delayTime: param(0) });
  ctx.createBuffer = (channels, length, rate) => ({ channels, length, sampleRate: rate, getChannelData: () => new Float32Array(length) });
  ctx.output = ctx.createGain();
  ctx.output.connect(ctx.destination);
  return ctx;
}
// Does this node's signal reach the master output node?
function reaches(node, target, seen = new Set()) {
  if (node === target) return true;
  if (seen.has(node)) return false;
  seen.add(node);
  return (node.outputs || []).some(o => reaches(o, target, seen));
}
function withEngine(ctx) {
  sound.__reset();
  sound.__setEngineGetter(() => ctx && ({ context: ctx, output: ctx.output }));
  return ctx;
}
const CUES = {
  spinLoopStart: () => sound.spinLoopStart(),
  reelStop: () => sound.reelStop(2),
  anticipation: () => sound.anticipation(true),
  scatter: () => sound.scatter(3),
  lineWin: () => sound.lineWin(1),
  coinShower: () => sound.coinShower(800),
  vaultOpen: () => sound.vaultOpen(),
  fanfare: () => sound.fanfare(),
  retrigger: () => sound.retrigger(),
  countTick: () => sound.countTick(0.5),
};

test('every cue schedules at least one started source whose signal reaches the master output', () => {
  for (const [name, cue] of Object.entries(CUES)) {
    const ctx = withEngine(fakeContext());
    cue();
    const started = ctx.sources.filter(s => s.started !== null);
    assert.ok(started.length > 0, `${name} starts a source`);
    assert.ok(started.some(s => reaches(s, ctx.output)), `${name} reaches the master output`);
    // Nothing bypasses the master: no source or gain connects straight to the destination.
    assert.ok(!ctx.nodes.some(n => n !== ctx.output && n.outputs.includes(ctx.destination)), `${name} never connects to ctx.destination`);
  }
});

test('without an unlocked engine every cue is a silent no-op that never throws', () => {
  withEngine(null);
  for (const cue of Object.values(CUES)) assert.doesNotThrow(cue);
  assert.doesNotThrow(() => sound.spinLoopStop());
  assert.doesNotThrow(() => sound.anticipation(false));
  // The default getter is audioSettings' engine, which is null until a gesture unlocks audio.
  sound.__setEngineGetter();
  for (const cue of Object.values(CUES)) assert.doesNotThrow(cue);
  assert.equal(sound.__liveCount(), 0);
});

test('a broken engine or odd arguments never throw', () => {
  sound.__reset();
  sound.__setEngineGetter(() => { throw Error('boom'); });
  for (const cue of Object.values(CUES)) assert.doesNotThrow(cue);
  const ctx = withEngine(fakeContext());
  ctx.createBiquadFilter = () => { throw Error('no filters here'); };
  for (const cue of Object.values(CUES)) assert.doesNotThrow(cue);
  withEngine(fakeContext());
  assert.doesNotThrow(() => { sound.reelStop(99); sound.reelStop(-3); sound.reelStop('x'); sound.scatter(0); sound.scatter(42); sound.lineWin(NaN); sound.coinShower(-5); sound.coinShower(1e9); sound.countTick(7); });
});

test('muted schedules nothing and stops the spin loop and the riser at once', () => {
  const ctx = withEngine(fakeContext());
  sound.spinLoopStart(); sound.anticipation(true);
  const loops = ctx.sources.filter(s => s.started !== null);
  assert.ok(loops.length >= 3);
  assert.ok(loops.every(s => s.stopped === null));
  ctx.currentTime = 1;
  settings.setAudioSettings({ muted: true });
  assert.ok(loops.every(s => s.stopped !== null && s.stopped <= 1.02), 'loop sources are stopped immediately on mute');
  const before = ctx.sources.length;
  for (const cue of Object.values(CUES)) cue();
  assert.equal(ctx.sources.length, before, 'muted: no new sources');
  settings.setAudioSettings({ muted: false, volume: 0 });
  for (const cue of Object.values(CUES)) cue();
  assert.equal(ctx.sources.length, before, 'volume 0: no new sources');
  settings.setAudioSettings({ muted: false, volume: 1 });
  sound.reelStop(0);
  assert.ok(ctx.sources.length > before, 'unmuted: cues play again');
});

test('spinLoopStop fades and stops every loop source; a second start does not stack loops', () => {
  const ctx = withEngine(fakeContext());
  sound.spinLoopStart();
  const n = ctx.sources.length;
  sound.spinLoopStart();
  assert.equal(ctx.sources.length, n, 'no duplicate loop');
  const loops = ctx.sources.filter(s => s.started !== null);
  assert.ok(loops.some(s => s.kind === 'buffer' && s.loop), 'the whoosh is a looping buffer');
  ctx.currentTime = 2.5;
  sound.spinLoopStop();
  for (const s of loops) { assert.ok(s.stopped !== null, 'stopped'); assert.ok(s.stopped >= 2.62 && s.stopped <= 2.64, `fade ~120 ms, got ${s.stopped}`); }
  const fades = ctx.nodes.filter(x => x.kind === 'gain' && x.gain.calls.some(c => c[0] === 'linearRampToValueAtTime' && c[1] === 0 && Math.abs(c[2] - 2.62) < 1e-9));
  assert.ok(fades.length >= 1, 'gain ramps to 0 over the fade');
  assert.doesNotThrow(() => sound.spinLoopStop());
  assert.equal(sound.__liveCount(3), 0);
  // anticipation(false) fades out the riser the same way
  sound.anticipation(true);
  const riser = ctx.sources.filter(s => s.started === 2.5);
  assert.ok(riser.length >= 1);
  ctx.currentTime = 4;
  sound.anticipation(false);
  for (const s of riser) assert.ok(s.stopped > 4 && s.stopped < 4.3);
});

test('polyphony never exceeds 24 live sources, even with a mega line win, a coin shower and the fanfare together', () => {
  const ctx = withEngine(fakeContext());
  sound.spinLoopStart();
  sound.lineWin(3); sound.coinShower(2000); sound.fanfare(); sound.vaultOpen(); sound.scatter(5);
  const started = ctx.sources.filter(s => s.started !== null);
  assert.ok(started.length > 24, `the request is heavier than the cap (${started.length} voices asked)`);
  // Sweep time in 1 ms steps and count sounding sources.
  let worst = 0;
  for (let t = 0; t <= 4; t += 0.001) {
    const live = started.filter(s => s.started <= t && (s.stopped === null || s.stopped > t)).length;
    worst = Math.max(worst, live);
    assert.ok(sound.__liveCount(t) <= sound.MAX_LIVE);
  }
  assert.ok(worst <= 24, `at most 24 sounding sources, saw ${worst}`);
  assert.ok(worst >= 12, `the cap is not reached by starving the mix (${worst})`);
  // Finished voices free their slots: later cues still play.
  ctx.currentTime = 10;
  const before = ctx.sources.length;
  sound.retrigger();
  assert.ok(ctx.sources.length > before);
});

test('countTick is rate limited to about 20 per second and rises in pitch with progress', () => {
  const ctx = withEngine(fakeContext());
  for (let i = 0; i < 60; i++) { ctx.currentTime = i / 60; sound.countTick(i / 60); } // 60 calls across one second
  const ticks = ctx.sources.filter(s => s.started !== null);
  assert.ok(ticks.length <= 21, `${ticks.length} ticks in a second`);
  assert.ok(ticks.length >= 14, `${ticks.length} ticks in a second`);
  const first = ticks[0].frequency.calls.find(c => c[0] === 'setValueAtTime')[1];
  const last = ticks.at(-1).frequency.calls.find(c => c[0] === 'setValueAtTime')[1];
  assert.ok(last > first, 'pitch rises with progress');
});

test('reel stops rise in pitch per reel and scatters rise a fifth per count', () => {
  const ctx = withEngine(fakeContext());
  const thunk = i => { const n = ctx.sources.length; sound.reelStop(i); return ctx.sources.slice(n).find(s => s.type === 'triangle').frequency.calls.find(c => c[0] === 'exponentialRampToValueAtTime')[1]; };
  const pitches = [0, 1, 2, 3, 4].map(thunk);
  for (let i = 1; i < 5; i++) assert.ok(pitches[i] > pitches[i - 1]);
  assert.ok(pitches[0] >= 90 && pitches[4] <= 140, `thunks between 90 and 140 Hz: ${pitches}`);
  const bell = n => { const k = ctx.sources.length; sound.scatter(n); return ctx.sources.slice(k)[0].frequency.calls[0][1]; };
  const bells = [1, 2, 3, 4, 5].map(bell);
  for (let i = 1; i < 5; i++) assert.ok(Math.abs(bells[i] / bells[i - 1] - 1.5) < 1e-9, 'a fifth up per scatter');
});

test('line win tiers grow longer and busier', () => {
  const ends = [0, 1, 2, 3].map(tier => {
    const ctx = withEngine(fakeContext());
    sound.lineWin(tier);
    const started = ctx.sources.filter(s => s.started !== null);
    return { count: started.length, end: Math.max(...started.map(s => s.stopped)) };
  });
  assert.equal(ends[0].count, 3);
  assert.ok(Math.abs(ends[0].end - 0.41) < 0.01, `tier 0 ends ~0.4 s: ${ends[0].end}`);
  for (let i = 1; i < 4; i++) { assert.ok(ends[i].count > ends[i - 1].count); assert.ok(ends[i].end > ends[i - 1].end); }
  assert.ok(ends[3].end >= 1.5 && ends[3].end <= 2.2, `mega ~1.6 s or more: ${ends[3].end}`);
});
