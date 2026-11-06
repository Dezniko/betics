// When the shared session hook reads /api/wallet/me again. Pure, so the schedule is unit tested.
// - hidden tab: no polling at all (the next read happens the moment the tab is visible or focused);
// - playing (a round settled in the last minute, or a round in flight): every 10 s, so a session closed
//   by a sign in from another browser (401 signed_in_elsewhere) is noticed within about 15 s;
// - idle and visible: every 30 s.
export const ME_POLL_MS = 10 * 1000;
export const ME_POLL_IDLE_MS = 30 * 1000;
export const PLAY_RECENT_MS = 60 * 1000;

export function isPlaying({ lastRoundAt = null, busy = false, now = Date.now() } = {}) {
  if (busy) return true;
  return Number.isFinite(lastRoundAt) && now - lastRoundAt < PLAY_RECENT_MS && lastRoundAt <= now + 60 * 1000;
}

// Milliseconds until the next poll, or null for "do not poll" (hidden tab or not connected).
export function pollDelayMs({ connected = true, visible = true, lastRoundAt = null, busy = false, now = Date.now() } = {}) {
  if (!connected || !visible) return null;
  return isPlaying({ lastRoundAt, busy, now }) ? ME_POLL_MS : ME_POLL_IDLE_MS;
}

// Should a visibility or focus change trigger an immediate read? Only when the page became visible.
export function refreshOnVisibility({ connected = true, visible = true } = {}) {
  return connected && visible;
}
