// Withdraw 100% of the liquidity this wallet holds in the Zcash NU7 coinholder-poll
// pools on Optimism, and collect the accrued fees in the same transaction.
//
// Scope is resolved FROM CHAIN: every wrapped token of every market in the creation
// log, paired against sUSDS. Invalid is included even though seeding never pooled it,
// so that "withdraw all" stays true if an Invalid pool is ever added by hand.
//
// This returns outcome tokens + sUSDS to the wallet. It does NOT convert the outcome
// tokens back to sUSDS — that is merge-zcash-nu7-positions.js.
//
//   node withdraw-zcash-nu7-liquidity.js          # dry: lists every matched position
//   node withdraw-zcash-nu7-liquidity.js --live   # sends, after a confirmation

import { ethers } from "ethers";
import fs from "fs";
import { runBatched } from "../../lib/batch.js";
import { assertMarket, getMarketInfo, makeMarketView } from "../../lib/market.js";
import {
  classifyPositions,
  collectFees,
  enumerateWalletPositions,
  matchPositions,
  withdrawPosition,
  POSITION_MANAGER_ABI,
} from "../../lib/positions.js";
import { run } from "../../lib/run.js";
import { pairKey } from "../../lib/ticks.js";
import { retryTransaction, sleep } from "../../lib/tx.js";

const DELAY_MS = 2000;

