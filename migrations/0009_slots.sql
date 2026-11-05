-- Gods of Power slot: game row and its published maths option.
INSERT OR IGNORE INTO games (id, name, kind, math_id, min_stake_cents, max_stake_cents, max_win_cents, max_house_loss_cents, sort)
VALUES ('slots', 'Gods of Power', 'slot', 'gods92', 2000, 1000000, 2000000000, 2000000000, 2);
INSERT OR IGNORE INTO game_math VALUES
  ('slots', 'gods92', 'Gods of Power 92', 'Five reels, three rows, 20 lines, wild, scatter and free spins with doubled wins. One round pays at most 2,000 times the bet. Payback 92%.', 92.00, 92.00, 92.00);
