import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
import type { ChainReader } from "./doctor.js";
import { coordinatorAbi, gameAbi, vaultAbi } from "./abis.js";

/// The real ChainReader over viem. Every read is a plain `readContract`; anything the
/// doctor can tolerate missing (an older deployment without a view) catches and returns
/// undefined instead of throwing.
export function viemChainReader(rpcUrl: string): ChainReader {
  const client: PublicClient = createPublicClient({ transport: http(rpcUrl, { retryCount: 2, timeout: 15_000 }) });
  const read = <T>(address: Address, abi: any, functionName: string, args: unknown[] = []) =>
    client.readContract({ address, abi, functionName, args } as any) as Promise<T>;

  return {
    chainId: () => client.getChainId(),
    getCode: (address) => client.getCode({ address }),
    getBalance: (address) => client.getBalance({ address }),
    gasPrice: () => client.getGasPrice(),
    game: {
      owner: (g) => read<Address>(g, gameAbi, "owner"),
      paused: (g) => read<boolean>(g, gameAbi, "paused"),
      drawPending: (g) => read<boolean>(g, gameAbi, "drawPending"),
      pendingRequestId: (g) => read<bigint>(g, gameAbi, "pendingRequestId").catch(() => undefined),
      houseVault: (g) => read<Address>(g, gameAbi, "houseVault"),
      subscriptionId: (g) => read<bigint>(g, gameAbi, "s_subscriptionId"),
      keyHash: (g) => read<Hex>(g, gameAbi, "s_keyHash"),
      nativePayment: (g) => read<boolean>(g, gameAbi, "s_nativePayment"),
      coordinator: (g) => read<Address>(g, gameAbi, "s_vrfCoordinator"),
    },
    vault: {
      authorized: (v, g) => read<boolean>(v, vaultAbi, "authorizedGames", [g]),
      allocationBps: (v, g) => read<number>(v, vaultAbi, "allocationBps", [g]).then(Number),
      totalAllocationBps: (v) => read<bigint>(v, vaultAbi, "totalAllocationBps").catch(() => 0n),
      bankroll: (v) => read<bigint>(v, vaultAbi, "bankroll"),
    },
    coordinator: {
      provingKeyHashes: async (c) => {
        // The coordinator exposes the registered hashes as an array getter; walk it until it
        // reverts. A handful of lanes at most.
        const out: Hex[] = [];
        for (let i = 0n; i < 16n; i++) {
          try {
            out.push(await read<Hex>(c, coordinatorAbi, "s_provingKeyHashes", [i]));
          } catch {
            break;
          }
        }
        return out;
      },
      subscription: async (c, subId) => {
        try {
          const [balance, nativeBalance, , owner, consumers] = await read<
            readonly [bigint, bigint, bigint, Address, readonly Address[]]
          >(c, coordinatorAbi, "getSubscription", [subId]);
          return { balance, nativeBalance, owner, consumers: [...consumers] };
        } catch {
          return undefined;
        }
      },
    },
  };
}
