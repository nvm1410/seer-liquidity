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
(progress saved to `add-back-execution.json`). The L1 add-back has NOT been done yet.

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
