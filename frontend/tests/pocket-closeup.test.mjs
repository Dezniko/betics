import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

const order = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];

// SSR exercises the actual JSX/artwork without a browser, audio or RAF clock.
test('closeup shows the actual European neighbors with a centered landed ball for every pocket', async () => {
 const server = await createServer({ root, configFile: false, plugins: [react()], server: { middlewareMode: true, ws: false }, appType: 'custom' });
 try {
  const { default: PocketCloseup } = await server.ssrLoadModule('/src/PocketCloseup.jsx');
  for (let i = 0; i < order.length; i++) {
   const pocket = order[i];
   const html = renderToStaticMarkup(createElement(PocketCloseup, { pocket }));
   const neighbors = [order[(i + 36) % 37], pocket, order[(i + 1) % 37]];
   assert.deepEqual([...html.matchAll(/<g data-pocket="(\d+)"/g)].map(match => Number(match[1])), order, 'closeup must render the entire real rotor and let the camera crop it');
   assert.match(html, new RegExp(`aria-label="Ball landed in ${pocket}\\. Adjacent pockets: ${neighbors[0]} and ${neighbors[2]}\\."`));
   assert.match(html, /href="\/wheel\/roulette-material.webp"/);
   const rotation = Number(html.match(/data-testid="closeup-rotor" transform="rotate\(([-\d.]+) 512 512\)"/)[1]);
   const [x, y] = html.match(/data-testid="closeup-ball" transform="translate\(([-\d.]+) ([-\d.]+)\)"/).slice(1).map(Number);
   const counterRotation = Number(html.match(/data-testid="closeup-ball-light" transform="rotate\(([-\d.]+)\)"/)[1]);
   assert.ok(Math.abs(rotation + counterRotation) < 1e-7, `ball lighting stays upright for ${pocket}`);
   const angle = rotation * Math.PI / 180;
   const screenX = 512 + (x - 512) * Math.cos(angle) - (y - 512) * Math.sin(angle);
   const screenY = 512 + (x - 512) * Math.sin(angle) + (y - 512) * Math.cos(angle);
   assert.ok(Math.abs(screenX - 512) < 1e-7, `ball centered for ${pocket}`);
   assert.ok(Math.abs(screenY - 262) < 1e-7, `ball at radius 250 for ${pocket}`);
   assert.equal((html.match(/data-testid="closeup-ball"/g) || []).length, 1);
  }
 } finally { await server.close(); }
});

test('live wheel is parent-sized and initially shows a ball in pocket zero before any spin', async () => {
 const server = await createServer({ root, configFile: false, plugins: [react()], server: { middlewareMode: true, ws: false }, appType: 'custom' });
 try {
  const { default: RouletteWheel } = await server.ssrLoadModule('/src/RouletteWheel.jsx');
  const html = renderToStaticMarkup(createElement(RouletteWheel));
  assert.match(html, /data-testid="roulette-wheel"[^>]*style="[^"]*width:100%;[^"]*aspect-ratio:1/);
  assert.match(html, /<svg[^>]*width="100%" height="100%"/);
  assert.equal((html.match(/<g data-pocket=/g) || []).length, 37);
  assert.match(html, /data-testid="wheel-rotor"/);
  assert.match(html, /data-phase="resting"/);
  assert.match(html, /data-ball-radius="250"/);
  const style = html.match(/data-testid="roulette-ball" style="([^"]+)"/)[1];
  const [rotation, distance] = style.match(/rotate\(([-\d.]+)deg\) translateY\(([-\d.]+)%\)/).slice(1).map(Number);
  const radius = -distance / 100 * 1024;
  const angle = (rotation - 90) * Math.PI / 180;
  const expected = (360 / 37 / 2 - 90) * Math.PI / 180;
  assert.ok(Math.abs(radius - 250) < 1e-7);
  assert.ok(Math.abs(512 + radius * Math.cos(angle) - (512 + 250 * Math.cos(expected))) < 1e-7);
  assert.ok(Math.abs(512 + radius * Math.sin(angle) - (512 + 250 * Math.sin(expected))) < 1e-7);
  assert.match(html, /data-testid="ball-carrier"/);
 } finally { await server.close(); }
});
