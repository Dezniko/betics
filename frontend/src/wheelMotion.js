export const WHEEL_ORDER = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];
export const POCKET_DEGREES = 360 / 37;
export const WHEEL_SPEED = 22.5;
export const pocketAngle = n => WHEEL_ORDER.indexOf(n) * POCKET_DEGREES + POCKET_DEGREES / 2 - 90;

// Geometry in the shared 1024-unit SVG space (WheelArtwork.jsx and the stator
// material image): 16 fixed diamond deflectors every 22.5° at r≈338–392.
export const DIAMOND_ANGLES = Array.from({ length: 16 }, (_, i) => i * 22.5);
const TRACK = 434, ROTOR_EDGE = 319, POCKET_ENTRY = 270, REST = 250, INNER_WALL = 238;
const DIAMOND_IN = 338, DIAMOND_OUT = 392, DIAMOND_HALF_WIDTH = 2.6, FRET_HEIGHT = 5;
const RIM_INNER = 284, RIM_OUTER = 305, GRAVITY = 3000;
// Ball (r=12 at r=250, about 2.75 deg) resting against a fret sits this far off the pocket middle.
const BALL_HALF = 12 / 250 * 180 / Math.PI;
// The bowl stops a slow ball within REST_OFFSET degrees of the pocket middle.
// Wooden centre cone inside the pockets (artwork: steel lip r=225, wood inside it).
const LIP_HEIGHT = 12, LIP_CLEAR = 300, CONE_PULL = 650, CONE_TOP = 150;
const BOWL = 60, POCKET_FRICTION = 115, CLEAR_SPEED = 120, HOP_OVER = 0.22, REBOUND = 0.35, KICK = 0.15, MAX_KICK = 250; // MAX_KICK: hops of about 10 units, a few mm on a real wheel
export const REST_OFFSET = POCKET_FRICTION / BOWL; // where the bowl can no longer beat friction
export const SIM_STEP = 1 / 240;

const wrap180 = d => ((d % 360) + 540) % 360 - 180;
const smooth = t => t * t * (3 - 2 * t);
const pocketIndex = rel => Math.floor((rel + 90) / POCKET_DEGREES);
const numberAtIndex = i => WHEEL_ORDER[((i % 37) + 37) % 37];

function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Per-spin physical character, fixed for the spin so the launch-speed search
// below only changes how far the ball travels before it drops.
function character(seed) {
  const rand = random(seed);
  return {
    seed,
    trackDecel: 92 + rand() * 26,       // deg/s² rolling resistance on the track
    drag: 0.00005 + rand() * 0.00002,   // air drag, deg/s² per (deg/s)²
    leaveSpeed: 300 + rand() * 45,      // |ω| below which the track can't hold the ball
    fall: 760 + rand() * 160,           // inward acceleration down the stator cone
  };
}

