// Gods of Power symbols: original inline SVG, dark luxury palette (steel, gold for money, neon purple,
// blue and cyan as accents) plus four crypto coins carrying their real marks. One component per symbol code; every one carries the symbol name as its label.
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
// a gold ring with neon glow, rendered as an image. A small gold WILD ribbon sits on the lower part of
// the ring so players know it is the wild; it scales with the symbol (see .slot-wild-tag in slots.css).
export const GodsOfPower = () => <span className="slot-sym slot-sym-W slot-sym-wild" role="img" aria-label={symbolName('W')}>
  <img className="slot-sym-img" src="/slots/gods-of-power.webp" width="512" height="512" alt="" draggable="false" />
  <i className="slot-wild-tag" aria-hidden="true">WILD</i>
</span>;

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

// Treasure chest: dark wood with gold bands and a gold lock plate, the lid raised a little so gold
// light pours out of the gap with coins and a gem spilling over the front. Cyan and purple neon rim lights.
const CHEST_CLIP = 'gp-chest-clip';
export const TreasureChest = () => <Svg code="C" defs={<>
  <linearGradient id="gp-chest-wood" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#6b3d1a" /><stop offset=".5" stopColor="#3f2210" /><stop offset="1" stopColor="#221006" /></linearGradient>
  <linearGradient id="gp-chest-lid" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#8a5224" /><stop offset=".6" stopColor="#4a2812" /><stop offset="1" stopColor="#2a1407" /></linearGradient>
  <linearGradient id="gp-chest-gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff1c0" /><stop offset=".4" stopColor="#f1c860" /><stop offset=".8" stopColor="#b8851d" /><stop offset="1" stopColor="#e8bd55" /></linearGradient>
  <linearGradient id="gp-chest-gold-h" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#9a6a14" /><stop offset=".5" stopColor="#ffe59a" /><stop offset="1" stopColor="#9a6a14" /></linearGradient>
  <linearGradient id="gp-chest-light" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff7d6" stopOpacity=".95" /><stop offset=".6" stopColor="#ffd56a" stopOpacity=".8" /><stop offset="1" stopColor="#ffb02e" stopOpacity=".35" /></linearGradient>
  <radialGradient id="gp-chest-beam" cx=".5" cy="1" r=".75"><stop offset="0" stopColor="#ffe9a8" stopOpacity=".95" /><stop offset=".45" stopColor="#ffcc4d" stopOpacity=".45" /><stop offset="1" stopColor="#ffb02e" stopOpacity="0" /></radialGradient>
  <radialGradient id="gp-chest-coin" cx=".4" cy=".35" r=".8"><stop offset="0" stopColor="#fff6d2" /><stop offset=".55" stopColor="#efc55a" /><stop offset="1" stopColor="#a67b20" /></radialGradient>
  <linearGradient id="gp-chest-gem" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#ffd3e4" /><stop offset=".45" stopColor="#ff2f66" /><stop offset="1" stopColor="#8a0626" /></linearGradient>
  <clipPath id={CHEST_CLIP}><path d="M14 56q0-6 6-6h60q6 0 6 6v30q0 4-4 4H18q-4 0-4-4z" /><path d="M14 40V36q0-20 36-20t36 20v4z" transform="translate(0 -3) rotate(-7 84 40)" /></clipPath>
</>}>
  <Glow id="gp-chest-glow" color="#f1c860" cy="52" rx="44" ry="40" />
  <ellipse cx="50" cy="90" rx="36" ry="4" fill="#000" opacity=".45" />
  {/* light pouring from the gap, behind everything */}
  <ellipse cx="50" cy="48" rx="40" ry="18" fill="url(#gp-chest-beam)" />
  {/* body */}
  <path d="M14 56q0-6 6-6h60q6 0 6 6v30q0 4-4 4H18q-4 0-4-4z" fill="url(#gp-chest-wood)" />
  <path d="M36 50v40M64 50v40" stroke="#1a0c04" strokeWidth="1.2" opacity=".7" />
  <path d="M20 50h60" stroke="#8a5224" strokeWidth="1.2" opacity=".9" />
  {/* gold bands and lock */}
  <rect x="21" y="50" width="8" height="40" fill="url(#gp-chest-gold)" /><rect x="71" y="50" width="8" height="40" fill="url(#gp-chest-gold)" />
  <rect x="14" y="83" width="72" height="4" fill="url(#gp-chest-gold-h)" />
  <rect x="42" y="50" width="16" height="17" rx="3" fill="url(#gp-chest-gold)" stroke="#6b4a0c" strokeWidth=".8" />
  <path d="M50 54.5a2.6 2.6 0 0 1 1.6 4.7L53 63h-6l1.4-3.8A2.6 2.6 0 0 1 50 54.5z" fill="#1d1006" />
  <path d="M22.5 52v36M72.5 52v36" stroke="#fff3cf" strokeWidth="1" opacity=".55" />
  {/* the gap: bright light with coins and a gem in it */}
  <rect x="17" y="34" width="66" height="18" fill="url(#gp-chest-light)" />
  <ellipse cx="50" cy="46" rx="30" ry="9" fill="#fff6d0" opacity=".75" />
  <circle cx="30" cy="49" r="4.6" fill="url(#gp-chest-coin)" stroke="#8a6414" strokeWidth=".7" />
  <circle cx="41" cy="47.5" r="5" fill="url(#gp-chest-coin)" stroke="#8a6414" strokeWidth=".7" />
  <circle cx="62" cy="47" r="5.2" fill="url(#gp-chest-coin)" stroke="#8a6414" strokeWidth=".7" />
  <circle cx="72" cy="49.5" r="4.4" fill="url(#gp-chest-coin)" stroke="#8a6414" strokeWidth=".7" />
  <path d="M51 38l7 6-7 9-7-9z" fill="url(#gp-chest-gem)" stroke="#ffd6e2" strokeWidth=".9" strokeLinejoin="round" />
  <path d="M47 43h8" stroke="#fff" strokeWidth=".9" opacity=".8" />
  {/* coins spilling over the front edge */}
  <ellipse cx="33" cy="54" rx="6" ry="3.4" fill="url(#gp-chest-coin)" stroke="#8a6414" strokeWidth=".7" transform="rotate(-18 33 54)" />
  <ellipse cx="66" cy="55" rx="6" ry="3.4" fill="url(#gp-chest-coin)" stroke="#8a6414" strokeWidth=".7" transform="rotate(16 66 55)" />
  <ellipse cx="86" cy="86" rx="5.5" ry="3.2" fill="url(#gp-chest-coin)" stroke="#8a6414" strokeWidth=".7" transform="rotate(-10 86 86)" />
  <ellipse cx="13" cy="88" rx="5" ry="3" fill="url(#gp-chest-coin)" stroke="#8a6414" strokeWidth=".7" transform="rotate(12 13 88)" />
  {/* lid, raised and tilted back on its right hinge */}
  <g transform="translate(0 -3) rotate(-7 84 40)">
    <ellipse cx="50" cy="41" rx="34" ry="3.5" fill="#1a0c04" />
    <path d="M14 40V36q0-20 36-20t36 20v4z" fill="url(#gp-chest-lid)" />
    <path d="M21 40V30.5q3-9 8-11.3V40zM71 40V30.5q-3-9-8-11.3V40z" fill="url(#gp-chest-gold)" />
    <rect x="14" y="38" width="72" height="4" rx="1" fill="url(#gp-chest-gold-h)" />
    <path d="M20 32q6-12 30-13" stroke="#c98a45" strokeWidth="1.2" strokeLinecap="round" fill="none" opacity=".8" />
    <path d="M20 32q6-12 30-13" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" fill="none" opacity=".55" />
    <path d="M14 40V36q0-20 36-20" stroke="#22d3ff" strokeWidth="1.6" strokeLinecap="round" fill="none" opacity=".85" />
  </g>
  {/* neon rim light on the body */}
  <path d="M86 56v30q0 4-4 4" stroke="#a63cff" strokeWidth="1.6" strokeLinecap="round" fill="none" opacity=".85" />
  <Shine clip={CHEST_CLIP} id="gp-chest" />
  <Star x="52" y="36" r="5" delay={0.3} color="#fff7d6" /><Star x="84" y="48" r="3.4" delay={1.7} color="#fff3c4" /><Star x="20" y="60" r="2.8" delay={2.9} />
