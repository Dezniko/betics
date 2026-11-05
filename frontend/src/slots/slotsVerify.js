// Browser side of the slot fairness check: the same draws as the server, from WebCrypto, and a full
// recomputation of a round from the revealed seed. Pure, no DOM.
import { playRound, maxPayoutUnits } from '../../../backend/src/games/slots.js';
import { SLOT_MATH } from '../../../backend/src/games/slotsMath.js';

export const MAX_DRAWS = (1 + SLOT_MATH.freeSpins.maxSpins) * SLOT_MATH.reels; // 255 draws cover any round
export const COUNTERS = 8;

const enc = new TextEncoder();
export function slotDrawMessage(clientSeed, nonce, draw, counter) {
  return `${clientSeed}:${nonce}:slots:${draw}:${counter}`;
}

// Precomputes every HMAC a round could need and returns a synchronous lookup for playRound.
export async function browserUint32At(serverSeed, clientSeed, nonce, { draws = MAX_DRAWS, counters = COUNTERS, subtle = globalThis.crypto.subtle } = {}) {
  const key = await subtle.importKey('raw', enc.encode(serverSeed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const table = new Map();
  const jobs = [];
  for (let d = 0; d < draws; d++) for (let c = 0; c < counters; c++) {
    jobs.push(subtle.sign('HMAC', key, enc.encode(slotDrawMessage(clientSeed, nonce, d, c))).then((buf) => { table.set(`${d}:${c}`, new DataView(buf).getUint32(0)); }));
  }
  await Promise.all(jobs);
  return (draw, counter) => {
    const v = table.get(`${draw}:${counter}`);
    if (v === undefined) throw new Error('draw outside the precomputed range');
    return v;
  };
}

// Lazy variant: only computes a draw when asked (cheap for a normal round, which needs 5 to 20 draws).
export async function lazyUint32At(serverSeed, clientSeed, nonce, { subtle = globalThis.crypto.subtle } = {}) {
  const key = await subtle.importKey('raw', enc.encode(serverSeed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return async (draw, counter) => new DataView(await subtle.sign('HMAC', key, enc.encode(slotDrawMessage(clientSeed, nonce, draw, counter)))).getUint32(0);
}

export async function sha256Hex(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Recompute a round the server reported and list every difference. `data` is the server's spin reply,
// `receipt` the pre-bet receipt saved by the browser (expected hash, agreed base client seed, nonce, entropy).
export async function verifySlotRound(receipt, data, math = SLOT_MATH) {
  const problems = [];
  const f = data?.fairness;
  if (!f || typeof f.serverSeed !== 'string') return { ok: false, problems: ['The server did not reveal its seed.'] };
  if (!receipt) problems.push('No pre-bet receipt was saved for this spin.');
  else {
    if (receipt.serverSeedHash !== f.serverSeedHash) problems.push('The revealed lock differs from the lock shown before the bet.');
    if (receipt.clientSeedBase !== f.clientSeedBase || receipt.clientEntropy !== f.clientEntropy) problems.push('Your lucky word or your randomness was not the one you sent.');
    if (receipt.nonce !== f.nonce) problems.push('The round number differs from the one agreed before the bet.');
    if (receipt.requestId && data.requestId !== receipt.requestId) problems.push('The reply belongs to a different request.');
  }
  if ((await sha256Hex(f.serverSeed)) !== f.serverSeedHash) problems.push('The revealed seed does not open the lock.');
  if (f.clientSeed !== `${f.clientSeedBase}:${f.clientEntropy}`) problems.push('The client seed was not built from your lucky word and randomness.');
  let round = null;
  try {
    // Draw lazily first to know how many are needed, then recompute synchronously.
    const lazy = await lazyUint32At(f.serverSeed, f.clientSeed, f.nonce);
    const cache = new Map();
    const need = [];
    const spins = Array.isArray(data.spins) ? data.spins.length : 1;
    for (let d = 0; d < spins * math.reels + math.reels; d++) for (let c = 0; c < COUNTERS; c++) need.push([d, c]);
    await Promise.all(need.map(async ([d, c]) => cache.set(`${d}:${c}`, await lazy(d, c))));
    round = playRound({ stake: data.stake, math, uint32At: (d, c) => { const v = cache.get(`${d}:${c}`); if (v === undefined) throw new Error('round longer than expected'); return v; } });
  } catch (e) { problems.push(`The round could not be recomputed: ${e.message}`); }
  if (round) {
    if (round.spins.length !== data.spins.length) problems.push(`The server played ${data.spins.length} spins, the seed gives ${round.spins.length}.`);
    round.spins.forEach((s, i) => {
      const d = data.spins[i]; if (!d) return;
      if (JSON.stringify(s.stops) !== JSON.stringify(d.stops)) problems.push(`Spin ${i + 1}: the reel stops differ from the seed.`);
      if (s.winUnits !== d.winUnits) problems.push(`Spin ${i + 1}: the win differs (${d.winUnits} shown, ${s.winUnits} from the seed).`);
      if (JSON.stringify(s.lineWins) !== JSON.stringify(d.lineWins)) problems.push(`Spin ${i + 1}: the winning lines differ.`);
      if (s.scatterCount !== d.scatterCount || s.scatterPay !== d.scatterPay) problems.push(`Spin ${i + 1}: the vault doors differ.`);
    });
    if (round.totalPayoutUnits !== data.totalPayoutCents) problems.push(`The total payout differs (${data.totalPayoutCents} shown, ${round.totalPayoutUnits} from the seed).`);
    if (round.freeSpinsPlayed !== data.freeSpinsPlayed) problems.push('The number of free spins differs.');
    if (round.totalPayoutUnits > maxPayoutUnits(data.stake, math)) problems.push('The payout is above the round cap.');
  }
  if (Number.isSafeInteger(data.balanceBeforeCents) && Number.isSafeInteger(data.balanceAfterCents)) {
    if (data.balanceAfterCents !== data.balanceBeforeCents - data.stake + data.totalPayoutCents) problems.push('The balance after the round does not add up.');
  }
  return { ok: problems.length === 0, problems, round };
}