// Time-stepped ball physics in SCREEN space with the rotor turning at its
// constant speed: roll on the track and brake, fall down the cone, possibly
// strike a diamond, land on the rotor, skitter over / bounce off the pocket
// frets (sometimes riding the smooth rim), and settle wherever friction leaves
// it. Nothing here forces the pocket;
// makeFlight searches launch speeds for a run that ends in the real result.
function simulate(startRel, startWheel, omega0, ch, record) {
  const rand = random(ch.seed * 7919 + 17);
  const dt = SIM_STEP;
  const samples = record ? [] : null;
  let t = 0, theta = startRel + startWheel, omega = omega0;
  let r = REST, vr = 0, z = 0, vz = 0, phase = 'launch';
  let drop = null, contact = null, settleStart = null, deflected = false, rimPull = 300;
  const lipClear = LIP_CLEAR * (0.8 + rand() * 0.6);
  const struck = new Set(), impacts = [];
  const willDeflect = rand() < 0.5; // Thorp: deflectors matter about half the time
  const wheelAt = time => startWheel + WHEEL_SPEED * time;
  const gravity = () => {
    vz -= GRAVITY * dt; z += vz * dt;
    if (z <= 0) { z = 0; if (vz < -50) { vz = -vz * 0.32; impacts.push(t); } else vz = 0; }
  };
  while (t < 16) {
    if (record) samples.push(theta - wheelAt(t), r, z);
    if (phase === 'launch' || phase === 'track') {
      omega += (ch.trackDecel + ch.drag * omega * omega) * dt;
      r = phase === 'launch' ? REST + (TRACK - REST) * smooth(Math.min(1, t / 0.32)) : TRACK + 0.7 * Math.sin(t * 21);
      if (phase === 'launch' && t >= 0.32) phase = 'track';
      if (phase === 'track' && -omega < ch.leaveSpeed) { phase = 'fall'; drop = t; vr = 0; }
      theta += omega * dt;
    } else if (phase === 'fall') {
      omega = Math.min(-35, omega + 55 * dt);
      vr -= ch.fall * dt; r += vr * dt;
      if (r > DIAMOND_IN && r < DIAMOND_OUT) {
        const d = Math.round(theta / 22.5);
        if (!struck.has(d) && Math.abs(wrap180(theta - d * 22.5)) < DIAMOND_HALF_WIDTH) {
          struck.add(d);
          // A clean strike is a single, dramatic deflection; later passes graze.
          if (!deflected && willDeflect) {
            deflected = true; impacts.push(t);
            omega *= 0.62 + rand() * 0.22;
            vr = Math.abs(vr) * (0.15 + rand() * 0.25);
            vz = Math.max(vz, 230 + rand() * 200);
          }
        }
      }
      gravity();
      theta += omega * dt;
      if (r <= ROTOR_EDGE) {
        // Meets the spinning rotor at a grazing angle and is thrown back up.
        phase = 'rotor'; contact = t; impacts.push(t);
        vz = Math.max(vz, 200 + rand() * 170); vr = -(40 + rand() * 110);
        rimPull = rand() < 0.08 ? 45 : 260 + rand() * 120; // occasionally rides the rim a long way
      }
    } else {
      // On the rotor: motion relative to the turning pocket ring.
      let rel = theta - wheelAt(t), w = omega - WHEEL_SPEED;
      // One continuous model all the way to rest, no scripted settle:
      // the pocket floor is a shallow bowl (pulls the ball to its middle),
      // rolling friction drains speed, and every fret is a real wall. A ball
      // that hits a wall either has the energy to jump it (and carries on into
      // the next pocket) or bounces back off it and rattles around inside,
      // possibly hopping out again, until it is too slow to leave.
      if (z > 0 || vz > 0) gravity();
      const onRim = r > RIM_INNER; // smooth sloped number ring: no frets to hit
      const onCone = r < INNER_WALL;  // up on the wooden centre cone, inside the pockets
      const mid = pocketIndex(rel) * POCKET_DEGREES - 90 + POCKET_DEGREES / 2;
      if (onRim) vr -= rimPull * dt;
      else if (onCone) vr += (CONE_PULL - vr * 1.2) * dt; // the cone slopes up: it rolls back out
      else if (z === 0) vr += (-(r - REST) * 400 - vr * (w === 0 ? 40 : 16)) * dt;   // curved pocket bed; a stopped ball rolls straight down to its floor
      else vr += (-(r - REST) * 120 - vr * 3) * dt;
      r += vr * dt;
      // Crossing the steel lip onto the wood only happens when the ball really has
      // the energy for it (airborne over the lip, or rolling inward fast enough).
      if (!onCone && r < INNER_WALL) {
        if (z >= LIP_HEIGHT || -vr > lipClear) { vr *= 0.75; impacts.push(t); vz = Math.max(vz, Math.min(MAX_KICK, -vr * 0.35)); }
        else { r = INNER_WALL; vr = Math.abs(vr) * 0.45; impacts.push(t); }
      }
      if (r < CONE_TOP) { r = CONE_TOP; vr = Math.abs(vr) * 0.3; }
      if (r > RIM_OUTER) { r = RIM_OUTER; vr = -Math.abs(vr) * 0.4; }
      if (z === 0) {
        const friction = onRim || onCone ? 55 : POCKET_FRICTION + Math.abs(w) * 0.3;
        const bowl = onRim || onCone ? 0 : -(rel - mid) * BOWL;
        // Coulomb friction: a slow ball near the middle simply stops (sticks).
        if (Math.abs(w) <= friction * dt && Math.abs(bowl) <= friction) w = 0;
        else w += (bowl - Math.sign(w || bowl) * friction) * dt;
      }
      const next = rel + w * dt, lead = Math.sign(w) * BALL_HALF; // the ball's leading edge meets the fret, not its centre
      if (!onRim && !onCone && w !== 0 && pocketIndex(next + lead) !== pocketIndex(rel + lead)) {
        if (z < FRET_HEIGHT) {
          const speed = Math.abs(w), lin = speed * Math.PI / 180 * r, ei = pocketIndex(rel + lead), boundary = (pocketIndex(next + lead) > ei ? ei + 1 : ei) * POCKET_DEGREES - 90;
          impacts.push(t);
          if (speed > CLEAR_SPEED * (0.8 + rand() * 0.5)) {
            // Enough energy to ride up and over the fret: a hop into the next pocket.
            w *= 0.7 + rand() * 0.18;
            vz = Math.max(vz, Math.min(MAX_KICK, lin * (HOP_OVER + rand() * 0.3)));
            rel = next;
          } else {
            // Bounces off the wall back into the pocket.
            // Some of the impact turns into a vertical kick, sometimes enough
            // to pop the ball over a fret and out of the pocket.
            w = -w * (REBOUND + rand() * 0.3);
            vz = Math.max(vz, Math.min(MAX_KICK, lin * (KICK + rand() * 0.55)));
            rel = boundary - lead - Math.sign(next - rel) * 0.01;
          }
          vr += (rand() - 0.5) * Math.min(140, speed * 0.5);
        } else rel = next; // airborne: sails over the fret
      } else rel = next;
      if (!onRim && !onCone && z === 0 && vz === 0 && w === 0 && Math.abs(vr) < 2 && Math.abs(r - REST) < 0.15) {
        // At rest: hold the last few frames so the stop reads as a stop.
        if (settleStart == null) settleStart = t;
        if (t - settleStart > 0.12) {
          t += dt;
          if (record) samples.push(rel, REST, 0);
          return { samples, duration: t, end: rel, number: numberAtIndex(pocketIndex(rel)), drop, contact, impacts };
        }
      } else settleStart = null;
      theta = rel + wheelAt(t + dt); omega = w + WHEEL_SPEED;
    }
    t += dt;
  }
  return null;
}