await run(
  { name: "withdraw-zcash-nu7-liquidity", slug: "zcash-nu7", stage: "unwind-withdraw", mutating: true },
  async (ctx) => {
    const { manifest, provider, wallet, chainId, addr, log, progress, dry } = ctx;
    const collateral = manifest.chain.collateral.address;

    log.log(`\n📋 Wallet  : ${wallet.address}`);

    const marketsFile = manifest.files.markets;
    if (!fs.existsSync(marketsFile)) throw new Error(`${marketsFile} not found — nothing to withdraw from.`);
    const markets = JSON.parse(fs.readFileSync(marketsFile, "utf8"));
    if (!markets.length) throw new Error(`${marketsFile} is empty.`);

    // ── Step 1: resolve every outcome token from chain, not from the log ──────
    log.log(`\n🔍 Step 1: resolving outcome tokens for ${markets.length} markets...`);
    const marketView = makeMarketView(addr.marketView, provider);
    const byPair = new Map();

    for (const m of markets) {
      const info = await getMarketInfo(marketView, addr.marketFactory, m.market);
      const labels = m.outcomes ?? [];
      // A length mismatch means the log and the chain disagree, which invalidates
      // the whole scope derivation.
      await assertMarket(info, {
        label: `[${m.shortName}]`,
        collateral,
        outcomeCount: labels.length,
        loggedWrappedTokens: m.wrappedTokens,
      });
      info.wrappedTokens.forEach((tok, i) => {
        byPair.set(pairKey(tok, collateral), {
          id: m.id,
          shortName: m.shortName,
          market: m.market,
          slot: i,
          side: labels[i] ?? `slot${i}`,
          outcomeToken: tok,
        });
      });
    }
    log.log(`   ${byPair.size} candidate pools (all outcome slots incl. Invalid, ${markets.length} markets)`);

    // ── Step 2: enumerate wallet positions, filter to ours ────────────────────
    log.log("\n🔍 Step 2: scanning wallet positions...");
    const positionManager = new ethers.Contract(addr.positionManager, POSITION_MANAGER_ABI, wallet);
    const balance = await positionManager.balanceOf(wallet.address);
    log.log(`   Wallet holds ${Number(balance)} position NFTs.`);

    const positionsData = await enumerateWalletPositions(positionManager, wallet.address, {
      batchSize: 20,
      pauseMs: 1000,
    });
    const matched = matchPositions(positionsData, byPair);
    // THREE buckets, not two. A position at zero liquidity can still hold
    // uncollected fees, and this lineage used to just warn about those.
    const { withLiquidity, emptyWithFees, emptyClean } = classifyPositions(matched);

    log.log(`   Matched ${matched.length} NU7 positions — ${withLiquidity.length} with liquidity > 0.\n`);
    for (const { tokenId, pos, meta } of withLiquidity) {
      log.log(
        `   #${tokenId.toString().padEnd(7)} [${String(meta.id).padStart(2)}] ` +
          `${meta.shortName.padEnd(4)} ${meta.side.slice(0, 42).padEnd(42)} liquidity ${pos.liquidity.toString()}`
      );
    }
    if (emptyWithFees.length) {
      log.log(
        `\n   💸 ${emptyWithFees.length} position(s) are at zero liquidity but still hold uncollected fees —` +
          `\n      these are SWEPT in step 4. This lineage used to only warn about them.`
      );
    }
    if (emptyClean.length) {
      log.log(`   ℹ️  ${emptyClean.length} matched position(s) are empty and clean — nothing to do.`);
    }

    if (withLiquidity.length === 0 && emptyWithFees.length === 0) {
      log.log("\n✅ Nothing to withdraw — no NU7 positions with liquidity or owed fees.");
      return { matched: matched.length, withdrawn: 0, swept: 0 };
    }
    if (dry) {
      return { matched: matched.length, toWithdraw: withLiquidity.length, toSweep: emptyWithFees.length };
    }

    // ── Step 3: remove 100% liquidity + collect ───────────────────────────────
    log.log(`\n📉 Step 3: withdrawing ${withLiquidity.length} positions\n`);
    let successCount = 0;

    for (const { tokenId, pos, meta } of withLiquidity) {
      const key = tokenId.toString();
      if (progress.has("remove", key)) {
        log.log(`  ⏭  #${key}: already in progress log`);
        successCount++;
        continue;
      }
      log.log(`\n--- #${key} [${meta.id}] ${meta.shortName} ${meta.side} ---`);
      try {
        const entry = await withdrawPosition(tokenId, pos, {
          wallet,
          provider,
          chainId,
          positionManagerAddress: addr.positionManager,
          burnNft: manifest.unwind?.burnNft ?? false,
          retry: (fn) => retryTransaction(fn, { log }),
        });
        progress.append({
          kind: "remove",
          key,
          positionId: key,
          id: meta.id,
          shortName: meta.shortName,
          market: meta.market,
          slot: meta.slot,
          side: meta.side,
          outcomeToken: meta.outcomeToken,
          ...entry,
        });
        successCount++;
        log.log(`  ✅ Saved to ${progress.path}`);
      } catch (err) {
        log.error(`  ❌ Failed for #${key}: ${err.shortMessage || err.message}`);
      }
      await sleep(DELAY_MS);
    }

    // ── Step 4: sweep fees off positions that were already empty ─────────────
    // withdrawPosition collects as part of the burn, so these are the only ones
    // whose fees would otherwise be left on the table.
    let sweptCount = 0;
    if (emptyWithFees.length) {
      log.log(`\n🧹 Step 4: collecting fees from ${emptyWithFees.length} already-empty position(s)\n`);
      for (const { tokenId, meta } of emptyWithFees) {
        const key = tokenId.toString();
        if (progress.has("collect", key)) {
          log.log(`  ⏭  #${key}: already in progress log`);
          sweptCount++;
          continue;
        }
        log.log(`\n--- collect #${key} [${meta.id}] ${meta.shortName} ${meta.side} ---`);
        try {
          const entry = await collectFees(tokenId, {
            positionManager,
            wallet,
            retry: (fn) => retryTransaction(fn, { log }),
          });
          progress.append({
            kind: "collect",
            key,
            positionId: key,
            id: meta.id,
            shortName: meta.shortName,
            market: meta.market,
            outcomeToken: meta.outcomeToken,
            ...entry,
          });
          sweptCount++;
          log.log(`  ✅ Saved to ${progress.path}`);
        } catch (err) {
          log.error(`  ❌ Collect failed for #${key}: ${err.shortMessage || err.message}`);
        }
        await sleep(DELAY_MS);
      }
    }

    log.log(`\n🎉 Done! ${successCount}/${withLiquidity.length} positions withdrawn, ${sweptCount} swept. See ${progress.path}.`);
    log.log(
      "   The wallet now holds the outcome tokens + sUSDS. To convert the outcome\n" +
        "   tokens back to sUSDS, merge a full set per market (Router.mergePositions)."
    );
    return { withdrawn: successCount };
  }
);
