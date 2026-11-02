import test from 'node:test';
import assert from 'node:assert/strict';

let sequence = 0;
async function setup({ failFetch = false, failDecode = false, suspended = false } = {}) {
  const fetched = [], sources = [], gains = [], decoded = [];
  class AudioContext {
    constructor() { this.currentTime = 0; this.state = suspended ? 'suspended' : 'running'; this.destination = {}; this.resumes = 0; }
    resume() { this.resumes++; this.state = 'running'; return Promise.resolve(); }
    async decodeAudioData(bytes) { if (failDecode) throw Error('decode'); const buffer = { duration: 0.2, bytes }; decoded.push(buffer); return buffer; }
    createOscillator() { throw Error('Recorded chip/payout effects must not synthesize oscillators'); }
    createGain() {
      const param = { value: 1, setValueAtTime(value) { this.value = value; }, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {} };
      const gain = { gain: param, connect() { return this; }, disconnect() { this.disconnected = true; } };
      gains.push(gain); return gain;
    }
    createBufferSource() {
      const source = { playbackRate: { value: 1 }, connect() { return this; }, start(...args) { this.started = args; }, stop() {}, disconnect() { this.disconnected = true; } };
      sources.push(source); return source;
    }
  }
  globalThis.window = { AudioContext };
  globalThis.fetch = async url => {
    fetched.push(url);
    if (failFetch) throw Error('offline');
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
  };
  const sound = await import(`../src/sound.js?test=${sequence++}`);
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  return { sound, fetched, sources, gains, decoded, flush };
}

test('gesture preloads and decodes chip recordings once, resuming a suspended context', async () => {
  const s = await setup({ suspended: true });
  assert.equal(s.fetched.length, 0);
  const ctx = s.sound.ensureAudioContext();
  assert.equal(ctx.resumes, 1);
  assert.equal(s.sound.ensureAudioContext(), ctx);
  await s.flush();
  assert.equal(s.fetched.length, 6);
  assert.equal(new Set(s.fetched).size, 6);
  assert.ok(s.fetched.every(url => /^\/sfx\/chip.*\.mp3$/.test(url)));
  assert.equal(s.decoded.length, 6);
  s.sound.ensureAudioContext();
  await s.flush();
  assert.equal(s.fetched.length, 6);
});

test('counting plays cached single-chip buffers quietly at most every 105ms and bounds overlap', async () => {
  const s = await setup();
  const ctx = s.sound.ensureAudioContext();
  s.sound.playCountTick(); // Not decoded yet: no stale queued playback.
  assert.equal(s.sources.length, 0);
  await s.flush();
  s.sound.playCountTick();
  assert.equal(s.sources.length, 1);
  ctx.currentTime = 0.055;
  s.sound.playCountTick();
  assert.equal(s.sources.length, 1);
  ctx.currentTime = 0.11;
  s.sound.playCountTick();
  assert.equal(s.sources.length, 2);
  assert.notEqual(s.sources[0].buffer, s.sources[1].buffer);
  ctx.currentTime = 0.22;
  s.sound.playCountTick();
  assert.equal(s.sources.length, 2, 'at most two simultaneous counting voices');
  s.sources[0].onended();
  assert.equal(s.sources[0].disconnected, true);
  s.sound.playCountTick();
  assert.equal(s.sources.length, 3);
  assert.ok(s.gains[0].gain.value === 1 && s.gains.slice(1).every(g => g.gain.value <= 0.2));
  assert.ok(s.sources.every(src => src.playbackRate.value >= 0.96 && src.playbackRate.value <= 1.04));
  assert.equal(s.fetched.length, 6);
});

test('individual payouts and tiered finale play real gathers without synthesized fanfares', async () => {
  const s = await setup();
  const ctx = s.sound.ensureAudioContext();
  await s.flush();
  s.sound.playChaChing();
  assert.equal(s.sources.length, 1);
  assert.equal(s.sources[0].buffer, s.decoded[3]);
  ctx.currentTime = 0.2;
  s.sound.playWin();
  assert.equal(s.sources[1].buffer, s.decoded[4]);
  s.sound.playWin(true);
  assert.equal(s.sources[2].buffer, s.decoded[5]);
  s.sound.playChaChing();
  assert.equal(s.sources.length, 3, 'payout overlap capped');
  assert.ok(s.gains[0].gain.value === 1 && s.gains.slice(1).every(g => g.gain.value <= 0.65));
});

test('placing, selecting and removing chips also use cached recordings', async () => {
  const s = await setup();
  s.sound.ensureAudioContext();
  await s.flush();
  s.sound.playChip(500);
  s.sound.playChipSelect();
  s.sound.playChipRemove();
  assert.equal(s.sources.length, 3);
  assert.equal(s.sources[0].buffer, s.decoded[0]);
  assert.equal(s.sources[1].buffer, s.decoded[1]);
  assert.equal(s.sources[2].buffer, s.decoded[3]);
  assert.equal(s.fetched.length, 6);
});

for (const failure of [{ failFetch: true }, { failDecode: true }]) {
  test(`failed ${failure.failFetch ? 'fetch' : 'decode'} stays silent without retries or synth fallback`, async () => {
    const s = await setup(failure);
    s.sound.playCountTick();
    s.sound.playChaChing();
    s.sound.playWin(true);
    assert.equal(s.fetched.length, 0, 'non-gesture payout calls do not create a context');
    s.sound.ensureAudioContext();
    await s.flush();
    for (let i = 0; i < 20; i++) {
      s.sound.playCountTick(); s.sound.playChaChing(); s.sound.playWin(true);
      s.sound.playChip(); s.sound.playChipSelect(); s.sound.playChipRemove();
    }
    await s.flush();
    assert.equal(s.sources.length, 0);
    assert.equal(s.fetched.length, 6);
  });
}

test('unsupported audio and suspended playback fail silently', async () => {
  const s = await setup();
  globalThis.window = {};
  assert.equal(s.sound.ensureAudioContext(), null);
  assert.doesNotThrow(() => { s.sound.playChip(); s.sound.playCountTick(); s.sound.playWin(); });
  assert.equal(s.fetched.length, 0);
  const ready = await setup();
  const ctx = ready.sound.ensureAudioContext();
  await ready.flush();
  ctx.state = 'suspended';
  ready.sound.playCountTick(); ready.sound.playChaChing(); ready.sound.playWin();
  assert.equal(ready.sources.length, 0);
});

test('recorded ball roll/drop keep their existing asset playback API', async () => {
  const s = await setup();
  const played = [];
  globalThis.Audio = class {
    constructor(url) { this.url = url; }
    play() { played.push(this); return Promise.resolve(); }
  };
  s.sound.playRealBallRoll(0.4);
  s.sound.playRealBallDrop(0.3);
  assert.match(played[0].url, /^\/sfx\/ballSpin_[123]\.mp3$/);
  assert.match(played[1].url, /^\/sfx\/ballDrop_[123]\.mp3$/);
  assert.equal(played[0].volume, 0.4);
  assert.equal(played[1].volume, 0.3);
  delete globalThis.Audio;
});
