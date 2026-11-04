// Where this visitor first came from: utm_source, else the referring site's host, plus utm_campaign.
// Saved once per browser on the first page load, then sent when the player row is created
// (guest session or first wallet sign in), so the admin traffic reports show the real source.
const KEY = 'betics:first-touch:v1';

export function computeFirstTouch(href, referrer) {
  let url;
  try { url = new URL(href); } catch { return { source: null, campaign: null }; }
  const p = url.searchParams;
  let source = (p.get('utm_source') || '').trim().toLowerCase() || null;
  if (!source && referrer) {
    try {
      const host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, '');
      if (host && host !== url.hostname.replace(/^www\./, '') && !/(^|\.)betics\.io$/.test(host)) source = host;
    } catch { /* not a URL */ }
  }
  const campaign = (p.get('utm_campaign') || '').trim() || null;
  return { source: source ? source.slice(0, 64) : null, campaign: campaign ? campaign.slice(0, 64) : null };
}

export function rememberFirstTouch(storage = globalThis.localStorage, href = globalThis.location?.href, referrer = globalThis.document?.referrer) {
  try {
    if (storage.getItem(KEY)) return;
    storage.setItem(KEY, JSON.stringify(computeFirstTouch(href, referrer)));
  } catch { /* storage blocked */ }
}

export function readFirstTouch(storage = globalThis.localStorage) {
  try { return JSON.parse(storage.getItem(KEY)) || null; } catch { return null; }
}
