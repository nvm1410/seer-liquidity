# Guide: Remove & Merge All Originality Liquidity

> **Status: HISTORICAL.** round-2 originality was unwound 2026-06-19; see lifecycle/originality-r3.json for the round-3 set  
> The scripts named below are **frozen** - do not edit them; a new campaign gets a new script.  
> Any claim in this guide about a script's `DRY_RUN` value is **not authoritative**: run `npm run audit:dryrun`.

Read this before helping unwind originality liquidity. Script: `remove-merge-originality.js`.

## Goal

Take down **all** originality liquidity and turn the resulting outcome tokens back
into **sUSDS**. This is the inverse of `add-20k-originality-liquidity.js`.

## Market structure (recap)

- **Parent market** `0xdb3aae8d1c964767eeaa17805be25cded7a17210` — categorical,
  collateral = **sUSDS** (`0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0`). One outcome
  per repo + an **Invalid** outcome → 99 parent outcome tokens total.
- **Child scalar markets** (`markets.js`, 98 of them) — collateral = that repo's
  parent-outcome token. Outcomes = **Down, Up, Invalid** (3 wrapped tokens each).
- **LP positions** — Up/Down paired against the repo's parent-outcome token. Two
  pools per repo, 196 positions, matched to NFTs via `add-back-execution.json`.

## The 3 phases

1. **Remove 100% liquidity** from every originality position
   (`NonfungiblePositionManager.removeCallParameters`, `liquidityPercentage = 100%`,
   collect to wallet). Returns the Up/Down tokens **and** the parent-outcome
   (collateral) tokens to the wallet.
2. **Merge child sets → parent-outcome token.** For each repo,
   `Router.mergePositions(sUSDS, childMarket, amount)` burns a **complete set
   {Down, Up, Invalid}** and returns `amount` of the parent-outcome token.
3. **Merge parent set → sUSDS.** `Router.mergePositions(sUSDS, parentMarket, amount)`
   burns the **complete parent set {all 98 repo outcomes + parent Invalid}** and
   returns `amount` sUSDS.

> `collateralToken` arg is always **sUSDS** (base collateral) for both merges —
> the Router figures out from `parentCollectionId` which tokens to pull. See
> `src/Router.sol` `mergePositions` / `_mergePositions` / `getPartition`.

## Why the Invalid tokens matter

`_mergePositions` iterates the **full partition** (`getPartition(outcomeSlotCount)`)
and pulls `amount` of **every** outcome — including **Invalid**, which is never put
in a pool but was minted during the original split and is held in the wallet. The
mergeable amount each step is therefore:

```
amount = min(balance of every outcome in the set)   // incl. Invalid
```

Any imbalance (e.g. an outcome you hold less of) caps the merge; the leftover of
the other outcomes stays in the wallet as dust. This is expected.

## How to run

```
# 1. Dry run — read-only, no transactions. Resolves the map (≈98 markets),
#    caches it to originality-merge-cache.json, and PROJECTS recovery:
#      - Phase 1 token returns, Phase 2 per-repo mergeable amount,
#      - Phase 3 "would recover ≈ N sUSDS" and "outcomes at zero" count.
node remove-merge-originality.js

# 2. Review:
#      - "positions: 196", "parent outcomes: 99"
#      - Phase 2: any repo printing "one outcome is zero" can't be merged.
#      - Phase 3: "outcomes at zero: 0" means the full parent merge will run.
#        If > 0, those outcomes block the parent merge (see Issues below).

# 3. Live run — edit line ~28: const DRY_RUN = false;  then:
node remove-merge-originality.js

# 4. (optional) verify wallet sUSDS went up and outcome-token balances went to ~dust.
```

Config flags (top of file):
- `DRY_RUN` — default `true`. Flip to `false` to send transactions.
- `BURN_NFT` — default `false`. Set `true` to also burn each emptied position NFT
  in the same remove tx (only if you don't want to reuse the NFTs).

## Idempotency / resume

- Phase 1 removals are logged to `remove-merge-originality-execution.json` after
  each success; a re-run skips positions already logged and skips any position
  whose on-chain liquidity is already `0`. Safe to interrupt and re-run.
- Phases 2–3 are **balance-driven**, so they're naturally re-runnable: after a
  successful run the outcome balances are ~0, so `amount` becomes 0 and they skip.
- The resolved map is cached in `originality-merge-cache.json` (static data —
  delete it to force a fresh on-chain resolve).

## Transaction volume / timing

Like the add script, everything is sequential: ~196 remove txs, up to 98 child
merges (each with up to 3 approvals), and 1 parent merge (with up to 99 approvals).
Expect 1–2 hours. `ensureAllowance` skips tokens already approved, so re-runs are
faster.

## Common issues

### Phase 2: "one outcome is zero — cannot merge this repo"
You hold 0 of one of {Down, Up, Invalid} for that repo, so the set is incomplete.
Usually means that outcome was sold/transferred, or the Invalid was never minted.
That repo's parent-outcome token won't be reconstituted, which can in turn lower
the Phase 3 parent merge. Acquire/mint the missing outcome or accept partial recovery.

### Phase 3: "outcomes at zero: N (> 0)"
The parent merge needs a complete set of all 99 parent outcomes. If any is zero
(e.g. a repo whose child merge couldn't run), the parent merge is blocked. Fix the
upstream zero (Phase 2) first, or merge the parent set only up to the min you do hold.

### Slippage on removal
Removal uses 0.5% slippage. If a pool moved a lot it may revert; `retryTransaction`
retries 3×. Bump the `slippageTolerance` in the remove options if needed.

## Key addresses (Optimism, chain 10)

| Contract | Address |
|---|---|
| Seer Router | `0x179d8F8c811B8C759c33809dbc6c5ceDc62D05DD` |
| Originality parent market | `0xdb3aae8d1c964767eeaa17805be25cded7a17210` |
| sUSDS | `0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0` |
| Uniswap V3 NonfungiblePositionManager | `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` |
| MarketFactory | `0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6` |
| MarketView | `0x336695ec9efbafd6322fb82eaadbcda02e38f348` |

## Files

| File | Purpose |
|---|---|
| `remove-merge-originality.js` | the remove + merge script |
| `remove-merge-originality-execution.json` | Phase 1 removal progress log |
| `originality-merge-cache.json` | cached resolved map (repos + full parent set) |
| `add-back-execution.json` | pool `(token0,token1)` → positionId source |
| `markets.js` | originality child market addresses |
| `src/Router.sol` | merge/split semantics (partition incl. Invalid) |
| `add-20k-originality-liquidity.js` | the inverse (add) script |
