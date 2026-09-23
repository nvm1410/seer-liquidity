// Add a second round of sUSDS liquidity to the originality round-2 pools on Optimism.
//
// Unlike the L1 top-up, nothing is solved here: the round budget is split whole on the
// parent market, and each repo gets a fixed slice.
//
//   Phase 1 — splitPosition(sUSDS, parent) mints TOTAL_SUSDS of EVERY parent outcome
//             token (one complete set).
//   Phase 2 — per repo, splitPosition(sUSDS, childMarket) burns PER_POOL of that repo's
//             parent-outcome token and mints PER_POOL of Up and Down. The collateral
//             argument is still the BASE collateral (sUSDS): the Router unwraps the
//             parent outcome ERC20 itself, because the child has a parentCollectionId.
//   Phase 3 — increaseLiquidity on each existing position, sized from PER_POOL a side.
//
// So each repo keeps 2/3 of its minted parent outcome as the collateral side and splits
// 1/3 into Up/Down — the 13333-split vs 26666-collateral ratio of the original seed.
//
//   node add-20k-originality-liquidity.js --resume                 # dry: full plan
//   node add-20k-originality-liquidity.js --resume --live          # sends, after a confirmation
//   node add-20k-originality-liquidity.js --resume --live --skip-splits
//
// --skip-splits is the resume switch: if a live run did both splits but died partway
// through Phase 3, it skips phases 1-2 and only finishes the increaseLiquidity calls
// not yet in the progress log.

import { Percent } from "@uniswap/sdk-core";
import { NonfungiblePositionManager, Position } from "@uniswap/v3-sdk";
import { ethers } from "ethers";
import fs from "fs";
import JSBI from "jsbi";
import { erc20Abi, formatUnits } from "viem";
import { RouterAbi } from "./abis/RouterAbi.js";
import { getMarketInfo, makeMarketView } from "./lib/market.js";
import { buildPoolFor, POSITION_MANAGER_ABI } from "./lib/positions.js";
import { run } from "./lib/run.js";
import { pairKey, sortTokens } from "./lib/ticks.js";
import { ensureAllowance, retryTransaction, sleep } from "./lib/tx.js";
import { markets } from "./markets.js";

// sUSDS to split on the parent market. This is THIS ROUND's budget and is deliberately
// NOT read from the manifest: spendingCap.collateral (60000) is the campaign-level
// ceiling across both rounds, not the amount one run may spend.
const TOTAL_SUSDS = 20_000n * 10n ** 18n;
// Per repo we reserve 1/3 of the minted parent outcome tokens to split into Up/Down and
// keep 2/3 as the collateral side. PER_POOL is therefore both the child-split amount per
// repo AND the per-pool token budget.
const PER_POOL = TOTAL_SUSDS / 3n;
// Sanity target: each position's final liquidity (current + added) should reach at least
// this multiple of its current on-chain liquidity. Kept as a fraction so the comparison
// stays in integer math.
const MIN_FINAL_MULT_NUM = 3n; // 3/2 = 1.5x
const MIN_FINAL_MULT_DEN = 2n;

