// Add a second round of sUSDS liquidity to the L1 (Deep Funding GG24) pools on Optimism,
// scaling every pool by the same multiplier rather than topping each up by a fixed amount.
//
// The multiplier `f` is SOLVED against the budget, not chosen: both the split cost and the
// pool-side sUSDS scale near-linearly in f, so f ← f * BUDGET / total(f) converges in a
// couple of iterations. The max(0, need - balance) clamp on leftover token balances is what
// makes it not exactly linear, hence the loop rather than one division.
//
// The pools are fed by TWO nested markets, so the tokens come from two splits:
//   Phase 1 — splitPosition(sUSDS, market A) mints every A outcome INCLUDING the
//             "Other repositories" token (OTHER_TOKEN)
//   Phase 2 — splitPosition(sUSDS, market B) burns OTHER_TOKEN and mints every B outcome.
//             The collateral argument is still the BASE collateral (sUSDS): the Router
//             unwraps the parent outcome ERC20 itself, because B has a non-zero
//             parentCollectionId.
// So split A must cover both A's own shortfall and whatever split B will burn.
//
// Source positions are grouped per pool and the LARGEST NFT in each (fee, tickLower,
// tickUpper) group is the single top-up target — all positions in a pool share a range, so
// concentrating the add into one NFT is economically identical to topping each up.
//
//   node add-20k-l1-liquidity.js --resume                 # dry: solver trace + full plan
//   node add-20k-l1-liquidity.js --resume --live          # sends, after a confirmation
//   node add-20k-l1-liquidity.js --resume --live --skip-splits
//
// --skip-splits is the resume switch: if a live run did the two splits but died partway
// through phase 3, it skips phases 1-2 (the tokens are already in the wallet) and only
// finishes the increaseLiquidity calls not yet in the progress log.

import { Percent } from "@uniswap/sdk-core";
import { NonfungiblePositionManager, Position } from "@uniswap/v3-sdk";
import { ethers } from "ethers";
import fs from "fs";
import JSBI from "jsbi";
import { erc20Abi, formatUnits, parseUnits } from "viem";
import { RouterAbi } from "../../abis/RouterAbi.js";
import { getMarketInfo, makeMarketView } from "../../lib/market.js";
import { buildPoolFor, POSITION_MANAGER_ABI } from "../../lib/positions.js";
import { run } from "../../lib/run.js";
import { ensureAllowance, retryTransaction, sleep } from "../../lib/tx.js";

// Scale a BigInt by a floating multiplier with 1e9 precision.
const F_SCALE = 1_000_000_000n;
const scaleBy = (x, f) => (BigInt(Math.round(f * Number(F_SCALE))) * x) / F_SCALE;
const bigMax = (a, b) => (a > b ? a : b);
const fmt = (x) => Number(formatUnits(x, 18)).toFixed(2);

