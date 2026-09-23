// Restore the originality round-2 positions that index.js halved, on Optimism.
//
// index.js removed exactly 50% (Percent(1,2)), so original = 2 x current and the amount to
// add back is simply the CURRENT liquidity. That is the one structural difference from
// add-back-l1-liquidity.js, which reads its originals out of execution.json instead —
// here there is no recorded baseline, only the arithmetic of a known-half removal.
//
// Scope is tokens.js (every position the wallet held) filtered to originality-pairs.js,
// so a position from another campaign in the same list is skipped rather than restored.
//
// This is a RESTORE, not a seed: it never mints. Every call passes the existing tokenId
// to addCallParameters, which makes it an increaseLiquidity.
//
// The balance preflight CAPS rather than aborts — where a token is short, the position is
// re-sized from what is actually available (Position.fromAmounts) instead of being skipped.
//
//   node add-back-liquidity.js --resume          # dry: per-position deltas + preflight
//   node add-back-liquidity.js --resume --live   # sends, after a confirmation

import { Percent } from "@uniswap/sdk-core";
import { NonfungiblePositionManager, Position } from "@uniswap/v3-sdk";
import { ethers } from "ethers";
import JSBI from "jsbi";
import { erc20Abi, formatUnits } from "viem";
import { originalityPairs } from "./originality-pairs.js";
import { buildPoolFor, POSITION_MANAGER_ABI } from "../../lib/positions.js";
import { run } from "../../lib/run.js";
import { retryTransaction, sleep } from "../../lib/tx.js";
import { tokenIds } from "./tokens.js";

