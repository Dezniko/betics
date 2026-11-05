// Offline QA render of every Gods of Power sound cue, for listening and for the peak budget.
// Drives headless Chrome over raw CDP (port 9355), serves frontend/src over http so the real module
// (and its audioSettings import) loads unbundled, renders each cue with an OfflineAudioContext
// through a master gain of 1 and writes 16-bit WAVs plus a peak table.
//   node frontend/tests/browser/slot-sound-render.mjs            # output dir: $TMPDIR/slot-sounds (or ./tmp/slot-sounds)
// Fails (exit 1) when any peak reaches -1 dBFS.
import { spawn, execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, '../../src');
const outDir = path.join(process.env.TMPDIR || path.resolve(here, '../../../tmp'), 'slot-sounds');
const PORT = 9355;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const RATE = 44100;

// cue name -> { len seconds, body: page side JS using m (module), ctx, schedule(t, fn) }
const CUES = {
  spinLoop: { len: 2.2, run: 'm.spinLoopStart(); schedule(1.9, () => m.spinLoopStop());' },
  reelStop0: { len: 0.5, run: 'm.reelStop(0);' },
  reelStop1: { len: 0.5, run: 'm.reelStop(1);' },
  reelStop2: { len: 0.5, run: 'm.reelStop(2);' },
  reelStop3: { len: 0.5, run: 'm.reelStop(3);' },
  reelStop4: { len: 0.5, run: 'm.reelStop(4);' },
  anticipation: { len: 1.8, run: 'm.anticipation(true); schedule(1.5, () => m.anticipation(false));' },
  scatter1: { len: 1.2, run: 'm.scatter(1);' },
  scatter2: { len: 1.3, run: 'm.scatter(2);' },
  scatter3: { len: 1.4, run: 'm.scatter(3);' },
  scatter4: { len: 1.5, run: 'm.scatter(4);' },
  scatter5: { len: 1.6, run: 'm.scatter(5);' },
  lineWin0: { len: 0.7, run: 'm.lineWin(0);' },
  lineWin1: { len: 1, run: 'm.lineWin(1);' },
  lineWin2: { len: 1.4, run: 'm.lineWin(2);' },
  lineWin3: { len: 2.4, run: 'm.lineWin(3);' },
  coinShower: { len: 2.3, run: 'm.coinShower(2000);' },
  vaultOpen: { len: 2.6, run: 'm.vaultOpen();' },
  fanfare: { len: 2.3, run: 'm.fanfare();' },
  retrigger: { len: 0.7, run: 'm.retrigger();' },
  countTicks: { len: 1.2, run: 'for (let i = 0; i < 40; i++) schedule(i * 0.025, () => m.countTick(i / 40));' },
  // Worst case mix the polyphony cap and the gain budget must survive.
  comboMegaWin: { len: 2.6, run: 'm.lineWin(3); m.coinShower(2000); m.fanfare(); schedule(0.3, () => m.vaultOpen());' },
};

const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html' };
function serve() {
  return new Promise(resolve => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>slot sound render</title>'); return; }
      try {
        const file = path.join(srcDir, path.normalize(url.pathname));
        if (!file.startsWith(srcDir)) throw Error('outside');
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' });
        res.end(body);
      } catch { res.writeHead(404); res.end(); }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function cdpSession() {
  const list = async () => { try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { return null; } };
  let pages = null;
  for (let i = 0; i < 60 && !pages; i++) { pages = await list(); if (!pages) await new Promise(r => setTimeout(r, 250)); }
  if (!pages) throw Error('Chrome did not answer on the debugging port');
  let page = pages.find(p => p.type === 'page');
  if (!page) page = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = ev => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
  const send = (method, params = {}) => new Promise(res => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
  return { send, close: () => ws.close() };
}

// Runs in the page: renders one cue, returns { peak, duration, wav (base64) }.
const PAGE_RENDER = `async (moduleUrl, len, rate, body) => {
  const m = await import(moduleUrl);
  const ctx = new OfflineAudioContext(2, Math.round(rate * len), rate);
  const master = ctx.createGain(); master.gain.value = 1; master.connect(ctx.destination);
  m.__reset();
  m.__setEngineGetter(() => ({ context: ctx, output: master }));
  const pending = [];
  const schedule = (t, fn) => { const at = Math.ceil(t * rate / 128) * 128 / rate; pending.push(ctx.suspend(at).then(() => { fn(); return ctx.resume(); })); };
  new Function('m', 'ctx', 'schedule', body)(m, ctx, schedule);
  const buffer = await ctx.startRendering();
  await Promise.all(pending);
  const chans = [0, 1].map(c => buffer.getChannelData(c));
  let peak = 0;
  for (const d of chans) for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  const frames = buffer.length, out = new ArrayBuffer(44 + frames * 4), v = new DataView(out);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + frames * 4, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 4, true);
  v.setUint16(32, 4, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, frames * 4, true);
  let o = 44;
  for (let i = 0; i < frames; i++) for (const d of chans) { const s = Math.max(-1, Math.min(1, d[i])); v.setInt16(o, s < 0 ? s * 32768 : s * 32767, true); o += 2; }
  const bytes = new Uint8Array(out); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { peak, duration: buffer.duration, wav: btoa(bin), live: m.__liveCount() };
}`;

async function main() {
  if (!existsSync(CHROME)) throw Error(`Chrome not found at ${CHROME} (set CHROME=...)`);
  await mkdir(outDir, { recursive: true });
  const { server, port } = await serve();
  const profile = path.join(os.tmpdir(), 'slot-sound-chrome');
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore', detached: true });
  const rows = [];
  try {
    const cdp = await cdpSession();
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await new Promise(r => setTimeout(r, 500));
    const moduleUrl = `http://127.0.0.1:${port}/slots/slotSound.js`;
    for (const [name, cue] of Object.entries(CUES)) {
      const expression = `(${PAGE_RENDER})(${JSON.stringify(moduleUrl)}, ${cue.len}, ${RATE}, ${JSON.stringify(cue.run)})`;
      const reply = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (reply.result?.exceptionDetails || !reply.result?.result?.value) throw Error(`${name}: ${JSON.stringify(reply.result?.exceptionDetails?.exception?.description || reply)}`);
      const { peak, duration, wav } = reply.result.result.value;
      const file = path.join(outDir, `${name}.wav`);
      await writeFile(file, Buffer.from(wav, 'base64'));
      const dbfs = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
      rows.push({ name, duration, peak, dbfs });
      console.log(`${name.padEnd(14)} ${duration.toFixed(2).padStart(5)} s  peak ${dbfs.toFixed(1).padStart(6)} dBFS`);
    }
    cdp.close();
  } finally {
    server.close();
    try { process.kill(-chrome.pid); } catch { /* already gone */ }
    try { execSync(`pkill -f remote-debugging-port=${PORT}`); } catch { /* none left */ }
  }
  const loud = rows.filter(r => r.dbfs >= -1);
  const silent = rows.filter(r => r.peak === 0);
  console.log(`\n${rows.length} renders in ${outDir}`);
  if (silent.length) console.log(`SILENT: ${silent.map(r => r.name).join(', ')}`);
  if (loud.length) console.log(`TOO LOUD (>= -1 dBFS): ${loud.map(r => `${r.name} ${r.dbfs.toFixed(1)}`).join(', ')}`);
  process.exit(loud.length || silent.length ? 1 : 0);
}

main().catch(err => { console.error(err); try { execSync(`pkill -f remote-debugging-port=${PORT}`); } catch { /* none */ } process.exit(1); });
