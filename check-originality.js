// Read-only checker for add-back-liquidity.js: did every originality position
// actually get its removed half back?
//
// Three outcomes per position — in the log and funded (good), in the log but
// still at zero liquidity (the add-back did not land), or an originality
// position missing from the log entirely (it was never attempted).
//
// Sends nothing: declared `mutating: false`, so the harness never builds a signer.
//
//   node check-originality.js

import { ethers } from "ethers";
import fs from "fs";
import { formatUnits } from "viem";
import { POSITION_MANAGER_ABI } from "./lib/positions.js";
import { run } from "./lib/run.js";
import { originalityPairs } from "./originality-pairs.js";
import { tokenIds } from "./tokens.js";

await run(
  { name: "check-originality", slug: "originality-r2", stage: "verify-add-back", mutating: false },
  async (ctx) => {
    const { manifest, provider, addr, log } = ctx;
    const positionManager = new ethers.Contract(addr.positionManager, POSITION_MANAGER_ABI, provider);

    const addBackFile = manifest.files.addBack;
    const entries = fs.existsSync(addBackFile) ? JSON.parse(fs.readFileSync(addBackFile, "utf8")) : [];
    const progressMap = new Map(entries.map((e) => [String(e.positionId), e]));

    log.log(`\n📋 Checking ${tokenIds.length} positions against originality pairs...`);
    log.log(`📋 Progress log entries: ${progressMap.size}\n`);

    let restored = 0;
    const zeroAfterRestore = [];
    const notInLog = [];
    let nonOriginality = 0;

    for (const positionId of tokenIds) {
      const pos = await positionManager.positions(BigInt(positionId));

      const isOriginality = originalityPairs.some(
        (pair) =>
          pos.token0.toLowerCase() === pair.token0.toLowerCase() &&
          pos.token1.toLowerCase() === pair.token1.toLowerCase()
      );
      if (!isOriginality) {
        nonOriginality++;
        continue;
      }

      const inLog = progressMap.has(String(positionId));
      const current = pos.liquidity;

      if (inLog && current > 0n) {
        log.log(`  ✅ #${positionId}: liquidity=${formatUnits(current, 18)}`);
        restored++;
      } else if (inLog && current === 0n) {
        log.log(`  ❌ #${positionId}: in progress log but liquidity=0 on-chain!`);
        zeroAfterRestore.push(positionId);
      } else {
        log.log(
          `  ⚠️  #${positionId}: originality position NOT in progress log — liquidity=${formatUnits(current, 18)}`
        );
        notInLog.push(positionId);
      }
    }

    log.log(`\n📊 Final check summary:`);
    log.log(`   ✅ Restored and confirmed on-chain : ${restored}`);
    log.log(`   ❌ In log but zero liquidity       : ${zeroAfterRestore.length}`);
    log.log(`   ⚠️  Originality but not in log     : ${notInLog.length}`);
    log.log(`   Non-originality (ignored)          : ${nonOriginality}`);

    if (zeroAfterRestore.length === 0 && notInLog.length === 0) {
      log.log("\n🎉 All originality positions confirmed restored!");
    } else {
      if (zeroAfterRestore.length > 0) log.log(`\n   Zero-liquidity positions: ${zeroAfterRestore.join(", ")}`);
      if (notInLog.length > 0) log.log(`   Missed positions: ${notInLog.join(", ")}`);
    }
    return { restored, zeroAfterRestore: zeroAfterRestore.length, notInLog: notInLog.length };
  }
);
