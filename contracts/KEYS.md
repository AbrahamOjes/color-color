# Key handling

**No private key belongs in a file in this repo, ever.** Not in `.env`, not in a script, not
in a comment.

Foundry can generate and hold keys in an encrypted keystore, so the private key never exists
in plaintext at any point. That removes the export-and-paste step entirely, which is the most
common way a hot key leaks.

---

## One-time setup

### 1. Create the deployer key

```bash
cast wallet new ~/.foundry/keystores deployer
```

This **generates a fresh keypair in-process and writes it encrypted**. You are prompted for a
password; nothing is ever printed, copied, or written in the clear. Do not use
`--unsafe-password` — it puts the password into your shell history, which defeats the point.

Note the address it prints, then confirm it any time with:

```bash
cast wallet address --account deployer
cast wallet list
```

**Do not import a key exported from MetaMask.** That export is the risky step. Generate here
and fund the new address instead.

### 2. Fund it

Send POL (gas) and USDC (the vault bankroll) to the address from step 1.

### 3. Strip keys from `.env`

`contracts/.env` should contain RPC URLs and configuration only — no `PRIVATE_KEY`, no
mnemonic. See `.env.example`.

---

## Using it

Every command takes `--account` instead of `--private-key`, and prompts once for the password.

```bash
export DEPLOYER=$(cast wallet address --account deployer)

forge script script/DeployColorColor.s.sol:DeployColorColor \
  --rpc-url $AMOY_RPC_URL --account deployer --sender $DEPLOYER \
  --broadcast --slow -vvvv

cast send $COLORCOLOR "setDrawInterval(uint256)" 180 \
  --rpc-url $AMOY_RPC_URL --account deployer
```

### Hardware wallet (preferred for anything holding real value)

No keystore, no password, key cannot leave the device:

```bash
forge script script/DeployColorColor.s.sol:DeployColorColor \
  --rpc-url $POLYGON_RPC_URL --ledger --sender 0xYourLedgerAddress \
  --broadcast --slow
```

`cast send` takes `--ledger` too. For mainnet this is the bar, not the keystore.

---

## The keeper needs its own key

`script/keeper.sh` signs continuously and cannot sit at a password prompt, so it gets a
**separate hot wallet** — never the deployer or owner key:

```bash
cast wallet new ~/.foundry/keystores keeper
printf '%s' 'the-keeper-password' > ~/.foundry/keeper.pass
chmod 600 ~/.foundry/keeper.pass
```

Then run the keeper with `KEEPER_ACCOUNT=keeper KEEPER_PASSWORD_FILE=~/.foundry/keeper.pass`.

This split matters. `performUpkeep` is **permissionless**, so the keeper needs nothing but gas
— fund it with a few POL and no more. If that wallet is ever drained the game keeps working
and you top it up; if the deployer key were used instead, losing it would mean losing
ownership of the game and the vault.

The one exception is `cancelPendingDraw`, which is `onlyOwner`. Either run that by hand from
the deployer when a draw wedges, or move ownership to a multisig and execute it there.

---

## Why

A plaintext key in `.env` is readable by every process that can read your files, and exporting
a key from a browser wallet means displaying it, copying it and pasting it somewhere, where any
process or extension with clipboard access can see it. A key generated straight into an
encrypted keystore is never copied, never displayed and never written unencrypted, so that
whole class of leak disappears.
