import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygonAmoy, polygon, foundry } from "viem/chains";

import ColorColorAbi from "./abi/ColorColor.json" with { type: "json" };
import AgentMandateAbi from "./abi/AgentMandate.json" with { type: "json" };
import HouseVaultAbi from "./abi/HouseVault.json" with { type: "json" };

export const ABI = {
  game: ColorColorAbi,
  mandate: AgentMandateAbi,
  vault: HouseVaultAbi,
} as const;

/** Bet type ids — must match `BetType` in contracts/src/OddsLib.sol. */
export const BET_TYPE = {
  PICK1: 0,
  PICK2: 1,
  PICK3: 2,
  COLOR: 3,
  HILO: 4,
  RAINBOW: 5,
} as const;

export type BetTypeName = keyof typeof BET_TYPE;

export const BET_TYPE_NAME: Record<number, BetTypeName> = Object.fromEntries(
  Object.entries(BET_TYPE).map(([k, v]) => [v, k as BetTypeName]),
) as Record<number, BetTypeName>;

export const COLOUR_NAMES = ["Red", "Yellow", "Green", "Blue", "Draw"] as const;
export const HILO_NAMES = ["Lo", "Mid", "Hi"] as const;

/** Colour ranges, matching OddsLib. Blue holds 13 numbers; the others hold 12. */
export function colourOf(n: number): "Red" | "Yellow" | "Green" | "Blue" {
  if (n <= 12) return "Red";
  if (n <= 24) return "Yellow";
  if (n <= 36) return "Green";
  return "Blue";
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

function resolveChain(chainId: number) {
  if (chainId === polygonAmoy.id) return polygonAmoy;
  if (chainId === polygon.id) return polygon;
  if (chainId === foundry.id) return foundry;
  throw new Error(`Unsupported CHAIN_ID ${chainId}`);
}

export interface Config {
  game: Address;
  mandate: Address;
  vault: Address;
  mandateId: bigint;
  agentAddress: Address;
}

export interface Clients {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: ReturnType<typeof privateKeyToAccount>;
  config: Config;
}

export function makeClients(): Clients {
  const rpcUrl = requiredEnv("RPC_URL");
  const chain = resolveChain(Number(process.env.CHAIN_ID ?? polygonAmoy.id));
  const account = privateKeyToAccount(requiredEnv("AGENT_PRIVATE_KEY") as Hex);

  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

  return {
    publicClient,
    walletClient,
    account,
    config: {
      game: requiredEnv("COLORCOLOR_ADDRESS") as Address,
      mandate: requiredEnv("AGENT_MANDATE_ADDRESS") as Address,
      vault: (process.env.HOUSE_VAULT_ADDRESS ?? "0x0000000000000000000000000000000000000000") as Address,
      mandateId: BigInt(requiredEnv("MANDATE_ID")),
      agentAddress: account.address,
    },
  };
}

/**
 * Encode a selection into the canonical bytes32 the contract expects.
 *
 * PICK2/PICK3 numbers are sorted ascending to match `OddsLib.canonicalize`. The contract
 * does this itself, but sorting here keeps what we quote identical to what it stores.
 */
export function encodeSelection(betType: BetTypeName, selection: number[]): Hex {
  let value = 0n;

  switch (betType) {
    case "PICK1":
      value = BigInt(selection[0]);
      break;
    case "PICK2": {
      const [a, b] = [...selection].sort((x, y) => x - y);
      value = (BigInt(a) << 8n) | BigInt(b);
      break;
    }
    case "PICK3": {
      const [a, b, c] = [...selection].sort((x, y) => x - y);
      value = (BigInt(a) << 16n) | (BigInt(b) << 8n) | BigInt(c);
      break;
    }
    case "COLOR":
    case "HILO":
      value = BigInt(selection[0]);
      break;
    case "RAINBOW":
      value =
        BigInt(selection[0]) * 1000n +
        BigInt(selection[1]) * 100n +
        BigInt(selection[2]) * 10n +
        BigInt(selection[3]);
      break;
  }

  return `0x${value.toString(16).padStart(64, "0")}` as Hex;
}

export function decodeSelection(betType: number, selection: Hex): number[] {
  const v = BigInt(selection);
  switch (betType) {
    case BET_TYPE.PICK1:
      return [Number(v)];
    case BET_TYPE.PICK2:
      return [Number(v >> 8n), Number(v & 0xffn)];
    case BET_TYPE.PICK3:
      return [Number(v >> 16n), Number((v >> 8n) & 0xffn), Number(v & 0xffn)];
    case BET_TYPE.RAINBOW:
      return [
        Number(v / 1000n),
        Number((v % 1000n) / 100n),
        Number((v % 100n) / 10n),
        Number(v % 10n),
      ];
    default:
      return [Number(v)];
  }
}

/** Human-readable description of a selection, for reporting bets back to an agent. */
export function describeSelection(betType: number, selection: Hex): string {
  const values = decodeSelection(betType, selection);
  switch (betType) {
    case BET_TYPE.COLOR:
      return COLOUR_NAMES[values[0]] ?? "unknown";
    case BET_TYPE.HILO:
      return HILO_NAMES[values[0]] ?? "unknown";
    case BET_TYPE.RAINBOW:
      return `R${values[0]} Y${values[1]} G${values[2]} B${values[3]}`;
    default:
      return values.join(", ");
  }
}

export const USDC_DECIMALS = 6;

export function toUsdc(amount: number): bigint {
  return BigInt(Math.round(amount * 10 ** USDC_DECIMALS));
}

export function fromUsdc(amount: bigint): number {
  return Number(amount) / 10 ** USDC_DECIMALS;
}

export function usd(amount: bigint): string {
  return `$${fromUsdc(amount).toFixed(2)}`;
}
