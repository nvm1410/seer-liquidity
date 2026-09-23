# Guide for Claude: L1 Liquidity Add-Back

> **Status: HISTORICAL.** closed out 2026-09-01 - answered, resolved, redeemed  
> Machine-readable: [`lifecycle/l1-deepfunding.json`](../../lifecycle/l1-deepfunding.json)  
> Run logs: [`archive/runs/l1/`](../../archive/runs/l1/)  
> The scripts named below are **frozen** - do not edit them; a new campaign gets a new script.  
> Any claim in this guide about a script's `DRY_RUN` value is **not authoritative**: run `npm run audit:dryrun`.

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

## Unwind: all L1 liquidity back to sUSDS (2026-08-25)

The reverse of everything above. **Status: EXECUTED 2026-08-25 — 198/198 positions
drained, both merges landed, 0 failures.**

### Result

| Leg | Amount |
|---|---|
| Liquidity removed | 158,506.116804064375452412 |
| sUSDS returned directly by the pools | 12,485.72 |
| sUSDS from merging Market B → Market A → sUSDS | 20,476.007615049539122226 |
| **Total sUSDS recovered** | **~32,962** (4,544.01 → 37,505.741498927464627829) |
| Stranded outcome tokens (market A) | 351,173.309797163442676209 across 67/68 outcomes |
| Stranded outcome tokens (market B) | 135,954.362503889194683910 across 32/33 outcomes |
| Txs | 198 removals + 101 approvals + 2 merges = 301 |
| Gas | ~0.0000178 ETH |

10 transient retries in total (drpc lag); every one recovered on attempt 2.

### Scripts

| File | Purpose |
|---|---|
| `withdraw-l1-liquidity.js` | Phase 1 — remove 100% + collect from every L1 position |
| `merge-l1-positions.js` | Phases 2+3 — merge B → OTHER_TOKEN, then A → sUSDS |
| `verify-l1-unwind.js` | Read-only: all positions drained, logged txs succeeded, residuals |
| `withdraw-l1-liquidity-execution.json` | 198 entries (`kind: "remove"`, market A/B label, txHash) |
| `merge-l1-positions-execution.json` | 2 entries, one per market, resumable per phase |

Run order: `withdraw-l1-liquidity.js` (dry, then `DRY_RUN = false`) →
`merge-l1-positions.js` (dry, then live) → `verify-l1-unwind.js`.

### Things worth knowing before re-running this

1. **Merge Market B first.** `Router.mergePositions` burns an equal amount of *every*
   outcome, so each merge is capped at `min(balances)` over the full set incl. Invalid.
   B's merge *mints* A's outcome #66 (OTHER_TOKEN) — the only A outcome with no pool and
   therefore the one with almost no standalone balance. Merging A first would have capped
   the whole unwind at the ~2,749 of OTHER_TOKEN lying around instead of 20,476.
   After B's merge, A's binding minimum was #66 at 20,476.01; the next-lowest outcome was
   #58 at 20,839.57 — only ~364 above, so the B→A chain was very nearly the *only*
   constraint. The ordering is worth roughly 17.7k sUSDS.
2. **`mergePositions` takes sUSDS (the base collateral) as arg 1 for BOTH markets** — not
   the parent-outcome token for B. The Router derives the partition from
   `parentCollectionId`. Same rule as the splits in round 2.
3. **Scope is discovered from chain, not from `execution.json`.** `withdraw-l1-liquidity.js`
   enumerates the wallet's 494 position NFTs via `balanceOf` / `tokenOfOwnerByIndex` and
   matches on `pairKey(token0, token1)` against A's + B's wrapped tokens. It cross-checks
   against `execution.json`'s 198 IDs and prints any divergence — on this run: 0 missing,
   0 extra, 100 distinct pools (A: 133 NFTs, B: 65).
4. **NFTs were kept, not burned** (`BURN_NFT = false`). All 198 are still owned at zero
   liquidity, so a future round can `increaseLiquidity` the same tokenIds exactly as the
   two add rounds did. `COLLECT_EMPTY = true` sweeps fees off already-empty positions;
   nothing qualified on this run.
