// Lays out a reel strip from symbol counts so no symbol clusters and scatters never sit within 3 rows of
// each other (so one reel never shows two scatters at once). Deterministic: same counts, same strip.
export function buildStrip(counts, length = 32) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total !== length) throw new Error(`counts sum to ${total}, not ${length}`);
  const order = Object.entries(counts).filter(([, n]) => n > 0).sort((a, b) => a[1] - b[1]);
  const strip = Array(length).fill(null);
  // Spread each symbol evenly round the strip, rarest first, taking the nearest free slot.
  for (const [code, n] of order) {
    const step = length / n;
    for (let i = 0; i < n; i++) {
      let pos = Math.round(i * step + step / 2) % length;
      let tries = 0;
      while (strip[pos] !== null || (code === 'S' && nearScatter(strip, pos, length))) { pos = (pos + 1) % length; if (++tries > length) throw new Error('cannot place ' + code); }
      strip[pos] = code;
    }
  }
  return strip;
}
function nearScatter(strip, pos, length) {
  for (let d = -2; d <= 2; d++) if (d !== 0 && strip[(pos + d + length) % length] === 'S') return true;
  return false;
}
