// Which tabs of this game are open in this browser. Each tab writes a heartbeat into localStorage
// every few seconds. When the server says the lock was used by a spin this page did not make, the
// game asks whether any other tab was alive recently: if not, that "other spin" could only have come
// from another device, or from the server itself.
const KEY = 'betics:tabs:v2';
const SESSION_KEY = 'betics:tab-id:v1';
export const HEARTBEAT_MS = 5 * 1000;
export const OTHER_TAB_WINDOW_MS = 2 * 60 * 1000; // another tab seen this recently could have used the lock
const MAX_TABS = 20;

function local() { try { return globalThis.localStorage; } catch { return null; } }
function session() { try { return globalThis.sessionStorage; } catch { return null; } }
function read(storage) {
  try {
    const m = JSON.parse(storage?.getItem(KEY) || '{}');
    if (!m || typeof m !== 'object' || Array.isArray(m)) return {};
    const out = {};
    for (const [k, v] of Object.entries(m)) if (v && Number.isFinite(v.t)) out[k] = { t: v.t, c: v.c === true };
    return out;
  } catch { return {}; }
}
function write(storage, m) { try { storage?.setItem(KEY, JSON.stringify(m)); } catch { /* private mode: best effort */ } }

export function newTabId() {
  try { return globalThis.crypto.randomUUID(); } catch { return `t${Date.now()}${Math.random().toString(16).slice(2)}`; }
}

// Records this tab as alive and drops tabs not seen for a while.
export function beat(id, now = Date.now(), storage = local(), closed = false) {
  const next = {};
  for (const [k, v] of Object.entries(read(storage))) if (now - v.t < OTHER_TAB_WINDOW_MS && v.t <= now + 60000) next[k] = v;
  next[id] = { t: now, c: closed };
  write(storage, Object.fromEntries(Object.entries(next).sort((a, b) => b[1].t - a[1].t).slice(0, MAX_TABS)));
}
// True when another tab of this game was alive within the window. A tab that was closed still
// counts until the window ends, because it may have spun on the lock just before it closed.
export function otherTabRecently(id, now = Date.now(), storage = local(), windowMs = OTHER_TAB_WINDOW_MS) {
  return Object.entries(read(storage)).some(([k, v]) => k !== id && now - v.t <= windowMs && v.t <= now + 60000);
}

// The id of this tab. A reload of the same tab keeps its id (its entry was marked closed when the
// page went away), so the page it replaced is not mistaken for another tab. A duplicated tab copies
// sessionStorage while the original is still open, so it gets a new id.
export function tabIdFor(sessionStore = session(), storage = local()) {
  const saved = sessionStore?.getItem?.(SESSION_KEY);
  const entry = saved ? read(storage)[saved] : null;
  const id = saved && (!entry || entry.c) ? saved : newTabId();
  try { sessionStore?.setItem?.(SESSION_KEY, id); } catch { /* best effort */ }
  return id;
}

// Starts the heartbeat for this tab. Returns { id, stop }.
export function startPresence({ storage = local(), sessionStore = session() } = {}) {
  const id = tabIdFor(sessionStore, storage);
  beat(id, Date.now(), storage);
  const timer = setInterval(() => beat(id, Date.now(), storage), HEARTBEAT_MS);
  const onHide = () => beat(id, Date.now(), storage, true);
  const onShow = () => beat(id, Date.now(), storage);
  if (typeof window !== 'undefined') { window.addEventListener('pagehide', onHide); window.addEventListener('pageshow', onShow); }
  return { id, stop: () => { clearInterval(timer); if (typeof window !== 'undefined') { window.removeEventListener('pagehide', onHide); window.removeEventListener('pageshow', onShow); } } };
}
