# Guide for Claude: L1 Liquidity Add-Back

Read this file at the start of the session before helping with L1 liquidity restoration.

## Situation

The wallet (`0x00DC3E0AcAdB8dBA21BB08fF30540222FF8836e0`) had Uniswap V3 concentrated
liquidity positions on Optimism (chain 10) across two types of pools:

1. **L1 pools** — outcome tokens (from `wrappedTokens.js`) paired with sUSDS
   (`0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0`). ~198 positions, IDs ~1038868–1055066.
2. **Originality pools** — outcome tokens paired against a parent outcome token
   (not sUSDS). ~196 positions, IDs ~1034306–1034507.

`index.js` was run to remove 50% of liquidity from these positions using
`liquidityPercentage: new Percent(1, 2)`. It wrote `execution.json` at the end of
the L1 removal run, recording each position's **pre-removal** liquidity values.

The originality add-back has already been handled by `add-back-liquidity.js`
(progress saved to `add-back-execution.json`).

## ✅ L1 add-back status: EXECUTED 2026-07-27

The L1 add-back was run live on 2026-07-27. Result: **198/198 positions processed,
0 failed**. 275 txs (77 approvals + 198 `increaseLiquidity`). Of the 198:
- **168 positions fully restored** (delta now 0 on re-read).
- **30 positions partially restored** — capped at available balance because 30 of the
  ~300 unique outcome tokens were short (shortfalls ranged ~0.3%–39%). These used
  `Position.fromAmounts` scale-down. A fresh dry run shows exactly these 30 still have
  residual delta > 0.

Progress log: `add-back-l1-execution.json` (198 entries). To finish the 30 partials,
acquire more of those short outcome tokens (e.g. `splitPosition` more complete sets),
then re-run — the script auto-skips the 168 done and tops up only the residual deltas.

## What execution.json contains

Each entry has:
```json
{
  "token0": "0x5bcDfCa3F241791f3d6372385924178f59618238",
  "token1": "0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0",
  "liquidity": "2087391058643915539",
  "positionId": "1038868",
  "poolAddress": "0x0767E5d02d10ECeAB237F1dBDdB798Eec44291B9"
}
```

`liquidity` = the liquidity value **before** the 50% removal. Since `index.js`
removed 50%, the current on-chain value should be roughly half of this.
Delta to add back = `original (execution.json) - current (on-chain)`.

## Script to use: add-back-l1-liquidity.js

This script is already written and ready. Key behaviours:

- Sources from `execution.json` (has exact original liquidity — more precise than
  the originality script which had to assume `delta = current`).
- For each position: reads on-chain `positions(tokenId)`, computes
  `delta = original - current`. Skips automatically if `delta <= 0` (position
  untouched or already restored).
- Preflight shows per-token needed vs available wallet balance (no abort on
  insufficient — caps at available and scales down positions proportionally using
  `Position.fromAmounts`).
- Approves each unique token **once** before sending any increase txs.
- Writes progress incrementally to `add-back-l1-execution.json` after each
  success — safe to interrupt and re-run.
- `DRY_RUN = true` by default. Always run dry first, then flip to `false`.

## How to run

```
# Step 1 — dry run (reads on-chain, no transactions)
node add-back-l1-liquidity.js

# Step 2 — review the output:
#   - "To restore" count should be ~198 (or fewer if some were already restored)
#   - Check per-token "needed vs available" — ⚠️ means script will use less
#   - Skipped (delta=0) means those positions were never reduced or already done

# Step 3 — live run
# Edit add-back-l1-liquidity.js line 11: const DRY_RUN = false;
node add-back-l1-liquidity.js

# Step 4 — verify idempotency (re-run, all should be skipped)
node add-back-l1-liquidity.js
```

## Common issues and fixes

### "to restore" count is 0 or very low
`execution.json` may have been overwritten by a later run of `index.js`. Check
whether the position IDs in `execution.json` are the L1 ones (1038868+) or
something else. If overwritten, you can reconstruct originals as `original = 2 ×
current` for any position confirmed to be at 50% (same approach as the originality
script). In that case switch the source from `execution.json` to `positionsToWithdraw.js`
and set `delta = current`.

### ⚠️ INSUFFICIENT on a token
Expected — the script handles this automatically. It caps the approval at available
balance and skips positions only when a token is fully exhausted (balance = 0) or
the capped amounts yield zero liquidity. Check the skipped count at the end. If
many are skipped, the wallet may need more of that token before running again.

### Transaction reverts / nonce issues
The `retryTransaction` helper retries up to 3× with 3s delay. If all 3 attempts
fail, the position is logged as `❌ Failed` but the script continues. Re-run to
retry failed positions — they won't be in `add-back-l1-execution.json` so they
will be picked up again.

### Slippage errors
Pool prices may have moved. The script uses 0.1% slippage tolerance (same as the
original add). If prices moved a lot, increase to e.g. `new Percent(50, 10_000)`
(0.5%) at line with `slippageTolerance`.

## Key contract addresses (Optimism, chain 10)

| Contract | Address |
|---|---|
| Uniswap V3 NonfungiblePositionManager | `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` |
| sUSDS (L1 collateral token) | `0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0` |
| MarketFactory | `0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6` |
| MarketView | `0x336695ec9efbafd6322fb82eaadbcda02e38f348` |

## Key files in this repo

