// Withdraw 100% of the liquidity this wallet holds in the Octant epoch-12 pools
// on Optimism, collecting accrued fees in the same transaction.
//
// Scope covers ALL outcome slots including Invalid, because this campaign
// deliberately seeded an Invalid pool too: the main seed drops it, and
// add-octant-invalid-liquidity.js then deploys the split's idle Invalid tokens
// into a 26th pool.
//
// This returns outcome tokens + sUSDS to the wallet; it does not convert them.
//
//   node withdraw-octant-liquidity.js          # dry: lists every matched position
//   node withdraw-octant-liquidity.js --live   # sends, after a confirmation

import { ethers } from "ethers";
import { getMarketInfo, makeMarketView } from "./lib/market.js";
import {
  enumerateWalletPositions,
  matchPositions,
  withdrawPosition,
  POSITION_MANAGER_ABI,
} from "./lib/positions.js";
import { run } from "./lib/run.js";
import { pairKey } from "./lib/ticks.js";
import { retryTransaction, sleep } from "./lib/tx.js";

const DELAY_MS = 2000;

await run(
  { name: "withdraw-octant-liquidity", slug: "octant", stage: "unwind-withdraw", mutating: true },
  async (ctx) => {
    const { manifest, provider, wallet, chainId, addr, log, progress, dry } = ctx;
    const collateral = manifest.chain.collateral.address;
    const market = manifest.results.parent;

    log.log(`\n📋 Wallet  : ${wallet.address}`);
    log.log(`📋 Market  : ${market}\n`);

    // ── Step 1: resolve octant outcome tokens from chain ──────────────────────
    log.log("🔍 Step 1: resolving octant market & outcome tokens...");
    const marketView = makeMarketView(addr.marketView, provider);
    const info = await getMarketInfo(marketView, addr.marketFactory, market);
    if (info.collateralToken.toLowerCase() !== collateral.toLowerCase()) {
      throw new Error(`Collateral ${info.collateralToken} != sUSDS ${collateral}.`);
    }
    const outcomeTokens = info.wrappedTokens; // ALL outcomes incl. Invalid
    log.log(`   Market "${info.name}" | ${outcomeTokens.length} outcome tokens (incl. Invalid)`);

    const byPair = new Map();
    outcomeTokens.forEach((tok, i) => {
      byPair.set(pairKey(tok, collateral), {
        index: i,
        outcomeToken: tok,
        name: info.outcomes[i] ?? `outcome${i}`,
      });
    });

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
    const octant = matched.filter((x) => x.pos.liquidity > 0n);

    log.log(`   Matched ${octant.length} octant positions with liquidity > 0.\n`);
    for (const { tokenId, pos, meta } of octant) {
      log.log(`   #${tokenId.toString()}  outcome ${meta.outcomeToken}  liquidity ${pos.liquidity.toString()}`);
    }

    if (octant.length === 0) {
      log.log("\n✅ Nothing to withdraw — no octant positions with liquidity.");
      return { matched: matched.length, withdrawn: 0 };
    }
    if (dry) return { matched: matched.length, toWithdraw: octant.length };

    // ── Step 3: remove 100% liquidity + collect ───────────────────────────────
    log.log(`\n📉 Step 3: withdrawing ${octant.length} positions\n`);
    let successCount = 0;

    for (const { tokenId, pos, meta } of octant) {
      const key = tokenId.toString();
      if (progress.has("remove", key)) {
        log.log(`  ⏭  #${key}: already in progress log`);
        successCount++;
        continue;
      }
      log.log(`\n--- Position #${key} ---`);
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
          index: meta.index,
          name: meta.name,
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

    log.log(`\n🎉 Done! ${successCount}/${octant.length} positions withdrawn. See ${progress.path}.`);
    return { withdrawn: successCount };
  }
);