5. **~487k outcome tokens are stranded** in the wallet — the trading imbalance across two
   many-outcome markets. They are not lost: they become redeemable via
   `Router.redeemPositions` once A and B resolve. Do not try to recover them by selling
   into the pools; the pools are now empty.
6. The residual gaps from the July add-back (29-30 partially restored positions) are moot
   now — everything is drained.

## Resolution: answering Reality + reporting payouts (2026-08-28)

The final act. The unwind left ~487k outcome tokens stranded; they only become redeemable
once both markets resolve.

### ✅ Step 1 status: EXECUTED 2026-08-28 — 99/99 answers submitted, 0 retries, 0 failures

| Leg | Value |
|---|---|
| Market A answers | 67 (66 repos + "Other repositories") |
| Market B answers | 32 repos |
| Bonds posted | 0.0495 ETH (99 × 0.0005 min_bond) |
| Σ market A payouts | `999999999800000000` (0.9999999998) |
| Σ market B payouts | `168323080700000000` (0.1683230807) |
| A#66 "Other repositories" | `168323080700000000` — exactly Σ market B |
| Questions finalize | 2026-08-31 ~16:52 UTC (302400 s after the last submit) |

Verified independently from chain afterwards: all 99 `best_answer` values match the intended
answers, none pending arbitration, none unanswered.

### Scripts

| File | Purpose |
|---|---|
| `l1weightsForResolution.csv` | The juror weights — 98 repos, `repo,parent,weight`, summing to 0.9999999998 |
| `answer-l1-markets.js` | Step 1 — submits all 99 Reality answers, fail-closed, resumable |
| `answer-l1-execution.json` | 99 entries with market/outcomeIndex/questionId/answerWei/txHash |
| `resolve-l1-markets.js` | Step 2 — scans status, calls `Market.resolve()` when finalized |
| `resolve-l1-execution.json` | Written by step 2, one entry per market — never written here, a third party resolved both markets first |
| `redeem-l1-positions.js` | Step 3 — redeems every non-zero-payout outcome, B then A, back to sUSDS |
| `redeem-l1-positions-execution.json` | 8 entries, one per redeem chunk |

Run order: `answer-l1-markets.js` (dry, then `DRY_RUN = false`) → wait 3.5 days →
`resolve-l1-markets.js` (dry, then live) → `redeem-l1-positions.js` (dry, then live).

### Things worth knowing before doing this again

1. **The answer scale is a FRACTION, not a percent.** The question is *"What will be the juror
   weight … of [repository]…?"* with `lowerBound = 0`, `upperBound = 1e18`. So `0.0456649495`
   is submitted as `45664949500000000`. The Octant market (`answer-octant-markets.js`) was a
   `[percent]` question with `upperBound = 100e18` — copying that scale here would be 100× wrong.
   Always read `upperBound` off the market rather than assuming.

2. **`elo.js` is NOT the resolution data.** It holds the *seeding* weights used to price the
   pools (go-ethereum 0.0623, A/B split 0.9313/0.0687). The resolution weights are different
   numbers with a different split (0.0457, 0.8317/0.1683). Using `elo.js` would have mispriced
   every outcome.

3. **A#66 "Other repositories" is answered with Σ(market B's 32 weights).** That is what makes
   the two-level redemption exact: a B token redeems to `w_j/ΣB` of an OTHER token, which
   redeems to `ΣB/ΣA` sUSDS — the product is exactly `w_j`. Any other value silently
   over- or under-pays every market B holder.

4. **Market B#31's on-chain name is `lambdaclass/lambda_ethereum_consensus\t`** — a literal
   backslash + `t` (bytes `0x5c 0x74`), a stray escape sequence baked in at market creation.
   Normalizing to `[a-z0-9]` strips the backslash but keeps the `t`, so it needs an explicit
   entry in `ALIASES`. The name-matching assertions caught this before any transaction.

