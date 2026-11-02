// Places "+X TICS" labels for winning wagers right on their chips (one winner
// always gets exactly one label, centred on its number and kept inside the felt);
// with several winners none overlap each other, the total pill, or the edges. Labels that can't fit are hidden
// (the chip still glows and the total pill always shows the money).
// All coordinates are board units; screen-pixel sizes are divided by `scale`.
export const LABEL_H = 28;
export const labelWidth = text => Math.ceil(text.length * 9.6 + 24);
const overlaps = (a, b, pad) => a.left < b.left + b.width + pad && b.left < a.left + a.width + pad && a.top < b.top + b.height + pad && b.top < a.top + a.height + pad;

export function totalPillRect(text, W, scale) {
  const width = labelWidth(text) * 1.25 / scale, height = LABEL_H * 1.2 / scale;
  return { left: (W - width) / 2, top: 4 / scale, width, height };
}

export function layoutPayoutLabels(items, { W, H, scale = 1, chip = 22, reserved = [] }) {
  const placed = [...reserved], out = [];
  const pad = 3 / scale, h = LABEL_H / scale, gap = (chip / 2 + 6) / scale;
  for (const it of items) {
    const width = labelWidth(it.text) / scale;
    const cx = Math.max(0, Math.min(W - width, it.x - width / 2));
    const cy = Math.max(0, Math.min(H - h, it.y - h / 2));
    if (items.length === 1) { const rect = { left: cx, top: cy, width, height: h }; out.push({ key: it.key, shown: true, ...rect }); break; }
    const candidates = [
      { left: cx, top: cy },                           // right on the winning chip/number
      { left: cx, top: it.y - gap - h },               // above the chip
      { left: cx, top: it.y + gap },                   // below
      { left: it.x + gap, top: it.y - h / 2 },         // right
      { left: it.x - gap - width, top: it.y - h / 2 }, // left
    ];
    const spot = candidates.find(c => c.left >= 0 && c.top >= 0 && c.left + width <= W && c.top + h <= H
      && !placed.some(p => overlaps({ ...c, width, height: h }, p, pad)));
    if (spot) { const rect = { ...spot, width, height: h }; placed.push(rect); out.push({ key: it.key, shown: true, ...rect }); }
    else out.push({ key: it.key, shown: false });
  }
  return out;
}
