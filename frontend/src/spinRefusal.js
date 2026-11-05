import { didBetWin } from './rouletteRules.js';
import { fmtShort } from './chips.js';

// Refused spins. Once the browser has sent its random value (clientEntropy) for a lock, ANY refusal
// could be the server dropping a spin it did not like. So every such lock is treated as used: it is
// opened through the same reveal-and-verify path as "Get a new lock" (retireLock), the pocket the
// refused spin would have landed on is worked out in this browser and kept in a local log, and the
// lock is never bet on again.
//
// Refusals are counted in rolling one-hour budgets kept in localStorage:
// - expected (predicted) refusals, the checks the game already makes before Spin (table limit, max
//   bet, max win, balance, Demo/Real mode, maintenance, paused switches, the "several big bets"
//   bankroll guard, a changed payout table): PREDICTED_LIMIT per hour;
// - anything else (unpredicted): REFUSAL_LIMIT per hour.
// Reaching a budget stops betting (stopForVerification).

export const REFUSAL_LIMIT = 3;          // unpredicted refusals per rolling hour
export const PREDICTED_LIMIT = 10;       // predicted refusals per rolling hour
export const REFUSAL_WINDOW_MS = 60 * 60 * 1000;
export const OPEN_LOCK_GRACE_MS = 30 * 1000; // a lock another tab may still be spinning on is left alone this long

const BUDGET_KEYS = { unpredicted: 'betics:refusals:unpredicted:v2', predicted: 'betics:refusals:predicted:v2' };
const BUDGET_LIMITS = { unpredicted: REFUSAL_LIMIT, predicted: PREDICTED_LIMIT };
const OPEN_KEY = 'betics:open-locks:v1';
const LOG_KEY = 'betics:refused-log:v1';
const MAX_OPEN = 50;
export const MAX_REFUSED_LOG = 50;
const MAX_TIMES = 200;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PREDICTED_400 = /total bet must be at least|total bet can be at most|could win more than|over the table limit|most you can bet/i;
const STALE_LOCK = /stale or mismatched expectedCommitment/i;

// 'auth' | 'table_changed' | 'other_tab' | 'stale_lock' | 'predicted' | 'unpredicted' | 'transient'
export function classifySpinRefusal(status, message = '', code = null) {
  const text = String(message || '');
  if (status === 401) return 'auth'; // sign-in expired: never reached the game, not counted
  if (status === 409 && code === 'table_changed') return 'table_changed'; // refused before anything was used
  if (status === 409 && code === 'other_tab') return 'other_tab'; // another tab or game has a fresh round: nothing used, lock untouched
  if (status === 409 && STALE_LOCK.test(text)) return 'stale_lock'; // the lock moved on (another tab or device?)
  if (status === 402) return 'predicted'; // not enough balance
  if (status === 403) return 'predicted'; // Demo/Real mode or account state
  if (status === 503) return 'predicted'; // game off, real play paused, table limit, "several big bets" guard
  if (status === 400 && PREDICTED_400.test(text)) return 'predicted'; // min/max stake, max win, table limit
  // Busy or broken for a moment (rate limit, server or gateway error). The lock is still opened and the
  // refused pocket logged, so a short outage uses the larger budget instead of stopping honest play.
  if (status === 429 || status >= 500) return 'transient';
  return 'unpredicted';
}
// Which budget a refusal class counts against (null = not counted).
export function budgetFor(kind) {
  if (kind === 'predicted' || kind === 'table_changed' || kind === 'transient') return 'predicted';
  if (kind === 'unpredicted' || kind === 'stale_lock' || kind === 'other_device') return 'unpredicted';
  return null;
}

