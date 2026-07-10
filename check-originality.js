import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import { formatUnits } from "viem";
import { originalityPairs } from "./originality-pairs.js";
import { tokenIds } from "./tokens.js";

const RPC_URL = process.env.RPC_URL;
const POSITION_MANAGER_ADDRESS = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const POSITION_MANAGER_ABI = [
  "function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const positionManager = new ethers.Contract(POSITION_MANAGER_ADDRESS, POSITION_MANAGER_ABI, provider);

const progressLog = fs.existsSync("./add-back-execution.json")
  ? JSON.parse(fs.readFileSync("./add-back-execution.json", "utf8"))
  : [];
const progressMap = new Map(progressLog.map((e) => [String(e.positionId), e]));

async function main() {
  console.log(`\n📋 Checking ${tokenIds.length} positions against originality pairs...`);
  console.log(`📋 Progress log entries: ${progressMap.size}\n`);

  let restored = 0;       // in progress log AND has liquidity on-chain
  let zeroAfterRestore = []; // in progress log BUT liquidity = 0 on-chain (problem)
  let notInLog = [];      // originality position NOT in progress log (missed)
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
      console.log(`  ✅ #${positionId}: liquidity=${formatUnits(current, 18)}`);
      restored++;
    } else if (inLog && current === 0n) {
      console.log(`  ❌ #${positionId}: in progress log but liquidity=0 on-chain!`);
      zeroAfterRestore.push(positionId);
    } else {
      console.log(`  ⚠️  #${positionId}: originality position NOT in progress log — liquidity=${formatUnits(current, 18)}`);
      notInLog.push(positionId);
    }
  }

  console.log(`\n📊 Final check summary:`);
  console.log(`   ✅ Restored and confirmed on-chain : ${restored}`);
  console.log(`   ❌ In log but zero liquidity       : ${zeroAfterRestore.length}`);
  console.log(`   ⚠️  Originality but not in log     : ${notInLog.length}`);
  console.log(`   Non-originality (ignored)          : ${nonOriginality}`);

  if (zeroAfterRestore.length === 0 && notInLog.length === 0) {
    console.log("\n🎉 All originality positions confirmed restored!");
  } else {
    if (zeroAfterRestore.length > 0)
      console.log(`\n   Zero-liquidity positions: ${zeroAfterRestore.join(", ")}`);
    if (notInLog.length > 0)
      console.log(`   Missed positions: ${notInLog.join(", ")}`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
