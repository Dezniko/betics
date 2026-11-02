import { memo, useRef, useEffect, useId } from 'react';
import { playRealBallRoll, playRealBallDrop } from './sound.js';
import { pocketAngle } from './wheelMotion.js';
import { ballTransform, createWheelAnimation } from './wheelAnimation.js';
import { WheelDefinitions, RotorArtwork, WheelBall } from './WheelArtwork.jsx';
export { WHEEL_ORDER } from './wheelMotion.js';

const layer = { position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' };
const svgStyle = { display: 'block', width: '100%', height: '100%', overflow: 'visible' };
const initialBall = ballTransform({ angle: pocketAngle(0), radius: 250, hop: 0 });

function RouletteWheel({ spinToken, pocket = 0, onSettled, spinDuration = 5.2 }) {
 const id = useId().replace(/:/g, '');
 const rotor = useRef(null), carrier = useRef(null), ball = useRef(null), root = useRef(null);
 const animation = useRef(null);
 const callback = useRef(onSettled); callback.current = onSettled;
 useEffect(() => {
  const controller = createWheelAnimation({
   rotor: rotor.current, carrier: carrier.current, ball: ball.current, root: root.current,
   roll: () => playRealBallRoll(.65), drop: () => playRealBallDrop(.65),
   settled: () => callback.current?.(),
  });
  animation.current = controller;
  return () => { controller.dispose(); animation.current = null; };
 }, []);
 useEffect(() => {
  animation.current?.spin(spinToken, pocket, spinDuration, Math.floor(Math.random() * 2 ** 31));
 }, [spinToken, pocket, spinDuration]);
 return <div ref={root} data-testid="roulette-wheel" data-wheel-angle="0" data-ball-relative={pocketAngle(0)} data-ball-radius="250" data-phase="resting" className="relative mx-auto select-none" style={{ width: '100%', aspectRatio: 1, minWidth: 0 }} role="img" aria-label="European roulette wheel">
  {/* Static bowl; only HTML wrappers animate, never SVG attributes or filters. */}
  <svg viewBox="0 0 1024 1024" width="100%" height="100%" style={svgStyle} aria-hidden="true">
   <image href="/wheel/roulette-material.webp" width="1024" height="1024"/>
  </svg>
  <div ref={rotor} data-testid="wheel-rotor" style={layer}>
   <svg viewBox="0 0 1024 1024" style={svgStyle} aria-hidden="true">
    <WheelDefinitions id={`${id}rotor-`}/>
    <RotorArtwork id={`${id}rotor-`}/>
   </svg>
  </div>
  <svg viewBox="0 0 1024 1024" style={layer} aria-hidden="true">
   <WheelDefinitions id={`${id}bowl-`}/>
   <circle cx="512" cy="512" r="319" fill={`url(#${id}bowl-shade)`}/>
  </svg>
  {/* The carrier NEVER stops: capture remains physical even while finish JS waits. */}
  <div ref={carrier} data-testid="ball-carrier" style={layer}>
   <div ref={ball} data-testid="roulette-ball" style={{ ...layer, transform: initialBall }}>
    <svg viewBox="0 0 1024 1024" style={svgStyle} aria-hidden="true">
     <WheelDefinitions id={`${id}ball-`}/>
     <g transform="translate(512 512)"><WheelBall id={`${id}ball-`}/></g>
    </svg>
   </div>
  </div>
 </div>;
}
export default memo(RouletteWheel);
