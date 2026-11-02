import test from 'node:test';
import assert from 'node:assert/strict';
import {makeLayout} from '../src/boardLayout.js';
import * as touch from '../src/touchBetting.js';

test('touch chips stay readable in screen pixels, while the desktop size remains unchanged',()=>{
 const l=makeLayout(false);
 assert.ok(touch.visibleChipSize(l,0.45,'straight',true)*0.45>=20);
 assert.ok(touch.visibleChipSize(l,0.45,'corner',true)*0.45>=17);
 assert.equal(touch.visibleChipSize(l,1,'straight',false),l.sizeFor('straight'));
});
