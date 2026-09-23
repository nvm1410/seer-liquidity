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

All nine are mutation-tested: corrupting each one makes `npm run lint:manifest` exit 1.

## Adding a campaign

```bash
cp lifecycle/originality-r3.json lifecycle/<new-slug>.json   # nearest precedent
# edit: setSlug, mode, family, status=draft, source, markets, liquidity, files, spendingCap
npm run lint:manifest
```

Set `status: "gated"` only once a human has approved, and fill `gate` when you do.
