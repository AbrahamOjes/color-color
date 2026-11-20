import type { Address, Hex } from "viem";
import { LOCAL_CHAIN_ID, type Env, type GameEntry } from "../runtime/config.js";

/// A self-check in the shape of a finding: what is wrong and what to do about it. A blocking
/// finding stops a service from starting; a warning is printed and the service runs.

export type Severity = "blocking" | "warning" | "info";

export interface Finding {
  severity: Severity;
  check: string;
  issue: string;
  fix: string;
}

/// Everything the doctor needs from the chain, as an interface so the checks are unit-tested
/// against stubs and the real client is wired in once, in `cli.ts`.
export interface ChainReader {
  chainId(): Promise<number>;
  getCode(address: Address): Promise<Hex | undefined>;
  getBalance(address: Address): Promise<bigint>;
  gasPrice(): Promise<bigint>;
  game: {
    owner(game: Address): Promise<Address>;
    paused(game: Address): Promise<boolean>;
    drawPending(game: Address): Promise<boolean>;
    /// Resolves to undefined on a game deployed before the stale-fulfilment guard existed.
    pendingRequestId(game: Address): Promise<bigint | undefined>;
    houseVault(game: Address): Promise<Address>;
    subscriptionId(game: Address): Promise<bigint>;
    keyHash(game: Address): Promise<Hex>;
    nativePayment(game: Address): Promise<boolean>;
    coordinator(game: Address): Promise<Address>;
  };
  vault: {
    authorized(vault: Address, game: Address): Promise<boolean>;
    allocationBps(vault: Address, game: Address): Promise<number>;
    totalAllocationBps(vault: Address): Promise<bigint>;
    bankroll(vault: Address): Promise<bigint>;
  };
  coordinator: {
    provingKeyHashes(coordinator: Address): Promise<Hex[]>;
    subscription(
      coordinator: Address,
      subId: bigint,
    ): Promise<{ balance: bigint; nativeBalance: bigint; owner: Address; consumers: Address[] } | undefined>;
  };
}

