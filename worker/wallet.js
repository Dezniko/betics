// Wallet players: Sign-In with Ethereum, wallet sessions, profile, $TICS
// deposits (watcher + fast check), withdrawal requests, the casino wallet
// snapshot (float) and wallet holdings. Money itself only moves inside the
// player's wallet Durable Object (idempotent internal routes) and, for sends,
// inside the separate payouts Worker.
import { parseSiweMessage, validateSiweMessage } from 'viem/siwe';
import { recoverMessageAddress, createPublicClient, http } from 'viem';
import { sha256 } from './platform.js';
import {
  ticsSettings, saveTicsSettings, DEFAULT_TICS, normAddress, checksum, isTxHash, weiToUnits, formatTics, rpcClient, rpcUrl,
  hexToNumber, decodeTransfers, transferLogsFilter, tokenBalance, confirmationsFor,
} from './tics.js';

export const WALLET_COOKIE = '__Host-betics_wallet';
const SESSION_DAYS = 30;
const NONCE_MINUTES = 5;
// Alchemy's free plan allows eth_getLogs over at most 10 blocks per call.
const LOG_CHUNK = 10;
const FLOAT_MAX_AGE_MS = 10 * 60 * 1000;
const HOLDINGS_EVERY_MS = 10 * 60 * 1000;
// Alchemy budget: holdings are only looked up for wallets that have made a credited deposit (they are
// only shown in the admin player profile), and the whole site makes at most this many lookups per UTC day,
// so throwaway wallets signing in cannot use up the free Alchemy allowance.
export const HOLDINGS_DAILY_CAP = 300;
const HOLDINGS_BUDGET_KEY = 'holdings_budget';
async function claimHoldingsBudget(db, now) {
  const day = new Date(now).toISOString().slice(0, 10);
  await db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, '{\"day\":\"\",\"used\":0}')").bind(HOLDINGS_BUDGET_KEY).run();
  // One conditional statement: a new day resets the count; otherwise it only rises while under the cap.
  const row = await db.prepare(`UPDATE settings SET value = json_object('day', ?1,
      'used', CASE WHEN json_extract(value, '$.day') = ?1 THEN json_extract(value, '$.used') + 1 ELSE 1 END)
    WHERE key = ?3 AND (json_extract(value, '$.day') IS NOT ?1 OR json_extract(value, '$.used') < ?2) RETURNING value`)
    .bind(day, HOLDINGS_DAILY_CAP, HOLDINGS_BUDGET_KEY).first();
  return !!row;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@<>"'`]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

export class WalletError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new WalletError(status, message); };
const randomHex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

// ---------- rate limits (per hashed IP, per minute) ----------
// events: per player (not per IP), so a flood of analytics calls cannot fill the database.
const LIMITS = { nonce: 20, verify: 10, withdraw: 10, check: 30, profile: 10, session: 60, events: 60 };
export async function rateLimit(db, bucket, key, now = Date.now()) {
  const max = LIMITS[bucket] || 30, windowStart = Math.floor(now / 60000);
  const row = await db.prepare(`INSERT INTO rate_limits (bucket, window_start, hits) VALUES (?, ?, 1)
    ON CONFLICT(bucket, window_start) DO UPDATE SET hits = hits + 1 RETURNING hits`).bind(`${bucket}:${key || 'none'}`, windowStart).first();
  if (row && row.hits > max) fail(429, 'Too many attempts. Please wait a minute and try again.');
}

// ---------- SIWE ----------
export async function issueNonce(db, now = Date.now()) {
  const nonce = randomHex(16);
  await db.prepare('INSERT INTO wallet_nonces (nonce_hash, expires_at) VALUES (?, ?)').bind(await sha256(nonce), sqlTime(now + NONCE_MINUTES * 60000)).run();
  return nonce;
}

// Verifies a signed SIWE message for this site and consumes its nonce. Returns the lowercase address.
export async function verifySiwe(db, env, { message, signature }, { host, chainId, now = Date.now(), verifyContract } = {}) {
  if (typeof message !== 'string' || message.length > 2000 || typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130,}$/.test(signature) || signature.length > 20000) fail(400, 'Invalid sign-in request.');
  let fields;
  try { fields = parseSiweMessage(message); } catch { fail(400, 'Invalid sign-in message.'); }
  const address = normAddress(fields.address);
  if (!address) fail(400, 'Invalid wallet address.');
  if (fields.domain !== host) fail(400, 'This sign-in message is for another site.');
  if (fields.uri !== `https://${host}` && fields.uri !== `https://${host}/` && !(host.startsWith('127.0.0.1') || host.startsWith('localhost'))) fail(400, 'This sign-in message is for another site.');
  if (fields.version !== '1') fail(400, 'Invalid sign-in message.');
  if (fields.chainId !== chainId) fail(400, 'Please switch your wallet to Ethereum and try again.');
  if (!fields.nonce || !/^[a-f0-9]{32}$/.test(fields.nonce)) fail(400, 'Invalid sign-in message.');
  if (!validateSiweMessage({ message: fields, domain: host, nonce: fields.nonce, time: new Date(now) })) fail(400, 'This sign-in message has expired. Please try again.');
  if (fields.issuedAt && Math.abs(now - fields.issuedAt.getTime()) > NONCE_MINUTES * 60000) fail(400, 'This sign-in message has expired. Please try again.');
  let ok = false;
  try { ok = (await recoverMessageAddress({ message, signature })).toLowerCase() === address; } catch { ok = false; }
  if (!ok && verifyContract) ok = await verifyContract({ address: checksum(address), message, signature }).catch(() => false);
  if (!ok) fail(401, 'The signature does not match this wallet.');
  // Single use: only one request can flip used_at for an unexpired nonce.
  const used = await db.prepare(`UPDATE wallet_nonces SET used_at = datetime('now') WHERE nonce_hash = ? AND used_at IS NULL AND expires_at > ?`)
    .bind(await sha256(fields.nonce), sqlTime(now)).run();
  if ((used.meta?.changes ?? 0) !== 1) fail(401, 'This sign-in request was already used or has expired. Please try again.');
  return address;
}
// Smart-contract wallets (ERC-1271 / ERC-6492) are verified on-chain.
export function contractVerifier(env, chainId) {
  const url = rpcUrl(env, chainId);
  if (!url) return null;
  const client = createPublicClient({ transport: http(url) });
  return (args) => client.verifyMessage(args);
}

