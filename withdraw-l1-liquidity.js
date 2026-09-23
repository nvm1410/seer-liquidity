// Withdraw 100% of the liquidity this wallet holds in the "L1" outcome-token / sUSDS
// pools on Optimism (chain 10), collecting accrued fees in the same transaction.
//
// The L1 pools are fed by TWO nested markets:
//   Market A (top-level, sUSDS collateral)      - 68 outcomes, 67 pooled vs sUSDS
//   Market B (conditional on A's outcome #66)   - 33 outcomes, all 33 pooled vs sUSDS
// A's outcome #66 (the "Other repositories..." token) is the only A outcome with no
// sUSDS pool - its whole supply was split into Market B.
//
// Scope is resolved FROM CHAIN via MarketView, and positions are discovered by
// enumerating the wallet's ERC-721 balance - not from a hard-coded tokenId list - so
// anything minted after execution.json was written is still caught. execution.json is
// used only as a cross-check.
//
// This returns outcome tokens + sUSDS to the wallet. It does NOT convert the outcome
// tokens back to sUSDS - that is merge-l1-positions.js (B first, then A).
//
//   node withdraw-l1-liquidity.js --resume          # dry: lists every matched position
//   node withdraw-l1-liquidity.js --resume --live   # sends, after a confirmation
//
// --resume is required because the progress file IS the historical record that
// verify-l1-unwind.js reads (manifest files.withdraw, 198 entries from the live
// run of 2026-08-25). The guard is asking you to acknowledge it, not warning you.

import { ethers } from "ethers";
import fs from "fs";
import { formatUnits } from "viem";
import { assertMarket, getMarketInfo, makeMarketView } from "./lib/market.js";
import {
  classifyPositions,
  collectFees,
  enumerateWalletPositions,
  matchPositions,
  projectReturns,
  scopeByPair,
  withdrawPosition,
  POSITION_MANAGER_ABI,
} from "./lib/positions.js";
import { run } from "./lib/run.js";
import { retryTransaction, sleep } from "./lib/tx.js";

const DELAY_MS = 2000;

