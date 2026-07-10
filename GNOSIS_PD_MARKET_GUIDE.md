# Guide: Gnosis PD (Probability-of-Default) Multi-Categorical Market

Read this before touching liquidity on the Gnosis "Probability of Default" market or
wiring the `risk-pricing-ui` frontend to it. Covers: market structure, the
yearly↔quarterly pricing model, the Swapr/Algebra liquidity scripts (`add-pd-*`,
`remove-liquidity-gnosis.js`), and the UI-side changes in the sibling
`risk-pricing-ui` repo.

## The market

> "What is the Probability of Default (PD) for the following DeFi assets before 2027?"
> https://app.seer.pm/markets/100/what-is-the-probability-of-default-pd-for-the-following-defi-assets-before-2027-2

- **Address**: `0x7d386b7c41b8dab6179fc79cf7986a795305b815` (Gnosis, chain 100).
- **⚠️ Disambiguation**: there are **two** markets with this exact name/question. The
  one we use has **24 assets**; a sibling at `0x0ccad5a986efd65e06fa64ac62764aa14555a0f01`
  has only **8 assets** and is a different market. Always confirm via `MarketView` /
  the subgraph before assuming an address — don't trust the URL slug alone.
- **Outcomes (26, on-chain order)**: `wbETH, stETH, ETH+, bsdETH, rETH, pufETH, PYUSD,
  RLUSD, USDC, USD1, USDS, USDT, BTCB, solvBTC, tBTC, cbBTC, LBTC, UBTC, GACLO-1,
  BUIDL-I, JAAA, JTRSY, mF-ONE, STAC, No To All, Invalid result` — this order matches
  `assets_pd.csv` 1:1 for the first 24.
- **Collateral**: sDAI (`0xaf204776c7245bf4147c2612bf6e5972ee483701`).
- **DEX**: Swapr, i.e. **Algebra V1** concentrated-liquidity pools — NOT Uniswap V3.
  No fee tiers (single dynamic fee), fixed `tickSpacing = 60`.

## Pricing model: yearly PD → quarterly PD → pool price

Source data: `assets_pd.csv` (yearly probability of default per asset, from the
Notion methodology doc). Two-step conversion, implemented in `implied-prices.js`:

1. **Yearly → quarterly** (constant quarterly hazard rate):
   ```
   quarterlyPD = 1 - (1 - yearlyPD) ^ (1/4)
   ```
