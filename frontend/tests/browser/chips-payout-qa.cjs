const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {open,sleep,OUT}=require('./mobile-controls-qa.cjs');
(async()=>{
 const x=await open(390,844);
 const stack=()=>x.ev(`(()=>{const e=document.querySelector('[data-bet-key="straight:17"] [data-chip-total]');return e?{total:Number(e.dataset.chipTotal),layers:[...e.querySelectorAll('[data-chip-denomination]')].map(n=>Number(n.dataset.chipDenomination)),face:e.textContent.trim()}:null})()`);
 await x.tap('button[title="50 $TICS chip (key 4)"]');
 for(let i=0;i<2;i++)await x.tapBet('button[title="Straight: 17"]');
 assert.deepEqual(await stack(),{total:10000,layers:[10000],face:'100'});
 await x.tapBet('button[title="Straight: 17"]');assert.deepEqual(await stack(),{total:15000,layers:[10000,5000],face:'150'});
 await x.click('Undo');assert.deepEqual(await stack(),{total:10000,layers:[10000],face:'100'});await x.click('Clear');
 await x.tap('button[title="500 $TICS chip (key 6)"]');for(let i=0;i<3;i++)await x.tapBet('button[title="Straight: 17"]');
 assert.deepEqual(await stack(),{total:150000,layers:[100000,50000],face:'1.5K'});await x.shot('normalized-1500-tics-stack');await x.click('Undo');assert.deepEqual(await stack(),{total:100000,layers:[100000],face:'1K'});await x.click('Clear');
 const edge=await x.ev(`(()=>{const cell=document.querySelector('[data-cell-number="7"]').getBoundingClientRect(),dozen=document.querySelector('[data-outside-bet="dozen1"]').getBoundingClientRect(),button=document.querySelector('button[title="Street: 9/8/7"]'),r=button.getBoundingClientRect();return{numberBottom:cell.bottom,dozenTop:dozen.y,streetY:r.y+r.height/2,hit:button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`);
 assert.ok(Math.abs(edge.numberBottom-edge.dozenTop)<1&&Math.abs(edge.streetY-edge.dozenTop)<1&&edge.hit,JSON.stringify(edge));
 await x.tapBet('button[title="Street: 9/8/7"]');assert.equal(await x.ev(`document.querySelector('[data-bet-key="street:7,8,9"]').dataset.stakedCents`),'50000');await x.shot('shared-street-dozen-boundary');await x.click('Clear');
 // Cover every straight-up number at 300 $TICS to guarantee a real 300 $TICS winning
 // stake without forging an outcome or bypassing its cryptographic verifier.
 await x.tap('button[title="100 $TICS chip (key 5)"]');await x.ev(`(()=>{for(let n=0;n<=36;n++){const b=document.querySelector('button[title="Straight: '+n+'"]');for(let i=0;i<3;i++)b.click()}})()`);await sleep(150);
 assert.equal(await x.ev(`document.querySelectorAll('[data-bet-key][data-staked-cents="30000"]').length`),37);
 await x.tap('button[title="10 $TICS chip (key 3)"]');await x.tap('button[title="Spin (Space)"]');
 // Pocket is confirmed first with no payout pops; then a pop appears on the real winning chip.
 let landedChecked=false;
 for(let i=0;i<200;i++){await sleep(50);const st=await x.ev(`document.querySelector('[data-testid="round-stage"]').dataset.roundStage`);
  if(st==='landed'&&!landedChecked){assert.equal(await x.ev(`document.querySelectorAll('.felt-payout-pop').length`),0,'Confirm the pocket before any payout');landedChecked=true;}
  if(await x.ev(`!!document.querySelector('.felt-payout-pop')`))break;}
 assert.ok(landedChecked,'landed phase observed');
 const pop=await x.ev(`(()=>{const p=document.querySelector('.felt-payout-pop'),k=p.dataset.payoutKey,chip=document.querySelector('[data-bet-key="'+k+'"]'),pr=p.getBoundingClientRect(),cr=chip.getBoundingClientRect();return{key:k,cents:Number(p.dataset.payoutCents),staked:Number(chip.dataset.stakedCents),text:(document.querySelector('[data-payout-label="'+k+'"]')||{}).innerText+' totals:'+document.querySelectorAll('[data-testid="felt-payout-total"]').length,dx:Math.abs((pr.left)-(cr.left+cr.width/2)),cards:document.querySelectorAll('.compact-payout,[data-testid="winning-felt-preview"]').length}})()`);
 assert.equal(pop.cents,1080000);assert.equal(pop.staked,30000);assert.match(pop.text,/^\+10\.8K \$TICS totals:0$/,'single win shows its amount once');assert.ok(pop.dx<2,'pop sits on the winning chip '+JSON.stringify(pop));assert.equal(pop.cards,0,'no payout calculator card');
 await sleep(300);await x.shot('felt-payout-pop');
 for(let i=0;i<120;i++){await sleep(50);await x.click('Collect winnings');if(await x.ev(`document.querySelector('[data-testid="win-celebration"]')?.dataset.phase==='transferring'`))break;}
 const transfer=await x.ev(`(()=>{const c=document.querySelector('[data-testid="win-celebration"]');return{phase:c.dataset.phase,tier:c.dataset.tier,amount:c.querySelector('[data-testid="celebrate-amount"]').textContent,flyingChips:c.querySelectorAll('.fly-chip [data-chip-denomination]').length}})()`);
 assert.equal(transfer.phase,'transferring');assert.equal(transfer.amount,'10,800.00 $TICS');assert.ok(transfer.flyingChips>0,'real chips fly into the balance');const t=Date.now();await x.shot('celebration-chip-transfer');
 for(let i=0;i<50;i++){await sleep(75);if(await x.ev(`!document.querySelector('button[title="Spin (Space)"]').disabled`))break;}assert.ok(Date.now()-t<2500,'Transfer finishes promptly');assert.ok(await x.ev(`!document.querySelector('button[title="Spin (Space)"]').disabled`));assert.deepEqual(x.errors,[]);
 const report={edge,transfer,api:process.env.REAL_API?'live':'controlled fixture'};fs.writeFileSync(path.join(OUT,'chips-payout-report.json'),JSON.stringify(report,null,2));await x.close();console.log('PASS chip consolidation/Undo, shared street edge, actual felt reveal + 300 $TICS stake, 10,800 $TICS celebration chip transfer',JSON.stringify(report));
})().catch(e=>{console.error(e);process.exit(1)});
