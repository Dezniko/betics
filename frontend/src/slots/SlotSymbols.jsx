// Gods of Power symbols: original inline SVG, dark luxury palette (steel, gold for money, neon purple,
// blue and cyan as accents). One component per symbol code; every one carries the symbol name as its label.
// No symbol has a plaque or a border: everything floats on the dark reel with its own coloured glow.
import { symbolName } from '../../../backend/src/games/slotsMath.js';

const Svg = ({ code, children, defs }) => <svg className={`slot-sym slot-sym-${code}`} viewBox="0 0 100 100" role="img" aria-label={symbolName(code)} focusable="false">
  {defs && <defs>{defs}</defs>}
  {children}
</svg>;

// A four point sparkle star; the idle shimmer twinkles them (opacity only).
const Star = ({ x: px, y: py, r: pr, delay = 0, color = '#ffffff' }) => {
  const x = Number(px), y = Number(py), r = Number(pr);
  return <path className="slot-star" style={{ '--d': `${delay}s` }} d={`M${x} ${y - r}Q${x} ${y} ${x + r} ${y}Q${x} ${y} ${x} ${y + r}Q${x} ${y} ${x - r} ${y}Q${x} ${y} ${x} ${y - r}Z`} fill={color} />;
};

// Soft coloured glow behind a symbol (a radial gradient, no filter, so it is cheap on phones).
const Glow = ({ id, color, cx = 50, cy = 54, rx = 40, ry = 36 }) => <>
  <defs><radialGradient id={id} cx=".5" cy=".5" r=".5"><stop offset="0" stopColor={color} stopOpacity=".55" /><stop offset=".55" stopColor={color} stopOpacity=".18" /><stop offset="1" stopColor={color} stopOpacity="0" /></radialGradient></defs>
  <ellipse className="slot-glow" cx={cx} cy={cy} rx={rx} ry={ry} fill={`url(#${id})`} />
</>;

// The moving specular sweep: a bright slanted band clipped to the symbol's shape, moved with a CSS transform.
const Shine = ({ clip, id }) => <g clipPath={`url(#${clip})`}>
  <defs><linearGradient id={`${id}-shine`} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#fff" stopOpacity="0" /><stop offset=".45" stopColor="#fff" stopOpacity=".75" /><stop offset=".55" stopColor="#fff" stopOpacity=".75" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></linearGradient></defs>
  <g className="slot-shine"><rect x="-10" y="-10" width="34" height="130" fill={`url(#${id}-shine)`} transform="skewX(-22)" /></g>
</g>;

// Gods of Power (wild, the top paying symbol): the owner's cartoon portrait (used with permission),
// a gold ring with neon glow. Rendered as an image, not SVG.
export const GodsOfPower = () => <img className="slot-sym slot-sym-W slot-sym-img" src="/slots/gods-of-power.webp" width="512" height="512" alt={symbolName('W')} draggable="false" />;

// Golden key: kept as spare art.
export const GoldenKey = () => <Svg code="W" defs={<>
  <linearGradient id="gp-gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fff2c2" /><stop offset=".35" stopColor="#f1c860" /><stop offset=".7" stopColor="#b8851d" /><stop offset="1" stopColor="#f7dd8a" /></linearGradient>
  <radialGradient id="gp-purple" cx=".4" cy=".35" r=".7"><stop offset="0" stopColor="#e8b6ff" /><stop offset=".5" stopColor="#a63cff" /><stop offset="1" stopColor="#4a0f80" /></radialGradient>
</>}>
  <ellipse cx="50" cy="60" rx="34" ry="10" fill="rgba(166,60,255,.25)" />
  <g transform="rotate(-38 50 50)">
    <circle cx="30" cy="50" r="17" fill="none" stroke="url(#gp-gold)" strokeWidth="9" />
    <circle cx="30" cy="50" r="6" fill="url(#gp-purple)" />
    <rect x="44" y="45.5" width="44" height="9" rx="3" fill="url(#gp-gold)" />
    <rect x="70" y="52" width="6" height="12" rx="1.5" fill="url(#gp-gold)" />
    <rect x="80" y="52" width="6" height="15" rx="1.5" fill="url(#gp-gold)" />
    <path d="M46 47h38" stroke="#fff6d5" strokeWidth="1.6" strokeLinecap="round" opacity=".8" />
  </g>