5. **Only ratios matter.** `RealityProxy.resolveMultiScalarMarket` writes the raw answers as
   the payout vector and `ConditionalTokens` divides by their sum, so the 2e-10 shortfall in
   the CSV total is irrelevant.

6. **`Market.resolve()` reverts unless EVERY question in that market is finalized.** One missed
   answer blocks the whole market, which is why step 1 fails closed on an incomplete
   outcome ↔ CSV mapping rather than skipping rows.

7. **Answers are contestable.** Anyone can overwrite a question by posting 2× the bond, which
   also restarts that question's 3.5-day clock. Re-running `answer-l1-markets.js` dry is the
   check: it compares each on-chain `best_answer` to the intended value and warns loudly.

### Expected redemption

At these weights the wallet's stranded tokens are worth **~5,533 sUSDS** (4,774 direct from
market A, 759 via market B's 4,510 OTHER tokens). Note this is much smaller than the 487k token
count suggests — weights sum to 1, so `Σ balance × weight` tracks the *mean* per-outcome
balance, not the total.

## Redemption: stranded tokens → sUSDS (2026-09-01)

### ✅ Status: EXECUTED 2026-09-01 — 98/98 outcomes redeemed, exact to the wei

`resolve-l1-markets.js` had **nothing to do**: by 2026-09-01 both markets already read `CLOSED`
with `payoutReported = true`, so a third party had called the permissionless `Market.resolve()`
after the questions finalized. `resolve-l1-execution.json` was therefore never written — that is
expected, not a gap.

| Leg | Value |
|---|---|
| Phase 1 — market B | 32 outcomes → **4,510.2845 OTHER** tokens (3 txs) |
| Phase 2 — market A | 67 outcomes (incl. the fresh OTHER) → **5,533.4660 sUSDS** (5 txs) |
| sUSDS | 37,305.7415 → **42,839.2075** (+5,533.465968565583817205) |
| Delta vs projection | **0** |
| Transactions | 98 approvals + 8 redeems = 106; 13.28M gas on the redeems |
| Gas cost | ~0.0000182 ETH |
| Left in wallet | 2,467.94 (B) + 383.39 (A) "Invalid result" tokens, `payoutNumerator = 0`, worth 0 |

Script: `redeem-l1-positions.js` → log `redeem-l1-positions-execution.json`, run
`redeem-l1-run.log`. The predicted 5,533 in the section above was exactly right.

### Things worth knowing before doing this again

1. **Child market first, again — but for a different reason than the merge.** Unlike
   `mergePositions`, `redeemPositions` is *not* capped at `min(balances)`; each outcome pays out
   its own weight independently. Order still matters because market B redeems into market A's
   outcome #66 (OTHER_TOKEN), whose standalone balance was **zero**. Redeeming A first would have
   left B's whole 759 sUSDS behind a token balance of nothing.
2. **Skip outcomes with `payoutNumerators == 0`.** The two "Invalid result" slots would burn
   2,851 tokens for exactly zero collateral. The script reads the payout vector off
   `ConditionalTokens` and filters them out rather than trusting the outcome name.
3. **Pass the BASE collateral (sUSDS) for both markets**, exactly as with `mergePositions` —
   `_redeemPositions` derives the position id from each market's own `parentCollectionId`.
4. **A confirmed approve receipt is not globally visible state.** The first live run approved all
   15 tokens of a chunk, then `estimateGas` on the redeem reverted with
   `ERC20: transfer amount exceeds allowance` — the estimate hit a lagging RPC backend node. The
   same call estimated fine seconds later. `ensureAllowance` now polls the allowance back until
   it reads through, and `estimateGas` sits inside the retry loop. This cost only wasted
   approvals, but on a send rather than an estimate it would have been a failed transaction.
5. **The progress file is an audit trail, not the work queue.** Chunks are recomputed from live
   balances every run, so a redeemed outcome (balance → 0) drops out by itself and the script is
   safely resumable after a crash mid-phase.
6. **67 outcomes in one call is ~2.4M gas at `CHUNK_SIZE = 15`**, well under Optimism's 40M block
   limit; the chunking is caution, not necessity.
