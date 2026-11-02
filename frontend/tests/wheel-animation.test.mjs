import test from 'node:test';
import assert from 'node:assert/strict';
import { flightAt, makeFlight, WHEEL_ORDER } from '../src/wheelMotion.js';
import { flightKeyframes, ballTransform, createWheelAnimation } from '../src/wheelAnimation.js';

test('compositor keyframes sample authoritative physics for every pocket and speed', () => {
 for (const requested of [3.1, 5.2]) for (const number of WHEEL_ORDER) {
  const flight = makeFlight(-1800, number, 6, requested, 137);
  const duration = flight.duration;
  const frames = flightKeyframes(flight, duration * 1000, 137);
  assert.equal(frames[0].offset, 0);
  assert.equal(frames.at(-1).offset, 1);
  assert.ok(frames.length >= duration * 120);
  for (const impact of flight.impacts) assert.ok(frames.some(f => f.offset === impact), 'every impact is an exact keyframe');
  for (const frame of frames) {
   assert.deepEqual(Object.keys(frame).sort(), ['offset', 'transform']);
   assert.equal(frame.transform, ballTransform(flightAt(flight, frame.offset), 137 + 22.5 * (duration * 1000) / 1000 * frame.offset));
   assert.ok(!frame.transform.includes('NaN'));
  }
  assert.equal(frames.at(-1).transform, ballTransform({ angle: flight.end, radius: 250, hop: 0 }));
 }
});

function harness() {
 const animations = [], timers = new Map(); let serial = 0;
 const element = () => ({ style: {}, dataset: {}, animate(frames, options) {
  const animation = { frames, options, currentTime: 0, startTime: null, cancelled: false, cancel() { this.cancelled = true; } };
  animations.push(animation); return animation;
 } });
 const rotor = element(), carrier = element(), ball = element(), root = element();
 const timeline = { currentTime: 1234 };
 const calls = { roll: 0, drop: 0, settled: 0 };
 const wheel = createWheelAnimation({ rotor, carrier, ball, root, timeline,
  roll: () => calls.roll++, drop: () => calls.drop++, settled: () => calls.settled++,
  setTimer: fn => { const id = ++serial; timers.set(id, fn); return id; },
  clearTimer: id => timers.delete(id),
  setTelemetry: fn => { timers.set('telemetry', fn); return 'telemetry'; },
  clearTelemetry: id => timers.delete(id),
 });
 return { wheel, rotor, carrier, ball, root, timeline, animations, timers, calls };
}

test('shared constant-speed carriers and retained final pose do not depend on finish JS', () => {
 const h = harness();
 assert.equal(h.animations.length, 2);
 assert.deepEqual(h.animations[0].frames, [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }]);
 for (const a of h.animations) {
  assert.equal(a.startTime, 1234);
  assert.equal(a.options.duration, 16000);
  assert.equal(a.options.iterations, Infinity);
  assert.equal(a.options.easing, 'linear');
 }
 h.wheel.spin('round1', 32, 3.1, 6);
 h.wheel.spin('round1', 32, 3.1, 6);
 assert.equal(h.calls.roll, 1);
 assert.equal(h.animations.length, 3);
 const flight = h.animations[2];
 assert.equal(flight.options.fill, 'forwards');
 assert.equal(flight.startTime, h.timeline.currentTime);
 const final = flight.frames.at(-1).transform;
 // A stalled main thread leaves fill-forwards in a constantly turning carrier.
 assert.equal(h.animations[1].cancelled, false);
 const finish = flight.onfinish;
 flight.currentTime = 3100;
 finish(); finish();
 assert.equal(h.ball.style.transform, final);
 assert.equal(flight.cancelled, true);
 assert.deepEqual(h.calls, { roll: 1, drop: 1, settled: 1 });
 h.wheel.spin('round2', 26, 5.2, 5);
 assert.equal(h.animations[3].frames[0].transform, final);
 h.wheel.dispose();
 assert.ok(h.animations.every(a => a.cancelled));
 assert.equal(h.timers.size, 0);
});

test('interruption cancels stale completion and reports telemetry without driving motion', () => {
 const h = harness();
 h.wheel.spin(1, 17, 5.2, 6);
 const old = h.animations[2], stale = old.onfinish;
 old.currentTime = 2600; h.animations[0].currentTime = 2000;
 h.timers.get('telemetry')();
 assert.equal(Number(h.root.dataset.wheelAngle), 45);
 assert.equal(h.root.dataset.phase, 'rolling');
 assert.equal(h.ball.style.transform, ballTransform({ angle: -90 + 180 / 37, radius: 250, hop: 0 }));
 h.wheel.spin(2, 0, 3.1, 6);
 stale();
 assert.equal(h.calls.settled, 0);
 assert.equal(old.cancelled, true);
 h.wheel.dispose();
 assert.equal(h.animations[3].onfinish, null);
});