</Svg>;

// Vault door (scatter): a round steel door with a gold spoked wheel and a cyan rim light.
export const VaultDoor = () => <Svg code="S" defs={<>
  <radialGradient id="gp-steel" cx=".35" cy=".3" r=".9"><stop offset="0" stopColor="#8b93a7" /><stop offset=".55" stopColor="#3b4152" /><stop offset="1" stopColor="#15181f" /></radialGradient>
  <linearGradient id="gp-gold2" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fff2c2" /><stop offset=".5" stopColor="#d6b06a" /><stop offset="1" stopColor="#8d6a1c" /></linearGradient>
</>}>
  <circle cx="50" cy="50" r="44" fill="none" stroke="#22d3ff" strokeWidth="2.5" opacity=".85" />
  <circle cx="50" cy="50" r="40" fill="url(#gp-steel)" stroke="#0b0d12" strokeWidth="1.5" />
  <circle cx="50" cy="50" r="33" fill="none" stroke="#1d212b" strokeWidth="3" />
  {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => <circle key={a} cx={50 + 36.5 * Math.cos((a * Math.PI) / 180)} cy={50 + 36.5 * Math.sin((a * Math.PI) / 180)} r="2.2" fill="#9aa3b8" />)}
  <circle cx="50" cy="50" r="19" fill="none" stroke="url(#gp-gold2)" strokeWidth="5" />
  {[0, 60, 120].map((a) => <rect key={a} x="47.5" y="27" width="5" height="46" rx="2" fill="url(#gp-gold2)" transform={`rotate(${a} 50 50)`} />)}
  <circle cx="50" cy="50" r="7" fill="url(#gp-gold2)" stroke="#5a4210" strokeWidth="1" />
  <path d="M22 36a30 30 0 0 1 20-16" stroke="#cfe9ff" strokeWidth="2" strokeLinecap="round" opacity=".55" fill="none" />
</Svg>;

// Diamond: a brilliant cut in cyan and white facets (spare art).
export const Diamond = () => <Svg code="D" defs={<>
  <linearGradient id="gp-ice" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffffff" /><stop offset=".5" stopColor="#9eeaff" /><stop offset="1" stopColor="#22a9d8" /></linearGradient>
</>}>
  <ellipse cx="50" cy="84" rx="26" ry="5" fill="rgba(34,211,255,.22)" />
  <polygon points="20,38 36,20 64,20 80,38 50,82" fill="url(#gp-ice)" stroke="#0e5f7a" strokeWidth="1.5" strokeLinejoin="round" />
  <polygon points="20,38 80,38 50,82" fill="#5fd4f5" opacity=".55" />
  <polygon points="36,20 50,38 64,20" fill="#e9fbff" opacity=".9" />
  <polygon points="20,38 36,20 50,38" fill="#7fe0ff" opacity=".9" />
  <polygon points="64,20 80,38 50,38" fill="#7fe0ff" opacity=".9" />
  <polygon points="36,38 50,82 50,38" fill="#ffffff" opacity=".35" />
  <path d="M26 36l8-10" stroke="#fff" strokeWidth="2" strokeLinecap="round" opacity=".9" />
</Svg>;

