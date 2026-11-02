// Wallet connection, loaded on demand (dynamic import) so the game paints first.
// With VITE_REOWN_PROJECT_ID set this uses Reown AppKit (WalletConnect, MetaMask,
// mobile wallets). Without it, local QA falls back to the browser wallet
// (window.ethereum) through wagmi's injected() connector.
import { createConfig, http } from 'wagmi';
import { mainnet, sepolia } from 'wagmi/chains';
import { injected } from 'wagmi/connectors';
import { connect, disconnect, getConnection, getChainId, reconnect, signMessage, switchChain, watchConnection, writeContract } from 'wagmi/actions';
import { createSiweMessage } from 'viem/siwe';
import { walletApi, shortAddress } from './walletApi.js';
import { siweFieldsProblem, SIWE_MISMATCH } from './siweCheck.js';
import { CHAIN_ID } from './depositTarget.js';

const ERC20_TRANSFER = [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable',
  inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }];
const WEI_PER_UNIT = 10n ** 16n; // 1 unit = 0.01 TICS, TICS has 18 decimals

const projectId = import.meta.env.VITE_REOWN_PROJECT_ID || '';
const defaultChainId = Number(import.meta.env.VITE_CHAIN_ID || 1);
const chains = defaultChainId === 11155111 ? [sepolia, mainnet] : [mainnet, sepolia];

let config, modal;

async function setup() {
  if (config) return;
  if (projectId) {
    const [{ createAppKit }, { WagmiAdapter }, networks, { coinbaseWallet }] = await Promise.all([
      import('@reown/appkit'), import('@reown/appkit-adapter-wagmi'), import('@reown/appkit/networks'), import('wagmi/connectors')]);
    // Production offers Ethereum only; the test network appears only in a Sepolia build.
    const nets = defaultChainId === 11155111 ? [networks.sepolia] : [networks.mainnet];
    // Our own Coinbase Wallet connector with its analytics beacon off (cca-lite.coinbase.com/amp,
    // which Chrome reports as a blocked cross-origin response). AppKit skips adding its own.
    const icon = `${location.origin}/brand/icon-512.png`;
    const coinbase = coinbaseWallet({ appName: 'qu-BETICS', appLogoUrl: icon, preference: { options: 'all', telemetry: false } });
    const adapter = new WagmiAdapter({ projectId, networks: nets, connectors: [coinbase] });
    modal = createAppKit({ adapters: [adapter], networks: nets, projectId,
      metadata: { name: 'qu-BETICS', description: 'qu-BETICS roulette', url: location.origin, icons: [`${location.origin}/brand/icon-512.png`] },
      features: { analytics: false, email: false, socials: false, swaps: false, onramp: false },
      themeMode: 'dark', themeVariables: { '--w3m-accent': '#a63cff' } });
    config = adapter.wagmiConfig;
  } else {
    config = createConfig({ chains, connectors: [injected()], transports: Object.fromEntries(chains.map((c) => [c.id, http()])) });
  }
  await reconnect(config).catch(() => {});
}

const account = () => { const c = getConnection(config); return c.status === 'connected' ? c.address : null; };

function friendly(e) {
  const text = String(e?.shortMessage || e?.message || e);
  if (/reject|denied|cancel/i.test(text)) return new Error('You cancelled the request in your wallet.');
  if (/no injected|provider not found|connector not found/i.test(text)) return new Error('No wallet found. Install MetaMask or another wallet and try again.');
  return e instanceof Error && !/[\n{]/.test(e.message) ? e : new Error('Your wallet could not finish the request. Please try again.');
}

// Ask the player to pick and unlock a wallet. Resolves with the address.
async function connectAccount() {
  await setup();
  const existing = account();
  if (existing) return existing;
  if (!modal) {
    const r = await connect(config, { connector: config.connectors[0] });
    return r.accounts[0];
  }
  return new Promise((resolve, reject) => {
    let opened = false, stopConn = null, stopModal = null, finished = false;
    const done = () => { finished = true; stopConn?.(); stopModal?.(); modal.close(); };
    stopConn = watchConnection(config, { onChange(c) { if (!finished && c.status === 'connected') { done(); resolve(c.address); } } });
    stopModal = modal.subscribeState((s) => {
      if (s.open) opened = true;
      else if (opened && !finished && !account()) { done(); reject(new Error('You closed the wallet window.')); }
    });
    modal.open({ view: 'Connect' });
  });
}

// Connect, then Sign-In with Ethereum against our own server.
export async function signIn() {
  try {
    const address = await connectAccount();
    const n = await walletApi.nonce();
    if (siweFieldsProblem(n, { host: window.location.host, origin: window.location.origin, chainId: CHAIN_ID })) throw Object.assign(new Error(SIWE_MISMATCH), { status: 400 });
    const message = createSiweMessage({ domain: n.domain, address, uri: n.uri, version: '1', chainId: n.chainId,
      nonce: n.nonce, issuedAt: new Date(), statement: n.statement });
    const signature = await signMessage(config, { account: address, message });
    const result = await walletApi.verify(message, signature);
    return result.profile;
  } catch (e) { throw e?.status ? e : friendly(e); }
}

// ERC-20 transfer of `units` (0.01 TICS) of the official token to the casino wallet.
export async function sendTics({ token, to, units, chainId, from }) {
  try {
    await setup();
    let address = account() || await connectAccount();
    if (from && address.toLowerCase() !== from.toLowerCase()) throw new Error(`Your wallet is on another address. Switch it to ${shortAddress(from)} and try again.`);
    if (getChainId(config) !== chainId) await switchChain(config, { chainId });
    return await writeContract(config, { address: token, abi: ERC20_TRANSFER, functionName: 'transfer',
      args: [to, BigInt(units) * WEI_PER_UNIT], chainId, account: address });
  } catch (e) { throw friendly(e); }
}

export async function disconnectWallet() {
  try { await setup(); await disconnect(config); } catch { /* already disconnected */ }
}