| File | Purpose |
|---|---|
| `execution.json` | Pre-removal L1 liquidity snapshot (source of truth for L1 add-back) |
| `add-back-l1-execution.json` | Progress log written by add-back-l1-liquidity.js |
| `add-back-execution.json` | Progress log for originality add-back (already done) |
| `positionsToWithdraw.js` | The 198 L1 position IDs that were queued for removal |
| `tokens.js` | All 394 position IDs ever created by this wallet |
| `wrappedTokens.js` | L1 outcome token addresses (paired with sUSDS in L1 pools) |
| `originalityPairs.js` | Originality pool token pairs (used to filter originality positions) |
| `index.js` | The removal script (50% via Percent(1,2), writes execution.json) |
| `liquidity-originality.js` | The original add script for originality pools |
| `liquidity-l1.js` | The original add script for L1 pools |
| `add-20k-l1-liquidity.js` | Round-2 add: +20k sUSDS into the L1 pools (see below) |
| `verify-20k-l1.js` | Read-only checker for the round-2 add |
| `add-20k-l1-execution.json` | Progress log written by add-20k-l1-liquidity.js |

## Round 2: +20k sUSDS into the L1 pools (2026-07-30)

Separate from the add-back above. The add-back *restored* what `index.js` removed; this
round *adds new* liquidity, mirroring `add-20k-originality-liquidity.js`.

### ✅ Status: EXECUTED 2026-07-30 — 100/100 pools, 0 failed

205 txs (2 router approvals + 2 splits + 77 PositionManager approvals + 100
`increaseLiquidity`). Solved multiplier **f = 0.8993**, so every pool ended at exactly
**1.8993×** its pre-run liquidity, verified on-chain for all 100.

| Leg | Amount |
|---|---|
| `splitPosition` on market A | 14,090.173262736365820835 sUSDS |
| `splitPosition` on market B | 11,341.087190477483366222 "Other repos" (from A's split) |
| sUSDS deposited into pools | 5,889.826735139665744196 |
| **Total sUSDS spent** | **19,980.00** (44,532.02 → 24,552.02) |
| Gas | 0.0000636 ETH |

Three transient `nonce too low` errors from a lagging drpc node; all recovered on retry 2.

⚠️ **`execution.json` is NOT a valid baseline for checking this round.** It is the
*pre-removal* snapshot from `index.js`; the July add-back left 29 pools only 80–99.9%
restored, so comparing against it understates this round's growth by that residual gap.
`verify-20k-l1.js` derives the true baseline as `(current − addedLiquidity)` instead.
The 29 residual gaps are still open — see the add-back section above to close them.

### L1 market structure (verified on-chain)

The 100 L1 pools are fed by **two** markets, not one:

| | Address | Collateral | Outcomes | Pooled vs sUSDS |
|---|---|---|---|---|
| Market A (top-level) | `0x3220A208aAf4D2ceECDe5A2e21eC0C9145f40BA6` | sUSDS | 68 | 67 |
| Market B (conditional on A) | `0xfea47428981f70110c64dd678889826c3627245b` | A's outcome #66 | 33 | 33 |

Market B's parent is Market A at `parentOutcome = 66`, whose ERC20 is
`0x63a4F76ef5846F68D069054C271465B7118e8ed9` ("Other repositories…") — the **only** Market A
outcome with no sUSDS pool, so its entire supply is free to split into Market B.

The 198 positions in `execution.json` cover only **100 distinct pools**: 98 tokens have two
NFTs each with identical fee (100) and identical range `[-92109, -16096]` (a tiny first test
batch `1038868–1038968` plus the real batch `1039269–1039367`), and the two "Invalid result"
tokens have one tiny NFT each (`1055065`, `1055066`).

### How add-20k-l1-liquidity.js works

- **Budget accounting**: the 20k counts *both* the sUSDS locked in `splitPosition` *and* the
  sUSDS deposited as the pool's collateral side — the same way the first 20k was counted.
- **Phase 0**: groups `execution.json` by pool, sums each pool's combined liquidity, and picks
  the largest NFT per pool as the single top-up target (100 txs, not 198). Asserts every NFT
  in a pool shares fee + tick range; splits into sub-targets if not.
- **Phase 0.5**: solves the add multiplier `f` so that
  `splitA + Σ pool-side sUSDS == 20,000`, iterating `f ← f * BUDGET / total(f)`. One split per
  market must cover that market's single largest per-token shortfall, since one split mints
  every outcome of the market. Leftover wallet balances are netted off first.
- **Phase 1**: `router.splitPosition(sUSDS, MARKET_A, splitA)`.
- **Phase 2**: `router.splitPosition(sUSDS, MARKET_B, splitB)` — pass the **base** collateral
  (sUSDS) as the first arg; the Router unwraps the parent outcome ERC20 because B has a
  non-zero `parentCollectionId`. `OTHER_TOKEN` must be approved to the Router.
- **Phase 3**: `increaseLiquidity` per pool, capping via `Position.fromAmounts` if a balance
  falls short, writing `add-20k-l1-execution.json` after each success.

Run it exactly like the add-back: dry run first, review, flip `DRY_RUN = false`, then
`node verify-20k-l1.js`. If it dies mid-run set `SKIP_SPLITS = true` and re-run — the splits
already happened and only the missing `increaseLiquidity` calls are retried.
