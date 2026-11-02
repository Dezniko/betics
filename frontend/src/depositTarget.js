// The only token and casino wallet the game will ever send a top up to. These are pinned in the
// page itself, so a changed server reply cannot redirect a deposit. A build for another network
// sets VITE_TICS_TOKEN / VITE_CASINO_WALLET.
const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};

// Official $TICS (ERC-20 on Ethereum). Terms.jsx shows this same constant.
export const TICS_CONTRACT = '0x551ecFDBa071cB6541f642cB90a073c8c158Df05';
export const OFFICIAL_TICS = env.VITE_TICS_TOKEN || TICS_CONTRACT;
export const CASINO_WALLET = env.VITE_CASINO_WALLET || '0x0400e48587a43078c72158fb5c2e482d181754db';

// The network top ups are sent on. Pinned in the page like the addresses (VITE_CHAIN_ID, default
// Ethereum mainnet), never taken from the server reply.
const chain = Number(env.VITE_CHAIN_ID || 1);
export const CHAIN_ID = Number.isSafeInteger(chain) && chain > 0 ? chain : 1;

export const DEPOSITS_CLOSED_MESSAGE = 'Top ups are closed right now.';
export const DEPOSIT_PAUSED_MESSAGE = 'Top ups are paused while we check the casino wallet. Please contact support.';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && ADDRESS.test(a) && ADDRESS.test(b) && a.toLowerCase() === b.toLowerCase();

// null when the server's token and casino wallet are the pinned ones, else a reason (never shown raw).
export function depositTargetProblem(profile, pinned = { token: OFFICIAL_TICS, wallet: CASINO_WALLET }) {
  if (!profile) return 'no profile';
  if (!sameAddress(profile.token, pinned.token)) return 'token differs';
  if (!sameAddress(profile.casinoWallet, pinned.wallet)) return 'casino wallet differs';
  return null;
}

// Etherscan page of an address on the pinned network. Built only from page constants, never from a
// server reply, so a changed reply cannot point the player at another wallet.
export function etherscanAddress(chainId, address) {
  return `${Number(chainId) === 11155111 ? 'https://sepolia.etherscan.io' : 'https://etherscan.io'}/address/${address}`;
}
export const PINNED_WALLET_URL = etherscanAddress(CHAIN_ID, CASINO_WALLET);

// The reserve card may only say "covered" when the server reports the pinned casino wallet on the
// pinned network. Anything else: the figures cannot be tied to the wallet the player can check.
export function reserveWalletMatches(reserve, pinned = { wallet: CASINO_WALLET, chainId: CHAIN_ID }) {
  return !!reserve && sameAddress(reserve.wallet, pinned.wallet) && Number(reserve.chainId) === pinned.chainId;
}

// What the Top up tab shows: 'closed' when top ups are switched off or the server has no casino
// wallet (checked first, so a closed cashier never reads as a wallet problem), 'paused' when the
// server's token or casino wallet differs from the pinned ones, else 'open'.
export function topUpState(profile, pinned) {
  if (!profile || !profile.depositsOpen || profile.casinoWallet == null || profile.casinoWallet === '') return 'closed';
  return depositTargetProblem(profile, pinned) ? 'paused' : 'open';
}
