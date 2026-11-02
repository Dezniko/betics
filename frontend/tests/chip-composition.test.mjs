import test from 'node:test';
import assert from 'node:assert/strict';
import * as chips from '../src/chips.js';
import { makeLayout } from '../src/boardLayout.js';

test('chip colours consolidate the actual stake without mutating the placement history',()=>{
 assert.equal(typeof chips.consolidatedLayers,'function');
 for(const[input,expected]of [[[5000,5000],[10000]],[[5000,5000,5000],[10000,5000]],[[50000,50000,50000],[100000,50000]],[[50000,50000],[100000]],[[100000,100000,100000,100000,100000],[500000]]]){
  const saved=[...input];assert.deepEqual(chips.consolidatedLayers(input),expected);assert.deepEqual(input,saved);
 }
 assert.equal(chips.faceLabel(1500),'15');
});
test('large stacks stay bounded but retain the correct top denominations and full amount',()=>{
 assert.equal(typeof chips.chipGroups,'function');const groups=chips.chipGroups(2501000);
 assert.equal(groups.reduce((s,g)=>s+g.cents*g.count,0),2501000);
 assert.ok(chips.consolidatedLayers([2501000]).length<=3);
 assert.equal(chips.consolidatedLayers([2501000]).at(-1),1000);
});
test('chips are $TICS: 1, 5, 10, 50, 100, 500, 1K, 5K and amounts read as $TICS, never dollars',()=>{
 assert.deepEqual(chips.CHIP_VALUES,[100,500,1000,5000,10000,50000,100000,500000]);
 assert.deepEqual(chips.DENOMS.map(d=>d.label),['1','5','10','50','100','500','1K','5K']);
 assert.equal(chips.fmtMoney(123450),'1,234.50 $TICS');
 assert.equal(chips.fmtMoney(5),'0.05 $TICS');
 assert.equal(chips.fmtMoney(10000000),'100,000.00 $TICS');
 assert.equal(chips.fmtShort(125000),'1,250 $TICS');
 assert.equal(chips.fmtShort(1250),'12.50 $TICS');
 assert.equal(chips.fmtFelt(125000),'+1,250 $TICS');
 assert.equal(chips.fmtFelt(1250000),'+12.5K $TICS');
 assert.equal(chips.fmtFelt(54000000),'+540K $TICS');
 assert.equal(chips.faceLabel(100000),'1K');
 assert.equal(chips.faceLabel(50),'0.5');
 for(const f of [chips.fmtMoney,chips.fmtShort,chips.fmtFelt])for(const v of [0,1,99,100,123456789])assert.ok(!/\$\s?\d|[\u2013\u2014]/.test(f(v))&&/\$TICS/.test(f(v)),f(v));
});
test('streets and six-lines sit on the shared number/dozen border, with no detached strip',()=>{
 for(const height of [null,200,400,700]){
  const l=makeLayout(false,height),bottom=l.rectOf[1].y+l.rectOf[1].h;
  assert.equal(l.outside.find(o=>o.type==='dozen1').y,bottom);
  for(const z of l.zones.filter(z=>z.type==='street'||z.type==='sixline'))assert.equal(z.y,bottom);
  assert.equal(l.rectOf[4].x,l.rectOf[1].x+l.rectOf[1].w);
  assert.equal(l.rectOf[1].y,l.rectOf[2].y+l.rectOf[2].h);
 }
});
