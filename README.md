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

Scripts are ESM. Run them **from the repo root** by their full path — several read CWD-relative
files, so the working directory is load-bearing.

```bash
cp .env.example .env    # then fill in PRIVATE_KEY and RPC_URL
npm install
npm test                # audits: nothing can send unasked, no broken paths, golden tests
node campaigns/originality-r3/check-originality-r3-pools.js --markets-only   # a safe read-only example
```

> **Every script is dry by default and `--live` is the only way to send.** It prints the entire
> plan — every market resolved, every amount sized — exits 0 and sends nothing. There is no
> `DRY_RUN` constant anywhere in the repo; `npm run audit:dryrun` fails the build if a script could
> ever send without that flag.

```bash
node campaigns/zcash-q3/add-zcash-liquidity.js          # dry: prints the plan
node campaigns/zcash-q3/add-zcash-liquidity.js --live   # sends, after a confirmation
```

Other flags: `--resume` (required when a progress log already has entries — it is a resume log, and
every item in it will be SKIPPED), `--progress=<path>` (write somewhere new, which is what a re-seed
needs), `--yes` (skip the confirmation, for an unattended resume).

## Layout

| Path | |
|---|---|
| `lib/` | the harness and shared modules — **build a new campaign on this** |
| `lifecycle/<slug>.json` | the structured manifest — **declare a new campaign here** |
| `tools/` | repo audits (`npm test`) |
| `campaigns/<slug>/` | every past campaign, self-contained: its scripts **and** its data |
| `campaigns/<slug>/superseded/` | generations that were replaced, kept with their own campaign |
| `docs/guides/` | per-campaign runbooks: structure, prices, hazards, what it cost |
| `docs/README.md` | the campaign index |
| `archive/` | stdout transcripts by campaign, dead files, orphan tools |
| `abis/` | shared contract ABIs |
| `src/` | read-only copy of the Seer Solidity contracts, for reference. Never compiled |

The root holds configuration and these two markdown files, nothing else. A `*-execution.json` in a
campaign directory is an append-only **resume log, not a record of holdings**.

## Start here

**`CLAUDE.md`** — the repo invariants (how a change is proved not to alter behaviour, why a resume
log is not a record, which three scripts are gated rather than migrated, the file-move rule) and
pointers to the campaign guides and history.
