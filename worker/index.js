// Isolated, fake-money staging only. Does not import the Node database/server.
import {
  generateServerSeed, generateClientSeed, hashServerSeed, deriveOutcome,
} from '../backend/src/core/fairness.js';
import {
  POCKET_COUNT, pocketColor, payoutCentsFor, validateBet,
} from '../backend/src/games/roulette.js';
import { mathOption, STANDARD } from '../backend/src/games/rouletteMath.js';
import { maxPayoutCents } from '../backend/src/games/roulette.js';
import { checkRoundLimits, checkSlotLimits, slotLimitMessage } from './limits.js';
import { playRound, maxPayoutUnits as slotMaxPayout } from '../backend/src/games/slots.js';
import { SLOT_MATH } from '../backend/src/games/slotsMath.js';
import { makeUint32At } from '../backend/src/core/slotDraws.js';
import { isTronAddress, paymentSettings, providerReady, createProviderPayment, verifyIpn, mapProviderStatus } from './payments.js';
import { firstTouch, resolvePlayer, createGuestPlayer, touchPlayer, requestMeta, recordEvent, loadGameConfig, publicConfig, triggerMessages, inbox, markInbox } from './platform.js';
import {
  WalletError, rateLimit, issueNonce, verifySiwe, contractVerifier, upsertWalletPlayer, createWalletSession, walletCookie, walletToken,
  resolveWalletPlayer, revokeWalletSession, profile, saveEmail, readFloat, freeFloatFrom, liveFloat, liveFloatCached, publicReserve, reserveSpinExposure, releaseSpinExposure, HOLD_KEEP_MS, checkDepositTx, chainTick, requestWithdrawal, refreshHoldings, withdrawalFee,
} from './wallet.js';
import { ticsSettings, rpcClient, rpcUrl, formatTics } from './tics.js';
import { pageFor, withPageHead, NOT_FOUND_HTML } from './seo.js';

const COOKIE = '__Host-casino_demo';
const MAX_BODY_BYTES = 32768;
const MAX_BETS = 100;
const MAX_BET_CENTS = 1_000_000_000;
const SPIN_BURST = 10;
const SPIN_RATE_PER_S = 5;
// New play-money balance: 100,000 demo TICS (units of 0.01 TICS). Admin setting demoStartUnits overrides it.
const DEMO_START_UNITS = 10_000_000;
const BET_TYPES = new Set([
  'straight', 'split', 'trio', 'street', 'corner', 'sixline',
  'red', 'black', 'odd', 'even', 'low', 'high',
  'dozen1', 'dozen2', 'dozen3', 'column1', 'column2', 'column3',
]);
const ROBOTS = 'noindex, nofollow, noarchive';
// Set by the platform Worker only; any copy sent by a browser is stripped.
const CONTEXT_HEADER = 'X-Platform-Context';
const INTERNAL_HEADER = 'X-Internal-Secret';
// Not exported: the Workers runtime only accepts handlers and classes as named exports of the entry module.
const WITHDRAW_WAIT_MESSAGE = 'Your latest top up is still being confirmed on Ethereum. You can withdraw about 15 minutes after it arrived.';
const STATUS_MESSAGES = {
  frozen: 'Your account is paused. Please contact support.',
  banned: 'This account has been closed.',
};

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function fail(status, message) { throw new ApiError(status, message); }
function json(value, status = 200) { return Response.json(value, { status }); }
// Content Security Policy for the game pages. Scripts only from this site; no eval, no inline script, no plugins, no framing. Wallet connections need
// HTTPS/WSS endpoints (WalletConnect relay, Reown, Coinbase, the wallet's own RPC), images from
// wallet logos, and the WalletConnect verify iframe.
const CSP = [
  "default-src 'self'",
  // Cloudflare Web Analytics is injected into the page by the zone, so its beacon script must be allowed;
  // Google Analytics loads gtag.js from Google Tag Manager (its setup lives in /ga.js, no inline script).
  "script-src 'self' https://static.cloudflareinsights.com https://www.googletagmanager.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://fonts.reown.com",
  // connect-src/img-src stay broad on purpose: wallet libraries reach relays, RPCs and logo hosts not known in advance.
  "connect-src 'self' https: wss:",
  "frame-src https://verify.walletconnect.org https://verify.walletconnect.com https://secure.walletconnect.org https://secure.walletconnect.com https://keys.coinbase.com",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
const HSTS = 'max-age=31536000; includeSubDomains';
// Plain words for the table limit: what these bets could pay, the most one spin can pay, and
// the biggest straight-up bet that allows.
export function tableLimitMessage(worst, maxWin, math = STANDARD) {
  const straight = Math.floor(maxWin / (math.multipliers?.straight || 36));
  return `The most you can bet on one number right now is ${formatTics(straight)}.`;
}
// Constant-time comparison for shared secrets.
function sameSecret(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string') return false;
  const a = new TextEncoder().encode(given), b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
}
function secured(response, api = true) {
  const headers = new Headers(response.headers);
  // API replies and non-page responses stay out of search; the player pages are indexable.
  if (api) headers.set('X-Robots-Tag', ROBOTS);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('Strict-Transport-Security', HSTS);
  if (!api && (headers.get('Content-Type') || '').includes('text/html')) headers.set('Content-Security-Policy', CSP);
  if (api) headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
function errorResponse(error) {
  const known = error instanceof ApiError || error instanceof WalletError;
  if (!known) console.error('Demo API failure', error);
  return json({ error: known ? error.message : 'internal error', ...(known && error.code ? { code: error.code } : {}) }, known ? error.status : 500);
}
function sessionToken(request) {
  const matches = (request.headers.get('Cookie') || '').split(';')
    .map((part) => part.trim()).filter((part) => part.startsWith(`${COOKIE}=`));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}
function checkOrigin(request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const origin = request.headers.get('Origin');
  if (origin !== null && origin !== new URL(request.url).origin) fail(403, 'cross-origin mutation denied');
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') fail(403, 'cross-site mutation denied');
}
async function bodyText(request) {
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) fail(413, 'request body too large');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) { await reader.cancel(); fail(413, 'request body too large'); }
    chunks.push(value);
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(combined);
}
function parseBody(text) {
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { fail(400, 'invalid JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'body must be a JSON object');
  return body;
}
function publicCommitment(row) {
  return { serverSeedHash: row.server_seed_hash, clientSeed: row.client_seed, nonce: row.nonce };
}
function expectedCommitment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.serverSeedHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.serverSeedHash)
    || typeof value.clientSeed !== 'string' || !value.clientSeed.trim() || value.clientSeed.length > 64
    || !Number.isSafeInteger(value.nonce) || value.nonce < 0) fail(400, 'invalid expectedCommitment');
  // Do not trim the observed base: matching the stored tuple must be exact.
  return { serverSeedHash: value.serverSeedHash, clientSeed: value.clientSeed, nonce: value.nonce };
}
function checkCommitment(expected, current) {
  if (expected.serverSeedHash !== current.server_seed_hash || expected.clientSeed !== current.client_seed || expected.nonce !== current.nonce) fail(409, 'stale or mismatched expectedCommitment');
}
function normalizedBets(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_BETS) fail(400, `bets must contain 1 to ${MAX_BETS} bets`);
  return value.map((bet) => {
    if (!bet || typeof bet !== 'object' || Array.isArray(bet) || typeof bet.type !== 'string' || !BET_TYPES.has(bet.type)) fail(400, 'invalid bet type');
    if (!Number.isSafeInteger(bet.amountCents) || bet.amountCents <= 0 || bet.amountCents > MAX_BET_CENTS) fail(400, 'amountCents must be a positive integer within demo limits');
    try { validateBet(bet); } catch (error) { fail(400, error.message); }
    // Drop arbitrary client fields instead of echoing/storing them.
    return { type: bet.type, ...(bet.value === undefined ? {} : { value: bet.value }), amountCents: bet.amountCents };
  });
}
function idempotencyKey(request, body) {
  const header = request.headers.get('Idempotency-Key');
  if (typeof body.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId)) fail(400, 'requestId must be a UUID');
  if (header !== null && header !== body.requestId) fail(400, 'conflicting idempotency keys');
  return body.requestId;
}
function canonicalInput(value) {
  if (Array.isArray(value)) return value.map(canonicalInput);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalInput(value[key])]));
  return value;
}

