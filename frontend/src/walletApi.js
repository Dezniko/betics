// Small, dependency-free wallet helpers that ship in the main bundle.
// The heavy wallet libraries (wagmi, viem, Reown AppKit) live in walletConnect.js
// and are only downloaded when a player connects or tops up.

const API = '/api';

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function call(path, { method = 'GET', body } = {}) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch { /* empty body */ }
  if (!r.ok) throw new ApiError((data && data.error) || 'Something went wrong. Please try again.', r.status);
  return data;
}

export const walletApi = {
  nonce: () => call('/wallet/nonce', { method: 'POST', body: {} }),
  verify: (message, signature) => call('/wallet/verify', { method: 'POST', body: { message, signature } }),
  logout: () => call('/wallet/logout', { method: 'POST', body: {} }),
  async me() {
    try {
      const p = await call('/wallet/me');
      return p && typeof p.address === 'string' ? p : null;
    } catch (e) { if (e.status === 401) return null; throw e; }
  },
  saveProfile: (email, consent) => call('/wallet/profile', { method: 'POST', body: { email, consent } }),
  terms: () => call('/wallet/terms', { method: 'POST', body: {} }),
  depositCheck: (txHash) => call('/wallet/deposit/check', { method: 'POST', body: { txHash } }),
  withdrawQuote: () => call('/wallet/withdraw/quote'),
  withdraw: (amountCents, maxFeeCents, requestId) => call('/wallet/withdraw', { method: 'POST', body: { amountCents, maxFeeCents, requestId } }),
  session: () => call('/session', { method: 'POST', body: {} }),
  wallet: () => call('/wallet'),
};