await run(
  {
    name: "add-20k-originality-liquidity",
    slug: "originality-r2",
    stage: "topup-20k",
    mutating: true,
    progress: (m) => m.files.topUp,
  },
  async (ctx) => {
    const { manifest, provider, wallet, chainId, addr, log, progress, args, dry: DRY_RUN } = ctx;

    const SKIP_SPLITS = args.flags.has("--skip-splits");
    const COLLATERAL = manifest.chain.collateral.address;
    const PARENT_MARKET_ADDRESS = manifest.results.parent;
    const ADD_BACK_FILE = manifest.files.addBack;
    // Cache of the resolved repo→tokens/markets/positions map. Built once (e.g. on the
    // dry run) and reused so later runs don't re-resolve ~98 markets over RPC.
    const MAP_CACHE_FILE = manifest.files.mapCache;

    log.log(`\n📋 Wallet address : ${wallet.address}`);
    log.log(`📋 DRY_RUN        : ${DRY_RUN}`);
    log.log(`📋 TOTAL_SUSDS    : ${formatUnits(TOTAL_SUSDS, 18)}`);
    log.log(`📋 PER_POOL       : ${formatUnits(PER_POOL, 18)}\n`);

    const positionManager = new ethers.Contract(addr.positionManager, POSITION_MANAGER_ABI, provider);
    const marketView = makeMarketView(addr.marketView, provider);
    const getTokenBalance = (token) => new ethers.Contract(token, erc20Abi, provider).balanceOf(wallet.address);

    // ── Phase 0: build repo → tokens/markets/positions map ───────────────────
    let repos; // [{ childMarket, parentOutcomeToken, outcomeTokens[], positions[] }]

    if (fs.existsSync(MAP_CACHE_FILE)) {
      repos = JSON.parse(fs.readFileSync(MAP_CACHE_FILE, "utf8"));
      log.log(`🔍 Phase 0: loaded ${repos.length} repos from cache ${MAP_CACHE_FILE}`);
      log.log(`   (delete ${MAP_CACHE_FILE} to re-resolve from chain)`);
    } else {
      log.log("🔍 Phase 0: resolving child markets and matching positions...\n");

      const addBack = JSON.parse(fs.readFileSync(ADD_BACK_FILE, "utf8"));
      const poolToPosition = new Map();
      for (const e of addBack) {
        const [a, b] = sortTokens(e.token0, e.token1);
        poolToPosition.set(pairKey(a, b), { positionId: e.positionId, token0: a, token1: b });
      }

      repos = [];
      const matchedPoolKeys = new Set();
      let parentMismatch = 0;

      for (const m of markets) {
        const info = await getMarketInfo(marketView, addr.marketFactory, m.marketId);

        if (!info.parentMarketAddress || info.parentOutcomeToken === undefined) {
          log.log(`  ⚠️  ${m.marketId}: not a conditional market — skipping`);
          continue;
        }
        if (info.parentMarketAddress.toLowerCase() !== PARENT_MARKET_ADDRESS.toLowerCase()) {
          log.log(`  ⚠️  ${m.marketId}: parent ${info.parentMarketAddress} ≠ expected ${PARENT_MARKET_ADDRESS} — skipping`);
          parentMismatch++;
          continue;
        }

        const parentOutcomeToken = info.parentOutcomeToken;
        const outcomeTokens = info.wrappedTokens.slice(0, -1); // drop Invalid

        const positions = [];
        for (const outcome of outcomeTokens) {
          const key = pairKey(outcome, parentOutcomeToken);
          const pos = poolToPosition.get(key);
          if (!pos) {
            log.log(`  ⚠️  ${m.marketId}: pool ${outcome}/${parentOutcomeToken} not found in ${ADD_BACK_FILE}`);
            continue;
          }
          matchedPoolKeys.add(key);
          positions.push({ ...pos, outcomeToken: outcome });
        }

        if (positions.length === 0) continue;
        repos.push({ childMarket: m.marketId, parentOutcomeToken, outcomeTokens, positions });
      }

      log.log(`   Parent-market mismatches    : ${parentMismatch}`);
      log.log(`   add-back positions unmatched: ${addBack.length - matchedPoolKeys.size}`);
      fs.writeFileSync(MAP_CACHE_FILE, JSON.stringify(repos, null, 2));
      log.log(`   Cached map → ${MAP_CACHE_FILE}`);
    }

    const totalPositions = repos.reduce((n, r) => n + r.positions.length, 0);
    log.log(`\n📊 Phase 0 summary:`);
    log.log(`   Repos with positions        : ${repos.length}`);
    log.log(`   Positions to top up         : ${totalPositions}`);

    if (repos.length === 0) throw new Error("No repos/positions matched — aborting.");

    // ── Projected mint deltas (per token, lowercased) ─────────────────────────
    // Parent split: +TOTAL_SUSDS to every parent outcome token we use.
    // Child split:  −PER_POOL parentOutcome, +PER_POOL Up, +PER_POOL Down per repo.
    const projected = new Map();
    const addProjected = (token, delta) => {
      const k = token.toLowerCase();
      projected.set(k, (projected.get(k) ?? 0n) + delta);
    };
    for (const r of repos) {
      addProjected(r.parentOutcomeToken, TOTAL_SUSDS - PER_POOL);
      for (const o of r.outcomeTokens) addProjected(o, PER_POOL);
    }

    const router = new ethers.Contract(addr.router, RouterAbi, wallet);

    if (SKIP_SPLITS) {
      log.log("\n⏭  Phases 1-2 skipped (--skip-splits) — assuming tokens already minted.");
    } else {
      // ── Phase 1: split sUSDS → parent outcome tokens ───────────────────────
      const susdsBalance = await getTokenBalance(COLLATERAL);
      log.log(`\n💰 Phase 1: split sUSDS on parent market ${PARENT_MARKET_ADDRESS}`);
      log.log(`   sUSDS balance: ${formatUnits(susdsBalance, 18)} | need: ${formatUnits(TOTAL_SUSDS, 18)}`);
      if (!DRY_RUN && susdsBalance < TOTAL_SUSDS) throw new Error("Insufficient sUSDS — aborting.");

      if (!DRY_RUN) {
        // sanity-check router before sending value
        const ct = await router.conditionalTokens();
        if (!ct || ct === ethers.ZeroAddress) {
          throw new Error("Router.conditionalTokens() is zero — wrong Router address? Aborting.");
        }
        log.log(`   Router.conditionalTokens() = ${ct}`);

        await ensureAllowance(COLLATERAL, addr.router, TOTAL_SUSDS, { wallet, log });
        log.log("   Splitting sUSDS...");
        await retryTransaction(() => router.splitPosition(COLLATERAL, PARENT_MARKET_ADDRESS, TOTAL_SUSDS), { log });
      } else {
        log.log("   (dry run — no split sent)");
      }

      // ── Phase 2: split parent outcomes → Up/Down per repo ──────────────────
      log.log(`\n🪙 Phase 2: split ${formatUnits(PER_POOL, 18)} of each parent outcome into Up/Down`);
      for (const r of repos) {
        log.log(`   Repo ${r.childMarket} (collateral ${r.parentOutcomeToken})`);
        if (!DRY_RUN) {
          await ensureAllowance(r.parentOutcomeToken, addr.router, PER_POOL, { wallet, log });
          // collateralToken arg = base collateral (sUSDS); the Router pulls/unwraps the
          // parent outcome ERC20 because the child has a non-zero parentCollectionId.
          await retryTransaction(() => router.splitPosition(COLLATERAL, r.childMarket, PER_POOL), { log });
          await sleep(2000);
        } else {
          log.log("     (dry run — no split sent)");
        }
      }
    }

    // ── Phase 3: increase liquidity on each position ─────────────────────────
    log.log(`\n📈 Phase 3: increase liquidity on ${totalPositions} positions\n`);

    // Build the flat work list with on-chain tick ranges + pool state.
    const work = [];
    for (const r of repos) {
      for (const p of r.positions) {
        const pos = await positionManager.positions(BigInt(p.positionId));
        const { pool } = await buildPoolFor(pos, { provider, chainId });
        const position = Position.fromAmounts({
          pool,
          tickLower: Number(pos.tickLower),
          tickUpper: Number(pos.tickUpper),
          amount0: PER_POOL.toString(),
          amount1: PER_POOL.toString(),
          useFullPrecision: true,
        });
        work.push({
          positionId: p.positionId,
          token0: p.token0,
          token1: p.token1,
          tickLower: Number(pos.tickLower),
          tickUpper: Number(pos.tickUpper),
          currentLiquidity: pos.liquidity, // on-chain liquidity before this run
          pool,
          position,
          amount0Desired: BigInt(position.mintAmounts.amount0.toString()),
          amount1Desired: BigInt(position.mintAmounts.amount1.toString()),
        });
      }
    }

    // Spendable balance tracker. In a live run the splits already ran, so on-chain
    // balances reflect the mint. In a dry run nothing was minted, so add the projected
    // deltas to preview realistic amounts.
    const remaining = new Map();
    const involved = new Set();
    for (const w of work) {
      involved.add(w.token0.toLowerCase());
      involved.add(w.token1.toLowerCase());
    }
    for (const key of involved) {
      let bal = await getTokenBalance(key);
      if (DRY_RUN) bal += projected.get(key) ?? 0n;
      remaining.set(key, bal);
    }

    log.log("💰 Available (post-split) per token:");
    for (const [k, v] of remaining) log.log(`   ${k}: ${formatUnits(v, 18)}`);
    log.log("");

    // Approvals for PositionManager (skip in dry run)
    if (!DRY_RUN) {
      log.log("🔑 Approving tokens for PositionManager...");
      for (const key of involved) {
        await ensureAllowance(key, addr.positionManager, remaining.get(key), { wallet, log });
      }
    }

    // The historical entries carry positionId with no kind/key, so key off positionId.
    const alreadyDone = new Set(progress.entries.map((e) => String(e.positionId)));

    let successCount = 0;
    let skipped = 0;
    const belowTarget = []; // positions whose final liquidity stays under 1.5x
    for (const item of work) {
      if (alreadyDone.has(String(item.positionId))) {
        log.log(`  ⏭  #${item.positionId}: already in progress log — skipping`);
        successCount++;
        continue;
      }

      const t0 = item.token0.toLowerCase();
      const t1 = item.token1.toLowerCase();
      const rem0 = remaining.get(t0) ?? 0n;
      const rem1 = remaining.get(t1) ?? 0n;

      let positionToUse = item.position;
      let use0 = item.amount0Desired;
      let use1 = item.amount1Desired;

      if (rem0 < item.amount0Desired || rem1 < item.amount1Desired) {
        if (rem0 === 0n || rem1 === 0n) {
          log.log(`  ⚠️  #${item.positionId}: one token exhausted — skipping`);
          skipped++;
          continue;
        }
        const capped0 = rem0 < item.amount0Desired ? rem0 : item.amount0Desired;
        const capped1 = rem1 < item.amount1Desired ? rem1 : item.amount1Desired;
        positionToUse = Position.fromAmounts({
          pool: item.pool,
          tickLower: item.tickLower,
          tickUpper: item.tickUpper,
          amount0: capped0.toString(),
          amount1: capped1.toString(),
          useFullPrecision: true,
        });
        if (JSBI.equal(positionToUse.liquidity, JSBI.BigInt(0))) {
          log.log(`  ⚠️  #${item.positionId}: capped amounts yield zero liquidity — skipping`);
          skipped++;
          continue;
        }
        use0 = BigInt(positionToUse.mintAmounts.amount0.toString());
        use1 = BigInt(positionToUse.mintAmounts.amount1.toString());
      }

      // 1.5x sanity check: does (current + added) reach the target multiple of current?
      const addedLiquidity = BigInt(positionToUse.liquidity.toString());
      const current = item.currentLiquidity;
      const finalLiquidity = current + addedLiquidity;
      const meetsTarget = current === 0n || finalLiquidity * MIN_FINAL_MULT_DEN >= current * MIN_FINAL_MULT_NUM;
      const ratioStr = current === 0n ? "∞" : (Number(finalLiquidity) / Number(current)).toFixed(2);
      if (!meetsTarget) belowTarget.push({ positionId: item.positionId, ratio: ratioStr });

      log.log(
        `\n--- Position #${item.positionId} | token0=${formatUnits(use0, 18)} token1=${formatUnits(use1, 18)}` +
          ` | final/current=${ratioStr}x ${meetsTarget ? "✅" : "⚠️ <1.5x"} ---`
      );

      if (DRY_RUN) {
        remaining.set(t0, rem0 - use0);
        remaining.set(t1, rem1 - use1);
        successCount++;
        continue;
      }

      try {
        const { calldata, value } = NonfungiblePositionManager.addCallParameters(positionToUse, {
          tokenId: item.positionId.toString(), // triggers increaseLiquidity
          slippageTolerance: new Percent(50, 10_000), // 0.5%
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

    log.log(`\n🎯 1.5x liquidity check: ${work.length - belowTarget.length}/${work.length} positions reach ≥1.5x.`);
    if (belowTarget.length > 0) {
      log.log(`   ⚠️  ${belowTarget.length} below 1.5x:`);
      for (const b of belowTarget) log.log(`      #${b.positionId}: ${b.ratio}x`);
    }

    log.log(`\n🎉 Done! ${successCount} processed, ${skipped} skipped (insufficient balance).${DRY_RUN ? "" : ` See ${progress.path}.`}`);
    return { repos: repos.length, positions: totalPositions, processed: successCount, skipped };
  }
);
