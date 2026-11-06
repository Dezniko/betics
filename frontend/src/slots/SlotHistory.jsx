import { useEffect, useState } from 'react';
import { fmtMoney } from '../chips.js';
import { slotHistoryRows, checkSlotHistoryRound } from './slotHistory.js';

// The slot's History tab in the profile sheet: the last rounds with stake, payout and the number of
// spins, and a 'Check this round' button that recomputes the round in this browser.
const when = (s) => { if (!s) return ''; try { return new Date(String(s).replace(' ', 'T') + (String(s).includes('Z') ? '' : 'Z')).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };

export default function SlotHistory({ refreshKey = 0 }) {
  const [rows, setRows] = useState(null);
  const [checks, setChecks] = useState({});
  useEffect(() => {
    let live = true;
    fetch('/api/rounds').then((r) => (r.ok ? r.json() : [])).then((list) => { if (live) setRows(slotHistoryRows(list)); }).catch(() => { if (live) setRows([]); });
    return () => { live = false; };
  }, [refreshKey]);
  const check = async (round) => {
    setChecks((c) => ({ ...c, [round.roundId]: { busy: true } }));
    const result = await checkSlotHistoryRound(round).catch((e) => ({ ok: false, problems: [e.message], receipt: false }));
    setChecks((c) => ({ ...c, [round.roundId]: result }));
  };
  if (rows === null) return <p className="fair-note">Loading your rounds...</p>;
  if (rows.length === 0) return <p className="fair-note" data-testid="slot-history-empty">No rounds yet. Spin the reels and they show here.</p>;
  return <ul className="profile-history slot-history" data-testid="slot-history">
    {rows.map((r) => {
      const c = checks[r.roundId];
      const net = r.totalPayoutCents - r.stake;
      return <li key={r.roundId} data-testid="slot-history-row" data-round={r.roundId}>
        <div className="profile-history-main">
          <span className="profile-history-title">Round #{r.roundId} <small>{when(r.at)}</small></span>
          <span className="profile-history-sub">Bet {fmtMoney(r.stake)}, {r.spins.length} {r.spins.length === 1 ? 'spin' : 'spins'}{r.freeSpinsAwarded ? `, ${r.freeSpinsAwarded} free` : ''}</span>
        </div>
        <span className={`profile-history-net ${net > 0 ? 'win' : net < 0 ? 'loss' : ''}`}>{net > 0 ? '+' : ''}{fmtMoney(net)}</span>
        <div className="profile-history-check">
          {c && !c.busy ? <span className={`profile-history-verdict ${c.ok ? 'ok' : 'bad'}`} data-testid="slot-history-verdict" data-ok={c.ok ? 'yes' : 'no'}>
            {c.ok ? (c.receipt ? 'Checked against your receipt' : 'Reveal checked') : 'Does not match'}
          </span>
            : <button type="button" className="profile-mini" disabled={!!c?.busy} onClick={() => check(r)} data-testid="slot-history-check">{c?.busy ? 'Checking...' : 'Check this round'}</button>}
          {c && !c.busy && !c.ok && <ul className="fair-note slot-fair-problems">{c.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        </div>
      </li>;
    })}
  </ul>;
}
