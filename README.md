# qu-BETICS

Online roulette played with the official **$TICS** token on Ethereum. Live at **https://www.betics.io**.

This repository holds the game: the website, the game server and the payout signer. The admin panel lives in
[Dezniko/betics-admin](https://github.com/Dezniko/betics-admin).

The code is public so anyone can read and check it. It is **not open source**: see [LICENSE](LICENSE)
(view only). Found a problem? See [SECURITY.md](SECURITY.md).

## How it works, in short

- **Custodial.** qu-BETICS is a custodial casino, like most crypto casinos. When a player tops up, their $TICS
  goes to the casino wallet and their balance is kept by the casino until they withdraw. Withdrawals are paid
  automatically, only to the wallet that deposited.
- **Every win is covered.** Every player balance counts as owed. A bet is only accepted if its biggest possible
  payout fits in what is left in the casino wallet, so the maximum bet adjusts automatically
  (`worker/limits.js`, `worker/tics.js`).
- **Provably fair spins.** Before each bet the server commits to a secret seed and shows its SHA-256 hash. The
  player's browser then adds 32 fresh random bytes, so the server cannot know or choose the result in advance.
  After the spin the seed is revealed and the browser recomputes the pocket, the payout and the ending balance
  itself (`frontend/src/fairnessClient.js`). If anything does not match, betting stops.
- **Offline check.** The fairness sheet can download the round data; `node verify-roulette.mjs round-proof.json`
  (`frontend/public/verify-roulette.mjs`, no packages, no network) checks the number, every payout and the
  ending balance.
- **Beta.** The game is still being improved. Please read the Terms on the site before playing.

## What is in here

| Folder | What it is |
|---|---|
| `frontend/` | React and Vite website: table, wheel, wallet connection, fairness checks |
| `worker/` | Cloudflare Worker: game API, one wallet per player (SQLite Durable Object), deposit watcher, limits |
| `payouts/` | Separate Worker that signs withdrawals. It has no public address; the casino key is stored encrypted |
| `migrations/` | Database schema (Cloudflare D1) |
| `backend/src/` | Shared roulette rules and fairness maths, also used by the Worker |
| `scripts/` | Local test chain, casino key setup and `verify-live.mjs` |

No passwords, keys or secrets are stored in this repository. In production they are Cloudflare Worker secrets.
The IDs in `wrangler.toml` (account, database) are not secret and give no access on their own.

## Check that the live site runs this code

The code that runs in your browser can be checked against this repository:

```sh
git clone https://github.com/Dezniko/betics.git && cd betics
npm --prefix frontend ci
npm run build
node scripts/verify-live.mjs
```

`verify-live.mjs` downloads every JavaScript and CSS file of your build from www.betics.io and compares their
SHA-256 fingerprints. `MATCH` means the site serves exactly this code, including the fairness checks and the
random value your browser adds to each spin. The latest `main` is what is live.

The server side (the Workers on Cloudflare) cannot be proven this way, and we do not claim otherwise. That is
why the important checks (fairness, payouts, ending balance) also run in your browser.

## Run it locally

Needs Node 22 or newer and [Wrangler](https://developers.cloudflare.com/workers/wrangler/).

```sh
npm ci && npm --prefix frontend ci
npm test                         # unit and integration tests
cp .dev.vars.example .dev.vars   # then fill in your own random values
wrangler d1 migrations apply betics-db --local
npm run build && wrangler dev --port 8789
```

Then open http://127.0.0.1:8789. Everything runs on your machine with play money; nothing touches the live site.
`node scripts/fake-chain.mjs 8545` starts a fake Ethereum node for testing deposits and payouts locally.

## Dealer voices and sound effects

The dealer voices (`frontend/public/voice/`) and sound effects (`frontend/public/sfx/`) are included so the
game builds exactly as it runs on betics.io. They are for qu-BETICS only. If you fork or copy this code,
do not use them: remove both folders and use your own audio.

## Licence

View only. You may read, build and test this code to review it or to verify the live site. You may not copy,
reuse or run it as a service without written permission. Full terms in [LICENSE](LICENSE).
