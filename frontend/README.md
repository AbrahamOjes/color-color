# Frontend

Next.js app for the games: boards, bet slips, results, statistics, the house vault, referrals
and the 3D race replay.

## Run

```bash
cp .env.local.example .env.local   # then fill in the chain and contract addresses
npm ci
npm run dev
```

Open <http://localhost:3000>. With `NEXT_PUBLIC_CHAIN=local` against Anvil, the connect modal
offers a **Local Test Wallet**, so no browser extension is needed. See the root README and
[`../docs/architecture.md`](../docs/architecture.md) for deploying contracts locally.

## Configuration

All settings are in `.env.local.example`. The ones that matter most:

- `NEXT_PUBLIC_CHAIN`: `local`, `amoy` or `polygon`. It must match where the contract addresses
  live, or every read silently returns nothing.
- `NEXT_PUBLIC_GAMES`: the games shown in the lobby, as `id:address` pairs or a JSON array.
  Known ids are listed in `src/games/registry.ts`.
- `NEXT_PUBLIC_HOUSE_VAULT_ADDRESS`, `NEXT_PUBLIC_REFERRAL_MANAGER_ADDRESS`,
  `NEXT_PUBLIC_USDC_ADDRESS`.

## Layout

| Path | Contents |
|---|---|
| `src/app/` | Routes: `/`, `/play/[gameId]`, `/bets`, `/results`, `/stats`, `/vault`, `/referrals` |
| `src/games/` | Game registry, per-game boards, hooks and encoders, race skins, 3D replay |
| `src/lib/` | Contract addresses and ABIs, colours, the signals engine |
| `scripts/race3d/` | Procedural generator for the 3D race assets in `public/race3d/` |

Payouts shown before betting come from the contract's `quote()`, never from a multiplier
recomputed in JS.

## Checks

```bash
npm run lint
npm test
npm run build
```
