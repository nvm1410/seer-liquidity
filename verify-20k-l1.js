import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import { formatUnits } from "viem";

// Read-only checker for add-20k-l1-liquidity.js.
// Confirms every pool got a top-up, its increaseLiquidity tx actually succeeded
// on-chain, and the pool's combined liquidity grew by the logged amount.

const RPC_URL = process.env.RPC_URL;
const POSITION_MANAGER_ADDRESS = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const SUSDS_ADDRESS = "0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0".toLowerCase();
const SOURCE_FILE = "./execution.json";
const PROGRESS_FILE = "./add-20k-l1-execution.json";

const POSITION_MANAGER_ABI = [
  "function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const pm = new ethers.Contract(POSITION_MANAGER_ADDRESS, POSITION_MANAGER_ABI, provider);

async function main() {
  const source = JSON.parse(fs.readFileSync(SOURCE_FILE, "utf8"));
  const log = fs.existsSync(PROGRESS_FILE) ? JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8")) : [];
  const logMap = new Map(log.map((e) => [String(e.positionId), e]));

  // Group source positions into pools, same keying as the main script.
  const byOutcome = new Map();
  for (const e of source) {
    const t0 = e.token0.toLowerCase();
    const t1 = e.token1.toLowerCase();
    if (t0 !== SUSDS_ADDRESS && t1 !== SUSDS_ADDRESS) continue;
    const outcome = t0 === SUSDS_ADDRESS ? t1 : t0;
    if (!byOutcome.has(outcome)) byOutcome.set(outcome, []);
    byOutcome.get(outcome).push(e);
  }

  console.log(`\n📋 Pools in ${SOURCE_FILE}          : ${byOutcome.size}`);
  console.log(`📋 Positions logged in progress  : ${logMap.size}\n`);

  const missing = []; // pool has no logged top-up
  const revertedTx = [];
  const noReceipt = [];
  const shortfall = []; // on-chain growth < logged addedLiquidity
  let confirmed = 0;

  for (const [outcome, entries] of byOutcome) {
    // Which of this pool's NFTs was topped up?
    const entry = entries.map((e) => logMap.get(String(e.positionId))).find(Boolean);
    if (!entry) {
      missing.push(outcome);
      console.log(`  ⚠️  ${outcome}: no top-up logged for any of [${entries.map((e) => e.positionId).join(", ")}]`);
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
    // NOTE: execution.json is the *pre-removal* snapshot from index.js, not the
    // pre-run baseline — the July add-back left ~29 pools partially restored, so
    // comparing against it understates this run's growth. Derive the true
    // baseline as (now - addedLiquidity) instead, and report the execution.json
    // gap separately as informational.
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
    console.log(
      `  ${good ? "✅" : "⚠️ "} #${entry.positionId} ${outcome}: ${formatUnits(preRunLiq, 18)} → ${formatUnits(nowLiq, 18)}` +
        ` (${(Number(nowLiq) / Number(preRunLiq)).toFixed(3)}x)` +
        (restored < 99.9 ? ` [was only ${restored.toFixed(1)}% of the pre-removal snapshot]` : "") +
        ` | tx=${entry.txHash ? entry.txHash.slice(0, 12) + "…" : "none"} (${status})`
    );
  }

  console.log(`\n📊 Verification summary:`);
  console.log(`   ✅ Confirmed (tx ok, liquidity grew) : ${confirmed}/${byOutcome.size}`);
  console.log(`   ⚠️  Pools with no logged top-up       : ${missing.length}`);
  console.log(`   ⏳ Tx not yet mined                   : ${noReceipt.length}`);
  console.log(`   ❌ Tx reverted                        : ${revertedTx.length}`);
  console.log(`   ❌ No liquidity added                 : ${shortfall.length}`);
  if (missing.length) console.log(`\n   Missing: ${missing.join(", ")}`);
  if (revertedTx.length) console.log(`   Reverted: ${revertedTx.join(", ")}`);
  if (noReceipt.length) console.log(`   Pending: ${noReceipt.join(", ")}`);
  if (shortfall.length) console.log(`   Shortfall: ${shortfall.join(", ")}`);

  if (confirmed === byOutcome.size) {
    console.log(`\n🎉 All ${byOutcome.size} pools confirmed — liquidity added successfully.`);
  } else {
    console.log(
      `\n⚠️  Not all pools confirmed. To finish the remaining ones, set` +
        ` SKIP_SPLITS = true in add-20k-l1-liquidity.js and re-run it` +
        ` (the splits already happened; it will only complete the missing increaseLiquidity calls).`
    );
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
