// Initial liquidity for a multi-categorical Seer market on Gnosis, using Swapr (Algebra
// V1 concentrated-liquidity pools) instead of Uniswap V3.
//
// Market: "What is the Probability of Default (PD) for the following DeFi assets before
// 2027?" — 24 asset outcomes + "No To All" + "Invalid result".
//
// Initial prices are derived from assets_pd.csv (yearly PD per asset):
//   1. yearly PD -> quarterly PD, assuming a constant quarterly hazard rate:
//        qPD = 1 - (1 - yearlyPD) ^ (1/4)
//   2. quarterly PDs -> initial pool prices via the multi-categorical pricing model in
//      useImpliedProbs.ts (ported forward-only in implied-prices.js):
//        priceY  = prod(1 - qPD_i)              -> "No To All"
//        price_i = qPD_i * E[1 / (1 + k)]       -> each asset outcome
//      (k = number of *other* outcomes that also default, since defaults share a fixed
//      payout pool).
//
// Mirrors the structure of add-octant-liquidity.js, adapted for:
//   - Gnosis chain id (100) / sDAI collateral / Seer GnosisRouter
//   - Swapr's Algebra NonfungiblePositionManager (different ABI, tickSpacing 60, no fee
//     tier baked into pool identity — createAndInitializePoolIfNecessary + mint are
//     hand-encoded and sent together via multicall)
//   - A per-outcome "Safe" price band (-20% / +40%) around its own center price, instead
//     of one fixed band for every pool
//
//   node add-pd-liquidity-gnosis.js --resume          # dry: the 25-pool sizing table
//   node add-pd-liquidity-gnosis.js --resume --live   # seeds, after a confirmation
//
// THIS IS THE SUPERSEDED v1. Its sizing defect is visible in its own dry-run output:
// one equal outcome quantity Q across all 25 pools means a near-1 outcome consumes
// collateral in proportion to its price, so "No To All" at 0.9654 takes 4.269 of the 5
// sDAI. add-pd-liquidity-gnosis-round2.js worked around it by excluding that pool;
// add-pd-liquidity-gnosis-v2.js fixed it with sizePositionByCollateral. The v1 market
// was drained on 2026-08-12 to fund v2 — see lifecycle/gnosis-pd-v1.json.

import { ethers } from "ethers";
import fs from "fs";
import { erc20Abi, formatUnits } from "viem";
import { RouterAbi } from "./abis/RouterAbi.js";
import { computePrices, yearlyToQuarterly } from "./implied-prices.js";
import { buildMintCalldata } from "./lib/algebra.js";
import { getMarketInfo, makeMarketView, normalizeName } from "./lib/market.js";
import { run } from "./lib/run.js";
import { ensureAllowance, retryTransaction, sleep } from "./lib/tx.js";
import { buildPoolAndBounds, sizePosition } from "./lib/uniswap.js";

// Trial outcome-token quantity per pool used to size the (linear) budget.
const Q0 = 10n ** 17n; // 0.1 outcome token

// Parse assets_pd.csv (Asset,PD) -> Map<normalizedName, { name, yearlyPD }>.
function parsePdCsv(path) {
  const lines = fs
    .readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  lines.shift(); // drop header
  const map = new Map();
  for (const line of lines) {
    const idx = line.lastIndexOf(",");
    const name = line.slice(0, idx);
    const yearlyPD = Number(line.slice(idx + 1));
    if (!Number.isFinite(yearlyPD)) throw new Error(`Bad CSV row: ${line}`);
    map.set(normalizeName(name), { name, yearlyPD });
  }
  return map;
}

