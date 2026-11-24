# Launch-Odds Radar v17-mellow

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/agungvg/launch-odds-radar-v17-mellow/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/agungvg/launch-odds-radar-v17-mellow/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Pre-token protocols, valued from their own record. Implied value = TVL × fitted
multiple (the value if a token launches) × token odds (from how long peers ran
before recording one). Every coefficient is fitted on the DefiLlama snapshot
2026-11-14 and tested held-out twice: leave-one-out and walk-forward.

## Model (all numbers computed by `main.ts` from the snapshot, nothing hand-typed)

- **Value:** log10(mcap/TVL) on the 95 dated protocols whose tokens trade.
  Ridge on log10 TVL + shrunk category effects (λ=4). LOO ×4.31, walk-forward
  66/29 ×5.27, 47/48 ×4.97; flat-median baseline ×5.31 / ×7.31. Worst 5-fold
  (seed 42) ×5.21. Multiple at $100M TVL ×0.17, size slope −0.56 ± 0.12.
- **Odds:** logistic on the 645 dated peers (327 record a token): age + full
  category + log10 TVL + 7-day growth + log chain count. Brier 0.200–0.201
  ten-fold / 0.210 walk-forward, AUC 0.756–0.758 / 0.704. Chains is kept:
  it improves Brier and AUC on both held-out tests, on both ten-fold seeds.
  CAT+chains+size×growth is tested, not kept — on seed 11 its ten-fold
  Brier (0.202) and AUC (0.753) are worse than CAT+chains.
- **Ranges:** Jackknife+ half-width plus the sd of 200 bootstrap-refit
  predictions (seed 777). Measured walk-forward coverage 58.6% / 79.3%
  for the stated 50% / 80% bands; the method over-covers leave-one-out on
  the 50% band (66.7%) — stated as measured, never as nominal.
- **λ sweep (on the real ranked set):** λ=2 wins walk-forward (×5.17) and
  Farm (16) but has the worst LOO (×4.44); λ=16 wins LOO (×4.24) but Farm
  collapses to 6; λ=4 is the defensible compromise (LOO ×4.31, WF66 ×5.27,
  Farm 13) and stays primary. The sweep table is on the dashboard.
- **Farm (strict rule):** net beats the T-bill on the same deposit AND
  $25/hour, 12 weeks, 7% drop share, deposit 0.02% of TVL, fees $2.95,
  3.4 h of work. Farm 13 / Marginal 183 / Skip 2. The rule is never
  loosened to add Farm rows.
- **No odds floor:** floors 0.5% / 1% / 2% change Brier and AUC on
  neither test at 3 decimals. Sub-$1K implied values print as <$1K.
- **Board:** 198 rows = watchlist 40 + early 158 (the two lowest-implied
  non-Farm rows of the 200-row ranked set are dropped, never a Farm row).
  Ledger 758/758. Every row carries a costed 10-step farm plan, a
  drop-share × deposit grid, a T-bill benchmark and its 8 nearest priced
  peers.

## Run

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
```

Writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and
`dossier.json` into the output directory. Node 22, standard library only.
