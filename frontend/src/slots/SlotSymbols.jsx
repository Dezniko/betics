// Gods of Power symbols: original inline SVG, dark luxury palette (steel, gold for money, neon purple,
// blue and cyan as accents). One component per symbol code; every one carries the symbol name as its label.
import { symbolName } from '../../../backend/src/games/slotsMath.js';

const Svg = ({ code, children, defs }) => <svg className={`slot-sym slot-sym-${code}`} viewBox="0 0 100 100" role="img" aria-label={symbolName(code)} focusable="false">
  {defs && <defs>{defs}</defs>}
  {children}
</svg>;

// Golden key (wild): a round bow with a purple gem, a long shaft and two teeth.
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

// Diamond: a brilliant cut in cyan and white facets.
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

// Gold bar: a stepped ingot with a bright edge.
export const GoldBar = () => <Svg code="B" defs={<>
  <linearGradient id="gp-bar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffe9a8" /><stop offset=".45" stopColor="#e3b24e" /><stop offset="1" stopColor="#9a6c12" /></linearGradient>
  <linearGradient id="gp-bar-side" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#c99a34" /><stop offset="1" stopColor="#6d4a08" /></linearGradient>
</>}>
  <ellipse cx="50" cy="80" rx="36" ry="6" fill="rgba(214,176,106,.25)" />
  <polygon points="14,70 24,42 76,42 86,70" fill="url(#gp-bar-side)" />
  <polygon points="24,42 32,30 68,30 76,42" fill="url(#gp-bar)" />
  <polygon points="14,70 24,42 76,42 86,70" fill="none" stroke="#5a3d05" strokeWidth="1.5" strokeLinejoin="round" />
  <polygon points="24,42 32,30 68,30 76,42" fill="none" stroke="#5a3d05" strokeWidth="1.5" strokeLinejoin="round" />
  <rect x="34" y="50" width="32" height="12" rx="2" fill="none" stroke="#fff1c4" strokeWidth="1.4" opacity=".75" />
  <path d="M34 33h30" stroke="#fff8e0" strokeWidth="2" strokeLinecap="round" opacity=".9" />
</Svg>;

// Ruby: a cushion cut in red and magenta facets.
export const Ruby = () => <Svg code="R" defs={<>
  <linearGradient id="gp-ruby" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#ff8ab4" /><stop offset=".45" stopColor="#e3153f" /><stop offset="1" stopColor="#6f0520" /></linearGradient>
</>}>
  <ellipse cx="50" cy="84" rx="26" ry="5" fill="rgba(227,21,63,.22)" />
  <path d="M30 22h40l12 14v26L70 78H30L18 62V36z" fill="url(#gp-ruby)" stroke="#4d0315" strokeWidth="1.5" strokeLinejoin="round" />
  <path d="M38 36h24l8 8v14l-8 8H38l-8-8V44z" fill="#ff5a85" opacity=".75" />
  <path d="M30 22l8 14M70 22l-8 14M82 62l-12 4M18 62l12 4M30 78l8-12M70 78l-8-12" stroke="#ffd1df" strokeWidth="1.2" opacity=".7" />
  <path d="M36 30l10-4" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" opacity=".9" />
</Svg>;

// Coin stack: five gold coins, the top one face up.
export const CoinStack = () => <Svg code="C" defs={<>
  <linearGradient id="gp-coin" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#8d6a1c" /><stop offset=".5" stopColor="#f3d27a" /><stop offset="1" stopColor="#8d6a1c" /></linearGradient>
  <radialGradient id="gp-coin-face" cx=".4" cy=".35" r=".8"><stop offset="0" stopColor="#fff3c6" /><stop offset=".6" stopColor="#e2b650" /><stop offset="1" stopColor="#9c7420" /></radialGradient>
</>}>
  <ellipse cx="50" cy="86" rx="34" ry="5" fill="rgba(214,176,106,.25)" />
  {[76, 68, 60, 52].map((y) => <g key={y}><rect x="20" y={y - 6} width="60" height="10" rx="2" fill="url(#gp-coin)" /><ellipse cx="50" cy={y - 6} rx="30" ry="7" fill="#e7bf5c" stroke="#7d5a12" strokeWidth="1" /></g>)}
  <rect x="20" y="38" width="60" height="10" rx="2" fill="url(#gp-coin)" />
  <ellipse cx="50" cy="38" rx="30" ry="9" fill="url(#gp-coin-face)" stroke="#7d5a12" strokeWidth="1.2" />
  <ellipse cx="50" cy="38" rx="20" ry="5.5" fill="none" stroke="#a37d22" strokeWidth="1.2" />
  <path d="M30 20l8-2" stroke="#fff8e0" strokeWidth="2" strokeLinecap="round" opacity=".9" />
</Svg>;

// Royals: chrome letters in the display face on a dark plaque with a neon edge.
const Letter = ({ code, glyph, glow }) => <Svg code={code} defs={<>
  <linearGradient id={`gp-chrome-${code}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffffff" /><stop offset=".38" stopColor="#e8e3d6" /><stop offset=".55" stopColor="#a9a294" /><stop offset=".78" stopColor="#f4efe4" /><stop offset="1" stopColor="#c9c1af" /></linearGradient>
</>}>
  <rect x="16" y="14" width="68" height="72" rx="12" fill="#0f1119" stroke={glow} strokeWidth="2" opacity=".95" />
  <rect x="20" y="18" width="60" height="64" rx="9" fill="none" stroke={glow} strokeWidth=".8" opacity=".45" />
  <text x="50" y="66" textAnchor="middle" fontFamily="var(--bx-display)" fontSize="44" fontWeight="700" fill={`url(#gp-chrome-${code})`} stroke="#2a2a33" strokeWidth=".8">{glyph}</text>
</Svg>;
export const LetterA = () => <Letter code="A" glyph="A" glow="#a63cff" />;
export const LetterK = () => <Letter code="K" glyph="K" glow="#4a5cff" />;
export const LetterQ = () => <Letter code="Q" glyph="Q" glow="#22d3ff" />;
export const LetterJ = () => <Letter code="J" glyph="J" glow="#7c6bff" />;

export const SYMBOL_COMPONENTS = Object.freeze({
  W: GoldenKey,
  S: VaultDoor,
  D: Diamond,
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
