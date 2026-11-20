import { pad, toHex, type Hex } from "viem";

/// Market ids — must match RaceOddsLib (contracts/src/RaceOddsLib.sol).
export const MARKET = {
  WIN: 0,
  PLACE: 1,
  SHOW: 2,
  FORECAST: 3,
  REVERSE_FORECAST: 4,
  TRICAST: 5,
  ODD_EVEN: 6,
  HI_LO: 7,
} as const;

export type Market = (typeof MARKET)[keyof typeof MARKET];

export const MARKET_LABEL: Record<number, string> = {
  0: "Win",
  1: "Place",
  2: "Show",
  3: "Forecast",
  4: "Reverse Forecast",
  5: "Tricast",
  6: "Odd/Even",
  7: "Hi/Lo",
};

/// Runners a complete selection needs, per market. ODD/EVEN and HI/LO take one choice (0 or 1).
export const PICKS: Record<number, number> = { 0: 1, 1: 1, 2: 1, 3: 2, 4: 2, 5: 3, 6: 1, 7: 1 };

/// Encode a selection into the `bytes32` the contract expects (design.md, Appendix B).
/// Runner indexes are 0-based, as on-chain. REVERSE FORECAST is sorted ascending; the
/// contract canonicalises it too, but sorting here keeps the displayed bet identical.
export function encodeRaceSelection(market: number, picks: readonly number[]): Hex {
  let value: bigint;
  if (market === MARKET.FORECAST) {
    value = (BigInt(picks[0]) << 8n) | BigInt(picks[1]);
  } else if (market === MARKET.REVERSE_FORECAST) {
    const [a, b] = [...picks].sort((x, y) => x - y);
    value = (BigInt(a) << 8n) | BigInt(b);
  } else if (market === MARKET.TRICAST) {
    value = (BigInt(picks[0]) << 16n) | (BigInt(picks[1]) << 8n) | BigInt(picks[2]);
  } else {
    value = BigInt(picks[0]);
  }
  return pad(toHex(value), { size: 32 });
}

export function decodeRaceSelection(market: number, selection: Hex): number[] {
  const v = BigInt(selection);
  if (market === MARKET.FORECAST || market === MARKET.REVERSE_FORECAST) {
    return [Number(v >> 8n), Number(v & 0xffn)];
  }
  if (market === MARKET.TRICAST) {
    return [Number(v >> 16n), Number((v >> 8n) & 0xffn), Number(v & 0xffn)];
  }
  return [Number(v)];
}

/// ODD/EVEN and HI/LO, as the contract scores them: selection 0 is an odd-numbered winner
/// (1-based), and "lo" is a winner numbered at most N/2.
export function oddEvenLabel(choice: number): string {
  return choice === 0 ? "Odd" : "Even";
}

export function hiLoLabel(choice: number, runners: number): string {
  const half = Math.floor(runners / 2);
  return choice === 0 ? `Lo (1–${half})` : `Hi (${half + 1}–${runners})`;
}

/// Whether `picks` is a complete, valid selection for `market` on an N-runner card.
export function isCompleteSelection(market: number, picks: readonly number[], runners: number): boolean {
  if (picks.length !== PICKS[market]) return false;
  if (market === MARKET.ODD_EVEN || market === MARKET.HI_LO) return picks[0] === 0 || picks[0] === 1;
  if (picks.some((p) => p < 0 || p >= runners)) return false;
  return new Set(picks).size === picks.length;
}
