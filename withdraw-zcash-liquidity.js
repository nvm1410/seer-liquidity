// Withdraw 100% of the liquidity this wallet holds in the Zcash Q3 2026 CDRGP
// pools on Optimism, and collect the accrued fees in the same transaction.
//
// Scope is resolved FROM CHAIN: every wrapped token of every market in the creation
// log, paired against sUSDS. Invalid is included even though seeding never pooled it,
// so that "withdraw all" stays true if an Invalid pool is ever added by hand.
//
// This returns outcome tokens + sUSDS to the wallet. It does NOT convert the outcome
// tokens back to sUSDS — that is merge-zcash-positions.js.
//
//   node withdraw-zcash-liquidity.js          # dry: lists every matched position
//   node withdraw-zcash-liquidity.js --live   # sends, after a confirmation

import { ethers } from "ethers";
import fs from "fs";
import { assertMarket, getMarketInfo, makeMarketView } from "./lib/market.js";
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
const SIDES = ["YES", "NO", "Invalid"];

await run(
  { name: "withdraw-zcash-liquidity", slug: "zcash-q3", stage: "unwind-withdraw", mutating: true },
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
      await assertMarket(info, {
        label: `[${m.shortName}]`,
        collateral,
        outcomeCount: 3, // YES, NO, Invalid
        loggedWrappedTokens: m.wrappedTokens,
      });
      info.wrappedTokens.forEach((tok, i) => {
        byPair.set(pairKey(tok, collateral), {
          id: m.id,
          shortName: m.shortName,
          market: m.market,
          slot: i,
          side: SIDES[i] ?? `slot${i}`,
          outcomeToken: tok,
        });
      });
    }
    log.log(`   ${byPair.size} candidate pools (YES + NO + Invalid across ${markets.length} markets)`);

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
    const withLiquidity = matched.filter((x) => x.pos.liquidity > 0n);
    const empty = matched.filter((x) => x.pos.liquidity === 0n);

    log.log(`   Matched ${matched.length} Zcash positions — ${withLiquidity.length} with liquidity > 0.\n`);
    for (const { tokenId, pos, meta } of withLiquidity) {
      log.log(
        `   #${tokenId.toString().padEnd(7)} [${String(meta.id).padStart(2)}] ` +
          `${meta.shortName.padEnd(15)} ${meta.side.padEnd(7)} liquidity ${pos.liquidity.toString()}`
      );
    }
    if (empty.length) {
      log.log(
        `\n   ℹ️  ${empty.length} matched position(s) already have zero liquidity and are skipped.` +
          `\n      Any residual uncollected fees on those must be collected separately.`
      );
    }

    if (withLiquidity.length === 0) {
      log.log("\n✅ Nothing to withdraw — no Zcash positions with liquidity.");
      return { matched: matched.length, withdrawn: 0 };
    }
    if (dry) return { matched: matched.length, toWithdraw: withLiquidity.length };

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

    log.log(`\n🎉 Done! ${successCount}/${withLiquidity.length} positions withdrawn. See ${progress.path}.`);
    log.log(
      "   The wallet now holds the outcome tokens + sUSDS. To convert the outcome\n" +
        "   tokens back to sUSDS, merge a full set per market (Router.mergePositions)."
    );
    return { withdrawn: successCount };
  }
);
