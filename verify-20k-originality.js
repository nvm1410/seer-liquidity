import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import { formatUnits } from "viem";

// Read-only checker for add-20k-originality-liquidity.js.
// Confirms every expected position was processed, its increaseLiquidity tx
// actually succeeded on-chain, and it now holds non-zero liquidity.

const RPC_URL = process.env.RPC_URL;
const POSITION_MANAGER_ADDRESS = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const PROGRESS_FILE = "./add-20k-originality-execution.json";
const MAP_CACHE_FILE = "./originality-map-cache.json";

const POSITION_MANAGER_ABI = [
  "function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const pm = new ethers.Contract(POSITION_MANAGER_ADDRESS, POSITION_MANAGER_ABI, provider);

async function main() {
  if (!fs.existsSync(MAP_CACHE_FILE)) {
    console.log(`❌ ${MAP_CACHE_FILE} not found — run the main script (even a dry run) first.`);
    process.exit(1);
  }
  const repos = JSON.parse(fs.readFileSync(MAP_CACHE_FILE, "utf8"));
  const expected = repos.flatMap((r) => r.positions.map((p) => String(p.positionId)));

  const log = fs.existsSync(PROGRESS_FILE) ? JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8")) : [];
  const logMap = new Map(log.map((e) => [String(e.positionId), e]));

  console.log(`\n📋 Expected positions (from map cache): ${expected.length}`);
  console.log(`📋 Logged positions  (from progress)  : ${logMap.size}\n`);

  const missing = []; // expected but not in progress log
  const revertedTx = []; // logged but tx receipt status !== 1
  const noReceipt = []; // logged but receipt not found yet
  const zeroLiquidity = []; // on-chain liquidity == 0
  let confirmed = 0;

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
      const rc = await provider.getTransactionReceipt(entry.txHash);
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
    console.log(
      `  ${good ? "✅" : "⚠️ "} #${id}: liquidity=${formatUnits(liq, 18)} | tx=${
        entry.txHash ? entry.txHash.slice(0, 12) + "…" : "none"
      } (${status})`
    );
  }

  console.log(`\n📊 Verification summary:`);
  console.log(`   ✅ Confirmed (logged, tx ok, liquidity > 0): ${confirmed}/${expected.length}`);
  console.log(`   ⚠️  Missing from progress log              : ${missing.length}`);
  console.log(`   ⏳ Tx not yet mined                        : ${noReceipt.length}`);
  console.log(`   ❌ Tx reverted                             : ${revertedTx.length}`);
  console.log(`   ❌ Zero liquidity on-chain                 : ${zeroLiquidity.length}`);
  if (missing.length) console.log(`\n   Missing: ${missing.join(", ")}`);
  if (revertedTx.length) console.log(`   Reverted: ${revertedTx.join(", ")}`);
  if (noReceipt.length) console.log(`   Pending: ${noReceipt.join(", ")}`);
  if (zeroLiquidity.length) console.log(`   Zero-liquidity: ${zeroLiquidity.join(", ")}`);

  if (confirmed === expected.length) {
    console.log(`\n🎉 All ${expected.length} positions confirmed — liquidity added successfully.`);
  } else {
    console.log(
      `\n⚠️  Not all positions confirmed. To finish the remaining ones, set` +
        ` SKIP_SPLITS = true in add-20k-originality-liquidity.js and re-run it` +
        ` (the splits already happened; it will only complete the missing increaseLiquidity calls).`
    );
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
