import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { hasBlocking, runDoctor, type ChainReader, type Finding } from "../src/doctor/doctor.js";
import { loadEnv, parseGames } from "../src/runtime/config.js";

const GAME = "0x1000000000000000000000000000000000000001" as Address;
const VAULT = "0x2000000000000000000000000000000000000002" as Address;
const COORD = "0x3000000000000000000000000000000000000003" as Address;
const OWNER = "0x4000000000000000000000000000000000000004" as Address;
const KEEPER = "0x5000000000000000000000000000000000000005" as Address;
const KEY = ("0x" + "ab".repeat(32)) as Hex;

function env(over: Record<string, string> = {}) {
  return loadEnv({
    RPC_URL: "http://127.0.0.1:8545",
    CHAIN_ID: "137",
    GAMES: `[{"id":"colorcolor","address":"${GAME}"}]`,
    HOUSE_VAULT_ADDRESS: VAULT,
    VRF_COORDINATOR: COORD,
    KEEPER_ADDRESS: KEEPER,
    ...over,
  });
}

/// A healthy chain; tests break one thing at a time.
function healthy(over: Partial<{ [K in keyof ChainReader]: Partial<ChainReader[K]> }> & Record<string, any> = {}): ChainReader {
  const base: ChainReader = {
    chainId: async () => 137,
    getCode: async () => "0x6001" as Hex,
    getBalance: async () => 10n * 10n ** 18n,
    gasPrice: async () => 100n * 10n ** 9n,
    game: {
      owner: async () => OWNER,
      paused: async () => true,
      drawPending: async () => false,
      pendingRequestId: async () => 0n,
      houseVault: async () => VAULT,
      subscriptionId: async () => 42n,
      keyHash: async () => KEY,
      nativePayment: async () => true,
      coordinator: async () => COORD,
    },
    vault: {
      authorized: async () => true,
      allocationBps: async () => 6000,
      totalAllocationBps: async () => 6000n,
      bankroll: async () => 20n * 10n ** 6n,
    },
    coordinator: {
      provingKeyHashes: async () => [KEY],
      subscription: async () => ({ balance: 0n, nativeBalance: 100n * 10n ** 18n, owner: OWNER, consumers: [GAME] }),
    },
  };
  return {
    ...base,
    ...over,
    game: { ...base.game, ...(over.game ?? {}) },
    vault: { ...base.vault, ...(over.vault ?? {}) },
    coordinator: { ...base.coordinator, ...(over.coordinator ?? {}) },
  } as ChainReader;
}

const issues = (f: Finding[], sev?: string) => f.filter((x) => !sev || x.severity === sev).map((x) => x.issue);

describe("config", () => {
  it("parses both GAMES shapes", () => {
    expect(parseGames(`colorcolor:${GAME},dogs:${VAULT}:race`)).toEqual([
      { id: "colorcolor", address: GAME, kind: "colorcolor" },
      { id: "dogs", address: VAULT, kind: "race" },
    ]);
    expect(parseGames(`[{"id":"x","address":"${GAME}","kind":"race"}]`)[0]?.kind).toBe("race");
    expect(parseGames("")).toEqual([]);
  });
  it("refuses a malformed address", () => {
    expect(() => parseGames("x:0x123")).toThrow();
  });
});

describe("doctor", () => {
  it("passes a healthy deployment", async () => {
    const f = await runDoctor({ env: env(), chain: healthy() });
    expect(hasBlocking(f)).toBe(false);
    expect(issues(f, "warning")).toEqual([]);
  });

  it("blocks on a chain id mismatch and stops there", async () => {
    const f = await runDoctor({ env: env(), chain: healthy({ chainId: async () => 80002 }) });
    expect(issues(f, "blocking")[0]).toMatch(/chain 80002/);
    expect(f).toHaveLength(1);
  });

  it("blocks on an address with no code", async () => {
    const f = await runDoctor({ env: env(), chain: healthy({ getCode: async (a: Address) => (a === GAME ? "0x" : "0x60") }) });
    expect(issues(f, "blocking")[0]).toMatch(/GAMES\[colorcolor\].*no code/);
  });

  it("blocks when the key hash is not registered", async () => {
    const f = await runDoctor({ env: env(), chain: healthy({ coordinator: { provingKeyHashes: async () => [] } }) });
    expect(issues(f, "blocking").join("\n")).toMatch(/key hash .* not registered/);
  });

  it("accepts any key hash on a local chain", async () => {
    const f = await runDoctor({
      env: env({ CHAIN_ID: "31337" }),
      chain: healthy({ chainId: async () => 31337, coordinator: { provingKeyHashes: async () => [] } }),
    });
    expect(hasBlocking(f)).toBe(false);
  });

  it("blocks when the game is not a consumer", async () => {
    const f = await runDoctor({
      env: env(),
      chain: healthy({ coordinator: { subscription: async () => ({ balance: 0n, nativeBalance: 10n ** 20n, owner: OWNER, consumers: [] }) } }),
    });
    expect(issues(f, "blocking")[0]).toMatch(/not a consumer/);
  });

  it("measures VRF runway in draws and escalates when nearly empty", async () => {
    const low = await runDoctor({
      env: env(),
      chain: healthy({ coordinator: { subscription: async () => ({ balance: 0n, nativeBalance: 10n ** 18n, owner: OWNER, consumers: [GAME] }) } }),
    });
    expect(issues(low, "blocking")[0]).toMatch(/covers about 3 draws/);
    const mid = await runDoctor({
      env: env(),
      chain: healthy({ coordinator: { subscription: async () => ({ balance: 0n, nativeBalance: 5n * 10n ** 18n, owner: OWNER, consumers: [GAME] }) } }),
    });
    expect(issues(mid, "warning")[0]).toMatch(/covers about 19 draws/);
  });

  it("warns when the keeper is the owner", async () => {
    const f = await runDoctor({ env: env({ KEEPER_ADDRESS: OWNER }), chain: healthy() });
    expect(issues(f, "warning")[0]).toMatch(/keeper signs with the owner key/);
  });

  it("warns on a deployment without the stale-fulfilment guard", async () => {
    const f = await runDoctor({ env: env(), chain: healthy({ game: { pendingRequestId: async () => undefined } }) });
    expect(issues(f, "warning")[0]).toMatch(/stale-fulfilment guard/);
  });

  it("blocks on zero allocation and missing authorisation", async () => {
    const f = await runDoctor({ env: env(), chain: healthy({ vault: { authorized: async () => false, allocationBps: async () => 0 } }) });
    expect(issues(f, "blocking")).toEqual(expect.arrayContaining([expect.stringMatching(/not authorised/), expect.stringMatching(/allocation is 0/)]));
  });

  it("warns on low keeper gas and blocks when it is nearly gone", async () => {
    const low = await runDoctor({ env: env(), chain: healthy({ getBalance: async () => 10n ** 18n }) });
    expect(issues(low, "warning")[0]).toMatch(/keeper balance .* covers about 33 transactions/);
    const empty = await runDoctor({ env: env(), chain: healthy({ getBalance: async () => 10n ** 17n }) });
    expect(issues(empty, "blocking")[0]).toMatch(/covers about 3 transactions/);
  });

  it("reports ABI drift as a warning", async () => {
    const f = await runDoctor({ env: env(), chain: healthy(), abiCopiesMatch: async () => ({ ok: false, detail: "ABI drift: x" }) });
    expect(issues(f, "warning")[0]).toBe("ABI drift: x");
  });
});
