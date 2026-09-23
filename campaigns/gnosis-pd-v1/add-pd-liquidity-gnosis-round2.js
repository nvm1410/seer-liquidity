// Round 2 top-up for the Gnosis PD v1 market pools created by add-pd-liquidity-gnosis.js.
//
// "No To All" already holds plenty of sDAI relative to its need — round 1 gave it 4.269
// of the 5 sDAI budget — so this round skips it entirely and puts the full remaining
// 5 sDAI into the 24 asset pools instead, deepening each by an equal outcome-token
// quantity. That is a WORKAROUND for round 1's sizing defect, not a fix; v2 fixed it by
// sizing a near-1 outcome by collateral. See lifecycle/gnosis-pd-v1.json.
//
// Adds a SECOND position per pool at the SAME tick range as round 1, reusing the
// addresses and prices recorded in round 1's execution log rather than recomputing them.
// This does NOT change the pool's current price — price only moves on swaps, and no
// swaps had occurred since round 1's mint.
//
//   node add-pd-liquidity-gnosis-round2.js --resume          # dry: the 24-pool table
//   node add-pd-liquidity-gnosis-round2.js --resume --live   # seeds, after a confirmation

import { ethers } from "ethers";
import fs from "fs";
import { erc20Abi, formatUnits } from "viem";
import { RouterAbi } from "../../abis/RouterAbi.js";
import { buildMintCalldata } from "../../lib/algebra.js";
import { run } from "../../lib/run.js";
import { ensureAllowance, retryTransaction, sleep } from "../../lib/tx.js";
import { buildPoolAndBounds, sizePosition } from "../../lib/uniswap.js";

// This round's budget, a SECOND 5 sDAI on top of round 1's. Deliberately a literal:
// manifest.liquidity.totalCollateral is round 1's figure, and spendingCap (10.5) is the
// ceiling across both rounds — neither is "what this run may spend".
const ROUND2_BUDGET = 5n * 10n ** 18n;
// Trial outcome quantity, 0.1 token.
const Q0 = 10n ** 17n;

