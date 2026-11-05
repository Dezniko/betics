// Browser side of the "one game, one tab" rule. The wallet refuses a spin from a second tab or game
// within 8 s of a round (409 other_tab, nothing used). To warn the player BEFORE that refusal, every
// game tab announces each spin it starts on a BroadcastChannel; a game tab that hears an announcement
// from a different tab shows a dismissible cover ("Playing in another tab. Tap to play here.").
// Pure helpers here, so the rule is unit tested without a browser.
export const PLAY_CHANNEL = 'betics-play';
export const OTHER_TAB_WINDOW_MS = 8 * 1000;
const GAMES = new Set(['roulette', 'godsofpower']);
export const COVER_TEXT = 'Playing in another tab. Tap to play here.';

export function makeAnnouncement(game, tab, at = Date.now()) {
  return { game, tab, at };
}
export function isAnnouncement(m) {
  return !!m && typeof m === 'object' && GAMES.has(m.game) && typeof m.tab === 'string' && m.tab.length > 0 && m.tab.length <= 64 && Number.isFinite(m.at);
}
// True when the message is a valid announcement from ANOTHER tab, made within the window (a message
// stamped in the far future is ignored: a wrong clock must not pin a cover on the screen).
export function isForeignRecent(m, tab, now = Date.now(), windowMs = OTHER_TAB_WINDOW_MS) {
  return isAnnouncement(m) && m.tab !== tab && now - m.at <= windowMs && m.at <= now + 60 * 1000;
}

// Opens the channel. announce() tells the other tabs this tab is spinning; onForeign(cb) fires with
// { game, tab, at } for every recent announcement from another tab; stop() closes everything.
// channelFactory lets tests pass a fake channel; without BroadcastChannel the guard is a no-op.
export function createPlayGuard({ game, tab, now = Date.now, channelFactory = defaultChannelFactory } = {}) {
  const listeners = new Set();
  let channel = null;
  try { channel = channelFactory(PLAY_CHANNEL); } catch { channel = null; }
  const onMessage = (ev) => {
    const m = ev && 'data' in ev ? ev.data : ev;
    if (!isForeignRecent(m, tab, now())) return;
    listeners.forEach((fn) => { try { fn(m); } catch { /* one listener must not break the others */ } });
  };
  if (channel) channel.onmessage = onMessage;
  return {
    announce() {
      const m = makeAnnouncement(game, tab, now());
      try { channel?.postMessage(m); } catch { /* channel closed */ }
      return m;
    },
    onForeign(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    stop() { listeners.clear(); try { channel?.close(); } catch { /* already closed */ } channel = null; },
  };
}
function defaultChannelFactory(name) {
  return typeof BroadcastChannel === 'function' ? new BroadcastChannel(name) : null;
}

// How long a cover should stay up after the latest foreign announcement (0 = take it down now).
export function coverRemainingMs(lastForeignAt, now = Date.now(), windowMs = OTHER_TAB_WINDOW_MS) {
  if (!Number.isFinite(lastForeignAt)) return 0;
  return Math.max(0, lastForeignAt + windowMs - now);
}
