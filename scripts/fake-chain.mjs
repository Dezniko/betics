#!/usr/bin/env node
// Local fake Ethereum JSON-RPC node for end-to-end QA (never used in production).
//   node scripts/fake-chain.mjs [port]     default 8545, chain id 1
// It holds ERC-20 balances for the official TICS contract, really verifies
// signed transactions (sender, nonce, token, transfer call), and exposes test
// methods:
//   test_transfer {from, to, amountWei, token?}  a wallet sending tokens (no signature needed)
//   test_mine {blocks}                             advance the chain
//   test_setBalance {address, wei, eth?}           set a token (or ETH) balance
//   test_state                                     dump balances and sent transactions
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { parseTransaction, recoverTransactionAddress, decodeFunctionData, keccak256, encodeAbiParameters, pad } from 'viem';
import { OFFICIAL_TICS, ERC20_ABI, TRANSFER_TOPIC } from '../worker/tics.js';

const port = Number(process.argv[2] || 8545);
const chainId = Number(process.env.FAKE_CHAIN_ID || 1);
const s = { block: 5000, balances: new Map(), eth: new Map(), nonces: new Map(), logs: [], receipts: new Map(), txs: new Map(), sent: [] };
const key = (token, a) => `${token}:${a.toLowerCase()}`;
const bal = (token, a) => s.balances.get(key(token, a)) || 0n;
const hex = (n) => `0x${BigInt(n).toString(16)}`;

function transfer(token, from, to, wei, txHash = `0x${randomBytes(32).toString('hex')}`) {
  from = from.toLowerCase(); to = to.toLowerCase(); token = token.toLowerCase();
  if (bal(token, from) < wei) return { ok: false, txHash };
  s.balances.set(key(token, from), bal(token, from) - wei);
  s.balances.set(key(token, to), bal(token, to) + wei);
  s.block += 1;
  const log = { address: token, topics: [TRANSFER_TOPIC, pad(from), pad(to)], data: encodeAbiParameters([{ type: 'uint256' }], [wei]),
    blockNumber: hex(s.block), transactionHash: txHash, logIndex: '0x0', removed: false };
  s.logs.push(log);
  s.receipts.set(txHash, { status: '0x1', blockNumber: hex(s.block), transactionHash: txHash, logs: [log], from, to: token });
  return { ok: true, txHash };
}

const methods = {
  eth_chainId: () => hex(chainId),
  net_version: () => String(chainId),
  eth_blockNumber: () => hex(s.block),
  eth_getBlockByNumber: () => ({ number: hex(s.block), baseFeePerGas: '0x3b9aca00', timestamp: hex(Math.floor(Date.now() / 1000)) }),
  eth_maxPriorityFeePerGas: () => '0x59682f00',
  eth_gasPrice: () => '0x77359400',
  eth_estimateGas: () => '0xc350',
  eth_getBalance: ([a]) => hex(s.eth.get(a.toLowerCase()) ?? 10n ** 18n),
  eth_getTransactionCount: ([a]) => hex(s.nonces.get(a.toLowerCase()) || 0),
  eth_call: ([call]) => {
    const { functionName, args } = decodeFunctionData({ abi: ERC20_ABI, data: call.data });
    if (functionName !== 'balanceOf') throw new Error('unsupported call');
    return encodeAbiParameters([{ type: 'uint256' }], [bal(call.to, args[0])]);
  },
  eth_getLogs: ([f]) => s.logs.filter((l) => Number(l.blockNumber) >= Number(f.fromBlock) && Number(l.blockNumber) <= Number(f.toBlock)
    && (!f.address || l.address === String(f.address).toLowerCase()) && (!f.topics?.[2] || l.topics[2] === f.topics[2])),
  eth_getTransactionReceipt: ([h]) => s.receipts.get(h) || null,
  eth_getTransactionByHash: ([h]) => (s.txs.has(h) ? { hash: h } : null),
  eth_sendRawTransaction: async ([raw]) => {
    const tx = parseTransaction(raw), from = (await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase();
    if (tx.chainId !== chainId) throw new Error('wrong chain id');
    const nonce = s.nonces.get(from) || 0;
    if (tx.nonce < nonce) throw new Error('nonce too low');
    if (tx.nonce > nonce) throw new Error('nonce too high');
    const hash = keccak256(raw);
    if (s.txs.has(hash)) throw new Error('already known');
    const call = decodeFunctionData({ abi: ERC20_ABI, data: tx.data });
    if (call.functionName !== 'transfer') throw new Error('only transfer is supported');
    s.nonces.set(from, nonce + 1);
    s.txs.set(hash, tx);
    const r = transfer(tx.to, from, call.args[0], call.args[1], hash);
    if (!r.ok) { s.block += 1; s.receipts.set(hash, { status: '0x0', blockNumber: hex(s.block), transactionHash: hash, logs: [] }); }
    s.sent.push({ hash, from, to: call.args[0].toLowerCase(), amountWei: call.args[1].toString(), ok: r.ok });
    return hash;
  },
  test_transfer: ([{ from, to, amountWei, token = OFFICIAL_TICS }]) => {
    const r = transfer(token, from, to, BigInt(amountWei));
    if (!r.ok) throw new Error('insufficient token balance');
    return r.txHash;
  },
  test_mine: ([{ blocks = 1 } = {}]) => { s.block += blocks; return hex(s.block); },
  test_setBalance: ([{ address, wei, eth, token = OFFICIAL_TICS }]) => {
    if (eth !== undefined) s.eth.set(address.toLowerCase(), BigInt(eth));
    if (wei !== undefined) s.balances.set(key(token, address), BigInt(wei));
    return true;
  },
  test_state: () => ({ block: s.block, balances: Object.fromEntries([...s.balances].map(([k, v]) => [k, v.toString()])), sent: s.sent }),
};

http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.end();
  let msg;
  try { msg = JSON.parse(body); } catch { res.statusCode = 400; return res.end('{}'); }
  const one = async (m) => {
    try {
      if (!methods[m.method]) throw new Error(`method ${m.method} not supported`);
      return { jsonrpc: '2.0', id: m.id, result: await methods[m.method](m.params || []) };
    } catch (e) { return { jsonrpc: '2.0', id: m.id, error: { code: -32000, message: e.message } }; }
  };
  res.end(JSON.stringify(Array.isArray(msg) ? await Promise.all(msg.map(one)) : await one(msg)));
}).listen(port, '127.0.0.1', () => console.log(`fake chain ${chainId} on http://127.0.0.1:${port}`));
