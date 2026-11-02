import { motion, AnimatePresence } from 'framer-motion';
import { pocketColor } from './rouletteRules.js';

const FILL = { red: 'bg-red-700', black: 'bg-zinc-800', green: 'bg-emerald-600' };

// The last 20 numbers the wheel has landed on — newest first — shown
// whether the player won or lost. Updates the instant the ball settles.
export default function RecentNumbers({ numbers, compact = false }) {
  const last = numbers.slice(0, 20); // items are { id, n }
  const counts = { red: 0, black: 0, green: 0 };
  last.forEach(({ n }) => { counts[pocketColor(n)] += 1; });
  if (compact) {
    return (
      <div className="brand-panel rounded-xl noselect px-2 py-1 flex items-center gap-2">
        <div className="text-[10px] tracking-[0.15em] text-[#9b98ab] shrink-0">LAST 20</div>
        {last.length === 0 ? (
          <div className="text-[11px] text-[#63607a]">numbers appear here</div>
        ) : (
          <div className="flex gap-1 flex-nowrap overflow-hidden">
            {last.map(({ id, n }, i) => (
              <motion.div
                key={id}
                initial={{ scale: 0 }}
                animate={{ scale: i === 0 ? 1.12 : 1 }}
                transition={{ type: 'spring', stiffness: 420, damping: 18 }}
                className={`w-[21px] h-[21px] shrink-0 rounded-full flex items-center justify-center text-[10px] font-bold text-white ${FILL[pocketColor(n)]} ${
                  i === 0 ? 'ring-2 ring-[#f3d98b]' : 'border border-white/10'
                }`}
              >
                {n}
              </motion.div>
            ))}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className={`brand-panel rounded-xl noselect ${compact ? 'px-2 py-1' : 'px-3 py-2.5'}`}>
      <div className={`flex items-center justify-between ${compact ? 'mb-0.5' : 'mb-1.5'}`}>
        <div className="text-[11px] tracking-[0.2em] text-[#9b98ab]">LAST 20 NUMBERS</div>
        <div className="flex items-center gap-2 text-[11px] text-[#9b98ab]">
          <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-full bg-red-700 inline-block" />{counts.red}</span>
          <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-full bg-zinc-600 inline-block" />{counts.black}</span>
          <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-full bg-emerald-600 inline-block" />{counts.green}</span>
        </div>
      </div>
      {last.length === 0 ? (
        <div className="text-xs text-[#63607a] py-1.5">No spins yet. The numbers that come up will appear here.</div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          <AnimatePresence initial={false}>
            {last.map(({ id, n }, i) => (
              <motion.div
                key={id}
                layout
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: i === 0 ? 1.12 : 1, opacity: 1 - Math.min(i, 19) * 0.02 }}
                transition={{ type: 'spring', stiffness: 420, damping: 18 }}
                title={i === 0 ? `Latest: ${n}` : `${i} spin${i === 1 ? '' : 's'} ago: ${n}`}
                className={`${compact ? 'w-[21px] h-[21px] text-[10px]' : 'w-[26px] h-[26px]'} rounded-full flex items-center justify-center ${compact ? '' : 'text-[12px]'} font-bold text-white ${FILL[pocketColor(n)]} ${
                  i === 0 ? 'ring-2 ring-[#f3d98b] shadow-[0_0_10px_rgba(243,217,139,0.6)]' : 'border border-white/10'
                }`}
              >
                {n}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
