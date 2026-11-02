import { WHEEL_SPEED, flightAt, makeFlight, pocketAngle } from './wheelMotion.js';

// All distances use the full-size HTML arm, so resizing needs no new animation.
// Undo the carrier rotation for the screen-vertical hop before polar placement.
export function ballTransform({ angle, radius, hop }, wheelAngle = 0) {
 const radians = wheelAngle * Math.PI / 180;
 const x = hop ? -hop * Math.sin(radians) / 1024 * 100 : 0;
 const y = hop ? -hop * Math.cos(radians) / 1024 * 100 : 0;
 return `translate(${x}%, ${y}%) rotate(${angle + 90}deg) translateY(${-radius / 1024 * 100}%) rotate(${-angle - 90}deg) scale(${1 + hop / 65})`;
}

// Lifetime matches the mounted wheel, not a round or a viewport size.
export function createWheelAnimation({ rotor, carrier, ball, root, timeline = document.timeline,
 roll, drop, settled, setTimer = setTimeout, clearTimer = clearTimeout,
 setTelemetry = setInterval, clearTelemetry = clearInterval }) {
 const rotationFrames = [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }];
 const rotationOptions = { duration: 360 / WHEEL_SPEED * 1000, iterations: Infinity, easing: 'linear' };
 const startTime = timeline.currentTime;
 const rotations = [rotor, carrier].map(element => {
  const animation = element.animate(rotationFrames, rotationOptions);
  animation.startTime = startTime;
  return animation;
 });
 let relative = pocketAngle(0), active = null, token, disposed = false;
 ball.style.transform = ballTransform({ angle: relative, radius: 250, hop: 0 });
 const wheelAngle = () => Number(rotations[0].currentTime ?? 0) / 1000 * WHEEL_SPEED;
 const pose = () => active ? flightAt(active.flight, Number(active.animation.currentTime ?? 0) / active.duration)
  : { angle: relative, radius: 250, hop: 0 };
 const cancelFlight = () => {
  if (!active) return;
  active.animation.onfinish = null;
  active.animation.cancel();
  clearTimer(active.timer);
  active = null;
 };
 const report = () => {
  const current = pose();
  root.dataset.wheelAngle = String(wheelAngle());
  root.dataset.ballRelative = String(current.angle);
  root.dataset.ballRadius = String(current.radius);
  root.dataset.phase = active ? 'rolling' : 'resting';
 };
 const telemetry = setTelemetry(report, 100);
 return {
  spin(nextToken, number, seconds, seed) {
   if (disposed || nextToken == null || token === nextToken) return;
   token = nextToken;
   relative = pose().angle;
   cancelFlight();
   // `seed` varies the spin's physical character; the simulated flight sets its own length.
   const flight = makeFlight(relative, number, seed, seconds, wheelAngle());
   const duration = flight.duration * 1000;
   const frames = flightKeyframes(flight, duration, wheelAngle());
   const animation = ball.animate(frames, { duration, easing: 'linear', fill: 'forwards' });
   animation.startTime = timeline.currentTime;
   const running = { flight, animation, duration, dropped: false, timer: null };
   active = running;
   const playDrop = () => {
    if (active !== running || running.dropped) return;
    running.dropped = true;
    drop();
   };
   running.timer = setTimer(playDrop, duration * flight.dropAt);
   animation.onfinish = () => {
    if (active !== running || disposed) return;
    // Fill-forwards already holds this relative pose inside the rotating carrier,
    // even if JS was blocked across capture. Commit before cancelling the effect.
    ball.style.transform = frames.at(-1).transform;
    relative = flight.end;
    playDrop();
    cancelFlight();
    report();
    settled();
   };
   roll();
   report();
  },
  dispose() {
   disposed = true;
   cancelFlight();
   rotations.forEach(animation => animation.cancel());
   clearTelemetry(telemetry);
  },
 };
}

export function flightKeyframes(flight, duration, wheelAngle) {
 // Linear compositor interpolation of the simulated trajectory, not a new ease.
 // Include every impact instant (crisp bounces) as well as 120 samples per second.
 const steps = Math.ceil(duration / 1000 * 120);
 const offsets = new Set([0, flight.contactAt, ...(flight.impacts || []), 1].filter(x => x >= 0 && x <= 1));
 for (let i = 0; i <= steps; i++) offsets.add(i / steps);
 return [...offsets].sort((a, b) => a - b).map(offset => ({
  offset,
  transform: ballTransform(flightAt(flight, offset), wheelAngle + WHEEL_SPEED * duration / 1000 * offset),
 }));
}