await run(
  {
    name: "add-20k-l1-liquidity",
    slug: "l1-deepfunding",
    stage: "topup-20k",
    mutating: true,
    progress: (m) => m.files.topUp,
  },
  async (ctx) => {
    const { manifest, provider, wallet, chainId, addr, log, progress, args, dry: DRY_RUN } = ctx;

    // Total sUSDS we are willing to spend this round. This counts BOTH the sUSDS locked in
    // splitPosition (to mint outcome tokens) and the sUSDS deposited as the collateral side
    // of the pools — the same accounting used for the first 20k.
    const TOTAL_SUSDS_BUDGET = parseUnits(String(manifest.spendingCap.collateral), 18);
    const SKIP_SPLITS = args.flags.has("--skip-splits");

    const COLLATERAL = manifest.chain.collateral.address;
    const [MARKET_A, MARKET_B] = manifest.results.marketAddresses;
    const OTHER_TOKEN = manifest.settle.catchAllOutcome.token;
    const SOURCE_FILE = manifest.files.baseline;

    log.log(`\n📋 Wallet address : ${wallet.address}`);
    log.log(`📋 DRY_RUN        : ${DRY_RUN}`);
    log.log(`📋 SKIP_SPLITS    : ${SKIP_SPLITS}`);
    log.log(`📋 Budget         : ${formatUnits(TOTAL_SUSDS_BUDGET, 18)} sUSDS (split cost + pool side)\n`);

    const positionManager = new ethers.Contract(addr.positionManager, POSITION_MANAGER_ABI, provider);
    const marketView = makeMarketView(addr.marketView, provider);
    const susdsLower = COLLATERAL.toLowerCase();
    const otherLower = OTHER_TOKEN.toLowerCase();

    const getTokenBalance = (token) =>
      new ethers.Contract(ethers.getAddress(token), erc20Abi, provider).balanceOf(wallet.address);

    // ── Phase 0: resolve markets and build the per-pool work list ─────────────
    log.log("🔍 Phase 0: resolving markets and building the pool work list...\n");

    const mA = await getMarketInfo(marketView, addr.marketFactory, MARKET_A);
    const mB = await getMarketInfo(marketView, addr.marketFactory, MARKET_B);
    const tokenMarket = new Map(); // token (lower) → "A" | "B"
    for (const t of mA.wrappedTokens) tokenMarket.set(t.toLowerCase(), "A");
    for (const t of mB.wrappedTokens) tokenMarket.set(t.toLowerCase(), "B");
    log.log(`   Market A ${MARKET_A}: ${mA.wrappedTokens.length} outcomes`);
    log.log(`   Market B ${MARKET_B}: ${mB.wrappedTokens.length} outcomes`);
    if (mB.parentMarketAddress?.toLowerCase() !== MARKET_A.toLowerCase()) {
      throw new Error(`Market B's parent is ${mB.parentMarketAddress}, expected ${MARKET_A} — aborting.`);
    }
    if (mB.parentOutcomeToken?.toLowerCase() !== otherLower) {
      throw new Error(`Market B's parent outcome token is not ${OTHER_TOKEN} — aborting.`);
    }

    const source = JSON.parse(fs.readFileSync(SOURCE_FILE, "utf8"));
    // Group the source positions by pool (keyed on the non-sUSDS outcome token).
    const byOutcome = new Map();
    for (const e of source) {
      const t0 = e.token0.toLowerCase();
      const t1 = e.token1.toLowerCase();
      if (t0 !== susdsLower && t1 !== susdsLower) {
        log.log(`  ⚠️  #${e.positionId}: not an sUSDS pool — skipping`);
        continue;
      }
      const outcome = t0 === susdsLower ? t1 : t0;
      if (!byOutcome.has(outcome)) byOutcome.set(outcome, []);
      byOutcome.get(outcome).push(e);
    }
    log.log(`   Source positions            : ${source.length}`);
    log.log(`   Distinct sUSDS pools        : ${byOutcome.size}`);

    // For each pool: read every position, sum their liquidity, and pick the largest one as
    // the single top-up target.
    const pools = [];
    let mismatched = 0;
    for (const [outcome, entries] of byOutcome) {
      const market = tokenMarket.get(outcome);
      if (!market) {
        log.log(`  ⚠️  ${outcome}: not an outcome of market A or B — skipping`);
        continue;
      }

      const read = [];
      for (const e of entries) {
        const p = await positionManager.positions(BigInt(e.positionId));
        read.push({
          positionId: String(e.positionId),
          fee: Number(p.fee),
          tickLower: Number(p.tickLower),
          tickUpper: Number(p.tickUpper),
          liquidity: p.liquidity,
          token0: ethers.getAddress(p.token0),
          token1: ethers.getAddress(p.token1),
        });
      }

      // Group by (fee, tickLower, tickUpper) so a pool with heterogeneous ranges degrades
      // gracefully into one target per distinct range instead of silently mixing them.
      const byRange = new Map();
      for (const r of read) {
        const key = `${r.fee}:${r.tickLower}:${r.tickUpper}`;
        if (!byRange.has(key)) byRange.set(key, []);
        byRange.get(key).push(r);
      }
      if (byRange.size > 1) {
        mismatched++;
        log.log(`  ⚠️  ${outcome}: ${byRange.size} distinct fee/tick ranges — creating one target per range`);
      }

      for (const group of byRange.values()) {
        const target = group.reduce((a, b) => (b.liquidity > a.liquidity ? b : a));
        const totalLiquidity = group.reduce((s, r) => s + r.liquidity, 0n);
        if (totalLiquidity === 0n) {
          log.log(`  ⚠️  ${outcome}: zero combined liquidity — skipping`);
          continue;
        }

        const { pool } = await buildPoolFor(target, { provider, chainId });

        pools.push({
          outcome,
          market,
          positionId: target.positionId,
          mergedFrom: group.map((r) => r.positionId),
          token0: target.token0,
          token1: target.token1,
          tickLower: target.tickLower,
          tickUpper: target.tickUpper,
          currentLiquidity: target.liquidity, // liquidity of the NFT we will increase
          totalLiquidity, // combined liquidity of every NFT in this pool/range
          inRange: pool.tickCurrent > target.tickLower && pool.tickCurrent < target.tickUpper,
          pool,
        });
      }
    }

    const covered = pools.reduce((n, p) => n + p.mergedFrom.length, 0);
    log.log(`   Top-up targets              : ${pools.length}`);
    log.log(`   Source positions covered    : ${covered}/${source.length}`);
    log.log(`   Pools with mixed tick ranges: ${mismatched}`);
    log.log(`   In-range targets            : ${pools.filter((p) => p.inRange).length}/${pools.length}`);
    if (pools.length === 0) throw new Error("No pools resolved — aborting.");

    // ── Phase 0.5: solve the add multiplier `f` against the budget ────────────
    log.log("\n🧮 Phase 0.5: solving the add multiplier against the budget...\n");

    const involved = new Set([susdsLower, otherLower]);
    for (const p of pools) involved.add(p.outcome);
    const balances = new Map();
    for (const t of involved) balances.set(t, await getTokenBalance(t));
    const susdsBalance = balances.get(susdsLower);

    // amountsFor(f) → { needOutcome per token, needSUSDS total, per-pool amounts }
    function amountsFor(f) {
      const needByToken = new Map();
      let needSUSDS = 0n;
      const perPool = [];
      for (const p of pools) {
        const targetLiquidity = scaleBy(p.totalLiquidity, f);
        if (targetLiquidity <= 0n) {
          perPool.push({ p, targetLiquidity: 0n, needOutcome: 0n, needSUSDS: 0n });
          continue;
        }
        const position = new Position({
          pool: p.pool,
          tickLower: p.tickLower,
          tickUpper: p.tickUpper,
          liquidity: JSBI.BigInt(targetLiquidity.toString()),
        });
        const a0 = BigInt(position.mintAmounts.amount0.toString());
        const a1 = BigInt(position.mintAmounts.amount1.toString());
        const isToken0SUSDS = p.token0.toLowerCase() === susdsLower;
        const needO = isToken0SUSDS ? a1 : a0;
        const needS = isToken0SUSDS ? a0 : a1;
        needByToken.set(p.outcome, (needByToken.get(p.outcome) ?? 0n) + needO);
        needSUSDS += needS;
        perPool.push({ p, targetLiquidity, position, needOutcome: needO, needSUSDS: needS });
      }
      return { needByToken, needSUSDS, perPool };
    }

    // splitPosition on market A mints `splitA` of EVERY A outcome (including OTHER_TOKEN);
    // splitPosition on market B burns `splitB` OTHER_TOKEN and mints `splitB` of every B
    // outcome. So one split per market must cover the single largest per-token shortfall.
    function costFor(f) {
      const { needByToken, needSUSDS, perPool } = amountsFor(f);
      let shortA = 0n;
      let shortB = 0n;
      for (const [tok, need] of needByToken) {
        const short = bigMax(0n, need - (balances.get(tok) ?? 0n));
        if (tokenMarket.get(tok) === "A") shortA = bigMax(shortA, short);
        else shortB = bigMax(shortB, short);
      }
      const otherShort = bigMax(0n, shortB - (balances.get(otherLower) ?? 0n));
      const splitA = bigMax(shortA, otherShort);
      return { f, splitA, splitB: shortB, needSUSDS, total: splitA + needSUSDS, perPool, needByToken };
    }

    let f = 1.0;
    let cost = costFor(f);
    log.log(
      `   f=${f.toFixed(4)}  splitA=${fmt(cost.splitA)}  splitB=${fmt(cost.splitB)}  poolSUSDS=${fmt(cost.needSUSDS)}  TOTAL=${fmt(cost.total)}`
    );
    for (let i = 0; i < 6; i++) {
      if (cost.total === 0n) break;
      const next = f * (Number(TOTAL_SUSDS_BUDGET) / Number(cost.total));
      if (Math.abs(next - f) / f < 1e-6) break;
      f = next;
      cost = costFor(f);
      log.log(
        `   f=${f.toFixed(4)}  splitA=${fmt(cost.splitA)}  splitB=${fmt(cost.splitB)}  poolSUSDS=${fmt(cost.needSUSDS)}  TOTAL=${fmt(cost.total)}`
      );
    }
    // Never exceed the budget because of a rounding overshoot.
    while (cost.total > TOTAL_SUSDS_BUDGET) {
      f *= 0.999;
      cost = costFor(f);
    }

    const { splitA, splitB, needSUSDS, perPool } = cost;
    log.log(`\n📊 Plan:`);
    log.log(`   add multiplier f            : ${f.toFixed(4)}x current liquidity`);
    log.log(`   → every pool ends at        : ${(1 + f).toFixed(4)}x`);
    log.log(`   splitPosition on market A   : ${formatUnits(splitA, 18)} sUSDS`);
    log.log(`   splitPosition on market B   : ${formatUnits(splitB, 18)} ${OTHER_TOKEN}`);
    log.log(`   sUSDS deposited into pools  : ${formatUnits(needSUSDS, 18)}`);
    log.log(`   ────────────────────────────────────────────`);
    log.log(`   TOTAL sUSDS outlay          : ${formatUnits(splitA + needSUSDS, 18)}`);
    log.log(`   sUSDS balance               : ${formatUnits(susdsBalance, 18)}`);

    const ethBalance = await provider.getBalance(wallet.address);
    const txEstimate = 2 + 2 + involved.size + pools.length;
    log.log(`   ETH balance (gas)           : ${formatUnits(ethBalance, 18)} (~${txEstimate} txs to send)`);

    if (splitA + needSUSDS > susdsBalance) {
      throw new Error(`Insufficient sUSDS: need ${formatUnits(splitA + needSUSDS, 18)} — aborting.`);
    }
    // After split A the wallet holds balOther + splitA of OTHER_TOKEN; split B burns splitB.
    if (splitB > (balances.get(otherLower) ?? 0n) + splitA) {
      throw new Error(`Split A does not mint enough ${OTHER_TOKEN} for split B — aborting.`);
    }

    const router = new ethers.Contract(addr.router, RouterAbi, wallet);

    if (SKIP_SPLITS) {
      log.log("\n⏭  Phases 1-2 skipped (--skip-splits) — assuming tokens already minted.");
    } else {
      // ── Phase 1: split sUSDS → market A outcome tokens ──────────────────────
      log.log(`\n💰 Phase 1: split ${formatUnits(splitA, 18)} sUSDS on market A ${MARKET_A}`);
      if (!DRY_RUN) {
        const ct = await router.conditionalTokens();
        if (!ct || ct === ethers.ZeroAddress) {
          throw new Error("Router.conditionalTokens() is zero — wrong Router address? Aborting.");
        }
        log.log(`   Router.conditionalTokens() = ${ct}`);
        await ensureAllowance(COLLATERAL, addr.router, splitA, { wallet, log });
        await retryTransaction(() => router.splitPosition(COLLATERAL, MARKET_A, splitA), { log });
        await sleep(2000);
      } else {
        log.log("   (dry run — no split sent)");
      }

      // ── Phase 2: split OTHER_TOKEN → market B outcome tokens ────────────────
      log.log(`\n🪙 Phase 2: split ${formatUnits(splitB, 18)} of ${OTHER_TOKEN} on market B ${MARKET_B}`);
      if (!DRY_RUN) {
        if (splitB > 0n) {
          await ensureAllowance(OTHER_TOKEN, addr.router, splitB, { wallet, log });
          // collateralToken arg = base collateral (sUSDS); the Router pulls/unwraps the
          // parent outcome ERC20 because market B has a non-zero parentCollectionId.
          await retryTransaction(() => router.splitPosition(COLLATERAL, MARKET_B, splitB), { log });
          await sleep(2000);
        } else {
          log.log("   Nothing to split — existing balances already cover market B.");
        }
      } else {
        log.log("   (dry run — no split sent)");
      }
    }

    // ── Phase 3: increase liquidity on each target position ──────────────────
    log.log(`\n📈 Phase 3: increase liquidity on ${pools.length} positions\n`);

    // Spendable balance tracker. In a live run the splits already happened, so re-read
    // on-chain. In a dry run nothing was minted, so add the projected mint deltas to
    // preview realistic amounts.
    const remaining = new Map();
    for (const t of involved) {
      let bal = DRY_RUN ? balances.get(t) : await getTokenBalance(t);
      if (DRY_RUN) {
        if (t === susdsLower) bal -= splitA;
        else if (t === otherLower) bal += splitA - splitB;
        else if (tokenMarket.get(t) === "A") bal += splitA;
        else if (tokenMarket.get(t) === "B") bal += splitB;
      }
      remaining.set(t, bal);
    }
    log.log(`💰 sUSDS available for pools: ${formatUnits(remaining.get(susdsLower), 18)}`);

    // Approvals for the PositionManager (skip in dry run).
    if (!DRY_RUN) {
      log.log("\n🔑 Approving tokens for PositionManager...");
      for (const t of involved) {
        if (t === otherLower) continue; // not pooled
        const amount = t === susdsLower ? needSUSDS : (remaining.get(t) ?? 0n);
        if (amount === 0n) continue;
        await ensureAllowance(t, addr.positionManager, amount, { wallet, log });
      }
    }

    // The historical entries carry positionId with no kind/key, so key off positionId.
    const alreadyDone = new Set(progress.entries.map((e) => String(e.positionId)));

    let successCount = 0;
    let skipped = 0;
    let failed = 0;
    const belowTarget = [];

    for (const item of perPool) {
      const p = item.p;
      if (alreadyDone.has(p.positionId)) {
        log.log(`  ⏭  #${p.positionId}: already in progress log — skipping`);
        successCount++;
        continue;
      }
      if (item.targetLiquidity === 0n) {
        log.log(`  ⚠️  #${p.positionId}: target liquidity is zero — skipping`);
        skipped++;
        continue;
      }

      const t0 = p.token0.toLowerCase();
      const t1 = p.token1.toLowerCase();
      const rem0 = remaining.get(t0) ?? 0n;
      const rem1 = remaining.get(t1) ?? 0n;
      const isToken0SUSDS = t0 === susdsLower;
      const want0 = isToken0SUSDS ? item.needSUSDS : item.needOutcome;
      const want1 = isToken0SUSDS ? item.needOutcome : item.needSUSDS;

      let positionToUse = item.position;
      let use0 = want0;
      let use1 = want1;

      if (rem0 < want0 || rem1 < want1) {
        if (rem0 === 0n || rem1 === 0n) {
          log.log(`  ⚠️  #${p.positionId}: one token exhausted — skipping`);
          skipped++;
          continue;
        }
        const capped0 = rem0 < want0 ? rem0 : want0;
        const capped1 = rem1 < want1 ? rem1 : want1;
        positionToUse = Position.fromAmounts({
          pool: p.pool,
          tickLower: p.tickLower,
          tickUpper: p.tickUpper,
          amount0: capped0.toString(),
          amount1: capped1.toString(),
          useFullPrecision: true,
        });
        if (JSBI.equal(positionToUse.liquidity, JSBI.BigInt(0))) {
          log.log(`  ⚠️  #${p.positionId}: capped amounts yield zero liquidity — skipping`);
          skipped++;
          continue;
        }
        use0 = BigInt(positionToUse.mintAmounts.amount0.toString());
        use1 = BigInt(positionToUse.mintAmounts.amount1.toString());
      }

      // Pool-level ratio: the add lands on one NFT but the pool's combined liquidity is
      // what we are scaling by (1 + f).
      const addedLiquidity = BigInt(positionToUse.liquidity.toString());
      const ratio = Number(p.totalLiquidity + addedLiquidity) / Number(p.totalLiquidity);
      if (ratio < 1 + f * 0.99) belowTarget.push({ positionId: p.positionId, ratio: ratio.toFixed(3) });

      log.log(
        `\n--- #${p.positionId} [${p.market}] ${p.outcome} | token0=${formatUnits(use0, 18)} token1=${formatUnits(use1, 18)}` +
          ` | pool ends at ${ratio.toFixed(3)}x ---`
      );

      if (DRY_RUN) {
        remaining.set(t0, rem0 - use0);
        remaining.set(t1, rem1 - use1);
        successCount++;
        continue;
      }

      try {
        const { calldata, value } = NonfungiblePositionManager.addCallParameters(positionToUse, {
          tokenId: p.positionId, // triggers increaseLiquidity
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
          positionId: p.positionId,
          kind: "increase",
          key: p.positionId,
          outcomeToken: p.outcome,
          market: p.market,
          token0: p.token0,
          token1: p.token1,
          amount0Desired: use0.toString(),
          amount1Desired: use1.toString(),
          addedLiquidity: addedLiquidity.toString(),
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
        });
        successCount++;
        log.log(`  ✅ Saved to ${progress.path}`);
      } catch (err) {
        failed++;
        log.error(`  ❌ Failed for #${p.positionId}: ${err.shortMessage || err.message}`);
      }
      await sleep(2000);
    }

    log.log(`\n🎯 Target check: ${perPool.length - belowTarget.length}/${perPool.length} pools reach ${(1 + f).toFixed(3)}x.`);
    if (belowTarget.length > 0) {
      log.log(`   ⚠️  ${belowTarget.length} below target:`);
      for (const b of belowTarget) log.log(`      #${b.positionId}: ${b.ratio}x`);
    }

    log.log(`\n🎉 Done! ${successCount} processed, ${skipped} skipped, ${failed} failed.${DRY_RUN ? "" : ` See ${progress.path}.`}`);
    return { f, targets: pools.length, processed: successCount, skipped, failed };
  }
);
