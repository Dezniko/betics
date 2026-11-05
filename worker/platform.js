// Central platform database helpers (Cloudflare D1). The player wallet
// Durable Object stays the authority for money; this module resolves who the
// player is, what the game's live admin config is, and records analytics.
import { mathOption } from '../backend/src/games/rouletteMath.js';
import { SLOT_MATH } from '../backend/src/games/slotsMath.js';

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
export const sha256 = async text => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

// Light user-agent parsing: enough for device / OS / browser breakdowns.
export function parseAgent(ua = '') {
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'Other';
  const device = /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua)) ? 'tablet'
    : /Mobi|iPhone|iPod|Android/.test(ua) ? 'mobile' : 'desktop';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung'
    : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Other';
  return { os, device, browser };
}

// Everything we learn about a visit from the request itself.
export async function requestMeta(request, env) {
  const cf = request.cf || {};
  const ip = request.headers.get('CF-Connecting-IP') || '';
  return {
    country: cf.country || null,
    city: cf.city || null,
    language: (request.headers.get('Accept-Language') || '').split(',')[0].slice(0, 16) || null,
    // Salted hash: lets us spot duplicate accounts without storing the IP itself.
    ipHash: ip ? (await sha256(`${env.IP_SALT || 'casino-ip'}:${ip}`)).slice(0, 32) : null,
    ...parseAgent(request.headers.get('User-Agent') || ''),
  };
}

export async function resolvePlayer(db, token) {
  if (!token) return null;
  return db.prepare(`SELECT p.* FROM player_identities i JOIN players p ON p.id = i.player_id
    WHERE i.kind = 'guest' AND i.value = ?`).bind(await sha256(token)).first();
}

// Where a new player came from, as sent by the page (the API request's own Referer is always this site).
// source = utm_source, else the referring site's host; campaign = utm_campaign. Anything odd is dropped.
export function firstTouch(body) {
  const t = body && typeof body === 'object' ? body.firstTouch : null;
  if (!t || typeof t !== 'object') return { referrer: null, campaign: null };
  const source = typeof t.source === 'string' ? t.source.trim().toLowerCase() : '';
  const campaign = typeof t.campaign === 'string' ? t.campaign.trim() : '';
  return {
    referrer: /^[a-z0-9][a-z0-9._-]{0,63}$/.test(source) && !/(^|\.)betics\.io$/.test(source) ? source : null,
    campaign: /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,63}$/.test(campaign) ? campaign : null,
  };
}