// Gold bar: a stepped ingot with bevelled faces, a stamped panel, a hot specular and sparkles.
const BAR_CLIP = 'gp-bar-clip';
export const GoldBar = () => <Svg code="B" defs={<>
  <linearGradient id="gp-bar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff4c8" /><stop offset=".4" stopColor="#f0c452" /><stop offset=".75" stopColor="#c28a1c" /><stop offset="1" stopColor="#e8b946" /></linearGradient>
  <linearGradient id="gp-bar-side" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#d9a83a" /><stop offset=".5" stopColor="#8d5f0c" /><stop offset="1" stopColor="#b0810f" /></linearGradient>
  <linearGradient id="gp-bar-end" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#6d4a08" /><stop offset="1" stopColor="#b58a28" /></linearGradient>
  <clipPath id={BAR_CLIP}><polygon points="12,72 22,40 78,40 88,72" /><polygon points="22,40 31,26 69,26 78,40" /></clipPath>
</>}>
  <Glow id="gp-bar-glow" color="#f1c860" cy="58" rx="44" ry="30" />
  <polygon points="12,72 22,40 78,40 88,72" fill="url(#gp-bar-side)" />
  <polygon points="12,72 22,40 24,42 15,72" fill="url(#gp-bar-end)" opacity=".8" />
  <polygon points="22,40 31,26 69,26 78,40" fill="url(#gp-bar)" />
  <polygon points="22,40 31,26 36,26 28,40" fill="#fff8dc" opacity=".45" />
  <rect x="32" y="48" width="36" height="14" rx="2.5" fill="none" stroke="#fff1c4" strokeWidth="1.6" opacity=".8" />
  <path d="M38 55h24" stroke="#fff6d8" strokeWidth="2.2" strokeLinecap="round" opacity=".7" />
  <path d="M33 29h30" stroke="#fffaf0" strokeWidth="2.4" strokeLinecap="round" opacity=".95" />
  <path d="M14 70h72" stroke="#ffe39a" strokeWidth="1.2" strokeLinecap="round" opacity=".5" />
  <Shine clip={BAR_CLIP} id="gp-bar" />
  <Star x="25" y="30" r="4.5" delay={0.4} /><Star x="80" y="44" r="3.5" delay={1.6} color="#fff3c4" /><Star x="60" y="74" r="2.6" delay={2.7} />
</Svg>;

// Ruby: a cushion cut with a table, crown facets, a hot rim light and a magenta glow.
const RUBY_CLIP = 'gp-ruby-clip';
export const Ruby = () => <Svg code="R" defs={<>
  <linearGradient id="gp-ruby" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#ffa1c4" /><stop offset=".4" stopColor="#f0194a" /><stop offset=".75" stopColor="#8a0626" /><stop offset="1" stopColor="#d81c4c" /></linearGradient>
  <radialGradient id="gp-ruby-core" cx=".5" cy=".45" r=".55"><stop offset="0" stopColor="#ff7aa2" /><stop offset=".6" stopColor="#ff2f66" /><stop offset="1" stopColor="#b00a35" /></radialGradient>
  <clipPath id={RUBY_CLIP}><path d="M30 20h40l14 14v30L70 80H30L16 64V34z" /></clipPath>
</>}>
  <Glow id="gp-ruby-glow" color="#ff2f66" cy="52" rx="40" ry="38" />
  <path d="M30 20h40l14 14v30L70 80H30L16 64V34z" fill="url(#gp-ruby)" />
  <path d="M38 34h24l10 10v14L62 68H38L28 58V44z" fill="url(#gp-ruby-core)" />
  <path d="M30 20l8 14M70 20l-8 14M84 64l-12 4M16 64l12 4M30 80l8-12M70 80l-8-12M16 34l12 10M84 34l-12 10" stroke="#ffd4e1" strokeWidth="1.3" opacity=".75" />
  <path d="M38 34h24l10 10v14L62 68H38L28 58V44z" fill="none" stroke="#fff0f5" strokeWidth="1" opacity=".55" />
  <path d="M30 20h40l14 14v30L70 80H30L16 64V34z" fill="none" stroke="#ffc2d6" strokeWidth="1.6" opacity=".9" />
  <path d="M34 28l12-5" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" opacity=".95" />
  <path d="M40 40l6-3" stroke="#fff" strokeWidth="2" strokeLinecap="round" opacity=".7" />
  <Shine clip={RUBY_CLIP} id="gp-ruby" />
  <Star x="28" y="24" r="4.5" delay={0.9} /><Star x="78" y="70" r="3.5" delay={2.1} color="#ffd6e4" /><Star x="72" y="26" r="2.6" delay={3.3} />
</Svg>;