// ---------- wallet player + session ----------
export async function upsertWalletPlayer(db, address, meta, extra = {}) {
  await db.batch([
    db.prepare(`INSERT INTO players (id, display_name, wallet_address, first_connected_at, last_connected_at, country, city, device, os, browser, language, first_referrer, first_campaign, ip_hash)
      VALUES (?, ?, ?, datetime('now'), datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET last_connected_at = datetime('now'), last_seen_at = datetime('now'), first_connected_at = COALESCE(first_connected_at, datetime('now')),
        wallet_address = excluded.wallet_address, country = COALESCE(excluded.country, country), city = COALESCE(excluded.city, city),
        device = excluded.device, os = excluded.os, browser = excluded.browser, language = COALESCE(excluded.language, language), ip_hash = COALESCE(excluded.ip_hash, ip_hash)`)
      .bind(address, `${address.slice(0, 6)}...${address.slice(-4)}`, address, meta.country, meta.city, meta.device, meta.os, meta.browser, meta.language,
        extra.referrer || null, extra.campaign || null, meta.ipHash),
    db.prepare(`INSERT OR IGNORE INTO player_identities (kind, value, player_id, verified) VALUES ('wallet', ?, ?, 1)`).bind(address, address),
    db.prepare(`INSERT INTO wallet_connections (player_id, address, country, city, device, os, browser, language, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(address, address, meta.country, meta.city, meta.device, meta.os, meta.browser, meta.language, meta.ipHash),
  ]);
  return db.prepare('SELECT * FROM players WHERE id = ?').bind(address).first();
}
export async function createWalletSession(db, address, now = Date.now()) {
  const token = randomHex(32);
  await db.prepare('INSERT INTO wallet_sessions (token_hash, player_id, address, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), address, address, sqlTime(now + SESSION_DAYS * 864e5)).run();
  return token;
}
export function walletCookie(token) {
  return token ? `${WALLET_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`
    : `${WALLET_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
export function walletToken(request) {
  const matches = (request.headers.get('Cookie') || '').split(';').map((p) => p.trim()).filter((p) => p.startsWith(`${WALLET_COOKIE}=`));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(WALLET_COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}
export async function resolveWalletPlayer(db, token, now = Date.now()) {
  if (!token) return null;
  return db.prepare(`SELECT p.* FROM wallet_sessions s JOIN players p ON p.id = s.player_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`).bind(await sha256(token), sqlTime(now)).first();
}
export async function revokeWalletSession(db, token) {
  if (!token) return;
  await db.prepare("UPDATE wallet_sessions SET revoked_at = datetime('now') WHERE token_hash = ? AND revoked_at IS NULL").bind(await sha256(token)).run();
}

// ---------- profile ----------
export async function profile(db, player, settings) {
  const [email, deposits, withdrawals, fee, pending] = await Promise.all([
    db.prepare("SELECT value, consent FROM player_identities WHERE player_id = ? AND kind = 'email' ORDER BY created_at DESC LIMIT 1").bind(player.id).first(),
    db.prepare("SELECT tx_hash, amount_units, status, created_at, credited_at FROM chain_deposits WHERE player_id = ? OR from_address = ? ORDER BY created_at DESC LIMIT 20").bind(player.id, player.id).all(),
    db.prepare("SELECT id, amount_units, fee_units, send_units, status, tx_hash, created_at, sent_at FROM chain_withdrawals WHERE player_id = ? AND kind = 'player' ORDER BY created_at DESC LIMIT 20").bind(player.id).all(),
    withdrawalFee(db, settings),
    db.prepare(`SELECT MAX(credited_at) AS since FROM chain_deposits WHERE finalized_at IS NULL AND reversed_at IS NULL AND review_at IS NULL
      AND player_id = ? AND status IN ('credited', 'assigned') AND credited_at IS NOT NULL`).bind(player.id).first(),
  ]);
  return {
    address: checksum(player.wallet_address), firstConnectedAt: player.first_connected_at, termsAcceptedAt: player.terms_accepted_at,
    email: email ? email.value : null, emailConsent: email ? !!email.consent : false,
    chainId: settings.chainId, token: checksum(settings.token), casinoWallet: settings.casinoWallet ? checksum(settings.casinoWallet) : null,
    confirmations: settings.confirmations, minDepositCents: settings.minDepositUnits, minWithdrawalCents: settings.minWithdrawalUnits,
    withdrawalFeeCents: fee.feeCents, realEnabled: !!settings.realEnabled && !!settings.casinoWallet,
    depositsOpen: !!settings.depositsOpen && !!settings.casinoWallet, withdrawalsOpen: !!settings.withdrawalsOpen && !!settings.casinoWallet,
    hasDeposited: deposits.results.some((d) => d.status === 'credited'),
    // When the newest top up that is not final yet arrived (UTC ISO), for the page's 'withdrawals open in about N minutes'.
    withdrawPendingSince: pending?.since ? `${pending.since.replace(' ', 'T')}Z` : null,
    deposits: deposits.results.map((d) => ({ txHash: d.tx_hash, amountCents: d.amount_units, status: d.status, createdAt: d.created_at, creditedAt: d.credited_at })),
    withdrawals: withdrawals.results.map((w) => ({ id: w.id, amountCents: w.amount_units, feeCents: w.fee_units, sendCents: w.send_units, status: w.status, txHash: w.tx_hash, createdAt: w.created_at, sentAt: w.sent_at })),
  };
}
export async function saveEmail(db, player, body) {
  const raw = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const consent = body.consent === true ? 1 : 0;
  if (raw && (raw.length > 254 || !EMAIL.test(raw))) fail(400, 'Please enter a valid email address.');
  if (raw) {
    const taken = await db.prepare("SELECT player_id FROM player_identities WHERE kind = 'email' AND value = ?").bind(raw).first();
    if (taken && taken.player_id !== player.id) fail(409, 'That email is already linked to another wallet.');
  }
  const statements = [db.prepare("DELETE FROM player_identities WHERE kind = 'email' AND player_id = ? AND value != ?").bind(player.id, raw)];
  if (raw) statements.push(db.prepare(`INSERT INTO player_identities (kind, value, player_id, verified, consent) VALUES ('email', ?, ?, 0, ?)
    ON CONFLICT(kind, value) DO UPDATE SET consent = excluded.consent`).bind(raw, player.id, consent));
  await db.batch(statements);
  return { email: raw || null, emailConsent: raw ? !!consent : false };
}

// ---------- casino wallet snapshot ----------
// Cached 15 s per database (one per isolate in production).
const floatCaches = new WeakMap();
export async function readFloat(db, now = Date.now()) {
  const hit = floatCaches.get(db);
  if (hit && now >= hit.at && now - hit.at < 15000) return hit.value;
  const row = await db.prepare("SELECT value FROM chain_state WHERE key = 'float'").first();
  const value = row ? JSON.parse(row.value) : null;
  floatCaches.set(db, { at: now, value });
  return value;
}
export function freeFloatFrom(snapshot, now = Date.now()) {
  if (!snapshot || now - snapshot.at > FLOAT_MAX_AGE_MS || !Number.isSafeInteger(snapshot.freeUnits)) return 0;
  return Math.max(0, snapshot.freeUnits);
}
// Live view for spins and the public reserve card: the cached on-chain wallet balance minus what
// players are owed right now and minus the exposure of real spins in progress (spin_holds).
// The most one spin may PAY (total return, stake included) is a share of that free float.
// A booking is not released by time any more (re-audit R1): it stays counted until the Worker sees the
// spin answered with its balance in the central copy, the player's wallet copies it (its flush deletes
// the booking in the same batch as the new balance), or the cron learns the spin never happened.
// expires_at is set far ahead so every reader that counts "expires_at > now" keeps counting it.
const HOLD_KEEP_MS = 10 * 365 * 86_400_000;
export const HOLD_CHECK_AFTER_MS = 120_000;
export const HOLD_ALERT_AFTER_MS = 10 * 60_000;
const openHolds = async (db, now) => (await db.prepare('SELECT COALESCE(SUM(units),0) AS n FROM spin_holds WHERE expires_at > ?').bind(now).first().catch(() => ({ n: 0 })))?.n || 0;
// A payout marked 'sent' no longer counts as owed, but the snapshot's token balance may have been read
// before it left the wallet (the snapshot is refreshed about once a minute and used for up to 10). So
// everything marked sent since shortly before the snapshot is still taken off that balance. The margin
// covers a node that answered the balance a little behind; counting a payout twice for a minute only
// makes the table limit smaller, never bigger. Uses the index chain_withdrawals_sent_at (status, sent_at).
const SENT_MARGIN_S = 30;
const sentSinceSql = (since) => `(SELECT COALESCE(SUM(send_units), 0) FROM chain_withdrawals WHERE status = 'sent' AND sent_at >= ${since})`;
export const sentSinceTime = (snapshotAt) => sqlTime(snapshotAt - SENT_MARGIN_S * 1000);
async function sentSinceUnits(db, snapshotAt) {
  return (await db.prepare(`SELECT ${sentSinceSql('?')} AS n`).bind(sentSinceTime(snapshotAt)).first())?.n || 0;
}
export async function liveFloat(db, settings, now = Date.now()) {
  const snapshot = await readFloat(db, now);
  if (!snapshot || now - snapshot.at > FLOAT_MAX_AGE_MS || !Number.isSafeInteger(snapshot.tokenUnits) || !settings.casinoWallet) return null;
  const [owed, held, sent] = await Promise.all([owedUnits(db), openHolds(db, now), sentSinceUnits(db, snapshot.at)]);
  const tokenUnits = Math.max(0, snapshot.tokenUnits - sent); // what the wallet still holds
  const free = Math.max(0, tokenUnits - owed - held);
  const pct = Math.min(100, Math.max(1, Number(settings.maxSpinExposurePct) || DEFAULT_TICS.maxSpinExposurePct));
  return { at: snapshot.at, wallet: snapshot.wallet, chainId: snapshot.chainId, tokenUnits, owedUnits: owed, heldUnits: held, sentUnits: sent, freeUnits: free,
    covered: tokenUnits >= owed, exposurePct: pct, maxWinUnits: Math.floor(free * pct / 100 / 10_000) * 10_000 }; // whole 100 $TICS
}
// Demo spins only need the table limit to follow the real one roughly, so they share one reading per
// database for a few seconds instead of summing everything owed on every spin.
const DEMO_FLOAT_MS = 5000;
const demoFloatCache = new WeakMap();
export async function liveFloatCached(db, settings, now = Date.now()) {
  const hit = demoFloatCache.get(db);
  if (hit && now - hit.at >= 0 && now - hit.at < DEMO_FLOAT_MS && hit.wallet === settings.casinoWallet && hit.pct === settings.maxSpinExposurePct) return hit.value;
  const value = await liveFloat(db, settings, now);
  demoFloatCache.set(db, { at: now, wallet: settings.casinoWallet, pct: settings.maxSpinExposurePct, value });
  return value;
}
// Atomic reservation of a real spin's worst net win. One conditional INSERT, so D1 (one writer)
// checks and books it in a single step: two spins can never both take the same free float.
// The token balance and its time come from the same snapshot row, so payouts sent since are taken off.
export async function reserveSpinExposure(db, { id, playerId, units, now = Date.now() }) {
  if (!Number.isSafeInteger(units) || units < 0) return false;
  const since = `(SELECT datetime(CAST(json_extract(value, '$.at') AS INTEGER) / 1000 - ${SENT_MARGIN_S}, 'unixepoch') FROM chain_state WHERE key = 'float')`;
  const r = await db.prepare(`INSERT INTO spin_holds (id, player_id, units, expires_at, booked_at)
    SELECT ?1, ?2, ?3, ?4, ?5
    WHERE COALESCE((SELECT json_extract(value, '$.tokenUnits') FROM chain_state WHERE key = 'float'), 0)
      - ${sentSinceSql(since)}
      - (${OWED_SQL})
      - (SELECT COALESCE(SUM(units), 0) FROM spin_holds WHERE expires_at > ?5) >= ?3`)
    .bind(id, playerId, units, now + HOLD_KEEP_MS, now).run();
  return (r.meta?.changes ?? r.changes ?? 0) === 1;
}
export async function releaseSpinExposure(db, id) {
  await db.prepare('DELETE FROM spin_holds WHERE id = ?').bind(id).run().catch(() => {});
}
// Cron: bookings the Worker could not release (no reply from the wallet, or its central copy failed).
// Ask the player's wallet: 'void' (the spin never ran there, and now never will) or 'flushed' (its balance
// is in the central copy) -> release. 'pending' -> keep counting it, and alert once it is 10 minutes old.
export async function sweepSpinHolds(env, now = Date.now()) {
  const db = env.DB, out = { checked: 0, released: 0, kept: 0 };
  // Longest-unchecked first, so bookings that stay open (a copy that keeps failing) never hide newer ones.
  const { results = [] } = await db.prepare('SELECT id, player_id, units, booked_at FROM spin_holds WHERE booked_at IS NOT NULL AND booked_at < ? ORDER BY COALESCE(checked_at, 0), booked_at LIMIT 25')
    .bind(now - HOLD_CHECK_AFTER_MS).all();
  const started = Date.now();
  for (const h of results) {
    if (Date.now() - started > 20_000) break; // the rest next minute
    out.checked++;
    await db.prepare('UPDATE spin_holds SET checked_at = ? WHERE id = ?').bind(now, h.id).run();
    const state = await walletOp(env, h.player_id, 'hold-status', { holdId: h.id }).then((r) => r.state, (e) => { console.error('hold check failed', h.id, e?.message || e); return null; });
    if (state === 'void' || state === 'flushed') { await releaseSpinExposure(db, h.id); out.released++; continue; }
    out.kept++;
    if (now - h.booked_at >= HOLD_ALERT_AFTER_MS) await raise(db, { type: 'tics_hold_stuck', severity: 'warning', key: `tics_hold_stuck:${h.id}`, playerId: h.player_id,
      title: 'A real spin has not reached the central copy', details: `The balance after a real spin of ${h.player_id} has not been copied to the central database for over 10 minutes. Its possible win (${formatTics(h.units)}) stays counted against the casino wallet, so every win is still covered, but the copy keeps failing. Check the game Worker logs.` }).run().catch(() => {});
  }
  return out;
}
export async function pruneSpinHolds(db, now = Date.now()) {
  await db.prepare('DELETE FROM spin_holds WHERE expires_at < ?').bind(now - 3600_000).run().catch(() => {});
}
let reserveCache = null;
export async function publicReserve(db, settings, straightMultiplier = 36, now = Date.now()) {
  if (reserveCache && now - reserveCache.at < 20000) return reserveCache.value;
  const f = await liveFloat(db, settings, now);
  const maxWin = f && settings.realEnabled ? f.maxWinUnits : 0;
  const value = f ? { live: true, chainId: f.chainId, wallet: f.wallet ? checksum(f.wallet) : null, tokenUnits: f.tokenUnits, covered: f.covered,
    maxWinUnits: maxWin, maxStraightUnits: Math.floor(maxWin / straightMultiplier), exposurePct: f.exposurePct, updatedAt: new Date(f.at).toISOString() } : { live: false };
  reserveCache = { at: now, value };
  return value;
}
// What the casino owes or is already sending: every player's real balance, player withdrawals not yet
// paid (including 'holding', created just before the money is set aside), and treasury sends in flight.
export const OWED_SQL = `(SELECT COALESCE(SUM(real_tics_cents), 0) FROM players WHERE real_tics_cents > 0)
      + (SELECT COALESCE(SUM(amount_units), 0) FROM chain_withdrawals WHERE kind = 'player' AND status IN ('holding','queued','signing','sending','blocked','cancelling'))
      + (SELECT COALESCE(SUM(amount_units), 0) FROM chain_withdrawals WHERE kind = 'treasury' AND status IN ('queued','signing','sending'))`;
export async function owedUnits(db) {
  return (await db.prepare(`SELECT ${OWED_SQL} AS n`).first()).n || 0;
}
const raise = (db, a) => db.prepare(`INSERT OR IGNORE INTO alerts (type, severity, title, details, player_id, dedupe_key) VALUES (?, ?, ?, ?, ?, ?)`)
  .bind(a.type, a.severity || 'warning', a.title, a.details || null, a.playerId || null, a.key);
export { raise as raiseAlert };

export async function refreshFloat(env, settings, rpc, now = Date.now()) {
  const db = env.DB;
  const [tokenWei, ethWei, owed] = await Promise.all([
    tokenBalance(rpc, settings.token, settings.casinoWallet), rpc('eth_getBalance', [settings.casinoWallet, 'latest']).then((h) => BigInt(h)), owedUnits(db),
  ]);
  const tokenUnits = weiToUnits(tokenWei);
  // Insolvency check: a payout that is 'sending' may already have left the wallet while it still counts
  // as owed, so leave those out here (counting them twice would falsely pause payouts after a big send),
  // and only act on two bad readings in a row.
  const inFlight = (await db.prepare("SELECT COALESCE(SUM(amount_units),0) AS n FROM chain_withdrawals WHERE status = 'sending'").first())?.n || 0;
  const previous = await db.prepare("SELECT value FROM chain_state WHERE key = 'float'").first().then((r) => (r ? JSON.parse(r.value) : null)).catch(() => null);
  const insolvent = tokenUnits < owed - inFlight;
  const snapshot = { at: now, chainId: settings.chainId, wallet: settings.casinoWallet, tokenUnits, ethWei: ethWei.toString(), owedUnits: owed, freeUnits: tokenUnits - owed, insolvent };
  const hour = sqlTime(now).slice(0, 13);
  const statements = [db.prepare(`INSERT INTO chain_state (key, value) VALUES ('float', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).bind(JSON.stringify(snapshot))];
  if (insolvent && previous?.insolvent) {
    statements.push(raise(db, { type: 'tics_insolvent', severity: 'critical', key: `tics_insolvent:${hour}`, title: 'Casino wallet holds less TICS than players are owed',
      details: `Wallet ${formatTics(tokenUnits)}, owed ${formatTics(owed)}. Automatic payouts were paused. Top up the casino wallet.` }));
    if (!settings.payoutsPaused) await db.prepare("UPDATE settings SET value = json_set(value, '$.payoutsPaused', json('true'), '$.pausedReason', ?), updated_at = datetime('now') WHERE key = 'tics_payments'")
      .bind('Casino wallet holds less than players are owed').run();
  }
  if (settings.lowFloatUnits > 0 && snapshot.freeUnits < settings.lowFloatUnits) statements.push(raise(db, { type: 'tics_low_float', key: `tics_low_float:${hour}`,
    title: `Casino wallet float is low: ${formatTics(snapshot.freeUnits)} free`, details: `Holding ${formatTics(tokenUnits)}, owed to players ${formatTics(owed)}. Consider topping up.` }));
  if (settings.highFloatUnits > 0 && snapshot.freeUnits > settings.highFloatUnits) statements.push(raise(db, { type: 'tics_high_float', severity: 'info', key: `tics_high_float:${hour.slice(0, 10)}`,
    title: `Casino wallet float is high: ${formatTics(snapshot.freeUnits)} free`, details: 'Consider moving some to the treasury from the Treasury page.' }));
  if (ethWei < BigInt(settings.lowEthWei || 0)) statements.push(raise(db, { type: 'tics_low_eth', key: `tics_low_eth:${hour}`,
    title: 'Casino wallet is low on ETH for gas', details: `It holds ${(Number(ethWei) / 1e18).toFixed(5)} ETH. Payouts stop when gas runs out.` }));
  await db.batch(statements);
  floatCaches.delete(db);
  demoFloatCache.delete(db);
  return snapshot;
}

// ---------- deposits ----------
async function walletOp(env, playerId, op, body) {
  const stub = env.CASINO.get(env.CASINO.idFromName(playerId));
  const res = await stub.fetch(new Request(`https://wallet/internal/${op}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': env.INTERNAL_SECRET }, body: JSON.stringify(body) }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new WalletError(res.status, data.error || 'wallet error');
  return data;
}
export { walletOp };

// Wallets of the casino itself (the casino wallet, the treasury and any admin-listed house wallets).
// Their transfers in are top ups of the float, never player money: recorded as 'ignored' and not credited.
export function houseAddresses(settings) {
  const list = [settings.casinoWallet, settings.treasuryAddress, ...(Array.isArray(settings.houseAddresses) ? settings.houseAddresses : [])];
  return new Set(list.filter((a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)).map((a) => a.toLowerCase()));
}
// How many identical transfers (same sender and amount) come before each one in its transaction. Unlike
// the log index, this does not change when a reorg puts the transaction into another block.
export function withOrdinals(transfers) {
  return transfers.map((t) => ({ ...t, ordinal: transfers.filter((o) => o.txHash === t.txHash && o.from === t.from && o.amountWei === t.amountWei && o.logIndex < t.logIndex).length }));
}
export async function recordTransfer(env, settings, t) {
  const db = env.DB, id = `${settings.chainId}:${t.txHash}:${t.logIndex}`;
  const units = weiToUnits(t.amountWei);
  const ordinal = Number.isSafeInteger(t.ordinal) ? t.ordinal : 0;
  const house = houseAddresses(settings).has(t.from);
  const player = house ? null : await db.prepare('SELECT id FROM players WHERE wallet_address = ?').bind(t.from).first();
  const status = house ? 'ignored' : units < settings.minDepositUnits ? 'below_min' : player ? 'credited' : 'unmatched';
  // Ignored on a clash with the id OR with the same transfer recorded before a reorg under another log index.
  await db.prepare(`INSERT OR IGNORE INTO chain_deposits (id, chain_id, tx_hash, log_index, block_number, from_address, to_address, amount_wei, amount_units, player_id, status, note, tx_ordinal, token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, settings.chainId, t.txHash, t.logIndex, t.blockNumber, t.from, t.to, t.amountWei, units,
    status === 'credited' ? player.id : null, status, house ? 'house wallet top up' : null, ordinal, settings.token).run();
  let row = await db.prepare('SELECT * FROM chain_deposits WHERE id = ?').bind(id).first();
  if (!row) {
    // The same transfer is already recorded under its old log index: it is never recorded or credited twice.
    row = await db.prepare('SELECT * FROM chain_deposits WHERE chain_id = ? AND tx_hash = ? AND from_address = ? AND amount_wei = ? AND tx_ordinal = ?')
      .bind(settings.chainId, t.txHash, t.from, t.amountWei, ordinal).first();
    if (!row) throw new Error(`deposit ${id} could not be recorded`);
    await raise(db, { type: 'tics_reorg', severity: 'info', key: `tics_reorg:${id}`, title: 'A deposit moved to another block',
      details: `${t.txHash} was seen again at log ${t.logIndex} (block ${t.blockNumber}) after a chain reorganisation. It was recorded once as ${row.id}.` }).run();
  }
  if (row.status === 'unmatched') await raise(db, { type: 'tics_unmatched', key: `tics_unmatched:${row.id}`, title: `Deposit from an unknown wallet: ${formatTics(units)}`,
    details: `${t.from} sent ${formatTics(units)} in ${t.txHash}. It is not linked to a player. Assign it on the Payments page if it belongs to one.` }).run();
  if (row.status === 'credited' && !row.credited_at) await creditRow(env, row);
  return db.prepare('SELECT * FROM chain_deposits WHERE id = ?').bind(row.id).first();
}
async function creditRow(env, row) {
  const settings = await ticsSettings(env.DB);
  await walletOp(env, row.player_id, 'tics-deposit', { ref: `td:${row.chain_id}-${row.tx_hash}-${row.log_index}`, amountCents: row.amount_units, playerId: row.player_id, demoStartUnits: settings.demoStartUnits });
  await env.DB.prepare("UPDATE chain_deposits SET credited_at = datetime('now') WHERE id = ? AND credited_at IS NULL").bind(row.id).run();
  await env.DB.prepare(`INSERT INTO events (type, player_id, value_cents, meta) VALUES ('deposit', ?, ?, ?)`).bind(row.player_id, row.amount_units, JSON.stringify({ currency: 'TICS', tx: row.tx_hash })).run().catch(() => {});
}

// Quick-lane credits per sending wallet over the last 24 hours stay under quickDailyMaxUnits, so a
// big amount split into many small transfers still waits for the full confirmation depth. Booked with
// one conditional INSERT (D1 runs one write at a time), so parallel checks cannot pass the cap together.
// Idempotent per deposit: a deposit that already has its booking stays allowed.
// Returns { ok, inserted }: inserted is true only when this call made the booking.
async function bookQuick(db, settings, depositId, from, units, now = Date.now()) {
  const cap = settings.quickDailyMaxUnits ?? settings.quickDepositMaxUnits;
  if (!(Number.isSafeInteger(cap) && cap > 0)) return { ok: false, inserted: false };
  const ins = await db.prepare(`INSERT INTO quick_lane (deposit_id, from_address, units, at_ms)
    SELECT ?1, ?2, ?3, ?4 WHERE COALESCE((SELECT SUM(units) FROM quick_lane WHERE from_address = ?2 AND at_ms > ?5), 0) + ?3 <= ?6
    ON CONFLICT(deposit_id) DO NOTHING RETURNING deposit_id`).bind(depositId, from, units, now, now - 86_400_000, cap).first();
  if (ins) return { ok: true, inserted: true };
  return { ok: !!(await db.prepare('SELECT 1 AS ok FROM quick_lane WHERE deposit_id = ?').bind(depositId).first()), inserted: false };
}
// Fast path after the player says "I have sent it".
export async function checkDepositTx(env, settings, rpc, txHash) {
  if (!isTxHash(txHash)) fail(400, 'That is not a transaction hash.');
  const receipt = await rpc('eth_getTransactionReceipt', [txHash]);
  if (!receipt) return { status: 'pending', confirmations: 0, required: settings.confirmations };
  if (receipt.status !== '0x1') return { status: 'failed', confirmations: 0, required: settings.confirmations };
  const latest = hexToNumber(await rpc('eth_blockNumber'));
  const confirmations = latest - hexToNumber(receipt.blockNumber) + 1;
  const transfers = withOrdinals(decodeTransfers(receipt.logs.map((l) => ({ ...l, blockNumber: receipt.blockNumber, transactionHash: receipt.transactionHash })), settings.token, settings.casinoWallet));
  if (!transfers.length) return { status: 'not_tics', confirmations, required: settings.confirmations };
  const total = weiToUnits(transfers.reduce((sum, t) => sum + BigInt(t.amountWei), 0n));
  let required = confirmationsFor(settings, total);
  if (required < settings.confirmations && confirmations >= required) {
    // Only once it is deep enough to credit: every transfer in the transaction must fit its sender's
    // quick cap, otherwise undo the bookings THIS call made (a parallel call's booking stays: it may be
    // crediting on it right now) and wait for the full depth.
    const booked = [];
    for (const t of transfers) {
      const id = `${settings.chainId}:${t.txHash}:${t.logIndex}`;
      const b = await bookQuick(env.DB, settings, id, t.from, weiToUnits(t.amountWei));
      if (b.ok) { if (b.inserted) booked.push(id); continue; }
      for (const b of booked) await env.DB.prepare('DELETE FROM quick_lane WHERE deposit_id = ? AND deposit_id NOT IN (SELECT id FROM chain_deposits WHERE credited_at IS NOT NULL)').bind(b).run();
      required = settings.confirmations; break;
    }
  }
  if (confirmations < required) return { status: 'confirming', confirmations, required };
  const rows = [];
  for (const t of transfers) rows.push(await recordTransfer(env, settings, t));
  return { status: rows.every((r) => r.status === 'credited') ? 'credited' : rows[0].status, confirmations, required,
    amountCents: rows.reduce((s, r) => s + r.amount_units, 0) };
}

// Cron: scan new confirmed blocks for $TICS sent to the casino wallet.
// Two cursors: 'tics_watch' runs at the quick depth and records deposits up to
// quickDepositMaxUnits; 'tics_watch_full' runs at the full depth and records
// the bigger ones. Each transfer belongs to exactly one cursor by its amount,
// and recording is idempotent, so nothing is credited twice or skipped.
export async function scanDeposits(env, settings, rpc, maxChunks = 30) {
  const db = env.DB;
  const latest = hexToNumber(await rpc('eth_blockNumber'));
  const quickDepth = confirmationsFor(settings, 0);
  const split = quickDepth < settings.confirmations;
  const lanes = split
    ? [{ key: 'tics_watch', depth: quickDepth, quick: true, take: (units) => units <= settings.quickDepositMaxUnits },
       // The full lane looks at everything; recording is idempotent, so it only credits what the quick lane left.
       { key: 'tics_watch_full', depth: settings.confirmations, take: () => true }]
    : [{ key: 'tics_watch', depth: settings.confirmations, take: () => true }];
  let found = 0, lastBlock = null;
  const sameWatch = (st) => st && st.chainId === settings.chainId && st.token === settings.token && st.wallet === settings.casinoWallet;
  const readState = async (key) => { const r = await db.prepare('SELECT value FROM chain_state WHERE key = ?').bind(key).first(); return r ? JSON.parse(r.value) : null; };
  for (const lane of lanes) {
    const safe = latest - lane.depth + 1;
    let state = await readState(lane.key);
    if (!split && sameWatch(state)) {
      // One lane only (quick path off): the main cursor may have run ahead at the quick depth while the
      // full lane, which alone records the bigger deposits, was further back. Resume from the lower one.
      const full = await readState('tics_watch_full');
      if (sameWatch(full) && full.lastBlock < state.lastBlock) state = { ...state, lastBlock: full.lastBlock };
    }
    if (!sameWatch(state)) {
      // A new full lane starts where the main cursor's full-depth view starts, so big deposits already past are not missed.
      const base = lane.key === 'tics_watch_full' ? await db.prepare("SELECT value FROM chain_state WHERE key = 'tics_watch'").first() : null;
      const fromMain = base ? JSON.parse(base.value) : null;
      const start = fromMain && fromMain.wallet === settings.casinoWallet ? Math.min(fromMain.lastBlock, safe) - (settings.confirmations - quickDepth)
        : Number.isSafeInteger(settings.startBlock) ? settings.startBlock - 1 : safe - 50;
      state = { chainId: settings.chainId, token: settings.token, wallet: settings.casinoWallet, lastBlock: start };
    }
    for (let i = 0; i < maxChunks && state.lastBlock < safe; i++) {
      const from = state.lastBlock + 1, to = Math.min(safe, from + LOG_CHUNK - 1);
      const logs = await rpc('eth_getLogs', [transferLogsFilter(settings.token, settings.casinoWallet, from, to)]);
      // A transaction's logs all sit in one block, so its ordinals are complete within one query.
      for (const t of withOrdinals(decodeTransfers(logs, settings.token, settings.casinoWallet))) {
        if (!lane.take(weiToUnits(t.amountWei))) continue;
        if (lane.quick && !(await bookQuick(db, settings, `${settings.chainId}:${t.txHash}:${t.logIndex}`, t.from, weiToUnits(t.amountWei))).ok) continue;
        await recordTransfer(env, settings, t); found++;
      }
      state.lastBlock = to;
      const put = (key) => db.prepare(`INSERT INTO chain_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).bind(key, JSON.stringify(state));
      // With one lane it scans at the full depth, so the full-lane cursor moves with it.
      await db.batch(split ? [put(lane.key)] : [put(lane.key), put('tics_watch_full')]);
    }
    if (lane.key === 'tics_watch') lastBlock = state.lastBlock;
  }
  // Retry credits that were recorded but not yet applied (e.g. a wallet call failed).
  const stuck = await db.prepare("SELECT * FROM chain_deposits WHERE status = 'credited' AND credited_at IS NULL LIMIT 20").all();
  for (const row of stuck.results) await creditRow(env, row).catch((e) => console.error('deposit credit retry failed', e));
  return { latest, lastBlock, found };
}

// A withdrawal whose "set money aside" step ended with an unknown result (lost reply, timeout) is
// left as 'holding'. After two minutes ask the player's wallet what really happened and finish it.
export async function settleHoldingRows(env, now = Date.now()) {
  const rows = (await env.DB.prepare("SELECT id, player_id, amount_units FROM chain_withdrawals WHERE kind = 'player' AND status = 'holding' AND created_at <= ? ORDER BY created_at LIMIT 20")
    .bind(sqlTime(now - 120_000)).all()).results || [];
  for (const row of rows) {
    // tics-hold-void answers like tics-hold-check, but when no hold exists it also closes the ref in
    // the player's wallet, so a hold request still on its way can never land after this row is gone.
    const hold = await walletOp(env, row.player_id, 'tics-hold-void', { ref: `th:${row.id}` }).catch(() => null);
    if (!hold) continue;
    if (hold.status === 'held' && hold.units === row.amount_units) {
      // The cooling window starts now, and a large one still alerts.
      const settings = await ticsSettings(env.DB);
      await env.DB.prepare("UPDATE chain_withdrawals SET status = 'queued', release_at = ? WHERE id = ? AND status = 'holding'")
        .bind(sqlTime(now + Math.max(0, settings.coolingSeconds) * 1000), row.id).run();
      if (row.amount_units >= settings.largeWithdrawalAlertUnits) await raise(env.DB, { type: 'tics_large_withdrawal', severity: 'info', key: `tics_wd:${row.id}`, playerId: row.player_id,
        title: `Large withdrawal: ${formatTics(row.amount_units)}`, details: `A withdrawal of ${formatTics(row.amount_units)} was queued after a delayed confirmation.` }).run();
    } else if (hold.status == null || hold.status === 'released') {
      // Nothing is held (never set aside and now closed, or already given back): the claim can go.
      await env.DB.prepare("DELETE FROM chain_withdrawals WHERE id = ? AND status = 'holding'").bind(row.id).run();
    } else {
      // Money may still be held: 'blocked' keeps it counted as owed until someone reviews it.
      await env.DB.prepare("UPDATE chain_withdrawals SET status = 'blocked', last_error = 'hold did not match' WHERE id = ? AND status = 'holding'").bind(row.id).run();
      await raise(env.DB, { type: 'tics_hold_mismatch', severity: 'critical', key: `tics_hold_mismatch:${row.id}`, playerId: row.player_id,
        title: 'A withdrawal did not match its held money', details: `Withdrawal ${row.id} was stopped before payment (hold ${hold.status}, ${hold.units} vs ${row.amount_units}). Check the player in the admin.` }).run();
    }
  }
}
export async function chainTick(env, deps = {}) {
  // Housekeeping: old rate-limit windows and expired sign-in nonces.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(Math.floor(Date.now() / 60000) - 60),
    env.DB.prepare("DELETE FROM wallet_nonces WHERE expires_at < datetime('now', '-1 day')"),
  ]).catch(() => {});
  // Before anything that needs the blockchain node, so an RPC outage does not stop it.
  await settleHoldingRows(env).catch((e) => console.error('holding sweep failed', e));
  const settings = await ticsSettings(env.DB);
  if (!settings.casinoWallet) return { skipped: 'no casino wallet' };
  const rpc = deps.rpc || rpcClient(rpcUrl(env, settings.chainId), deps.fetch, { fallbackUrl: env.ETH_RPC_URL_2 || null });
  if (!rpcUrl(env, settings.chainId) && !deps.rpc) return { skipped: 'no rpc' };
  // A failing deposit scan must not stop the casino wallet snapshot: spins rely on it being fresh.
  let scanError = null;
  const scan = await scanDeposits(env, settings, rpc).catch((e) => { scanError = e; return null; });
  const finality = await finalizeDeposits(env, settings, rpc, { rpc2: deps.rpc2 || (env.ETH_RPC_URL_2 ? rpcClient(env.ETH_RPC_URL_2, deps.fetch) : null), rpc2Url: env.ETH_RPC_URL_2 || null })
    .catch((e) => { console.error('deposit finality check failed', e); return null; });
  const snapshot = await refreshFloat(env, await ticsSettings(env.DB), rpc);
  await pruneSpinHolds(env.DB);
  const gas = await refreshGas(env.DB, rpc).catch((e) => { console.error('gas refresh failed', e); return null; });
  const prices = await refreshPrices(env, settings, deps.fetch || fetch).catch((e) => { console.error('price refresh failed', e); return null; });
  // Last, with a time budget, so slow wallet checks never delay the deposit scan or the wallet snapshot.
  await sweepSpinHolds(env).catch((e) => console.error('spin booking sweep failed', e));
  if (scanError) throw scanError; // still reported by the cron after everything else ran
  return { scan, finality, snapshot, gas, prices };
}

// ---------- withdrawal fee = the gas the payout costs, charged in TICS ----------
// The casino wallet pays ETH gas to send a payout; the player pays about the
// same value in TICS, deducted from the amount withdrawn. Estimate: 52,000 gas
// (a TICS transfer to a wallet that never held TICS; about 34,000 to one that
// does) at the current base fee + 25% (it can rise during the cancel window)
// plus the tip, priced through the market TICS/ETH rate, plus the margin.
// Mainnet check 2026-10-28: real cost 34 TICS, this formula about 75 TICS.
export const PAYOUT_GAS = 52_000n;
const PRICE_EVERY_MS = 5 * 60 * 1000;
const PRICE_MAX_AGE_MS = 60 * 60 * 1000;
const GAS_MAX_AGE_MS = 10 * 60 * 1000;
const putState = (db, key, value) => db.prepare(`INSERT INTO chain_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).bind(key, JSON.stringify(value)).run();
const getState = async (db, key) => { const r = await db.prepare('SELECT value FROM chain_state WHERE key = ?').bind(key).first(); return r ? JSON.parse(r.value) : null; };

export async function refreshGas(db, rpc, now = Date.now()) {
  const [block, tip] = await Promise.all([rpc('eth_getBlockByNumber', ['latest', false]), rpc('eth_maxPriorityFeePerGas').then(BigInt).catch(() => 1_500_000_000n)]);
  const gas = { at: now, baseFeeWei: BigInt(block.baseFeePerGas || '0x0').toString(), tipWei: (tip < 100_000_000n ? 100_000_000n : tip).toString() };
  await putState(db, 'gas', gas);
  return gas;
}
// TICS price in ETH (and USD): CoinGecko coin "qubetics" first, MEXC spot
// (TICSUSDT / ETHUSDT) second. Neither Alchemy nor CoinGecko-by-contract price
// the ERC-20 yet (checked 2026-10-28).
export async function refreshPrices(env, settings, fetchImpl = fetch, now = Date.now()) {
  if (settings.chainId !== 1) return null;
  const prev = await getState(env.DB, 'prices');
  if (prev && now - prev.at < PRICE_EVERY_MS) return prev;
  const getJson = async (url) => { const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) }); return res.ok ? res.json() : null; };
  let out = null;
  try {
    const id = settings.priceId || 'qubetics';
    const body = await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=eth,usd`);
    const row = body && body[id];
    if (row && row.eth > 0) out = { at: now, ticsEth: Number(row.eth), ticsUsd: row.usd ? Number(row.usd) : null, source: 'coingecko' };
  } catch { out = null; }
  if (!out) {
    try {
      const [tics, eth] = await Promise.all([getJson('https://api.mexc.com/api/v3/ticker/price?symbol=TICSUSDT'), getJson('https://api.mexc.com/api/v3/ticker/price?symbol=ETHUSDT')]);
      const ticsUsd = Number(tics?.price), ethUsd = Number(eth?.price);
      if (ticsUsd > 0 && ethUsd > 0) out = { at: now, ticsEth: ticsUsd / ethUsd, ticsUsd, source: 'mexc' };
    } catch { out = null; }
  }
  if (out && Number.isFinite(out.ticsEth) && out.ticsEth > 0) { await putState(env.DB, 'prices', out); return out; }
  return prev;
}

// Returns { feeCents, gasWei, source } for a withdrawal right now.
export async function withdrawalFee(db, settings, now = Date.now()) {
  // Fees off: the casino pays the gas and the player receives the full amount.
  if (settings.feesEnabled === false) return { feeCents: 0, source: 'off' };
  const floor = 0;
  const [gas, prices] = await Promise.all([getState(db, 'gas'), getState(db, 'prices')]);
  const fallback = Math.max(0, settings.fallbackFeeUnits || 0);
  if (!gas || now - gas.at > GAS_MAX_AGE_MS || !prices || now - prices.at > PRICE_MAX_AGE_MS || !(prices.ticsEth > 0)) return { feeCents: fallback, source: 'fallback' };
  const gasWei = PAYOUT_GAS * ((BigInt(gas.baseFeeWei) * 5n) / 4n + BigInt(gas.tipWei));
  // TICS needed = gasWei / (ticsEth * 1e18); in units of 0.01 TICS, with the margin, rounded up.
  const margin = 1 + Math.max(0, settings.gasFeeMarginPct ?? 20) / 100;
  const units = Math.ceil((Number(gasWei) / 1e18 / prices.ticsEth) * 100 * margin);
  return { feeCents: Math.max(floor, units), gasWei: gasWei.toString(), source: prices.source };
}

// ---------- deposit finality (re-audit R2) ----------
// A deposit is credited after a few blocks so the player can play at once, but a few blocks are not
// final. The player's wallet keeps every credited top up as 'not final' (it cannot be withdrawn) until
// the cron has seen its transfer again in a block Ethereum has finalized (about 13 to 15 minutes).
// If the transfer is not there any more, twice at least 5 minutes apart:
//  - a second, independent provider (ETH_RPC_URL_2, not the one this run uses) must not see it either;
//    then the credit is taken back with its own ledger entry, the account is paused, owners get a
//    critical alert. Nothing in the ledger is deleted.
//  - without such a provider nothing is taken back automatically: the account is paused and owners get
//    a critical alert to review it (review_at). The money stays not withdrawable while it is open.
// The longest-unchecked rows are checked first (final_checked_at), so rows that stay open never block
// newer deposits, and one failing row never stops the others.
export const FINAL_MISS_CONFIRM_MS = 5 * 60_000;
const FINAL_STUCK_MS = 60 * 60_000;
export async function unfinalUnits(db, playerId) {
  return (await db.prepare(`SELECT COALESCE(SUM(amount_units), 0) AS n FROM chain_deposits
    WHERE finalized_at IS NULL AND reversed_at IS NULL AND player_id = ? AND status IN ('credited', 'assigned')`).bind(playerId).first())?.n || 0;
}
const depositRef = (row) => `td:${row.chain_id}-${row.tx_hash}-${row.log_index}`;
const transferStillThere = (receipt, row, settings, finalized) => !!receipt && receipt.status === '0x1' && hexToNumber(receipt.blockNumber) <= finalized
  && withOrdinals(decodeTransfers(receipt.logs.map((l) => ({ ...l, blockNumber: receipt.blockNumber, transactionHash: receipt.transactionHash })), row.token || settings.token, row.to_address))
    .some((t) => t.from === row.from_address && t.amountWei === row.amount_wei && t.ordinal === (row.tx_ordinal ?? 0));
export async function finalizeDeposits(env, settings, rpc, { rpc2 = null, rpc2Url = null, now = Date.now() } = {}) {
  const db = env.DB, out = { checked: 0, finalized: 0, missing: 0, reviewed: 0, reversed: 0 };
  const { results = [] } = await db.prepare('SELECT * FROM chain_deposits WHERE finalized_at IS NULL AND reversed_at IS NULL ORDER BY COALESCE(final_checked_at, 0), block_number LIMIT 20').all();
  if (!results.length) return out;
  const fin = await rpc('eth_getBlockByNumber', ['finalized', false]);
  const finalized = fin?.number ? hexToNumber(fin.number) : NaN;
  if (!Number.isSafeInteger(finalized)) return out;
  // The second provider only counts as independent if this run is not already using it.
  const independent = rpc2 && !(rpc2Url && typeof rpc.provider === 'function' && rpc.provider() === rpc2Url) ? rpc2 : null;
  for (const row of results) {
    try {
      await db.prepare('UPDATE chain_deposits SET final_checked_at = ? WHERE id = ?').bind(now, row.id).run();
      if (row.block_number > finalized) continue; // not final yet
      out.checked++;
      const receipt = await rpc('eth_getTransactionReceipt', [row.tx_hash]);
      // Moved into a newer block by a reorg: wait until that one is final.
      if (receipt && receipt.status === '0x1' && hexToNumber(receipt.blockNumber) > finalized) continue;
      let there = transferStillThere(receipt, row, settings, finalized);
      if (!there && independent) {
        const other = await independent('eth_getTransactionReceipt', [row.tx_hash]).catch(() => undefined);
        if (other === undefined) continue; // unknown: ask again next run
        if (transferStillThere(other, row, settings, finalized)) there = true; // our provider is wrong, the chain has it
      }
      if (there) { await markFinal(env, row); out.finalized++; continue; }
      out.missing++;
      if (!row.final_miss_at) { await db.prepare('UPDATE chain_deposits SET final_miss_at = ? WHERE id = ? AND final_miss_at IS NULL').bind(now, row.id).run(); continue; }
      if (now - row.final_miss_at < FINAL_MISS_CONFIRM_MS) continue;
      if (independent) { await reverseDeposit(env, row.id); out.reversed++; continue; }
      if (!row.review_at) { await flagDeposit(env, row); out.reviewed++; }
      else if (now - row.final_miss_at > FINAL_STUCK_MS) await raise(db, { type: 'tics_deposit_open', severity: 'warning', key: `tics_deposit_open:${row.id}`, playerId: row.player_id || null,
        title: 'A deposit is still not found on Ethereum after an hour', details: `${row.tx_hash}: still missing. Set a second provider (ETH_RPC_URL_2) on the game Worker so it can be settled, or check it on Etherscan.` }).run();
    } catch (e) { console.error('deposit finality check failed for', row.id, e?.message || e); }
  }
  return out;
}
async function markFinal(env, row) {
  // The wallet must know first: only then may its money be withdrawn.
  if (row.player_id && ['credited', 'assigned'].includes(row.status)) await walletOp(env, row.player_id, 'tics-deposit-final', { ref: depositRef(row) });
  await env.DB.prepare("UPDATE chain_deposits SET finalized_at = datetime('now'), final_miss_at = NULL WHERE id = ? AND finalized_at IS NULL").bind(row.id).run();
  if (row.review_at) await raise(env.DB, { type: 'tics_deposit_found', severity: 'info', key: `tics_deposit_found:${row.id}`, playerId: row.player_id || null,
    title: 'A deposit under review was found on Ethereum', details: `${row.tx_hash} is in a final block after all. It is final now. The account ${row.player_id || ''} stays paused until an owner resumes it.` }).run();
}
async function flagDeposit(env, row) {
  const db = env.DB;
  // Pause and alert first, then mark it: a crash in between repeats them (both idempotent), never skips them.
  // Once review_at is set this never runs again, so an owner who resumes the account is not overruled.
  if (row.player_id) await db.prepare("UPDATE players SET status = 'frozen' WHERE id = ? AND status = 'active'").bind(row.player_id).run();
  await raise(db, { type: 'tics_deposit_gone', severity: row.player_id ? 'critical' : 'warning', key: `tics_deposit_review:${row.id}`, playerId: row.player_id || null,
    title: `A deposit could not be found on Ethereum: ${formatTics(row.amount_units)}`,
    details: `${row.tx_hash} from ${row.from_address} was not found although its block is final. No second provider confirmed it, so nothing was taken back.${row.player_id ? ` The account ${row.player_id} is paused and it cannot withdraw. Check the transaction on Etherscan.` : ''}` }).run();
  await db.prepare("UPDATE chain_deposits SET review_at = datetime('now') WHERE id = ? AND review_at IS NULL").bind(row.id).run();
}
async function reverseDeposit(env, id) {
  const db = env.DB;
  const row = await db.prepare('SELECT * FROM chain_deposits WHERE id = ?').bind(id).first(); // fresh: an admin may have just assigned it
  if (!row || row.reversed_at) return;
  // Always ask the wallet when a player is linked: it knows whether it credited this ref (and closes it if
  // not). It returns the same amounts on a retry, so every step below also runs after a lost reply.
  const result = row.player_id ? await walletOp(env, row.player_id, 'tics-deposit-reverse', { ref: depositRef(row), amountCents: row.amount_units }) : { reversedCents: 0, shortCents: 0 };
  const taken = result.reversedCents > 0 || result.shortCents > 0;
  // Pause and alert BEFORE the row is marked done: a crash in between repeats them (both idempotent), never skips them.
  if (row.player_id && taken) await db.prepare("UPDATE players SET status = 'frozen' WHERE id = ? AND status = 'active'").bind(row.player_id).run();
  await raise(db, { type: 'tics_deposit_gone', severity: taken ? 'critical' : 'warning', key: `tics_deposit_gone:${row.id}`, playerId: row.player_id || null,
    title: `A deposit disappeared from the chain: ${formatTics(row.amount_units)}`,
    details: `${row.tx_hash} from ${row.from_address} is not on Ethereum any more although its block was final (two providers agree). ${taken
      ? `The credit was taken back (${formatTics(result.reversedCents)}${result.shortCents > 0 ? `; ${formatTics(result.shortCents)} could not be taken back because it was already played or withdrawn` : ''}) and the account ${row.player_id} is paused. Check the transaction on Etherscan before resuming it.`
      : 'It was never credited, and it can no longer be credited or assigned.'}` }).run();
  await db.prepare("UPDATE chain_deposits SET reversed_at = datetime('now'), note = ? WHERE id = ? AND reversed_at IS NULL")
    .bind(`gone from the chain after its block was final${taken ? `; ${formatTics(result.reversedCents)} taken back` : ''}`.slice(0, 200), row.id).run();
}

// ---------- withdrawals ----------
export async function requestWithdrawal(env, player, body, settings, now = Date.now()) {
  const db = env.DB;
  if (!player.wallet_address) fail(403, 'Connect your wallet first.');
  if (!settings.casinoWallet || !settings.withdrawalsOpen) fail(503, 'Withdrawals are not open right now.');
  if (typeof body.requestId !== 'string' || !UUID.test(body.requestId)) fail(400, 'requestId must be a UUID');
  const id = body.requestId.toLowerCase();
  const amount = body.amountCents;
  if (!Number.isSafeInteger(amount) || amount <= 0) fail(400, 'Enter an amount to withdraw.');
  const existing = await db.prepare('SELECT * FROM chain_withdrawals WHERE id = ?').bind(id).first();
  if (existing) {
    if (existing.player_id !== player.id || existing.amount_units !== amount) fail(409, 'This request was already used.');
    return { withdrawalId: id, status: existing.status === 'holding' ? 'pending' : existing.status, duplicate: true };
  }
  // Only a wallet that has deposited $TICS itself can withdraw.
  const deposited = await db.prepare("SELECT 1 AS ok FROM chain_deposits WHERE from_address = ? AND status = 'credited' AND credited_at IS NOT NULL LIMIT 1").bind(player.wallet_address).first();
  if (!deposited) fail(403, 'Withdrawals are only possible to a wallet that has made a deposit.');
  // The player pays the network fee. The browser sends the most it agreed to pay (from the quote).
  const { feeCents: fee } = await withdrawalFee(db, settings, now);
  if (Number.isSafeInteger(body.maxFeeCents) && fee > body.maxFeeCents) fail(409, `The network fee went up to ${formatTics(fee)}. Please check and confirm again.`);
  if (amount < settings.minWithdrawalUnits) fail(400, `The smallest withdrawal is ${formatTics(settings.minWithdrawalUnits)}.`);
  if (amount <= fee) fail(400, `The amount must be more than the network fee of ${formatTics(fee)}.`);
  const ref = `th:${id}`;
  // Re-audit R2: money from a top up whose block Ethereum has not finalized yet can be played but not
  // withdrawn. The player's wallet keeps its own list of such credits and holds that much back.
  const release = new Date(now + Math.max(0, settings.coolingSeconds) * 1000).toISOString().slice(0, 19).replace('T', ' ');
  // 1. Claim the request id first. Only the call whose insert lands goes on to set money aside, so a
  //    request sent several times at once can never hold (or release) the same money twice.
  //    'holding' rows are never picked up by the payouts Worker.
  const claimed = await db.prepare(`INSERT INTO chain_withdrawals (id, kind, player_id, chain_id, to_address, amount_units, fee_units, send_units, status, release_at, requested_by)
    VALUES (?, 'player', ?, ?, ?, ?, ?, ?, 'holding', ?, ?) ON CONFLICT(id) DO NOTHING`).bind(id, player.id, settings.chainId, player.wallet_address, amount, fee,
    amount - fee, release, player.id).run();
  if ((claimed.meta?.changes ?? claimed.changes ?? 0) !== 1) {
    const again = await db.prepare('SELECT player_id, amount_units, status FROM chain_withdrawals WHERE id = ?').bind(id).first();
    if (!again || again.player_id !== player.id || again.amount_units !== amount) fail(409, 'This request was already used.');
    return { withdrawalId: id, status: again.status === 'holding' ? 'pending' : again.status, duplicate: true };
  }
  // 2. Set the money aside. A clear refusal (not enough balance, balance check) removes the claim.
  let held;
  try {
    held = await walletOp(env, player.id, 'tics-hold', { ref, amountCents: amount });
  } catch (error) {
    if (error?.status && error.status < 500) {
      await db.prepare("DELETE FROM chain_withdrawals WHERE id = ? AND status = 'holding'").bind(id).run();
    } // otherwise the outcome is unknown: the 'holding' row stays and settleHoldingRows() resolves it.
    throw error;
  }
  if (held.duplicate) {
    // This id was used in the wallet before (a retry of a request whose claim was removed). Ask what
    // the wallet holds under it instead of guessing.
    const hold = await walletOp(env, player.id, 'tics-hold-check', { ref }).catch(() => null);
    if (!hold || hold.status === 'done' || (hold.status === 'held' && hold.units !== amount)) {
      // Unknown, or something the sweep must look at: the 'holding' row stays and the sweep settles it.
      return { withdrawalId: id, status: 'pending', duplicate: true };
    }
    if (hold.status !== 'held') {
      // Nothing is held under this id (never set aside, or already given back).
      await db.prepare("DELETE FROM chain_withdrawals WHERE id = ? AND status = 'holding'").bind(id).run();
      fail(409, 'This withdrawal request was closed before it went through. Your balance was not changed. Please start a new withdrawal.');
    }
    held = { realTicsCents: undefined }; // held under this id: carry on and queue it
  }
  // 3. Hand it to the payouts queue.
  const queued = await db.prepare("UPDATE chain_withdrawals SET status = 'queued' WHERE id = ? AND status = 'holding'").bind(id).run();
  if ((queued.meta?.changes ?? queued.changes ?? 0) !== 1) {
    const now2 = await db.prepare('SELECT status FROM chain_withdrawals WHERE id = ?').bind(id).first();
    if (!now2) {
      // The claim is gone while the money is held. Give it straight back; only say the balance is
      // unchanged once the wallet confirms it. Otherwise put the claim back so the sweep finishes it.
      const back = await walletOp(env, player.id, 'tics-release', { ref, reason: 'the request expired before it was recorded' }).then(() => true, () => false);
      if (back) fail(409, 'That withdrawal took too long and was cancelled. Your balance was not changed. Please try again.');
      await db.prepare(`INSERT INTO chain_withdrawals (id, kind, player_id, chain_id, to_address, amount_units, fee_units, send_units, status, release_at, requested_by)
        VALUES (?, 'player', ?, ?, ?, ?, ?, ?, 'holding', ?, ?) ON CONFLICT(id) DO NOTHING`).bind(id, player.id, settings.chainId, player.wallet_address, amount, fee,
        amount - fee, release, player.id).run();
      return { withdrawalId: id, status: 'pending' };
    }
    if (now2.status !== 'queued') return { withdrawalId: id, status: now2.status === 'holding' ? 'pending' : now2.status };
  }
  if (amount >= settings.largeWithdrawalAlertUnits) await raise(db, { type: 'tics_large_withdrawal', severity: 'info', key: `tics_wd:${id}`, playerId: player.id,
    title: `Large withdrawal: ${formatTics(amount)}`, details: `${checksum(player.wallet_address)} asked to withdraw ${formatTics(amount)}. It is sent automatically at ${release} UTC unless you cancel it on the Payments page.` }).run();
  return { withdrawalId: id, status: 'queued', releaseAt: release, realTicsCents: held.realTicsCents, feeCents: fee, sendCents: amount - fee };
}

// ---------- holdings (Alchemy Portfolio API) ----------
const NETWORKS = ['eth-mainnet', 'base-mainnet', 'bnb-mainnet'];
const NATIVE = { 'eth-mainnet': ['ETH', 'Ether'], 'base-mainnet': ['ETH', 'Ether (Base)'], 'bnb-mainnet': ['BNB', 'BNB'] };
export function parseHoldings(data) {
  const out = [];
  for (const t of data?.data?.tokens || []) {
    if (!NETWORKS.includes(t.network)) continue;
    let raw;
    try { raw = BigInt(t.tokenBalance || '0'); } catch { continue; }
    if (raw === 0n) continue;
    const native = !t.tokenAddress;
    const meta = t.tokenMetadata || {};
    const decimals = native ? 18 : Number.isInteger(meta.decimals) ? meta.decimals : null;
    if (decimals === null || decimals > 36) continue;
    const amount = Number(raw) / 10 ** decimals;
    const price = (t.tokenPrices || []).find((p) => String(p.currency).toLowerCase() === 'usd');
    const usdPrice = price ? Number(price.value) : null;
    const usdValue = usdPrice != null && Number.isFinite(usdPrice) ? amount * usdPrice : null;
    const [nSym, nName] = NATIVE[t.network];
    out.push({ network: t.network, token: native ? 'native' : String(t.tokenAddress).toLowerCase(),
      symbol: String(native ? nSym : meta.symbol || '?').slice(0, 24), name: String(native ? nName : meta.name || '').slice(0, 64), decimals,
      amount: String(amount), usdPrice, usdValue, hidden: usdValue == null || usdValue < 0.01 ? 1 : 0 });
  }
  return out;
}
export async function refreshHoldings(env, player, { force = false, fetchImpl = fetch, now = Date.now() } = {}) {
  const db = env.DB;
  if (!env.ALCHEMY_API_KEY || !player.wallet_address) return null;
  if (!force && player.holdings_updated_at && now - Date.parse(`${player.holdings_updated_at}Z`) < HOLDINGS_EVERY_MS) return null;
  const deposited = await db.prepare("SELECT 1 AS ok FROM chain_deposits WHERE from_address = ? AND status = 'credited' LIMIT 1").bind(player.wallet_address).first();
  if (!deposited) return { skipped: 'no deposit' };
  if (!(await claimHoldingsBudget(db, now))) return { skipped: 'daily cap' };
  // Up to 5 pages of 100 tokens across the three networks.
  const rows = [];
  let pageKey;
  for (let page = 0; page < 5; page++) {
    const res = await fetchImpl(`https://api.g.alchemy.com/data/v1/${env.ALCHEMY_API_KEY}/assets/tokens/by-address`, { signal: AbortSignal.timeout(15_000), method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addresses: [{ address: player.wallet_address, networks: NETWORKS }], withMetadata: true, withPrices: true, includeNativeTokens: true, ...(pageKey ? { pageKey } : {}) }) });
    if (!res.ok) throw new Error(`holdings lookup failed: HTTP ${res.status}`);
    const body = await res.json();
    rows.push(...parseHoldings(body));
    pageKey = body?.data?.pageKey;
    if (!pageKey) break;
  }
  const total = rows.filter((r) => !r.hidden).reduce((s, r) => s + r.usdValue, 0);
  await db.batch([
    db.prepare('DELETE FROM wallet_holdings WHERE player_id = ?').bind(player.id),
    ...rows.map((r) => db.prepare(`INSERT INTO wallet_holdings (player_id, network, token, symbol, name, decimals, amount, usd_price, usd_value, hidden) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(player.id, r.network, r.token, r.symbol, r.name, r.decimals, r.amount, r.usdPrice, r.usdValue, r.hidden)),
    db.prepare("UPDATE players SET holdings_usd = ?, holdings_updated_at = datetime('now') WHERE id = ?").bind(Math.round(total * 100) / 100, player.id),
  ]);
  return { count: rows.length, totalUsd: total };
}