2. **Quarterly PDs → initial pool prices** via the multi-categorical pricing model
   (`computePrices`, ported from the frontend's `useImpliedProbs.ts`):
   ```
   priceY   = Π(1 - qPD_i)                    → "No To All" outcome price
   price_i  = qPD_i · E[1 / (1 + k)]           → each asset outcome's price
   ```
   where `k` = number of *other* outcomes that also default this quarter (since
   defaults share a fixed payout pool — this is the dilution/expectation term).

Validated end-to-end: `Σ price_i + priceY = 1.0000000000` exactly against the real
CSV (`No To All ≈ 0.9654`, asset prices range `0.00009`–`0.006`).

**The inverse (quarterly PD → yearly PD)** is `1 - (1 - quarterlyPD) ^ 4` — used to
convert live pool-implied quarterly probabilities back to yearly for display.

## Liquidity scripts (this repo)

| Script | Role |
|---|---|
| `implied-prices.js` | forward-only port of `useImpliedProbs.ts`'s `computePrices` + `yearlyToQuarterly` helper. No React/Worker/inverse-solver — we already know the probabilities. |
| `add-pd-liquidity-gnosis.js` | **Round 1**: creates + initializes + mints all 25 real-outcome pools (24 assets + No To All) fresh. Budget 5 sDAI, **equal outcome-token quantity `Q`** across ALL 25 pools (octant-style sizing), Safe band (−20%/+40%) per outcome. |
| `add-pd-liquidity-gnosis-round2.js` | **Round 2**: tops up the 24 asset pools only (excludes No To All — see "lesson" below) with another 5 sDAI, equal `Q2` per asset pool, same tick ranges as round 1 (new NFT per pool, doesn't touch round 1's positions or move price). |
| `remove-liquidity-gnosis.js` | Removes 100% liquidity from every matched NPM position (auto-discovered via ERC721 enumeration, no tokenId tracking needed) and merges the recovered complete set back into sDAI. **Written and dry-run validated only — not yet executed** (saved for later, on purpose). |

### Deployment state as of this session

- Round 1: 25/25 positions minted, ~4.999996 sDAI spent.
- Round 2: 24/24 positions minted (No To All untouched), ~5.0 sDAI spent.
- Total deployed: ~10 sDAI. Each asset pool now holds `0.713716 + 4.884318 ≈ 5.598`
  outcome-token-equivalent depth; No To All holds only its round-1 depth
  (`0.713716` outcome + `4.269380` sDAI).
- Progress logs (idempotent, resumable): `add-pd-gnosis-execution.json`,
  `add-pd-gnosis-round2-execution.json`. `remove-pd-gnosis-execution.json` will be
  created once the remove script is actually run.

### Lesson learned: don't give "No To All" equal weight

Round 1 used the **same** equal-outcome-quantity `Q` for all 25 pools, including "No
To All" (price ≈ 0.9654). Because that pool's price is so close to 1, matching its
outcome-token side with the same `Q` as a 0.0001-priced asset pool required a huge
sDAI side — **85% of the round-1 budget (4.27 of 5 sDAI) went into just that one
pool.** Round 2 fixed this by excluding "No To All" entirely and putting the whole
budget into the 24 asset pools. **If deploying fresh again, decouple "No To All"
sizing from the asset pools from the start** (e.g. fix its sDAI contribution to a
small constant and let outcome-token amount be "whatever's implied", rather than
equal-`Q`).

### Swapr/Algebra technical notes (things that aren't obvious)

- **Algebra NPM ABI** (`0x91fd594c46d8b01e62dbdebed2401dde01817834` on Gnosis) is
  close to but NOT identical to Uniswap V3's — no `fee`/`deployer` fields anywhere.
  Verified on-chain via Sourcify (`partial_match`). Key functions used:
  `createAndInitializePoolIfNecessary(token0,token1,sqrtPriceX96)`,
  `mint((token0,token1,tickLower,tickUpper,amount0Desired,amount1Desired,amount0Min,
  amount1Min,recipient,deadline))`, `decreaseLiquidity((tokenId,liquidity,
  amount0Min,amount1Min,deadline))`, `collect((tokenId,recipient,amount0Max,
  amount1Max))`, `burn(tokenId)`, `multicall(bytes[])`, plus standard
  ERC721Enumerable (`balanceOf`, `tokenOfOwnerByIndex`) for discovering owned
  positions without tracking tokenIds ourselves.
- Because the Uniswap V3 SDK's calldata builders (`NonfungiblePositionManager.
  addCallParameters`/`removeCallParameters`) assume the Uniswap ABI shape, they
  **cannot** be used for Algebra — all Algebra calls are hand-encoded via
  `ethers.Interface` + `multicall`.
- **`@uniswap/v3-sdk`'s `Pool`/`Position` math is still reused** for tick/amount
  calculations — Algebra V1 shares identical concentrated-liquidity math for a given
  `[tickLower, tickUpper]` + `sqrtPriceX96`. We pass `FeeAmount.MEDIUM` (3000) as a
  **math-only vehicle** purely because it maps to `tickSpacing = 60`, matching
  Algebra's fixed spacing exactly. This fee value is never sent on-chain.
- **Pool address** (for reading live price/liquidity without an SDK helper):
  `CREATE2(POOL_DEPLOYER, keccak256(abi.encode(token0, token1)), INIT_CODE_HASH)`.
  Live state read via `globalState()` (`price`/`tick`, Algebra's analog of `slot0`)
  and `liquidity()`.
- **Complete-set split mechanic**: `GnosisRouter.splitPosition(sDAI, market, X)`
  mints `X` units of **every** outcome token simultaneously for a cost of exactly
  `X` sDAI (not `X × numOutcomes`) — standard conditional-tokens behavior. This is
  why, after round 1 + round 2, every one of the 26 wrapped tokens (including the
  never-funded "Invalid result" and the untouched-in-round-2 "No To All" excess)
  converges to the **same** balance (`0.713716 + 4.884318 ≈ 5.598034`) once all
  liquidity is removed — confirmed by `remove-liquidity-gnosis.js`'s dry run,
  projecting a perfectly complete set with **zero dust**.
- **Adding liquidity never moves price.** Only swaps move a pool's spot price, so
  round 2 could safely add a second position in the same tick range as round 1
  without withdrawing anything first, and without disturbing the already-initialized
  price.

### Key addresses (Gnosis, chain 100)

| Contract | Address |
|---|---|
| sDAI (collateral) | `0xaf204776c7245bf4147c2612bf6e5972ee483701` |
| Seer GnosisRouter (split/merge) | `0xeC9048b59b3467415b1a38F63416407eA0c70fB8` |
| Seer MarketView | `0x95493F3e3F151eD9ee9338a4Fc1f49c00890F59C` |
| Seer MarketFactory | `0x83183DA839Ce8228E31Ae41222EaD9EDBb5cDcf1` |
| Swapr Algebra NonfungiblePositionManager | `0x91fd594c46d8b01e62dbdebed2401dde01817834` |
| Algebra PoolDeployer (for CREATE2 pool address) | `0xC1b576AC6Ec749d5Ace1787bF9Ec6340908ddB47` |
| Algebra pool init code hash | `0xbce37a54eab2fcd71913a0d40723e04238970e7fc1159bfd58ad5b79531697e7` |
| Algebra tick spacing | `60` (fixed, no fee tiers) |
| Seer markets subgraph (GraphQL) | `https://indexer.hyperindex.xyz/798eb82/v1/graphql` |

### Environment

`.env` needs `PRIVATE_KEY` (shared wallet) plus **`GNOSIS_RPC_URL`** — a Gnosis RPC,
separate from `RPC_URL` which stays pointed at Optimism for the other scripts in
this repo. Wallet used this session: `0x00DC3E0AcAdB8dBA21BB08fF30540222FF8836e0`.

### How to run the remove script when ready

```
# 1. Dry run (default DRY_RUN = true) — enumerates all NPM positions for this
#    market, projects removal amounts + the final merge amount, no transactions.
node remove-liquidity-gnosis.js

# 2. Review: "Matched N positions... M have liquidity > 0", the min-outcome-balance
#    merge preview, and "outcomes at zero: 0" (should be 0 for a full merge).

# 3. Live run — flip DRY_RUN = false at the top of the file, then re-run.
#    BURN_NFT = true by default (cleans up emptied position NFTs in the same tx).
```

Expect ~75 transactions (49 removes + up to 26 approvals + 1 merge) — each costs
xDAI gas. Resumable via `remove-pd-gnosis-execution.json` (Phase 1 only; Phase 2
merge is balance-driven and naturally re-runnable).

## `risk-pricing-ui` (sibling repo, `D:\Code\risk-pricing-ui`)

This Next.js app displays/trades the market above. It already targeted Gnosis chain
entirely (wagmi/viem `gnosis`, chain id 100) — only the market id needed updating,
plus wiring up the yearly↔quarterly conversion the pools actually need.

### Changes made

| File | Change |
|---|---|
| `src/consts/markets.ts` | `RISK_PRICING_MARKET_ID` → `0x7d386b7c41b8dab6179fc79cf7986a795305b815` (single source of truth; chain id and all derived URLs already followed from this one constant). |
| `src/hooks/useImpliedProbs.ts` | Added `yearlyToQuarterly` / `quarterlyToYearly` helpers (same formulas as `implied-prices.js` above). |
| `src/hooks/useMarketData.ts` | **Reverse path (pool → UI)**: the solver's `state.probs`/`priceY` are quarterly (pools trade on quarterly-implied prices). Now converts each to yearly via `quarterlyToYearly`, then recomputes "No To All" by re-running `computePrices` on the yearly-converted values, so the displayed figure stays self-consistent rather than being a raw quarterly leftover. |
| `src/hooks/predict/usePredictRiskFlow.ts` | **Forward path (UI → trade)**: `predictedProbs` (user's slider input / `outcome.probability` fallback) is yearly PD end-to-end; converted via `yearlyToQuarterly` immediately before `computePrices` so the actual trade target prices are computed correctly in quarterly terms. |

Net effect: sliders and every displayed number are yearly PD throughout the UI
(matching `assets_pd.csv`'s units and what a user intuitively predicts), while the
pools — seeded using quarterly-derived prices — are traded against correctly
under the hood. Verified with a full `tsc --noEmit` project typecheck (exit 0, zero
errors) after the edits.

`RiskAssetDetailsMapping` (Credora-style risk profile lookup, keyed by lowercased
outcome name, in `src/consts/markets.ts`) and its "No data for this asset" fallback
(`src/app/(homepage)/components/RiskPricing/Details.tsx`) were **not** touched —
already handled before this session.

## Files (this repo)

| File | Purpose |
|---|---|
| `assets_pd.csv` | yearly PD per asset (source data) |
| `implied-prices.js` | pricing math (yearlyToQuarterly + computePrices) |
| `add-pd-liquidity-gnosis.js` | round-1 initial liquidity (fresh pool creation) |
| `add-pd-liquidity-gnosis-round2.js` | round-2 top-up (24 asset pools only) |
| `remove-liquidity-gnosis.js` | remove all liquidity + merge to sDAI (not yet run) |
| `add-pd-gnosis-execution.json` | round-1 progress log (tokenId not recorded — only tx hashes; positions discovered by enumeration when removing) |
| `add-pd-gnosis-round2-execution.json` | round-2 progress log |
| `remove-pd-gnosis-execution.json` | (created on first live run of the remove script) |
| `abis/MarketViewAbi.js`, `abis/RouterAbi.js` | reused Seer ABIs (same shape across chains) |
