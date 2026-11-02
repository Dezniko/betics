// betics-payouts: the only code that can use the casino wallet key.
// No public route (workers_dev off, no custom domain). Reached only through
// service bindings from the game and admin Workers, with the internal secret,
// plus its own cron. One PayoutQueue Durable Object sends every transaction,
// one at a time, so nonces never collide.
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, parseTransaction } from 'viem';
import {
  ticsSettings, rpcClient, rpcUrl, hexToNumber, unitsToWei, weiToUnits, tokenBalance, transferData, formatTics, normAddress, decodeTransfers,
} from '../../worker/tics.js';

const INTERNAL_HEADER = 'X-Internal-Secret';
const AAD = new TextEncoder().encode('betics-casino-wallet-v1');
const MAC_INFO = new TextEncoder().encode('betics-row-mac-v2');
const MAX_PER_RUN = 5;
// Some nodes suggest a 0 tip when the network is quiet; a payout always offers at least 0.1 gwei so it is mined.
const MIN_TIP = 100_000_000n;
// Hard fee caps (gwei). Settings maxFeeGwei / maxTipGwei may override them within sane bounds.
const MAX_FEE_GWEI = 50;
const MAX_TIP_GWEI = 3;
// An ERC-20 transfer costs about 35-52k gas; anything above this is not a plain transfer.
const GAS_LIMIT_CAP = 100_000n;
const BUMP_AFTER_MS = 5 * 60 * 1000;
const REQUEUE_AFTER_MS = 3 * 60 * 1000;
const SIGNING_STALE_MS = 5 * 60 * 1000;
const TREASURY_ADDRESS_WAIT_MS = 48 * 60 * 60 * 1000;
// A nonce counts as taken by someone else only when every one of our hashes had no receipt on two runs this far apart.
const NULL_RECHECK_MS = 5 * 60 * 1000;
// A reverted payout is refunded only once its block is finalized, or this deep when the node has no 'finalized' tag.
const REVERT_FINAL_CONFIRMATIONS = 12;
// Rows failed as 'nonce taken' are watched this long in case one of our hashes shows up mined after all.
const FAILED_WATCH_MS = 30 * 24 * 60 * 60 * 1000;
// Node replies that mean "this transaction was not accepted".
const CLEAR_REJECTION = /nonce too low|nonce has already been used|insufficient funds|underpriced|fee cap|intrinsic gas|exceeds block gas|gas limit|invalid sender|invalid transaction|max fee per gas/i;
const NONCE_TOO_LOW = /nonce too low|nonce has already been used/i;
// Errors that say the node or a wallet object is unreachable right now (not a problem with one row).
const TRANSIENT = /failed with HTTP (5\d\d|429)|fetch failed|network|timed? ?out|ECONN|socket|not configured/i;
// A node error is only blamed on one row when it clearly is about that transaction (the token refuses it).
// Anything else the node says ("Internal error", rate limits sent as HTTP 200...) is an outage for every row.
const ROW_SPECIFIC = /revert|invalid opcode|out of gas/i;
const isTransient = (msg, error) => TRANSIENT.test(msg) || (/^RPC /.test(msg) && !ROW_SPECIFIC.test(msg))
  || (/^wallet [a-z-]+ failed/.test(msg) && (!error?.status || error.status >= 500));
// A row that fails before signing this many times in a row (over at least this long) is stopped for review,
// so one bad row can never hold up every payout behind it.
const ROW_FAIL_LIMIT = 5;
const ROW_FAIL_MIN_MS = 15 * 60 * 1000;
// A payout marked sent is checked again this deep; a receipt that vanished (reorg, lying node) raises the alarm.
const SENT_WATCH_BLOCKS = 64;
const TREASURY_HEADER = 'X-Treasury-Secret';
const json = (v, status = 200) => Response.json(v, { status });
const sqlNow = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const hour = (ms) => sqlNow(ms).slice(0, 13);
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => b64(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
const fail = (status, message, extra) => Object.assign(new Error(message), { status, extra });
const bmax = (...v) => v.reduce((a, b) => (b > a ? b : a));
// +10% rounded up: the least a replacement must offer on both fee fields.
const up10 = (v) => v + (v + 9n) / 10n;

// ---------- key handling ----------
// The private key is stored as AES-256-GCM ciphertext (setting 'casino_key_ct'
// in D1); the key that decrypts it is a secret of this Worker only. Plain text
// exists only in memory, inside sign(), per transaction.
export async function encryptKey(privateKeyHex, kekB64) {
  const kek = await crypto.subtle.importKey('raw', b64(kekB64), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, kek, new TextEncoder().encode(privateKeyHex)));
  const out = new Uint8Array(iv.length + ct.length); out.set(iv); out.set(ct, iv.length);
  return btoa(String.fromCharCode(...out));
}
async function withAccount(env, fn) {
  if (!env.CASINO_KEY_KEK) throw new Error('casino wallet key is not configured');
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'casino_key_ct'").first();
  if (!row) throw new Error('casino wallet key is not configured');
  const blob = b64(JSON.parse(row.value));
  const kek = await crypto.subtle.importKey('raw', b64(env.CASINO_KEY_KEK), 'AES-GCM', false, ['decrypt']);
  let pk = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.slice(0, 12), additionalData: AAD }, kek, blob.slice(12)));
  try { return await fn(privateKeyToAccount(pk)); } finally { pk = null; }
}

// ---------- row authentication ----------
// Treasury rows are created only here. Each carries an HMAC (key derived from the KEK with HKDF), so a row
// written into D1 by anyone else (or a row whose address/amount was edited) is never signed.
async function macKey(env) {
  if (!env.CASINO_KEY_KEK) throw new Error('casino wallet key is not configured');
  const ikm = await crypto.subtle.importKey('raw', b64(env.CASINO_KEY_KEK), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: MAC_INFO }, ikm, 256);
  return crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
// v2 covers the amount actually sent and the fee too, so neither can be edited in D1 after the row was made.
const macInput = (r) => new TextEncoder().encode(`${r.id}|${r.kind}|${r.to_address}|${r.amount_units}|${r.send_units}|${r.fee_units}|${r.chain_id}`);
export async function rowMac(env, r) {
  return b64url(await crypto.subtle.sign('HMAC', await macKey(env), macInput(r)));
}
async function rowMacOk(env, r) {
  if (typeof r.row_mac !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(r.row_mac)) return false;
  // crypto.subtle.verify compares in constant time.
  return crypto.subtle.verify('HMAC', await macKey(env), fromB64url(r.row_mac), macInput(r));
}
async function sameSecret(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false;
  const enc = new TextEncoder();
  const [x, y] = (await Promise.all([given, expected].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))))).map((d) => new Uint8Array(d));
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// ---------- pinned token and chain ----------
// The token contract and chain come from this Worker's own vars, never only from the shared settings row.
function pinned(env) {
  const token = normAddress(String(env.TICS_TOKEN || '').toLowerCase());
  const chainId = Number(env.CHAIN_ID);
  return token && Number.isSafeInteger(chainId) && chainId > 0 ? { token, chainId } : null;
}
function pinProblem(env, settings, row) {
  const pin = pinned(env);
  if (!pin) return 'TICS_TOKEN / CHAIN_ID are not set on the payouts Worker';
  if (String(settings.token || '').toLowerCase() !== pin.token) return `Settings token ${settings.token} is not the pinned $TICS contract ${pin.token}`;
  if (Number(settings.chainId) !== pin.chainId) return `Settings chain ${settings.chainId} is not the pinned chain ${pin.chainId}`;
  if (row && Number(row.chain_id) !== pin.chainId) return `Withdrawal ${row.id} is for chain ${row.chain_id}, not the pinned chain ${pin.chainId}`;
  return null;
}
function feeCaps(settings) {
  const pick = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : d);
  const wei = (gwei) => BigInt(Math.round(gwei * 1e9));
  return { maxFee: wei(pick(settings.maxFeeGwei, 1, 500, MAX_FEE_GWEI)), maxTip: wei(pick(settings.maxTipGwei, 0, 50, MAX_TIP_GWEI)) };
}
function treasuryAddressTooNew(settings, now) {
  if (settings.treasuryAddressSetAt == null) return null;
  const at = Date.parse(settings.treasuryAddressSetAt);
  if (!Number.isFinite(at)) return 'The treasury address change time is unreadable, so treasury sends are refused. Save the treasury address again.';
  const left = at + TREASURY_ADDRESS_WAIT_MS - now;
  return left > 0 ? `The treasury address was changed less than 48 hours ago. Treasury sends are possible again in about ${Math.ceil(left / 3600000)} hours.` : null;
}
// A paid receipt must contain Transfer(casino wallet -> to, wei) emitted by the token contract.
function hasTransfer(receipt, hash, token, from, to, wei) {
  try {
    return decodeTransfers(receipt.logs, token, to).some((t) => t.from === from && t.amountWei === wei.toString() && t.txHash === hash);
  } catch { return false; }
}

const alert = (db, a) => db.prepare(`INSERT OR IGNORE INTO alerts (type, severity, title, details, player_id, dedupe_key) VALUES (?, ?, ?, ?, ?, ?)`)
  .bind(a.type, a.severity || 'warning', a.title, a.details || null, a.playerId || null, a.key).run().catch(() => {});

async function walletOp(env, playerId, op, body) {
  const stub = env.CASINO.get(env.CASINO.idFromName(playerId));
  const res = await stub.fetch(new Request(`https://wallet/internal/${op}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', [INTERNAL_HEADER]: env.INTERNAL_SECRET }, body: JSON.stringify(body) }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`wallet ${op} failed: ${data.error || res.status}`), { status: res.status });
  return data;
}
// Sets only the two pause fields (json_set), so a concurrent admin edit of other settings is never overwritten.
// The first reason is kept while already paused.
async function pause(env, reason) {
  const db = env.DB;
  const res = await db.prepare(`UPDATE settings SET value = json_set(value, '$.payoutsPaused', json('true'), '$.pausedReason', ?), updated_at = datetime('now')
    WHERE key = 'tics_payments' AND COALESCE(json_extract(value, '$.payoutsPaused'), 0) = 0`).bind(reason).run();
  if ((res.meta?.changes ?? 0) === 0) {
    await db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('tics_payments', json_object('payoutsPaused', json('true'), 'pausedReason', ?))`).bind(reason).run();
  }
  await alert(db, { type: 'tics_paused', severity: 'critical', key: `tics_paused:${hour()}:${reason.slice(0, 40)}`, title: 'Automatic payouts were paused', details: reason });
}

