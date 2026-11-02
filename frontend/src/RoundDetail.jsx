import { motion } from 'framer-motion';
import { betLabel, pocketColor } from './rouletteRules.js';
import { decompose, fmtMoney, fmtShort } from './chips.js';
import { Chip } from './ChipView.jsx';

// Click a round in "Recent rounds" → a breakdown of exactly what happened:
// every bet, what it returned, and the net — winners first.
export default function RoundDetail({ round, onClose, onVerify }) {
  let outcome = null;
  try { outcome = round.outcome_json ? JSON.parse(round.outcome_json) : null; } catch { outcome = null; }
  const results = outcome?.betResults || [];
  const pocket = outcome?.pocket;
  const colour = pocket != null ? pocketColor(pocket) : 'black';
  const stake = round.stake_cents || 0;
  const returned = round.payout_cents || 0;
  const net = returned - stake;
  const winners = results.filter((r) => r.won || r.payoutCents > 0).sort((a, b) => b.payoutCents - a.payoutCents);
  const losers = results.filter((r) => !(r.won || r.payoutCents > 0)).sort((a, b) => b.amountCents - a.amountCents);

  const Row = ({ r, win }) => {
    const bet = { type: r.type, value: r.value };
    const ret = r.payoutCents || 0;
    return (
      <div className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left ${win ? 'bg-emerald-900/25 border border-emerald-600/40' : 'bg-black/25 border border-white/5'}`}>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-[#ede9e1] truncate">{betLabel(bet)}</div>
          <div className="text-[11px] text-[#9b98ab]">bet {fmtShort(r.amountCents)}</div>
        </div>
        {win && (
          <div className="flex items-center -space-x-2 shrink-0">
            {decompose(ret, 4).map((c, k) => <Chip key={k} cents={c} size={18} />)}
          </div>
        )}
        <div className={`text-sm font-bold min-w-[78px] whitespace-nowrap text-right shrink-0 ${win ? 'text-emerald-300' : 'text-red-400'}`}>
          {win ? `+${fmtShort(ret - r.amountCents)}` : `-${fmtShort(r.amountCents)}`}
        </div>
      </div>
    );
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 px-3"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0, y: 16 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.95, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 24 }}
        onClick={(e) => e.stopPropagation()}
        className="bg-gradient-to-br from-[#15151f] to-[#09090e] border border-[#d6b06a]/70 rounded-2xl p-4 w-full max-w-lg max-h-[90vh] flex flex-col"
      >
        <div className="flex items-center gap-3">
          <div className={`w-12 h-12 rounded-full flex items-center justify-center text-xl font-extrabold text-white border-2 border-[#d6b06a] shrink-0 ${
            colour === 'red' ? 'bg-red-700' : colour === 'green' ? 'bg-emerald-700' : 'bg-zinc-800'
          }`}>{pocket ?? '-'}</div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-[#ede9e1]">Round #{round.id}</div>
            <div className="text-[11px] text-[#9b98ab]">{round.created_at} · {results.length} {results.length === 1 ? 'bet' : 'bets'}</div>
          </div>
          <button onClick={onClose} className="text-[#9b98ab] hover:text-[#ede9e1] text-xl leading-none px-2" aria-label="Close">×</button>
        </div>

        <div className="grid grid-cols-3 gap-2 my-3 text-center">
          <div className="rounded-lg bg-black/30 py-2"><div className="text-[10px] tracking-widest text-[#9b98ab]">BET</div><div className="font-bold text-[#ede9e1]">{fmtMoney(stake)}</div></div>
          <div className="rounded-lg bg-black/30 py-2"><div className="text-[10px] tracking-widest text-[#9b98ab]">RETURNED</div><div className="font-bold text-[#ede9e1]">{fmtMoney(returned)}</div></div>
          <div className={`rounded-lg py-2 ${net > 0 ? 'bg-emerald-900/40' : net < 0 ? 'bg-red-900/30' : 'bg-black/30'}`}>
            <div className="text-[10px] tracking-widest text-[#9b98ab]">NET</div>
            <div className={`font-extrabold ${net > 0 ? 'text-emerald-300' : net < 0 ? 'text-red-400' : 'text-[#ede9e1]'}`}>{net > 0 ? '+' : net < 0 ? '-' : ''}{fmtMoney(Math.abs(net))}</div>
          </div>
        </div>

        <div className="overflow-y-auto space-y-1.5 pr-1">
          {results.length === 0 && <div className="text-xs text-[#9b98ab] text-center py-4">This round has no bet breakdown stored.</div>}
          {winners.length > 0 && <div className="text-[11px] tracking-widest text-emerald-400/90 pt-1">WINNING BETS ({winners.length})</div>}
          {winners.map((r, i) => <Row key={`w${i}`} r={r} win />)}
          {losers.length > 0 && (
            <details className="pt-1" open={winners.length === 0 && losers.length <= 12}>
              <summary className="text-[11px] tracking-widest text-red-400/90 cursor-pointer select-none py-1">LOSING BETS ({losers.length}) · tap to {winners.length === 0 && losers.length <= 12 ? 'hide' : 'show'}</summary>
              <div className="space-y-1.5 mt-1">{losers.map((r, i) => <Row key={`l${i}`} r={r} />)}</div>
            </details>
          )}
        </div>

        <div className="flex justify-between items-center mt-3 pt-3 border-t border-white/10">
          <button onClick={() => onVerify(round)} className="text-xs text-[#d6b06a] underline underline-offset-2">Verify this outcome independently →</button>
          <button onClick={onClose} className="px-4 py-1.5 rounded-lg bg-[#1d1d29] text-sm">Close</button>
        </div>
      </motion.div>
    </motion.div>
  );
}
