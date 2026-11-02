#!/usr/bin/env node
// Stores the casino wallet key for automatic payouts, without ever printing it.
//   node scripts/setup-casino-key.mjs [--file PATH] [--local] [--generate]
// --file     a file holding the private key (64 hex characters, with or without 0x). Default ~/.hermes/secrets/betics-casino-key.txt
// --generate create a brand-new key instead (test networks only; nobody else holds a copy)
// --local    write to the local dev database and payouts/.dev.vars instead of Cloudflare
// The key is encrypted (AES-256-GCM). The ciphertext goes to the D1 setting
// casino_key_ct; the decryption key goes ONLY to the betics-payouts Worker as
// the secret CASINO_KEY_KEK. The plain file is overwritten and deleted.
import { readFileSync, writeFileSync, unlinkSync, statSync, existsSync, appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { encryptKey } from '../payouts/src/index.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const local = flag('--local');
const file = opt('--file', `${homedir()}/.hermes/secrets/betics-casino-key.txt`);
const root = new URL('..', import.meta.url).pathname;

let pk;
if (flag('--generate')) pk = generatePrivateKey();
else {
  if (!existsSync(file)) { console.error(`No key file at ${file}`); process.exit(1); }
  const raw = readFileSync(file, 'utf8').trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) { console.error('The file must contain one private key: 64 hex characters (with or without 0x). Nothing was changed.'); process.exit(1); }
  pk = `0x${raw.toLowerCase()}`;
}
const address = privateKeyToAccount(pk).address;
const kek = randomBytes(32).toString('base64');
const ct = await encryptKey(pk, kek);
pk = null;

const wrangler = (argv, input) => execFileSync('wrangler', argv, { cwd: root, input, env: { ...process.env, CI: 'true' }, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] }).toString();
const sql = `INSERT INTO settings (key, value) VALUES ('casino_key_ct', '${JSON.stringify(ct)}') ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now');
UPDATE settings SET value = json_set(value, '$.casinoWallet', '${address.toLowerCase()}'), updated_at = datetime('now') WHERE key = 'tics_payments';
INSERT INTO admin_audit (admin_email, action, target, after_json) VALUES ('system', 'tics.casino_wallet', 'settings:tics_payments', '{"casinoWallet":"${address.toLowerCase()}","via":"setup-casino-key"}');`;

if (local) {
  const devVars = `${root}payouts/.dev.vars`;
  const keep = existsSync(devVars) ? readFileSync(devVars, 'utf8').split('\n').filter((l) => l && !l.startsWith('CASINO_KEY_KEK=')).join('\n') : '';
  writeFileSync(devVars, `${keep ? `${keep}\n` : ''}CASINO_KEY_KEK=${kek}\n`, { mode: 0o600 });
  wrangler(['d1', 'execute', 'betics-db', '--local', '--persist-to', `${root}.wrangler/state`, '--command', sql]);
} else {
  wrangler(['secret', 'put', 'CASINO_KEY_KEK', '--config', 'payouts/wrangler.toml'], kek);
  wrangler(['d1', 'execute', 'betics-db', '--remote', '--command', sql]);
}

if (!flag('--generate')) {
  const size = statSync(file).size;
  writeFileSync(file, randomBytes(Math.max(size, 128)));
  unlinkSync(file);
  if (existsSync(file)) { console.error('WARNING: could not delete the key file. Delete it by hand.'); process.exit(2); }
}
console.log(`Casino wallet set: ${address}${local ? ' (local)' : ''}`);
console.log(flag('--generate') ? 'A new key was generated and stored encrypted. No copy exists outside the system.' : 'The key is stored encrypted and the plain file was overwritten and deleted.');
