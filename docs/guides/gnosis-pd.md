# Guide: Gnosis PD (Probability-of-Default) Multi-Categorical Market

> **Status: HISTORICAL.** v2 live and seeded since 2026-08-12; v1 drained and abandoned  
> Machine-readable: [`lifecycle/gnosis-pd.json`](../../lifecycle/gnosis-pd.json)  
> The scripts named below are **frozen** - do not edit them; a new campaign gets a new script.  
> Any claim in this guide about a script's `DRY_RUN` value is **not authoritative**: run `npm run audit:dryrun`.

Read this before touching liquidity on the Gnosis "Probability of Default" market or
wiring the `risk-pricing-ui` frontend to it. Covers: market structure, the
yearly↔quarterly pricing model, the Swapr/Algebra liquidity scripts (`add-pd-*`,
`remove-liquidity-gnosis.js`), and the UI-side changes in the sibling
`risk-pricing-ui` repo.

> **⚠️ There are two generations of this market.** The **v2 market (33 assets)** is
> the live one — see [Market v2](#market-v2-33-assets-current) below. The v1
> section that follows it describes the original 24-asset market, which has been
> fully drained and is no longer wired to the UI. Most of the mechanics
> (Algebra ABI notes, pricing model, key addresses) are shared and documented once,
> under the v1 sections.

## Market v2 (33 assets) — current

- **Address**: `0xc84786B06390F11dED0DD362E27Fc881B540e6F2` (Gnosis, chain 100).
- **Created**: 2026-08-12, tx
  `0xae2f434a0db172d337e9c86fadb8c3f642f8814e38888b51f7f4365e408d2b8f`,
  block 47679508, **12,829,147 gas**.
- **Outcomes (35)**: the 33 assets from `assets_pd.ts` in file order, then
  `No To All`, then `Invalid result`.
- Same question text, category (`misc`), lang (`en_US`), min bond (10 xDAI) and
  arbitrator as v1. `openingTime` is the creation timestamp, matching v1 —
  the Reality question is answerable immediately.

### What changed vs v1

| | v1 | v2 |
|---|---|---|
| Assets | 24 | 33 |
| First outcome | `wbETH` | **`weETH`** — a *different* Credora asset (psl 0.00096 vs 0.00778), not a rename. `wbETH` was dropped. |
| PD source | static `assets_pd.csv` (rounded, hand-maintained) | **live Credora `Metrics.psl`**, frozen to `assets_pd_v2.csv` by `fetch-credora-pd.js` |
| "No To All" price | 0.9655 | **0.8152** — the new high-PD assets (USDF 16.8%, avETH 13.4%, avUSD 10.4%) pull it down hard |
| Asset price spread | 66× | **497×** (cbBTC 0.0000837 → USDF 0.0416) |
| "No To All" sizing | equal-`Q`, ate 85% of budget | **fixed 0.5 sDAI cap** — 10% of budget |

`assets_pd.ts` lists `solvBTC` twice; it is de-duplicated (first occurrence kept)
by `fetch-credora-pd.js`. A duplicate outcome would produce two identical Reality
answers and two identically-named wrapped tokens, so `create-pd-market-gnosis.js`
hard-fails on one.

### Credora as the PD source

`fetch-credora-pd.js` is the only thing that talks to Credora. It exists because
market creation and liquidity seeding are separate transactions and `psl` moves
between publishes — every downstream step must price against one frozen snapshot.

- Endpoint `https://api.staging.credora.io/graphql` (note: **staging**), auth via a
  `ClientSecret` header from `CREDORA_API` in `.env` (copied from
  `risk-pricing-ui/.env.local`, where the same key backs `src/app/api/credora/route.ts`).
- Query: `ratings(filter: { product: ["assets"], chainId: 1, address: [] })`. The
  `chainId: 1` filter is not restrictive in practice — Credora rates the mainnet
  contract even for assets that live elsewhere, and all 33 resolve.
- The number is `items[].Metrics.psl` — yearly PD as a fraction. The join key is
  **lowercased `name`**, exactly as the frontend's `Details.tsx` does it.
- Outputs `assets_pd_v2.csv` (`Asset,PD`, same format `parsePdCsv` already reads)
  and `assets_pd_v2.json` (adds rating, publishDate, Credora's own spelling).

### Creating a market (no precedent before this)

`create-pd-market-gnosis.js` calls
`MarketFactory.createMultiCategoricalMarket(CreateMarketParams)` — see
`src/MarketFactory.sol:35-50` for the struct. Non-obvious bits:

- `outcomes` must **not** include `Invalid result`; the factory appends it
  (`outcomeSlotCount = outcomes.length + 1`).
- `tokenNames` is one name per *user* outcome (34). The Invalid slot is
  auto-named `SER-INVALID`, and the factory short-circuits before reading
  `tokenNames[invalidIndex]`, so the array must **not** be padded.
- The naming convention, reverse-engineered from v1's deployed wrapped tokens:
  uppercase, `+` → `PLUS`, drop everything non-alphanumeric, suffix `PD`.
  `ETH+`→`ETHPLUSPD`, `GACLO-1`→`GACLO1PD`, `satUSD+`→`SATUSDPLUSPD`,
  `No To All`→`NOTOALLPD`. `toString31` truncates silently past 31 bytes, so the
  script asserts length and uniqueness rather than finding out on-chain.
- **Gas is the real constraint.** Cost is roughly `759k + 344k × outcomeSlots`
  (fit from v1's 26 slots = 9.70M and the 8-asset market's 11 slots = 4.54M).
  v2's 35 slots came in at 12.83M against a **17.0M** Gnosis block limit. The
  script pads `estimateGas` by only 5% — a 20% pad would request 92% of a whole
  block, which validators may not fill. Above ~44 outcomes this stops fitting in
  one transaction at all.
- No bond or value is sent at creation; `minBond` only sets what answerers must post.
- The return value isn't readable from a receipt — the market address comes from
  the `NewMarket` event.

### Sizing: never give "No To All" the asset pools' `Q`

v1's lesson (below) gets worse in v2, because `priceY / minAssetPrice` is now
~9700×. `add-pd-liquidity-gnosis-v2.js` fixes it with `NO_TO_ALL_SDAI = 0.5 sDAI`
and a `sizePositionBySdai()` helper — the mirror of `sizePosition()`, putting the
`HUGE` sentinel on the *outcome* side so the sDAI side binds.

The budget solve has to consider two regimes, because `splitPosition` mints
`splitAmount` of *every* outcome and is therefore driven by whichever pool wants
the most outcome tokens:

```
regime A (split = Q):          f·(Q0 + trialSdaiAssets) + NO_TO_ALL_SDAI               <= BUDGET
regime B (split = noToAllQty): f·trialSdaiAssets + NO_TO_ALL_SDAI + noToAllQty         <= BUDGET
```

Take the tighter `f`; the total then respects the budget either way. Result at a
5 sDAI budget: split 3.994 + sDAI side 1.006 = 4.99999999, with No To All at
10.0% of spend instead of 85%.

### v2 deployment state

- **34 pools** seeded 2026-08-12 (33 assets + No To All; `Invalid result` gets no
  pool, same as v1). Progress log `add-pd-gnosis-v2-execution.json`, 34 entries.
- **5.0 sDAI** spent exactly (wallet `8.292 → 3.292`), funded by draining v1.
- Verified on-chain afterwards, all 34: live `globalState().tick` price within
  **0.0086%** of the intended price (pure tick granularity — `sqrtPriceX96` is
  derived from the clamped tick, so this residual is expected and irreducible),
  every pool in-range and holding non-zero liquidity.
- Seer's backend picked it up promptly: `get-market` returns 35 outcomes and
  `market-chart` 35 series, with the No-To-All pool reading `0.815145` against a
  `0.815186` target.

### Gotcha: Seer's backend renames the last outcome

`MarketView.getMarket` returns the final outcome as **`Invalid result`**, but
Seer's `get-market` Netlify function returns it as **`Invalid`**. Scripts in this
repo read MarketView and assert `"invalid result"`; the frontend reads the Netlify
function and matches `isTwoStringsEqual(outcome.outcome, "invalid")`. Both are
correct against their own source — don't "fix" one to match the other.

### Runbook: deploying a new generation

```
# 1. Edit assets_pd.ts (the asset list; duplicates are de-duplicated on read).
# 2. Freeze the PD snapshot. Needs CREDORA_API in .env.
node campaigns/gnosis-pd/fetch-credora-pd.js

# 3. Create the market. DRY_RUN = true by default: prints outcomes, token names,
#    the encoded Reality question, the predicted address and the gas estimate.
node campaigns/gnosis-pd/create-pd-market-gnosis.js
#    Review, then flip DRY_RUN = false and re-run. NOT idempotent — a second live
#    run creates a second market. Writes create-pd-market-execution.json.

# 4. Seed liquidity. Reads the market address from that file.
node campaigns/gnosis-pd/add-pd-liquidity-gnosis-v2.js
#    Check the dry run's GRAND TOTAL and the "No To All: N% of total" line, then
#    flip DRY_RUN = false. ~70 transactions; resumable via its progress log.

# 5. Point the UI at the new address: RISK_PRICING_MARKET_ID in
#    risk-pricing-ui/src/consts/markets.ts. That is the only required edit.
```

Both live steps are slow enough (~10 min each) that an RPC timeout mid-run is
likely; both are resumable, so just re-run.

## The market (v1, 24 assets — drained 2026-08-12)

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

Validated end-to-end for both generations: `Σ price_i + priceY = 1.0000000000`
exactly. v1 (24 assets): `No To All ≈ 0.9654`, asset prices `0.00009`–`0.006`.
v2 (33 assets): `No To All ≈ 0.8152`, asset prices `0.000084`–`0.0416` — the
model is unchanged, but adding assets with double-digit yearly PD moves `priceY`
a long way and widens the price spread by ~7.5×.

**The inverse (quarterly PD → yearly PD)** is `1 - (1 - quarterlyPD) ^ 4` — used to
convert live pool-implied quarterly probabilities back to yearly for display.

## Liquidity scripts (this repo)

| Script | Role |
|---|---|
| `implied-prices.js` | forward-only port of `useImpliedProbs.ts`'s `computePrices` + `yearlyToQuarterly` helper. No React/Worker/inverse-solver — we already know the probabilities. |
| `add-pd-liquidity-gnosis.js` | **Round 1**: creates + initializes + mints all 25 real-outcome pools (24 assets + No To All) fresh. Budget 5 sDAI, **equal outcome-token quantity `Q`** across ALL 25 pools (octant-style sizing), Safe band (−20%/+40%) per outcome. |
| `add-pd-liquidity-gnosis-round2.js` | **Round 2**: tops up the 24 asset pools only (excludes No To All — see "lesson" below) with another 5 sDAI, equal `Q2` per asset pool, same tick ranges as round 1 (new NFT per pool, doesn't touch round 1's positions or move price). |
| `remove-liquidity-gnosis.js` | Removes 100% liquidity from every matched NPM position (auto-discovered via ERC721 enumeration, no tokenId tracking needed) and merges the recovered complete set back into sDAI. **Executed 2026-08-12** to fund the v2 market. |

### Deployment state

- Round 1: 25/25 positions minted, ~4.999996 sDAI spent.
- Round 2: 24/24 positions minted (No To All untouched), ~5.0 sDAI spent.
- **Drained 2026-08-12**: all 49 positions removed and their NFTs burned (0 left),
  then a complete set merged back to sDAI. Progress log
  `remove-pd-gnosis-execution.json` (49 entries).
- Progress logs (idempotent, resumable): `add-pd-gnosis-execution.json`,
  `add-pd-gnosis-round2-execution.json`, `remove-pd-gnosis-execution.json`.

### Removing after the market has traded: the merge is capped by the *smallest* holding

The dry run recorded when the remove script was first written projected a
perfectly balanced complete set with zero dust. Six weeks of trading broke that.
At removal time the recovered balances ranged from `bsdETH` **0.784** up to
`No To All` **7.58**, and `mergePositions` can only convert `min(balances)` —
so the merge returned **0.784 sDAI**, not ~5.6.

Actual recovery: `2.717` sDAI from the pool positions' sDAI sides + `0.784` from
the merge = wallet went `4.791 → 8.292` sDAI. The rest of the value is still there
but stranded as unmergeable outcome tokens (~6.8 units each of `No To All`,
`USDT`, `pufETH`, less of the others). With the pools emptied there is nothing to
sell them into, so that value is only realisable at resolution. **Budget for this
when planning a drain** — the recoverable cash is far below the deployed capital
once a market has traded.

### Bug fixed on first live run of `remove-liquidity-gnosis.js`

`Position.burnAmountsWithSlippage()` returns raw JSBI amounts, exactly like
`mintAmountsWithSlippage()` — **not** `CurrencyAmount`. The script called
`.quotient.toString()` on them and threw `Cannot read properties of undefined`.
Because it threw while building calldata, no transaction was sent. Fixed to
`.toString()`.

Also: expect the run to hit an RPC timeout somewhere in the ~76 transactions. It
is resumable — re-running skips removals via the progress log, `ensureAllowance`
is idempotent, and the merge is balance-driven.

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
  `X` sDAI (not `X × numOutcomes`) — standard conditional-tokens behavior. It is
  why the budget formula adds `Q` once rather than `Q × nPools`.
  ⚠️ The corollary once held that pulling all liquidity back out would recover a
  perfectly balanced complete set with zero dust (every wrapped token at
  `0.713716 + 4.884318 ≈ 5.598034`). **That only holds while nobody trades.** It
  was true of the dry run taken right after deployment and false by the time the
  market was actually drained — see "Removing after the market has traded" above.
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

### How to run the remove script

Already run against v1. To reuse it for another market, point `MARKET` at that
address first and start from a fresh `PROGRESS_FILE`.

```
# 1. Dry run (default DRY_RUN = true) — enumerates all NPM positions for this
#    market, projects removal amounts + the final merge amount, no transactions.
node campaigns/gnosis-pd/remove-liquidity-gnosis.js

# 2. Review: "Matched N positions... M have liquidity > 0", the min-outcome-balance
#    merge preview, and "outcomes at zero: 0" (should be 0 for a full merge).
#    The merge preview is the cash you actually get back — on a market that has
#    traded it will be far below what was deployed.

# 3. Live run — flip DRY_RUN = false at the top of the file, then re-run.
#    BURN_NFT = true by default (cleans up emptied position NFTs in the same tx).
```

Expect ~75 transactions (49 removes + up to 26 approvals + 1 merge) — each costs
xDAI gas. Resumable via `remove-pd-gnosis-execution.json` (Phase 1 only; Phase 2
merge is balance-driven and naturally re-runnable). The v1 run took two passes: an
RPC timeout during the approval loop, then a clean resume.

## `risk-pricing-ui` (sibling repo, `D:\Code\risk-pricing-ui`)

This Next.js app displays/trades the market above. It already targeted Gnosis chain
entirely (wagmi/viem `gnosis`, chain id 100) — only the market id needed updating,
plus wiring up the yearly↔quarterly conversion the pools actually need.

### Changes made

| File | Change |
|---|---|
| `src/consts/markets.ts` | `RISK_PRICING_MARKET_ID` → the market address (single source of truth; chain id and all derived URLs already followed from this one constant). **Now `0xc84786B06390F11dED0DD362E27Fc881B540e6F2` (v2).** |
| `src/hooks/useImpliedProbs.ts` | Added `yearlyToQuarterly` / `quarterlyToYearly` helpers (same formulas as `implied-prices.js` above). |
| `src/hooks/useMarketData.ts` | **Reverse path (pool → UI)**: the solver's `state.probs`/`priceY` are quarterly (pools trade on quarterly-implied prices). Now converts each to yearly via `quarterlyToYearly`, then recomputes "No To All" by re-running `computePrices` on the yearly-converted values, so the displayed figure stays self-consistent rather than being a raw quarterly leftover. |
| `src/hooks/predict/usePredictRiskFlow.ts` | **Forward path (UI → trade)**: `predictedProbs` (user's slider input / `outcome.probability` fallback) is yearly PD end-to-end; converted via `yearlyToQuarterly` immediately before `computePrices` so the actual trade target prices are computed correctly in quarterly terms. |

Net effect: sliders and every displayed number are yearly PD throughout the UI
(matching the units of the source PD data — Credora's `psl` — and what a user
intuitively predicts), while the pools — seeded using quarterly-derived prices —
are traded against correctly under the hood. Verified with a full `tsc --noEmit` project typecheck (exit 0, zero
errors) after the edits.

`RiskAssetDetailsMapping` (the old hardcoded risk-profile lookup) has since been
deleted — risk profiles now come live from `/api/credora`, keyed by lowercased
outcome name, with a "No risk data available for this asset" fallback in
`src/app/(homepage)/components/RiskPricing/Details.tsx`.

### Pointing the UI at v2

Genuinely a one-constant change — `RISK_PRICING_MARKET_ID`. Nothing per-asset is
hardcoded on the risk path: colours are assigned by regex *category*
(`/eth/i`, `/usd/i`, `/btc/i`, else "Funds Based") in
`RiskPricing/constants.ts`, `SUBSCRIBED_MARKET_ID` derives from the same
constant, and outcome names/symbols come from the market payload. `tsc --noEmit`
passes.

Things that are structural rather than per-asset, and stay valid only because
v2 keeps the same outcome tail `[…, "No To All", "Invalid result"]` — check these
if that ever changes: the `slice(0, -2)` / `at(-2)` sites in
`(homepage)/page.tsx:95,104-112,138`, `useMarketData.ts:132-134`,
`useAssetColorMap.ts:28`, `useRiskPdHistory.ts:53-55`, and the `slice(0, -1)`
sites in `usePredictRiskFlow.ts`, `AdvancedSection.tsx`, `PredictionsCsvButton.tsx`.

`startTime` / `endTime` / `marketMetadata.question` / `QuarterTabs` were **not**
touched — v2 covers the same Q3 2026 period as v1.

Two things to watch at 33 assets rather than 24 (not pre-optimised — measure first):

- the implied-probability solver is ~O(n⁴) overall, so each solve costs ~3.6× more,
  and `useRiskPdHistory` runs one per 4h grid point;
- `useTradeExecutorPredictRiskOutcomes.ts` packs *every* outcome's approve + swap +
  merge into a single `batchValueExecute` with no chunking (`MAX_MARKETS_PER_BATCH`
  is only used by the legacy movies flow). 34 outcomes in one Gnosis transaction is
  the most likely thing to hit a gas ceiling.

**The UI does not read the chain directly.** Market and chart data come from Seer's
own backend (`app.seer.pm/.netlify/functions/get-market` and `market-chart`,
proxied through `src/app/api/seer/[fn]` and `src/app/api/risk-market-chart`). A
freshly created market returns `[]` from `market-chart` until Seer indexes its
pools — that is a lag, not a bug.

## Files (this repo)

| File | Purpose |
|---|---|
| `implied-prices.js` | pricing math (yearlyToQuarterly + computePrices) — shared by both generations |
| `abis/MarketViewAbi.js`, `abis/RouterAbi.js` | reused Seer ABIs (same shape across chains) |
| **v2** | |
| `assets_pd.ts` | hand-maintained asset list (names only; `solvBTC` listed twice, de-duplicated on read) |
| `fetch-credora-pd.js` | pulls Credora `Metrics.psl` → freezes `assets_pd_v2.csv` + `assets_pd_v2.json` |
| `create-pd-market-gnosis.js` | creates the market via `MarketFactory.createMultiCategoricalMarket` → `create-pd-market-execution.json` |
| `add-pd-liquidity-gnosis-v2.js` | initial liquidity, 34 pools, decoupled No-To-All sizing → `add-pd-gnosis-v2-execution.json` |
| **v1 (historical)** | |
| `assets_pd.csv` | yearly PD per asset (static snapshot, superseded by Credora) |
| `add-pd-liquidity-gnosis.js` | round-1 initial liquidity (fresh pool creation) |
| `add-pd-liquidity-gnosis-round2.js` | round-2 top-up (24 asset pools only) |
| `remove-liquidity-gnosis.js` | remove all liquidity + merge to sDAI (run 2026-08-12; still points at the v1 `MARKET` constant) |
| `add-pd-gnosis-execution.json` | round-1 progress log (tokenId not recorded — only tx hashes; positions discovered by enumeration when removing) |
| `add-pd-gnosis-round2-execution.json` | round-2 progress log |
| `remove-pd-gnosis-execution.json` | removal progress log (49 entries) |

To drain the v2 market later, copy `remove-liquidity-gnosis.js` and point `MARKET`
at the v2 address — position discovery is by ERC721 enumeration, so no tokenId
bookkeeping is needed.
