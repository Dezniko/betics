import test from 'node:test';
import assert from 'node:assert/strict';
import {makeFlight,flightAt,pocketAngle,WHEEL_SPEED,POCKET_DEGREES,REST_OFFSET} from '../src/wheelMotion.js';

const wrap=d=>((d%360)+540)%360-180;

test('simulated ball lands exactly in the server pocket for every pocket, both speeds and any start',()=>{
 for(const duration of [3.1,5.2])for(let n=0;n<37;n++)for(const [start,wheel,seed] of [[-900,0,6],[0,45,1],[180,300,77],[720,123,9001]]){
  const f=makeFlight(start,n,seed,duration,wheel);
  assert.ok(Math.abs(f.duration-duration)<1.15,`duration ${f.duration} for ${duration}`);
  const final=flightAt(f,1);
  assert.ok(Math.abs(wrap(final.angle-pocketAngle(n)))<=REST_OFFSET+1e-7,`pocket ${n}`);
  assert.ok(REST_OFFSET+12/250*180/Math.PI<=POCKET_DEGREES/2+0.1,'resting ball stays inside its pocket');
  assert.equal(final.radius,250);assert.equal(final.hop,0);
  // The visible pose just before the end is already at rest in that pocket (no snap).
  const near=flightAt(f,1-0.02/f.duration);
  assert.ok(Math.abs(wrap(near.angle-final.angle))<0.1 && Math.abs(near.radius-250)<0.5);
 }
});

test('ball never reverses or speeds up in screen space before it reaches the rotor',()=>{
 for(const duration of [3.1,5.2])for(const n of [0,17,26])for(const seed of [1,2,3]){
  const f=makeFlight(0,n,seed,duration,90);
  let previous=flightAt(f,0).angle+90,previousSpeed=Infinity;
  const steps=Math.floor(f.contactAt*3000);
  for(let i=1;i<=steps;i++){
   const t=i/3000,screen=flightAt(f,t).angle+90+WHEEL_SPEED*f.duration*t;
   assert.ok(screen<=previous+1e-6,`reversal ${n} ${seed} ${t}`);
   const speed=previous-screen;assert.ok(speed<=previousSpeed+1e-6,`speed-up ${n} ${seed} ${t}`);
   previous=screen;previousSpeed=speed;
  }
 }
});

test('on the rotor the ball bounces: real hops, radial rebounds and fret rattles across pockets',()=>{
 let rattles=0,pocketsCrossed=0;
 for(const seed of [1,2,3,4,5]){
  const f=makeFlight(0,20,seed,5.2,0);
  let maxHop=0,up=0,down=0,prevR=flightAt(f,f.contactAt).radius,prevA=flightAt(f,f.contactAt).angle,prevD=0;
  const pk0=Math.floor((prevA+90)/POCKET_DEGREES);
  for(let i=Math.ceil(f.contactAt*4000);i<=4000;i++){
   const p=flightAt(f,i/4000);maxHop=Math.max(maxHop,p.hop);
   if(p.radius>prevR+1e-6)up++;if(p.radius<prevR-1e-6)down++;
   const d=p.angle-prevA;if(Math.abs(d)>1e-6){if(prevD&&Math.sign(d)!==Math.sign(prevD))rattles++;prevD=d;}
   prevR=p.radius;prevA=p.angle;
  }
  pocketsCrossed+=Math.abs(Math.floor((f.end+90)/POCKET_DEGREES)-pk0);
  assert.ok(maxHop>2,`visible hop for seed ${seed}`);assert.ok(up>0&&down>0);
  assert.ok(f.impacts.filter(x=>x>=f.contactAt).length>=2,'several impacts after reaching the rotor');
 }
 assert.ok(pocketsCrossed>=10,'ball scatters across several pockets before settling');
});

test('the same seed reproduces the same flight; different seeds differ',()=>{
 const a=makeFlight(10,5,42,5.2,30),b=makeFlight(10,5,42,5.2,30),c=makeFlight(10,5,43,5.2,30);
 assert.deepEqual(a.samples,b.samples);assert.notDeepEqual(a.samples,c.samples);
});