</Svg>;

// Crypto coins (A, K, Q, J): thick glossy 3D coins with a reeded edge, a bevelled rim, an inner
// shadow, a specular sweep, sparkles and a soft coloured glow, each carrying its real mark: Bitcoin,
// Ethereum, Solana and Tether. The face is centred on (50, 47) with the edge showing below it.
const COINS = {
  A: { face: ['#ffd27a', '#f7931a', '#b95a05'], rim: ['#ffe2a8', '#ff9b22', '#c86a08'], edge: ['#e08a16', '#6e3703'], glow: '#ff9f2e', stars: [[22, 24], [80, 32], [66, 84]] },
  K: { face: ['#9fb0ff', '#4b5fe0', '#1b2270'], rim: ['#d6dcff', '#6f80ff', '#3540b0'], edge: ['#4b58d8', '#12165a'], glow: '#6b7cff', stars: [[76, 20], [26, 78], [66, 64]] },
  Q: { face: ['#3d4258', '#15171f', '#040406'], rim: ['#e3e6f2', '#8f95ab', '#3f4457'], edge: ['#5a6078', '#0b0d14'], glow: '#9945ff', stars: [[22, 22], [80, 30], [34, 84]] },
  J: { face: ['#86ecc6', '#26a17b', '#0b5a3f'], rim: ['#d4fff0', '#4ad0a0', '#1a8a66'], edge: ['#209a74', '#073a29'], glow: '#2fd49a', stars: [[30, 24], [84, 70], [40, 90]] },
};
const COIN_CX = 50, COIN_CY = 47, COIN_R = 37, COIN_DEPTH = 6;

