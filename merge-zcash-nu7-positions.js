// Convert the Zcash NU7 coinholder-poll outcome tokens sitting in the wallet back
// into sUSDS, on Optimism (chain 10). Run this AFTER withdraw-zcash-nu7-liquidity.js —
// that script returns outcome tokens + sUSDS to the wallet but deliberately stops there.
//
// Merging needs a COMPLETE set: every outcome slot plus Invalid. Invalid was never
// pooled, but every split minted it, so it is already in the wallet (src/Router.sol
// _mergePositions / getPartition). The mergeable amount per market is the MIN balance
// across the whole set — if a market traded, the surplus sides are left over in the
// wallet and stay there until the market resolves.
//
//   node merge-zcash-nu7-positions.js            # dry: prints the full table, sends nothing
//   node merge-zcash-nu7-positions.js --live     # sends, after a confirmation
//
// No gate: an unwind returns capital rather than committing it, so the confirmation
// prompt and the per-market table are the review step. A fresh progress file per
// round is enforced by the harness — reusing the previous round's would skip every
// market and report success.

import { ethers } from "ethers";
import fs from "fs";
import { erc20Abi, formatUnits } from "viem";
import { RouterAbi } from "./abis/RouterAbi.js";
import { runBatched } from "./lib/batch.js";
import { assertMarket, getMarketInfo, makeMarketView } from "./lib/market.js";
import { run } from "./lib/run.js";
import { planMerge, readBalances } from "./lib/settle.js";
import { ensureAllowance, retryTransaction, sleep } from "./lib/tx.js";

const DELAY_MS = 2000;

await run(
  { name: "merge-zcash-nu7-positions", slug: "zcash-nu7", stage: "unwind-merge", mutating: true },
  async (ctx) => {
    const { manifest, provider, wallet, chainId, addr, log, progress, dry } = ctx;
    const collateral = manifest.chain.collateral.address;
    const owner = wallet.address;

    log.log(`\n📋 Wallet  : ${owner}`);

    const marketsFile = manifest.files.markets;
    if (!fs.existsSync(marketsFile)) throw new Error(`${marketsFile} not found — nothing to merge.`);
    const markets = JSON.parse(fs.readFileSync(marketsFile, "utf8"));
    if (!markets.length) throw new Error(`${marketsFile} is empty.`);

    const router = new ethers.Contract(addr.router, RouterAbi, wallet);
    const ct = await router.conditionalTokens();
    if (!ct || ct === ethers.ZeroAddress) throw new Error("Router.conditionalTokens() is zero — wrong Router?");

    // ── Step 1: resolve the full outcome set from chain and read balances ─────
    log.log(`\n🔍 Step 1: resolving ${markets.length} markets and reading balances...`);
    const marketView = makeMarketView(addr.marketView, provider);

    const entries = await runBatched(
      markets,
      async (m) => {
        const info = await getMarketInfo(marketView, addr.marketFactory, m.market);
        // Categorical: n outcomes + Invalid, n varies per market. The creation log
        // is a RECORD, not a source of truth, so cross-check it against chain.
        const labels = m.outcomes ?? [];
        await assertMarket(info, {
          label: `[${m.shortName}]`,
          collateral,
          outcomeCount: labels.length,
          loggedWrappedTokens: m.wrappedTokens,
        });
        const set = info.wrappedTokens; // [...outcomes, Invalid]
        const balances = await readBalances(set, { provider, owner });
        return { id: m.id, shortName: m.shortName, market: m.market, labels, set, balances, ...planMerge(balances) };
      },
      { batchSize: 8, pauseMs: 500 }
    );

    // ── Step 2: the table ─────────────────────────────────────────────────────
    const f = (v) => Number(formatUnits(v, 18)).toFixed(4).padStart(13);
    let totalMerge = 0n;
    let totalLeftover = 0n;
    let blocked = 0;

    for (const e of entries) {
      totalMerge += e.amount;
      totalLeftover += e.stranded;
      if (e.blocked) blocked++;
      log.log(`\n   [${e.id}] ${e.shortName} — ${e.set.length} slots`);
      e.balances.forEach((b, i) => {
        const surplus = b - e.amount;
        log.log(
          `        ${f(b)}  ${e.labels[i].slice(0, 48).padEnd(48)}` +
            (surplus > 0n ? `  (+${Number(formatUnits(surplus, 18)).toFixed(4)} leftover)` : "")
        );
      });
      log.log(
        `        ${f(e.amount)}  ${"MERGEABLE (min of the set)".padEnd(48)}` +
          (e.blocked ? "  ⚠️  one slot is zero — cannot merge" : "")
      );
    }

    const susds = new ethers.Contract(collateral, erc20Abi, provider);
    const susdsBefore = await susds.balanceOf(owner);
    log.log(
      `\n   Recoverable  : ${formatUnits(totalMerge, 18)} sUSDS over ${entries.length} markets\n` +
        `   Stranded     : ${formatUnits(totalLeftover, 18)} outcome tokens (imbalance from trading)\n` +
        `   sUSDS now    : ${formatUnits(susdsBefore, 18)}\n` +
        `   sUSDS after  : ${formatUnits(susdsBefore + totalMerge, 18)}`
    );
    if (blocked) log.log(`   ⚠️  ${blocked} market(s) have a zero outcome balance and are skipped.`);

    if (dry) return { markets: entries.length, recoverable: totalMerge.toString(), blocked };

    // ── Step 3: merge, market by market ───────────────────────────────────────
    log.log(`\n🔀 Step 3: merging ${entries.length - blocked} markets\n`);
    let successCount = 0;

    for (const e of entries) {
      if (e.blocked) continue;
      if (progress.has("merge", e.market.toLowerCase())) {
        log.log(`  ⏭  [${e.id}] ${e.shortName}: already in progress log`);
        successCount++;
        continue;
      }
      log.log(`\n--- [${e.id}] ${e.shortName} — merging ${formatUnits(e.amount, 18)} ---`);
      try {
        // Approve every slot in the set: mergePositions burns all of them.
        for (const token of e.set) {
          await ensureAllowance(token, addr.router, e.amount, { wallet, log });
        }
        // Argument 0 is the BASE collateral even for a conditional market — the
        // Router derives the partition from the market's parentCollectionId.
        const receipt = await retryTransaction(() => router.mergePositions(collateral, e.market, e.amount), { log });
        progress.append({
          kind: "merge",
          key: e.market.toLowerCase(),
          id: e.id,
          shortName: e.shortName,
          market: e.market,
          wrappedTokens: e.set,
          balances: e.balances.map((b) => b.toString()),
          merged: e.amount.toString(),
          leftover: e.stranded.toString(),
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
        });
        successCount++;
        log.log(`  ✅ Saved to ${progress.path}`);
      } catch (err) {
        log.error(`  ❌ Failed for ${e.shortName}: ${err.shortMessage || err.message}`);
      }
      await sleep(DELAY_MS);
    }

    const susdsAfter = await susds.balanceOf(owner);
    log.log(`\n🎉 Done! ${successCount}/${entries.length - blocked} markets merged.`);
    log.log(
      `   sUSDS ${formatUnits(susdsBefore, 18)} → ${formatUnits(susdsAfter, 18)} ` +
        `(+${formatUnits(susdsAfter - susdsBefore, 18)})`
    );
    if (successCount < entries.length - blocked) {
      log.log("   Re-run with --resume to retry the failures — merged markets are skipped.");
    }
    return { merged: successCount, recovered: (susdsAfter - susdsBefore).toString() };
  }
);
