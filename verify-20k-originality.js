// Read-only checker for add-20k-originality-liquidity.js.
// Confirms every expected position was processed, its increaseLiquidity tx
// actually succeeded on-chain, and it now holds non-zero liquidity.
//
// Scope comes from the MAP CACHE rather than the progress log, so a position the
// top-up never attempted still shows up — as "missing", which is the whole point.
//
// Sends nothing: declared `mutating: false`, so the harness never builds a signer.
//
//   node verify-20k-originality.js

import { ethers } from "ethers";
import fs from "fs";
import { formatUnits } from "viem";
import { POSITION_MANAGER_ABI } from "./lib/positions.js";
import { run } from "./lib/run.js";

await run(
  { name: "verify-20k-originality", slug: "originality-r2", stage: "verify-topup", mutating: false },
  async (ctx) => {
    const { manifest, provider, addr, log } = ctx;
    const mapCacheFile = manifest.files.mapCache;
    const progressFile = manifest.files.topUp;

    if (!fs.existsSync(mapCacheFile)) {
      throw new Error(`${mapCacheFile} not found — run the main script (even a dry run) first.`);
    }
    const repos = JSON.parse(fs.readFileSync(mapCacheFile, "utf8"));
    const expected = repos.flatMap((r) => r.positions.map((p) => String(p.positionId)));

    const entries = fs.existsSync(progressFile) ? JSON.parse(fs.readFileSync(progressFile, "utf8")) : [];
    const logMap = new Map(entries.map((e) => [String(e.positionId), e]));

    log.log(`\n📋 Expected positions (from map cache): ${expected.length}`);
    log.log(`📋 Logged positions  (from progress)  : ${logMap.size}\n`);

    const pm = new ethers.Contract(addr.positionManager, POSITION_MANAGER_ABI, provider);
    const missing = [];
    const revertedTx = [];
    const noReceipt = [];
    const zeroLiquidity = [];
    let confirmed = 0;

    // A null receipt for a months-old transaction is RPC throttling, not a
    // pending transaction. Retry before concluding anything.
    const receiptOf = async (hash, tries = 3) => {
      for (let i = 0; i < tries; i++) {
        const rc = await provider.getTransactionReceipt(hash);
        if (rc) return rc;
        if (i < tries - 1) await new Promise((r) => setTimeout(r, 750));
      }
      return null;
    };

    for (const id of expected) {
      const entry = logMap.get(id);
      if (!entry) {
        missing.push(id);
        continue;
      }

      const pos = await pm.positions(BigInt(id));
      const liq = pos.liquidity;
      if (liq === 0n) zeroLiquidity.push(id);

      let status = "—";
      if (entry.txHash) {
        const rc = await receiptOf(entry.txHash);
        if (!rc) {
          noReceipt.push(id);
          status = "pending";
        } else {
          status = rc.status === 1 ? "ok" : "REVERTED";
          if (rc.status !== 1) revertedTx.push(id);
        }
      }

      const good = !!entry && liq > 0n && status === "ok";
      if (good) confirmed++;
      log.log(
        `  ${good ? "✅" : "⚠️ "} #${id}: liquidity=${formatUnits(liq, 18)} | tx=${
          entry.txHash ? entry.txHash.slice(0, 12) + "…" : "none"
        } (${status})`
      );
    }

    log.log(`\n📊 Verification summary:`);
    log.log(`   ✅ Confirmed (logged, tx ok, liquidity > 0): ${confirmed}/${expected.length}`);
    log.log(`   ⚠️  Missing from progress log              : ${missing.length}`);
    log.log(`   ⏳ Tx not yet mined                        : ${noReceipt.length}`);
    log.log(`   ❌ Tx reverted                             : ${revertedTx.length}`);
    log.log(`   ❌ Zero liquidity on-chain                 : ${zeroLiquidity.length}`);
    if (missing.length) log.log(`\n   Missing: ${missing.join(", ")}`);
    if (revertedTx.length) log.log(`   Reverted: ${revertedTx.join(", ")}`);
    if (noReceipt.length) log.log(`   Pending: ${noReceipt.join(", ")}`);
    if (zeroLiquidity.length) log.log(`   Zero-liquidity: ${zeroLiquidity.join(", ")}`);

    if (confirmed === expected.length) {
      log.log(`\n🎉 All ${expected.length} positions confirmed — liquidity added successfully.`);
    } else {
      log.log(
        `\n⚠️  Not all positions confirmed. To finish the remaining ones, set` +
          ` SKIP_SPLITS = true in add-20k-originality-liquidity.js and re-run it` +
          ` (the splits already happened; it will only complete the missing increaseLiquidity calls).`
      );
    }
    return { expected: expected.length, confirmed, missing: missing.length };
  }
);
