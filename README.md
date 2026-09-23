# seer-liquidity

Scripts that operate [Seer](https://seer.pm) prediction markets on **Optimism** (chain 10, sUSDS
collateral) and **Gnosis** (chain 100, sDAI collateral).

A campaign runs through some or all of these phases:

| Phase | What it does |
|---|---|
| **create** | deploy the markets and ask their Reality.eth questions |
| **seed** | split collateral into outcome tokens and mint a Uniswap V3 (or Swapr/Algebra) pool per outcome |
| **withdraw** | burn liquidity back out of the pools, collecting fees |
| **merge** | recombine complete outcome sets into collateral |
| **answer / resolve** | submit Reality.eth answers, then resolve once the timeout passes |
| **redeem** | convert resolved outcome tokens back to collateral |
| **check / verify** | read-only reconciliation against live chain state |

Past campaigns: originality (Deep Funding rounds 2–3), Zcash Q3 CDRGP, Zcash NU7 coinholder polls,
L1 / Deep Funding GG24, Octant epoch 12, and the Gnosis probability-of-default market.

## Running something

Scripts are ESM and take no arguments — run them as bare `node <script>.js` **from the repo root**.

```bash
cp .env.example .env    # then fill in PRIVATE_KEY and RPC_URL
npm install
npm test                # audits: nothing armed to send, no broken paths
node campaigns/originality-r3/check-originality-r3-pools.js --markets-only   # a safe read-only example
```

> **Every mutating script gates transactions on a hand-edited `const DRY_RUN` near the top of the
> file — not a CLI flag.** A script committed at `false` sends real transactions the moment you run
> it, with no prompt. Always `npm run audit:dryrun` first.

## Layout

| Path | |
|---|---|
| `*.js` (root) | one script per campaign phase. **Frozen** — records of real on-chain runs |
| `*-execution.json` | append-only **resume logs**, not records of holdings |
| `docs/guides/` | per-campaign runbooks: structure, prices, hazards, what it cost |
| `archive/runs/` | stdout transcripts of past runs, by campaign |
| `lifecycle/<slug>.json` | structured per-campaign manifest |
| `abis/` | shared contract ABIs |
| `tools/` | repo audits (`npm test`) |
| `src/` | read-only copy of the Seer Solidity contracts, for reference. Never compiled |

## Start here

**`CLAUDE.md`** — the repo invariants (why the scripts are frozen, why a resume log is not a record,
the `DRY_RUN` hazard, the file-move rule) and pointers to the campaign guides and history.