export interface DoctorInput {
  env: Env & { games: GameEntry[] };
  chain: ChainReader;
  /// Optional repo-level checks (ABI copies). Supplied by the CLI when run inside the repo.
  abiCopiesMatch?: () => Promise<{ ok: boolean; detail: string }>;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const fmtWei = (wei: bigint) => `${(Number(wei) / 1e18).toFixed(3)}`;

export async function runDoctor(input: DoctorInput): Promise<Finding[]> {
  const { env, chain } = input;
  const out: Finding[] = [];
  const add = (severity: Severity, check: string, issue: string, fix: string) =>
    out.push({ severity, check, issue, fix });

  // ── chain ────────────────────────────────────────────────────────────────────────────
  let chainId: number;
  try {
    chainId = await chain.chainId();
  } catch (e) {
    add("blocking", "rpc", `RPC unreachable: ${(e as Error).message}`, "Check RPC_URL and network access.");
    return out;
  }
  if (chainId !== env.CHAIN_ID) {
    add(
      "blocking",
      "chain",
      `RPC reports chain ${chainId} but CHAIN_ID is ${env.CHAIN_ID}`,
      "Point RPC_URL at the chain the addresses were deployed to. Reads against the wrong chain return empty values, not errors.",
    );
    return out;
  }
  const local = chainId === LOCAL_CHAIN_ID;

  // ── addresses have code ──────────────────────────────────────────────────────────────
  const named: Array<[string, Address | undefined]> = [
    ["HOUSE_VAULT_ADDRESS", env.HOUSE_VAULT_ADDRESS],
    ["VRF_COORDINATOR", env.VRF_COORDINATOR],
    ["AGENT_MANDATE_ADDRESS", env.AGENT_MANDATE_ADDRESS],
  ];
  for (const g of env.games) named.push([`GAMES[${g.id}]`, g.address]);
  if (env.games.length === 0) {
    add("blocking", "games", "GAMES is empty", "Set GAMES to a JSON array or id:address list of game contracts.");
  }
  for (const [name, addr] of named) {
    if (!addr) continue;
    const code = await chain.getCode(addr);
    if (!code || code === "0x") {
      add(
        "blocking",
        "code",
        `${name} (${addr}) has no code on chain ${chainId}`,
        "Verify the address with `cast code`. Several addresses in this repo's history were right at the prefix and wrong at the tail.",
      );
    }
  }
  if (out.some((f) => f.severity === "blocking")) return out;

  // ── per game ─────────────────────────────────────────────────────────────────────────
  let totalAlloc = 0;
  for (const g of env.games) {
    const game = g.address;
    const tag = `game ${g.id}`;

    const [owner, paused, pending, guard, vaultAddr, subId, keyHash, native, coord] = await Promise.all([
      chain.game.owner(game),
      chain.game.paused(game),
      chain.game.drawPending(game),
      chain.game.pendingRequestId(game),
      chain.game.houseVault(game),
      chain.game.subscriptionId(game),
      chain.game.keyHash(game),
      chain.game.nativePayment(game),
      chain.game.coordinator(game),
    ]);

    add("info", tag, `paused=${paused} drawPending=${pending} owner=${owner}`, "");

    if (guard === undefined) {
      add(
        "warning",
        tag,
        "deployed without the stale-fulfilment guard (no pendingRequestId view)",
        "Never cancel a pending draw automatically on this deployment: a late callback would settle the draw twice. Redeploy from the current engine before enabling KEEPER_AUTO_CANCEL.",
      );
    }

    if (env.KEEPER_ADDRESS && same(env.KEEPER_ADDRESS, owner)) {
      add(
        "warning",
        tag,
        "the keeper signs with the owner key",
        "Give the keeper its own keystore (contracts/KEYS.md). performUpkeep is permissionless; the owner key should only be needed for cancelPendingDraw.",
      );
    }

    // vault wiring
    if (env.HOUSE_VAULT_ADDRESS && !same(vaultAddr, env.HOUSE_VAULT_ADDRESS)) {
      add(
        "blocking",
        tag,
        `game points at vault ${vaultAddr}, config says ${env.HOUSE_VAULT_ADDRESS}`,
        "Fix HOUSE_VAULT_ADDRESS or the game's setHouseVault; monitoring the wrong vault hides shortfalls.",
      );
    }
    const vault = env.HOUSE_VAULT_ADDRESS ?? vaultAddr;
    const [authorized, alloc] = await Promise.all([
      chain.vault.authorized(vault, game),
      chain.vault.allocationBps(vault, game),
    ]);
    if (!authorized) {
      add("blocking", tag, "not authorised on the vault", "vault.setAuthorizedGame(game, true); every settlement would fail and emit HouseSettlementFailed.");
    }
    if (alloc === 0) {
      add("blocking", tag, "vault allocation is 0 bps", "vault.setAllocation(game, bps); with no allocation every bet is rejected by the exposure cap.");
    }
    totalAlloc += alloc;

    // VRF
    if (env.VRF_COORDINATOR && !same(coord, env.VRF_COORDINATOR)) {
      add("blocking", tag, `game uses coordinator ${coord}, config says ${env.VRF_COORDINATOR}`, "Fix VRF_COORDINATOR; the subscription checks below would read the wrong coordinator.");
    }
    const hashes = await chain.coordinator.provingKeyHashes(coord);
    if (!local && !hashes.some((h) => same(h, keyHash))) {
      add(
        "blocking",
        tag,
        `key hash ${keyHash} is not registered on the coordinator`,
        "A request with an unregistered key hash is accepted and served by nobody; the draw sticks forever. Compare against `s_provingKeyHashes` and call updateVRFConfig.",
      );
    }
    const sub = await chain.coordinator.subscription(coord, subId);
    if (!sub) {
      add("blocking", tag, `VRF subscription ${subId} does not exist on ${coord}`, "Create and fund a subscription, add the game as a consumer, then updateVRFConfig.");
    } else {
      if (!sub.consumers.some((c) => same(c, game))) {
        add("blocking", tag, "game is not a consumer of its VRF subscription", "coordinator.addConsumer(subId, game).");
      }
      const funded = native ? sub.nativeBalance : sub.balance;
      const runway = env.VRF_COST_PER_DRAW_WEI > 0n ? Number(funded / env.VRF_COST_PER_DRAW_WEI) : 0;
      const unit = native ? "native" : "LINK";
      if (runway < env.VRF_MIN_RUNWAY_DRAWS) {
        add(
          runway < 5 ? "blocking" : "warning",
          tag,
          `VRF ${unit} balance ${fmtWei(funded)} covers about ${runway} draws (minimum ${env.VRF_MIN_RUNWAY_DRAWS})`,
          native
            ? "Fund with fundSubscriptionWithNative. An empty subscription does not fail cleanly: the request goes out, the callback is never paid for, and the draw sits pending forever."
            : "Fund the subscription with LINK.",
        );
      } else {
        add("info", tag, `VRF ${unit} runway about ${runway} draws`, "");
      }
    }
  }

  if (totalAlloc > 10_000) {
    add("blocking", "vault", `allocations sum to ${totalAlloc} bps (> 10000)`, "The vault should have refused this; check you are reading the right vault.");
  }

  // ── keeper gas ───────────────────────────────────────────────────────────────────────
  if (env.KEEPER_ADDRESS) {
    const [bal, price] = await Promise.all([chain.getBalance(env.KEEPER_ADDRESS), chain.gasPrice()]);
    const perTx = price * env.KEEPER_GAS_PER_TX;
    const runway = perTx > 0n ? Number(bal / perTx) : 0;
    if (runway < env.KEEPER_MIN_RUNWAY_TXS) {
      add(
        runway < 10 ? "blocking" : "warning",
        "keeper",
        `keeper balance ${fmtWei(bal)} covers about ${runway} transactions at the current gas price (minimum ${env.KEEPER_MIN_RUNWAY_TXS})`,
        "Top up the keeper account. It needs gas and nothing else; never send it USDC.",
      );
    } else {
      add("info", "keeper", `gas runway about ${runway} transactions`, "");
    }
  }

  // ── repo ─────────────────────────────────────────────────────────────────────────────
  if (input.abiCopiesMatch) {
    const r = await input.abiCopiesMatch();
    if (!r.ok) add("warning", "abi", r.detail, "Run scripts/check-abi-copies.sh --write and commit.");
  }

  return out;
}

export function hasBlocking(findings: Finding[]): boolean {
  return findings.some((f) => f.severity === "blocking");
}

export function formatFindings(findings: Finding[]): string {
  const order: Severity[] = ["blocking", "warning", "info"];
  const lines: string[] = [];
  for (const sev of order) {
    for (const f of findings.filter((x) => x.severity === sev)) {
      lines.push(`${sev.toUpperCase().padEnd(8)} ${f.check}: ${f.issue}${f.fix ? `\n         fix: ${f.fix}` : ""}`);
    }
  }
  return lines.join("\n");
}