// Calls a player's wallet object on its private admin/payments routes.
async function walletCall(env, playerId, path, body) {
  if (!env.INTERNAL_SECRET) fail(500, 'payments not configured');
  const stub = env.CASINO.get(env.CASINO.idFromName(playerId));
  const res = await stub.fetch(new Request(`https://wallet/internal/${path}`, { method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', [INTERNAL_HEADER]: env.INTERNAL_SECRET }, body: body ? JSON.stringify(body) : undefined }));
  const data = await res.json();
  if (!res.ok) fail(res.status, data.error || 'wallet error');
  return data;
}

const usdText = (c) => `${(c / 100).toFixed(2)} USDT`;
async function playerPayments(request, env, url, player, text) {
  const db = env.DB, settings = await paymentSettings(db);
  const path = url.pathname, method = request.method;
  if (path === '/api/payments' && method === 'GET') {
    const [wallet, deposits, withdrawals] = await Promise.all([
      walletCall(env, player.id, 'wallet'),
      db.prepare('SELECT id, status, requested_cents, credited_cents, pay_currency, pay_address, pay_amount, created_at FROM deposits WHERE player_id = ? ORDER BY created_at DESC LIMIT 20').bind(player.id).all(),
      db.prepare('SELECT id, status, amount_cents, fee_cents, address, tx_hash, reason, created_at FROM withdrawals WHERE player_id = ? ORDER BY created_at DESC LIMIT 20').bind(player.id).all(),
    ]);
    return { realBalanceCents: wallet.realBalanceCents, network: settings.network, depositsOpen: settings.depositsOpen && providerReady(env), withdrawalsOpen: settings.withdrawalsOpen,
      limits: { minDepositCents: settings.minDepositCents, minWithdrawalCents: settings.minWithdrawalCents, maxWithdrawalCents: settings.maxWithdrawalCents, withdrawalFeeCents: settings.withdrawalFeeCents },
      deposits: deposits.results, withdrawals: withdrawals.results };
  }
  if (method !== 'POST') fail(404, 'demo endpoint not found');
  if (player.status !== 'active') fail(403, STATUS_MESSAGES[player.status] || 'account unavailable');
  const body = parseBody(text);
  if (path === '/api/payments/deposit') {
    if (!settings.depositsOpen || !providerReady(env)) fail(503, 'Deposits are not open yet.');
    if (!Number.isSafeInteger(body.amountCents) || body.amountCents < settings.minDepositCents || body.amountCents > MAX_BET_CENTS) fail(400, `The smallest deposit is ${usdText(settings.minDepositCents)}.`);
    const depositId = crypto.randomUUID();
    const p = await createProviderPayment(env, { depositId, amountCents: body.amountCents, payCurrency: settings.payCurrency, callbackUrl: `${url.origin}/api/payments/webhook/nowpayments` });
    await db.prepare(`INSERT INTO deposits (id, player_id, provider, provider_ref, status, network, pay_currency, pay_address, pay_amount, requested_cents) VALUES (?, ?, ?, ?, 'waiting', ?, ?, ?, ?, ?)`)
      .bind(depositId, player.id, settings.provider, p.providerRef, settings.network, settings.payCurrency, p.payAddress, p.payAmount, body.amountCents).run();
    return { depositId, payAddress: p.payAddress, payAmount: p.payAmount, payCurrency: settings.payCurrency, network: settings.network };
  }
  if (path === '/api/payments/withdraw') {
    if (!settings.withdrawalsOpen) fail(503, 'Withdrawals are not open yet.');
    const amount = body.amountCents;
    if (!Number.isSafeInteger(amount) || amount < settings.minWithdrawalCents) fail(400, `The smallest withdrawal is ${usdText(settings.minWithdrawalCents)}.`);
    if (amount > settings.maxWithdrawalCents) fail(400, `The largest single withdrawal is ${usdText(settings.maxWithdrawalCents)}.`);
    if (amount <= settings.withdrawalFeeCents) fail(400, 'The amount must be more than the network fee.');
    const address = typeof body.address === 'string' ? body.address.trim() : '';
    if (!(await isTronAddress(address))) fail(400, 'That is not a valid Tron (TRC-20) address. It starts with T and has 34 characters.');
    const today = await db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS n FROM withdrawals WHERE player_id = ? AND status != 'rejected' AND status != 'failed' AND created_at >= datetime('now','-1 day')`).bind(player.id).first();
    if (today.n + amount > settings.dailyWithdrawalLimitCents) fail(400, `The daily withdrawal limit is ${usdText(settings.dailyWithdrawalLimitCents)}.`);
    const withdrawalId = crypto.randomUUID();
    // Hold the money first so it cannot be bet or withdrawn twice; release it if recording fails.
    const held = await walletCall(env, player.id, 'withdraw-hold', { ref: `wd:${withdrawalId}`, amountCents: amount });
    try {
      await db.prepare(`INSERT INTO withdrawals (id, player_id, amount_cents, fee_cents, network, currency, address, status) VALUES (?, ?, ?, ?, ?, 'USDT', ?, 'requested')`)
        .bind(withdrawalId, player.id, amount, settings.withdrawalFeeCents, settings.network, address).run();
    } catch (error) {
      await walletCall(env, player.id, 'withdraw-release', { ref: `wdr:${withdrawalId}`, amountCents: amount, reason: 'could not record the request' });
      throw error;
    }
    return { withdrawalId, status: 'requested', realBalanceCents: held.realBalanceCents, sendCents: amount - settings.withdrawalFeeCents };
  }
  fail(404, 'demo endpoint not found');
}

// Provider callback: verified by signature, idempotent, credits only finished payments.
async function paymentWebhook(request, env) {
  const text = await bodyText(request);
  if (!env.NOWPAYMENTS_IPN_SECRET) return json({ error: 'payments not configured' }, 503);
  const body = await verifyIpn(env.NOWPAYMENTS_IPN_SECRET, text, request.headers.get('x-nowpayments-sig'));
  if (!body) return json({ error: 'bad signature' }, 401);
  const deposit = await env.DB.prepare('SELECT * FROM deposits WHERE id = ?').bind(String(body.order_id || '')).first();
  if (!deposit || (deposit.provider_ref && String(body.payment_id) !== deposit.provider_ref)) return json({ error: 'unknown payment' }, 404);
  const status = mapProviderStatus(body.payment_status);
  if (!status) return json({ ok: true, ignored: true });
  if (status === 'finished' && !deposit.credited_cents) {
    // Credit what the player asked to deposit (the provider fixed the rate when the payment was created).
    await walletCall(env, deposit.player_id, 'deposit', { ref: `dep:${deposit.id}`, amountCents: deposit.requested_cents });
    await env.DB.prepare(`UPDATE deposits SET status = 'finished', credited_cents = ?, actually_paid = ?, tx_hash = ?, credited_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
      .bind(deposit.requested_cents, String(body.actually_paid ?? ''), body.payin_hash || null, deposit.id).run();
    const player = await env.DB.prepare('SELECT * FROM players WHERE id = ?').bind(deposit.player_id).first();
    await recordEvent(env.DB, 'deposit', { player, valueCents: deposit.requested_cents }).catch(() => {});
  } else if (deposit.status !== 'finished') {
    await env.DB.prepare("UPDATE deposits SET status = ?, actually_paid = ?, updated_at = datetime('now') WHERE id = ?").bind(status, String(body.actually_paid ?? ''), deposit.id).run();
  }
  return json({ ok: true });
}

// Wallet (Sign-In with Ethereum) and $TICS routes handled by the platform Worker itself.
async function walletRoutes(request, env, ctx, url, meta, text, walletPlayer) {
  const path = url.pathname, method = request.method, db = env.DB;
  const settings = await ticsSettings(db);
  if (path === '/api/wallet/nonce' && method === 'POST') {
    await rateLimit(db, 'nonce', meta.ipHash);
    return json({ nonce: await issueNonce(db), chainId: settings.chainId, domain: url.host, uri: url.origin, statement: 'Sign in to qu-BETICS. This does not cost anything or move any funds.' });
  }
  if (path === '/api/wallet/verify' && method === 'POST') {
    await rateLimit(db, 'verify', meta.ipHash);
    const body = parseBody(text);
    const address = await verifySiwe(db, env, body, { host: url.host, chainId: settings.chainId, verifyContract: contractVerifier(env, settings.chainId) });
    const player = await upsertWalletPlayer(db, address, meta, firstTouch(body));
    const token = await createWalletSession(db, address);
    await recordEvent(db, 'wallet_connect', { player, meta, gameId: 'roulette' }).catch(() => {});
    ctx?.waitUntil?.(refreshHoldings(env, player).catch((e) => console.error('holdings refresh failed', e)));
    const response = json({ ok: true, profile: await profile(db, player, settings) });
    response.headers.append('Set-Cookie', walletCookie(token));
    return response;
  }
  if (path === '/api/wallet/logout' && method === 'POST') {
    await revokeWalletSession(db, walletToken(request));
    const response = json({ ok: true });
    response.headers.append('Set-Cookie', walletCookie(null));
    return response;
  }
  if (!walletPlayer) fail(401, 'Connect your wallet first.');
  if (path === '/api/wallet/me' && method === 'GET') return json(await profile(db, walletPlayer, settings));
  if (walletPlayer.status !== 'active') fail(403, STATUS_MESSAGES[walletPlayer.status] || 'account unavailable');
  if (path === '/api/wallet/profile' && method === 'POST') { await rateLimit(db, 'profile', meta.ipHash); return json(await saveEmail(db, walletPlayer, parseBody(text))); }
  if (path === '/api/wallet/terms' && method === 'POST') {
    await db.prepare("UPDATE players SET terms_accepted_at = COALESCE(terms_accepted_at, datetime('now')) WHERE id = ?").bind(walletPlayer.id).run();
    return json({ ok: true });
  }
  if (path === '/api/wallet/deposit/check' && method === 'POST') {
    await rateLimit(db, 'check', meta.ipHash);
    if (!settings.casinoWallet || !rpcUrl(env, settings.chainId)) fail(503, 'Deposits are not open right now.');
    const body = parseBody(text);
    return json(await checkDepositTx(env, settings, rpcClient(rpcUrl(env, settings.chainId), fetch, { fallbackUrl: env.ETH_RPC_URL_2 || null }), typeof body.txHash === 'string' ? body.txHash.toLowerCase() : ''));
  }
  if (path === '/api/wallet/withdraw/quote' && method === 'GET') {
    const q = await withdrawalFee(db, settings);
    return json({ feeCents: q.feeCents, feesEnabled: settings.feesEnabled !== false, minWithdrawalCents: settings.minWithdrawalUnits });
  }
  if (path === '/api/wallet/withdraw' && method === 'POST') {
    await rateLimit(db, 'withdraw', meta.ipHash);
    const result = await requestWithdrawal(env, walletPlayer, parseBody(text), settings);
    if (env.PAYOUTS && result.status === 'queued' && settings.coolingSeconds === 0) {
      ctx?.waitUntil?.(env.PAYOUTS.fetch('https://payouts/process', { method: 'POST', headers: { [INTERNAL_HEADER]: env.INTERNAL_SECRET || '' } }).catch(() => {}));
    }
    return json(result);
  }
  fail(404, 'demo endpoint not found');
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(chainTick(env).catch((e) => console.error('chain tick failed:', String(e?.message || e), e?.stack || '')));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Plain http is never served: send it to https first (local development hosts excepted).
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (!local && (url.protocol === 'http:' || (request.headers.get('X-Forwarded-Proto') || '').toLowerCase() === 'http')) {
      url.protocol = 'https:';
      if (url.hostname === 'betics.io') url.hostname = 'www.betics.io';
      return Response.redirect(url.toString(), 301);
    }
    // Canonical host is www.betics.io; redirect the bare apex domain there,
    // preserving path and query. The workers.dev address is switched off
    // in wrangler.toml (workers_dev = false), so only the custom domains serve the game.
    if (url.hostname === 'betics.io') {
      url.hostname = 'www.betics.io';
      return Response.redirect(url.toString(), 301);
    }
    const api = url.pathname === '/api' || url.pathname.startsWith('/api/');
    try {
      if (!api) {
        // Player pages get their own head tags, so the stored file's ETag no longer describes the reply:
        // drop conditional headers for them so the asset store always returns the full file.
        let assetRequest = request;
        if (pageFor(url.pathname) && (request.headers.has('If-None-Match') || request.headers.has('If-Modified-Since'))) {
          const headers = new Headers(request.headers);
          headers.delete('If-None-Match');
          headers.delete('If-Modified-Since');
          assetRequest = new Request(request.url, { method: request.method, headers });
        }
        const asset = await env.ASSETS.fetch(assetRequest);
        // A missing build file must be a 404, not the app page (which would be cached for a year as a script).
        if (url.pathname.startsWith('/assets/') && (asset.headers.get('Content-Type') || '').includes('text/html')) {
          return secured(new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } }), false);
        }
        if ((asset.headers.get('Content-Type') || '').includes('text/html')) {
          // The app fallback answers every unknown path with index.html. Only the three player pages are pages;
          // anything else is a real 404, so search engines never index made-up addresses as copies of the game.
          const page = pageFor(url.pathname);
          if (!page || asset.status !== 200) {
            const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': ROBOTS };
            return secured(new Response(request.method === 'HEAD' ? null : NOT_FOUND_HTML, { status: 404, headers }), false);
          }
          const headers = new Headers(asset.headers);
          headers.delete('Content-Length');
          headers.delete('ETag');
          if (page.noindex) headers.set('X-Robots-Tag', ROBOTS);
          const body = request.method === 'HEAD' ? null : withPageHead(await asset.text(), page);
          return secured(new Response(body, { status: 200, headers }), false);
        }
        return secured(asset, false);
      }
      checkOrigin(request);
      if (url.pathname === '/api/demo/reset-balance' && env.STAGING !== 'true') fail(404, 'demo endpoint not found');
      // Liveness only (prelaunch audit P3): the Worker answers. It says nothing about the operating mode or about
      // whether money can move; /api/ready does that from the live settings and data.
      if (url.pathname === '/api/health' && request.method === 'GET') {
        return secured(json({ ok: true, live: true, storage: 'durable-object-sqlite' }));
      }
      if (url.pathname === '/api/ready' && request.method === 'GET') {
        const checks = { database: false, mode: 'unknown', reserveFresh: null, staleBookings: null };
        try {
          await env.DB.prepare('SELECT 1 AS ok').first();
          checks.database = true;
          const settings = await ticsSettings(env.DB);
          checks.mode = settings.realEnabled ? 'real' : 'demo';
          const floatRow = await env.DB.prepare("SELECT value FROM chain_state WHERE key = 'float'").first(); // uncached: a readiness answer must be current
          const float = floatRow ? JSON.parse(floatRow.value) : null;
          checks.reserveFresh = !!float && Date.now() - float.at <= 10 * 60_000;
          checks.staleBookings = (await env.DB.prepare('SELECT COUNT(*) AS n FROM spin_holds WHERE booked_at IS NOT NULL AND booked_at < ?').bind(Date.now() - 10 * 60_000).first())?.n ?? 0;
        } catch (error) { console.error('readiness check failed', error?.message || error); }
        // Demo play needs only the database. Real play also needs a fresh casino wallet reading and no
        // booking waiting for its balance copy for more than ten minutes.
        const ok = checks.database && (checks.mode === 'demo' || (checks.reserveFresh === true && checks.staleBookings === 0));
        return secured(json({ ok, ...checks }, ok ? 200 : 503));
      }
      if (url.pathname === '/api/casino/reserve' && request.method === 'GET') {
        // Public: what the casino wallet holds on-chain, whether it covers every player balance, and the most one spin can win.
        const cfg = await loadGameConfig(env.DB, 'roulette');
        const straight = (cfg ? mathOption(cfg.mathId) : STANDARD).multipliers.straight;
        const r = secured(json(await publicReserve(env.DB, await ticsSettings(env.DB), straight)));
        r.headers.set('Cache-Control', 'public, max-age=20');
        return r;
      }
      if (url.pathname === '/api/payments/status' && request.method === 'GET') {
        const settings = await paymentSettings(env.DB);
        return secured(json({ provider: settings.provider, network: settings.network, configured: providerReady(env), depositsOpen: settings.depositsOpen && providerReady(env), withdrawalsOpen: settings.withdrawalsOpen }));
      }
      // Legacy USDT payments (NOWPayments) are retired: $TICS is the only way in and out. Kept behind an
      // explicit flag for its tests; the old webhook also credits the requested amount, not what was paid.
      if (url.pathname.startsWith('/api/payments') && env.LEGACY_PAYMENTS !== '1') return secured(json({ error: 'not found' }, 404));
      if (url.pathname === '/api/payments/webhook/nowpayments' && request.method === 'POST') return secured(await paymentWebhook(request, env));
      const isSession = url.pathname === '/api/session' && request.method === 'POST';
      const isWalletRoute = /^\/api\/wallet\/(?:nonce|verify|logout|me|profile|terms|deposit\/check|withdraw|withdraw\/quote)$/.test(url.pathname);
      let token = sessionToken(request);
      // Bound the incoming stream before any database or Durable Object work.
      const text = ['GET', 'HEAD'].includes(request.method) ? undefined : await bodyText(request);
      if (!env.DB) fail(500, 'platform database not configured');
      const meta = await requestMeta(request, env);
      const walletPlayer = await resolveWalletPlayer(env.DB, walletToken(request));
      if (isWalletRoute) return secured(await walletRoutes(request, env, ctx, url, meta, text, walletPlayer));
      if (!token && !isSession && !walletPlayer) fail(401, 'demo session required');
      let player = walletPlayer || await resolvePlayer(env.DB, token);
      let created = false;
      if (!player) {
        if (!isSession) fail(401, 'demo session required');
        // New guests per IP and minute are limited, so nobody can flood the database with players.
        await rateLimit(env.DB, 'session', meta.ipHash);
        // Unknown or missing cookie: always a brand-new opaque token, never a client-chosen one.
        token = generateServerSeed();
        let touch = { referrer: null, campaign: null };
        try { touch = firstTouch(JSON.parse(text || '{}')); } catch { /* the DO answers a bad body */ }
        player = await createGuestPlayer(env.DB, token, meta, touch);
        created = true;
      }
      if (isSession) {
        await touchPlayer(env.DB, player, meta);
        await recordEvent(env.DB, created ? 'first_visit' : 'visit', { player, meta, gameId: 'roulette' }).catch(() => {});
        if (created) await triggerMessages(env.DB, player, 'first_visit').catch((e) => console.error('trigger failed', e));
      }
      if (url.pathname === '/api/inbox' && request.method === 'GET') return secured(json(await inbox(env.DB, player)));
      const inboxAction = url.pathname.match(/^\/api\/inbox\/(\d{1,12})\/(seen|click|dismiss)$/);
      if (inboxAction && request.method === 'POST') {
        const ok = await markInbox(env.DB, player, Number(inboxAction[1]), inboxAction[2]);
        if (!ok) fail(404, 'message not found');
        if (inboxAction[2] !== 'dismiss') await recordEvent(env.DB, inboxAction[2] === 'seen' ? 'message_seen' : 'message_click', { player, meta, extra: { messageId: Number(inboxAction[1]) } }).catch(() => {});
        return secured(json({ ok: true }));
      }
      const configRoute = url.pathname.match(/^\/api\/games\/(roulette|godsofpower)\/config$/);
      if (configRoute && request.method === 'GET') {
        const config = await loadGameConfig(env.DB, configRoute[1]);
        if (!config) fail(404, 'game not found');
        return secured(json(publicConfig(config)));
      }
      if (url.pathname === '/api/events' && request.method === 'POST') {
        await rateLimit(env.DB, 'events', player.id);
        const body = parseBody(text);
        const type = typeof body.type === 'string' && /^[a-z_]{2,32}$/.test(body.type) ? body.type : fail(400, 'invalid event type');
        if (!['screen', 'game_open', 'session_end', 'fairness_fail', 'round_error'].includes(type)) fail(400, 'invalid event type');
        const screen = typeof body.screen === 'string' && /^\d{2,5}x\d{2,5}$/.test(body.screen) ? body.screen : null;
        const extra = body.seconds ? { seconds: Math.min(86400, Number(body.seconds) || 0) } : typeof body.detail === 'string' ? { detail: body.detail.slice(0, 300) } : null;
        const eventGame = body.game === 'godsofpower' ? 'godsofpower' : 'roulette';
        await recordEvent(env.DB, type, { player, meta, gameId: eventGame, screen, extra });
        return secured(json({ ok: true }));
      }
      if (url.pathname.startsWith('/api/payments')) return secured(json(await playerPayments(request, env, url, player, text)));
      const spinRoute = request.method === 'POST' ? url.pathname.match(/^\/api\/games\/(roulette|godsofpower)\/spin$/) : null;
      const isSpin = !!spinRoute;
      const spinGame = spinRoute ? spinRoute[1] : 'roulette';
      let holdId = null;
      if (player.status !== 'active' && !isSession && request.method !== 'GET') fail(403, STATUS_MESSAGES[player.status] || 'account unavailable');
      const ticsCfg = await ticsSettings(env.DB);
      const gameConfig = await loadGameConfig(env.DB, spinGame);
      if (isSpin && !gameConfig) fail(404, 'game not found');
      const context = { playerId: player.id, country: meta.country, device: meta.device, walletPlayer: !!walletPlayer,
        realEnabled: !!ticsCfg.realEnabled && !!ticsCfg.casinoWallet, demoStartUnits: ticsCfg.demoStartUnits, minStakeCents: gameConfig ? gameConfig.minStakeCents : 1 };
      if (isSpin) {
        context.config = gameConfig;
        // The most one spin may pay (total return): a share of the free float (casino wallet minus what
        // players are owed right now minus real spins in progress). Demo follows the same table limit.
        let spinBody = {};
        try { spinBody = JSON.parse(text || '{}') || {}; } catch { spinBody = {}; }
        // Demo spins use a reading shared for a few seconds; real spins always read it fresh.
        const live = spinBody.mode === 'real' && walletPlayer ? await liveFloat(env.DB, ticsCfg) : await liveFloatCached(env.DB, ticsCfg);
        context.maxWinCents = live ? live.maxWinUnits : null;
        context.freeFloatCents = walletPlayer && live && spinBody.mode === 'real' ? live.maxWinUnits : 0;
        // Real spin: book its worst net win atomically before it runs, so any number of players
        // spinning at once can never be owed more than the wallet holds.
        if (spinBody.mode === 'real' && walletPlayer && live) {
          let worst = null, stake = 0;
          if (spinGame === 'godsofpower') {
            // A slot round's worst case is its cap (the round stops there), so the booking is cap minus stake.
            if (Number.isSafeInteger(spinBody.stake) && spinBody.stake > 0) { stake = spinBody.stake; worst = slotMaxPayout(stake, SLOT_MATH); }
          } else {
            let bets = null;
            try { bets = normalizedBets(spinBody.bets); } catch { bets = null; } // the Durable Object reports the exact error
            if (bets) {
              const math = gameConfig ? mathOption(gameConfig.mathId) : STANDARD;
              worst = maxPayoutCents(bets, math); stake = bets.reduce((t, b) => t + b.amountCents, 0);
            }
          }
          if (worst !== null) {
            if (worst <= live.maxWinUnits) {
              holdId = `${player.id}:${typeof spinBody.requestId === 'string' ? spinBody.requestId.slice(0, 40) : ''}:${crypto.randomUUID()}`;
              const booked = await reserveSpinExposure(env.DB, { id: holdId, playerId: player.id, units: Math.max(0, worst - stake) });
              // No room: the wallet may still answer a replay of a spin it already made (lost reply), but
              // refuses a new one with the same message.
              if (!booked) { holdId = null; context.replayOnly = true; }
              else context.holdId = holdId; // the wallet records it with the spin, and its central copy releases it
            }
          }
        }
      }
      const headers = new Headers(request.headers);
      headers.delete(INTERNAL_HEADER);
      headers.set(CONTEXT_HEADER, JSON.stringify(context));
      const forwarded = new Request(request.url, { method: request.method, headers, body: text });
      const stub = env.CASINO.get(env.CASINO.idFromName(player.id));
      let response;
      try { response = secured(await stub.fetch(forwarded)); }
      finally {
        // Free the booking only on a positive answer from the player's wallet (prelaunch audit P2): either
        // the settled balance is in the central copy, or the spin was refused before anything was committed.
        // Anything else (a 500 from an unexpected error, a copy that is still pending, no reply at all: the
        // spin may have settled) keeps the booking counted: the wallet's next central copy deletes it, or the
        // cron asks the wallet about it (sweepSpinHolds). It never just runs out, and it is never released by
        // default.
        if (holdId && response && response.headers.get('X-Hold') === 'release') await releaseSpinExposure(env.DB, holdId);
        response?.headers.delete('X-Hold'); // internal signal only
      }
      if (walletPlayer) {
        // Wallet sessions never set or need the guest cookie.
      } else if (isSession && response.ok) {
        // Always Secure, including HTTP local tests (tests send Cookie manually).
        response.headers.set('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax`);
      } else if (created) {
        // A failed session request never establishes a browser session.
        response.headers.delete('Set-Cookie');
      }
      return response;
    } catch (error) { return secured(errorResponse(error)); }
  },
};