export const SIGN_IN_EXPIRED_MESSAGE = 'Your sign-in expired. Please connect your wallet again.';
// Fallback when the server's own 'other tab' text is missing (the server text is shown when present).
export const OTHER_TAB_MESSAGE = 'You are playing in another tab or game. Finish that round first.';
export const REFUSAL_NO_LOCK_MESSAGE = 'The spin was refused and a new lock could not be checked. Betting is paused. Reload the page to try again.';
export const TABLE_CHANGED_MESSAGE = 'The payout table changed. Please check it and confirm again.';
export const LOST_REPLY_MESSAGE = 'The connection dropped before the spin was confirmed, and the server has no record of it, so your bet was not taken. The lock was opened and checked, and a new one is ready. You can spin again.';
export const LOST_REPLY_PAUSED_MESSAGE = 'The connection dropped before the spin was confirmed. Betting is paused until the game can check the lock. Reload the page to go on.';
export const OTHER_DEVICE_MESSAGE = 'Your lock was used by a spin in another tab or on another device, so the game picked up the new lock. This bet was not taken. It counts toward the safety limit for refused spins. You can spin again.';
// The lock was used by a spin this page did not make while no other tab of the game was open.
export const OTHER_DEVICE_ALONE_MESSAGE = 'Your lock was used by a spin this tab did not make, so this bet was not taken. That is normal if you also play on another device. If you do not, please contact support. It counts toward the safety limit for refused spins.';
export const OWN_ROUND_SWAPPED_MESSAGE = 'An earlier spin of yours does not use the random value this browser sent. Betting is stopped. Inspect the round before continuing.';
export const STALE_LOCK_MESSAGE = 'The server says your lock changed, but it did not show the old key. Betting is paused. Reload the page or contact support.';
export const NEVER_OPENED_MESSAGE = 'An earlier spin used a lock the server never opened, so this page could not check it. It counts toward the safety limit for refused spins.';

const clean = (s) => String(s || '').replace(/[\u2013\u2014]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 160);
// Toast text after a refused spin whose lock was opened and checked. Shows the server's own reason.
export function refusalRetiredMessage(reason, { checked = false, wouldHave = '' } = {}) {
  const why = clean(reason);
  return `${why ? `The server refused the spin: ${why}${/[.!?]$/.test(why) ? '' : '.'} ` : 'The server refused the spin. '}${checked ? 'This page checked your balance and the limits, and they allowed this bet, so it counts toward the safety limit. ' : ''}Your bet was not taken. ${wouldHave ? `${wouldHave} ` : ''}That lock now counts as used, so the game opened it, checked it and made a new one. You can spin again.`;
}
// Accurate wording for a reached budget: how many refusals, of which kind, in which window.
export function refusalStopMessage(budget, count) {
  const n = Number.isSafeInteger(count) && count > 0 ? count : budget === 'predicted' ? PREDICTED_LIMIT : REFUSAL_LIMIT;
  return budget === 'predicted'
    ? `The server turned down ${n} spins in the last hour. To keep you safe, betting is stopped. Please reload the page later or contact support.`
    : `The server turned down ${n} spins in the last hour for a reason this page could not check. To keep you safe, betting is stopped. Please reload the page later or contact support.`;
}

function store() { try { return globalThis.localStorage; } catch { return null; } }
function readJson(storage, key) { try { return JSON.parse(storage?.getItem(key) || 'null'); } catch { return null; } }
function writeJson(storage, key, value) { try { storage?.setItem(key, JSON.stringify(value)); } catch { /* private mode: best effort */ } }

// ---- rolling budgets ----
export function readRefusalTimes(budget, now = Date.now(), storage = store()) {
  const list = readJson(storage, BUDGET_KEYS[budget]);
  if (!Array.isArray(list)) return [];
  // Validated on read: numbers inside the window and not in the future (a small clock skew is allowed).
  return list.filter((t) => Number.isFinite(t) && t > now - REFUSAL_WINDOW_MS && t <= now + 60000).slice(-MAX_TIMES);
}
export function readRefusalCount(budget = 'unpredicted', now = Date.now(), storage = store()) { return readRefusalTimes(budget, now, storage).length; }
// Records one refusal and returns { budget, count, limit, reached }.
export function recordRefusal(budget, now = Date.now(), storage = store()) {
  if (!BUDGET_KEYS[budget]) throw new Error('unknown refusal budget');
  const times = [...readRefusalTimes(budget, now, storage), now].slice(-MAX_TIMES);
  writeJson(storage, BUDGET_KEYS[budget], times);
  const limit = BUDGET_LIMITS[budget];
  return { budget, count: times.length, limit, reached: times.length >= limit };
}
export function refusalLimitReached(count, budget = 'unpredicted') { return Number.isSafeInteger(count) && count >= BUDGET_LIMITS[budget]; }

