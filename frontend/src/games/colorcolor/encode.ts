import { pad, toHex } from "viem";

/// Bet type ids — must match the `BetType` enum in contracts/src/OddsLib.sol.
export const BET_TYPE = {
  PICK1: 0,
  PICK2: 1,
  PICK3: 2,
  COLOR: 3,
  HILO: 4,
  RAINBOW: 5,
} as const;

export type BetType = keyof typeof BET_TYPE;

export const BET_TYPE_LABEL: Record<number, string> = {
  0: "Pick 1",
  1: "Pick 2",
  2: "Pick 3",
  3: "Colour",
  4: "Hi/Lo",
  5: "Rainbow",
};

/// Encode a selection into the canonical `bytes32` the contract expects.
/// PICK2/PICK3 are sorted ascending to match `OddsLib.canonicalize` — the contract does this
/// too, but sorting here keeps the value we display identical to the one it stores.
export function encodeSelection(betType: BetType, selection: number[]): `0x${string}` {
  let value = 0n;

  if (betType === "PICK1") {
    value = BigInt(selection[0]);
  } else if (betType === "PICK2") {
    const [a, b] = [...selection].sort((x, y) => x - y);
    value = (BigInt(a) << 8n) | BigInt(b);
  } else if (betType === "PICK3") {
    const [a, b, c] = [...selection].sort((x, y) => x - y);
    value = (BigInt(a) << 16n) | (BigInt(b) << 8n) | BigInt(c);
  } else if (betType === "COLOR" || betType === "HILO") {
    value = BigInt(selection[0]);
  } else if (betType === "RAINBOW") {
    // R*1000 + Y*100 + G*10 + B, must sum to 6 — matches OddsLib.encodeRainbow.
    value =
      BigInt(selection[0]) * 1000n +
      BigInt(selection[1]) * 100n +
      BigInt(selection[2]) * 10n +
      BigInt(selection[3]);
  }

  return pad(toHex(value), { size: 32 });
}

/// Decode a stored selection back into numbers, for rendering a placed bet.
export function decodeSelection(betType: number, selection: `0x${string}`): number[] {
  const v = BigInt(selection);
  if (betType === BET_TYPE.PICK1) return [Number(v)];
  if (betType === BET_TYPE.PICK2) return [Number(v >> 8n), Number(v & 0xffn)];
  if (betType === BET_TYPE.PICK3) {
    return [Number(v >> 16n), Number((v >> 8n) & 0xffn), Number(v & 0xffn)];
  }
  if (betType === BET_TYPE.RAINBOW) {
    return [
      Number(v / 1000n),
      Number((v % 1000n) / 100n),
      Number((v % 100n) / 10n),
      Number(v % 10n),
    ];
  }
  return [Number(v)];
}
