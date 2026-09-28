# Campaign manifests

One file per campaign: `lifecycle/<set-slug>.json`, validated against `schema.json` by
`npm run lint:manifest`.

## Why this exists

Before this, a campaign's facts lived in three incompatible places: `const` literals at the top of
four to seven forked scripts, prose in a 20–27 KB guide, and a run log. The same Market View address
was re-typed in 27 files. Nothing could check any of it, and nothing could tell you what a campaign
*was* without reading its scripts.

`lifecycle/originality-r3.json` was the first attempt, and it was **write-only** — it stated
`"feeTier": 100` while `add-originality-r3-liquidity.js:83` separately declared
`const FEE_TIER = 100`. Two copies, no link, free to drift.

v2 fixes that by splitting the document in half.

## The contract half — READ before acting

Scripts read these instead of declaring constants. If one is wrong, the run is wrong, so the
validator checks them hard.

| Field | Replaces |
|---|---|
| `chain.id`, `chain.name` | 31 copies of `const CHAIN_ID` |
| `chain.collateral.{symbol,address,decimals}` | 24 `SUSDS_ADDRESS` + 5 `SDAI_ADDRESS` literals |
| `addresses.*` | `MARKET_VIEW` (27 copies), `MARKET_FACTORY` (27), `SUSDS` (24), `POSITION_MANAGER` (22), `ROUTER` (12) |
| `amm.{kind,feeTier,tickSpacing,mathFeeTier}` | `FEE_TIER`, `TICK_SPACING`, `MATH_FEE_TIER` |
| `liquidity.{totalCollateral,band,sizing}` | `TOTAL_BUDGET`, `MIN_PRICE`/`MAX_PRICE`, the sizing mode |
| `markets[]` | the creation plan **and** the verifier's expectations |
| `files.*` | `SEED_FILE`, `MARKETS_FILE`, `QUESTIONS_FILE` |
| `spendingCap.{collateral,gasEth}` | *new* — a hard ceiling the run harness enforces |
| `gate.*` | *new* — `--live` is refused without an approval |

## The ledger half — APPENDED after the fact

Evidence. Never read to make a decision, so a stale value here can mislead a reader but cannot
misdirect a transaction.

`stages[]` · `evidenceLog[]` · `results.*` · `walletAtIntake` / `walletAfter` · `ui.*` ·
`grillAnswers` · `immutableText`

> `results` holds the **market addresses this campaign produced**. `addresses` holds the **chain's
> contract addresses it ran against**. v1 used `addresses` for the former; the migration renamed it,
> because a script reading `addresses.marketFactory` and getting a market back is exactly the kind
> of silent wrong this file is meant to end.

### The one field that is both

`gate.summaryHash` is written when approval is given and **re-read before `--live`** to prove the
seed file has not changed since. It is the only place the two halves touch.

## Modes

`mode` plus `family` is what lets one schema cover every campaign:

- **`launch`** — create markets, then seed pools.
- **`reseed`** — put liquidity back into an existing, drained set. A drained Uniswap V3 pool keeps
  its last `sqrtPriceX96` and `createAndInitializePoolIfNecessary` is a no-op on it, so a reseed
  must price from the **live** pool, not the seed file.
- **`unwind`** — withdraw liquidity, merge complete outcome sets, redeem. Requires the `unwind`
  block, whose `order` and `orderNote` carry the ordering constraint (on L1, merging the parent
  before the child would have cost ~17.7k).
- **`settle`** — answer Reality, resolve, redeem. Requires the `settle` block, whose `unit` field
  guards the trap that Octant answered in `[percent]` while L1 answered as a fraction of 1.

## What the validator actually checks

Structure comes from `schema.json` (`additionalProperties: false` at the top level, so a typo'd key
is an error rather than a silent no-op). The semantic checks are the valuable part:

1. every address checksums and is non-zero — compared **normalized**, since `MARKET_VIEW` is
   lowercase in all 27 script copies while the rest are checksummed
2. `chain.id` and `chain.name` agree
3. `spendingCap.collateral >= liquidity.totalCollateral`
4. the band is a band (`minPrice < maxPrice`)
5. **every seed price lies strictly inside the band** — the exact precondition
   `buildPoolAndBounds` throws on, checked before anyone spends gas finding out
6. declared input files exist
7. a stage claiming `"done"` names artifacts, and those artifacts exist on disk
8. `algebra-v1` carries a `mathFeeTier`; `uniswap-v3` must not
9. **cross-manifest**: every manifest on the same chain must agree on each contract address. This
   catches a Gnosis address pasted into an Optimism manifest without anyone maintaining a second
   copy of the truth

10. every `schedule` entry names a withdraw/remove script in this campaign's directory, on
    `lib/run.js`, in an unwind stage — and a pending one carries `approvedAt` and `planHash`

The first nine are mutation-tested: corrupting each one makes `npm run lint:manifest` exit 1. The
tenth is exercised by `tests/schedule.test.js`.

## Scheduled runs

A withdrawal can be approved now and fired unattended later. **Withdraw/unwind only** — Reality
answers post a bond on a judgment, and resolve/redeem stay with a human too.

```bash
node tools/schedule.js add zcash-q3 campaigns/zcash-q3/withdraw-zcash-liquidity.js --at=2026-10-15T09:00:00Z [--window=48h] [--args="--resume"]
node tools/schedule.js list
node tools/schedule.js cancel <id>
node tools/schedule.js tick --dry-fire   # every check, then stops before sending
node tools/schedule.js install           # Windows task: every 15 min, wakes from sleep
```

A scheduled live run passes `--yes`, skipping the harness's y/N prompt. Two things stand in for it:

- **`add` is the approval.** It runs the script dry, prints the whole plan, and on `y` records the
  plan's *shape* hash (`lib/transcript.js` `planShape`: amounts and wei-sized integers masked;
  position ids, addresses, counts and order kept) plus the transcript itself.
- **`tick` re-runs the dry run at fire time** and refuses unless the shape still matches. Fees and
  amounts may move with price; which positions, in which pools, may not. Note the zcash withdraw
  scripts print the wallet's *total* NFT count, so minting for any other campaign in between makes
  the entry refuse — safe, and the notification says why.

Every other harness guard still runs on the live invocation. Past `notAfter` an entry is refused, not
fired late. A `failed` run is never retried — partial on-chain state needs a human, and the
notification gives the `--resume` command. Transcripts land in `runs/<slug>/scheduled/`, the tick log
in `runs/scheduler.log`. Notifications go to ntfy.sh when `NTFY_TOPIC` is set in `.env`; one
heartbeat is sent when an entry comes within 24h, so silence after its time means the machine was off.

The Windows task wakes the PC from **sleep, not shutdown**; wake timers must be enabled in Power
Options. Moving to an always-on box is `install` there (it prints the cron line) — but the key, and
the LP positions it owns, then live on that box: use a dedicated campaign wallet.

## Adding a campaign

```bash
cp lifecycle/originality-r3.json lifecycle/<new-slug>.json   # nearest precedent
# edit: setSlug, mode, family, status=draft, source, markets, liquidity, files, spendingCap
npm run lint:manifest
```

Set `status: "gated"` only once a human has approved, and fill `gate` when you do.