// ---- locks whose random value was sent but whose key this browser has not checked yet ----
// Entry: { identity, serverSeedHash, clientSeed, nonce, clientEntropy, requestId, at, refused, counted }
// `refused`: the server answered with a refusal. `counted`: already counted (or never to be counted).
function validOpenLock(e) {
  return !!e && typeof e === 'object' && typeof e.identity === 'string' && e.identity.length > 0 && e.identity.length <= 64
    && HASH.test(e.serverSeedHash || '') && typeof e.clientSeed === 'string' && e.clientSeed.length > 0 && e.clientSeed.length <= 64
    && Number.isSafeInteger(e.nonce) && e.nonce >= 0 && HASH.test(e.clientEntropy || '') && UUID.test(e.requestId || '')
    && Number.isFinite(e.at) && typeof e.refused === 'boolean' && typeof e.counted === 'boolean';
}
export function readOpenLocks(storage = store()) {
  const list = readJson(storage, OPEN_KEY);
  return Array.isArray(list) ? list.filter(validOpenLock).slice(-MAX_OPEN) : [];
}
export function rememberOpenLock(entry, storage = store()) {
  const e = { refused: false, counted: false, at: Date.now(), ...entry };
  if (!validOpenLock(e)) throw new Error('invalid open lock');
  const list = [...readOpenLocks(storage).filter((x) => x.serverSeedHash !== e.serverSeedHash), e].slice(-MAX_OPEN);
  writeJson(storage, OPEN_KEY, list);
  return e;
}
export function updateOpenLock(hash, patch, storage = store()) {
  const list = readOpenLocks(storage).map((x) => (x.serverSeedHash === hash ? { ...x, ...patch } : x)).filter(validOpenLock);
  writeJson(storage, OPEN_KEY, list);
  return list.find((x) => x.serverSeedHash === hash) || null;
}
export function forgetOpenLock(hash, storage = store()) {
  const list = readOpenLocks(storage).filter((x) => x.serverSeedHash !== hash);
  writeJson(storage, OPEN_KEY, list);
  return list;
}
export function findOpenLock(hash, identity, storage = store()) {
  return readOpenLocks(storage).find((x) => x.serverSeedHash === hash && x.identity === identity) || null;
}
// A current lock must be opened through the reveal before betting when it saw a refusal, or when
// its spin was sent long enough ago that no tab can still be waiting for it.
export function mustRetireLock(entry, now = Date.now()) {
  return !!entry && (entry.refused || now - entry.at > OPEN_LOCK_GRACE_MS);
}
// Locks of this player that are no longer the current lock and need a look in the round history.
export function locksToCheck(identity, currentHash, now = Date.now(), storage = store()) {
  return readOpenLocks(storage).filter((x) => x.identity === identity && x.serverSeedHash !== currentHash && mustRetireLock(x, now));
}
// The round in GET /api/rounds that used this lock, and whether it was this browser's own spin.
export function findRoundForLock(rounds, entry) {
  if (!Array.isArray(rounds) || !entry) return null;
  const round = rounds.find((r) => r && r.server_seed_hash === entry.serverSeedHash);
  if (!round) return null;
  return { round, own: (!!round.request_id && round.request_id === entry.requestId) || (!!round.client_entropy && round.client_entropy === entry.clientEntropy) };
}

