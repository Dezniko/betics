// The one header shared by the lobby, the roulette page and Gods of Power: which items show on which
// page, in which order, and how portrait phones split them over two short rows. Pure, so the layout
// rules are unit tested and the three pages cannot drift apart.
export const HEADER_ORDER = Object.freeze(['logo', 'lobby', 'lock', 'balance', 'mode', 'mute', 'bell', 'profile']);
export const PAGES = Object.freeze(['lobby', 'roulette', 'slot']);

// Items in header order for a page. The Real/Demo switch shows for everyone (a guest tapping Real
// starts the connect flow), so `connected` changes nothing and is only accepted so callers need not
// change. The Lobby pill and the Next lock pill belong to the games only.
export function headerItems({ page, connected = false, lock = true } = {}) { // eslint-disable-line no-unused-vars
  if (!PAGES.includes(page)) throw new Error(`unknown page ${page}`);
  const game = page !== 'lobby';
  return HEADER_ORDER.filter((id) => {
    if (id === 'lobby') return game;
    if (id === 'lock') return game && lock;
    return true;
  });
}

// Portrait phones: row 1 is logo, balance and the profile controls, row 2 the rest (Lobby, lock,
// Real/Demo, mute, bell). Measured at 320 px: with the bell on row 1 a guest's amount is clipped and the
// logo sits at its 60 px floor, so the bell lives on row 2 beside the mute.
export const ROW_ONE = Object.freeze(['logo', 'balance', 'profile']);
export function phoneRows(items) {
  return { row1: items.filter((id) => ROW_ONE.includes(id)), row2: items.filter((id) => !ROW_ONE.includes(id)) };
}

// The three layouts the header knows, from the viewport.
export function headerLayout(width, height) {
  const landscape = width > height && height < 560;
  if (landscape) return 'landscape';
  return width >= 1000 ? 'desktop' : 'portrait';
}

// What the profile control reads: the short address when connected, else Connect wallet.
export function profilePill({ address = null, connecting = false, shortAddress = (a) => a } = {}) {
  if (address) return { kind: 'connected', text: shortAddress(address) };
  return { kind: 'guest', text: connecting ? 'Connecting...' : 'Connect wallet' };
}

// The small word over the amount: which balance this is. A guest is always on Demo.
export function balanceLabel(mode) {
  return mode === 'real' ? 'REAL BALANCE' : 'DEMO BALANCE';
}

// The bell badge: the unread count capped at 99+, nothing for zero.
export function bellBadge(unseen) {
  const n = Number(unseen) || 0;
  if (n <= 0) return null;
  return n > 99 ? '99+' : String(n);
}

// The same order on every page: the common items of two pages must appear in the same sequence.
export function sameOrder(a, b) {
  const common = a.filter((id) => b.includes(id));
  return JSON.stringify(common) === JSON.stringify(b.filter((id) => a.includes(id)));
}
