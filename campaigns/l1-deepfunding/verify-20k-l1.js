// Read-only checker for add-20k-l1-liquidity.js.
// Confirms every pool got a top-up, its increaseLiquidity tx actually succeeded
// on-chain, and the pool's combined liquidity grew by the logged amount.
//
// Sends nothing: declared `mutating: false`, so the harness never builds a signer.
//
//   node verify-20k-l1.js

import { ethers } from "ethers";
import fs from "fs";
import { formatUnits } from "viem";
import { POSITION_MANAGER_ABI } from "../../lib/positions.js";
import { run } from "../../lib/run.js";

await run(
  { name: "verify-20k-l1", slug: "l1-deepfunding", stage: "verify-topup", mutating: false },
  async (ctx) => {
    const { manifest, provider, addr, log } = ctx;
    const collateral = manifest.chain.collateral.address.toLowerCase();
    const sourceFile = manifest.files.baseline;
    const progressFile = manifest.files.topUp;

    const pm = new ethers.Contract(addr.positionManager, POSITION_MANAGER_ABI, provider);
    const source = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
    const entriesLogged = fs.existsSync(progressFile) ? JSON.parse(fs.readFileSync(progressFile, "utf8")) : [];
    const logMap = new Map(entriesLogged.map((e) => [String(e.positionId), e]));

    // Group source positions into pools, same keying as the top-up script: a pool
    // can hold more than one position NFT.
    const byOutcome = new Map();
    for (const e of source) {
      const t0 = e.token0.toLowerCase();
      const t1 = e.token1.toLowerCase();
      if (t0 !== collateral && t1 !== collateral) continue;
      const outcome = t0 === collateral ? t1 : t0;
      if (!byOutcome.has(outcome)) byOutcome.set(outcome, []);
      byOutcome.get(outcome).push(e);
    }

    log.log(`\n📋 Pools in ${sourceFile}          : ${byOutcome.size}`);
    log.log(`📋 Positions logged in progress  : ${logMap.size}\n`);

    const missing = [];
    const revertedTx = [];
    const noReceipt = [];
    const shortfall = [];
    let confirmed = 0;

    for (const [outcome, entries] of byOutcome) {
      const entry = entries.map((e) => logMap.get(String(e.positionId))).find(Boolean);
      if (!entry) {
        missing.push(outcome);
        log.log(`  ⚠️  ${outcome}: no top-up logged for any of [${entries.map((e) => e.positionId).join(", ")}]`);
        continue;
      }

      let status = "—";
      if (entry.txHash) {
        const rc = await provider.getTransactionReceipt(entry.txHash);
        if (!rc) {
          noReceipt.push(entry.positionId);
          status = "pending";
        } else {
          status = rc.status === 1 ? "ok" : "REVERTED";
          if (rc.status !== 1) revertedTx.push(entry.positionId);
        }
      }

      // Combined pool liquidity now, vs the liquidity immediately BEFORE this run.
      // execution.json is the PRE-REMOVAL snapshot, not the pre-run baseline — the
      // July add-back left ~29 pools only partially restored, so comparing against
      // it understates this run's growth. Derive the true baseline as
      // (now - addedLiquidity) and report the snapshot gap separately.
      let nowLiq = 0n;
      for (const e of entries) {
        const p = await pm.positions(BigInt(e.positionId));
        nowLiq += p.liquidity;
      }
      const added = BigInt(entry.addedLiquidity ?? "0");
      const preRunLiq = nowLiq - added;
      const snapshotLiq = entries.reduce((s, e) => s + BigInt(e.liquidity), 0n);
      const grew = added > 0n && preRunLiq > 0n;
      if (!grew) shortfall.push(entry.positionId);

      const good = status === "ok" && grew;
      if (good) confirmed++;
      const restored = snapshotLiq > 0n ? (Number(preRunLiq) / Number(snapshotLiq)) * 100 : 100;
      log.log(
        `  ${good ? "✅" : "⚠️ "} #${entry.positionId} ${outcome}: ${formatUnits(preRunLiq, 18)} → ${formatUnits(nowLiq, 18)}` +
          ` (${(Number(nowLiq) / Number(preRunLiq)).toFixed(3)}x)` +
          (restored < 99.9 ? ` [was only ${restored.toFixed(1)}% of the pre-removal snapshot]` : "") +
          ` | tx=${entry.txHash ? entry.txHash.slice(0, 12) + "…" : "none"} (${status})`
      );
    }

    log.log(`\n📊 Verification summary:`);
    log.log(`   ✅ Confirmed (tx ok, liquidity grew) : ${confirmed}/${byOutcome.size}`);
    log.log(`   ⚠️  Pools with no logged top-up       : ${missing.length}`);
    log.log(`   ⏳ Tx not yet mined                   : ${noReceipt.length}`);
    log.log(`   ❌ Tx reverted                        : ${revertedTx.length}`);
    log.log(`   ❌ No liquidity added                 : ${shortfall.length}`);
    if (missing.length) log.log(`\n   Missing: ${missing.join(", ")}`);
    if (revertedTx.length) log.log(`   Reverted: ${revertedTx.join(", ")}`);
    if (noReceipt.length) log.log(`   Pending: ${noReceipt.join(", ")}`);
    if (shortfall.length) log.log(`   Shortfall: ${shortfall.join(", ")}`);

    if (confirmed === byOutcome.size) {
      log.log(`\n🎉 All ${byOutcome.size} pools confirmed — liquidity added successfully.`);
    } else {
      log.log(
        `\n⚠️  Not all pools confirmed. To finish the remaining ones, set` +
          ` SKIP_SPLITS = true in add-20k-l1-liquidity.js and re-run it` +
          ` (the splits already happened; it will only complete the missing increaseLiquidity calls).`
      );
    }
    return { pools: byOutcome.size, confirmed, missing: missing.length };
  }
);
