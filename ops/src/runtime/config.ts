import { z } from "zod";
import { isAddress, type Address } from "viem";

/// Environment shared by every ops service. Validated once at startup so a typo fails
/// loudly instead of surfacing as a zero address or a silent empty read hours later.

const address = z.string().refine(isAddress, "not a 20-byte hex address").transform((s) => s as Address);

export const GameEntry = z.object({
  id: z.string().min(1),
  address,
  /// Which game contract this is. Decides which ABI the services read it with.
  kind: z.enum(["colorcolor", "race"]).default("colorcolor"),
});
export type GameEntry = z.infer<typeof GameEntry>;

/// Same shapes as the frontend's NEXT_PUBLIC_GAMES: a JSON array or `id:0xaddr,id:0xaddr`.
export function parseGames(raw: string | undefined): GameEntry[] {
  if (!raw || raw.trim() === "") return [];
  const text = raw.trim();
  if (text.startsWith("[")) return z.array(GameEntry).parse(JSON.parse(text));
  return text.split(",").map((part) => {
    const [id, addr, kind] = part.split(":").map((s) => s.trim());
    return GameEntry.parse({ id, address: addr, kind: kind ?? "colorcolor" });
  });
}

export const LOCAL_CHAIN_ID = 31337;

export const Env = z.object({
  RPC_URL: z.string().url(),
  CHAIN_ID: z.coerce.number().int().positive(),
  GAMES: z.string().optional(),
  HOUSE_VAULT_ADDRESS: address.optional(),
  VRF_COORDINATOR: address.optional(),
  AGENT_MANDATE_ADDRESS: address.optional(),
  /// Address that will sign keeper transactions. Checked for gas runway and ownership.
  KEEPER_ADDRESS: address.optional(),
  /// Alerting thresholds. Runway is expressed in draws so it means the same on every chain.
  VRF_MIN_RUNWAY_DRAWS: z.coerce.number().positive().default(50),
  VRF_COST_PER_DRAW_WEI: z.coerce.bigint().positive().default(260_000_000_000_000_000n), // 0.26 POL
  KEEPER_MIN_RUNWAY_TXS: z.coerce.number().positive().default(100),
  KEEPER_GAS_PER_TX: z.coerce.bigint().positive().default(300_000n),
});
export type Env = z.infer<typeof Env>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env & { games: GameEntry[] } {
  const env = Env.parse(source);
  return { ...env, games: parseGames(env.GAMES) };
}