await run(
  {
    name: "add-back-liquidity",
    slug: "originality-r2",
    stage: "restore-addback",
    mutating: true,
    progress: (m) => m.files.addBack,
  },
  async (ctx) => {
    const { provider, wallet, chainId, addr, log, progress, dry: DRY_RUN } = ctx;

    log.log(`\n📋 tokens.js total position IDs : ${tokenIds.length}`);
    log.log(`📋 Wallet address                : ${wallet.address}`);
    log.log(`📋 DRY_RUN                       : ${DRY_RUN}\n`);

    const positionManager = new ethers.Contract(addr.positionManager, POSITION_MANAGER_ABI, wallet);

    // Loaded early so Phase 1 can skip already-done positions. The historical entries
    // carry positionId with no kind/key, so key off positionId as the original did.
    const alreadyDone = new Set(progress.entries.map((e) => String(e.positionId)));
    log.log(`📋 Already done (from ${progress.path}): ${alreadyDone.size}\n`);

    // ── Phase 1: scan all positions, filter to originality, compute delta ─────
    log.log("🔍 Scanning positions for originality pairs...\n");
    const toRestore = [];
    let nonOriginalityCount = 0;
    let zeroLiquidityCount = 0;

    for (const positionId of tokenIds) {
      if (alreadyDone.has(String(positionId))) continue;

      const pos = await positionManager.positions(BigInt(positionId));
      const current = pos.liquidity;

      // Skip positions with zero liquidity (burned / fully withdrawn)
      if (current === 0n) {
        zeroLiquidityCount++;
        continue;
      }

      // Filter to originality pairs only
      const isOriginality = originalityPairs.some(
        (pair) =>
          pos.token0.toLowerCase() === pair.token0.toLowerCase() &&
          pos.token1.toLowerCase() === pair.token1.toLowerCase()
      );
      if (!isOriginality) {
        nonOriginalityCount++;
        continue;
      }

      // delta = current because original = 2 × current (50% was removed)
      const delta = current;

      // Build the pool at its CURRENT on-chain state, then size the delta into it.
      const { pool } = await buildPoolFor(pos, { provider, chainId });
      const position = new Position({
        pool,
        liquidity: delta.toString(),
        tickLower: Number(pos.tickLower),
        tickUpper: Number(pos.tickUpper),
      });

      const amount0Desired = BigInt(position.mintAmounts.amount0.toString());
      const amount1Desired = BigInt(position.mintAmounts.amount1.toString());

      log.log(
        `  ✅ #${positionId}: current=${formatUnits(current, 18)}, delta=${formatUnits(delta, 18)}` +
          ` | need token0=${formatUnits(amount0Desired, 18)}, token1=${formatUnits(amount1Desired, 18)}`
      );

      toRestore.push({
        positionId,
        token0: pos.token0,
        token1: pos.token1,
        delta,
        amount0Desired,
        amount1Desired,
        position,
      });
    }

    log.log(`\n📊 Summary:`);
    log.log(`   Originality positions to restore : ${toRestore.length}`);
    log.log(`   Non-originality (skipped)        : ${nonOriginalityCount}`);
    log.log(`   Zero-liquidity  (skipped)        : ${zeroLiquidityCount}`);

    if (toRestore.length === 0) {
      log.log("\n✅ No originality positions with liquidity found in tokens.js.");
      return { toRestore: 0, nonOriginality: nonOriginalityCount, zeroLiquidity: zeroLiquidityCount };
    }

    // ── Phase 2: preflight balance check (caps at available, no abort) ─────────
    // Aggregate needed amounts per unique token (preserve original casing for calls).
    const tokenNeeded = new Map(); // lowercased -> { address, needed }
    for (const item of toRestore) {
      const t0 = item.token0.toLowerCase();
      const t1 = item.token1.toLowerCase();
      if (!tokenNeeded.has(t0)) tokenNeeded.set(t0, { address: item.token0, needed: 0n });
      if (!tokenNeeded.has(t1)) tokenNeeded.set(t1, { address: item.token1, needed: 0n });
      tokenNeeded.get(t0).needed += item.amount0Desired;
      tokenNeeded.get(t1).needed += item.amount1Desired;
    }

    log.log("\n💰 Wallet balance preflight:");
    const remaining = new Map(); // lowercased -> BigInt (spendable)
    for (const [key, { address, needed }] of tokenNeeded) {
      const available = await new ethers.Contract(address, erc20Abi, provider).balanceOf(wallet.address);
      const usable = available < needed ? available : needed;
      remaining.set(key, usable);
      const ok = available >= needed;
      log.log(
        `   ${address}\n     needed   : ${formatUnits(needed, 18)}\n` +
          `     available: ${formatUnits(available, 18)}  ${ok ? "✅" : `⚠️  INSUFFICIENT — will use ${formatUnits(usable, 18)}`}`
      );
    }

    if (DRY_RUN) {
      return { toRestore: toRestore.length, tokens: tokenNeeded.size };
    }

    // ── Phase 3: approve each unique token once (skip if allowance already enough)
    log.log("\n🔑 Checking/approving tokens...");
    for (const [key, { address }] of tokenNeeded) {
      const approveAmount = remaining.get(key);
      const tokenContract = new ethers.Contract(address, erc20Abi, provider);
      const currentAllowance = await tokenContract.allowance(wallet.address, addr.positionManager);
      if (currentAllowance >= approveAmount) {
        log.log(`  ⏭  ${address}: allowance already sufficient — skipping`);
        continue;
      }
      log.log(`  Approving ${address} for ${formatUnits(approveAmount, 18)} ...`);
      const token = new ethers.Contract(address, erc20Abi, wallet);
      await retryTransaction(() => token.approve(addr.positionManager, approveAmount), { log });
      await sleep(2000);
    }

    // ── Phase 4: increase liquidity per position ──────────────────────────────
    log.log("\n📈 Increasing liquidity for each position...");

    let successCount = 0;
    let skippedInsufficientCount = 0;
    for (const item of toRestore) {
      const t0 = item.token0.toLowerCase();
      const t1 = item.token1.toLowerCase();
      const rem0 = remaining.get(t0) ?? 0n;
      const rem1 = remaining.get(t1) ?? 0n;

      // If either token is short, recompute the position using whatever is left rather
      // than skipping. Position.fromAmounts finds the max liquidity that fits both caps.
      let positionToUse = item.position;
      let use0 = item.amount0Desired;
      let use1 = item.amount1Desired;

      if (rem0 < item.amount0Desired || rem1 < item.amount1Desired) {
        if (rem0 === 0n || rem1 === 0n) {
          log.log(`  ⚠️  #${item.positionId}: one token fully exhausted — skipping`);
          skippedInsufficientCount++;
          continue;
        }
        const capped0 = rem0 < item.amount0Desired ? rem0 : item.amount0Desired;
        const capped1 = rem1 < item.amount1Desired ? rem1 : item.amount1Desired;
        positionToUse = Position.fromAmounts({
          pool: item.position.pool,
          tickLower: item.position.tickLower,
          tickUpper: item.position.tickUpper,
          amount0: capped0.toString(),
          amount1: capped1.toString(),
          useFullPrecision: true,
        });
        if (JSBI.equal(positionToUse.liquidity, JSBI.BigInt(0))) {
          log.log(`  ⚠️  #${item.positionId}: capped amounts yield zero liquidity — skipping`);
          skippedInsufficientCount++;
          continue;
        }
        use0 = BigInt(positionToUse.mintAmounts.amount0.toString());
        use1 = BigInt(positionToUse.mintAmounts.amount1.toString());
        log.log(
          `  ⚠️  #${item.positionId}: using reduced amounts ` +
            `token0=${formatUnits(use0, 18)}, token1=${formatUnits(use1, 18)}`
        );
      }

      log.log(`\n--- Position #${item.positionId} ---`);
      try {
        const { calldata, value } = NonfungiblePositionManager.addCallParameters(positionToUse, {
          tokenId: item.positionId.toString(), // triggers increaseLiquidity (not mint)
          slippageTolerance: new Percent(10, 10_000), // 0.1%
          deadline: Math.floor(Date.now() / 1000) + 60 * 20,
        });

        const receipt = await retryTransaction(
          () => wallet.sendTransaction({ to: addr.positionManager, data: calldata, value }),
          { log }
        );

        // Deduct actual amounts used from the remaining balance tracker
        remaining.set(t0, rem0 - use0);
        remaining.set(t1, rem1 - use1);

        progress.append({
          positionId: item.positionId,
          kind: "increase",
          key: String(item.positionId),
          token0: item.token0,
          token1: item.token1,
          delta: item.delta.toString(),
          amount0Desired: use0.toString(),
          amount1Desired: use1.toString(),
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
        });
        successCount++;
        log.log(`  ✅ Saved to ${progress.path}`);
      } catch (err) {
        log.error(`  ❌ Failed for #${item.positionId}: ${err.shortMessage || err.message}`);
      }

      await sleep(2000);
    }

    log.log(
      `\n🎉 Done! ${successCount} restored, ${skippedInsufficientCount} skipped (insufficient balance). ` +
        `See ${progress.path} for details.`
    );
    return { restored: successCount, skippedInsufficient: skippedInsufficientCount };
  }
);
