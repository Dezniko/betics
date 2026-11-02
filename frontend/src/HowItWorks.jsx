import { useCasinoReserve } from './CasinoReserve.jsx';
import { CONNECT_NOTICE } from './connectNotice.js';
import { PINNED_WALLET_URL, reserveWalletMatches } from './depositTarget.js';
import { fmtMoney } from './chips.js';
import SupportLink from './Support.jsx';

const CUSTODY_TEXT = CONNECT_NOTICE.sections[0].text;

// How it works: the game, fairness, top ups and withdrawals, and how every balance stays covered
// by the casino wallet (table limit, many players at once, while funds last). Plain words only.
export default function HowItWorksPage() {
  const r = useCasinoReserve();
  const live = r?.live && r.maxWinUnits > 0;
  const pct = r?.exposurePct || 25;
  const pinned = reserveWalletMatches(r);
  return <main className="terms-page how-page">
    <a className="terms-back" href="/">Back to the game</a>
    <img className="terms-logo" src="/brand/logo-480.webp" width="480" height="179" alt="qu-BETICS" />
    <h1>How it works</h1>
    <p>Everything you need to know about playing at qu-BETICS, in plain words.</p>

    {r?.live && <section className="how-live" data-testid="how-live">
      <div className="how-live-head"><span className="how-dot" aria-hidden="true" />Right now</div>
      <dl>
        <div><dt>Casino wallet</dt><dd>{fmtMoney(r.tokenUnits)}</dd></div>
        <div><dt>Player balances</dt><dd className={r.covered && pinned ? 'ok' : 'warn'} data-testid="how-covered">{!pinned ? 'Wallet not confirmed' : r.covered ? 'All covered' : 'Being checked'}</dd></div>
        <div><dt>Max win per spin</dt><dd data-testid="how-maxwin">{live ? fmtMoney(r.maxWinUnits) : 'Paused'}</dd></div>
        <div><dt>Max bet on one number</dt><dd data-testid="how-maxstraight">{live ? fmtMoney(r.maxStraightUnits) : 'Paused'}</dd></div>
      </dl>
      {!pinned && <p data-testid="how-wallet-mismatch">The server reported a different casino wallet than the one this page knows, so these figures cannot be confirmed.</p>}
      <a href={PINNED_WALLET_URL} target="_blank" rel="noopener noreferrer">See the casino wallet live on Etherscan</a>
    </section>}

    <h2>The game</h2>
    <p>qu-BETICS is European roulette: one wheel with 37 pockets, 0 to 36. Pick a chip, place it on the table and spin. A straight bet on one number pays 35 to 1, so you get back 36 times your stake. If the casino ever uses a table that pays less, the game shows you that table first and you play only after you accept it. Red or black, odd or even and 1 to 18 or 19 to 36 pay 1 to 1.</p>

    <h2>Demo and Real</h2>
    <p><b>Demo</b> is free practice money with no value. You do not need a wallet, and it follows the same table limit as real play, so nothing changes when you switch.</p>
    <p><b>Real</b> uses $TICS. Connect your Ethereum wallet, send official $TICS from that wallet to the casino wallet, and your balance appears once the transfer is confirmed on the blockchain.</p>

    {/* Same words as the Connect wallet notice (one source), so the two never contradict. */}
    <h2>Your balance is held by the casino</h2>
    <p data-testid="how-custody">{CUSTODY_TEXT}</p>

    <h2>Every spin is fair, and you can check it</h2>
    <p>Before you bet, the casino locks in its secret for the next spin and shows you a code for that lock. Your browser then adds its own random value, plus your lucky word if you set one. The result comes from all of these together, so the casino cannot change it after you bet without the check failing.</p>
    <p>After each spin your browser checks the result and the payout by itself. If anything does not match, the game stops and tells you.</p>

    <h2>Withdrawals</h2>
    <p>Withdrawals are sent automatically and only go to the wallet that made the deposit. The network fee is shown before you confirm, and a minimum amount applies. Payouts can be held for a safety check when a transfer looks unusual, but your balance stays yours while that happens.</p>

    <h2>How your balance is covered</h2>
    <p>The casino wallet is a public Ethereum address, so anyone can see what it holds. Every player balance counts as money the casino owes. Only what is left after that, the free float, can be used to pay wins.</p>
    <p>Before every spin the game works out the biggest payout your chips could get, on any number. If that is more than the casino can pay while still covering every other balance, the bet is refused before the wheel turns. So the casino wallet is designed to always hold enough to pay every balance shown in the game.</p>

    <h2>The table limit</h2>
    <p>The most one spin can pay is {pct}% of the free float{live ? <>, which is <b>{fmtMoney(r.maxWinUnits)}</b> right now</> : ''}. That is the max win per spin, stake included.</p>
    <p>The table adds up all your chips, on every number and every bet, and stops you as you place them. Because a straight bet pays 36 times, the max bet on one number is the max win per spin divided by 36{live ? <>, so <b>{fmtMoney(r.maxStraightUnits)}</b> right now</> : ''}. Both figures are always shown live in the Casino reserve card.</p>

    <h2>When lots of people play at the same time</h2>
    <p>Say 10 players spin at the same moment, each going for a big win. Before each real spin runs, the casino reserves its biggest possible win from the free float, one spin at a time, in a single step. When there is no room left for the next one, that player is asked to try again in a few seconds. A spin is never allowed to win money that is already reserved for someone else.</p>
    <p>Even if all 10 hit their biggest possible win, the game is designed so every one of them can be paid, and every other player balance is still covered.</p>

    <h2>While funds last</h2>
    <p>The table limit follows the casino wallet. After big wins it gets smaller. If the free float runs out, big bets and then real play are paused until the casino tops the wallet up. That only limits new bets. It never touches your balance, which stays yours and can be withdrawn.</p>

    <h2>What this does not cover</h2>
    <p>These safeguards are how the game is built, not a guarantee. The casino has not been audited by a third party, and like any online service it can have bugs or be attacked. You play at your own risk and for fun. Please read the <a href="/terms">Terms</a>.</p>

    <h2>Need help?</h2>
    <SupportLink className="how-support" testid="how-support" />
  </main>;
}
