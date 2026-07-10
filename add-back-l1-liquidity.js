import { Percent, Token } from "@uniswap/sdk-core";
import { NonfungiblePositionManager, Pool, Position } from "@uniswap/v3-sdk";
import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import JSBI from "jsbi";
import { erc20Abi, formatUnits } from "viem";

// ── Config ──────────────────────────────────────────────────────────────────
const DRY_RUN = true; // ← set to false to send transactions

const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL;
const CHAIN_ID = 10;
const POSITION_MANAGER_ADDRESS = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const PROGRESS_FILE = "./add-back-l1-execution.json";

// ── ABIs ────────────────────────────────────────────────────────────────────
const POSITION_MANAGER_ABI = [
  "function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
];

const POOL_ABI = [
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() external view returns (uint128)",
];

// ── Provider / wallet ───────────────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

// ── Helpers ──────────────────────────────────────────────────────────────────
async function retryTransaction(txFn, retries = 3, delayMs = 3000) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`  Attempt ${attempt}/${retries}...`);
      const tx = await txFn();
      console.log(`  Tx sent: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`  Confirmed in block ${receipt.blockNumber}`);
      return receipt;
    } catch (err) {
      lastError = err;
      console.warn(`  Attempt ${attempt} failed: ${err.message}`);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError;
}

async function getTokenBalance(tokenAddress) {
  const token = new ethers.Contract(tokenAddress, erc20Abi, provider);
  return await token.balanceOf(wallet.address);
}

async function approveToken(tokenAddress, spender, amount) {
  const token = new ethers.Contract(tokenAddress, erc20Abi, wallet);
  await retryTransaction(() => token.approve(spender, amount));
}

// ── Load execution.json (written by index.js during the L1 removal run) ─────
// execution.json records each position's PRE-REMOVAL liquidity, so we know
// exactly how much to add back: delta = original - current.
const executionData = JSON.parse(fs.readFileSync("./execution.json", "utf8"));

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n📋 execution.json entries : ${executionData.length}`);
  console.log(`📋 Wallet address         : ${wallet.address}`);
  console.log(`📋 DRY_RUN                : ${DRY_RUN}\n`);

  const positionManager = new ethers.Contract(
    POSITION_MANAGER_ADDRESS,
    POSITION_MANAGER_ABI,
    wallet
  );

  // ── Phase 1: compute per-position deltas ──────────────────────────────────
  // execution.json was written by index.js just before/after each 50% removal.
  // delta = original (execution.json) - current (on-chain).
  // - If the position was reduced: current ≈ original/2, delta ≈ original/2.
  // - If the run was interrupted before reaching a position: current == original,
  //   delta == 0 → auto-skipped.
  console.log("🔍 Computing deltas from execution.json vs on-chain state...\n");
  const toRestore = [];
  let skippedZeroDelta = 0;

  for (const entry of executionData) {
    const positionId = entry.positionId;
    const pos = await positionManager.positions(BigInt(positionId));
    const original = BigInt(entry.liquidity);
    const current = pos.liquidity;
    const delta = original - current;

    if (delta <= 0n) {
      console.log(
        `  ⏭  #${positionId}: delta=${delta.toString()} (original=${formatUnits(original, 18)}, current=${formatUnits(current, 18)}) — skipping`
      );
      skippedZeroDelta++;
      continue;
    }

    // Build pool at current on-chain state
    const token0 = new Token(CHAIN_ID, pos.token0, 18, "TOKEN0");
    const token1 = new Token(CHAIN_ID, pos.token1, 18, "TOKEN1");
    const poolAddress = Pool.getAddress(token0, token1, Number(pos.fee));
    const poolContract = new ethers.Contract(poolAddress, POOL_ABI, provider);
    const [slot0, poolLiquidity] = await Promise.all([
      poolContract.slot0(),
      poolContract.liquidity(),
    ]);

    const pool = new Pool(
      token0,
      token1,
      Number(pos.fee),
      slot0.sqrtPriceX96.toString(),
      poolLiquidity.toString(),
      Number(slot0.tick)
    );

    const position = new Position({
      pool,
      liquidity: delta.toString(),
      tickLower: Number(pos.tickLower),
      tickUpper: Number(pos.tickUpper),
    });

    const amount0Desired = BigInt(position.mintAmounts.amount0.toString());
    const amount1Desired = BigInt(position.mintAmounts.amount1.toString());

    console.log(
      `  ✅ #${positionId}: original=${formatUnits(original, 18)}, current=${formatUnits(current, 18)}, ` +
        `delta=${formatUnits(delta, 18)} | need token0=${formatUnits(amount0Desired, 18)}, token1=${formatUnits(amount1Desired, 18)}`
    );

    toRestore.push({
      positionId,
      token0: pos.token0,
      token1: pos.token1,
      original,
      delta,
      amount0Desired,
      amount1Desired,
      position,
    });
  }

  console.log(`\n📊 Summary:`);
  console.log(`   To restore          : ${toRestore.length}`);
  console.log(`   Skipped (delta = 0) : ${skippedZeroDelta}`);

  if (toRestore.length === 0) {
    console.log("\n✅ All L1 positions are already at their original size.");
    process.exit(0);
  }

  // ── Phase 2: preflight balance check (caps at available, no abort) ─────────
  const tokenNeeded = new Map(); // lowercased -> { address, needed }
  for (const item of toRestore) {
    const t0 = item.token0.toLowerCase();
    const t1 = item.token1.toLowerCase();
    if (!tokenNeeded.has(t0)) tokenNeeded.set(t0, { address: item.token0, needed: 0n });
    if (!tokenNeeded.has(t1)) tokenNeeded.set(t1, { address: item.token1, needed: 0n });
    tokenNeeded.get(t0).needed += item.amount0Desired;
    tokenNeeded.get(t1).needed += item.amount1Desired;
  }

  console.log("\n💰 Wallet balance preflight:");
  const remaining = new Map(); // lowercased -> BigInt (spendable)
  for (const [key, { address, needed }] of tokenNeeded) {
    const available = await getTokenBalance(address);
    const usable = available < needed ? available : needed;
    remaining.set(key, usable);
    const ok = available >= needed;
    console.log(
      `   ${address}\n     needed   : ${formatUnits(needed, 18)}\n` +
        `     available: ${formatUnits(available, 18)}  ${ok ? "✅" : `⚠️  INSUFFICIENT — will use ${formatUnits(usable, 18)}`}`
    );
  }

  if (DRY_RUN) {
    console.log(
      "\n✅ Dry run complete — no transactions sent.\n" +
        "   Set DRY_RUN = false to execute the restore."
    );
    process.exit(0);
  }

  // ── Phase 3: approve each unique token once (skip if allowance already enough)
  console.log("\n🔑 Checking/approving tokens...");
  for (const [key, { address }] of tokenNeeded) {
    const approveAmount = remaining.get(key);
    const tokenContract = new ethers.Contract(address, erc20Abi, provider);
    const currentAllowance = await tokenContract.allowance(wallet.address, POSITION_MANAGER_ADDRESS);
    if (currentAllowance >= approveAmount) {
      console.log(`  ⏭  ${address}: allowance already sufficient — skipping`);
      continue;
    }
    console.log(`  Approving ${address} for ${formatUnits(approveAmount, 18)} ...`);
    await approveToken(address, POSITION_MANAGER_ADDRESS, approveAmount);
    await new Promise((r) => setTimeout(r, 2000));
  }

  // ── Phase 4: increase liquidity per position ──────────────────────────────
  console.log("\n📈 Increasing liquidity for each L1 position...");

  let progressLog = [];
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      progressLog = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
    } catch {
      progressLog = [];
    }
  }
  const alreadyDone = new Set(progressLog.map((e) => String(e.positionId)));

  let successCount = 0;
  let skippedInsufficientCount = 0;

  for (const item of toRestore) {
    if (alreadyDone.has(String(item.positionId))) {
      console.log(`  ⏭  #${item.positionId}: already in progress log — skipping`);
      successCount++;
      continue;
    }

    const t0 = item.token0.toLowerCase();
    const t1 = item.token1.toLowerCase();
    const rem0 = remaining.get(t0) ?? 0n;
    const rem1 = remaining.get(t1) ?? 0n;

    // If either token is short, recompute position with available amounts
    // rather than skipping. Only truly exhausted tokens abort the position.
    let positionToUse = item.position;
    let use0 = item.amount0Desired;
    let use1 = item.amount1Desired;

    if (rem0 < item.amount0Desired || rem1 < item.amount1Desired) {
      if (rem0 === 0n || rem1 === 0n) {
        console.log(`  ⚠️  #${item.positionId}: one token fully exhausted — skipping`);
        skippedInsufficientCount++;
        continue;
      }
      const capped0 = rem0 < item.amount0Desired ? rem0 : item.amount0Desired;
      const capped1 = rem1 < item.amount1Desired ? rem1 : item.amount1Desired;
      positionToUse = Position.fromAmounts({
        pool: item.position.pool,
        tickLower: item.position.tickLower,
        tickUpper: item.position.tickUpper,
        amount0: capped0.toString(),
        amount1: capped1.toString(),
        useFullPrecision: true,
      });
      if (JSBI.equal(positionToUse.liquidity, JSBI.BigInt(0))) {
        console.log(`  ⚠️  #${item.positionId}: capped amounts yield zero liquidity — skipping`);
        skippedInsufficientCount++;
        continue;
      }
      use0 = BigInt(positionToUse.mintAmounts.amount0.toString());
      use1 = BigInt(positionToUse.mintAmounts.amount1.toString());
      console.log(
        `  ⚠️  #${item.positionId}: using reduced amounts ` +
          `token0=${formatUnits(use0, 18)}, token1=${formatUnits(use1, 18)}`
      );
    }

    console.log(`\n--- Position #${item.positionId} ---`);
    try {
      const { calldata, value } = NonfungiblePositionManager.addCallParameters(
        positionToUse,
        {
          tokenId: item.positionId.toString(), // triggers increaseLiquidity (not mint)
          slippageTolerance: new Percent(10, 10_000), // 0.1%
          deadline: Math.floor(Date.now() / 1000) + 60 * 20,
        }
      );

      const receipt = await retryTransaction(() =>
        wallet.sendTransaction({
          to: POSITION_MANAGER_ADDRESS,
          data: calldata,
          value,
        })
      );

      remaining.set(t0, rem0 - use0);
      remaining.set(t1, rem1 - use1);

      const logEntry = {
        positionId: item.positionId,
        token0: item.token0,
        token1: item.token1,
        original: item.original.toString(),
        delta: item.delta.toString(),
        amount0Desired: use0.toString(),
        amount1Desired: use1.toString(),
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      };
      progressLog.push(logEntry);
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progressLog, null, 2));
      successCount++;
      console.log(`  ✅ Saved to ${PROGRESS_FILE}`);
    } catch (err) {
      console.error(`  ❌ Failed for #${item.positionId}: ${err.message}`);
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log(
    `\n🎉 Done! ${successCount} restored, ${skippedInsufficientCount} skipped (insufficient balance). ` +
      `See ${PROGRESS_FILE} for details.`
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