export async function createGuestPlayer(db, token, meta, extra = {}) {
  const id = crypto.randomUUID();
  await db.batch([
    db.prepare(`INSERT INTO players (id, display_name, country, city, device, os, browser, language, first_referrer, first_campaign, ip_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, extra.displayName || 'player', meta.country, meta.city, meta.device, meta.os,
      meta.browser, meta.language, extra.referrer || null, extra.campaign || null, meta.ipHash),
    db.prepare(`INSERT INTO player_identities (kind, value, player_id, verified) VALUES ('guest', ?, ?, 1)`).bind(await sha256(token), id),
  ]);
  return db.prepare('SELECT * FROM players WHERE id = ?').bind(id).first();
}

export function touchPlayer(db, player, meta) {
  return db.prepare(`UPDATE players SET last_seen_at = datetime('now'), country = COALESCE(?, country), city = COALESCE(?, city),
    device = ?, os = ?, browser = ?, ip_hash = COALESCE(?, ip_hash) WHERE id = ?`)
    .bind(meta.country, meta.city, meta.device, meta.os, meta.browser, meta.ipHash, player.id).run();
}

export async function recordEvent(db, type, { player, meta = {}, gameId = null, valueCents = null, screen = null, referrer = null, campaign = null, extra = null } = {}) {
  await db.prepare(`INSERT INTO events (type, player_id, game_id, country, city, device, os, browser, screen, language, referrer, campaign, value_cents, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(type, player?.id || null, gameId, meta.country || null, meta.city || null,
    meta.device || null, meta.os || null, meta.browser || null, screen, meta.language || null, referrer, campaign, valueCents,
    extra ? JSON.stringify(extra) : null).run();
}

// Short cache: an admin change reaches every spin within a few seconds and
// always applies from the next round (rounds record the version they used).
const cache = new Map();
export const CONFIG_TTL_MS = 3000;
export async function loadGameConfig(db, gameId, now = Date.now()) {
  const hit = cache.get(gameId);
  if (hit && now - hit.at < CONFIG_TTL_MS) return hit.config;
  const [row, currency, mode] = await Promise.all([
    db.prepare('SELECT * FROM games WHERE id = ?').bind(gameId).first(),
    db.prepare("SELECT value FROM settings WHERE key = 'house_currency'").first(),
    db.prepare("SELECT value FROM settings WHERE key = 'mode'").first(),
  ]);
  if (!row) return null;
  const config = {
    gameId: row.id, name: row.name, enabled: !!row.enabled, maintenanceMessage: row.maintenance_message,
    minStakeCents: row.min_stake_cents, maxStakeCents: row.max_stake_cents, maxWinCents: row.max_win_cents,
    maxHouseLossCents: row.max_house_loss_cents, mathId: row.math_id, configVersion: row.config_version,
    currency: currency ? JSON.parse(currency.value).symbol : 'USDT', realMoney: mode ? JSON.parse(mode.value) === 'real' : false,
  };
  cache.set(gameId, { at: now, config });
  return config;
}
export function clearConfigCache() { cache.clear(); }

// What the player's browser may see about a game's live config.
export function publicConfig(config) {
  const head = { gameId: config.gameId, enabled: config.enabled, maintenanceMessage: config.enabled ? null : config.maintenanceMessage,
    minStakeCents: config.minStakeCents, maxStakeCents: config.maxStakeCents, maxWinCents: config.maxWinCents, currency: config.currency };
  if (config.gameId === 'slots') {
    const m = SLOT_MATH;
    return { ...head, math: { id: m.id, label: m.label, rtp: m.rtp, reels: m.reels, rows: m.rows, lineCount: m.lineCount, betLevels: m.betLevels,
      symbols: m.symbols, lines: m.lines, strips: m.strips, pays: m.pays, scatterPays: m.scatterPays, freeSpins: m.freeSpins, capMultiplier: m.capMultiplier } };
  }
  const math = mathOption(config.mathId);
  return { ...head, math: { id: math.id, label: math.label, multipliers: math.multipliers } };
}

// Messages from the admin panel. Audience rules mirror casino-admin's
// audienceSql; here they are evaluated for one player when a trigger fires.
export function matchesAudience(audience, player, walletValues = []) {
  if (!audience || player.status === 'banned') return false;
  if (audience.type === 'all') return player.status === 'active';
  if (audience.type === 'players') {
    const list = (audience.ids || []).map((s) => String(s).trim().toLowerCase());
    return list.includes(String(player.id).toLowerCase()) || walletValues.some((w) => list.includes(String(w).toLowerCase()));
  }
  if (audience.type === 'segment') {
    const f = audience.filters || {};
    if (player.status !== 'active') return false;
    const days = (t) => (Date.now() - Date.parse(String(t).replace(' ', 'T') + 'Z')) / 864e5;
    if (f.joinedWithinDays && days(player.joined_at) > f.joinedWithinDays) return false;
    if (f.inactiveDays && days(player.last_seen_at) < f.inactiveDays) return false;
    if (f.minBetCents && player.total_bet_cents < f.minBetCents) return false;
    if (f.country && player.country !== String(f.country).toUpperCase()) return false;
    if (f.device && player.device !== f.device) return false;
    if (f.hasWallet && !walletValues.length) return false;
    return true;
  }
  return false;
}

export async function triggerMessages(db, player, trigger) {
  const [messages, wallets] = await Promise.all([
    db.prepare("SELECT id, audience_json FROM messages WHERE status = 'active' AND trigger = ? AND is_template = 0").bind(trigger).all(),
    db.prepare("SELECT value FROM player_identities WHERE player_id = ? AND kind = 'wallet'").bind(player.id).all(),
  ]);
  const walletValues = wallets.results.map((w) => w.value);
  const hits = messages.results.filter((m) => { try { return matchesAudience(JSON.parse(m.audience_json), player, walletValues); } catch { return false; } });
  if (hits.length) await db.batch(hits.map((m) => db.prepare("INSERT OR IGNORE INTO message_deliveries (message_id, player_id, channel) VALUES (?, ?, 'site')").bind(m.id, player.id)));
  return hits.length;
}

export async function inbox(db, player) {
  const rows = await db.prepare(`SELECT m.id, m.title, m.body, m.button_label, m.button_url, d.delivered_at, d.seen_at FROM message_deliveries d
    JOIN messages m ON m.id = d.message_id WHERE d.player_id = ? AND d.channel = 'site' AND d.dismissed_at IS NULL ORDER BY d.delivered_at DESC, m.id DESC LIMIT 30`).bind(player.id).all();
  const messages = rows.results.map((r) => ({ id: r.id, title: r.title, body: r.body, buttonLabel: r.button_label, buttonUrl: r.button_url, deliveredAt: r.delivered_at, seen: !!r.seen_at }));
  return { messages, unseen: messages.filter((m) => !m.seen).length };
}

const INBOX_COLUMN = { seen: 'seen_at', click: 'clicked_at', dismiss: 'dismissed_at' };
export async function markInbox(db, player, messageId, action) {
  const column = INBOX_COLUMN[action];
  if (!column || !Number.isSafeInteger(messageId)) return false;
  const extra = action === 'seen' ? '' : ', seen_at = COALESCE(seen_at, datetime(\'now\'))';
  const res = await db.prepare(`UPDATE message_deliveries SET ${column} = COALESCE(${column}, datetime('now'))${extra} WHERE message_id = ? AND player_id = ? AND channel = 'site'`).bind(messageId, player.id).run();
  return (res.meta?.changes ?? 0) > 0;
}