await run(
  {
    name: "add-pd-liquidity-gnosis-round2",
    slug: "gnosis-pd-v1",
    stage: "seed-pools-round2",
    mutating: true,
    requires: ["GNOSIS_RPC_URL", "PRIVATE_KEY"],
    progress: (m) => m.files.round2Liquidity,
  },
  async (ctx) => {
    const { manifest, provider, wallet, chainId, addr, log, progress, dry: DRY_RUN } = ctx;

    const MARKET = manifest.results.parent;
    const ROUND1_PROGRESS_FILE = manifest.files.liquidity;
    const COLLATERAL = manifest.chain.collateral.address;
    const MATH_FEE_TIER = manifest.amm.mathFeeTier; // maps to tickSpacing 60, matching Algebra
    const TICK_SPACING = manifest.amm.tickSpacing;
    const { safeDown: SAFE_DOWN, safeUp: SAFE_UP } = manifest.liquidity.bandPerOutcome;

    log.log(`\n📋 Wallet      : ${wallet.address}`);
    log.log(`📋 DRY_RUN     : ${DRY_RUN}`);
    log.log(`📋 Round-2 budget : ${formatUnits(ROUND2_BUDGET, 18)} sDAI (24 asset pools only)\n`);

    const getTokenBalance = (token) => new ethers.Contract(token, erc20Abi, provider).balanceOf(wallet.address);
    const bandFor = (centerPrice) => ({
      minPrice: Math.max(1e-9, centerPrice * (1 - SAFE_DOWN)),
      maxPrice: Math.min(0.999999, centerPrice * (1 + SAFE_UP)),
    });

    const round1 = JSON.parse(fs.readFileSync(ROUND1_PROGRESS_FILE, "utf8"));
    const pools = round1
      .filter((e) => e.name !== "No To All")
      .map((e) => ({ name: e.name, outcomeToken: e.outcomeToken, price: e.price }));
    log.log(`   Loaded ${pools.length} asset pools from ${ROUND1_PROGRESS_FILE} (No To All excluded)`);

    // ── Phase 1: size positions & solve for Q2 ──────────────────────────────────
    log.log("\n📐 Phase 1: sizing positions...");
    let trialSdai = 0n;
    for (const p of pools) {
      p.meta = buildPoolAndBounds({
        outcomeToken: p.outcomeToken,
        collateral: COLLATERAL,
        price: p.price,
        live: null, // round 1's price is reused verbatim; no swaps had moved the pools
        chainId,
        feeTier: MATH_FEE_TIER,
        tickSpacing: TICK_SPACING,
        band: bandFor(p.price),
      });
      trialSdai += sizePosition(p.meta, Q0).collateralUsed;
    }
    const totalTrial = Q0 + trialSdai;
    const Q2 = (Q0 * ROUND2_BUDGET) / totalTrial;
    log.log(
      `   Trial Q0=${formatUnits(Q0, 18)} → ΣsDAI=${formatUnits(trialSdai, 18)}, ` +
        `total=${formatUnits(totalTrial, 18)} ⇒ Q2=${formatUnits(Q2, 18)}`
    );

    let sumSdai = 0n;
    let maxOutcome = 0n;
    log.log("\n   outcome                          price       outcome        sDAI");
    for (const p of pools) {
      const s = sizePosition(p.meta, Q2);
      p.position = s.position;
      p.outcomeUsed = s.outcomeUsed;
      p.sdaiUsed = s.collateralUsed;
      p.amount0 = s.amount0;
      p.amount1 = s.amount1;
      sumSdai += s.collateralUsed;
      if (s.outcomeUsed > maxOutcome) maxOutcome = s.outcomeUsed;
      log.log(
        `   ${p.name.slice(0, 30).padEnd(30)} ${p.price.toFixed(6).padStart(9)}  ` +
          `${Number(formatUnits(s.outcomeUsed, 18)).toFixed(6).padStart(12)}` +
          `  ${Number(formatUnits(s.collateralUsed, 18)).toFixed(6).padStart(10)}`
      );
    }
    const splitAmount = maxOutcome > Q2 ? maxOutcome : Q2;
    const grandTotal = splitAmount + sumSdai;
    log.log(
      `\n   Split (mint) : ${formatUnits(splitAmount, 18)} sDAI\n` +
        `   sDAI side    : ${formatUnits(sumSdai, 18)} sDAI\n` +
        `   GRAND TOTAL  : ${formatUnits(grandTotal, 18)} sDAI (budget ${formatUnits(ROUND2_BUDGET, 18)})`
    );
    if (grandTotal > ROUND2_BUDGET) log.warn("   ⚠️  grand total exceeds budget — check rounding/sentinel.");

    if (DRY_RUN) {
      return { pools: pools.length, Q2: Q2.toString(), grandTotal: grandTotal.toString() };
    }

    // ── Phase 2a: balance guard + split sDAI once ───────────────────────────────
    const sdaiBalance = await getTokenBalance(COLLATERAL);
    log.log(`\n💰 sDAI balance: ${formatUnits(sdaiBalance, 18)} | need: ${formatUnits(grandTotal, 18)}`);
    if (sdaiBalance < grandTotal) throw new Error("Insufficient sDAI balance — aborting.");

    const router = new ethers.Contract(addr.router, RouterAbi, wallet);

    // The historical entries carry outcomeToken with no kind/key, so key off that.
    const alreadyDone = new Set(progress.entries.map((e) => e.outcomeToken.toLowerCase()));

    const needSplit = !alreadyDone.size;
    if (!needSplit) log.log("\n⏭  Round-2 progress log present — assuming split already done.");
    if (needSplit) {
      log.log(`\n💧 Phase 2a: split ${formatUnits(splitAmount, 18)} sDAI on market`);
      await ensureAllowance(COLLATERAL, addr.router, splitAmount, { wallet, log });
      await retryTransaction(() => router.splitPosition(COLLATERAL, MARKET, splitAmount), { log });
      await sleep(3000);
    }

    await ensureAllowance(COLLATERAL, addr.positionManager, sumSdai, { wallet, log });

    // ── Phase 2b: mint a second position per pool (same tick range as round 1) ──
    log.log(`\n📈 Phase 2b: minting ${pools.length} additional positions\n`);
    let successCount = 0;
    for (const p of pools) {
      if (alreadyDone.has(p.outcomeToken.toLowerCase())) {
        log.log(`  ⏭  ${p.name}: already in round-2 progress log — skipping`);
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
