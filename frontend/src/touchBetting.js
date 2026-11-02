export function visibleChipSize(layout,scale,type,mobile){
 if(!mobile)return layout.sizeFor(type);
 const cell=layout.rectOf[1].w*scale;
 return Math.max(type==='straight'?20:17,Math.min(type==='straight'?24:20,cell*(type==='straight'?.9:.8)))/scale;
}

// Invisible mobile hit areas only. Keep the felt and chip anchors unchanged.
// Shared edges span the full cell; corners win overlapping junctions via z-order.
export function touchHitSize(layout,zone,scale,mobile){
 if(!mobile||!['split','corner'].includes(zone.type))return{w:zone.w,h:zone.h};
 const cell=layout.rectOf[zone.type==='split'?(zone.value.find(n=>n!==0)):1];
 const shortest=Math.min(cell.w,cell.h)*scale;
 if(zone.type==='corner'){const size=Math.min(18,shortest*.65)/scale;return{w:Math.max(zone.w,size),h:Math.max(zone.h,size)}}
 const edge=Math.min(14,shortest*.5)/scale;
 const [a,b]=zone.value.map(n=>layout.rectOf[n]);
 const vertical=zone.value.includes(0)||Math.abs(a.x-b.x)>.01;
 return vertical?{w:Math.max(zone.w,edge),h:Math.max(zone.h,cell.h)}:{w:Math.max(zone.w,cell.w),h:Math.max(zone.h,edge)};
}