// SQLite-backed Durable Object. All money/round/seed writes are synchronous
// inside storage.transactionSync; no await may be introduced in those blocks.
export class DemoCasino {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY CHECK (id = 1), username TEXT NOT NULL,
        balance_cents INTEGER NOT NULL CHECK (balance_cents >= 0 AND balance_cents <= 9007199254740991),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL CHECK (user_id = 1),
        type TEXT NOT NULL, amount_cents INTEGER NOT NULL,
        balance_after_cents INTEGER NOT NULL CHECK (balance_after_cents >= 0),
        round_id INTEGER, meta TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS fairness_commitments (
        user_id INTEGER PRIMARY KEY CHECK (user_id = 1), server_seed TEXT NOT NULL,
        server_seed_hash TEXT NOT NULL, client_seed TEXT NOT NULL, nonce INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS rounds (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL CHECK (user_id = 1),
        game TEXT NOT NULL, stake_cents INTEGER NOT NULL CHECK (stake_cents > 0),
        status TEXT NOT NULL DEFAULT 'reserved', bet_json TEXT NOT NULL, outcome_json TEXT,
        payout_cents INTEGER, server_seed TEXT NOT NULL, server_seed_hash TEXT NOT NULL,
        client_seed TEXT NOT NULL, nonce INTEGER NOT NULL, revealed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS idempotency (
        request_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS entropy_used (
        client_entropy TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    // Spin bookings (D1 spin_holds) this wallet knows: 'pending' = the spin settled here, its balance is not in
    // the central copy yet; 'flushed' = it is; 'void' = asked about before the spin ever ran, so it never will.
    // Credited top ups whose block Ethereum has not finalized yet (final = 0): played freely, never withdrawn.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tics_finality (ref TEXT PRIMARY KEY, units INTEGER NOT NULL DEFAULT 0, final INTEGER NOT NULL DEFAULT 0 CHECK (final IN (0, 1)))`);
    if (!this.sql.exec('PRAGMA table_info(tics_finality)').toArray().some((c) => c.name === 'credited_at')) {
      this.sql.exec('ALTER TABLE tics_finality ADD COLUMN credited_at TEXT');
      this.sql.exec("UPDATE tics_finality SET credited_at = datetime('now') WHERE credited_at IS NULL");
    }
    // Each reversal of a vanished top up and what it took back (returned again on a retry).
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tics_reversals (ref TEXT PRIMARY KEY, reversed_cents INTEGER NOT NULL, short_cents INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS spin_hold_marks (hold_id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK (state IN ('pending', 'flushed', 'void')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    // Real money is a separate balance; play money stays in users.balance_cents.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS real_wallet (id INTEGER PRIMARY KEY CHECK (id = 1), balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0));
      CREATE TABLE IF NOT EXISTS processed_payments (ref TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now')));`);
    if (!this.sql.exec('PRAGMA table_info(ledger)').toArray().some((c) => c.name === 'real_money')) this.sql.exec('ALTER TABLE ledger ADD COLUMN real_money INTEGER NOT NULL DEFAULT 0');
    // $TICS real balance (units of 0.01 TICS) and withdrawal holds. Ledger rows
    // carry their own currency; NULL means the object's legacy currency.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS real_tics (id INTEGER PRIMARY KEY CHECK (id = 1), balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0));
      CREATE TABLE IF NOT EXISTS holds (ref TEXT PRIMARY KEY, units INTEGER NOT NULL CHECK (units > 0), status TEXT NOT NULL CHECK (status IN ('held', 'done', 'released')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));`);
    if (!this.sql.exec('PRAGMA table_info(ledger)').toArray().some((c) => c.name === 'currency')) this.sql.exec('ALTER TABLE ledger ADD COLUMN currency TEXT');
    // Existing Durable Objects keep all old rows; legacy receipts stay null.
    const columns = new Set(this.sql.exec('PRAGMA table_info(rounds)').toArray().map((column) => column.name));
    for (const [name, type] of [['receipt_json', 'TEXT'], ['game_id', "TEXT NOT NULL DEFAULT 'roulette'"], ['math_id', "TEXT NOT NULL DEFAULT 'standard'"],
      ['config_version', 'INTEGER NOT NULL DEFAULT 0'], ['currency', "TEXT NOT NULL DEFAULT 'USDT'"], ['real_money', 'INTEGER NOT NULL DEFAULT 0'],
      ['country', 'TEXT'], ['device', 'TEXT']]) {
      if (!columns.has(name)) this.sql.exec(`ALTER TABLE rounds ADD COLUMN ${name} ${type}`);
    }
  }
  getMeta(key) { const row = this.one('SELECT value FROM meta WHERE key = ?', key); return row ? row.value : null; }
  setMeta(key, value) { this.sql.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value)); }
  // Copies new ledger entries and settled rounds to the central database.
  // Watermarks only move after D1 accepts the batch, so nothing is lost; a
  // failure schedules a retry alarm. INSERT OR IGNORE makes replays harmless.
  // One central copy at a time: two overlapping copies could land out of order and leave an older balance in D1.
  flush() {
    // A hung D1 call must not hold every later spin of this player: give up waiting after 15 s
    // (the copy then counts as not done, so spin bookings are kept until they expire).
    // It never rejects (prelaunch audit P2): any failure counts as 'not copied', so callers keep their bookings.
    const once = () => Promise.race([this.flushOnce().catch((error) => { console.error('central copy crashed', error); return false; }), new Promise((r) => setTimeout(() => r(false), 15_000))]);
    const run = (this.flushChain || Promise.resolve()).then(once, once);
    this.flushChain = run.catch(() => {});
    return run;
  }
  async flushOnce() {
    const db = this.env.DB, playerId = this.getMeta('player_id');
    if (!db || !playerId || !this.user()) return;
    const seq = Date.now() * 1000 + (this.flushCounter = ((this.flushCounter || 0) + 1) % 1000);
    try {
      for (let pass = 0; pass < 10; pass++) {
        const ledgerMark = Number(this.getMeta('ledger_mark') || 0), roundMark = Number(this.getMeta('round_mark') || 0);
        const ledger = this.sql.exec('SELECT * FROM ledger WHERE id > ? ORDER BY id LIMIT 100', ledgerMark).toArray();
        const rounds = this.sql.exec("SELECT * FROM rounds WHERE id > ? AND status = 'settled' ORDER BY id LIMIT 100", roundMark).toArray();
        // Bookings of spins already settled here. Read in the same synchronous step as the balance below,
        // so the batch that writes this balance also deletes exactly their bookings (D1 runs a batch as one
        // transaction): a possible win stops being counted only when the win itself is counted.
        const holds = this.sql.exec("SELECT hold_id FROM spin_hold_marks WHERE state = 'pending' LIMIT 50").toArray().map((r) => r.hold_id);
        if (!ledger.length && !rounds.length && !holds.length && pass > 0) break;
        const currency = this.getMeta('currency') || 'USDT';
        const totals = this.one("SELECT COUNT(*) AS n, COALESCE(SUM(stake_cents),0) AS bet, COALESCE(SUM(payout_cents),0) AS paid FROM rounds WHERE status = 'settled'");
        const statements = [
          ...ledger.map((row) => db.prepare(`INSERT OR IGNORE INTO ledger (id, player_id, type, amount_cents, balance_after_cents, round_id, meta, currency, real_money, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(`${playerId}:${row.id}`, playerId, row.type, row.amount_cents, row.balance_after_cents,
            row.round_id == null ? null : `${playerId}:${row.round_id}`, row.meta, row.currency || currency, row.real_money ? 1 : 0, row.created_at)), // as stored: demo rows stay demo
          ...rounds.map((row) => {
            const outcome = JSON.parse(row.outcome_json || '{}');
            return db.prepare(`INSERT OR IGNORE INTO rounds (id, player_id, game_id, math_id, config_version, stake_cents, payout_cents, outcome, bets_json, fairness_json, currency, real_money, country, device, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(`${playerId}:${row.id}`, playerId, row.game_id, row.math_id, row.config_version,
              row.stake_cents, row.payout_cents, JSON.stringify({ pocket: outcome.pocket, color: outcome.color }), row.bet_json,
              JSON.stringify({ serverSeed: row.server_seed, serverSeedHash: row.server_seed_hash, clientSeed: row.client_seed, nonce: row.nonce }),
              row.currency, row.real_money, row.country, row.device, row.created_at);
          }),
          // Each copy carries a rising number; an older copy that lands late (after a timeout) never overwrites a newer one.
          db.prepare('UPDATE players SET balance_cents = ?, real_balance_cents = ?, real_tics_cents = ?, total_bet_cents = ?, total_paid_cents = ?, rounds = ?, flush_seq = ? WHERE id = ? AND flush_seq < ?')
            .bind(this.user().balance_cents, this.realBalance(), this.ticsBalance(), totals.bet, totals.paid, totals.n, seq, playerId, seq),
          ...(holds.length ? [db.prepare(`DELETE FROM spin_holds WHERE id IN (${holds.map(() => '?').join(', ')})`).bind(...holds)] : []),
        ];
        await db.batch(statements);
        if (holds.length) this.sql.exec(`UPDATE spin_hold_marks SET state = 'flushed' WHERE state = 'pending' AND hold_id IN (${holds.map(() => '?').join(', ')})`, ...holds);
        if (ledger.length) this.setMeta('ledger_mark', ledger.at(-1).id);
        if (rounds.length) this.setMeta('round_mark', rounds.at(-1).id);
        if (ledger.length < 100 && rounds.length < 100 && holds.length < 50) break;
      }
      return true;
    } catch (error) {
      console.error('central copy failed, retrying', error);
      // Its own guard (prelaunch audit P2): a failing alarm must not turn 'copy pending' into an exception.
      try { await this.ctx.storage.setAlarm(Date.now() + 30_000); } catch (alarmError) { console.error('retry alarm could not be set', alarmError); }
      return false;
    }
  }
  async alarm() { this.pruneOld(true); await this.flush(); }
  // Replay protection only matters for minutes (every spin uses a new lock), so entries older than a day
  // are removed. At most once an hour, so it costs nothing on normal spins.
  pruneOld(force = false) {
    const now = this.now();
    if (!force && now - Number(this.getMeta('pruned_at') || 0) < 3600_000) return;
    this.sql.exec("DELETE FROM idempotency WHERE created_at < datetime('now', '-1 day')");
    this.sql.exec("DELETE FROM entropy_used WHERE created_at < datetime('now', '-1 day')");
    this.sql.exec("DELETE FROM spin_hold_marks WHERE state != 'pending' AND created_at < datetime('now', '-1 day')");
    this.setMeta('pruned_at', now);
  }
  now() { return Date.now(); }
  // Spins per player: a burst of 10, then 5 a second. A refused spin changes nothing (no lock used).
  takeSpinToken() {
    const now = this.now(), b = this.spinBucket || { tokens: SPIN_BURST, at: now };
    b.tokens = Math.min(SPIN_BURST, b.tokens + Math.max(0, now - b.at) * SPIN_RATE_PER_S / 1000);
    b.at = now;
    this.spinBucket = b;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
  realBalance() { const row = this.one('SELECT balance_cents FROM real_wallet WHERE id = 1'); return row ? row.balance_cents : 0; }
  ticsBalance() { const row = this.one('SELECT balance_cents FROM real_tics WHERE id = 1'); return row ? row.balance_cents : 0; }
  heldTics() { return this.one("SELECT COUNT(*) AS n, COALESCE(SUM(units),0) AS units FROM holds WHERE status = 'held'"); }
  // The real TICS balance must always equal the sum of its ledger rows.
  ticsLedgerSum() { return this.one("SELECT COALESCE(SUM(amount_cents),0) AS s FROM ledger WHERE real_money = 1 AND currency = 'TICS'").s; }
  ticsReconciled() { return this.ticsLedgerSum() === this.ticsBalance(); }
  // Demo is hidden while the player has real funds (at least the minimum bet) or a withdrawal is in progress.
  demoAllowed(minStakeCents = 1) { return this.ticsBalance() < Math.max(1, minStakeCents) && this.heldTics().n === 0; }
  setTics(next, type, delta, meta) {
    if (!Number.isSafeInteger(next) || next < 0) fail(402, 'not enough real balance');
    this.sql.exec('INSERT OR IGNORE INTO real_tics (id, balance_cents) VALUES (1, 0)');
    this.sql.exec('UPDATE real_tics SET balance_cents = ? WHERE id = 1', next);
    this.sql.exec("INSERT INTO ledger (user_id, type, amount_cents, balance_after_cents, meta, real_money, currency) VALUES (1, ?, ?, ?, ?, 1, 'TICS')",
      type, delta, next, meta ? JSON.stringify(meta) : null);
  }
  // $TICS money movements, each idempotent by its ref:
  //  tics-deposit  credit a confirmed on-chain deposit      ref td:<chainId>-<txHash>-<logIndex>
  //  tics-hold     take a withdrawal amount off the balance  ref th:<withdrawalId>
  //  tics-finalise the withdrawal was paid on-chain          ref = the hold ref
  //  tics-release  the withdrawal failed or was cancelled    ref = the hold ref (money goes back)
  ticsOp(kind, body, { final = false, holdId = null } = {}) {
    if (typeof body.ref !== 'string' || !/^t[dh]:[A-Za-z0-9-]{8,100}$/.test(body.ref)) fail(400, 'invalid payment ref');
    return this.ctx.storage.transactionSync(() => {
      // A credit whose booking the cron already closed as 'never ran' (it sat unanswered for minutes) is refused, so
      // no credit can ever land without a booking. The caller retries and books afresh.
      if (holdId && this.one("SELECT 1 AS ok FROM spin_hold_marks WHERE hold_id = ? AND state = 'void'", holdId)) fail(409, 'The booking for this credit was closed before it ran. Nothing was credited; it will be retried.');
      if (kind === 'tics-deposit' || kind === 'tics-hold') {
        if (!Number.isSafeInteger(body.amountCents) || body.amountCents <= 0) fail(400, 'invalid amount');
        if (this.one('SELECT ref FROM processed_payments WHERE ref = ?', body.ref)) return { duplicate: true, realTicsCents: this.ticsBalance() };
        const current = this.ticsBalance();
        if (kind === 'tics-deposit') {
          if (!body.ref.startsWith('td:')) fail(400, 'invalid payment ref');
          this.setTics(current + body.amountCents, 'deposit', body.amountCents, { ref: body.ref, ...(body.note ? { note: String(body.note).slice(0, 200) } : {}) });
          // Not withdrawable until the cron has seen it in a final block (unless it already has).
          this.sql.exec(`INSERT INTO tics_finality (ref, units, final, credited_at) VALUES (?, ?, ?, datetime('now'))
            ON CONFLICT(ref) DO UPDATE SET units = excluded.units, final = MAX(final, excluded.final), credited_at = excluded.credited_at`, body.ref, body.amountCents, final ? 1 : 0);
          // The booking made before this credit (bookCredit) is marked in the same transaction as the credit, so the
          // central copy that carries this balance also deletes exactly that booking.
          if (holdId) this.sql.exec("INSERT OR IGNORE INTO spin_hold_marks (hold_id, state) VALUES (?, 'pending')", holdId);
        } else {
          if (!body.ref.startsWith('th:')) fail(400, 'invalid payment ref');
          // Never pay out from a balance that does not match its own ledger.
          if (!this.ticsReconciled()) fail(409, 'balance check failed');
          if (current < body.amountCents) fail(402, 'not enough real balance');
          // No withdrawal at all while a top up is not final on Ethereum yet (re-audit R2, verification F1):
          // the top up AND anything won with it stay here until it is confirmed for good.
          if (this.one('SELECT COUNT(*) AS n FROM tics_finality WHERE final = 0 AND units > 0').n > 0) fail(402, WITHDRAW_WAIT_MESSAGE);
          this.setTics(current - body.amountCents, 'withdrawal_hold', -body.amountCents, { ref: body.ref });
          this.sql.exec("INSERT INTO holds (ref, units, status) VALUES (?, ?, 'held')", body.ref, body.amountCents);
        }
        this.sql.exec('INSERT INTO processed_payments (ref) VALUES (?)', body.ref);
        return { duplicate: false, realTicsCents: this.ticsBalance() };
      }
      if (kind === 'tics-deposit-final') {
        if (!body.ref.startsWith('td:')) fail(400, 'invalid payment ref');
        // Already taken back (a reversal whose reply was lost, then the transfer was seen again): say so,
        // so the caller finishes that reversal (pause and alert) instead of calling the deposit final.
        const rev = this.reversalOf(body.ref);
        if (rev) return { ok: false, reversed: true, ...rev };
        this.sql.exec('INSERT INTO tics_finality (ref, final) VALUES (?, 1) ON CONFLICT(ref) DO UPDATE SET final = 1', body.ref);
        return { ok: true };
      }
      if (kind === 'tics-deposit-reverse') {
        // A credited top up whose transfer is gone from the chain (re-audit R2). Takes back what the
        // balance still has, never below zero, with its own ledger row; once per deposit.
        if (!body.ref.startsWith('td:') || !Number.isSafeInteger(body.amountCents) || body.amountCents <= 0) fail(400, 'invalid reversal');
        // The result is stored with the balance change, so a retry after a lost reply gets the SAME amounts
        // back (verification F2) and the caller can still pause the account and alert.
        const done = this.reversalOf(body.ref);
        if (done) return { duplicate: true, ...done, realTicsCents: this.ticsBalance() };
        let take = 0, short = 0;
        if (!this.one('SELECT ref FROM processed_payments WHERE ref = ?', body.ref)) {
          // Never credited here: close the ref so a credit still on its way is answered as a duplicate.
          this.sql.exec('INSERT OR IGNORE INTO processed_payments (ref) VALUES (?)', body.ref);
        } else {
          const current = this.ticsBalance();
          take = Math.min(current, body.amountCents); short = body.amountCents - take;
          if (take > 0) this.setTics(current - take, 'deposit_reversal', -take, { ref: body.ref, reason: 'transfer gone from the chain', shortCents: short });
        }
        this.sql.exec('INSERT INTO tics_reversals (ref, reversed_cents, short_cents) VALUES (?, ?, ?)', body.ref, take, short);
        this.sql.exec('INSERT INTO tics_finality (ref, units, final) VALUES (?, 0, 1) ON CONFLICT(ref) DO UPDATE SET units = 0, final = 1', body.ref);
        return { duplicate: false, reversedCents: take, shortCents: short, realTicsCents: this.ticsBalance() };
      }
      const hold = this.one('SELECT * FROM holds WHERE ref = ?', body.ref);
      // Read-only: lets the payouts Worker confirm a withdrawal's money is really held before it signs.
      if (kind === 'tics-hold-check') return hold ? { status: hold.status, units: hold.units } : { status: null, units: 0 };
      // Like the check, but a ref with no hold is closed for good: a hold request for it that is still on
      // its way is then answered as a duplicate and moves no money. Used before a withdrawal claim is removed.
      if (kind === 'tics-hold-void') {
        if (!body.ref.startsWith('th:')) fail(400, 'invalid payment ref');
        if (hold) return { status: hold.status, units: hold.units };
        this.sql.exec('INSERT OR IGNORE INTO processed_payments (ref) VALUES (?)', body.ref);
        return { status: null, units: 0, voided: true };
      }
      if (!hold) fail(404, 'hold not found');
      if (kind === 'tics-finalise') {
        if (hold.status === 'done') return { duplicate: true, realTicsCents: this.ticsBalance() };
        if (hold.status !== 'held') fail(409, 'hold already released');
        this.sql.exec("UPDATE holds SET status = 'done', updated_at = datetime('now') WHERE ref = ?", body.ref);
        return { duplicate: false, realTicsCents: this.ticsBalance() };
      }
      if (kind === 'tics-release') {
        if (hold.status === 'released') return { duplicate: true, realTicsCents: this.ticsBalance() };
        if (hold.status !== 'held') fail(409, 'hold already paid');
        this.sql.exec("UPDATE holds SET status = 'released', updated_at = datetime('now') WHERE ref = ?", body.ref);
        this.setTics(this.ticsBalance() + hold.units, 'withdrawal_refund', hold.units, { ref: body.ref, ...(body.reason ? { reason: String(body.reason).slice(0, 200) } : {}) });
        if (holdId) this.sql.exec("INSERT OR IGNORE INTO spin_hold_marks (hold_id, state) VALUES (?, 'pending')", holdId);
        return { duplicate: false, realTicsCents: this.ticsBalance() };
      }
      fail(404, 'demo endpoint not found');
    });
  }
  // A reversal already made for this deposit ref: from tics_reversals, or the marker the first version
  // of this code wrote (processed_payments 'rv:<ref>', amounts read back from its ledger row).
  reversalOf(ref) {
    const row = this.one('SELECT reversed_cents, short_cents FROM tics_reversals WHERE ref = ?', ref);
    if (row) return { reversedCents: row.reversed_cents, shortCents: row.short_cents };
    if (!this.one('SELECT ref FROM processed_payments WHERE ref = ?', `rv:${ref.slice(3)}`)) return null;
    const led = this.one("SELECT COALESCE(-SUM(amount_cents), 0) AS taken, MAX(COALESCE(json_extract(meta, '$.shortCents'), 0)) AS short FROM ledger WHERE type = 'deposit_reversal' AND json_extract(meta, '$.ref') = ?", ref);
    return { reversedCents: led.taken || 0, shortCents: led.short || 0 };
  }
  // What this wallet knows about a spin booking. Unknown means the spin has not run here: it is closed
  // for good ('void'), so a spin request still on its way is refused and the booking can be released.
  holdStatus(body) {
    const holdId = body?.holdId;
    if (typeof holdId !== 'string' || !holdId || holdId.length > 200) fail(400, 'invalid hold id');
    return this.ctx.storage.transactionSync(() => {
      const row = this.one('SELECT state FROM spin_hold_marks WHERE hold_id = ?', holdId);
      if (row) return { state: row.state };
      this.sql.exec("INSERT INTO spin_hold_marks (hold_id, state) VALUES (?, 'void')", holdId);
      return { state: 'void' };
    });
  }
  // Booking for a credit (prelaunch audit P1). A wallet's balance is the truth, the central database holds a copy
  // that the bank's liability sum reads. A credit (a deposit, or a withdrawal refund) makes the wallet's balance
  // higher than that copy until the copy lands. So the amount is first written to the same table the spin
  // bookings use, with a fresh id per attempt; the credit marks it in its own transaction; the central copy deletes
  // it in the same batch as the new balance; the cron closes bookings whose credit never happened.
  async bookCredit(kind, body) {
    const db = this.env.DB, playerId = this.getMeta('player_id');
    if (!db || !playerId || typeof body?.ref !== 'string') return null;
    let units = 0;
    if (kind === 'tics-deposit') {
      if (!Number.isSafeInteger(body.amountCents) || body.amountCents <= 0) return null; // refused by the credit itself
      if (this.one('SELECT ref FROM processed_payments WHERE ref = ?', body.ref)) return null; // already credited: nothing new
      units = body.amountCents;
    } else if (kind === 'tics-release') {
      const hold = this.one('SELECT units, status FROM holds WHERE ref = ?', body.ref);
      if (!hold || hold.status !== 'held') return null;
      units = hold.units;
    } else return null;
    const id = `cr:${crypto.randomUUID()}`, now = Date.now();
    await db.prepare('INSERT INTO spin_holds (id, player_id, units, expires_at, booked_at) VALUES (?, ?, ?, ?, ?)').bind(id, playerId, units, now + HOLD_KEEP_MS, now).run();
    return id;
  }
  async dropBooking(id) {
    if (id && this.env.DB) await this.env.DB.prepare('DELETE FROM spin_holds WHERE id = ?').bind(id).run().catch(() => {});
  }
  // A credit needs a recorded on-chain deposit behind it: the central deposits table must hold that exact
  // transfer (chain, transaction, log), for the same amount, linked to THIS player, credited or assigned
  // and not reversed. Holding the internal secret alone (a bug or a stolen key in the admin panel or
  // game Worker) is then no longer enough to make money appear. Someone who can also write the deposits
  // table can still fake a row: that limit is part of a custodial design and is stated in the README.
  async depositEvidence(body) {
    if (!this.env.DB) return {}; // unit tests of the object alone; production always has the database
    const m = typeof body?.ref === 'string' && body.ref.match(/^td:(\d{1,12})-(0x[0-9a-f]{64})-(\d{1,9})$/);
    if (!m) fail(400, 'invalid payment ref');
    if (this.one('SELECT ref FROM processed_payments WHERE ref = ?', body.ref)) return {}; // a repeat: answered as a duplicate
    const row = await this.env.DB.prepare('SELECT amount_units, player_id, status, reversed_at, finalized_at FROM chain_deposits WHERE chain_id = ? AND tx_hash = ? AND log_index = ?')
      .bind(Number(m[1]), m[2], Number(m[3])).first();
    const playerId = this.getMeta('player_id') || body.playerId;
    if (!row || row.amount_units !== body.amountCents || !playerId || row.player_id !== playerId
      || !['credited', 'assigned'].includes(row.status) || row.reversed_at) fail(409, 'No recorded deposit matches this credit. Nothing was credited.');
    return { final: !!row.finalized_at };
  }
  // Real-money movements. Each has a unique ref so a repeated call (webhook
  // retry, double click) never moves money twice.
  paymentOp(kind, body) {
    if (typeof body.ref !== 'string' || !/^[a-z]{2,8}:[A-Za-z0-9-]{8,64}$/.test(body.ref)) fail(400, 'invalid payment ref');
    if (!Number.isSafeInteger(body.amountCents) || body.amountCents <= 0 || body.amountCents > MAX_BET_CENTS) fail(400, 'invalid amount');
    return this.ctx.storage.transactionSync(() => {
      if (this.one('SELECT ref FROM processed_payments WHERE ref = ?', body.ref)) return { duplicate: true, realBalanceCents: this.realBalance() };
      this.sql.exec('INSERT OR IGNORE INTO real_wallet (id, balance_cents) VALUES (1, 0)');
      const current = this.realBalance();
      const delta = kind === 'withdraw-hold' ? -body.amountCents : body.amountCents;
      if (current + delta < 0) fail(402, 'not enough real balance');
      const type = kind === 'deposit' ? 'deposit' : kind === 'withdraw-hold' ? 'withdrawal' : 'withdrawal_refund';
      this.sql.exec('UPDATE real_wallet SET balance_cents = ? WHERE id = 1', current + delta);
      this.sql.exec('INSERT INTO ledger (user_id, type, amount_cents, balance_after_cents, meta, real_money) VALUES (1, ?, ?, ?, ?, 1)',
        type, delta, current + delta, JSON.stringify({ ref: body.ref, ...(body.reason ? { reason: String(body.reason).slice(0, 300) } : {}) }));
      this.sql.exec('INSERT INTO processed_payments (ref) VALUES (?)', body.ref);
      return { duplicate: false, realBalanceCents: current + delta };
    });
  }
  one(query, ...args) { return this.sql.exec(query, ...args).toArray()[0]; }
  user() { return this.one('SELECT * FROM users WHERE id = 1'); }
  commitment() { return this.one('SELECT * FROM fairness_commitments WHERE user_id = 1'); }
  wallet(minStakeCents = 1) {
    const user = this.user();
    if (!user) fail(401, 'demo session required');
    const held = this.heldTics();
    // The wallet is the authority on the withdrawal wait: when its newest top up that is not final arrived (UTC ISO).
    const wait = this.one('SELECT MAX(credited_at) AS since FROM tics_finality WHERE final = 0 AND units > 0');
    return { balanceCents: user.balance_cents, realTicsCents: this.ticsBalance(),
      pendingWithdrawals: held.n, heldCents: held.units, demoAllowed: this.demoAllowed(minStakeCents),
      withdrawPendingSince: wait?.since ? `${wait.since.replace(' ', 'T')}Z` : null };
  }
  init(body, demoStart = DEMO_START_UNITS) {
    return this.ctx.storage.transactionSync(() => {
      if (!this.user()) {
        const seed = generateServerSeed();
        // Each player has their own Durable Object; this row is its only account (no names are stored).
        this.sql.exec("INSERT INTO users (id, username, balance_cents) VALUES (1, 'player', ?)", demoStart);
        this.sql.exec("INSERT INTO ledger (user_id, type, amount_cents, balance_after_cents, meta, currency) VALUES (1, 'demo_credit', ?, ?, ?, 'TICS')", demoStart, demoStart, JSON.stringify({ mode: 'demo', realMoney: false }));
        this.sql.exec('INSERT INTO fairness_commitments (user_id, server_seed, server_seed_hash, client_seed, nonce) VALUES (1, ?, ?, ?, 0)', seed, hashServerSeed(seed), generateClientSeed());
      }
      return this.wallet();
    });
  }
  // Play-money top-up back to the starting demo balance (Demo mode only).
  resetDemoBalance(body, demoStart = DEMO_START_UNITS, minStakeCents = 1) {
    if (this.env.STAGING !== 'true') fail(404, 'demo endpoint not found');
    return this.ctx.storage.transactionSync(() => {
      if (!this.demoAllowed(minStakeCents)) fail(403, 'Demo is not available while you have real funds.');
      const current = this.wallet().balanceCents, target = demoStart;
      if (current !== target) {
        this.sql.exec('UPDATE users SET balance_cents = ? WHERE id = 1', target);
        this.sql.exec("INSERT INTO ledger (user_id, type, amount_cents, balance_after_cents, meta, currency) VALUES (1, 'demo_reset', ?, ?, ?, 'TICS')", target-current, target, JSON.stringify({mode:'demo',realMoney:false}));
      }
      return this.wallet(minStakeCents);
    });
  }
  setSeed(body) {
    if (typeof body.clientSeed !== 'string' || !body.clientSeed.trim() || body.clientSeed.trim().length > 64) fail(400, 'clientSeed must contain 1 to 64 characters');
    return this.ctx.storage.transactionSync(() => {
      checkCommitment(expectedCommitment(body.expectedCommitment), this.commitment());
      // New bases are trimmed; observed tuples and entropy are never normalized.
      this.sql.exec('UPDATE fairness_commitments SET client_seed = ? WHERE user_id = 1', body.clientSeed.trim());
      return publicCommitment(this.commitment());
    });
  }
  // Player-requested new lock before a spin. The replaced secret was never used
  // for a round, so it is revealed: the player can check it matches the old lock.
  rotateLock(body) {
    return this.ctx.storage.transactionSync(() => {
      const current = this.commitment();
      checkCommitment(expectedCommitment(body.expectedCommitment), current);
      const nextSeed = generateServerSeed();
      this.sql.exec('UPDATE fairness_commitments SET server_seed = ?, server_seed_hash = ?, nonce = 0 WHERE user_id = 1', nextSeed, hashServerSeed(nextSeed));
      return { retired: { serverSeed: current.server_seed, serverSeedHash: current.server_seed_hash }, commitment: publicCommitment(this.commitment()) };
    });
  }
  spin(request, body, context = {}) {
    const config = context.config || null;
    const math = config ? mathOption(config.mathId) : STANDARD;
    const key = idempotencyKey(request, body);
    // Bind the entire JSON input, including unused fields, with key order ignored.
    const fingerprint = JSON.stringify(canonicalInput(body));
    return this.ctx.storage.transactionSync(() => {
      if (key !== null) {
        const cached = this.one('SELECT * FROM idempotency WHERE request_key = ?', key);
        if (cached) {
          if (cached.fingerprint !== fingerprint) fail(409, 'idempotency key already used for different inputs');
          return JSON.parse(cached.response_json);
        }
      }
      if (context.replayOnly) fail(503, 'Several big bets are being played at this moment. Please try again in a few seconds.');
      const holdId = typeof context.holdId === 'string' && context.holdId.length <= 200 ? context.holdId : null;
      if (holdId && this.one("SELECT 1 AS ok FROM spin_hold_marks WHERE hold_id = ? AND state = 'void'", holdId)) fail(409, 'This spin took too long to reach the table. Your bet was not taken. Please try again.');
      // The browser says which payout table it agreed to. If it changed since, refuse before anything is
      // used, with a code the browser recognises (it reloads the table and asks the player again).
      if (body.mathId !== undefined && body.mathId !== math.id) {
        const e = new ApiError(409, 'The payout table changed. Please check it and confirm again.'); e.code = 'table_changed'; throw e;
      }
      const bets = normalizedBets(body.bets);
      const stake = bets.reduce((sum, bet) => sum + bet.amountCents, 0);
      if (!Number.isSafeInteger(stake)) fail(400, 'invalid total stake');
      const mode = body.mode === undefined ? 'demo' : body.mode;
      if (mode !== 'demo' && mode !== 'real') fail(400, 'mode must be demo or real');
      const real = mode === 'real';
      const expected = expectedCommitment(body.expectedCommitment);
      if (typeof body.clientEntropy !== 'string' || !/^[a-f0-9]{64}$/.test(body.clientEntropy)) fail(400, 'clientEntropy must be 64 lowercase hex characters');
      if (config) {
        const blocked = checkRoundLimits(bets, { ...config, math });
        if (blocked) fail(blocked.status, blocked.error);
      }
      if (real) {
        if (!context.walletPlayer) fail(403, 'Connect your wallet to play with real $TICS.');
        if (!context.realEnabled) fail(503, 'Real play is not open yet.');
        // Bankroll guard: the biggest possible payout of this spin must fit the table limit.
        if (!Number.isSafeInteger(context.freeFloatCents) || context.freeFloatCents <= 0) fail(503, 'Real play is paused while the casino wallet is checked. Please try again shortly.');
        const worst = maxPayoutCents(bets, math);
        if (worst > context.freeFloatCents) fail(503, tableLimitMessage(worst, context.freeFloatCents, math));
      } else if (Number.isSafeInteger(context.maxWinCents) && context.maxWinCents > 0 && maxPayoutCents(bets, math) > context.maxWinCents) {
        // Demo follows the same table limit, so switching to real never surprises the player.
        fail(503, tableLimitMessage(maxPayoutCents(bets, math), context.maxWinCents, math));
      }
      if (!real && !this.demoAllowed(config ? config.minStakeCents : 1)) fail(403, 'Demo is not available while you have real funds.');
      const user = this.user();
      const current = this.commitment();
      checkCommitment(expected, current);
      const startBalance = real ? this.ticsBalance() : user.balance_cents;
      if (real && !this.ticsReconciled()) fail(409, 'balance check failed');
      if (startBalance < stake) fail(402, 'insufficient balance');
      if (this.one('SELECT client_entropy FROM entropy_used WHERE client_entropy = ?', body.clientEntropy)) fail(409, 'clientEntropy already used');
      this.sql.exec('INSERT INTO entropy_used (client_entropy) VALUES (?)', body.clientEntropy);
      const effectiveClientSeed = `${current.client_seed}:${body.clientEntropy}`;
      const pocket = deriveOutcome(current.server_seed, effectiveClientSeed, current.nonce, POCKET_COUNT);
      const color = pocketColor(pocket);
      const betResults = bets.map((bet) => {
        const payoutCents = payoutCentsFor(bet, pocket, math);
        return { ...bet, payoutCents, won: payoutCents > 0 };
      });
      const payout = betResults.reduce((sum, bet) => sum + bet.payoutCents, 0);
      const afterDebit = startBalance - stake;
      const balanceAfter = afterDebit + payout;
      if (!Number.isSafeInteger(balanceAfter) || balanceAfter < 0) fail(400, 'balance exceeds demo limits');
      const currency = 'TICS';
      const writeBalance = (value) => (real
        ? this.sql.exec('UPDATE real_tics SET balance_cents = ? WHERE id = 1', value)
        : this.sql.exec('UPDATE users SET balance_cents = ? WHERE id = 1', value));
      if (real) this.sql.exec('INSERT OR IGNORE INTO real_tics (id, balance_cents) VALUES (1, 0)');
      writeBalance(afterDebit);
      const round = this.one(`INSERT INTO rounds
        (user_id, game, stake_cents, bet_json, server_seed, server_seed_hash, client_seed, nonce, receipt_json, game_id, math_id, config_version, currency, real_money, country, device)
        VALUES (1, 'roulette', ?, ?, ?, ?, ?, ?, ?, 'roulette', ?, ?, ?, ?, ?, ?) RETURNING id`,
        stake, JSON.stringify(bets), current.server_seed, current.server_seed_hash, effectiveClientSeed, current.nonce,
        JSON.stringify({ requestId: key, expectedCommitment: expected, clientEntropy: body.clientEntropy, mode }),
        math.id, config ? config.configVersion : 0, currency, real ? 1 : 0, context.country || null, context.device || null);
      const roundId = round.id;
      this.sql.exec("INSERT INTO ledger (user_id, type, amount_cents, balance_after_cents, round_id, real_money, currency) VALUES (1, 'bet_reserve', ?, ?, ?, ?, ?)", -stake, afterDebit, roundId, real ? 1 : 0, currency);
      this.sql.exec("UPDATE rounds SET status = 'settled', outcome_json = ?, payout_cents = ?, revealed_at = datetime('now') WHERE id = ?", JSON.stringify({ pocket, color, betResults }), payout, roundId);
      writeBalance(balanceAfter);
      this.sql.exec('INSERT INTO ledger (user_id, type, amount_cents, balance_after_cents, round_id, real_money, currency) VALUES (1, ?, ?, ?, ?, ?, ?)', payout > 0 ? 'bet_settle_win' : 'bet_settle_loss', payout, balanceAfter, roundId, real ? 1 : 0, currency);
      const nextSeed = generateServerSeed();
      this.sql.exec('UPDATE fairness_commitments SET server_seed = ?, server_seed_hash = ?, nonce = 0 WHERE user_id = 1', nextSeed, hashServerSeed(nextSeed));
      const result = {
        requestId: key, roundId, pocket, color, betResults, totalStakeCents: stake, totalPayoutCents: payout, mathId: math.id,
        mode, balanceAfterCents: balanceAfter,
        fairness: {
          serverSeed: current.server_seed, serverSeedHash: current.server_seed_hash,
          clientSeed: effectiveClientSeed, clientSeedBase: current.client_seed, clientEntropy: body.clientEntropy, nonce: current.nonce,
          nextCommitment: publicCommitment(this.commitment()),
        },
      };
      if (holdId) this.sql.exec("INSERT OR IGNORE INTO spin_hold_marks (hold_id, state) VALUES (?, 'pending')", holdId);
      if (key !== null) this.sql.exec('INSERT INTO idempotency (request_key, fingerprint, response_json) VALUES (?, ?, ?)', key, fingerprint, JSON.stringify(result));
      return result;
    });
  }
  // Gods of Power: one request plays the base spin and every free spin as ONE round in one transaction.
  // Same lock, same entropy rule, same money and booking rules as a roulette spin.
  spinSlots(request, body, context = {}) {
    const config = context.config || null;
    const math = SLOT_MATH;
    const key = idempotencyKey(request, body);
    const fingerprint = JSON.stringify(canonicalInput(body));
    return this.ctx.storage.transactionSync(() => {
      if (key !== null) {
        const cached = this.one('SELECT * FROM idempotency WHERE request_key = ?', key);
        if (cached) {
          if (cached.fingerprint !== fingerprint) fail(409, 'idempotency key already used for different inputs');
          return JSON.parse(cached.response_json);
        }
      }
      if (context.replayOnly) fail(503, 'Several big bets are being played at this moment. Please try again in a few seconds.');
      const holdId = typeof context.holdId === 'string' && context.holdId.length <= 200 ? context.holdId : null;
      if (holdId && this.one("SELECT 1 AS ok FROM spin_hold_marks WHERE hold_id = ? AND state = 'void'", holdId)) fail(409, 'This spin took too long to reach the table. Your bet was not taken. Please try again.');
      if (body.mathId !== undefined && body.mathId !== math.id) {
        const e = new ApiError(409, 'The pay table changed. Please check it and confirm again.'); e.code = 'table_changed'; throw e;
      }
      const stake = body.stake;
      if (!Number.isSafeInteger(stake) || stake <= 0) fail(400, 'stake must be a positive whole number of units');
      const mode = body.mode === undefined ? 'demo' : body.mode;
      if (mode !== 'demo' && mode !== 'real') fail(400, 'mode must be demo or real');
      const real = mode === 'real';
      const expected = expectedCommitment(body.expectedCommitment);
      if (typeof body.clientEntropy !== 'string' || !/^[a-f0-9]{64}$/.test(body.clientEntropy)) fail(400, 'clientEntropy must be 64 lowercase hex characters');
      if (config) {
        const blocked = checkSlotLimits(stake, config, math);
        if (blocked) fail(blocked.status, blocked.error);
      }
      const worst = slotMaxPayout(stake, math);
      if (real) {
        if (!context.walletPlayer) fail(403, 'Connect your wallet to play with real $TICS.');
        if (!context.realEnabled) fail(503, 'Real play is not open yet.');
        if (!Number.isSafeInteger(context.freeFloatCents) || context.freeFloatCents <= 0) fail(503, 'Real play is paused while the casino wallet is checked. Please try again shortly.');
        if (worst > context.freeFloatCents) fail(503, slotLimitMessage(context.freeFloatCents, math));
      } else if (Number.isSafeInteger(context.maxWinCents) && context.maxWinCents > 0 && worst > context.maxWinCents) {
        fail(503, slotLimitMessage(context.maxWinCents, math));
      }
      if (!real && !this.demoAllowed(config ? config.minStakeCents : 1)) fail(403, 'Demo is not available while you have real funds.');
      const user = this.user();
      const current = this.commitment();
      checkCommitment(expected, current);
      const startBalance = real ? this.ticsBalance() : user.balance_cents;
      if (real && !this.ticsReconciled()) fail(409, 'balance check failed');
      if (startBalance < stake) fail(402, 'insufficient balance');
      if (this.one('SELECT client_entropy FROM entropy_used WHERE client_entropy = ?', body.clientEntropy)) fail(409, 'clientEntropy already used');
      this.sql.exec('INSERT INTO entropy_used (client_entropy) VALUES (?)', body.clientEntropy);
      const effectiveClientSeed = `${current.client_seed}:${body.clientEntropy}`;
      const round = playRound({ stake, uint32At: makeUint32At(current.server_seed, effectiveClientSeed, current.nonce), math });
      const payout = round.totalPayoutUnits;
      const afterDebit = startBalance - stake;
      const balanceAfter = afterDebit + payout;
      if (!Number.isSafeInteger(balanceAfter) || balanceAfter < 0) fail(400, 'balance exceeds demo limits');
      const currency = 'TICS';
      const writeBalance = (value) => (real
        ? this.sql.exec('UPDATE real_tics SET balance_cents = ? WHERE id = 1', value)
        : this.sql.exec('UPDATE users SET balance_cents = ? WHERE id = 1', value));
      if (real) this.sql.exec('INSERT OR IGNORE INTO real_tics (id, balance_cents) VALUES (1, 0)');
      writeBalance(afterDebit);
      const outcome = { game: 'godsofpower', spins: round.spins.map((s) => ({ free: s.free, stops: s.stops, lineWins: s.lineWins, scatterCount: s.scatterCount, scatterPay: s.scatterPay, multiplier: s.multiplier, winUnits: s.winUnits, freeSpinsAdded: s.freeSpinsAdded })),
        freeSpinsAwarded: round.freeSpinsAwarded, freeSpinsPlayed: round.freeSpinsPlayed, capped: round.capped };
      const row = this.one(`INSERT INTO rounds
        (user_id, game, stake_cents, bet_json, server_seed, server_seed_hash, client_seed, nonce, receipt_json, game_id, math_id, config_version, currency, real_money, country, device)
        VALUES (1, 'godsofpower', ?, ?, ?, ?, ?, ?, ?, 'godsofpower', ?, ?, ?, ?, ?, ?) RETURNING id`,
        stake, JSON.stringify({ stake, lines: math.lineCount }), current.server_seed, current.server_seed_hash, effectiveClientSeed, current.nonce,
        JSON.stringify({ requestId: key, expectedCommitment: expected, clientEntropy: body.clientEntropy, mode }),
        math.id, config ? config.configVersion : 0, currency, real ? 1 : 0, context.country || null, context.device || null);
      const roundId = row.id;
      this.sql.exec("INSERT INTO ledger (user_id, type, amount_cents, balance_after_cents, round_id, real_money, currency) VALUES (1, 'bet_reserve', ?, ?, ?, ?, ?)", -stake, afterDebit, roundId, real ? 1 : 0, currency);
      this.sql.exec("UPDATE rounds SET status = 'settled', outcome_json = ?, payout_cents = ?, revealed_at = datetime('now') WHERE id = ?", JSON.stringify(outcome), payout, roundId);
      writeBalance(balanceAfter);
      this.sql.exec('INSERT INTO ledger (user_id, type, amount_cents, balance_after_cents, round_id, real_money, currency) VALUES (1, ?, ?, ?, ?, ?, ?)', payout > 0 ? 'bet_settle_win' : 'bet_settle_loss', payout, balanceAfter, roundId, real ? 1 : 0, currency);
      const nextSeed = generateServerSeed();
      this.sql.exec('UPDATE fairness_commitments SET server_seed = ?, server_seed_hash = ?, nonce = 0 WHERE user_id = 1', nextSeed, hashServerSeed(nextSeed));
      const result = {
        requestId: key, roundId, game: 'godsofpower', stake, spins: round.spins, freeSpinsAwarded: round.freeSpinsAwarded, freeSpinsPlayed: round.freeSpinsPlayed, capped: round.capped,
        totalStakeCents: stake, totalPayoutCents: payout, mathId: math.id, mode, balanceBeforeCents: startBalance, balanceAfterCents: balanceAfter,
        fairness: {
          serverSeed: current.server_seed, serverSeedHash: current.server_seed_hash,
          clientSeed: effectiveClientSeed, clientSeedBase: current.client_seed, clientEntropy: body.clientEntropy, nonce: current.nonce,
          nextCommitment: publicCommitment(this.commitment()),
        },
      };
      if (holdId) this.sql.exec("INSERT OR IGNORE INTO spin_hold_marks (hold_id, state) VALUES (?, 'pending')", holdId);
      if (key !== null) this.sql.exec('INSERT INTO idempotency (request_key, fingerprint, response_json) VALUES (?, ?, ?)', key, fingerprint, JSON.stringify(result));
      return result;
    });
  }
  async fetch(request) {
    try {
      checkOrigin(request);
      const { pathname } = new URL(request.url);
      const method = request.method;
      const body = method === 'POST' ? parseBody(await bodyText(request)) : null;
      if (pathname.startsWith('/internal/')) {
        const secret = this.env.INTERNAL_SECRET;
        if (!secret || !sameSecret(request.headers.get(INTERNAL_HEADER), secret)) fail(404, 'demo endpoint not found');
        // A deposit can arrive for a wallet that has not opened its game wallet yet: create it.
        if (!this.user() && pathname === '/internal/tics-deposit' && typeof body?.playerId === 'string') { this.setMeta('player_id', body.playerId); this.init({}, Number.isSafeInteger(body.demoStartUnits) ? body.demoStartUnits : DEMO_START_UNITS); }
        if (method === 'POST' && pathname === '/internal/tics-deposit-final' && !this.user()) return json(this.ticsOp('tics-deposit-final', body));
        if (method === 'POST' && pathname === '/internal/hold-status') {
          let r = this.holdStatus(body);
          if (r.state === 'pending') { await this.flush(); r = this.holdStatus(body); }
          return json(r);
        }
        if (!this.user()) fail(404, 'player wallet not found');
        if (method === 'GET' && pathname === '/internal/wallet') return json({ ...this.wallet(), realBalanceCents: this.realBalance(), playerId: this.getMeta('player_id'), ticsReconciled: this.ticsReconciled() });
        const op = pathname.match(/^\/internal\/(deposit|withdraw-hold|withdraw-release)$/);
        if (method === 'POST' && op) { const result = this.paymentOp(op[1], body); await this.flush(); return json(result); }
        const tics = pathname.match(/^\/internal\/(tics-deposit|tics-deposit-reverse|tics-deposit-final|tics-hold|tics-finalise|tics-release|tics-hold-check|tics-hold-void)$/);
        const evidence = method === 'POST' && tics && tics[1] === 'tics-deposit' ? await this.depositEvidence(body) : {};
        if (method === 'POST' && tics) {
          // Every operation that RAISES a real balance is booked in the central database first (prelaunch audit P1):
          // until the central copy carries the new balance, that amount counts as owed there. If the booking cannot
          // be written, nothing is credited and the caller retries.
          const bookingId = await this.bookCredit(tics[1], body);
          let result;
          try { result = this.ticsOp(tics[1], body, { ...evidence, holdId: bookingId }); } catch (error) { await this.dropBooking(bookingId); throw error; }
          // A duplicate or a vanished hold credited nothing and marked nothing: its booking is not needed.
          if (bookingId && result?.duplicate) await this.dropBooking(bookingId);
          if (!tics[1].startsWith('tics-hold-')) await this.flush();
          return json(result);
        }
        fail(404, 'demo endpoint not found');
      }
      // Only the platform Worker can reach this object, and it always overwrites this header.
      let context = {};
      try { context = JSON.parse(request.headers.get(CONTEXT_HEADER) || '{}') || {}; } catch { context = {}; }
      if (this.env.DB && !context.playerId) fail(500, 'missing platform context');
      if (context.playerId && !this.getMeta('player_id')) this.setMeta('player_id', context.playerId);
      if (context.config) { this.setMeta('currency', context.config.currency); this.setMeta('real_money', context.config.realMoney ? 1 : 0); }
      const demoStart = Number.isSafeInteger(context.demoStartUnits) && context.demoStartUnits > 0 ? context.demoStartUnits : DEMO_START_UNITS;
      const minStake = Number.isSafeInteger(context.minStakeCents) ? context.minStakeCents : 1;
      if (pathname === '/api/session' && method === 'POST') { this.init(body, demoStart); const result = this.wallet(minStake); await this.flush(); return json(result); }
      if (!this.user()) fail(401, 'demo session required');
      // The player is the cookie or wallet session (one Durable Object each); no id in the path.
      if (method === 'GET' && pathname === '/api/wallet') return json(this.wallet(minStake));
      if (method === 'GET' && pathname === '/api/fairness/commitment') return json(publicCommitment(this.commitment()));
      if (method === 'POST' && pathname === '/api/demo/reset-balance') { const result = this.resetDemoBalance(body, demoStart, minStake); await this.flush(); return json(result); }
      if (method === 'POST' && pathname === '/api/fairness/client-seed') return json(this.setSeed(body));
      if (method === 'POST' && pathname === '/api/fairness/rotate') return json(this.rotateLock(body));
      if (method === 'POST' && (pathname === '/api/games/roulette/spin' || pathname === '/api/games/godsofpower/spin')) {
        const run = pathname === '/api/games/godsofpower/spin' ? (req, b, c) => this.spinSlots(req, b, c) : (req, b, c) => this.spin(req, b, c);
        // X-Hold tells the Worker whether the spin booking can be released (prelaunch audit P2). 'release' only
        // when this wallet knows the booking is no longer needed: the spin was refused before anything was
        // committed, or its balance is confirmed in the central copy. Everything else keeps it counted.
        const release = (response) => { response.headers.set('X-Hold', 'release'); return response; };
        try {
          if (this.env.DB && !context.config) fail(500, 'missing game config');
          // A replay of a spin already made (lost reply) is always answered; new spins are rate limited.
          const replay = typeof body?.requestId === 'string' && this.one('SELECT 1 AS ok FROM idempotency WHERE request_key = ?', body.requestId);
          if (!replay && !this.takeSpinToken()) return release(json({ error: 'Slow down a little. Your bet was not taken.' }, 429));
          const result = run(request, body, context);
          try { this.pruneOld(); } catch (error) { console.error('prune failed', error); }
          const flushed = await this.flush(); // never throws: false means the copy is still pending
          const r = json(result);
          r.headers.set('X-Hold', flushed === true ? 'release' : 'keep');
          return r;
        } catch (error) {
          // A refusal thrown by the spin itself rolled back with its transaction: nothing was committed.
          if (error instanceof ApiError) return release(errorResponse(error));
          throw error;
        }
      }
      if (method === 'GET' && pathname === '/api/rounds') {
        // Only settled/revealed rounds ever expose seeds, never the pending seed.
        return json(this.sql.exec("SELECT * FROM rounds WHERE user_id = 1 AND status = 'settled' AND revealed_at IS NOT NULL ORDER BY id DESC LIMIT 25").toArray().map((row) => {
          const receipt = row.receipt_json ? JSON.parse(row.receipt_json) : null;
          const { user_id: _internalUser, ...publicRow } = row;
          return { ...publicRow, request_id: receipt?.requestId ?? null, client_seed_base: receipt?.expectedCommitment?.clientSeed ?? null, client_entropy: receipt?.clientEntropy ?? null };
        }));
      }
      fail(404, 'demo endpoint not found');
    } catch (error) { return errorResponse(error); }
  }
}
