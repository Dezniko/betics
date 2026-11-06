// The one header shared by the lobby, the roulette page and Gods of Power: which items show on which
// page, in which order, and how portrait phones split them over two short rows. Pure, so the layout
// rules are unit tested and the three pages cannot drift apart.
export const HEADER_ORDER = Object.freeze(['logo', 'lobby', 'lock', 'balance', 'mode', 'mute', 'profile']);
export const PAGES = Object.freeze(['lobby', 'roulette', 'slot']);

// Items in header order for a page. `connected` shows the Real/Demo switch (a guest has only Demo);
// the Lobby pill and the Next lock pill belong to the games only.
export function headerItems({ page, connected = false, lock = true } = {}) {
  if (!PAGES.includes(page)) throw new Error(`unknown page ${page}`);
  const game = page !== 'lobby';
  return HEADER_ORDER.filter((id) => {
    if (id === 'lobby') return game;
    if (id === 'lock') return game && lock;
    if (id === 'mode') return connected;
    return true;
  });
}

// Portrait phones: row 1 is logo, balance and the profile pill (avatar only), row 2 the rest.
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

// What the profile pill reads: the short address when connected, else Connect wallet.
export function profilePill({ address = null, connecting = false, shortAddress = (a) => a } = {}) {
  if (address) return { kind: 'connected', text: shortAddress(address) };
  return { kind: 'guest', text: connecting ? 'Connecting...' : 'Connect wallet' };
}

// The same order on every page: the common items of two pages must appear in the same sequence.
export function sameOrder(a, b) {
  const common = a.filter((id) => b.includes(id));
  return JSON.stringify(common) === JSON.stringify(b.filter((id) => a.includes(id)));
}