// An "own" round (same request or same random value) must use exactly what this browser sent: the
// lucky word plus its own random value, the same nonce and the same request. Anything else means the
// server swapped in inputs of its own. Returns the list of problems (empty = fine).
export function ownRoundProblems(round, entry) {
  if (!round || !entry) return ['missing round'];
  const problems = [];
  if (round.request_id !== entry.requestId) problems.push('request changed');
  if (round.client_seed !== `${entry.clientSeed}:${entry.clientEntropy}`) problems.push('your random value was not used');
  if (round.client_entropy != null && round.client_entropy !== entry.clientEntropy) problems.push('random value changed');
  if (round.nonce !== entry.nonce) problems.push('spin number changed');
  return problems;
}

// ---- refused spins log: what each refused spin would have landed on ----
// Entry: { at, lock, pocket (0..36, or null when the key was never shown), won (total payout it would
// have paid, stake included, or null when the bets are not known), kind, reason }
const LOG_KINDS = new Set(['predicted', 'unpredicted', 'table_changed', 'auth', 'stale_lock', 'lost', 'never_opened', 'other_device', 'transient']);
function validLog(e) {
  return !!e && typeof e === 'object' && Number.isFinite(e.at) && HASH.test(e.lock || '') && LOG_KINDS.has(e.kind)
    && (e.pocket === null || (Number.isInteger(e.pocket) && e.pocket >= 0 && e.pocket <= 36))
    && (e.won == null || (Number.isSafeInteger(e.won) && e.won >= 0)) && typeof e.reason === 'string' && e.reason.length <= 200;
}
export function readRefusedLog(storage = store()) {
  const list = readJson(storage, LOG_KEY);
  return Array.isArray(list) ? list.filter(validLog).slice(-MAX_REFUSED_LOG) : [];
}
export function addRefusedSpin({ at = Date.now(), lock, pocket = null, won = null, kind, reason = '' }, storage = store()) {
  const e = { at, lock, pocket, won: pocket === null ? null : won, kind, reason: clean(reason) };
  if (!validLog(e)) return readRefusedLog(storage);
  const list = [...readRefusedLog(storage).filter((x) => x.lock !== lock), e].slice(-MAX_REFUSED_LOG);
  writeJson(storage, LOG_KEY, list);
  return list;
}
export function refusedSpinText(e) {
  if (e.pocket === null) return 'Refused spin: the lock was never opened';
  return `Refused spin: would have been ${e.pocket}${e.won > 0 ? `, would have won ${fmtShort(e.won)}` : ''}`;
}

// What a refused (or voided) spin would have paid on this pocket: total payout, stake included, with
// the payout table the player agreed to before the bet. null when the bets or table are not known.
export function wouldHaveWon(bets, pocket, multipliers) {
  if (!Array.isArray(bets) || !bets.length || !multipliers || !Number.isInteger(pocket) || pocket < 0 || pocket > 36) return null;
  let total = 0;
  for (const bet of bets) {
    const mult = multipliers[bet?.type];
    if (!Number.isFinite(mult) || !Number.isSafeInteger(bet.amountCents)) return null;
    if (didBetWin(bet, pocket)) total += Math.floor(bet.amountCents * mult);
  }
  return total;
}
// One plain sentence for a toast: where the spin would have landed and what it would have paid.
export function wouldHaveText(pocket, won) {
  if (!Number.isInteger(pocket)) return '';
  return won > 0 ? `Had it gone ahead, it would have landed on ${pocket} and won ${fmtShort(won)}.` : `Had it gone ahead, it would have landed on ${pocket}.`;
}

// After a failed request, a commitment fetched from the server may only be accepted when it is the
// same lock the browser already had. A different lock without the old key being shown is refused.
export function canAcceptReloadedLock(next, previousHash) {
  if (!previousHash) return true;
  return !!next && next.serverSeedHash === previousHash;
}

