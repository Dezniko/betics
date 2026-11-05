// Search engine details for the three player pages. The Worker writes them into index.html
// (the app is one page, so every route would otherwise share the home page title).
export const SITE = 'https://www.betics.io';

export const PAGES = {
  '/': {
    title: 'Qubetics Roulette · Play with $TICS | qu-BETICS',
    description: 'Play roulette with $TICS, the Qubetics token on Ethereum. Connect your wallet, top up and spin. Every spin is provably fair and you can check it.',
  },
  '/how-it-works': {
    title: 'How It Works · qu-BETICS Qubetics $TICS Roulette',
    description: 'How to play roulette with Qubetics $TICS: top ups, your balance, the table limit, withdrawals and how to check every spin was fair yourself.',
  },
  '/terms': {
    title: 'Terms · qu-BETICS $TICS Roulette',
    description: 'The terms for playing qu-BETICS with Qubetics $TICS: who can play, your balance, top ups and withdrawals, fairness, risks and how to contact us.',
  },
};

// Pages served by the app but kept out of search (not in the sitemap, noindex): the slot while it is in testing.
export const HIDDEN_PAGES = {
  '/godsofpower': {
    title: 'Gods of Power · qu-BETICS',
    description: 'Gods of Power, a five reel slot played with $TICS on qu-BETICS.',
  },
};

// '/terms/' and '/terms' are the same page; anything else is not a page.
export function pageFor(pathname) {
  const path = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  if (Object.hasOwn(PAGES, path)) return { path, ...PAGES[path] };
  if (Object.hasOwn(HIDDEN_PAGES, path)) return { path, ...HIDDEN_PAGES[path], noindex: true };
  return null;
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function headTags({ path, title, description }) {
  const t = escapeHtml(title), d = escapeHtml(description), url = `${SITE}${path}`;
  return [
    `<title>${t}</title>`,
    `<meta name="description" content="${d}" />`,
    `<link rel="canonical" href="${url}" />`,
    '<meta property="og:type" content="website" />',
    '<meta property="og:site_name" content="qu-BETICS" />',
    `<meta property="og:title" content="${t}" />`,
    `<meta property="og:description" content="${d}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:image" content="${SITE}/brand/logo-960.webp" />`,
    '<meta name="twitter:card" content="summary" />',
    `<meta name="twitter:title" content="${t}" />`,
    `<meta name="twitter:description" content="${d}" />`,
    `<meta name="twitter:image" content="${SITE}/brand/logo-960.webp" />`,
  ].join('\n    ');
}

// Replaces the <title> in index.html with the page's title, description, canonical and share tags.
export function withPageHead(html, page) {
  const tags = page.noindex ? `${headTags(page)}\n    <meta name="robots" content="noindex, nofollow" />` : headTags(page);
  return html.replace(/<title>[^<]*<\/title>/, tags);
}

export const NOT_FOUND_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><meta name="robots" content="noindex" /><title>Page not found · qu-BETICS</title></head>
<body style="background:#06060a;color:#e8e2d0;font-family:system-ui,sans-serif;text-align:center;padding:4rem 1rem">
<h1>Page not found</h1>
<p><a href="/" style="color:#d4af37">Go to qu-BETICS</a></p>
</body>
</html>
`;
