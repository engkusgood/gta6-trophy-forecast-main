# gta6-trophy-forecast-main

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/engkusgood/gta6-trophy-forecast-main/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/engkusgood/gta6-trophy-forecast-main/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Damped recent-trend trophy forecaster (24h): forecasts each GTA VI trophy's Exophase earn rate at 2026-11-26T00:00:00Z. Per trophy, a least-squares line of logit(rate) against ln(1 + hours) over the last 24 hours of reads, extrapolated with 0.70 damping, with an honest spread (random walk + fit residual + refresh allowance + player-dilution guard). Deterministic, standard library only, no network. Practice proxy loss 0.9901 vs house persistence 1.5084.

## Run it

```sh
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=h7m7mvrn&utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards</sub>