await run(
  {
    name: "withdraw-l1-liquidity",
    slug: "l1-deepfunding",
    stage: "unwind-withdraw",
    mutating: true,
    progress: (m) => m.files.withdraw,
  },
  async (ctx) => {
    const { manifest, provider, wallet, chainId, addr, log, progress, dry: DRY_RUN } = ctx;

    const COLLATERAL = manifest.chain.collateral.address;
    const [MARKET_A, MARKET_B] = manifest.results.marketAddresses;
    const OTHER_TOKEN = manifest.settle.catchAllOutcome.token;
    const PARENT_OUTCOME = manifest.settle.catchAllOutcome.index;
    const BURN_NFT = manifest.unwind?.burnNft ?? false;
    const COLLECT_EMPTY = manifest.unwind?.collectEmpty ?? true;
    const SOURCE_FILE = manifest.files.baseline;

    log.log(`\n📋 Wallet  : ${wallet.address}`);
    log.log(`📋 DRY_RUN : ${DRY_RUN}  |  BURN_NFT: ${BURN_NFT}  |  COLLECT_EMPTY: ${COLLECT_EMPTY}`);

    const susdsLower = COLLATERAL.toLowerCase();
    const otherLower = OTHER_TOKEN.toLowerCase();

    // ── Step 1: resolve both markets from chain ───────────────────────────────
    log.log("\n🔍 Step 1: resolving markets A and B from chain...");
    const marketView = makeMarketView(addr.marketView, provider);
    const mA = await getMarketInfo(marketView, addr.marketFactory, MARKET_A);
    const mB = await getMarketInfo(marketView, addr.marketFactory, MARKET_B);

    await assertMarket(mA, { label: "Market A", collateral: COLLATERAL, topLevel: true });
    await assertMarket(mB, { label: "Market B", parentMarket: MARKET_A, parentOutcome: PARENT_OUTCOME });
    // getMarketInfo resolves the parent for us, so this is the same check the
    // original made by hand against mA.wrappedTokens[mB.parentOutcome].
    if (mB.parentOutcomeToken?.toLowerCase() !== otherLower) {
      throw new Error(`Market B's parent outcome token is not ${OTHER_TOKEN}`);
    }
    log.log(`   Market A ${MARKET_A}: ${mA.wrappedTokens.length} outcomes`);
    log.log(`   Market B ${MARKET_B}: ${mB.wrappedTokens.length} outcomes (parentOutcome ${mB.parentOutcomeIndex})`);

    // pairKey(outcome, sUSDS) → metadata. OTHER_TOKEN has no pool; harmless to include.
    const byPair = scopeByPair(
      [
        { label: "A", address: MARKET_A, wrappedTokens: mA.wrappedTokens, outcomes: mA.outcomes },
        { label: "B", address: MARKET_B, wrappedTokens: mB.wrappedTokens, outcomes: mB.outcomes },
      ],
      COLLATERAL
    );
    log.log(`   ${byPair.size} candidate pools (all outcomes of A + B vs sUSDS)`);

    // ── Step 2: discover positions by ERC-721 enumeration ─────────────────────
    log.log("\n🔍 Step 2: scanning wallet positions...");
    const positionManager = new ethers.Contract(addr.positionManager, POSITION_MANAGER_ABI, wallet);
    const balance = await positionManager.balanceOf(wallet.address);
    log.log(`   Wallet holds ${Number(balance)} position NFTs.`);

    const positionsData = await enumerateWalletPositions(positionManager, wallet.address, {
      batchSize: 20,
      pauseMs: 1000,
    });
    const matched = matchPositions(positionsData, byPair);
    const { withLiquidity, emptyWithFees, emptyClean } = classifyPositions(matched);

    const countA = matched.filter((x) => x.meta.market === "A").length;
    const countB = matched.filter((x) => x.meta.market === "B").length;
    const distinctPools = new Set(matched.map((x) => x.meta.outcomeToken.toLowerCase())).size;
    log.log(
      `   Matched ${matched.length} L1 positions (A: ${countA}, B: ${countB}) across ${distinctPools} distinct pools\n` +
        `   ${withLiquidity.length} with liquidity > 0 | ${emptyWithFees.length} empty with uncollected fees | ${emptyClean.length} empty and clean`
    );

    // ── Step 2b: cross-check against the known 198 from execution.json ────────
    if (fs.existsSync(SOURCE_FILE)) {
      const source = JSON.parse(fs.readFileSync(SOURCE_FILE, "utf8"));
      const known = new Set(source.map((e) => String(e.positionId)));
      const found = new Set(matched.map((x) => x.tokenId.toString()));
      const missing = [...known].filter((id) => !found.has(id));
      const extra = [...found].filter((id) => !known.has(id));
      log.log(`\n   Cross-check vs ./${SOURCE_FILE} (${known.size} known L1 positions):`);
      log.log(`     missing from wallet/scan : ${missing.length}${missing.length ? " → " + missing.join(", ") : ""}`);
      log.log(`     found but not in file    : ${extra.length}${extra.length ? " → " + extra.join(", ") : ""}`);
    }

    if (withLiquidity.length === 0 && emptyWithFees.length === 0) {
      log.log("\n✅ Nothing to withdraw — no L1 positions with liquidity or owed fees.");
      return { matched: matched.length, withdrawn: 0, swept: 0 };
    }

    // ── Step 3: projected returns (drives the dry-run decision) ───────────────
    log.log("\n🔍 Step 3: computing projected returns...");
    const { byToken: projected, totalLiquidity } = await projectReturns(
      { withLiquidity, emptyWithFees },
      { provider, chainId }
    );

    const f = (v) => Number(formatUnits(v, 18)).toFixed(4).padStart(14);
    log.log("\n    tokenId   mkt  #   outcome                        liquidity      outcome-out       sUSDS-out");
    for (const item of [...withLiquidity, ...emptyWithFees]) {
      const isT0Susds = item.pos.token0.toLowerCase() === susdsLower;
      const p = item.projected ?? { out0: 0n, out1: 0n };
      const outcomeOut = (isT0Susds ? p.out1 : p.out0) + (isT0Susds ? item.pos.tokensOwed1 : item.pos.tokensOwed0);
      const susdsOut = (isT0Susds ? p.out0 : p.out1) + (isT0Susds ? item.pos.tokensOwed0 : item.pos.tokensOwed1);
      log.log(
        `   ${item.tokenId.toString().padEnd(9)} ${item.meta.market}  ${String(item.meta.index).padStart(2)}  ` +
          `${item.meta.name.slice(0, 28).padEnd(28)}${f(item.pos.liquidity)}${f(outcomeOut)}${f(susdsOut)}`
      );
    }

    const susdsOutTotal = projected.get(susdsLower) ?? 0n;
    let outcomeOutTotal = 0n;
    for (const [k, v] of projected) if (k !== susdsLower) outcomeOutTotal += v;
    log.log(
      `\n   Total liquidity to remove : ${formatUnits(totalLiquidity, 18)}\n` +
        `   sUSDS returned directly   : ${formatUnits(susdsOutTotal, 18)}\n` +
        `   Outcome tokens returned   : ${formatUnits(outcomeOutTotal, 18)} across ${projected.size - 1} tokens\n` +
        `   (the outcome tokens convert to sUSDS only via merge-l1-positions.js, capped by\n` +
        `    the smallest balance in each market's full outcome set)`
    );

    if (DRY_RUN) {
      return { matched: matched.length, toWithdraw: withLiquidity.length, toSweep: emptyWithFees.length };
    }

    // ── Step 4: remove 100% liquidity + collect ───────────────────────────────
    // The 198 historical entries carry `positionId` but no kind/key — they predate
    // that convention — so progress.has() would read the whole log as empty and
    // re-withdraw everything. Key off positionId, exactly as the original did.
    const alreadyDone = new Set(progress.entries.map((e) => String(e.positionId)));

    log.log(`\n📉 Step 4: withdrawing ${withLiquidity.length} positions\n`);
    let successCount = 0;
    let failCount = 0;
    for (const { tokenId, pos, meta } of withLiquidity) {
      const id = tokenId.toString();
      if (alreadyDone.has(id)) {
        log.log(`  ⏭  #${id}: already in progress log`);
        successCount++;
        continue;
      }
      log.log(`\n--- #${id} [${meta.market}${meta.index}] ${meta.name.slice(0, 40)} ---`);
      try {
        const entry = await withdrawPosition(tokenId, pos, {
          wallet,
          provider,
          chainId,
          positionManagerAddress: addr.positionManager,
          burnNft: BURN_NFT,
          retry: (fn) => retryTransaction(fn, { log }),
        });
        progress.append({
          positionId: id,
          kind: "remove",
          key: id,
          market: meta.market,
          marketAddress: meta.marketAddress,
          outcomeIndex: meta.index,
          outcomeToken: meta.outcomeToken,
          ...entry,
        });
        successCount++;
        log.log(`  ✅ Saved to ${progress.path}`);
      } catch (err) {
        failCount++;
        log.error(`  ❌ Failed for #${id}: ${err.shortMessage || err.message}`);
      }
      await sleep(DELAY_MS);
    }

    // ── Step 5: sweep fees off positions that were already empty ──────────────
    if (COLLECT_EMPTY && emptyWithFees.length) {
      log.log(`\n🧹 Step 5: collecting fees from ${emptyWithFees.length} already-empty position(s)\n`);
      for (const { tokenId, meta } of emptyWithFees) {
        const id = tokenId.toString();
        if (alreadyDone.has(id)) {
          log.log(`  ⏭  #${id}: already in progress log`);
          continue;
        }
        log.log(`\n--- collect #${id} [${meta.market}${meta.index}] ---`);
        try {
          const entry = await collectFees(tokenId, {
            positionManager,
            wallet,
            retry: (fn) => retryTransaction(fn, { log }),
          });
          progress.append({
            positionId: id,
            kind: "collect",
            key: id,
            market: meta.market,
            outcomeToken: meta.outcomeToken,
            ...entry,
          });
          log.log(`  ✅ Saved to ${progress.path}`);
        } catch (err) {
          failCount++;
          log.error(`  ❌ Collect failed for #${id}: ${err.shortMessage || err.message}`);
        }
        await sleep(DELAY_MS);
      }
    }

    log.log(`\n🎉 Done! ${successCount}/${withLiquidity.length} positions withdrawn, ${failCount} failure(s).`);
    log.log(`   Progress: ${progress.path}`);
    log.log(
      "   The wallet now holds A/B outcome tokens + sUSDS. Next: node merge-l1-positions.js\n" +
        "   (merges Market B first — it mints the 'Other repositories' token Market A needs.)"
    );
    if (failCount) log.log("   Re-run to retry the failures — completed positions are skipped.");
    return { withdrawn: successCount, failed: failCount };
  }
);
