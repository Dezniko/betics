// $TICS on Ethereum: constants, unit conversion, address checks, a small
// JSON-RPC client and Transfer-log decoding. Shared by the game Worker and the
// payouts Worker. Amounts in the platform are integer units of 0.01 TICS.
import { getAddress, isAddress, encodeFunctionData, decodeEventLog, parseAbi } from 'viem';

export const OFFICIAL_TICS = '0x551ecfdba071cb6541f642cb90a073c8c158df05';
export const TOKEN_DECIMALS = 18;
export const UNIT_DECIMALS = 2;
const WEI_PER_UNIT = 10n ** BigInt(TOKEN_DECIMALS - UNIT_DECIMALS);
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const ERC20_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
export const MAX_UNITS = 9_007_199_254_740_991; // Number.MAX_SAFE_INTEGER

export const DEFAULT_TICS = {
  chainId: 1, token: OFFICIAL_TICS, casinoWallet: null, treasuryAddress: null, confirmations: 12, startBlock: null,
  // Deposits up to quickDepositMaxUnits are credited after quickConfirmations; bigger ones wait for `confirmations`. 0 turns the quick path off.
  quickConfirmations: 3, quickDepositMaxUnits: 100_000_000,
  // Rolling cap per sending wallet: quick-lane credits in the last 24 hours. Past it, deposits wait for the full depth.
  quickDailyMaxUnits: null, // null = same as quickDepositMaxUnits
  realEnabled: false, depositsOpen: true, withdrawalsOpen: true, payoutsPaused: false, pausedReason: null,
  minDepositUnits: 100, minWithdrawalUnits: 10_000_000, feesEnabled: true, gasFeeMarginPct: 20, fallbackFeeUnits: 50000, coolingSeconds: 120,
  largeWithdrawalAlertUnits: 5_000_000, lowFloatUnits: 0, highFloatUnits: 0, lowEthWei: '5000000000000000', demoStartUnits: 10_000_000,
  // One real spin may at most win this share of the casino's free float (wallet minus what players are owed),
  // so several players winning at the same moment are still covered.
  maxSpinExposurePct: 25,
};

