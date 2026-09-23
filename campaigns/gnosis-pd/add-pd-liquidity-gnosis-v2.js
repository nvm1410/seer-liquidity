// Seed the Gnosis PD market's Swapr pools: one per asset, plus "No To All".
// "Invalid result" gets no pool, same as v1.
//
// Swapr is Algebra V1, so the Uniswap SDK's calldata builders are unusable —
// only its Pool/Position math is reused and every call is hand-encoded through
// multicall. See lib/algebra.js. mathFeeTier 3000 exists solely to make the v3
// SDK derive tickSpacing 60; it is never sent on chain.
//
// TWO THINGS ARE DIFFERENT FROM EVERY OTHER SEEDER HERE:
//
//   Band. Not global. Each outcome gets a "Safe" band around its OWN centre
//   price: -20% / +40%, clamped to (0, 1).
//
//   Sizing. Mixed. The 33 asset pools use an equal outcome quantity Q, but
//   "No To All" is sized BY COLLATERAL at a fixed 0.5 sDAI. Its price is ~0.82,
//   so equal-Q sizing put 85% of v1's whole budget (4.27 of 5 sDAI) into that
//   one pool. A solved multiplier sits on top, taking the tighter of two
//   regimes because splitPosition mints every outcome and is driven by whichever
//   pool wants the most tokens.
//
//   node add-pd-liquidity-gnosis-v2.js          # dry: sizes everything, prints the table
//   node add-pd-liquidity-gnosis-v2.js --live   # sends, after a confirmation

import { ethers } from "ethers";
import fs from "fs";
import { erc20Abi, formatUnits } from "viem";
import { RouterAbi } from "../../abis/RouterAbi.js";
import { computePrices, yearlyToQuarterly } from "../../lib/implied-prices.js";
import { ALGEBRA_NPM_ABI, buildMintCalldata } from "../../lib/algebra.js";
import { getMarketInfo, makeMarketView, normalizeName } from "../../lib/market.js";
import { run } from "../../lib/run.js";
import { ensureAllowance, retryTransaction, sleep } from "../../lib/tx.js";
import { buildPoolAndBounds, sizePosition, sizePositionByCollateral } from "../../lib/uniswap.js";

// "Safe" preset band around each outcome's own centre price (frontend
// web/src/lib/liquidity.ts PRESETS.Safe).
const SAFE_DOWN = 0.2;
const SAFE_UP = 0.4;
// Fixed sDAI allocation for the No To All pool, decoupled from equal-Q sizing.
const NO_TO_ALL_SDAI = 5n * 10n ** 17n; // 0.5 sDAI
const Q0 = 10n ** 17n; // trial outcome quantity, 0.1 token
const DELAY_MS = 2000;

function parsePdCsv(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  lines.shift(); // header
  const map = new Map();
  for (const line of lines) {
    // Asset names can contain commas, so split on the LAST one.
    const idx = line.lastIndexOf(",");
    const name = line.slice(0, idx);
    const yearlyPD = Number(line.slice(idx + 1));
    if (!Number.isFinite(yearlyPD)) throw new Error(`Bad CSV row: ${line}`);
    map.set(normalizeName(name), { name, yearlyPD });
  }
  return map;
}

/** The Safe band for one outcome, clamped to a probability. */
const safeBand = (centerPrice) => ({
  minPrice: Math.max(1e-9, centerPrice * (1 - SAFE_DOWN)),
  maxPrice: Math.min(0.999999, centerPrice * (1 + SAFE_UP)),
});

