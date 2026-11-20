# Security

The contracts in this repository are **unaudited**. Do not deploy them with funds you are not
prepared to lose.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](../../security/advisories/new) for this repository, not in a
public issue. Include the affected contract or file, a description of the issue, and a proof of
concept (a failing Foundry test is ideal).

The surfaces where a bug costs the most:

- `OddsLib` / `RaceOddsLib` pricing: a wrong constant is silent, unbounded loss.
- `HouseVault` share accounting and collateral locking.
- The exposure bound in `PredictionGameBase`.
- `fulfillRandomWords`: it must never revert, and must settle only the pending request, once.
- `GaslessEntry` and `AgentMandate` authorisation.