export async function ticsSettings(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'tics_payments'").first();
  return { ...DEFAULT_TICS, ...(row ? JSON.parse(row.value) : {}) };
}
export async function saveTicsSettings(db, next) {
  await db.prepare(`INSERT INTO settings (key, value) VALUES ('tics_payments', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
    .bind(JSON.stringify(next)).run();
}

// Lowercase 0x address, or null. Accepts any valid checksum or all-lowercase form.
export function normAddress(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  // strict: a mixed-case address must carry a correct EIP-55 checksum; all-lowercase is accepted.
  if (!isAddress(value, { strict: true })) return null;
  return value.toLowerCase();
}
export const checksum = (address) => getAddress(address);
export const isTxHash = (value) => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);

// 18-decimal wei amount -> whole 0.01 TICS units, rounded down. BigInt only.
export function weiToUnits(wei) {
  const units = BigInt(wei) / WEI_PER_UNIT;
  if (units > BigInt(MAX_UNITS)) throw new Error('amount too large');
  return Number(units);
}
export function unitsToWei(units) {
  if (!Number.isSafeInteger(units) || units < 0) throw new Error('invalid units');
  return BigInt(units) * WEI_PER_UNIT;
}
export function formatTics(units) {
  const sign = units < 0 ? '-' : '';
  const abs = Math.abs(units);
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  return `${sign}${whole}.${String(abs % 100).padStart(2, '0')} $TICS`;
}

// Minimal JSON-RPC client; fetchImpl is injectable for tests.
// Every call has a deadline (a node that never answers must not hold the payout queue or a cron run).
// The error says "timed out", which every caller treats as an outage (unclear), never as a clear refusal.
// fallbackUrl (optional, a second independent provider): used only if the FIRST call of this client
// fails with an outage, and then for every later call of the client. A switch half way is never made:
// a deposit scan that read the block height from one node and the logs from another (a node a block or
// two behind) could skip transfers, so a later failure just fails this run and the next run starts over.
export const RPC_TIMEOUT_MS = 20_000;
export function rpcClient(url, fetchImpl = fetch, { fallbackUrl = null, timeoutMs = RPC_TIMEOUT_MS } = {}) {
  let id = 0, active = null;
  const call = async (target, method, params) => {
    if (!target) throw new Error('Ethereum RPC is not configured');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    let res, body;
    try {
      res = await fetchImpl(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: controller.signal });
      body = await res.json().catch(() => null);
    } catch (error) {
      if (controller.signal.aborted) { const e = new Error(`RPC ${method} timed out after ${Math.round(timeoutMs / 1000)} s`); e.outage = true; throw e; }
      error.outage = true; throw error;
    } finally { clearTimeout(timer); }
    // The provider's own error text (never contains the key) makes limits like Alchemy's 10-block log range visible in the logs.
    if (!res.ok || !body) { const e = new Error(`RPC ${method} failed with HTTP ${res.status}${body?.error?.message ? `: ${String(body.error.message).slice(0, 200)}` : ''}`); e.outage = res.status === 429 || res.status >= 500 || !body; throw e; }
    if (body.error) { const e = new Error(`RPC ${method}: ${body.error.message || 'error'}`); e.rpc = body.error; throw e; }
    return body.result;
  };
  const rpc = async function rpc(method, params = []) {
    if (active) return call(active, method, params);
    try { const result = await call(url, method, params); active = url; return result; } catch (error) {
      if (!fallbackUrl || !url || !error.outage) throw error;
      const result = await call(fallbackUrl, method, params);
      active = fallbackUrl;
      return result;
    }
  };
  rpc.provider = () => active; // which URL this client settled on (null before its first answer)
  return rpc;
}
export function rpcUrl(env, chainId) {
  if (env.ETH_RPC_URL) return env.ETH_RPC_URL;
  if (!env.ALCHEMY_API_KEY) return null;
  const net = chainId === 1 ? 'eth-mainnet' : chainId === 11155111 ? 'eth-sepolia' : null;
  return net ? `https://${net}.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}` : null;
}
export const hexToNumber = (h) => Number(BigInt(h));
const pad32 = (address) => `0x${address.slice(2).padStart(64, '0')}`;

// Decodes ERC-20 Transfer logs of the given token sent to `to`. Anything else is dropped.
export function decodeTransfers(logs, token, to) {
  const out = [];
  for (const log of logs || []) {
    if (log.removed) continue;
    if (String(log.address).toLowerCase() !== token) continue;
    if (!log.topics || log.topics[0] !== TRANSFER_TOPIC || log.topics.length !== 3) continue;
    let ev;
    try { ev = decodeEventLog({ abi: ERC20_ABI, data: log.data, topics: log.topics }); } catch { continue; }
    if (ev.eventName !== 'Transfer') continue;
    const dest = ev.args.to.toLowerCase();
    if (dest !== to) continue;
    out.push({ txHash: String(log.transactionHash).toLowerCase(), logIndex: hexToNumber(log.logIndex), blockNumber: hexToNumber(log.blockNumber),
      from: ev.args.from.toLowerCase(), to: dest, amountWei: ev.args.value.toString() });
  }
  return out;
}
export function transferLogsFilter(token, to, fromBlock, toBlock) {
  return { address: token, topics: [TRANSFER_TOPIC, null, pad32(to)], fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}` };
}
export async function tokenBalance(rpc, token, owner) {
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] });
  return BigInt(await rpc('eth_call', [{ to: token, data }, 'latest']));
}
export const transferData = (to, wei) => encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [getAddress(to), wei] });

// Confirmations a deposit of `units` needs before it is credited.
export function confirmationsFor(settings, units) {
  const full = settings.confirmations;
  const quick = Math.max(1, Math.min(full, settings.quickConfirmations || full));
  return settings.quickDepositMaxUnits > 0 && units <= settings.quickDepositMaxUnits ? quick : full;
}
