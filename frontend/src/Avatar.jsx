// Deterministic player avatar from the wallet address: a mirrored 5x5 pattern
// on a brand gradient (purple to cyan), so every wallet gets its own badge.
function bytesOf(address) {
  const hex = String(address || '').toLowerCase().replace(/^0x/, '').padEnd(40, '0');
  const out = [];
  for (let i = 0; i < 40; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16) || 0);
  return out;
}

export default function Avatar({ address, size = 28, className = '' }) {
  const b = bytesOf(address);
  const hueA = 255 + (b[0] % 40); // purple to violet
  const hueB = 185 + (b[1] % 45); // cyan to blue
  const id = `av-${String(address || 'x').slice(2, 10)}-${size}`;
  const cells = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if (b[2 + y * 3 + x] % 2 === 0) continue;
      cells.push([x, y]);
      if (x < 2) cells.push([4 - x, y]);
    }
  }
  return <svg className={`player-avatar ${className}`} width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor={`hsl(${hueA} 85% 52%)`} />
        <stop offset="1" stopColor={`hsl(${hueB} 90% 50%)`} />
      </linearGradient>
    </defs>
    <rect width="40" height="40" rx="20" fill={`url(#${id})`} />
    <g fill="rgba(255,246,222,0.62)">
      {cells.map(([x, y]) => <rect key={`${x}-${y}`} x={7.5 + x * 5} y={7.5 + y * 5} width="5" height="5" rx="1" />)}
    </g>
    <rect x="0.75" y="0.75" width="38.5" height="38.5" rx="19.25" fill="none" stroke="rgba(241,220,170,0.55)" strokeWidth="1.5" />
  </svg>;
}
