// Links in admin messages. Parsed with the URL parser against this page, so tricks like
// "/\\evil.com", "javascript:" or "https:evil" are judged by what the browser would open.
// Same-site links open in place; other sites must be https and open in a new tab.
export function inboxLink(url, origin = globalThis.location?.origin) {
  if (typeof url !== 'string' || !url.trim() || url.length > 2000 || !origin) return null;
  let parsed;
  try { parsed = new URL(url.trim(), origin); } catch { return null; }
  if (parsed.username || parsed.password) return null;
  if (parsed.origin === origin && (parsed.protocol === 'https:' || parsed.protocol === 'http:')) {
    return { href: parsed.pathname + parsed.search + parsed.hash, external: false };
  }
  if (parsed.protocol !== 'https:') return null;
  return { href: parsed.href, external: true };
}
