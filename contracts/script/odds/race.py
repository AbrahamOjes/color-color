#!/usr/bin/env python3
"""
Exact odds checker for VirtualRace (Plackett-Luce weighted finishing order).

Every probability is computed with fractions.Fraction. For N <= 8 runners the script
also enumerates every finishing order and asserts that the brute-force marginals equal
the closed forms; above 8 it uses the closed forms alone.

It also reproduces the contract's integer payouts exactly, including RaceOddsLib's
fixed-point PLACE/SHOW (each term rounded up at 1e36, summed, rounded up once to 1e18),
and checks that no payout exceeds stake * (1 - edge) / P.

Run:
    python3 contracts/script/odds/race.py                     # table for the example card
    python3 contracts/script/odds/race.py --weights 40,5,5,5,5,5 --edge 800
    python3 contracts/script/odds/race.py --emit-fixture      # rewrite RaceOddsFixture.sol

The fixture pins every payout for the example card; contracts/test/RaceOddsLib.t.sol
checks RaceOddsLib against it.
"""

import argparse
import itertools
import os
from fractions import Fraction

EXAMPLE_CARD = [30, 22, 16, 12, 11, 9]
MARKETS = ["WIN", "PLACE", "SHOW", "FORECAST", "REVERSE_FORECAST", "TRICAST", "ODD_EVEN", "HI_LO"]
ONE = 10**18
FINE = 10**36


