// The notice a player sees once (per browser) when pressing Connect wallet, before the wallet picker.
// Copy approved by Dez on 2026-10-31. Player copy rules: no emoji, no dashes.
export const CONNECT_NOTICE_KEY = 'betics:connect-notice:v1';

export const CONNECT_NOTICE = Object.freeze({
  title: 'Before you connect',
  sections: Object.freeze([
    { heading: 'Your balance is held by the casino.',
      text: 'qu-BETICS is a custodial casino, like most crypto casinos. When you top up, your $TICS goes to the casino wallet, and your balance is kept there until you withdraw. Withdrawals are paid to the wallet you connect.' },
    { heading: 'Every win is covered.',
      text: 'The maximum bet adjusts automatically to the funds in the casino wallet, so the table only accepts bets it can pay out.' },
    { heading: 'Every spin is provably fair.',
      text: 'The result is locked before you bet, and your browser adds its own random number, so you can check every spin yourself.' },
    { heading: 'qu-BETICS is in beta.',
      text: 'We are still improving the game. Please only play with what you are comfortable with.' },
  ]),
  agree: 'I have read and agree to the Terms',
});

export function needsConnectNotice(storage = globalThis.localStorage) {
  try { return storage?.getItem(CONNECT_NOTICE_KEY) !== '1'; } catch { return true; }
}

export function acceptConnectNotice(storage = globalThis.localStorage) {
  try { storage?.setItem(CONNECT_NOTICE_KEY, '1'); } catch { /* private mode: shown again next time */ }
}
