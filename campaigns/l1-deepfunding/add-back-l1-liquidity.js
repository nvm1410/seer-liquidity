// Restore the L1 (Deep Funding GG24) positions that index.js halved, on Optimism.
//
// execution.json records each position's PRE-REMOVAL liquidity, so the amount to add
// back is a per-position delta: original (from the file) - current (from chain). A
// position index.js never reached has delta 0 and is skipped automatically, which is
// what makes this safe to re-run.
//
// This is a RESTORE, not a seed: it never mints. Every call passes the existing tokenId
// to addCallParameters, which makes it an increaseLiquidity.
//
// The balance preflight CAPS rather than aborts — where a token is short, the position
// is re-sized from the amounts actually available (Position.fromAmounts) instead of
// being skipped. Only a token at exactly zero, or capped amounts that round to zero
// liquidity, abort a position.
//
//   node add-back-l1-liquidity.js --resume          # dry: per-position deltas + preflight
//   node add-back-l1-liquidity.js --resume --live   # sends, after a confirmation
//
// --resume is required because the progress file is the record of the live run of
// 2026-07-27 (168 full + 30 partial; manifest files.addBack).

import { Percent } from "@uniswap/sdk-core";
import { NonfungiblePositionManager, Position } from "@uniswap/v3-sdk";
import { ethers } from "ethers";
import fs from "fs";
import JSBI from "jsbi";
import { erc20Abi, formatUnits } from "viem";
import { buildPoolFor, POSITION_MANAGER_ABI } from "../../lib/positions.js";
import { run } from "../../lib/run.js";
import { retryTransaction, sleep } from "../../lib/tx.js";

const DELAY_MS = 2000;

await run(
  {
    name: "add-back-l1-liquidity",
    slug: "l1-deepfunding",
    stage: "restore-addback",
    mutating: true,
    progress: (m) => m.files.addBack,
  },
  async (ctx) => {
    const { manifest, provider, wallet, chainId, addr, log, progress, dry: DRY_RUN } = ctx;

    // execution.json was written by index.js just before/after each 50% removal.
    const executionData = JSON.parse(fs.readFileSync(manifest.files.baseline, "utf8"));

    log.log(`\n📋 execution.json entries : ${executionData.length}`);
    log.log(`📋 Wallet address         : ${wallet.address}`);
    log.log(`📋 DRY_RUN                : ${DRY_RUN}\n`);

    const positionManager = new ethers.Contract(addr.positionManager, POSITION_MANAGER_ABI, wallet);

    // ── Phase 1: compute per-position deltas ──────────────────────────────────
    // delta = original (execution.json) - current (on-chain).
    // - If the position was reduced: current ≈ original/2, delta ≈ original/2.
    // - If the run was interrupted before reaching a position: current == original,
    //   delta == 0 → auto-skipped.
    log.log("🔍 Computing deltas from execution.json vs on-chain state...\n");
    const toRestore = [];
    let skippedZeroDelta = 0;

    for (const entry of executionData) {
      const positionId = entry.positionId;
      const pos = await positionManager.positions(BigInt(positionId));
      const original = BigInt(entry.liquidity);
      const current = pos.liquidity;
      const delta = original - current;

      if (delta <= 0n) {
        log.log(
          `  ⏭  #${positionId}: delta=${delta.toString()} (original=${formatUnits(original, 18)}, current=${formatUnits(current, 18)}) — skipping`
        );
        skippedZeroDelta++;
        continue;
      }

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
        `  ✅ #${positionId}: original=${formatUnits(original, 18)}, current=${formatUnits(current, 18)}, ` +
          `delta=${formatUnits(delta, 18)} | need token0=${formatUnits(amount0Desired, 18)}, token1=${formatUnits(amount1Desired, 18)}`
      );

      toRestore.push({
        positionId,
        token0: pos.token0,
        token1: pos.token1,
        original,
        delta,
        amount0Desired,
        amount1Desired,
        position,
      });
    }

    log.log(`\n📊 Summary:`);
    log.log(`   To restore          : ${toRestore.length}`);
    log.log(`   Skipped (delta = 0) : ${skippedZeroDelta}`);

    if (toRestore.length === 0) {
      log.log("\n✅ All L1 positions are already at their original size.");
      return { toRestore: 0, skippedZeroDelta };
    }

    // ── Phase 2: preflight balance check (caps at available, no abort) ─────────
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
      return { toRestore: toRestore.length, skippedZeroDelta, tokens: tokenNeeded.size };
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
    log.log("\n📈 Increasing liquidity for each L1 position...");

    // The 198 historical entries carry positionId with no kind/key, so key off
    // positionId exactly as the original did — progress.has() would read the whole
    // completed log as empty and re-add every position.
    const alreadyDone = new Set(progress.entries.map((e) => String(e.positionId)));

    let successCount = 0;
    let skippedInsufficientCount = 0;

    for (const item of toRestore) {
      if (alreadyDone.has(String(item.positionId))) {
        log.log(`  ⏭  #${item.positionId}: already in progress log — skipping`);
        successCount++;
        continue;
      }

      const t0 = item.token0.toLowerCase();
      const t1 = item.token1.toLowerCase();
      const rem0 = remaining.get(t0) ?? 0n;
      const rem1 = remaining.get(t1) ?? 0n;

      // If either token is short, recompute position with available amounts
      // rather than skipping. Only truly exhausted tokens abort the position.
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

        remaining.set(t0, rem0 - use0);
        remaining.set(t1, rem1 - use1);

        progress.append({
          positionId: item.positionId,
          kind: "increase",
          key: String(item.positionId),
          token0: item.token0,
          token1: item.token1,
          original: item.original.toString(),
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

      await sleep(DELAY_MS);
    }

    log.log(
      `\n🎉 Done! ${successCount} restored, ${skippedInsufficientCount} skipped (insufficient balance). ` +
        `See ${progress.path} for details.`
    );
    return { restored: successCount, skippedInsufficient: skippedInsufficientCount };
  }
);