// Coin stack: five gold coins with bright rims, the top one face up with an embossed star and a specular.
const COIN_CLIP = 'gp-coin-clip';
export const CoinStack = () => <Svg code="C" defs={<>
  <linearGradient id="gp-coin" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#8d6a1c" /><stop offset=".35" stopColor="#f6d784" /><stop offset=".6" stopColor="#f1c860" /><stop offset="1" stopColor="#8d6a1c" /></linearGradient>
  <radialGradient id="gp-coin-face" cx=".4" cy=".35" r=".8"><stop offset="0" stopColor="#fff6d2" /><stop offset=".55" stopColor="#efc55a" /><stop offset="1" stopColor="#a67b20" /></radialGradient>
  <clipPath id={COIN_CLIP}><rect x="20" y="28" width="60" height="62" rx="6" /></clipPath>
</>}>
  <Glow id="gp-coin-glow" color="#f1c860" cy="60" rx="42" ry="34" />
  {[80, 71, 62, 53].map((y, i) => <g key={y}>
    <rect x="20" y={y - 7} width="60" height="12" rx="2" fill="url(#gp-coin)" />
    <ellipse cx="50" cy={y - 7} rx="30" ry="7.5" fill={i % 2 ? '#eec45e' : '#e7bb55'} stroke="#7d5a12" strokeWidth="1" />
    <path d={`M23 ${y - 1}h54`} stroke="#fff0c0" strokeWidth=".9" opacity=".35" />
  </g>)}
  <rect x="20" y="38" width="60" height="12" rx="2" fill="url(#gp-coin)" />
  <ellipse cx="50" cy="38" rx="30" ry="9.5" fill="url(#gp-coin-face)" stroke="#7d5a12" strokeWidth="1.2" />
  <ellipse cx="50" cy="38" rx="22" ry="6.5" fill="none" stroke="#b68a2a" strokeWidth="1.2" />
  <path d="M50 32l1.8 3.6 4 .5-2.9 2.8.7 4L50 41l-3.6 1.9.7-4-2.9-2.8 4-.5z" fill="#b38322" opacity=".85" />
  <path d="M28 32q10-5 22-4" stroke="#fffaf0" strokeWidth="2.4" strokeLinecap="round" fill="none" opacity=".95" />
  <Shine clip={COIN_CLIP} id="gp-coin" />
  <Star x="24" y="30" r="4" delay={1.2} /><Star x="80" y="56" r="3.2" delay={2.5} color="#fff3c4" /><Star x="36" y="84" r="2.4" delay={0.2} />
</Svg>;