// Bitcoin: the white B tilted 14 degrees, with the two vertical strokes above and below.
const BitcoinMark = () => <g fill="#fff" stroke="#fff" transform={`rotate(14 ${COIN_CX} ${COIN_CY}) translate(${COIN_CX} ${COIN_CY}) scale(.86) translate(${-COIN_CX} ${-COIN_CY})`}>
  <rect x="42.5" y="20" width="4.6" height="9" rx="1" stroke="none" /><rect x="51.5" y="20" width="4.6" height="9" rx="1" stroke="none" />
  <rect x="42.5" y="65" width="4.6" height="9" rx="1" stroke="none" /><rect x="51.5" y="65" width="4.6" height="9" rx="1" stroke="none" />
  <rect x="36.5" y="27" width="7.5" height="40" rx="1" stroke="none" />
  <path d="M40 30.75H54.5a8.75 8.75 0 0 1 0 17.5H40" fill="none" strokeWidth="7.5" />
  <path d="M40 48.25H57a9.25 9.25 0 0 1 0 18.5H40" fill="none" strokeWidth="7.5" />
</g>;

// Ethereum: the two tone diamond, lighter on the left, darker on the right.
const EthereumMark = () => <g>
  <polygon points="50,16 30,51 50,63" fill="#ffffff" />
  <polygon points="50,16 70,51 50,63" fill="#c9d1ff" />
  <polygon points="50,38 30,51 50,63" fill="#e9ecff" opacity=".9" />
  <polygon points="50,38 70,51 50,63" fill="#aab5ff" />
  <polygon points="50,69 30,55.5 50,80" fill="#ffffff" />
  <polygon points="50,69 70,55.5 50,80" fill="#c9d1ff" />
</g>;

// Solana: three slanted bars, teal at the bottom left to purple at the top right.
const SolanaMark = () => <g fill="url(#gp-Q-mark)">
  <polygon points="32,31.5 70,31.5 62,40 24,40" />
  <polygon points="24,42.75 62,42.75 70,51.25 32,51.25" />
  <polygon points="32,54 70,54 62,62.5 24,62.5" />
</g>;

// Tether: the white T whose crossbar sits on a disc, the stem running down through the ring.
const TetherMark = () => <g>
  <ellipse cx="50" cy="40.5" rx="21" ry="7.2" fill="#fff" />
  <ellipse cx="50" cy="41" rx="15.5" ry="3.9" fill="#26a17b" />
  <rect x="44.5" y="25" width="11" height="45" rx="1.5" fill="#fff" />
  <rect x="29" y="24" width="42" height="9" rx="1.5" fill="#fff" />
</g>;

const COIN_MARKS = { A: BitcoinMark, K: EthereumMark, Q: SolanaMark, J: TetherMark };