// L7: the balance before a spin was stale. A "credited too little" mismatch is only accepted when it
// is the ONLY problem, the balance this browser used was not fetched right before the spin, and the
// balance read again now is at least what it should be after this spin (balance before - stake +
// payout). A lower balance is never explained away as "another device": it is always flagged.
export function isBalanceResync({ terms, data, settlement, freshBalance }) {
  if (!terms || !data || !settlement || settlement.ok) return false;
  if (!Array.isArray(settlement.problems) || settlement.problems.length !== 1 || settlement.problems[0] !== 'balance credited too little') return false;
  if (terms.balanceFresh) return false;
  if (!Number.isSafeInteger(freshBalance) || !Number.isSafeInteger(terms.balanceBefore)) return false;
  return freshBalance >= terms.balanceBefore - settlement.stake + settlement.payout;
}
export const BALANCE_RESYNC_MESSAGE = 'The balance in the spin reply looked low, so it was read again. It is correct now.';
export function shortCreditMessage(expected, actual) {
  const have = Number.isSafeInteger(actual) ? ` Your balance shows ${fmtShort(actual)}, but after this spin it should be at least ${fmtShort(expected)}.` : '';
  return `Payout check failed: your balance was credited too little.${have} Betting is stopped. Inspect the round before continuing.`;
}

// A spin request that gets no full reply in this time counts as a lost reply: the lock stays in the
// open locks list and is checked in the round history, exactly like a dropped connection.
export const SPIN_TIMEOUT_MS = 30 * 1000;
// POST with a timeout. Returns { resp, data }; resp is null when the request failed or timed out.
// Which tab is playing: the wallet refuses a spin from a second tab or game while a round from the first
// is still fresh. The id comes from tabPresence (sessionStorage) so a reload keeps it.
export const PLAY_TAB_HEADER = 'X-Play-Tab';
export function playTabHeader() {
  try {
    const id = globalThis.sessionStorage?.getItem?.('betics:tab-id:v1');
    return id ? { [PLAY_TAB_HEADER]: id } : {};
  } catch { return {}; }
}
export async function postJsonWithTimeout(url, bodyText, { fetchFn = globalThis.fetch, ms = SPIN_TIMEOUT_MS } = {}) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => { try { ctrl?.abort(); } catch { /* ignore */ } resolve('timeout'); }, ms); });
  try {
    const work = (async () => {
      const resp = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json', ...playTabHeader() }, body: bodyText, ...(ctrl ? { signal: ctrl.signal } : {}) });
      let data = null;
      try { data = await resp.json(); } catch { data = null; }
      return { resp, data };
    })();
    const r = await Promise.race([work, timeout]);
    if (r === 'timeout') { work.catch(() => {}); return { resp: null, data: null, timedOut: true }; }
    return r;
  } catch { return { resp: null, data: null }; } finally { clearTimeout(timer); }
}

// M4: the server alone must not decide that a refusal was "expected". When the page's own figures
// say the bet was allowed (enough balance, stake inside the limits, possible win inside max win and
// the table limit), the refusal counts as unexpected, in the strict budget.
// known: { balance, stake, worstPayout, minStake, maxStake, maxWin, tableLimit } (any may be missing).
export function checkRefusalAgainstKnown(kind, status, message = '', known = {}) {
  if (kind !== 'predicted' || !known) return kind;
  const text = String(message || '');
  const n = (v) => Number.isSafeInteger(v) && v > 0;
  const { balance, stake, worstPayout, minStake, maxStake, maxWin, tableLimit } = known;
  if (!Number.isSafeInteger(stake) || stake <= 0) return kind;
  if (status === 402) return Number.isSafeInteger(balance) && balance >= stake ? 'unpredicted' : kind;
  if (/total bet must be at least/i.test(text)) return n(minStake) && stake >= minStake ? 'unpredicted' : kind;
  if (/total bet can be at most/i.test(text)) return n(maxStake) && stake <= maxStake ? 'unpredicted' : kind;
  if (/could win more than/i.test(text)) return n(maxWin) && Number.isSafeInteger(worstPayout) && worstPayout <= maxWin ? 'unpredicted' : kind;
  // The table limit moves with every other player's spins and wins, and the page's figure can be a minute old,
  // so a table limit refusal is never treated as unexpected on that figure alone.
  return kind;
}
