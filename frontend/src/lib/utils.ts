import { formatUnits, parseUnits } from "viem";
import { USDC_DECIMALS } from "./contracts";

export function formatUSDC(amount: bigint): string {
  return formatUnits(amount, USDC_DECIMALS);
}

export function parseUSDC(amount: string): bigint {
  return parseUnits(amount, USDC_DECIMALS);
}

export function formatUSD(amount: bigint): string {
  const num = Number(formatUnits(amount, USDC_DECIMALS));
  // Always two decimals: a min of 0 rendered $49,969.80 as "$49,969.8", which reads as a
  // formatting bug on a money figure.
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
}

/** Short form for tight spaces — $49,986.54 does not fit a third of a phone width. */
export function formatUSDCompact(amount: bigint): string {
  const num = Number(formatUnits(amount, USDC_DECIMALS));
  if (Math.abs(num) >= 1000) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(num);
  }
  return formatUSD(amount);
}

export function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function progressPercent(current: bigint, target: bigint): number {
  if (target === 0n) return 0;
  return Math.min(100, Number((current * 100n) / target));
}

/// Nav highlight. Every game board lives under /play/, so "Play" stays lit on any of them.
export function isActive(pathname: string, href: string): boolean {
  if (href.startsWith("/play/")) return pathname.startsWith("/play/");
  return pathname === href;
}
