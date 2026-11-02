// Real-money payments: USDT deposits through NOWPayments and withdrawals
// that an admin approves and sends from the casino wallet. Play money is
// untouched; real balances live in a separate column of the wallet object.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const DEFAULT_PAYMENTS = { provider: 'nowpayments', network: 'tron', payCurrency: 'usdttrc20', depositsOpen: false, withdrawalsOpen: false,
  minDepositCents: 1000, minWithdrawalCents: 2000, maxWithdrawalCents: 1000000, withdrawalFeeCents: 100, dailyWithdrawalLimitCents: 2000000 };

function base58Decode(text) {
  let n = 0n;
  for (const ch of text) { const i = B58.indexOf(ch); if (i < 0) return null; n = n * 58n + BigInt(i); }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  for (const ch of text) { if (ch !== '1') break; bytes.unshift(0); }
  return new Uint8Array(bytes);
}

// A Tron address: base58check, 25 bytes, version byte 0x41, double-SHA256 checksum.
export async function isTronAddress(address) {
  if (typeof address !== 'string' || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return false;
  const bytes = base58Decode(address);
  if (!bytes || bytes.length !== 25 || bytes[0] !== 0x41) return false;
  const payload = bytes.slice(0, 21);
  const h1 = new Uint8Array(await crypto.subtle.digest('SHA-256', payload));
  const h2 = new Uint8Array(await crypto.subtle.digest('SHA-256', h1));
  return h2.slice(0, 4).every((b, i) => b === bytes[21 + i]);
}

export async function paymentSettings(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'payments'").first();
  return { ...DEFAULT_PAYMENTS, ...(row ? JSON.parse(row.value) : {}) };
}
export const providerReady = env => !!(env.NOWPAYMENTS_API_KEY && env.NOWPAYMENTS_IPN_SECRET);

// NOWPayments: create a payment for a USD amount, paid in USDT on Tron.
export async function createProviderPayment(env, { depositId, amountCents, payCurrency, callbackUrl }, fetchImpl = fetch) {
  const res = await fetchImpl('https://api.nowpayments.io/v1/payment', {
    method: 'POST', headers: { 'x-api-key': env.NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ price_amount: amountCents / 100, price_currency: 'usd', pay_currency: payCurrency, order_id: depositId,
      order_description: 'Casino deposit', ipn_callback_url: callbackUrl, is_fixed_rate: true, is_fee_paid_by_user: false }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.pay_address) throw new Error(body.message || `provider error ${res.status}`);
  return { providerRef: String(body.payment_id), payAddress: body.pay_address, payAmount: String(body.pay_amount), status: body.payment_status || 'waiting' };
}

// NOWPayments IPN: HMAC-SHA512 of the JSON body with keys sorted, using the IPN secret.
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, sortKeys(value[k])]));
  return value;
}
export async function verifyIpn(secret, bodyText, signature) {
  if (!secret || typeof signature !== 'string' || !/^[a-f0-9]{128}$/i.test(signature)) return null;
  let body;
  try { body = JSON.parse(bodyText); } catch { return null; }
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const mac = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(JSON.stringify(sortKeys(body)))))].map(b => b.toString(16).padStart(2, '0')).join('');
  let diff = 0; const sig = signature.toLowerCase();
  for (let i = 0; i < 128; i++) diff |= mac.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? body : null;
}

const STATUS_MAP = { waiting: 'waiting', confirming: 'confirming', confirmed: 'confirming', sending: 'confirming', partially_paid: 'partially_paid',
  finished: 'finished', failed: 'failed', refunded: 'refunded', expired: 'expired' };
export const mapProviderStatus = s => STATUS_MAP[s] || null;