// Royals: big glossy jewel letters, each its own neon colour, bevelled faces with an inner light, a hot
// specular, a thin bright rim (no plaque), sparkles and a soft coloured glow. Read clearly at 60 px.
const LETTERS = {
  A: { d: 'M50 12L84 88H66L60 73H40L34 88H16ZM50 38L44 58H56Z', hole: true, light: '#f4d2ff', mid: '#b452ff', deep: '#4b0b90', rim: '#f3d9ff', glow: '#a63cff', stars: [[22, 26], [80, 34], [64, 84]] },
  K: { d: 'M20 12H37V42L60 12H81L52 47L83 88H62L41 59L37 64V88H20Z', light: '#e9fcff', mid: '#2fd6ff', deep: '#064f80', rim: '#dafaff', glow: '#22d3ff', stars: [[76, 20], [26, 78], [66, 62]] },
  Q: { d: 'M50 12C69 12 82 27 82 48C82 69 69 84 50 84C31 84 18 69 18 48C18 27 31 12 50 12ZM50 28C40 28 35 36 35 48C35 60 40 68 50 68C60 68 65 60 65 48C65 36 60 28 50 28Z', hole: true, tail: 'M58 60L82 82L70 92L50 72Z', light: '#ffd8ee', mid: '#ff3fb2', deep: '#7b0a50', rim: '#ffdcf1', glow: '#ff3fb2', stars: [[22, 22], [80, 30], [34, 82]] },
  J: { d: 'M62 12H80V58C80 76 69 88 52 88C37 88 27 79 25 64L42 60C43 68 47 73 53 73C59 73 62 69 62 58Z', light: '#fff6cf', mid: '#f7c843', deep: '#8a5706', rim: '#fff1bf', glow: '#f1c860', stars: [[30, 24], [84, 70], [40, 90]] },
};
const Letter = ({ code }) => {
  const L = LETTERS[code], id = `gp-${code}`, clip = `${id}-clip`;
  const fill = L.hole ? 'evenodd' : 'nonzero';
  return <Svg code={code} defs={<>
    <linearGradient id={`${id}-face`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={L.light} /><stop offset=".42" stopColor={L.mid} /><stop offset=".8" stopColor={L.deep} /><stop offset="1" stopColor={L.mid} /></linearGradient>
    <radialGradient id={`${id}-inner`} cx=".5" cy=".38" r=".62"><stop offset="0" stopColor="#fff" stopOpacity=".55" /><stop offset=".5" stopColor={L.light} stopOpacity=".15" /><stop offset="1" stopColor={L.deep} stopOpacity="0" /></radialGradient>
    <linearGradient id={`${id}-top`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".65" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></linearGradient>
    <linearGradient id={`${id}-depth`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={L.deep} /><stop offset="1" stopColor="#120518" /></linearGradient>
    <radialGradient id={`${id}-spec`} cx=".5" cy=".5" r=".5"><stop offset="0" stopColor="#fff" stopOpacity=".95" /><stop offset=".5" stopColor="#fff" stopOpacity=".35" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></radialGradient>
    <clipPath id={clip}><path d={L.d} clipRule={fill} />{L.tail && <path d={L.tail} />}</clipPath>
  </>}>
    <Glow id={`${id}-glow`} color={L.glow} cy="52" rx="42" ry="40" />
    {/* depth: the jewel's thick base, offset down */}
    <g transform="translate(0 4)">
      <path d={L.d} fillRule={fill} fill={`url(#${id}-depth)`} />
      {L.tail && <path d={L.tail} fill={`url(#${id}-depth)`} />}
    </g>
    {/* face */}
    <path d={L.d} fillRule={fill} fill={`url(#${id}-face)`} />
    {L.tail && <path d={L.tail} fill={`url(#${id}-face)`} />}
    {/* inner light and the bevelled top half */}
    <g clipPath={`url(#${clip})`}>
      <rect x="0" y="0" width="100" height="100" fill={`url(#${id}-inner)`} />
      <rect x="0" y="0" width="100" height="46" fill={`url(#${id}-top)`} />
      <ellipse cx="38" cy="26" rx="12" ry="7" fill={`url(#${id}-spec)`} transform="rotate(-22 38 26)" />
    </g>
    {/* thin bright rim */}
    <path d={L.d} fillRule={fill} fill="none" stroke={L.rim} strokeWidth="1.8" strokeLinejoin="round" opacity=".9" />
    {L.tail && <path d={L.tail} fill="none" stroke={L.rim} strokeWidth="1.8" strokeLinejoin="round" opacity=".9" />}
    <Shine clip={clip} id={id} />
    {L.stars.map(([x, y], i) => <Star key={i} x={x} y={y} r={i === 0 ? 5 : i === 1 ? 3.6 : 2.6} delay={i * 1.1 + (code.charCodeAt(0) % 4) * 0.3} color={i === 1 ? L.light : '#ffffff'} />)}
  </Svg>;
};
export const LetterA = () => <Letter code="A" />;
export const LetterK = () => <Letter code="K" />;
export const LetterQ = () => <Letter code="Q" />;
export const LetterJ = () => <Letter code="J" />;

// Qubetics (top regular symbol): the official Qubetics logo (used with permission), soft glow only.
export const Qubetics = () => <img className="slot-sym slot-sym-D slot-sym-img" src="/slots/qubetics.webp" width="512" height="512" alt={symbolName('D')} draggable="false" />;

export const SYMBOL_COMPONENTS = Object.freeze({
  W: GodsOfPower,
  S: VaultDoor,
  D: Qubetics,
  B: GoldBar,
  R: Ruby,
  C: CoinStack,
  A: LetterA,
  K: LetterK,
  Q: LetterQ,
  J: LetterJ,
});

export function SlotSymbol({ code }) {
  const C = SYMBOL_COMPONENTS[code];
  return C ? <C /> : <span className="slot-sym slot-sym-missing" aria-label={symbolName(code)} />;
}
