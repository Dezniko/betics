import { WHEEL_ORDER, POCKET_DEGREES } from './wheelMotion.js';

const RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
export const wheelPoint = (r, a) => [512 + r * Math.cos(a * Math.PI / 180), 512 + r * Math.sin(a * Math.PI / 180)];
const sector = (inner, outer, a, b) => {
 const p = wheelPoint(outer, a), q = wheelPoint(outer, b), r = wheelPoint(inner, b), s = wheelPoint(inner, a);
 return `M${p} A${outer},${outer} 0 0 1 ${q} L${r} A${inner},${inner} 0 0 0 ${s} Z`;
};

// Shared SVG materials keep the live wheel and its static detail camera identical.
export function WheelDefinitions({ id }) {
 return <defs>
  <clipPath id={`${id}rotor`}><circle cx="512" cy="512" r="319"/></clipPath>
  <radialGradient id={`${id}pocket`}><stop offset="0" stopColor="#050505"/><stop offset="0.67" stopColor="#27272a"/><stop offset="1" stopColor="#080809"/></radialGradient>
  <linearGradient id={`${id}steel`}><stop stopColor="#53585b"/><stop offset="0.25" stopColor="#f7f8f8"/><stop offset="0.45" stopColor="#8b9398"/><stop offset="0.7" stopColor="#e9edef"/><stop offset="1" stopColor="#62696d"/></linearGradient>
  <radialGradient id={`${id}ivory`} cx="28%" cy="24%"><stop stopColor="white"/><stop offset="0.4" stopColor="#fffff7"/><stop offset="0.8" stopColor="#d6d5c7"/><stop offset="1" stopColor="#777a73"/></radialGradient>
  <radialGradient id={`${id}shade`}><stop offset="0.48" stopColor="#000" stopOpacity="0"/><stop offset="0.56" stopColor="#000" stopOpacity="0.26"/><stop offset="0.62" stopColor="#fff" stopOpacity="0.1"/><stop offset="0.66" stopColor="#000" stopOpacity="0"/></radialGradient>
 </defs>;
}

export function RotorArtwork({ id, pockets = WHEEL_ORDER }) {
 return <>
  <image href="/wheel/roulette-material.webp" width="1024" height="1024" clipPath={`url(#${id}rotor)`}/>
  <circle cx="512" cy="512" r="318" fill="none" stroke={`url(#${id}steel)`} strokeWidth="7"/>
  {pockets.map(n => {
   const i = WHEEL_ORDER.indexOf(n);
   const a = i * POCKET_DEGREES - 90, b = a + POCKET_DEGREES;
   const color = n === 0 ? '#08733e' : RED.has(n) ? '#c82723' : '#191b1d';
   const [x, y] = wheelPoint(299, (a + b) / 2), p = wheelPoint(226, a), q = wheelPoint(282, a);
   return <g key={n} data-pocket={n}>
    <path d={sector(282,314,a,b)} fill={color} stroke="#9c9fa0" strokeWidth="0.7"/>
    <path d={sector(226,281,a,b)} fill={`url(#${id}pocket)`}/>
    <path d={sector(228,278,a+0.65,b-0.65)} fill={color} opacity="0.68"/>
    <line x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke="#040405" strokeWidth="5.5"/>
    <line x1={p[0]-0.8} y1={p[1]-0.8} x2={q[0]-0.8} y2={q[1]-0.8} stroke={`url(#${id}steel)`} strokeWidth="3"/>
    <text x={x} y={y} fill="#fff" fontFamily="Arial Narrow, Arial, sans-serif" fontSize="23" fontWeight="800" textAnchor="middle" dominantBaseline="central" transform={`rotate(${(a+b)/2+90} ${x} ${y})`}>{n}</text>
   </g>;
  })}
  <circle cx="512" cy="512" r="283" fill="none" stroke="#dfe1e1" strokeWidth="2"/>
  <circle cx="512" cy="512" r="225" fill="none" stroke={`url(#${id}steel)`} strokeWidth="5"/>
 </>;
}

export function WheelBall({ id }) {
 return <>
  <ellipse cx="3" cy="6" rx="13" ry="10" fill="#000" opacity="0.4"/>
  <circle r="12" fill={`url(#${id}ivory)`}/>
  <circle cx="-3" cy="-4" r="2.5" fill="#fff" opacity="0.8"/>
 </>;
}