await run(
  { name: "add-pd-liquidity-gnosis-v2", slug: "gnosis-pd", stage: "phase1-seed", mutating: true },
  async (ctx) => {
    const { manifest, provider, wallet, chainId, addr, amm, log, progress, dry, spend } = ctx;
    const collateral = manifest.chain.collateral.address;
    const market = manifest.results.parent;
    const budget = ethers.parseUnits(String(manifest.liquidity.totalCollateral), manifest.chain.collateral.decimals);

    log.log(`\n📋 Wallet      : ${wallet.address}`);
    log.log(`📋 Market      : ${market}`);
    log.log(`📋 Budget      : ${formatUnits(budget, 18)} sDAI (No To All capped at ${formatUnits(NO_TO_ALL_SDAI, 18)})`);
    log.log(`📋 Band        : Safe (-${SAFE_DOWN * 100}% / +${SAFE_UP * 100}%) per outcome\n`);

    // ── Phase 0: resolve market & prices ──────────────────────────────────────
    log.log("🔍 Phase 0: resolving market & prices...");
    const marketView = makeMarketView(addr.marketView, provider);
    const info = await getMarketInfo(marketView, addr.marketFactory, market);
    if (info.isConditional) throw new Error("Market is conditional — expected a top-level market.");
    if (info.collateralToken.toLowerCase() !== collateral.toLowerCase()) {
      throw new Error(`Market collateral ${info.collateralToken} != sDAI.`);
    }
    log.log(`   Market "${info.name}" | ${info.outcomes.length} outcomes | templateId=${info.templateId}`);

    // The outcome ORDER is load-bearing: assets, then No To All, then Invalid.
    const last = info.outcomes[info.outcomes.length - 1];
    const secondLast = info.outcomes[info.outcomes.length - 2];
    if (normalizeName(last) !== "invalid result") {
      throw new Error(`Expected last outcome to be "Invalid result", got "${last}".`);
    }
    if (normalizeName(secondLast) !== "no to all") {
      throw new Error(`Expected second-to-last outcome to be "No To All", got "${secondLast}".`);
    }
    const assetNames = info.outcomes.slice(0, -2);
    const assetTokens = info.wrappedTokens.slice(0, -2);
    const noToAllToken = info.wrappedTokens[info.wrappedTokens.length - 2];

    const pdMap = parsePdCsv(manifest.files.seed);
    log.log(`   CSV: ${pdMap.size} rows`);
    if (pdMap.size !== assetNames.length) {
      throw new Error(`CSV has ${pdMap.size} rows but the market has ${assetNames.length} asset outcomes.`);
    }

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

    const assetPools = assetTokens.map((outcomeToken, i) => ({
      name: assetNames[i],
      outcomeToken,
      price: prices[i],
      isNoToAll: false,
    }));
    const noToAllPool = { name: "No To All", outcomeToken: noToAllToken, price: priceY, isNoToAll: true };
    const pools = [...assetPools, noToAllPool];

    for (const p of pools) {
      const code = await provider.getCode(p.outcomeToken);
      if (!code || code === "0x") throw new Error(`Outcome token ${p.outcomeToken} (${p.name}) has no code — not deployed.`);
    }
    log.log("   ✅ all outcome tokens deployed on-chain");

    // ── Phase 1: size positions & solve for Q ─────────────────────────────────
    log.log("\n📐 Phase 1: sizing positions...");
    for (const p of pools) {
      p.meta = buildPoolAndBounds({
        outcomeToken: p.outcomeToken,
        collateral,
        price: p.price,
        live: null, // first-seed script; see the header
        chainId,
        feeTier: amm.mathFeeTier, // SDK math only — Algebra has no fee tiers
        tickSpacing: amm.tickSpacing,
        band: safeBand(p.price), // PER OUTCOME
      });
    }

    // No To All is sized first and independently — its cost is fixed, so the
    // asset pools get whatever the budget has left.
    const noToAllSized = sizePositionByCollateral(noToAllPool.meta, NO_TO_ALL_SDAI);
    log.log(
      `   No To All: ${formatUnits(noToAllSized.collateralUsed, 18)} sDAI ⇒ ` +
        `${formatUnits(noToAllSized.outcomeUsed, 18)} outcome tokens (price ${priceY.toFixed(6)})`
    );

    let trialSdaiAssets = 0n;
    for (const p of assetPools) trialSdaiAssets += sizePosition(p.meta, Q0).collateralUsed;

    // The split mints `splitAmount` of EVERY outcome for exactly `splitAmount`
    // sDAI, so it is driven by whichever pool wants the most outcome tokens —
    // either an asset pool (at Q) or No To All (fixed). Solve under both regimes
    // and take the tighter, so the grand total respects the budget either way.
    //   regime A (split = Q):       f*(Q0 + trialSdaiAssets) + NO_TO_ALL_SDAI       <= BUDGET
    //   regime B (split = noToAll): f*trialSdaiAssets + NO_TO_ALL_SDAI + noToAllQty <= BUDGET
    const assetBudget = budget - NO_TO_ALL_SDAI;
    if (assetBudget <= 0n) throw new Error("NO_TO_ALL_SDAI is >= the whole budget.");
    const qRegimeA = (Q0 * assetBudget) / (Q0 + trialSdaiAssets);
    const remainderB = assetBudget - noToAllSized.outcomeUsed;
    const qRegimeB = remainderB > 0n ? (Q0 * remainderB) / trialSdaiAssets : 0n;
    const Q = qRegimeA < qRegimeB ? qRegimeA : qRegimeB;
    if (Q <= 0n) throw new Error("No budget left for the asset pools — lower NO_TO_ALL_SDAI.");
    log.log(
      `   Trial Q0=${formatUnits(Q0, 18)} → ΣsDAI(assets)=${formatUnits(trialSdaiAssets, 18)} ⇒ ` +
        `Q=${formatUnits(Q, 18)} (regime A ${formatUnits(qRegimeA, 18)}, B ${formatUnits(qRegimeB, 18)})`
    );

    let sumSdai = 0n;
    let maxOutcome = 0n;
    log.log("\n   outcome                          price       ticks              outcome        sDAI");
    for (const p of pools) {
      const s = p.isNoToAll ? noToAllSized : sizePosition(p.meta, Q);
      Object.assign(p, {
        position: s.position,
        outcomeUsed: s.outcomeUsed,
        sdaiUsed: s.collateralUsed,
        amount0: s.amount0,
        amount1: s.amount1,
      });
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
    const noToAllShare = (Number(noToAllSized.collateralUsed) / Number(grandTotal)) * 100;
    log.log(
      `\n   Split (mint) : ${formatUnits(splitAmount, 18)} sDAI\n` +
        `   sDAI side    : ${formatUnits(sumSdai, 18)} sDAI\n` +
        `   GRAND TOTAL  : ${formatUnits(grandTotal, 18)} sDAI (budget ${formatUnits(budget, 18)})\n` +
        `   No To All    : ${noToAllShare.toFixed(1)}% of total (v1's equal-Q sizing was 85%)`
    );
    if (grandTotal > budget) log.warn("   ⚠️  grand total exceeds budget — check rounding/sentinel.");

    if (dry) return { pools: pools.length, grandTotal: grandTotal.toString() };

    spend.charge(Number(formatUnits(grandTotal, 18)));

    const sdai = new ethers.Contract(collateral, erc20Abi, provider);
    const sdaiBalance = await sdai.balanceOf(wallet.address);
    log.log(`\n💰 sDAI balance: ${formatUnits(sdaiBalance, 18)} | need: ${formatUnits(grandTotal, 18)}`);
    if (sdaiBalance < grandTotal) throw new Error("Insufficient sDAI balance — aborting.");

    const router = new ethers.Contract(addr.router, RouterAbi, wallet);
    const ct = await router.conditionalTokens();
    if (!ct || ct === ethers.ZeroAddress) throw new Error("Router.conditionalTokens() is zero — wrong Router?");
    log.log(`   Router.conditionalTokens() = ${ct}`);

    // ── Phase 2a: one split for the whole market ──────────────────────────────
    if (progress.has("split", market.toLowerCase())) {
      log.log("\n⏭  Split already logged — skipping.");
    } else {
      log.log(`\n💧 Phase 2a: split ${formatUnits(splitAmount, 18)} sDAI on market`);
      await ensureAllowance(collateral, addr.router, splitAmount, { wallet, log });
      const receipt = await retryTransaction(() => router.splitPosition(collateral, market, splitAmount), { log });
      progress.append({
        kind: "split",
        key: market.toLowerCase(),
        market,
        amount: splitAmount.toString(),
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      });
      await sleep(DELAY_MS);
    }

    // sDAI is one side of every pool — approve the NPM once for the whole run.
    await ensureAllowance(collateral, addr.positionManager, sumSdai, { wallet, log });

    // ── Phase 2b: mint each position ──────────────────────────────────────────
    log.log(`\n📈 Phase 2b: minting ${pools.length} positions\n`);
    let successCount = 0;

    for (const p of pools) {
      const key = p.outcomeToken.toLowerCase();
      if (progress.has("pool", key)) {
        log.log(`  ⏭  ${p.name}: already in progress log — skipping`);
        successCount++;
        continue;
      }
      log.log(`\n--- ${p.name} (${p.outcomeToken}) ---`);
      try {
        const outcomeAmount = p.meta.isToken0Outcome ? p.amount0 : p.amount1;
        await ensureAllowance(p.outcomeToken, addr.positionManager, outcomeAmount, { wallet, log });

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
          key,
          name: p.name,
          outcomeToken: p.outcomeToken,
          price: p.price,
          tickLower: p.meta.tickLower,
          tickUpper: p.meta.tickUpper,
          amount0: p.amount0.toString(),
          amount1: p.amount1.toString(),
          outcomeUsed: p.outcomeUsed.toString(),
          sdaiUsed: p.sdaiUsed.toString(),
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
        });
        successCount++;
        log.log(`  ✅ Saved to ${progress.path}`);
      } catch (err) {
        log.error(`  ❌ ${p.name} failed: ${err.shortMessage || err.message}`);
      }
      await sleep(DELAY_MS);
    }

    log.log(`\n🎉 Done! ${successCount}/${pools.length} positions minted. See ${progress.path}.`);
    return { minted: successCount };
  }
);
