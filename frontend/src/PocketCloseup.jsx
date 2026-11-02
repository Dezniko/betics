import { useId } from 'react';
import { WHEEL_ORDER, pocketAngle } from './wheelMotion.js';
import { pocketColor } from './rouletteRules.js';
import { WheelDefinitions, RotorArtwork, WheelBall, wheelPoint } from './WheelArtwork.jsx';

// A static camera on the SAME rotor, not a second spin or invented number strip.
export default function PocketCloseup({ pocket = 0, compact = false }) {
 const id = `closeup-${useId().replace(/:/g, '')}`;
 const selected = WHEEL_ORDER.includes(pocket) ? pocket : 0;
 const index = WHEEL_ORDER.indexOf(selected);
 const neighbors = [WHEEL_ORDER[(index + 36) % 37], selected, WHEEL_ORDER[(index + 1) % 37]];
 const angle = pocketAngle(selected);
 const color = pocketColor(selected);
 const [x, y] = wheelPoint(250, angle);
 return <div data-testid="pocket-closeup" data-pocket={selected} className={compact ? 'compact-pocket-camera' : ''} style={{ height: compact ? '100%' : undefined, display: compact ? 'flex' : undefined, flexDirection: 'column', width: '100%', minWidth: 0, overflow: 'hidden', borderRadius: 14, padding: 4, boxSizing: 'border-box', background: 'linear-gradient(145deg, #d1b57a, #685134 28%, #241d16 55%, #9d7c46)', boxShadow: '0 10px 24px #0007, inset 0 1px 0 #f5e3bd66' }}>
  <svg viewBox="372 174 280 150" width="100%" role="img" aria-label={`Ball landed in ${selected}. Adjacent pockets: ${neighbors[0]} and ${neighbors[2]}.`} style={{ display: 'block', width: '100%', height: compact ? 0 : 'auto', flex: compact ? '1 1 0' : undefined, minHeight: 0, aspectRatio: compact ? undefined : '280 / 150', borderRadius: 10, background: '#241711' }}>
   <WheelDefinitions id={id}/>
   {/* Both artwork AND ball inherit this direct rotor transform. The selected
       pocket center becomes -90 degrees, with its genuine neighbors unchanged. */}
   <g data-testid="closeup-rotor" transform={`rotate(${-90 - angle} 512 512)`}>
    <RotorArtwork id={id}/>
    <g data-testid="closeup-ball" transform={`translate(${x} ${y})`}><g data-testid="closeup-ball-light" transform={`rotate(${90 + angle})`}><WheelBall id={id}/></g></g>
   </g>
  </svg>
  <div style={{display:'flex',alignItems:'center',gap:14,padding:'10px 14px',background:'linear-gradient(105deg,#181613,#090909)',borderRadius:'0 0 9px 9px',color:'#f4ead4'}}>
   <strong style={{display:'grid',placeItems:'center',minWidth:58,height:48,borderRadius:6,background:color==='red'?'#ad2423':color==='green'?'#08623e':'#252629',boxShadow:'inset 0 1px 0 #ffffff24',fontSize:34,lineHeight:1}}>{selected}</strong>
   <div><div style={{fontSize:9,letterSpacing:'.22em',color:'#b7a889'}}>BALL CONFIRMED</div><div style={{fontSize:18,fontWeight:700,letterSpacing:'.08em'}}>{selected===0?'ZERO':selected%2?'ODD':'EVEN'}</div></div>
  </div>
 </div>;
}
