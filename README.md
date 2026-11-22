# swift-site-forge

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/sadiomonro-boop/swift-site-forge/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/sadiomonro-boop/swift-site-forge/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast, dependency-free reimplementation of makefun-site 1.0.0 that builds the same static sites byte for byte, in a fraction of the CPU time. Templates are compiled once into node trees, Markdown is rendered in a single line pass with one inline scanner, slugs are cached, and strings are built with array joins — no per-line regex passes over bodies.

## Run it

```sh
node main.ts
```

The driver reads every case from `/input/cases.json` (or `MAKEFUN_INPUT_DIR`), answers each one with `run()` from `solve.js`, and writes `/output/answers.json` (or `MAKEFUN_OUTPUT_DIR`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=kpeyh02w&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