// Finds a physically simulated flight that comes to rest in `number` near the
// requested duration by varying only the launch speed (then the spin's
// character). The server decides the outcome; physics only decides how the
// ball gets there, so the visible ball always lands in the real pocket.
export function makeFlight(startRelative, number, seed = 1, duration = 5.2, startWheel = 0) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const ch = character((seed + attempt * 104729) >>> 0);
    const trackTime = Math.max(0.7, duration - 2.1);
    const nominal = -(ch.leaveSpeed + ch.trackDecel * trackTime * 1.08);
    let best = null;
    for (let k = 0; k < 360; k++) {
      const omega0 = nominal + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.35;
      const result = simulate(startRelative, startWheel, omega0, ch, false);
      if (!result || result.number !== number) continue;
      const error = Math.abs(result.duration - duration);
      if (!best || error < best.error) best = { omega0, error };
      if (error < 0.45) break;
    }
    if (best && best.error < 1.1) {
      const run = simulate(startRelative, startWheel, best.omega0, ch, true);
      return { start: startRelative, end: run.end, duration: run.duration, samples: run.samples,
        dropAt: (run.drop + (run.contact - run.drop) * 0.55) / run.duration,
        contactAt: run.contact / run.duration, impacts: run.impacts.map(x => x / run.duration), startWheel, number };
    }
  }
  throw new Error(`No physical flight found for pocket ${number}`);
}

export function flightAt(f, t) {
  t = Math.max(0, Math.min(1, t));
  if (t >= 1) return { angle: f.end, radius: REST, hop: 0 };
  const s = f.samples, count = s.length / 3;
  const position = Math.min(count - 1, t * f.duration / SIM_STEP);
  const i = Math.floor(position), j = Math.min(count - 1, i + 1), u = position - i;
  const at = k => s[i * 3 + k] + (s[j * 3 + k] - s[i * 3 + k]) * u;
  return { angle: at(0), radius: at(1), hop: at(2) };
}
