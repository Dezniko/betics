import { maxPayoutCents } from '../backend/src/games/roulette.js';
import { formatTics as usd } from './tics.js';
import { maxPayoutUnits, validStake } from '../backend/src/games/slots.js';
import { SLOT_MATH } from '../backend/src/games/slotsMath.js';

// Checks a round against the game's live admin config before any money moves.
// Returns null when the round may go ahead, else { status, error, code }.
export function checkRoundLimits(bets, config) {
  if (!config.enabled) return { status: 503, code: 'game_off', error: config.maintenanceMessage };
  const stake = bets.reduce((sum, bet) => sum + bet.amountCents, 0);
  if (stake < config.minStakeCents) return { status: 400, code: 'min_stake', error: `The total bet must be at least ${usd(config.minStakeCents)}.` };
  if (stake > config.maxStakeCents) return { status: 400, code: 'max_stake', error: `The total bet can be at most ${usd(config.maxStakeCents)}.` };
  const worst = maxPayoutCents(bets, config.math);
  if (worst > config.maxWinCents) return { status: 400, code: 'max_win', error: `These bets could win more than ${usd(config.maxWinCents)}, the most one spin can pay. Lower the bet.` };
  if (worst - stake > config.maxHouseLossCents) return { status: 400, code: 'max_loss', error: 'These bets are over the table limit. Lower the bet.' };
  return null;
}

// Same checks for a slot round: the stake must be one of the published bet levels and the round's
// highest possible payout (the cap) must fit the game's max win. Returns null when the round may go ahead.
export function checkSlotLimits(stake, config, math = SLOT_MATH) {
  if (!config.enabled) return { status: 503, code: 'game_off', error: config.maintenanceMessage };
  if (!validStake(stake, math)) return { status: 400, code: 'bad_stake', error: 'Please pick one of the bet amounts shown.' };
  if (stake < config.minStakeCents) return { status: 400, code: 'min_stake', error: `The bet must be at least ${usd(config.minStakeCents)}.` };
  if (stake > config.maxStakeCents) return { status: 400, code: 'max_stake', error: `The bet can be at most ${usd(config.maxStakeCents)}.` };
  if (maxPayoutUnits(stake, math) > config.maxWinCents) return { status: 400, code: 'max_win', error: `This bet could win more than ${usd(config.maxWinCents)}, the most one round can pay. Lower the bet.` };
  return null;
}
// Plain words for the slot table limit: the biggest bet level the free float allows right now.
export function slotLimitMessage(maxWin, math = SLOT_MATH) {
  const allowed = math.betLevels.filter((b) => maxPayoutUnits(b, math) <= maxWin);
  if (!allowed.length) return 'The casino wallet cannot cover a round at the smallest bet right now. Please try again later.';
  return `The most you can bet on one spin right now is ${usd(allowed[allowed.length - 1])}.`;
}
