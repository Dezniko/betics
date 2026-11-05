// Checks that the site served at www.betics.io is the code in this repository.
// Build the frontend first (see README), then:
//   node scripts/verify-live.mjs [https://www.betics.io]
// It downloads every JavaScript and CSS file of the local build (frontend/dist) from the live site,
// plus the offline verifier, and compares their SHA-256 fingerprints. No packages, no secrets.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.argv[2] || 'https://www.betics.io').replace(/\/$/, '');
const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'frontend', 'dist');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('No local build found. Run: npm --prefix frontend ci && npm run build');
  process.exit(2);
}
const files = [...readdirSync(join(DIST, 'assets')).filter((f) => /\.(js|css)$/.test(f)).map((f) => `assets/${f}`), 'verify-roulette.mjs', 'verify-slots.mjs'];
const localIndex = readFileSync(join(DIST, 'index.html'), 'utf8');
const liveIndex = await (await fetch(`${BASE}/`, { headers: { 'cache-control': 'no-cache' } })).text();
const entries = [...localIndex.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
const entriesLive = entries.every((e) => liveIndex.includes(`/${e}`));

let same = 0; const diff = [];
for (const f of files) {
  const res = await fetch(`${BASE}/${f}`, { headers: { 'cache-control': 'no-cache' } });
  const live = res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  const local = readFileSync(join(DIST, f));
  if (live && sha(live) === sha(local)) same++;
  else diff.push(`${f}: local ${sha(local).slice(0, 16)} live ${live ? sha(live).slice(0, 16) : `missing (HTTP ${res.status})`}`);
}
console.log(`Site: ${BASE}`);
console.log(`Entry files referenced by the live page: ${entriesLive ? 'yes' : 'NO'} (${entries.join(', ')})`);
console.log(`Files identical: ${same} of ${files.length}`);
for (const d of diff) console.log(`  DIFFERENT ${d}`);
const ok = entriesLive && diff.length === 0;
console.log(ok ? 'MATCH: the live site serves exactly this build.' : 'NO MATCH: the live site is not this build (or the build settings differ).');
process.exitCode = ok ? 0 : 1;
