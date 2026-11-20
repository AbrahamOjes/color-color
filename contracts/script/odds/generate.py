#!/usr/bin/env python3
"""
Generate the exact odds table for ColorColor and emit Solidity-ready constants.

Every outcome in this game is an exact rational whose denominator is C(49,6).
So we never store a probability -- we store `winCount`, the number of favourable
6-ball combinations. That makes all payout math exact integer arithmetic with
zero rounding drift:

    payout = stake * TOTAL_COMBINATIONS * (10_000 - edgeBps) / (winCount * 10_000)

Run:  python3 contracts/script/odds/generate.py
The values printed here are pinned by contracts/test/OddsLib.t.sol -- if you
change the colour ranges or HILO bands, re-run this and update both.
"""

from math import comb

TOTAL = comb(49, 6)  # 13_983_816

# Colour group sizes, matching ColorColor.sol:
#   Red 1-12, Yellow 13-24, Green 25-36, Blue 37-49
GROUPS = [12, 12, 12, 13]
COLOUR_NAMES = ["Red", "Yellow", "Green", "Blue"]

# HILO bands, matching ColorColor.sol: Lo <= 120, Mid 121-159, Hi >= 160
HILO_LO_MAX = 120
HILO_HI_MIN = 160


def compositions():
    """All 84 (r,y,g,b) colour distributions summing to 6."""
    out = []
    for r in range(7):
        for y in range(7 - r):
            for g in range(7 - r - y):
                b = 6 - r - y - g
                out.append((r, y, g, b))
    return out


def rainbow_count(c):
    """Favourable combinations for an exact colour distribution."""
    n = 1
    for size, k in zip(GROUPS, c):
        n *= comb(size, k)
    return n


def pick_counts():
    """PICK1/2/3: choose k specific numbers, the other 6-k from the remaining."""
    return {k: comb(49 - k, 6 - k) for k in (1, 2, 3)}


def colour_counts():
    """Dominant colour = strict max. Any tie -> index 4 ('Draw')."""
    counts = [0] * 5
    for c in compositions():
        n = rainbow_count(c)
        m = max(c)
        if c.count(m) == 1:
            counts[c.index(m)] += n
        else:
            counts[4] += n
    return counts


def hilo_counts():
    """Exact distribution of the sum of 6 distinct numbers from 1..49, via DP."""
    dp = [[0] * 280 for _ in range(7)]
    dp[0][0] = 1
    for v in range(1, 50):
        for k in range(5, -1, -1):
            for s in range(279 - v, -1, -1):
                if dp[k][s]:
                    dp[k + 1][s + v] += dp[k][s]
    sums = dp[6]
    assert sum(sums) == TOTAL
    lo = sum(sums[s] for s in range(0, HILO_LO_MAX + 1))
    mid = sum(sums[s] for s in range(HILO_LO_MAX + 1, HILO_HI_MIN))
    hi = sum(sums[s] for s in range(HILO_HI_MIN, 280))
    return [lo, mid, hi]


def main():
    print(f"TOTAL_COMBINATIONS = C(49,6) = {TOTAL:,}\n")

    picks = pick_counts()
    print("PICK (winCount, fair multiplier):")
    for k in (1, 2, 3):
        n = picks[k]
        print(f"  PICK{k}: {n:>10,}   {TOTAL / n:>12,.4f}x")

    cc = colour_counts()
    print("\nCOLOR (winCount, fair multiplier):")
    for name, n in zip(COLOUR_NAMES + ["Draw(tie)"], cc):
        print(f"  {name:<10} {n:>10,}   {TOTAL / n:>12,.4f}x")
    assert sum(cc) == TOTAL, f"COLOR partition {sum(cc)} != {TOTAL}"
    print(f"  sum = {sum(cc):,}  OK")

    hl = hilo_counts()
    print("\nHILO (winCount, fair multiplier):")
    for name, n in zip([f"Lo <={HILO_LO_MAX}", f"Mid {HILO_LO_MAX+1}-{HILO_HI_MIN-1}", f"Hi >={HILO_HI_MIN}"], hl):
        print(f"  {name:<14} {n:>10,}   {TOTAL / n:>12,.4f}x")
    assert sum(hl) == TOTAL, f"HILO partition {sum(hl)} != {TOTAL}"
    print(f"  sum = {sum(hl):,}  OK")

    comps = compositions()
    total_rainbow = sum(rainbow_count(c) for c in comps)
    assert total_rainbow == TOTAL, f"RAINBOW partition {total_rainbow} != {TOTAL}"
    ranked = sorted(comps, key=rainbow_count)
    print(f"\nRAINBOW: {len(comps)} compositions, sum = {total_rainbow:,}  OK")
    print(f"  rarest    {ranked[0]}  count {rainbow_count(ranked[0]):>8,}   {TOTAL / rainbow_count(ranked[0]):>12,.2f}x")
    print(f"  commonest {ranked[-1]}  count {rainbow_count(ranked[-1]):>8,}   {TOTAL / rainbow_count(ranked[-1]):>12,.2f}x")

    print("\n" + "=" * 60)
    print("Solidity constants for OddsLib.sol:\n")
    print(f"    uint256 internal constant TOTAL_COMBINATIONS = {TOTAL};")
    print(f"    uint256 internal constant PICK1_WINCOUNT = {picks[1]};")
    print(f"    uint256 internal constant PICK2_WINCOUNT = {picks[2]};")
    print(f"    uint256 internal constant PICK3_WINCOUNT = {picks[3]};")
    print("    // [Red, Yellow, Green, Blue, Draw]")
    print(f"    //   COLOUR_WINCOUNT = [{', '.join(str(n) for n in cc)}]")
    print("    // [Lo, Mid, Hi]")
    print(f"    //   HILO_WINCOUNT = [{', '.join(str(n) for n in hl)}]")
    print("\n    // Binomial tables for RAINBOW: C(12,k) and C(13,k), k = 0..6")
    print(f"    //   C(12,k) = [{', '.join(str(comb(12, k)) for k in range(7))}]")
    print(f"    //   C(13,k) = [{', '.join(str(comb(13, k)) for k in range(7))}]")


if __name__ == "__main__":
    main()