// Dez: a real ball hits the walls inside a pocket and keeps bouncing around
// and out of the pocket until it is too slow to escape. Earlier he rejected big
// backward runs across the wheel, so rebounds stay local.
test('pocket rattle looks real: wall rebounds, sometimes bounces out, local only, then stops',()=>{
 const pk=a=>Math.floor((a+90)/POCKET_DEGREES);const nets=[];let bouncedOut=0,runs=0;
 for(const duration of [4.4,5.2])for(let seed=1;seed<=24;seed++){
  const f=makeFlight(0,(seed*7)%37,seed,duration,40);const N=Math.round(f.duration*480);runs++;
  const c=Math.ceil(f.contactAt*N);let prev=flightAt(f,c/N),back=0,peak=0,dir=0,rev=0,afterRev=0,prevPk=pk(prev.angle),lastMove=c;
  for(let i=c+1;i<=N;i++){const p=flightAt(f,i/N);const d=p.angle-prev.angle;
   if(d>0)back+=d;peak=Math.max(peak,p.hop);
   if(Math.abs(d)>1e-4){const s=Math.sign(d);if(dir&&s!==dir)rev++;dir=s;lastMove=i}
   const k=pk(p.angle);if(k!==prevPk){if(rev)afterRev++;prevPk=k}prev=p;}
  if(afterRev)bouncedOut++;
  const net=(flightAt(f,f.contactAt).angle-f.end)/POCKET_DEGREES; nets.push(net);
  assert.ok(net>=2,`carried on across pockets in its travel direction (net ${net.toFixed(1)}, seed ${seed})`);
  assert.ok(rev>=1,`bounces off a pocket wall at least once (seed ${seed})`);
  assert.ok(back/POCKET_DEGREES<=2,`rebounds stay local, no long backward runs (${(back/POCKET_DEGREES).toFixed(2)} pockets, seed ${seed})`);
  assert.ok(peak>=5,`visible hops (peak ${peak.toFixed(1)}, seed ${seed})`);
  assert.ok(peak<=26,`hops stay small, a few mm on a real wheel (peak ${peak.toFixed(1)}, seed ${seed})`);
  assert.ok(f.impacts.filter(x=>x>=f.contactAt).length>=4,'several fret/bounce impacts');
  assert.ok((N-lastMove)/N*f.duration<=0.6,`no long creep once it has stopped (seed ${seed})`);
 }
 assert.ok(bouncedOut/runs>=0.3,`balls often bounce back out of a pocket after hitting its wall (${bouncedOut}/${runs})`);
 nets.sort((a,b)=>a-b);const median=nets[Math.floor(nets.length/2)];
 assert.ok(median>=6&&median<=20,`typical scatter ~6-20 pockets (median ${median.toFixed(1)})`);
});

// Dez: on a real wheel the ball can also run up onto the wooden centre cone,
// but only when its own motion carries it there. It must roll back down into
// the pockets by itself and still finish in the server's pocket.
test('ball sometimes runs up onto the wooden cone naturally and rolls back into a pocket',()=>{
 let visits=0,runs=0;
 for(const duration of [4.4,5.2])for(let seed=1;seed<=30;seed++){
  const n=(seed*11)%37,f=makeFlight(0,n,seed,duration,40);const N=Math.round(f.duration*240);runs++;
  let minR=999,prev=null,outward=true;
  for(let i=Math.ceil(f.contactAt*N);i<=N;i++){const p=flightAt(f,i/N);if(p.radius<226){if(minR>=226)visits++;minR=Math.min(minR,p.radius)}prev=p;}
  if(minR<226)assert.ok(minR>=150,'stays on the cone, below the centre turret');
  const end=flightAt(f,1);assert.equal(end.radius,250,'finishes resting in a pocket');
  assert.ok(Math.abs(((end.angle-pocketAngle(n))%360+540)%360-180)<=REST_OFFSET+1e-6,`still lands in pocket ${n}`);
 }
 assert.ok(visits/runs>=0.1&&visits/runs<=0.45,`occasional, not every spin (${visits}/${runs})`);
});
