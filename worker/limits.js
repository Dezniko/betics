import { maxPayoutCents } from '../backend/src/games/roulette.js';
import { formatTics as usd } from './tics.js';

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
