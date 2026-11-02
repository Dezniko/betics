import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {makeLayout,betKey} from '../src/boardLayout.js';

// Winnings are paid on the real felt: each winning wager gets a "+X $TICS" pop
// at its own chip anchor, and earlier pops stay as later ones are added.
test('payout pops sit on the winning chips and accumulate on the real felt',async()=>{
 const server=await createServer({root:new URL('..',import.meta.url).pathname,server:{middlewareMode:true},appType:'custom',logLevel:'silent'});
 try{
  const {default:Board}=await server.ssrLoadModule('/src/RouletteBoard.jsx');
  const bets=[{type:'straight',value:27,amountCents:500,chips:[500]},{type:'split',value:[27,30],amountCents:1000,chips:[1000]},{type:'red',value:null,amountCents:200,chips:[200]}];
  const layout=makeLayout(false);
  const render=payouts=>renderToStaticMarkup(createElement(Board,{bets,payouts,settledPocket:27,showResults:true,onAddBet(){},onRemoveBet(){}}));
  const first=render([{key:betKey('straight',27),amountCents:18000}]);
  assert.equal((first.match(/class="felt-payout-pop"/g)||[]).length,1);
  assert.equal((first.match(/\+180 \$TICS/g)||[]).length,1,'one win shows its amount exactly once');
  assert.equal(first.includes('felt-payout-total'),false,'no total pill for a single win');
  const all=render([{key:betKey('straight',27),amountCents:18000},{key:betKey('split',[27,30]),amountCents:18000},{key:betKey('red',null),amountCents:400}]);
  assert.equal((all.match(/class="felt-payout-pop"/g)||[]).length,3);
  assert.match(all,/TOTAL WIN/);
  for(const b of bets){
   const a=layout.anchorOf(b),key=betKey(b.type,b.value);
   const m=all.match(new RegExp(`data-payout-key="${key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}"[^>]*style="left:([\\d.]+)px;top:([\\d.]+)px`));
   assert.ok(m,`pop for ${key}`);assert.equal(Number(m[1]),a.x);assert.equal(Number(m[2]),a.y);
  }
  assert.equal(render([]).includes('felt-payout-pop'),false);
 }finally{await server.close();}
});
