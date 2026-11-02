// The winning straight-up chip stays at its cell centre on the real felt, and its
// "+$" payout pop is centred on that same anchor.
const assert=require('node:assert/strict');const{open,sleep}=require('./mobile-controls-qa.cjs');
(async()=>{for(const[w,h]of[[390,844],[874,402],[1440,900]]){const x=await open(w,h);await x.tap('button[title="10 $TICS chip (key 3)"]');
 await x.ev(`(()=>{for(let n=0;n<=36;n++)document.querySelector('[data-zone-key="straight:'+n+'"]').click()})()`);
 await x.tap('button[title="Spin (Space)"]');
 for(let i=0;i<200;i++){await sleep(100);if(await x.ev(`!!document.querySelector('.felt-payout-pop[data-payout-key^="straight:"]')`))break}
 await sleep(400);
 const m=await x.ev(`(()=>{const p=document.querySelector('.felt-payout-pop[data-payout-key^="straight:"]'),k=p.dataset.payoutKey,n=k.split(':')[1],cell=document.querySelector('[data-cell-number="'+n+'"]').getBoundingClientRect(),chip=document.querySelector('[data-bet-key="'+k+'"] [data-chip-total]').getBoundingClientRect(),pr=p.getBoundingClientRect();return{number:n,dx:chip.x+chip.width/2-cell.x-cell.width/2,dy:chip.bottom-chip.width/2-cell.y-cell.height/2,popDx:pr.left-(cell.x+cell.width/2),labels:document.querySelectorAll('.felt-payout-label').length,totals:document.querySelectorAll('.felt-payout-total').length,labelOnCell:(()=>{const l=document.querySelector('.felt-payout-label').getBoundingClientRect(),c={x:cell.x+cell.width/2,y:cell.y+cell.height/2},f=document.querySelector('.felt-table').getBoundingClientRect();return l.left<=c.x&&c.x<=l.right&&l.top<=c.y&&c.y<=l.bottom&&l.left>=f.left-1&&l.right<=f.right+1&&l.top>=f.top-1&&l.bottom<=f.bottom+1})()}})()`);
 assert.equal(m.labels,1);assert.equal(m.totals,0,'one win shows one amount');assert.ok(m.labelOnCell,'amount sits on the winning number, inside the felt '+JSON.stringify(m));
 assert.ok(Math.abs(m.dx)<1&&Math.abs(m.dy)<1&&Math.abs(m.popDx)<1,JSON.stringify(m));assert.deepEqual(x.errors,[]);await x.close();
 console.log('PASS winning chip and payout pop keep the original cell-centre anchor',w,h,JSON.stringify(m))}})().catch(e=>{console.error(e);process.exit(1)});
