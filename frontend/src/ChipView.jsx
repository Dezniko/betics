import { motion } from 'framer-motion';
import { denomFor, faceLabel, consolidatedLayers, fmtMoney } from './chips.js';

// One casino chip: coloured body, striped edge, inner ring, value in the middle.
// `label` overrides the face text (used when a stack shows its running total).
export function Chip({ cents, size = 26, selected = false, label, style, className = '' }) {
  const d = denomFor(cents);
  const text = label ?? d.label;
  const len = text.length;
  const font = Math.max(6, Math.round(size * (len > 3 ? 0.27 : len > 2 ? 0.31 : len > 1 ? 0.38 : 0.46)));
  return (
    <div
      data-chip-denomination={cents}
      className={`rounded-full relative shrink-0 ${className}`}
      style={{
        width: size,
        height: size,
        background: `repeating-conic-gradient(${d.edge} 0deg 16deg, ${d.base} 16deg 45deg)`,
        boxShadow: `0 ${Math.max(1, size * 0.06)}px ${size * 0.13}px rgba(0,0,0,0.55), inset 0 0 0 ${Math.max(1, size * 0.04)}px rgba(0,0,0,0.35)${
          selected ? ', 0 0 0 2.5px rgba(176,124,255,0.95), 0 0 12px 2px rgba(64,196,255,0.7)' : ''
        }`,
        ...style,
      }}
    >
      <div
        className="absolute rounded-full flex items-center justify-center font-extrabold leading-none"
        style={{
          inset: size * 0.15,
          background: d.base,
          border: `${Math.max(1, size * 0.04)}px dashed ${d.edge}`,
          color: d.text,
          fontSize: font,
          letterSpacing: '-0.04em',
          textShadow: '0 1px 1px rgba(0,0,0,0.4)',
        }}
      >
        {text}
      </div>
    </div>
  );
}

// Consolidate the stake into real denominations, largest at the bottom.
// The upper chip shows the exact spot total; up to three visible layers retain
// their individual colours. Raw placement history is never rewritten.
export const STACK_LAYERS = 3;
export function stackHeight(chipsOrCount, size) {
  const count = Array.isArray(chipsOrCount) ? consolidatedLayers(chipsOrCount, STACK_LAYERS).length : chipsOrCount;
  if (!count) return 0;
  return size + (Math.min(count, STACK_LAYERS) - 1) * Math.max(2, size * 0.1);
}

export function ChipStack({ chips, size = 22, glow = false, dim = false, ring = false, animateNewest = true }) {
  const total = chips.reduce((a, b) => a + b, 0);
  const display = consolidatedLayers(chips, STACK_LAYERS);
  const layers = display.length;
  const off = Math.max(2, size * 0.1);
  const height = stackHeight(display.length, size);
  if (!layers) return null;
  return (
    <div data-chip-total={total} role="img" aria-label={`Chips total ${fmtMoney(total)}`} className="relative pointer-events-none" style={{ width: size, height, opacity: dim ? 0.4 : 1, filter: dim ? 'grayscale(0.7)' : undefined }}>
      {glow && (
        <div className="absolute rounded-full" style={{ left: -size * 0.2, right: -size * 0.2, bottom: -size * 0.2, height: size * 1.4, boxShadow: '0 0 12px 4px rgba(243,217,139,0.85)', background: 'rgba(243,217,139,0.2)' }} />
      )}
      {ring && (
        <div className="absolute rounded-full" style={{ left: -4, right: -4, bottom: -4, height: size + 8, boxShadow: '0 0 0 2px #f3d98b' }} />
      )}
      {Array.from({ length: layers }).map((_, i) => {
        const isTop = i === layers - 1;
        return (
          <motion.div
            key={isTop ? `top-${total}` : `l-${i}`}
            className="absolute left-0"
            style={{ bottom: i * off }}
            initial={animateNewest && isTop ? { y: -size * 1.0, scale: 1.3, opacity: 0 } : false}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 520, damping: 22, mass: 0.7 }}
          >
            <Chip cents={display[i]} size={size} label={isTop ? faceLabel(total) : ''} />
          </motion.div>
        );
      })}
    </div>
  );
}