// What players are owed (shared rule with the game Worker, OWED_SQL in worker/wallet.js): real balances, player
// withdrawals not yet paid (including 'holding', 'blocked' and 'cancelling', whose money is still held), and treasury sends in flight.
async function owedUnits(db) {
  const row = await db.prepare(`SELECT (SELECT COALESCE(SUM(real_tics_cents), 0) FROM players WHERE real_tics_cents > 0)
      + (SELECT COALESCE(SUM(amount_units), 0) FROM chain_withdrawals WHERE kind = 'player' AND status IN ('holding','queued','signing','sending','blocked','cancelling'))
      + (SELECT COALESCE(SUM(amount_units), 0) FROM chain_withdrawals WHERE kind = 'treasury' AND status IN ('queued','signing','sending')) AS n`).first();
  return row?.n || 0;
}
// Treasury sends only: a player's balance counts as the larger of players.real_tics_cents and the newest real $TICS
// ledger row copied from their wallet. Zeroing the players column in D1 alone then no longer frees player money.
// (The ledger is append-only by trigger; someone who can also write ledger rows can still lower it: this is a floor,
// not a proof. The 48 h treasury address wait, its alert and X-Treasury-Secret are the other layers.)
async function owedUnitsStrict(db) {
  const row = await db.prepare(`SELECT (SELECT COALESCE(SUM(max(COALESCE(p.real_tics_cents, 0), COALESCE((SELECT l.balance_after_cents FROM ledger l
        WHERE l.player_id = p.id AND l.real_money = 1 AND l.currency = 'TICS' ORDER BY l.created_at DESC, l.rowid DESC LIMIT 1), 0))), 0) FROM players p)
      + (SELECT COALESCE(SUM(amount_units), 0) FROM chain_withdrawals WHERE kind = 'player' AND status IN ('holding','queued','signing','sending','blocked','cancelling'))
      + (SELECT COALESCE(SUM(amount_units), 0) FROM chain_withdrawals WHERE kind = 'treasury' AND status IN ('queued','signing','sending')) AS n`).first();
  return row?.n || 0;
}
async function spinHoldUnits(db, nowMs) {
  return (await db.prepare('SELECT COALESCE(SUM(units), 0) AS n FROM spin_holds WHERE expires_at > ?').bind(nowMs).first())?.n || 0;
}

// ---------- the queue ----------
const lc = (h) => String(h).toLowerCase();
const union = (...lists) => [...new Set(lists.flat().map(lc))];

