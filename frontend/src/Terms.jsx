import { useState } from 'react';
import { TICS_CONTRACT } from './depositTarget.js';

// First visit: 18+ and Terms. Remembered in this browser (localStorage).
export function AgeGate({ onAccept }) {
  const [checked, setChecked] = useState(false);
  return <div className="fair-backdrop age-gate-backdrop" data-testid="age-gate">
    <div className="fair-modal age-gate" role="dialog" aria-modal="true" aria-label="Before you play">
      <img className="age-gate-logo" src="/brand/logo-480.webp" width="480" height="179" alt="qu-BETICS" />
      <div className="fair-head"><h3>Before you play</h3></div>
      <p className="fair-note">qu-BETICS is for adults only. Please read <a href="/how-it-works" target="_blank" rel="noopener">How it works</a> and the <a href="/terms" target="_blank" rel="noopener">Terms</a> first.</p>
      <label className="wallet-check age-check"><input type="checkbox" id="age-confirm" name="ageConfirm" checked={checked} onChange={(e) => setChecked(e.target.checked)} data-testid="age-check" /><span>I am 18 or older and I accept the <a href="/terms" target="_blank" rel="noopener">Terms</a></span></label>
      <button type="button" className="fair-btn fair-btn-wide" disabled={!checked} onClick={onAccept} data-testid="age-continue">Continue</button>
    </div>
  </div>;
}

export { TICS_CONTRACT }; // single source: depositTarget.js

export function TermsPage() {
  return <main className="terms-page">
    <a className="terms-back" href="/">Back to the game</a>
    <img className="terms-logo" src="/brand/logo-480.webp" width="480" height="179" alt="qu-BETICS" />
    <h1>Terms</h1>
    <p className="terms-updated">Last updated 4 November 2026</p>
    <p>Please read these terms before you play. By opening the game, connecting a wallet, sending $TICS or placing a bet, you accept them in full. If you do not accept them, do not play.</p>
    <p>See also <a href="/how-it-works">How it works</a>, which explains in plain words how balances, the table limit and payouts work.</p>

    <h2>1. Who can play</h2>
    <p>You must be 18 or older, and allowed to play where you live.</p>
    <p>It is your responsibility to check that playing is legal for you. Do not play where it is not. We may refuse or close any account, and block any country, at any time.</p>

    <h2>2. Play for fun, at your own risk</h2>
    <p>You play at your own risk. Roulette is a game of chance and the house has an edge, so over time players lose more than they win. Only play with money you can afford to lose.</p>
    <p>qu-BETICS is entertainment. It is not an investment, a way to earn money or a financial service, and nothing here is financial advice. Any $TICS you stake can be lost in full, and past results say nothing about future spins.</p>

    <h2>3. No third party audit and no guarantees</h2>
    <p>The game, the fairness tools, the payout system and the casino wallet set up have not been audited by an independent security, smart contract or gaming audit company. The fairness tools let you check spins yourself, but they are not an external audit of the casino.</p>
    <p>Everything is provided as is and as available, without any promise or warranty of any kind, express or implied. That includes, as far as the law allows, any promise that the service works as described, is accurate, is fit for a purpose, is secure, or runs without flaws.</p>
    <p>The software may contain flaws, errors or interruptions. We give no guarantee of availability or of any results, and we do not promise that the safeguards described in How it works will always work.</p>

    <h2>4. Security, hacks and loss of funds</h2>
    <p>Online services, wallets and blockchains can be attacked or fail. Despite our safeguards, things like a hack, exploit, bug, theft of keys, a failure of the $TICS token or of Ethereum, or a failure of a provider we rely on (hosting, wallet connection, blockchain data) could delay payouts or cause a loss of funds. That includes $TICS held in the casino wallet and the balances shown in the game.</p>
    <p>By playing you accept this risk. As far as the law allows, we are not liable for losses caused by such events, or by anything outside our reasonable control.</p>

    <h2>5. Your balance, the casino wallet and the table limit</h2>
    <p>Your real balance is $TICS you deposited plus your winnings, minus your losses and withdrawals. The game is built so the casino wallet always holds enough $TICS to pay every player balance, and it refuses any bet that could win more than the casino can pay right now. How it works explains this in detail.</p>
    <p>The max win per spin and the max bet on one number change with the casino wallet. They can fall, and real play can be paused, until the casino tops up the wallet. While funds last, we may change limits at any time without notice.</p>

    <h2>6. Top ups and withdrawals</h2>
    <p>Blockchain transfers cannot be reversed. Check the amount and the address before you send anything.</p>
    <p>Only the official $TICS token on Ethereum is accepted, contract <code>{TICS_CONTRACT}</code>. Anything else sent to the casino wallet, any other token or any other network, is not credited and cannot be returned.</p>
    <p>Withdrawals go only to the wallet that made a deposit. Any network fee for a withdrawal is shown before you confirm, and minimum amounts apply. You are responsible for your wallet, its keys and anything signed with it.</p>
    <p data-testid="terms-topup-final">A top up is credited after a few blocks, so you can play with it straight away. Ethereum takes about 15 minutes to confirm a transfer for good. Until your latest top up is confirmed, you cannot withdraw. This includes any winnings made in that time. If a top up is not confirmed, for example because the transfer is no longer on Ethereum, it is taken back from your balance, your account is paused and we will contact you.</p>
    <p>Payouts are automatic, but they can take time and can be held for safety checks, for example when a transfer looks unusual or the network is busy. Your balance stays in your account while that happens.</p>

    <h2>7. Errors and abuse</h2>
    <p>A malfunction voids all plays and pays. If a bug, a system error or a wrong figure leads to a result, credit or payout that should not have happened, we may cancel the affected rounds and correct balances, including recovering anything paid by mistake.</p>
    <p>Using bugs, automation, several accounts, or working with others to gain an unfair advantage, money laundering or any other abuse is not allowed. In that case we may hold or cancel balances and close accounts.</p>

    <h2>8. Pauses and changes to the service</h2>
    <p>The casino may pause play, top ups or payouts at any time, for example for maintenance or safety checks. We may also change the games, limits and fees, or close the service. If we close it, we will give players a fair chance to withdraw their real balance where we reasonably can.</p>

    <h2>9. Limits of our liability</h2>
    <p>As far as the law allows, we are not liable for any indirect or consequential loss, lost profit, lost opportunity or lost data. Our total liability to you for any claim is limited to the real $TICS balance shown in your account at the time of the claim.</p>
    <p>You agree to cover us against claims, losses and costs caused by your breach of these terms or of any law.</p>

    <h2>10. Taxes</h2>
    <p>You are responsible for any taxes on your play and winnings where you live.</p>

    <h2>11. Your data</h2>
    <p>We collect your wallet address, connection data (such as country, device and browser), your email if you give it, and the public holdings of your wallet on the blockchain.</p>
    <p>We use this data to run the game, keep it safe, and to send you updates and marketing. You can remove your email or untick updates in your profile at any time.</p>
    <p>We also use Google Analytics, which sets cookies, to see how people find and use the site, and we note which site or campaign link first brought you here.</p>

    <h2>12. Play responsibly</h2>
    <p>Set yourself a limit and take breaks. If playing stops being fun, stop. Never chase losses.</p>

    <h2>13. Changes to these terms</h2>
    <p>We may update these terms at any time. The date at the top shows the latest version, and playing after an update means you accept it.</p>

    <h2>14. Contact</h2>
    <p>Questions or problems? Message us on Telegram: <a href="https://t.me/Betics_casino" target="_blank" rel="noopener noreferrer">t.me/Betics_casino</a>.</p>
  </main>;
}
