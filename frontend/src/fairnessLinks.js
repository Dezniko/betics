// CyberChef (made by the UK's GCHQ, open source, runs entirely in the browser).
// One prefilled link works out the pocket from the revealed codes:
// HMAC-SHA256(key = secret, text = "clientSeed:nonce:counter") -> first 8 hex
// characters -> decimal -> remainder after dividing by 37.
const CHEF = 'https://gchq.github.io/CyberChef/';
const chefEncode = s => s.split('').map(c => /[A-Za-z0-9_.\-()',:*/|!~]/.test(c) ? c : encodeURIComponent(c)).join('');
const b64 = s => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/=+$/, '');
const chefString = s => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
export const pocketRecipe = secret => `HMAC({'option':'UTF8','string':'${chefString(secret)}'},'SHA256')Take_bytes(0,8,false)From_Base(16)Jq('. - 37 * (. / 37 | floor)')`;
export const chefPocketUrl = (secret, message) => `${CHEF}#recipe=${chefEncode(pocketRecipe(secret))}&input=${encodeURIComponent(b64(message))}`;
export const chefLockUrl = secret => `${CHEF}#recipe=${chefEncode("SHA2('256',64,160)")}&input=${encodeURIComponent(b64(secret))}`;
