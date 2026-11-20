# ops

Operations services for the platform. See `docs/ops.md`.

```bash
npm install
npm test
RPC_URL=http://127.0.0.1:8545 CHAIN_ID=31337 GAMES='colorcolor:0x...' npm run doctor
```

- `src/runtime/config.ts`: validated environment shared by every service.
- `src/doctor/`: deployment self-check. `doctor.ts` is pure and tested against a stub chain;
  `chain.ts` is the viem reader; `cli.ts` is `npm run doctor`.