const Coin = ({ code }) => {
  const C = COINS[code], id = `gp-${code}`, clip = `${id}-clip`, Mark = COIN_MARKS[code];
  const faceR = COIN_R - 6;
  return <Svg code={code} defs={<>
    <radialGradient id={`${id}-face`} cx=".36" cy=".3" r=".85"><stop offset="0" stopColor={C.face[0]} /><stop offset=".5" stopColor={C.face[1]} /><stop offset="1" stopColor={C.face[2]} /></radialGradient>
    <linearGradient id={`${id}-rim`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={C.rim[0]} /><stop offset=".45" stopColor={C.rim[1]} /><stop offset=".75" stopColor={C.rim[2]} /><stop offset="1" stopColor={C.rim[0]} /></linearGradient>
    <linearGradient id={`${id}-edge`} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor={C.edge[1]} /><stop offset=".5" stopColor={C.edge[0]} /><stop offset="1" stopColor={C.edge[1]} /></linearGradient>
    <radialGradient id={`${id}-inner`} cx=".5" cy=".5" r=".5"><stop offset=".72" stopColor="#000" stopOpacity="0" /><stop offset="1" stopColor="#000" stopOpacity=".5" /></radialGradient>
    <linearGradient id={`${id}-top`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".5" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></linearGradient>
    {code === 'Q' && <linearGradient id="gp-Q-mark" gradientUnits="userSpaceOnUse" x1="24" y1="62" x2="70" y2="32"><stop offset="0" stopColor="#00ffa3" /><stop offset=".5" stopColor="#5fd0d8" /><stop offset="1" stopColor="#dc1fff" /></linearGradient>}
    <clipPath id={clip}><circle cx={COIN_CX} cy={COIN_CY} r={COIN_R} /></clipPath>
  </>}>
    <Glow id={`${id}-glow`} color={C.glow} cy="52" rx="44" ry="42" />
    {/* the thick edge below the face, with reeding */}
    <circle cx={COIN_CX} cy={COIN_CY + COIN_DEPTH} r={COIN_R} fill={`url(#${id}-edge)`} />
    <circle cx={COIN_CX} cy={COIN_CY + COIN_DEPTH} r={COIN_R - 1.5} fill="none" stroke="#000" strokeOpacity=".45" strokeWidth="3" strokeDasharray="1.4 1.9" />
    <ellipse cx={COIN_CX} cy={COIN_CY + COIN_DEPTH + COIN_R - 1} rx="22" ry="1.6" fill="#fff" opacity=".18" />
    {/* bevelled rim and the face */}
    <circle cx={COIN_CX} cy={COIN_CY} r={COIN_R} fill={`url(#${id}-rim)`} />
    <circle cx={COIN_CX} cy={COIN_CY} r={faceR + .6} fill="#000" opacity=".35" />
    <circle cx={COIN_CX} cy={COIN_CY} r={faceR} fill={`url(#${id}-face)`} />
    <circle cx={COIN_CX} cy={COIN_CY} r={faceR} fill={`url(#${id}-inner)`} />
    {/* a soft top light on the face, behind the mark so the mark stays crisp */}
    <ellipse cx="38" cy="28" rx="16" ry="7" fill="#fff" opacity=".2" transform="rotate(-28 38 28)" clipPath={`url(#${clip})`} />
    <Mark />
    {/* bevel highlight on the top half of the rim */}
    <path d={`M${COIN_CX - COIN_R} ${COIN_CY}A${COIN_R} ${COIN_R} 0 0 1 ${COIN_CX + COIN_R} ${COIN_CY}`} fill="none" stroke="#fff" strokeWidth="2.2" opacity=".55" clipPath={`url(#${clip})`} />
    <circle cx={COIN_CX} cy={COIN_CY} r={COIN_R - .8} fill="none" stroke="#fff" strokeWidth="1" opacity=".35" />
    <Shine clip={clip} id={id} />
    {C.stars.map(([x, y], i) => <Star key={i} x={x} y={y} r={i === 0 ? 5 : i === 1 ? 3.6 : 2.6} delay={i * 1.1 + (code.charCodeAt(0) % 4) * 0.3} color={i === 1 ? C.rim[0] : '#ffffff'} />)}
  </Svg>;
};
export const Bitcoin = () => <Coin code="A" />;
export const Ethereum = () => <Coin code="K" />;
export const Solana = () => <Coin code="Q" />;
export const Tether = () => <Coin code="J" />;

// Qubetics (top regular symbol): the official Qubetics logo (used with permission), soft glow only.
export const Qubetics = () => <img className="slot-sym slot-sym-D slot-sym-img" src="/slots/qubetics.webp" width="512" height="512" alt={symbolName('D')} draggable="false" />;

export const SYMBOL_COMPONENTS = Object.freeze({
  W: GodsOfPower,
  S: VaultDoor,
  D: Qubetics,
  B: GoldBar,
  R: Ruby,
  C: TreasureChest,
  A: Bitcoin,
  K: Ethereum,
  Q: Solana,
  J: Tether,
});

export function SlotSymbol({ code }) {
  const C = SYMBOL_COMPONENTS[code];
  return C ? <C /> : <span className="slot-sym slot-sym-missing" aria-label={symbolName(code)} />;
}