await run(
  {
    name: "add-pd-liquidity-gnosis",
    slug: "gnosis-pd-v1",
    stage: "seed-pools",
    mutating: true,
    requires: ["GNOSIS_RPC_URL", "PRIVATE_KEY"],
    progress: (m) => m.files.liquidity,
  },
  async (ctx) => {
    const { manifest, provider, wallet, chainId, addr, log, progress, dry: DRY_RUN } = ctx;

    const MARKET = manifest.results.parent;
    const CSV_FILE = manifest.files.seed;
    const COLLATERAL = manifest.chain.collateral.address;
    // Swapr's Algebra pools have a single dynamic fee (no fee tiers) and a fixed
    // tickSpacing of 60. @uniswap/v3-sdk needs *some* fee to derive a tickSpacing for
    // its tick-alignment math; 3000 maps to tickSpacing 60, which matches Algebra
    // exactly. This fee is never sent on chain.
    const MATH_FEE_TIER = manifest.amm.mathFeeTier;
    const TICK_SPACING = manifest.amm.tickSpacing;
    // Total capital to deploy: the single split (mint of every outcome token) plus the
    // sDAI side of every pool must sum to this.
    const TOTAL_BUDGET = BigInt(manifest.liquidity.totalCollateral) * 10n ** 18n;
    // "Safe" preset band around each outcome's own center price.
    const { safeDown: SAFE_DOWN, safeUp: SAFE_UP } = manifest.liquidity.bandPerOutcome;

    log.log(`\n📋 Wallet      : ${wallet.address}`);
    log.log(`📋 DRY_RUN     : ${DRY_RUN}`);
    log.log(`📋 Budget      : ${formatUnits(TOTAL_BUDGET, 18)} sDAI`);
    log.log(`📋 Band        : Safe (-${SAFE_DOWN * 100}% / +${SAFE_UP * 100}%) per outcome\n`);

    const marketView = makeMarketView(addr.marketView, provider);
    const getTokenBalance = (token) => new ethers.Contract(token, erc20Abi, provider).balanceOf(wallet.address);

    // The per-outcome band, in sDAI-per-outcome (probability) terms, clamped to (0,1).
    const bandFor = (centerPrice) => ({
      minPrice: Math.max(1e-9, centerPrice * (1 - SAFE_DOWN)),
      maxPrice: Math.min(0.999999, centerPrice * (1 + SAFE_UP)),
    });

    // ── Phase 0: resolve market + prices ────────────────────────────────────────
    log.log("🔍 Phase 0: resolving market & prices...");
    const info = await getMarketInfo(marketView, addr.marketFactory, MARKET);

    if (info.isConditional) throw new Error("Market is conditional — expected a top-level market.");
    if (info.collateralToken.toLowerCase() !== COLLATERAL.toLowerCase()) {
      throw new Error(`Collateral ${info.collateralToken} ≠ sDAI ${COLLATERAL}.`);
    }
    log.log(`   Market "${info.name}" | ${info.outcomes.length} outcomes | templateId=${info.templateId}`);

    const last = info.outcomes[info.outcomes.length - 1];
    const secondLast = info.outcomes[info.outcomes.length - 2];
    if (normalizeName(last) !== "invalid result") {
      throw new Error(`Expected last outcome to be "Invalid result", got "${last}".`);
    }
    if (normalizeName(secondLast) !== "no to all") {
      throw new Error(`Expected second-to-last outcome to be "No To All", got "${secondLast}".`);
    }

    // Asset outcomes are everything except "No To All" and "Invalid result".
    const assetNames = info.outcomes.slice(0, -2);
    const assetTokens = info.wrappedTokens.slice(0, -2);
    const noToAllToken = info.wrappedTokens[info.wrappedTokens.length - 2];

    const pdMap = parsePdCsv(CSV_FILE);
    log.log(`   CSV: ${pdMap.size} rows`);
    if (pdMap.size !== assetNames.length) {
      throw new Error(`CSV rows (${pdMap.size}) ≠ market asset outcomes (${assetNames.length}).`);
    }

    // Match each on-chain asset outcome to a CSV row by normalized name, in ON-CHAIN
    // order (the probability array must line up index-for-index with assetTokens so
    // prices map back to the right outcome).
    const unmatched = [];
    const quarterlyPDs = [];
    for (const name of assetNames) {
      const row = pdMap.get(normalizeName(name));
      if (!row) {
        unmatched.push(name);
        continue;
      }
      quarterlyPDs.push(yearlyToQuarterly(row.yearlyPD));
    }
    if (unmatched.length) {
      log.error("\n❌ Unmatched on-chain outcomes (fix CSV names):");
      unmatched.forEach((n) => log.error(`   - "${n}"`));
      throw new Error(`${unmatched.length} outcomes unmatched.`);
    }

    const { priceY, prices } = computePrices(quarterlyPDs);
    const priceSum = prices.reduce((a, b) => a + b, 0) + priceY;
    log.log(`   priceY ("No To All") = ${priceY.toFixed(6)} | Σ all prices = ${priceSum.toFixed(8)}`);

    const pools = assetTokens.map((outcomeToken, i) => ({ name: assetNames[i], outcomeToken, price: prices[i] }));
    pools.push({ name: "No To All", outcomeToken: noToAllToken, price: priceY });

    // ── Phase 0b: verify wrapped outcome ERC20s are deployed ────────────────────
    for (const p of pools) {
      const code = await provider.getCode(p.outcomeToken);
      if (!code || code === "0x") {
        throw new Error(`Outcome token ${p.outcomeToken} (${p.name}) has no code — not deployed.`);
      }
    }
    log.log("   ✅ all outcome tokens deployed on-chain");

    // ── Phase 1: size positions & solve for Q ───────────────────────────────────
    log.log("\n📐 Phase 1: sizing positions...");
    let trialSdai = 0n;
    for (const p of pools) {
      p.meta = buildPoolAndBounds({
        outcomeToken: p.outcomeToken,
        collateral: COLLATERAL,
        price: p.price,
        live: null, // v1 always prices from the model; see the v2 script for the re-seed case
        chainId,
        feeTier: MATH_FEE_TIER,
        tickSpacing: TICK_SPACING,
        band: bandFor(p.price),
      });
      trialSdai += sizePosition(p.meta, Q0).collateralUsed;
    }
    const totalTrial = Q0 + trialSdai; // mint (=Q0) + sDAI side
    const Q = (Q0 * TOTAL_BUDGET) / totalTrial;
    log.log(
      `   Trial Q0=${formatUnits(Q0, 18)} → ΣsDAI=${formatUnits(trialSdai, 18)}, ` +
        `total=${formatUnits(totalTrial, 18)} ⇒ Q=${formatUnits(Q, 18)}`
    );

    let sumSdai = 0n;
    let maxOutcome = 0n;
    log.log("\n   outcome                          price       ticks              outcome        sDAI");
    for (const p of pools) {
      const s = sizePosition(p.meta, Q);
      p.position = s.position;
      p.outcomeUsed = s.outcomeUsed;
      p.sdaiUsed = s.collateralUsed;
      p.amount0 = s.amount0;
      p.amount1 = s.amount1;
      sumSdai += s.collateralUsed;
      if (s.outcomeUsed > maxOutcome) maxOutcome = s.outcomeUsed;
      log.log(
        `   ${p.name.slice(0, 30).padEnd(30)} ${p.price.toFixed(6).padStart(9)}  ` +
          `[${p.meta.tickLower},${p.meta.tickUpper}]`.padEnd(18) +
          `  ${Number(formatUnits(s.outcomeUsed, 18)).toFixed(6).padStart(12)}` +
          `  ${Number(formatUnits(s.collateralUsed, 18)).toFixed(6).padStart(10)}`
      );
    }
    const splitAmount = maxOutcome > Q ? maxOutcome : Q;
    const grandTotal = splitAmount + sumSdai;
    log.log(
      `\n   Split (mint) : ${formatUnits(splitAmount, 18)} sDAI\n` +
        `   sDAI side    : ${formatUnits(sumSdai, 18)} sDAI\n` +
        `   GRAND TOTAL  : ${formatUnits(grandTotal, 18)} sDAI (budget ${formatUnits(TOTAL_BUDGET, 18)})`
    );
    if (grandTotal > TOTAL_BUDGET) log.warn("   ⚠️  grand total exceeds budget — check rounding/sentinel.");

    if (DRY_RUN) {
      return { pools: pools.length, Q: Q.toString(), grandTotal: grandTotal.toString() };
    }

    // ── Phase 2a: balance guard + split sDAI once ───────────────────────────────
    const sdaiBalance = await getTokenBalance(COLLATERAL);
    log.log(`\n💰 sDAI balance: ${formatUnits(sdaiBalance, 18)} | need: ${formatUnits(grandTotal, 18)}`);
    if (sdaiBalance < grandTotal) throw new Error("Insufficient sDAI balance — aborting.");

    const router = new ethers.Contract(addr.router, RouterAbi, wallet);
    const ct = await router.conditionalTokens();
    if (!ct || ct === ethers.ZeroAddress) throw new Error("Router.conditionalTokens() is zero — wrong Router?");
    log.log(`   Router.conditionalTokens() = ${ct}`);

    // The historical entries carry outcomeToken with no kind/key, so key off that.
    const alreadyDone = new Set(progress.entries.map((e) => e.outcomeToken.toLowerCase()));

    const needSplit = !alreadyDone.size; // fresh run → split; resume → assume done
    if (!needSplit) log.log("\n⏭  Progress log present — assuming split already done.");
    if (needSplit) {
      log.log(`\n💧 Phase 2a: split ${formatUnits(splitAmount, 18)} sDAI on market`);
      await ensureAllowance(COLLATERAL, addr.router, splitAmount, { wallet, log });
      await retryTransaction(() => router.splitPosition(COLLATERAL, MARKET, splitAmount), { log });
      await sleep(3000);
    }

    // sDAI is a token in every pool — approve the full sDAI side once.
    await ensureAllowance(COLLATERAL, addr.positionManager, sumSdai, { wallet, log });

    // ── Phase 2b: create + initialize + mint each pool ──────────────────────────
    log.log(`\n📈 Phase 2b: minting ${pools.length} positions\n`);
    let successCount = 0;
    for (const p of pools) {
      if (alreadyDone.has(p.outcomeToken.toLowerCase())) {
        log.log(`  ⏭  ${p.name}: already in progress log — skipping`);
        successCount++;
        continue;
      }

      log.log(`\n--- ${p.name} (${p.outcomeToken}) ---`);
      const outcomeAmount = p.meta.isToken0Outcome ? p.amount0 : p.amount1;
      await ensureAllowance(p.outcomeToken, addr.positionManager, outcomeAmount, { wallet, log });

      try {
        const data = buildMintCalldata({
          meta: { ...p.meta, position: p.position, sqrtPriceX96: p.meta.pool.sqrtRatioX96 },
          amount0: p.amount0,
          amount1: p.amount1,
          recipient: wallet.address,
        });
        const receipt = await retryTransaction(
          () => wallet.sendTransaction({ to: addr.positionManager, data, value: 0n }),
          { log }
        );

        progress.append({
          kind: "pool",
          key: p.outcomeToken.toLowerCase(),
          name: p.name,
          outcomeToken: p.outcomeToken,
          price: p.price,
          tickLower: p.meta.tickLower,
          tickUpper: p.meta.tickUpper,
          amount0: p.amount0.toString(),
          amount1: p.amount1.toString(),
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
        });
        successCount++;
        log.log(`  ✅ Saved to ${progress.path}`);
      } catch (err) {
        log.error(`  ❌ Failed for ${p.name}: ${err.shortMessage || err.message}`);
      }
      await sleep(2000);
    }

    log.log(`\n🎉 Done! ${successCount}/${pools.length} positions minted. See ${progress.path}.`);
    return { minted: successCount, pools: pools.length };
  }
);