def ceil_div(a, b):
    return -(-a // b)


# ── Exact closed forms ────────────────────────────────────────────────────────


def prefix(w, order):
    """Probability of an ordered prefix r1..rk."""
    W = sum(w)
    p = Fraction(1)
    for r in order:
        p *= Fraction(w[r], W)
        W -= w[r]
    return p


def p_win(w, i):
    return prefix(w, [i])


def p_place(w, i):
    n = len(w)
    return prefix(w, [i]) + sum(prefix(w, [j, i]) for j in range(n) if j != i)


def p_show(w, i):
    n = len(w)
    third = sum(prefix(w, [j, k, i]) for j in range(n) for k in range(n) if len({i, j, k}) == 3)
    return p_place(w, i) + third


def p_fc(w, a, b):
    return prefix(w, [a, b])


def p_rfc(w, a, b):
    return prefix(w, [a, b]) + prefix(w, [b, a])


def p_tc(w, a, b, c):
    return prefix(w, [a, b, c])


def p_odd_even(w, sel):
    return sum((p_win(w, i) for i in range(sel, len(w), 2)), Fraction(0))


def p_hi_lo(w, sel):
    n = len(w)
    return sum((p_win(w, i) for i in range(n) if (2 * (i + 1) > n) == (sel == 1)), Fraction(0))


# ── Contract arithmetic, reproduced exactly ───────────────────────────────────


def fine_place(w, i):
    W = sum(w)
    acc = ceil_div(FINE * w[i], W)
    for j in range(len(w)):
        if j != i:
            acc += ceil_div(FINE * w[j] * w[i], W * (W - w[j]))
    return acc


def place_1e18(w, i):
    return ceil_div(fine_place(w, i), FINE // ONE)


def show_1e18(w, i):
    W = sum(w)
    acc = fine_place(w, i)
    n = len(w)
    for j in range(n):
        if j == i:
            continue
        for k in range(n):
            if k in (i, j):
                continue
            acc += ceil_div(FINE * w[j] * w[k] * w[i], W * (W - w[j]) * (W - w[j] - w[k]))
    return ceil_div(acc, FINE // ONE)


def selections(n, market):
    """Every canonical selection of a market, as (encoded, runners)."""
    if market in (0, 1, 2):
        return [(i, (i,)) for i in range(n)]
    if market == 3:
        return [((a << 8) | b, (a, b)) for a in range(n) for b in range(n) if a != b]
    if market == 4:
        return [((a << 8) | b, (a, b)) for a in range(n) for b in range(a + 1, n)]
    if market == 5:
        return [((a << 16) | (b << 8) | c, (a, b, c)) for a, b, c in itertools.permutations(range(n), 3)]
    return [(0, (0,)), (1, (1,))]


def exact_p(w, market, runners):
    if market == 0:
        return p_win(w, *runners)
    if market == 1:
        return p_place(w, *runners)
    if market == 2:
        return p_show(w, *runners)
    if market == 3:
        return p_fc(w, *runners)
    if market == 4:
        return p_rfc(w, *runners)
    if market == 5:
        return p_tc(w, *runners)
    if market == 6:
        return p_odd_even(w, runners[0])
    return p_hi_lo(w, runners[0])


def contract_p(w, market, runners):
    """The (num, den) the contract prices with."""
    if market == 1:
        return place_1e18(w, runners[0]), ONE
    if market == 2:
        return show_1e18(w, runners[0]), ONE
    p = exact_p(w, market, runners)
    # The contract keeps its unreduced numerator and denominator; the payout is the same
    # floor either way because floor(stake*den*k / (num*1e4)) only depends on den/num.
    return p.numerator, p.denominator


def contract_payout(w, market, runners, stake, edge):
    num, den = contract_p(w, market, runners)
    return stake * den * (10_000 - edge) // (num * 10_000)


# ── Brute force ───────────────────────────────────────────────────────────────


def brute_force_check(w):
    n = len(w)
    win = [Fraction(0)] * n
    place = [Fraction(0)] * n
    show = [Fraction(0)] * n
    fc = {}
    tc = {}
    total = Fraction(0)
    for order in itertools.permutations(range(n)):
        p = prefix(w, order)
        total += p
        a, b, c = order[0], order[1], order[2]
        win[a] += p
        for r in (a, b):
            place[r] += p
        for r in (a, b, c):
            show[r] += p
        fc[(a, b)] = fc.get((a, b), Fraction(0)) + p
        tc[(a, b, c)] = tc.get((a, b, c), Fraction(0)) + p
    assert total == 1, "orderings do not sum to 1"
    for i in range(n):
        assert win[i] == p_win(w, i), f"WIN {i}"
        assert place[i] == p_place(w, i), f"PLACE {i}"
        assert show[i] == p_show(w, i), f"SHOW {i}"
    for (a, b), p in fc.items():
        assert p == p_fc(w, a, b), f"FC {a},{b}"
    for (a, b, c), p in tc.items():
        assert p == p_tc(w, a, b, c), f"TC {a},{b},{c}"


def check_invariants(w, edge, stake):
    n = len(w)
    assert sum(p_win(w, i) for i in range(n)) == 1
    assert sum(p_fc(w, a, b) for a in range(n) for b in range(n) if a != b) == 1
    assert sum(p_tc(w, *t) for t in itertools.permutations(range(n), 3)) == 1
    sp = sum(place_1e18(w, i) for i in range(n))
    ss = sum(show_1e18(w, i) for i in range(n))
    assert 2 * ONE <= sp <= 2 * ONE + n * n, sp
    assert 3 * ONE <= ss <= 3 * ONE + n * n, ss
    for i in range(n):
        assert place_1e18(w, i) <= show_1e18(w, i)
        assert Fraction(place_1e18(w, i), ONE) >= p_place(w, i)
        assert Fraction(show_1e18(w, i), ONE) >= p_show(w, i)
    for m in range(8):
        for _, runners in selections(n, m):
            pay = contract_payout(w, m, runners, stake, edge)
            fair = Fraction(stake) * Fraction(10_000 - edge, 10_000) / exact_p(w, m, runners)
            assert pay <= fair, (m, runners)


# ── Output ────────────────────────────────────────────────────────────────────


def x(p, edge):
    return float(Fraction(10_000 - edge, 10_000) / p)


def print_table(w, edge):
    n = len(w)
    W = sum(w)
    print(f"Card {w}  (W = {W}, N = {n}, edge {edge} bps)\n")
    print(f"{'Trap':>4} {'Weight':>6} {'P(win)':>8} {'WIN':>8} {'P(top2)':>8} {'PLACE':>8} {'P(top3)':>8} {'SHOW':>8}")
    for i in range(n):
        pw, pp, ps = p_win(w, i), p_place(w, i), p_show(w, i)
        print(
            f"{i + 1:>4} {w[i]:>6} {float(pw):>8.1%} {x(pw, edge):>7.2f}x {float(pp):>8.1%} "
            f"{x(pp, edge):>7.2f}x {float(ps):>8.1%} {x(ps, edge):>7.2f}x"
        )

    def trap(*rs):
        return "→".join(str(r + 1) for r in rs)

    fcs = sorted(((p_fc(w, a, b), (a, b)) for a in range(n) for b in range(n) if a != b), reverse=True)
    tcs = sorted(((p_tc(w, *t), t) for t in itertools.permutations(range(n), 3)), reverse=True)
    rfcs = sorted(((p_rfc(w, a, b), (a, b)) for a in range(n) for b in range(a + 1, n)), reverse=True)
    print()
    print(f"Forecast          {trap(*fcs[0][1])} {x(fcs[0][0], edge):.2f}x  …  {trap(*fcs[-1][1])} {x(fcs[-1][0], edge):.2f}x")
    print(f"Reverse forecast  {trap(*rfcs[0][1])} {x(rfcs[0][0], edge):.2f}x  …  {trap(*rfcs[-1][1])} {x(rfcs[-1][0], edge):.2f}x")
    print(f"Tricast           {trap(*tcs[0][1])} {x(tcs[0][0], edge):.2f}x  …  {trap(*tcs[-1][1])} {x(tcs[-1][0], edge):.2f}x")
    for name, m, labels in (("Odd/Even", 6, ("odd", "even")), ("Hi/Lo", 7, ("lo", "hi"))):
        parts = [f"{labels[s]} {float(exact_p(w, m, (s,))):.1%} {x(exact_p(w, m, (s,)), edge):.2f}x" for s in (0, 1)]
        print(f"{name:<17} " + "   ".join(parts))


def emit_fixture(w, edge, stake, path):
    n = len(w)
    rows = []
    for m in range(8):
        for sel, runners in selections(n, m):
            rows.append((m, sel, contract_payout(w, m, runners, stake, edge)))
    lines = [
        "// SPDX-License-Identifier: MIT",
        "pragma solidity ^0.8.24;",
        "",
        "// GENERATED by contracts/script/odds/race.py --emit-fixture. Do not edit by hand.",
        f"// Card {w}, stake {stake}, edge {edge} bps: the exact payout of every selection",
        "// of every market, computed with fractions.Fraction and the contract's rounding.",
        "library RaceOddsFixture {",
        f"    uint256 internal constant STAKE = {stake};",
        f"    uint256 internal constant EDGE_BPS = {edge};",
        f"    uint256 internal constant COUNT = {len(rows)};",
        "",
        "    struct Row {",
        "        uint8 market;",
        "        uint256 selection;",
        "        uint256 payout;",
        "    }",
        "",
        "    function card() internal pure returns (uint256[] memory w) {",
        f"        w = new uint256[]({n});",
    ]
    lines += [f"        w[{i}] = {v};" for i, v in enumerate(w)]
    lines += [
        "    }",
        "",
        "    function rows() internal pure returns (Row[] memory r) {",
        f"        r = new Row[]({len(rows)});",
    ]
    lines += [f"        r[{k}] = Row({m}, {sel}, {pay});" for k, (m, sel, pay) in enumerate(rows)]
    lines += ["    }", "}", ""]
    with open(path, "w") as f:
        f.write("\n".join(lines))
    print(f"\nWrote {len(rows)} rows to {path}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--weights", default=",".join(map(str, EXAMPLE_CARD)))
    ap.add_argument("--edge", type=int, default=800)
    ap.add_argument("--stake", type=int, default=1_000_000)
    ap.add_argument("--emit-fixture", action="store_true")
    args = ap.parse_args()

    w = [int(v) for v in args.weights.split(",")]
    assert 4 <= len(w) <= 12 and all(v >= 1 for v in w)

    if len(w) <= 8:
        brute_force_check(w)
        print(f"Brute force over {len(w)}! orderings matches the closed forms.")
    check_invariants(w, args.edge, args.stake)
    print("Partition, rounding and payout-bound invariants hold.\n")
    print_table(w, args.edge)

    if args.emit_fixture:
        here = os.path.dirname(os.path.abspath(__file__))
        emit_fixture(w, args.edge, args.stake, os.path.join(here, "..", "..", "test", "fixtures", "RaceOddsFixture.sol"))


if __name__ == "__main__":
    main()