// 0x12ab...9fe0 (three plain dots, as Dez asked)
export function shortAddress(address) {
  if (typeof address !== 'string' || address.length < 12) return address || '';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function explorerTx(chainId, hash) {
  return `${Number(chainId) === 11155111 ? 'https://sepolia.etherscan.io' : 'https://etherscan.io'}/tx/${hash}`;
}

// '12.5' -> 1250 units of 0.01 TICS. null when not a positive amount with at most 2 decimals.
export function parseTicsInput(text) {
  const s = String(text ?? '').trim().replace(/,/g, '');
  if (!/^\d{1,12}(\.\d{0,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const units = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return Number.isSafeInteger(units) && units > 0 ? units : null;
}

// The single place that decides Real or Demo.
// - Demo is only offered when the server says demoAllowed (no real funds, nothing pending).
// - With real funds the game is always in Real and Demo is hidden.
// - Real needs a wallet session and realEnabled; otherwise it is shown as unavailable with a reason.
export function resolveMode({ stored, wallet, profile }) {
  const demoVisible = wallet?.demoAllowed !== false;
  const connected = !!profile?.address;
  const realAvailable = connected && !!profile.realEnabled;
  const realReason = !connected ? 'Connect a wallet to play with real $TICS.' : !profile.realEnabled ? 'Real play is not open yet.' : null;
  if (!demoVisible) return { mode: 'real', demoVisible, realAvailable, realReason };
  return { mode: stored === 'real' && realAvailable ? 'real' : 'demo', demoVisible, realAvailable, realReason };
}

export const balanceField = (mode) => (mode === 'real' ? 'realTicsCents' : 'balanceCents');
export const modeBalance = (wallet, mode) => (wallet ? (mode === 'real' ? wallet.realTicsCents || 0 : wallet.balanceCents) : null);

export const DEPOSIT_TEXT = {
  sending: 'Confirm the transfer in your wallet.',
  pending: 'Sent. Waiting for the network.',
  failed: 'The transfer failed on the network. Nothing was credited.',
  not_tics: 'This is not a $TICS transfer to the casino wallet, so it cannot be credited.',
  below_min: 'This is below the smallest top up, so it was not credited.',
  unmatched: 'Received, but it is not linked to your wallet. Please contact support.',
};
export const DEPOSIT_FINAL = new Set(['credited', 'failed', 'not_tics', 'below_min', 'unmatched']);

// The request id for a withdrawal: the same one again when the player retries the same amount after
// a failed try (the server treats it as the same request), a new one when the amount changed.
export function nextWithdrawRequest(pending, units, newId = () => crypto.randomUUID()) {
  return pending && typeof pending.id === 'string' && pending.amount === units ? pending : { id: newId(), amount: units };
}

// The fee a withdrawal review shows: frozen at the moment the review opened. When the live quote
// moves while the review is open, the new fee is shown and must be confirmed ('Confirm new fee X').
export function withdrawReviewFee({ confirming, frozenFee, fee }) {
  if (!confirming || frozenFee == null) return { shownFee: fee, feeChanged: false };
  const feeChanged = fee !== frozenFee;
  return { shownFee: feeChanged ? fee : frozenFee, feeChanged };
}

export const WITHDRAW_TEXT = { holding: 'Starting', pending: 'Starting', queued: 'Queued', signing: 'Sending', sending: 'Sending', sent: 'Sent',
  failed: 'Failed, money returned', cancelled: 'Cancelled, money returned', cancelling: 'Cancelling', blocked: 'Under review' };
// A short reassurance under the less common states (no dashes, plain words).
export const WITHDRAW_NOTE = {
  holding: 'Your withdrawal is being set up. This takes a moment.',
  pending: 'Your withdrawal is being set up. This takes a moment.',
  cancelling: 'This withdrawal was cancelled. The money is on its way back to your balance.',
  blocked: 'Your money is safe and set aside for you. We are checking this withdrawal and will return it to your balance or send it once the check is done.',
};
// Any status the app does not know yet still reads as plain words, never a code.
export const withdrawText = (status) => WITHDRAW_TEXT[status] || 'Processing';

// The "held" row in the profile. Money is only "on its way" while every open withdrawal is really
// moving; a withdrawal under review or being cancelled means the money is held, not sent.
export function heldRowText(withdrawals = []) {
  const list = Array.isArray(withdrawals) ? withdrawals : [];
  if (list.some((w) => w && (w.status === 'blocked' || w.status === 'cancelling'))) return { title: 'Held for a withdrawal', note: 'Set aside for you, not sent yet' };
  return { title: 'Being withdrawn', note: 'On its way to your wallet' };
}

export const STORAGE = { adult: 'betics:adult:v1', mode: 'betics:mode:v1', deposit: 'betics:deposit:v1' };

// Saved top ups are kept per wallet, so connecting another wallet never deletes this one's.
export const depositKey = (address) => `${STORAGE.deposit}:${String(address || '').toLowerCase()}`;

export const isTxHash = (h) => typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h);
// The top up being tracked, saved in localStorage. Only a well-formed tx hash for this wallet is
// used; anything else returns null so the caller can drop it.
export function readSavedDeposit(raw, address) {
  if (typeof raw !== 'string' || !raw || typeof address !== 'string') return null;
  let d;
  try { d = JSON.parse(raw); } catch { return null; }
  if (!d || typeof d !== 'object' || !isTxHash(d.txHash) || typeof d.address !== 'string' || d.address.toLowerCase() !== address.toLowerCase()) return null;
  return { txHash: d.txHash, address: d.address };
}

// The saved top up of THIS wallet (key per wallet). An entry saved by an older build under the
// shared key is moved over when it belongs to this wallet and left alone when it belongs to another.
export function restoreSavedDeposit(storage, address) {
  if (!storage || typeof address !== 'string' || !address) return null;
  try {
    const key = depositKey(address);
    const raw = storage.getItem(key);
    let d = readSavedDeposit(raw, address);
    if (!d) {
      const legacy = readSavedDeposit(storage.getItem(STORAGE.deposit), address);
      if (legacy) { d = legacy; storage.setItem(key, JSON.stringify(legacy)); storage.removeItem(STORAGE.deposit); }
      else if (raw != null) storage.removeItem(key); // only this wallet's own unreadable entry is dropped
    }
    return d;
  } catch { return null; }
}
export function saveDepositFor(storage, address, txHash) {
  try { storage?.setItem(depositKey(address), JSON.stringify({ txHash, address })); } catch { /* private mode */ }
}
export function clearDepositFor(storage, address) {
  try { storage?.removeItem(depositKey(address)); } catch { /* private mode */ }
}

// After a top up, withdrawals open once Ethereum has confirmed it for good (about 15 minutes).
// sinceIso = when the newest top up that is not final yet was credited (profile.withdrawPendingSince).
export const WITHDRAW_WAIT_MINUTES = 15;
export const TOPUP_WAIT_NOTE = 'You can play as soon as your top up is credited. Withdrawals open about 15 minutes after it arrives, once Ethereum has confirmed it for good.';
export const creditedText = (amount) => `Credited ${amount}. You can play now. Withdrawals open in about 15 minutes.`;
export function withdrawWaitText(sinceIso, now = Date.now()) {
  const since = sinceIso ? Date.parse(sinceIso) : NaN;
  if (!Number.isFinite(since)) return null;
  const left = Math.min(WITHDRAW_WAIT_MINUTES, Math.ceil((since + WITHDRAW_WAIT_MINUTES * 60_000 - now) / 60_000));
  const when = left >= 1 ? `Withdrawals open in about ${left} minute${left === 1 ? '' : 's'}.` : 'Withdrawals open any moment now.';
  return `Your latest top up is still being confirmed on Ethereum. ${when} You can keep playing in the meantime.`;
}