export class PayoutQueue {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.chain = Promise.resolve(); this.active = 0; this.runSigned = new Map(); }
  // Serialise every run: awaits on the network must never interleave two senders.
  exclusive(fn) {
    this.active++;
    const run = this.chain.then(fn, fn).finally(() => { this.active--; });
    this.chain = run.catch(() => {});
    return run;
  }

  async fetch(request) {
    const { pathname } = new URL(request.url);
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    try {
      if (pathname === '/process') {
        // A cron tick while a run is still going (slow RPC) is skipped rather than stacked up.
        if (body.cron && this.active > 0) return json({ skipped: 'a payout run is already in progress' });
        return json(await this.exclusive(() => this.process()));
      }
      if (pathname === '/treasury') return json(await this.exclusive(() => this.treasury(body)));
      if (pathname === '/cancel') return json(await this.exclusive(() => this.cancel(body)));
      if (pathname === '/resolve') return json(await this.exclusive(() => this.resolve(body)));
      if (pathname === '/status') return json(await this.status());
      return json({ error: 'not found' }, 404);
    } catch (error) {
      return json({ error: error.message || 'payout error', ...(error.extra || {}) }, error.status || 500);
    }
  }

  deps(settings) {
    const pin = pinned(this.env);
    const rpc = this.env.__rpc || rpcClient(rpcUrl(this.env, pin ? pin.chainId : settings.chainId));
    return { rpc, now: this.env.__now ? this.env.__now() : Date.now() };
  }
  // Optional second Ethereum provider (ETH_RPC_URL_2). Without it, nothing that relies on "no receipt" is decided automatically.
  nowMs() { return this.env.__now ? this.env.__now() : Date.now(); }
  rpc2() {
    if (this.env.__rpc2 !== undefined) return this.env.__rpc2;
    if (!this._rpc2 && this.env.ETH_RPC_URL_2) this._rpc2 = rpcClient(this.env.ETH_RPC_URL_2);
    return this._rpc2 || null;
  }

  // The node must be on the pinned chain before anything is read or signed. A mismatch pauses (security) and alerts.
  async chainProblem(rpc, now, label = 'Ethereum node') {
    const pin = pinned(this.env);
    if (!pin) return null;
    const id = hexToNumber(await rpc('eth_chainId'));
    if (id === pin.chainId) return null;
    const reason = `The ${label} answered chain id ${id}, not the pinned chain ${pin.chainId}. Nothing is signed.`;
    await alert(this.env.DB, { type: 'tics_wrong_chain', severity: 'critical', key: `tics_wrong_chain:${hour(now)}`, title: 'Payouts refused: the Ethereum node is on the wrong chain', details: reason });
    await this.pause(reason);
    return reason;
  }

  // ---------- this object's own records (never taken from D1) ----------
  async kv(key) { const v = await this.ctx.storage.get(key); return v == null ? null : v; }
  async setKv(key, value) { await this.ctx.storage.put(key, value); }
  // One-shot signing registry: row id -> { kind, to, sendUnits, nonce, hashes (every hash ever signed), rejected, fees, final }.
  reg(id) { return this.kv(`signed:${id}`); }
  putReg(id, e) { return this.setKv(`signed:${id}`, e); }
  async finishReg(id, final) { const e = await this.reg(id); if (e && !e.final) await this.putReg(id, { ...e, final }); }

  // A pause for a security reason also stops the owner's treasury sends; an ordinary pause does not.
  async pause(reason, security = true) {
    if (security && !(await this.kv('securityPause'))) await this.setKv('securityPause', { reason: String(reason).slice(0, 300), at: Date.now() });
    await pause(this.env, reason);
  }
  // The flag is cleared once the owner has resumed payouts (settings no longer paused).
  async securityPaused(settings) {
    if (!settings.payoutsPaused) { if (await this.kv('securityPause')) await this.setKv('securityPause', null); return null; }
    return this.kv('securityPause');
  }

  // This object's own record of when the current treasury address was first seen. A changed address starts a new 48 h wait,
  // whatever settings.treasuryAddressSetAt says.
  async treasuryWait(settings, now) {
    const young = treasuryAddressTooNew(settings, now);
    if (young) return young;
    const address = normAddress(settings.treasuryAddress || '');
    if (!address) return null;
    let pin = await this.kv('treasuryPin');
    if (!pin || pin.address !== address) {
      const old = pin?.address || null;
      pin = { address, since: now };
      await this.setKv('treasuryPin', pin);
      // Every new treasury address is announced, wherever it came from (admin page or a direct D1 edit).
      await alert(this.env.DB, { type: 'tics_treasury_address', severity: 'critical', key: `tics_treasury_address:${address}:${hour(now)}`,
        title: 'The payouts signer saw a new treasury address',
        details: `Treasury address ${old ? `changed from ${old} to ${address}` : `set to ${address}`}. Treasury sends to it are refused for 48 hours. If you did not change it, pause payouts and check who did.` });
    }
    const left = pin.since + TREASURY_ADDRESS_WAIT_MS - now;
    return left > 0 ? `The payouts signer first saw this treasury address less than 48 hours ago. Treasury sends are possible again in about ${Math.ceil(left / 3600000)} hours.` : null;
  }

  async finalizedNonce(rpc, wallet, latest) {
    try { return hexToNumber(await rpc('eth_getTransactionCount', [wallet, 'finalized'])); } catch {
      const at = Math.max(0, (latest ?? hexToNumber(await rpc('eth_blockNumber'))) - 64);
      return hexToNumber(await rpc('eth_getTransactionCount', [wallet, `0x${at.toString(16)}`]));
    }
  }
  async finalizedBlock(rpc) {
    try { const b = await rpc('eth_getBlockByNumber', ['finalized', false]); return b?.number ? hexToNumber(b.number) : null; } catch { return null; }
  }
  // True only when every hash had no receipt on two runs at least NULL_RECHECK_MS apart (a lagging node can miss a fresh receipt).
  async nullTwice(id, now) {
    const first = await this.kv(`nullSeen:${id}`);
    if (!Number.isFinite(first)) { await this.setKv(`nullSeen:${id}`, now); return false; }
    return now - first >= NULL_RECHECK_MS;
  }
  // Our receipt for one of the hashes, only if the node answers for that exact hash.
  async ourReceipt(row, hashes, rpc, now) {
    for (const h of hashes) {
      const r = await rpc('eth_getTransactionReceipt', [h]);
      if (!r) continue;
      if (lc(r.transactionHash) !== h) {
        await alert(this.env.DB, { type: 'tics_rpc_mismatch', severity: 'critical', key: `tics_rpc_mismatch:${row.id}:${hour(now)}`, title: 'The Ethereum node answered with a receipt for a different transaction',
          details: `Asked for ${h}, got ${r.transactionHash}. Ignored.` });
        continue;
      }
      return { receipt: r, hash: h };
    }
    return null;
  }

  // Before anything is decided from "no receipt" (signing again at a new nonce, refunding a 'nonce taken' row),
  // every hash ever signed for the row must be unknown to the node on two runs NULL_RECHECK_MS apart (receipt AND
  // transaction by hash), and unknown to the second provider ETH_RPC_URL_2 as well, which must also see the nonce used.
  // { ok } | { wait } | { mined: { hash, where } } | { noSecond } (no second provider: a person must check).
  // A node can say "nonce too low" or hide a receipt and still have broadcast our transaction, so its word alone is never enough.
  async unminedProof(row, nonce, hashes, rpc, now) {
    const mine = await this.ourReceipt(row, hashes, rpc, now);
    if (mine) return { mined: { hash: mine.hash, where: 'node' } };
    for (const h of hashes) {
      const tx = await rpc('eth_getTransactionByHash', [h]).catch(() => 'unreachable');
      if (tx === 'unreachable') return { wait: 'the node did not answer for our transaction' };
      if (tx) {
        await this.setKv(`nullSeen:${row.id}`, null);
        await alert(this.env.DB, { type: 'tics_rpc_inconsistent', severity: 'critical', key: `tics_rpc_inconsistent:${row.id}`, title: 'A payout is known to the node but has no receipt',
          details: `${row.id}: nonce ${nonce} is used and the node knows our transaction ${h}, but shows no receipt for it. Nothing is decided automatically; check it on Etherscan.`, playerId: row.player_id });
        return { wait: `the node knows our transaction ${h} but shows no receipt` };
      }
    }
    if (!(await this.nullTwice(row.id, now))) return { wait: `nonce ${nonce} is used; making sure none of our transactions for it was mined` };
    const rpc2 = this.rpc2();
    if (!rpc2) return { noSecond: true };
    if (await this.chainProblem(rpc2, now, 'second Ethereum provider (ETH_RPC_URL_2)')) return { wait: 'the second provider is on the wrong chain' };
    const wallet = (await ticsSettings(this.env.DB)).casinoWallet;
    if (!((await this.finalizedNonce(rpc2, wallet)) > nonce)) return { wait: `the second provider does not see nonce ${nonce} used yet` };
    for (const h of hashes) {
      const r = await rpc2('eth_getTransactionReceipt', [h]);
      if (r && lc(r.transactionHash) === h) return { mined: { hash: h, where: 'second provider' } };
      if (await rpc2('eth_getTransactionByHash', [h])) return { wait: `the second provider knows our transaction ${h}` };
    }
    return { ok: true };
  }
  async secondProviderSawMined(row, found, now) {
    await alert(this.env.DB, { type: 'tics_rpc_mismatch', severity: 'critical', key: `tics_rpc_hidden:${row.id}`, title: 'The Ethereum node hid a mined payout',
      details: `${row.id}: the main node shows no receipt for ${found.hash}, but the second provider has it. The main node may be lying; check it by hand.`, playerId: row.player_id });
  }

  // May this row be signed at this nonce? { ok } | { wait } (back to the queue, no alarm) | { refuse } (blocked, alert, pause).
  async registryCheck(row, nonce, rpc, wallet, now) {
    const e = await this.reg(row.id);
    if (!e) return { ok: true };
    if (e.final) return { refuse: `it was already signed once and finished as '${e.final}'; it is never signed again` };
    if (e.kind !== row.kind || e.to !== row.to_address || e.sendUnits !== row.send_units) {
      return { refuse: `it was first signed for ${formatTics(e.sendUnits)} to ${e.to} (${e.kind}); the row now says ${formatTics(row.send_units)} to ${row.to_address} (${row.kind})` };
    }
    if (e.nonce === nonce) return { ok: true }; // a replacement at the same nonce can never pay twice
    const latest = hexToNumber(await rpc('eth_blockNumber'));
    const fin = await this.finalizedNonce(rpc, wallet, latest);
    if (fin > e.nonce) {
      // Every hash counts, including ones the node once called rejected: that reply is not proof.
      const proof = await this.unminedProof(row, e.nonce, e.hashes, rpc, now);
      if (proof.mined) {
        if (proof.mined.where !== 'node') await this.secondProviderSawMined(row, proof.mined, now);
        return { refuse: `our earlier transaction ${proof.mined.hash} for it (nonce ${e.nonce}) was mined` };
      }
      if (proof.wait) return { wait: proof.wait };
      if (proof.noSecond) return { ownerCheck: true, refuse: `it was signed at nonce ${e.nonce}, which is used, and none of our transactions shows a receipt; with no second Ethereum provider (ETH_RPC_URL_2) to confirm, it is not signed again. Check on Etherscan` };
      return { ok: true };
    }
    const latestCount = hexToNumber(await rpc('eth_getTransactionCount', [wallet, 'latest']));
    if (latestCount > e.nonce) return { wait: `nonce ${e.nonce} is used but not final yet; waiting before signing again` };
    return { refuse: `it was already signed at nonce ${e.nonce}, which is still open; signing it again at nonce ${nonce} could pay twice` };
  }

  // A row stopped for a person to review. Still counted as owed (player rows); never signed or refunded automatically.
  // ownerCheck: stopped only because "never mined" could not be confirmed by a second provider; /resolve may then
  // return the money after the owner checked Etherscan and the signer re-checks the chain.
  async blockRow(row, from, reason, { pauseToo = true, attempts, ownerCheck = false } = {}) {
    const sql = `UPDATE chain_withdrawals SET status = 'blocked', last_error = ?, updated_at = datetime('now') WHERE id = ? AND status = ?${attempts != null ? ' AND attempts = ?' : ''}`;
    const args = [String(reason).slice(0, 300), row.id, from, ...(attempts != null ? [attempts] : [])];
    await this.env.DB.prepare(sql).bind(...args).run();
    await this.finishReg(row.id, 'blocked');
    if (ownerCheck) { const e = await this.reg(row.id); if (e) await this.putReg(row.id, { ...e, ownerCheck: true }); }
    await alert(this.env.DB, { type: 'tics_payout_blocked', severity: 'critical', key: `tics_blocked:${row.id}`, title: `A ${row.kind} payout was stopped for review`,
      details: `${row.id}: ${reason}`.slice(0, 500), playerId: row.player_id });
    if (pauseToo) await this.pause(`Payout ${row.id} stopped: ${reason}`.slice(0, 300));
  }

  // strict (treasury sends): owed also respects the ledger floor (owedUnitsStrict).
  async freeFloat(settings, rpc, now, strict = false) {
    const token = pinned(this.env)?.token || settings.token;
    const [tokenWei, owed, held] = await Promise.all([tokenBalance(rpc, token, settings.casinoWallet), (strict ? owedUnitsStrict : owedUnits)(this.env.DB), spinHoldUnits(this.env.DB, now)]);
    const tokenUnits = weiToUnits(tokenWei);
    return { tokenUnits, owedUnits: owed, spinHoldUnits: held, freeUnits: tokenUnits - owed - held };
  }

  async status() {
    const settings = await ticsSettings(this.env.DB);
    const counts = await this.env.DB.prepare('SELECT status, COUNT(*) AS n FROM chain_withdrawals GROUP BY status').all();
    const out = { casinoWallet: settings.casinoWallet, treasuryAddress: settings.treasuryAddress, paused: !!settings.payoutsPaused, pausedReason: settings.pausedReason,
      chainId: settings.chainId, queue: Object.fromEntries(counts.results.map((c) => [c.status, c.n])), keyConfigured: !!this.env.CASINO_KEY_KEK,
      pinned: pinned(this.env), pinProblem: pinProblem(this.env, settings), securityPaused: !!(await this.securityPaused(settings)) };
    if (!settings.casinoWallet) return out;
    const { rpc, now } = this.deps(settings);
    const [f, ethHex] = await Promise.all([this.freeFloat(settings, rpc, now), rpc('eth_getBalance', [settings.casinoWallet, 'latest'])]);
    return { ...out, ...f, ethWei: BigInt(ethHex).toString() };
  }

  async treasury(body) {
    const db = this.env.DB, settings = await ticsSettings(db);
    const { rpc, now } = this.deps(settings);
    if (!settings.casinoWallet) throw fail(400, 'The casino wallet is not set up.');
    const to = normAddress(settings.treasuryAddress || '');
    if (!to) throw fail(400, 'Set a treasury address first.');
    const units = body.amountUnits;
    if (!Number.isSafeInteger(units) || units <= 0) throw fail(400, 'Enter an amount.');
    if (typeof body.id !== 'string' || !/^[0-9a-f-]{36}$/.test(body.id)) throw fail(400, 'invalid id');
    // A reused request id never sends again and is never reported as a new send.
    const existing = await db.prepare('SELECT id, kind, status FROM chain_withdrawals WHERE id = ?').bind(body.id).first();
    if (existing) throw fail(409, 'This request id was already used. Nothing new was sent.', { alreadyUsed: true, id: body.id, status: existing.status });
    const pinErr = pinProblem(this.env, settings);
    if (pinErr) throw fail(409, `Treasury sends are refused: ${pinErr}.`);
    const wrongChain = await this.chainProblem(rpc, now);
    if (wrongChain) throw fail(409, `Treasury sends are refused: ${wrongChain}`);
    const young = await this.treasuryWait(settings, now);
    if (young) throw fail(409, young);
    const secure = await this.securityPaused(settings);
    if (secure) throw fail(409, `Payouts were paused for a security reason (${secure.reason}). Treasury sends are refused until payouts are resumed.`);
    const open = await db.prepare("SELECT id FROM chain_withdrawals WHERE kind = 'treasury' AND status IN ('queued','signing','sending') LIMIT 1").first();
    if (open) throw fail(409, 'A treasury send is already in progress. Wait until it is confirmed.', { openId: open.id });
    const f = await this.freeFloat(settings, rpc, now, true);
    // Negative here is usually a payout that is mined but still confirming (its tokens have left the
    // wallet while it still counts as owed). Refuse the send, but do not pause: the game Worker's
    // insolvency check (which leaves 'sending' rows out and needs two readings) pauses if it is real.
    if (f.freeUnits < 0) throw fail(409, 'Nothing is free right now: a payout may still be confirming, or the wallet holds less than is owed. Try again in a few minutes.');
    if (units > f.freeUnits) throw fail(400, `Only ${formatTics(Math.max(0, f.freeUnits))} is free. The rest is owed to players.`);
    const chainId = pinned(this.env).chainId;
    const mac = await rowMac(this.env, { id: body.id, kind: 'treasury', to_address: to, amount_units: units, send_units: units, fee_units: 0, chain_id: chainId });
    // One open treasury row at a time, enforced in the same statement that inserts it.
    const ins = await db.prepare(`INSERT OR IGNORE INTO chain_withdrawals (id, kind, chain_id, to_address, amount_units, fee_units, send_units, status, release_at, requested_by, row_mac)
      SELECT ?, 'treasury', ?, ?, ?, 0, ?, 'queued', ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM chain_withdrawals WHERE kind = 'treasury' AND status IN ('queued','signing','sending'))`)
      .bind(body.id, chainId, to, units, units, sqlNow(now), String(body.requestedBy || 'admin').slice(0, 120), mac).run();
    if ((ins.meta?.changes ?? 0) !== 1) throw fail(409, 'A treasury send is already in progress. Wait until it is confirmed.');
    await alert(db, { type: 'tics_treasury_send', severity: 'info', key: `tics_treasury:${body.id}`, title: `Treasury send: ${formatTics(units)}`,
      details: `${body.requestedBy || 'An admin'} asked to send ${formatTics(units)} to the treasury ${to}.` });
    const run = await this.process({ treasuryId: body.id });
    const after = await db.prepare('SELECT status, last_error FROM chain_withdrawals WHERE id = ?').bind(body.id).first();
    return { id: body.id, ...run, status: after?.status, ...(['failed', 'blocked'].includes(after?.status) ? { error: after.last_error } : {}) };
  }

  // ---------- hold-close outbox ----------
  // Cancelled player rows whose refund is not confirmed yet. Kept in this object's storage, so no window or limit
  // can let one slip through.
  async markToClose(id) {
    const pending = (await this.ctx.storage.get('toClose')) || {};
    if (id in pending) return false;
    pending[id] = Date.now();
    await this.ctx.storage.put('toClose', pending);
    return true;
  }
  async closed(id) {
    const pending = (await this.ctx.storage.get('toClose')) || {};
    if (!(id in pending)) return;
    delete pending[id];
    await this.ctx.storage.put('toClose', pending);
  }

  async cancel(body) {
    const db = this.env.DB;
    const row = await db.prepare('SELECT * FROM chain_withdrawals WHERE id = ?').bind(String(body.id || '')).first();
    if (!row) throw fail(404, 'Withdrawal not found.');
    // A second click: the first cancel already owns the refund (and its outbox entry).
    if (row.status === 'cancelling' || row.status === 'cancelled') return { ok: true, alreadyCancelled: true, status: row.status, ...(row.status === 'cancelling' ? { refundPending: true } : {}) };
    if (row.status !== 'queued') throw fail(409, 'Only a withdrawal that has not been sent yet can be cancelled.');
    // 'queued' in D1 is not proof that nothing was signed: a row this signer ever signed may be on chain.
    const signed = await this.signedHashes(row);
    if (signed.length) {
      await alert(db, { type: 'tics_cancel_refused', severity: 'critical', key: `tics_cancel_refused:${row.id}`, title: 'A cancel was refused: the withdrawal was already signed',
        details: `${row.id} shows as queued but was signed (${signed.join(', ')}). It may be on chain; check it on Etherscan.`, playerId: row.player_id });
      throw fail(409, 'This withdrawal was already signed, so it may be on chain. It cannot be cancelled; check its transactions on Etherscan.', { hashes: signed });
    }
    const player = row.kind === 'player';
    const added = player ? await this.markToClose(row.id) : false;
    // A player row is 'cancelling' (still owed) until the refund is confirmed, then 'cancelled'.
    const res = await db.prepare(`UPDATE chain_withdrawals SET status = ?, cancelled_by = ?, updated_at = datetime('now') WHERE id = ? AND status = 'queued'`)
      .bind(player ? 'cancelling' : 'cancelled', String(body.by || 'admin').slice(0, 120), row.id).run();
    if ((res.meta?.changes ?? 0) !== 1) { if (added) await this.closed(row.id); throw fail(409, 'Only a withdrawal that has not been sent yet can be cancelled.'); }
    if (player) {
      const r = await this.finishCancel(row);
      if (r === 'blocked') throw fail(409, "The refund was refused by the player's wallet. The withdrawal was stopped for review.");
      if (r !== 'done') return { ok: true, refundPending: true };
    }
    return { ok: true };
  }
  // Owner review of a 'blocked' player withdrawal: give the money back, but only if this signer never
  // signed it (nothing can be on chain). A row that was ever signed must be checked by hand on Etherscan.
  async resolve(body) {
    const db = this.env.DB;
    const row = await db.prepare('SELECT * FROM chain_withdrawals WHERE id = ?').bind(String(body.id || '')).first();
    if (!row) throw fail(404, 'Withdrawal not found.');
    if (row.kind !== 'player' || row.status !== 'blocked') throw fail(409, 'Only a stopped player withdrawal can be returned to the player.');
    const reg = await this.reg(row.id);
    const signed = await this.signedHashes(row);
    if (signed.length) {
      // Only a row stopped because "never mined" could not be confirmed automatically (ownerCheck), and only if the chain
      // still shows none of its transactions now, after the owner checked Etherscan.
      const why = reg?.ownerCheck ? await this.stillUnmined(row, reg, signed) : 'it was signed';
      if (why) {
        throw fail(409, `This withdrawal was signed, so it may be on chain (${why}). Check its transactions on Etherscan before doing anything; it cannot be returned automatically.`,
          { hashes: signed });
      }
      await this.watchFailed(row, signed, this.nowMs());
    }
    const added = await this.markToClose(row.id);
    const res = await db.prepare(`UPDATE chain_withdrawals SET status = 'cancelling', cancelled_by = ?, updated_at = datetime('now') WHERE id = ? AND status = 'blocked'`)
      .bind(String(body.by || 'admin').slice(0, 120), row.id).run();
    if ((res.meta?.changes ?? 0) !== 1) { if (added) await this.closed(row.id); throw fail(409, 'Only a stopped player withdrawal can be returned to the player.'); }
    const r = await this.finishCancel(row);
    if (r === 'blocked') throw fail(409, "The player's wallet refused the refund (its hold does not match). Check the player's ledger before doing anything else.");
    return r === 'done' ? { ok: true } : { ok: true, refundPending: true };
  }
  // Every hash this row was ever signed with: the signer's registry plus tx_hash, raw_tx and tx_hashes in D1.
  // A hash the node once called rejected still counts: that reply is not proof it never reached the chain.
  async signedHashes(row) {
    const reg = await this.reg(row.id);
    let d1 = [];
    try { d1 = JSON.parse(row.tx_hashes || '[]'); } catch { d1 = ['unreadable tx_hashes']; }
    if (!Array.isArray(d1)) d1 = ['unreadable tx_hashes'];
    const fromRaw = row.raw_tx ? [(() => { try { return keccak256(row.raw_tx); } catch { return 'unreadable raw_tx'; } })()] : [];
    return union(reg?.hashes || [], d1, row.tx_hash ? [row.tx_hash] : [], fromRaw);
  }
  // Owner resolve of an ownerCheck row: null when the chain (and the second provider, if set) still shows none of
  // the hashes and the nonce is used at a finalized block; otherwise the reason it is refused.
  async stillUnmined(row, reg, hashes) {
    const settings = await ticsSettings(this.env.DB);
    const { rpc } = this.deps(settings);
    for (const r of [rpc, this.rpc2()].filter(Boolean)) {
      if (!((await this.finalizedNonce(r, settings.casinoWallet)) > reg.nonce)) return `nonce ${reg.nonce} is not final yet`;
      for (const h of hashes) {
        if (!/^0x[0-9a-f]{64}$/.test(h)) return `unreadable hash ${h}`;
        if (await r('eth_getTransactionReceipt', [h])) return `${h} has a receipt`;
        if (await r('eth_getTransactionByHash', [h])) return `${h} is known to the node`;
      }
    }
    return null;
  }
  // Returns the money of a 'cancelling' row, then marks it 'cancelled'. 'done' | 'retry' | 'blocked'.
  async finishCancel(row) {
    try { await walletOp(this.env, row.player_id, 'tics-release', { ref: `th:${row.id}`, reason: 'cancelled by admin' }); } catch (error) {
      if (error.status === 409 || error.status === 404) {
        await this.blockRow(row, 'cancelling', `cancel: tics-release answered ${error.message}`, { pauseToo: false });
        await this.closed(row.id);
        return 'blocked';
      }
      console.error(JSON.stringify({ msg: 'cancel: refund will be retried', id: row.id, error: String(error.message || error) }));
      return 'retry';
    }
    await this.env.DB.prepare(`UPDATE chain_withdrawals SET status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND status = 'cancelling'`).bind(row.id).run();
    await this.closed(row.id);
    return 'done';
  }

  // A row left in 'signing' by a crashed run (nothing signed was recorded, so nothing was broadcast) goes back to the queue.
  async sweepSigning(now) {
    await this.env.DB.prepare(`UPDATE chain_withdrawals SET status = 'queued', last_error = 'signing was interrupted; queued again', updated_at = ?
      WHERE status = 'signing' AND tx_hash IS NULL AND raw_tx IS NULL AND updated_at < ?`).bind(sqlNow(now), sqlNow(now - SIGNING_STALE_MS)).run();
  }

  async process(opts = {}) {
    const db = this.env.DB, settings = await ticsSettings(db);
    if (!settings.casinoWallet) return { skipped: 'no casino wallet' };
    const { rpc, now } = this.deps(settings);
    this.runSigned = new Map();
    await this.securityPaused(settings);
    await this.treasuryWait(settings, now);
    await this.sweepSigning(now);
    await this.settleRecent();
    // A node on another chain could report fake receipts and nonces: nothing is confirmed, refunded or signed.
    const wrongChain = await this.chainProblem(rpc, now);
    if (wrongChain) return { confirmed: 0, sent: 0, paused: true, refused: wrongChain };
    const confirmed = await this.confirmSending(settings, rpc, now);
    await this.checkFailedWatch(rpc, now).catch((e) => console.error('failed-row watch error', e));
    await this.checkSentWatch(rpc, now).catch((e) => console.error('sent-row watch error', e));
    const fresh = await ticsSettings(db);
    const pinErr = pinProblem(this.env, fresh);
    if (pinErr) { await this.pause(pinErr); return { confirmed, sent: 0, paused: true, refused: pinErr }; }
    const due = (await db.prepare(`SELECT * FROM chain_withdrawals WHERE status = 'queued' AND release_at <= ? ORDER BY created_at LIMIT ?`).bind(sqlNow(now), MAX_PER_RUN).all()).results;
    // The owner's new treasury row is handled by its id, whatever else is waiting.
    if (opts.treasuryId) {
      const t = await db.prepare("SELECT * FROM chain_withdrawals WHERE id = ? AND kind = 'treasury' AND status = 'queued'").bind(opts.treasuryId).first();
      const rest = due.filter((r) => r.id !== opts.treasuryId);
      due.length = 0; due.push(...(t ? [t] : []), ...rest);
    }
    let sent = 0;
    for (const row of due) {
      // A pause stops player payouts. The owner's own treasury send still goes through (with every check below), unless the pause
      // was for a security reason.
      const current = await ticsSettings(db);
      if (current.payoutsPaused) {
        const ownerSend = row.kind === 'treasury' && row.id === opts.treasuryId;
        if (!ownerSend || (await this.securityPaused(current))) continue;
      }
      // true = signed and sent; 'skip' = a problem with this row only (the next row is still tried); 'stop' = a problem
      // for every row (float, gas, fees, node down) or a signed row whose broadcast is unclear (keeps nonces in order).
      const ok = await this.send(row, current, rpc, now);
      if (ok === 'stop') break;
      if (ok === true) sent++;
    }
    return { confirmed, sent, paused: !!(await ticsSettings(db)).payoutsPaused };
  }

  async nextNonce(pendingNonce) {
    const stored = await this.ctx.storage.get('nextNonce');
    const top = await this.env.DB.prepare("SELECT MAX(nonce) AS n FROM chain_withdrawals WHERE status = 'sending' AND nonce IS NOT NULL").first();
    return Math.max(pendingNonce, Number.isSafeInteger(stored) ? stored : 0, top?.n == null ? 0 : top.n + 1);
  }

  // Money already on its way but not confirmed: rows in 'sending' plus anything signed earlier in this run.
  async inFlight(exceptId) {
    const rows = (await this.env.DB.prepare("SELECT id, send_units, raw_tx, max_fee_wei FROM chain_withdrawals WHERE status = 'sending' AND id != ?").bind(exceptId).all()).results;
    const all = new Map();
    for (const r of rows) {
      let gasWei = GAS_LIMIT_CAP * BigInt(r.max_fee_wei || 0);
      try { const tx = parseTransaction(r.raw_tx); gasWei = (tx.gas ?? GAS_LIMIT_CAP) * (tx.maxFeePerGas ?? BigInt(r.max_fee_wei || 0)); } catch {}
      all.set(r.id, { units: Math.max(0, Number(r.send_units) || 0), gasWei });
    }
    for (const [id, v] of this.runSigned) if (id !== exceptId && !all.has(id)) all.set(id, v);
    let units = 0, gasWei = 0n;
    for (const v of all.values()) { units += v.units; gasWei += v.gasWei; }
    return { units, gasWei };
  }

  sign(wallet, tx) {
    return withAccount(this.env, async (account) => {
      if (account.address.toLowerCase() !== wallet) throw new Error('the stored key does not belong to the casino wallet');
      return account.signTransaction({ type: 'eip1559', value: 0n, ...tx });
    });
  }

  async send(row, settings, rpc, now) {
    const db = this.env.DB;
    // attempts is the claim token: only this run may move the row on from 'signing'.
    const token = (Number(row.attempts) || 0) + 1;
    const claim = await db.prepare(`UPDATE chain_withdrawals SET status = 'signing', attempts = ?, updated_at = ? WHERE id = ? AND status = 'queued' AND attempts = ?`)
      .bind(token, sqlNow(now), row.id, Number(row.attempts) || 0).run();
    if ((claim.meta?.changes ?? 0) !== 1) return false;
    // Only an unsigned row goes back to the queue; a row with a recorded signed transaction never does.
    const back = (error) => db.prepare(`UPDATE chain_withdrawals SET status = 'queued', nonce = NULL, last_error = ?, updated_at = ? WHERE id = ? AND status = 'signing' AND attempts = ?`)
      .bind(String(error).slice(0, 300), sqlNow(now), row.id, token).run();
    // A row that must never be paid as it is: 'blocked' (still owed, money still held), for a person to check. Never refunded automatically.
    const refuse = async (reason, pauseToo) => {
      await db.prepare(`UPDATE chain_withdrawals SET status = 'blocked', last_error = ?, updated_at = ? WHERE id = ? AND status = 'signing' AND attempts = ?`)
        .bind(`refused: ${reason}`.slice(0, 300), sqlNow(now), row.id, token).run();
      await alert(db, { type: 'tics_payout_refused', severity: 'critical', key: `tics_refused:${row.id}`, title: `A ${row.kind} payout was refused and not signed`,
        details: `${row.id}: ${reason}`, playerId: row.player_id });
      if (pauseToo) await this.pause(`Payout ${row.id} refused: ${reason}`.slice(0, 300));
      return 'skip';
    };
    // A failure of this row before anything was signed: back to the queue, the next row is still tried. After
    // ROW_FAIL_LIMIT failures in a row (over at least ROW_FAIL_MIN_MS) it is stopped for review with a critical alert.
    const rowFailed = async (reason) => {
      const key = `rowFails:${row.id}`;
      const prev = (await this.kv(key)) || { n: 0, first: now };
      const cur = { n: prev.n + 1, first: prev.first, last: String(reason).slice(0, 200) };
      // Only stopped when other payouts got through meanwhile: if nothing moved at all, the problem is not this
      // row (casino out of tokens, node or wallet trouble), so it waits instead of being blocked.
      const progressAt = (await this.kv('progressAt')) || 0;
      if (cur.n >= ROW_FAIL_LIMIT && now - cur.first >= ROW_FAIL_MIN_MS && progressAt >= cur.first) {
        await db.prepare(`UPDATE chain_withdrawals SET status = 'blocked', last_error = ?, updated_at = ? WHERE id = ? AND status = 'signing' AND attempts = ?`)
          .bind(`failed ${cur.n} times in a row: ${reason}`.slice(0, 300), sqlNow(now), row.id, token).run();
        await alert(db, { type: 'tics_payout_failing', severity: 'critical', key: `tics_failing:${row.id}`, title: `A ${row.kind} payout kept failing and was stopped for review`,
          details: `${row.id} failed ${cur.n} times in a row before signing (last: ${String(reason).slice(0, 200)}). Nothing was signed; other payouts carry on.`, playerId: row.player_id });
        await this.setKv(key, null);
        return 'skip';
      }
      await this.setKv(key, cur);
      await back(reason);
      return 'skip';
    };
    let signed = false;
    try {
      const pinErr = pinProblem(this.env, settings, row);
      if (pinErr) { await back(pinErr); await this.pause(pinErr); return 'stop'; }
      const pin = pinned(this.env);
      if (row.kind === 'player') {
        const player = await db.prepare('SELECT wallet_address FROM players WHERE id = ?').bind(row.player_id).first();
        if (!player || player.wallet_address !== row.to_address) return refuse('the address does not match the player', true);
        // The player id IS the wallet address (SIWE sign-in, worker/wallet.js), and the wallet object holding the money is
        // keyed by it: a row whose address was edited in D1 (with players.wallet_address) is never paid elsewhere.
        if (lc(row.to_address) !== lc(row.player_id)) return refuse(`the payout address ${row.to_address} is not the player's own wallet ${row.player_id}`, true);
        if (row.send_units <= 0 || row.fee_units < 0 || row.send_units + row.fee_units !== row.amount_units) return refuse('amounts do not add up (send + fee != amount)', true);
        // The DB row alone is not trusted: the player's wallet must really hold exactly this amount for it.
        let hold;
        try { hold = await walletOp(this.env, row.player_id, 'tics-hold-check', { ref: `th:${row.id}` }); } catch (error) {
          // The game's wallet is busy or down: a problem for every row, so the run stops and nothing is counted.
          if (isTransient(String(error.message), error)) { await back(`hold check failed: ${error.message}`); return 'stop'; }
          return rowFailed(`hold check failed: ${error.message}`);
        }
        if (hold.status !== 'held' || hold.units !== row.amount_units) {
          return refuse(`no matching money held in the player's wallet (hold ${hold.status || 'missing'}, ${formatTics(hold.units || 0)} vs ${formatTics(row.amount_units)})`, true);
        }
      } else {
        if (!(await rowMacOk(this.env, row))) return refuse('the treasury row is not authenticated (row_mac missing or wrong)', true);
        if (row.send_units !== row.amount_units || row.fee_units !== 0) return refuse('a treasury row must send its whole amount with no fee', true);
        if (row.to_address !== normAddress(settings.treasuryAddress || '')) return refuse(`${row.to_address} is not the current treasury address`, true);
        const young = await this.treasuryWait(settings, now);
        if (young) return refuse(young, false);
        const secure = await this.securityPaused(settings);
        if (secure) return refuse(`payouts are paused for a security reason (${secure.reason})`, false);
        // Re-check right before signing: this row itself is counted in owed, so free must stay >= 0.
        const f = await this.freeFloat(settings, rpc, now, true);
        if (f.freeUnits + row.amount_units < 0) return refuse(`the casino wallet holds less than is owed right now (free float ${formatTics(f.freeUnits + row.amount_units)}); a payout may still be confirming`, false);
        if (f.freeUnits < 0) return refuse(`it would spend money owed to players (free float without it: ${formatTics(f.freeUnits + row.amount_units)})`, false);
      }
      const wei = unitsToWei(row.send_units);
      const wallet = settings.casinoWallet;
      const data = transferData(row.to_address, wei);
      const [tokenWei, ethWei, pendingNonce, block, rpcTip, busy] = await Promise.all([
        tokenBalance(rpc, pin.token, wallet), rpc('eth_getBalance', [wallet, 'latest']).then(BigInt), rpc('eth_getTransactionCount', [wallet, 'pending']).then(hexToNumber),
        rpc('eth_getBlockByNumber', ['latest', false]), rpc('eth_maxPriorityFeePerGas').then(BigInt).catch(() => 1_500_000_000n), this.inFlight(row.id),
      ]);
      // Tokens and gas already promised to transactions not yet confirmed are not available to this one.
      const spendableWei = tokenWei - unitsToWei(busy.units);
      if (spendableWei < wei) {
        await back('casino wallet does not hold enough TICS');
        await alert(db, { type: 'tics_low_float', severity: 'critical', key: `tics_cant_pay:${hour(now)}`, title: 'A payout is waiting: the casino wallet needs more TICS',
          details: `Needed ${formatTics(row.send_units)}, wallet holds ${formatTics(weiToUnits(tokenWei))} of which ${formatTics(busy.units)} is already on its way. Top up the casino wallet; payouts resume automatically.` });
        return 'stop';
      }
      const estimate = BigInt(await rpc('eth_estimateGas', [{ from: wallet, to: pin.token, data }]));
      if (estimate > GAS_LIMIT_CAP) {
        await back(`gas estimate ${estimate} is above the ${GAS_LIMIT_CAP} cap`);
        await alert(db, { type: 'tics_gas_limit', severity: 'critical', key: `tics_gas_limit:${hour(now)}`, title: 'Payouts refused: the transfer needs far more gas than normal',
          details: `Estimate ${estimate} gas, cap ${GAS_LIMIT_CAP}. A plain $TICS transfer should need about 52,000.` });
        return 'stop';
      }
      const gas = bmax(estimate * 12n / 10n > GAS_LIMIT_CAP ? GAS_LIMIT_CAP : estimate * 12n / 10n, estimate);
      const caps = feeCaps(settings);
      const baseFee = BigInt(block.baseFeePerGas || '0x0');
      let maxPriorityFeePerGas = rpcTip < MIN_TIP ? MIN_TIP : rpcTip;
      if (maxPriorityFeePerGas > caps.maxTip) maxPriorityFeePerGas = caps.maxTip;
      if (baseFee + maxPriorityFeePerGas > caps.maxFee) {
        await back('network fee is above the cap; waiting');
        await alert(db, { type: 'tics_gas_cap', severity: 'warning', key: `tics_gas_cap:${hour(now)}`, title: 'Payouts are waiting: network fees are above the cap',
          details: `Base fee ${Number(baseFee) / 1e9} gwei, cap ${Number(caps.maxFee) / 1e9} gwei. Payouts resume when fees fall.` });
        return 'stop';
      }
      const want = baseFee * 2n + maxPriorityFeePerGas;
      const maxFeePerGas = want > caps.maxFee ? caps.maxFee : want;
      if (ethWei - busy.gasWei < gas * maxFeePerGas) {
        await back('casino wallet does not hold enough ETH for gas');
        await alert(db, { type: 'tics_low_eth', severity: 'critical', key: `tics_no_gas:${hour(now)}`, title: 'A payout is waiting: the casino wallet needs ETH for gas',
          details: 'Send a little ETH to the casino wallet; payouts resume automatically.' });
        return 'stop';
      }
      const nonce = await this.nextNonce(pendingNonce);
      let hashes = JSON.parse(row.tx_hashes || '[]');
      // One-shot registry: an id is never signed at a second nonce unless the first is proven unused by us (see unminedProof).
      const verdict = await this.registryCheck(row, nonce, rpc, wallet, now);
      if (verdict.refuse) {
        if (verdict.ownerCheck) { const e = await this.reg(row.id); if (e) await this.putReg(row.id, { ...e, ownerCheck: true }); }
        return refuse(verdict.refuse, true);
      }
      if (verdict.wait) { await back(verdict.wait); return 'skip'; }
      const raw = await this.sign(wallet, { chainId: pin.chainId, nonce, to: pin.token, data, gas, maxFeePerGas, maxPriorityFeePerGas });
      const hash = lc(keccak256(raw));
      hashes = [...hashes, hash];
      const prevReg = await this.reg(row.id);
      await this.putReg(row.id, { kind: row.kind, to: row.to_address, sendUnits: row.send_units, nonce, hashes: union(prevReg?.hashes || [], [hash]),
        rejected: prevReg?.rejected || [], fees: { maxFee: maxFeePerGas.toString(), tip: maxPriorityFeePerGas.toString(), gas: gas.toString() }, final: null, at: prevReg?.at ?? now });
      signed = true;
      await this.setKv('progressAt', now);
      // Record before broadcasting, so a crash can never lose track of a signed payment. Only from this run's 'signing'.
      const rec = await db.prepare(`UPDATE chain_withdrawals SET status = 'sending', nonce = ?, raw_tx = ?, tx_hash = ?, tx_hashes = ?, max_fee_wei = ?, broadcast_at = ?, last_error = NULL, updated_at = ?
        WHERE id = ? AND status = 'signing' AND attempts = ?`)
        .bind(nonce, raw, hash, JSON.stringify(hashes), maxFeePerGas.toString(), sqlNow(now), sqlNow(now), row.id, token).run();
      if ((rec.meta?.changes ?? 0) !== 1) { console.error('payout row changed while signing; not broadcast', row.id); return 'stop'; }
      this.runSigned.set(row.id, { units: row.send_units, gasWei: gas * maxFeePerGas });
      if (await this.kv(`rowFails:${row.id}`)) await this.setKv(`rowFails:${row.id}`, null);
      try { await rpc('eth_sendRawTransaction', [raw]); await this.ctx.storage.put('nextNonce', nonce + 1); return true; } catch (error) {
        const msg = String(error.message || error);
        if (/already known|known transaction/i.test(msg)) { await this.ctx.storage.put('nextNonce', nonce + 1); return true; }
        // The reply may have been lost after the node accepted it. If the chain knows this exact
        // transaction it is on its way: never sign a new one (that would pay twice).
        const seen = await rpc('eth_getTransactionByHash', [hash]).catch(() => null) || await rpc('eth_getTransactionReceipt', [hash]).catch(() => null);
        if (seen) { await this.ctx.storage.put('nextNonce', nonce + 1); return true; }
        // Anything unclear (timeouts, dropped connections) keeps it as 'sending' with this signed transaction;
        // the monitor re-sends the same bytes (same nonce), so it can be paid at most once.
        if (!CLEAR_REJECTION.test(msg)) {
          await db.prepare(`UPDATE chain_withdrawals SET last_error = ?, updated_at = datetime('now') WHERE id = ?`).bind(`send reply lost: ${msg}`.slice(0, 300), row.id).run();
          await this.ctx.storage.put('nextNonce', nonce + 1);
          return 'stop';
        }
        if (NONCE_TOO_LOW.test(msg)) {
          // A node can answer this and still have broadcast our bytes (and hide them). The row stays 'sending' with this
          // signed transaction and is NEVER signed again at a new nonce here. Once the nonce is final, confirmSending
          // decides: paid if a receipt shows up; otherwise refunded only with proof from a second provider, else 'blocked'.
          await db.prepare(`UPDATE chain_withdrawals SET last_error = ?, updated_at = datetime('now') WHERE id = ?`).bind(`node said: ${msg}`.slice(0, 300), row.id).run();
          const freshNonce = hexToNumber(await rpc('eth_getTransactionCount', [wallet, 'pending']).catch(() => '0x0'));
          await this.ctx.storage.put('nextNonce', Math.max(nonce + 1, freshNonce));
          await alert(db, { type: 'tics_nonce_too_low', severity: 'warning', key: `tics_nonce_too_low:${row.id}`, title: 'A payout was answered "nonce too low"',
            details: `${row.id}: the node said nonce ${nonce} is already used. It is not signed again; it is decided once that nonce is final.`, playerId: row.player_id });
          return 'stop';
        }
        // Any other clear rejection: keep this nonce and replace it at the same nonce with a higher fee.
        await db.prepare(`UPDATE chain_withdrawals SET last_error = ?, updated_at = datetime('now') WHERE id = ?`).bind(`rejected: ${msg}`.slice(0, 300), row.id).run();
        await this.ctx.storage.put('nextNonce', nonce + 1);
        if (/insufficient funds/i.test(msg)) {
          await alert(db, { type: 'tics_low_eth', severity: 'critical', key: `tics_no_gas:${hour(now)}`, title: 'A payout is waiting: the casino wallet needs ETH for gas', details: msg.slice(0, 300) });
          return 'stop';
        }
        const current = await db.prepare('SELECT * FROM chain_withdrawals WHERE id = ?').bind(row.id).first();
        await this.bump(current, settings, rpc, now).catch((e) => this.bumpFailed(row, now, e));
        if (hashes.length + 1 >= 4) await this.pause(`Payout ${row.id} was rejected again and again: ${msg.slice(0, 120)}`, false);
        return 'stop';
      }
    } catch (error) {
      const msg = String(error?.message || error);
      console.error('payout send failed', row.id, error);
      // After signing, nothing moves on: the signed row keeps its nonce (back() only touches unsigned 'signing' rows).
      if (signed) { await back(msg); return 'stop'; }
      if (/stored key/.test(msg)) { await back(msg); await this.pause('The stored key does not match the casino wallet address'); return 'stop'; }
      // The node is down or busy: a problem for every row, not counted against this one.
      if (isTransient(msg, error)) { await back(msg); return 'stop'; }
      // Nothing was signed, so no nonce was used: skipping to the next row leaves no gap.
      return rowFailed(msg);
    }
  }

  // Safety net for cancelled player rows: returns the money once (release is idempotent). Never releases a 'blocked' row,
  // and a 'failed' row only when this object itself saw it fail on chain.
  async settleRecent() {
    const pending = (await this.ctx.storage.get('toClose')) || {};
    for (const id of Object.keys(pending)) {
      const row = await this.env.DB.prepare('SELECT id, kind, player_id, status FROM chain_withdrawals WHERE id = ?').bind(id).first();
      if (!row || row.kind !== 'player' || row.status === 'blocked') { await this.closed(id); continue; }
      if (row.status === 'cancelling') {
        const r = await this.finishCancel(row);
        if (r === 'done') console.log(JSON.stringify({ msg: 'withdrawal hold closed by safety net', id: row.id, op: 'tics-release' }));
        continue;
      }
      let op = null, reason = null;
      if (row.status === 'cancelled') { op = 'tics-release'; reason = 'cancelled by admin'; }
      else if (row.status === 'sent') op = 'tics-finalise';
      else if (row.status === 'failed') {
        const e = await this.reg(row.id);
        if (e && ['reverted', 'nonce_taken'].includes(e.final)) { op = 'tics-release'; reason = 'the transfer failed on chain'; } else {
          await alert(this.env.DB, { type: 'tics_hold_conflict', severity: 'critical', key: `tics_hold_conflict:${row.id}`, title: 'A cancelled withdrawal shows as failed: check by hand',
            details: `${row.id} is 'failed' but this signer never saw it fail on chain. Its hold was left as it is.`, playerId: row.player_id });
          await this.closed(id);
          continue;
        }
      }
      if (!op) continue;
      try {
        const r = await walletOp(this.env, row.player_id, op, { ref: `th:${row.id}`, ...(reason ? { reason } : {}) });
        await this.closed(id);
        if (!r.duplicate) console.log(JSON.stringify({ msg: 'withdrawal hold closed by safety net', id: row.id, op }));
      } catch (error) {
        if (error.status === 409 || error.status === 404) {
          await alert(this.env.DB, { type: 'tics_hold_conflict', severity: 'critical', key: `tics_hold_conflict:${row.id}`, title: 'A withdrawal hold could not be closed: check by hand',
            details: `${row.id} is ${row.status} but ${op} answered: ${error.message}`, playerId: row.player_id });
          await this.closed(id);
        } else console.error(JSON.stringify({ msg: 'withdrawal hold could not be closed', id: row.id, op, error: String(error.message || error) }));
      }
    }
  }

  // Closes a player's hold; never throws, so one row can never block the rest of the queue. A 409/404 stops the row
  // as 'blocked' (once: it leaves 'sending', so later runs never pause again for it).
  async closeHold(row, op, reason) {
    if (row.kind !== 'player') return true;
    try { await walletOp(this.env, row.player_id, op, { ref: `th:${row.id}`, ...(reason ? { reason } : {}) }); return true; } catch (error) {
      if (error.status === 409 || error.status === 404) {
        await alert(this.env.DB, { type: 'tics_hold_conflict', severity: 'critical', key: `tics_hold_conflict:${row.id}`, title: 'A withdrawal hold is in an unexpected state: check by hand',
          details: `${row.id}: ${op} answered ${error.message}. The row was stopped for review.`, playerId: row.player_id });
        await this.blockRow(row, 'sending', `${op} answered ${error.message}; check by hand`);
      } else console.error(JSON.stringify({ msg: 'withdrawal hold could not be closed; retrying next run', id: row.id, op, error: String(error.message || error) }));
      return false;
    }
  }

  // Rows failed as 'nonce taken': if one of their hashes is later seen mined after all, raise the alarm.
  async watchFailed(row, hashes, now) {
    const w = (await this.kv('failedWatch')) || {};
    w[row.id] = { hashes, until: now + FAILED_WATCH_MS, kind: row.kind, playerId: row.player_id || null };
    await this.setKv('failedWatch', w);
  }
  async checkFailedWatch(rpc, now) {
    const w = (await this.kv('failedWatch')) || {};
    let changed = false;
    for (const [id, e] of Object.entries(w)) {
      if (now > e.until) { delete w[id]; changed = true; continue; }
      for (const h of e.hashes) {
        const r = await rpc('eth_getTransactionReceipt', [h]).catch(() => null);
        if (!r || lc(r.transactionHash) !== h || r.status !== '0x1') continue;
        await alert(this.env.DB, { type: 'tics_failed_but_mined', severity: 'critical', key: `tics_failed_but_mined:${id}`, title: 'A payout marked as failed was mined after all',
          details: `${id} (${e.kind}) was failed as "nonce taken" and refunded, but our transaction ${h} was mined. It may have been paid twice: check by hand.`, playerId: e.playerId });
        await this.pause(`Payout ${id} was marked failed but its transaction ${h} was mined`);
        delete w[id]; changed = true;
        break;
      }
    }
    if (changed) await this.setKv('failedWatch', w);
  }

  // Sent rows are marked paid at 1-3 confirmations. Each is looked at once more SENT_WATCH_BLOCKS deeper: if its receipt
  // (with the Transfer) is gone, a reorg or a lying node fooled us, so raise a critical alert and pause.
  async watchSent(row, hash, block, sendUnits, to) {
    const w = (await this.kv('sentWatch')) || {};
    w[row.id] = { hash, block, kind: row.kind, playerId: row.player_id || null, sendUnits, to };
    await this.setKv('sentWatch', w);
  }
  async checkSentWatch(rpc, now) {
    const w = (await this.kv('sentWatch')) || {};
    const ids = Object.keys(w);
    if (!ids.length) return;
    const pin = pinned(this.env), wallet = (await ticsSettings(this.env.DB)).casinoWallet;
    const latest = hexToNumber(await rpc('eth_blockNumber'));
    let changed = false;
    for (const id of ids) {
      const e = w[id];
      if (latest - e.block < SENT_WATCH_BLOCKS) continue;
      const r = await rpc('eth_getTransactionReceipt', [e.hash]).catch(() => undefined);
      if (r === undefined) continue; // node unreachable: try again next run
      const ok = r && lc(r.transactionHash) === e.hash && r.status === '0x1' && pin && hasTransfer(r, e.hash, pin.token, wallet, e.to, unitsToWei(e.sendUnits));
      if (ok) { delete w[id]; changed = true; continue; }
      // One empty answer can be a lagging node behind a load balancer: only a second empty answer at least
      // 5 minutes later (or a receipt that really failed) raises the alarm.
      if (!r) {
        if (!e.missAt) { e.missAt = now; changed = true; continue; }
        if (now - e.missAt < 5 * 60 * 1000) continue;
      }
      {
        await alert(this.env.DB, { type: 'tics_sent_vanished', severity: 'critical', key: `tics_sent_vanished:${id}`, title: 'A payout marked as paid is no longer on chain',
          details: `${id} (${e.kind}) was marked sent in ${e.hash} (block ${e.block}), but ${SENT_WATCH_BLOCKS} blocks later the node shows ${r ? `status ${r.status}` : 'no receipt'}. It may not have been paid: check by hand.`, playerId: e.playerId });
        await this.pause(`Payout ${id} was marked sent but its transaction ${e.hash} is no longer on chain`);
      }
      delete w[id]; changed = true;
    }
    if (changed) await this.setKv('sentWatch', w);
  }

  async confirmSending(settings, rpc, now) {
    const db = this.env.DB, pin = pinned(this.env);
    const rows = await db.prepare("SELECT * FROM chain_withdrawals WHERE status = 'sending' ORDER BY nonce LIMIT 20").all();
    if (!rows.results.length || !pin) return 0;
    const wallet = settings.casinoWallet;
    const latest = hexToNumber(await rpc('eth_blockNumber'));
    const need = Math.max(1, Math.min(settings.confirmations, 3));
    let finBlock, finNonce;
    const finalBlock = async () => (finBlock === undefined ? (finBlock = await this.finalizedBlock(rpc)) : finBlock);
    const finalNonce = async () => (finNonce === undefined ? (finNonce = await this.finalizedNonce(rpc, wallet, latest)) : finNonce);
    let done = 0;
    for (const row of rows.results) {
      try {
        // Every hash this object ever signed for the row counts, even if D1 lost some.
        const e = await this.reg(row.id);
        const hashes = union(e?.hashes || [], JSON.parse(row.tx_hashes || '[]'));
        const to = e ? e.to : row.to_address, sendUnits = e ? e.sendUnits : row.send_units;
        const found = await this.ourReceipt(row, hashes, rpc, now);
        if (found) {
          if (await this.kv(`nullSeen:${row.id}`)) await this.setKv(`nullSeen:${row.id}`, null);
          const { receipt, hash } = found;
          const mined = hexToNumber(receipt.blockNumber);
          const conf = latest - mined + 1;
          if (conf < need) continue;
          if (receipt.status === '0x1') {
            if (!hasTransfer(receipt, hash, pin.token, wallet, to, unitsToWei(sendUnits))) {
              // Mined but no matching Transfer: never finalise, never refund. Stopped as 'blocked' (still owed) for a person to check.
              await alert(db, { type: 'tics_no_transfer', severity: 'critical', key: `tics_no_transfer:${row.id}`, title: 'A payout was mined without the expected token transfer',
                details: `${row.id} (${hash}) has no Transfer of ${formatTics(sendUnits)} from the casino wallet to ${to}. Not marked paid, not refunded.`, playerId: row.player_id });
              await this.blockRow(row, 'sending', `mined in ${hash} without the expected Transfer log; check by hand`);
              continue;
            }
            // Close the player's hold first (idempotent): if it fails the row stays 'sending' and the next run retries it.
            if (!(await this.closeHold(row, 'tics-finalise'))) continue;
            await db.prepare(`UPDATE chain_withdrawals SET status = 'sent', tx_hash = ?, sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'sending'`).bind(hash, row.id).run();
            await this.finishReg(row.id, 'sent');
            await this.watchSent(row, hash, mined, sendUnits, to);
            done++;
          } else {
            // A revert is refunded only once it can no longer be reorganised away.
            const fb = await finalBlock();
            if (!(conf >= REVERT_FINAL_CONFIRMATIONS || (fb != null && mined <= fb))) continue;
            if (!(await this.closeHold(row, 'tics-release', 'the transfer failed on chain'))) continue;
            await db.prepare(`UPDATE chain_withdrawals SET status = 'failed', tx_hash = ?, last_error = 'reverted on chain', updated_at = datetime('now') WHERE id = ? AND status = 'sending'`).bind(hash, row.id).run();
            await this.finishReg(row.id, 'reverted');
            await this.pause(`Payout ${row.id} reverted on chain (${hash}).${row.kind === 'player' ? " The player's money was returned." : ''}`, false);
          }
          continue;
        }
        const age = now - Date.parse(`${row.broadcast_at}Z`);
        const nonce = e ? e.nonce : row.nonce;
        if (age > REQUEUE_AFTER_MS && nonce != null && (await finalNonce()) > nonce) {
          // That nonce is used at a finalized block. Check every hash again AFTER reading it, so a payout mined in between is never freed.
          if (await this.ourReceipt(row, hashes, rpc, now)) continue;
          if (!e) { await this.blockRow(row, 'sending', 'its nonce was used, and this signer has no record of signing it; check by hand'); continue; }
          // A lagging (or lying) node may hide our receipt: no receipt and no transaction on two runs 5+ minutes apart,
          // confirmed by the second provider ETH_RPC_URL_2. Without one, a person decides (blocked; admin 'Return to player').
          const proof = await this.unminedProof(row, nonce, hashes, rpc, now);
          if (proof.mined) {
            if (proof.mined.where === 'node') continue; // picked up as mined on the next run
            await this.secondProviderSawMined(row, proof.mined, now);
            await this.blockRow(row, 'sending', `the second provider shows ${proof.mined.hash} mined but the main node does not; check by hand`);
            continue;
          }
          if (proof.wait) continue;
          if (proof.noSecond) {
            await this.blockRow(row, 'sending', `nonce ${nonce} was used and no receipt was found for our transactions, but there is no second Ethereum provider (ETH_RPC_URL_2) to confirm it was never paid. Check ${hashes.join(', ')} on Etherscan; if none was mined, use Return to player`,
              { pauseToo: false, ownerCheck: true });
            continue;
          }
          // The nonce was used by another transaction (for example a manual send) and none of ours was mined: it was never paid.
          // Never re-signed at a new nonce automatically: the row is freed and the player's money returned.
          if (!(await this.closeHold(row, 'tics-release', 'the payout nonce was used by another transaction'))) continue;
          await db.prepare(`UPDATE chain_withdrawals SET status = 'failed', last_error = 'nonce used by another transaction; never paid', updated_at = datetime('now') WHERE id = ? AND status = 'sending'`).bind(row.id).run();
          await this.finishReg(row.id, 'nonce_taken');
          await this.watchFailed(row, hashes, now);
          await alert(db, { type: 'tics_nonce_taken', severity: 'warning', key: `tics_nonce_taken:${row.id}`, title: 'A payout was replaced by another transaction from the casino wallet',
            details: `${row.id}: nonce ${nonce} was used by a transaction that is not ours. Nothing was paid; ${row.kind === 'player' ? "the player's money was returned and they can withdraw again" : 'send it again if needed'}.`, playerId: row.player_id });
          continue;
        }
        // Re-send our own recorded bytes only (a raw_tx edited in D1 is never broadcast).
        if (row.raw_tx && e && e.hashes.includes(lc(keccak256(row.raw_tx)))) {
          const known = await rpc('eth_getTransactionByHash', [lc(keccak256(row.raw_tx))]).catch(() => null);
          if (!known) await rpc('eth_sendRawTransaction', [row.raw_tx]).catch(() => {});
        }
        if (age > BUMP_AFTER_MS * Math.max(1, hashes.length)) await this.bump(row, settings, rpc, now).catch((err) => this.bumpFailed(row, now, err));
      } catch (error) {
        console.error(JSON.stringify({ msg: 'confirm failed for a payout; continuing', id: row.id, error: String(error.message || error) }));
      }
    }
    return done;
  }

  async bumpFailed(row, now, error) {
    console.error('fee bump failed', row.id, error);
    await alert(this.env.DB, { type: 'tics_bump_failed', severity: 'warning', key: `tics_bump_failed:${row.id}:${hour(now)}`, title: 'A stuck payout could not be replaced with a higher fee',
      details: `${row.id}: ${String(error?.message || error).slice(0, 250)}` });
  }

  // Same nonce, higher fees: replaces a stuck payout without ever paying twice. Both fees rise at least 10%, within the caps.
  // Nonce, recipient and amount come from this object's signing record, never from D1.
  async bump(row, settings, rpc, now) {
    const pin = pinned(this.env);
    if (!pin) throw new Error('token and chain are not pinned');
    const e = await this.reg(row.id);
    if (!e || e.final) { await this.blockRow(row, 'sending', e ? `asked to re-sign a row already finished as '${e.final}'` : 'asked to re-sign a row this signer has no record of signing'); return false; }
    if (row.nonce !== e.nonce || row.to_address !== e.to || row.send_units !== e.sendUnits || row.kind !== e.kind) {
      await this.blockRow(row, 'sending', `the row no longer matches what was signed (nonce ${e.nonce}, ${formatTics(e.sendUnits)} to ${e.to})`);
      return false;
    }
    let prevTip = e.fees ? BigInt(e.fees.tip) : null, prevMax = e.fees ? BigInt(e.fees.maxFee) : null, prevGas = e.fees ? BigInt(e.fees.gas) : null;
    if (prevTip == null) { const prev = parseTransaction(row.raw_tx); prevTip = prev.maxPriorityFeePerGas ?? 0n; prevMax = prev.maxFeePerGas ?? BigInt(row.max_fee_wei); prevGas = prev.gas; }
    const caps = feeCaps(settings);
    const [block, rpcTip] = await Promise.all([rpc('eth_getBlockByNumber', ['latest', false]), rpc('eth_maxPriorityFeePerGas').then(BigInt).catch(() => 0n)]);
    const baseFee = BigInt(block?.baseFeePerGas || '0x0');
    const minTip = up10(prevTip), minMax = up10(prevMax);
    let tip = bmax(minTip, MIN_TIP, rpcTip);
    if (tip > caps.maxTip) tip = caps.maxTip;
    let maxFeePerGas = bmax(minMax, baseFee * 2n + tip);
    if (maxFeePerGas > caps.maxFee) maxFeePerGas = caps.maxFee;
    if (tip < minTip || maxFeePerGas < minMax || tip > maxFeePerGas) {
      throw new Error(`fee cap reached (max ${Number(caps.maxFee) / 1e9} gwei, tip ${Number(caps.maxTip) / 1e9} gwei); the payout waits at its current fee`);
    }
    const data = transferData(e.to, unitsToWei(e.sendUnits));
    const gas = prevGas && prevGas <= GAS_LIMIT_CAP ? prevGas : GAS_LIMIT_CAP;
    const raw = await this.sign(settings.casinoWallet, { chainId: pin.chainId, nonce: e.nonce, to: pin.token, data, gas, maxFeePerGas, maxPriorityFeePerGas: tip });
    const hash = lc(keccak256(raw));
    await this.putReg(row.id, { ...e, hashes: union(e.hashes, [hash]), fees: { maxFee: maxFeePerGas.toString(), tip: tip.toString(), gas: gas.toString() } });
    const rec = await this.env.DB.prepare(`UPDATE chain_withdrawals SET raw_tx = ?, tx_hash = ?, tx_hashes = ?, max_fee_wei = ?, updated_at = datetime('now') WHERE id = ? AND status = 'sending' AND nonce = ?`)
      .bind(raw, hash, JSON.stringify([...JSON.parse(row.tx_hashes || '[]'), hash]), maxFeePerGas.toString(), row.id, e.nonce).run();
    if ((rec.meta?.changes ?? 0) !== 1) return false;
    try { await rpc('eth_sendRawTransaction', [raw]); } catch (error) {
      const msg = String(error.message || error);
      if (CLEAR_REJECTION.test(msg) && !/already known|known transaction/i.test(msg)) await this.bumpFailed(row, now, new Error(`replacement rejected: ${msg}`));
    }
    return true;
  }
}

const queue = (env) => env.QUEUE.get(env.QUEUE.idFromName('casino-wallet'));

export default {
  async fetch(request, env) {
    if (!(await sameSecret(request.headers.get(INTERNAL_HEADER), env.INTERNAL_SECRET))) return json({ error: 'not found' }, 404);
    const { pathname } = new URL(request.url);
    if (!['/process', '/treasury', '/cancel', '/resolve', '/status'].includes(pathname)) return json({ error: 'not found' }, 404);
    // Treasury sends also need their own secret (held by the admin Worker only), so the game Worker's INTERNAL_SECRET alone can never move money to the treasury.
    if (pathname === '/treasury') {
      if (!env.TREASURY_SECRET) return json({ error: 'Treasury sends are not set up' }, 503);
      if (!(await sameSecret(request.headers.get(TREASURY_HEADER), env.TREASURY_SECRET))) return json({ error: 'not allowed' }, 403);
    }
    return queue(env).fetch(request);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(queue(env).fetch(new Request('https://queue/process', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cron: true }) }))
      .catch((e) => console.error('payout run failed', e)));
  },
};
