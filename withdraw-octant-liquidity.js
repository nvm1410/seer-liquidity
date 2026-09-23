import { CurrencyAmount, Percent, Token } from "@uniswap/sdk-core";
import { NonfungiblePositionManager, Pool, Position } from "@uniswap/v3-sdk";
import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import { formatUnits } from "viem";
import { MarketViewAbi } from "./abis/MarketViewAbi.js";

// ── Config ──────────────────────────────────────────────────────────────────
const DRY_RUN = true; // ← set to false to send transactions

const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL;
const CHAIN_ID = 10;

// Octant — one-level multiscalar market on Optimism (no parent, no children).
const OCTANT_MARKET = "0xE85aDa7CD6D33CB41Ac596FB4749e3F94d836EcE";
const PROGRESS_FILE = "./withdraw-octant-execution.json";

// Addresses (Optimism, chain 10)
const POSITION_MANAGER_ADDRESS = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const SUSDS_ADDRESS = "0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0";
const MARKET_FACTORY = "0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6";
const MARKET_VIEW = "0x336695ec9efbafd6322fb82eaadbcda02e38f348";

const FEE_TIER = 100;

// ── ABIs (mirror index.js) ───────────────────────────────────────────────────
const POSITION_MANAGER_ABI = [
  "function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function balanceOf(address owner) external view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)",
];

const POOL_ABI = [
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() external view returns (uint128)",
];

// ── Provider / wallet ───────────────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

// ── Helpers (mirror add-octant-liquidity.js / index.js) ───────────────────────
function sortTokens(a, b) {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

async function runBatched(items, batchSize, asyncFn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(asyncFn));
    results.push(...batchResults);
    await new Promise((r) => setTimeout(r, 1000));
  }
  return results;
}

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
      if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

// Mirrors getMarketInfo() in add-octant-liquidity.js but keeps ALL wrapped
// tokens (including Invalid) — we want to withdraw from every octant pool.
async function getMarketInfo(marketAddress) {
  const marketView = new ethers.Contract(MARKET_VIEW, MarketViewAbi, provider);
  const result = await marketView.getMarket(MARKET_FACTORY, marketAddress);
  return {
    id: result.id,
    name: result.marketName,
    collateralToken: result.collateralToken,
    outcomes: result.outcomes,
    wrappedTokens: result.wrappedTokens,
    parentCollectionId: result.parentCollectionId,
    questionsIds: result.questionsIds,
  };
}

// ── Withdraw a single position: remove 100% liquidity + collect to wallet ─────
async function withdrawPosition(positionId, positionManager, octantTokenByPair) {
  const position = await positionManager.positions(positionId);

  const token0 = new Token(CHAIN_ID, position.token0, 18, "TOKEN0");
  const token1 = new Token(CHAIN_ID, position.token1, 18, "TOKEN1");

  const poolAddress = Pool.getAddress(token0, token1, Number(position.fee));
  const poolContract = new ethers.Contract(poolAddress, POOL_ABI, provider);
  const [slot0, liquidity] = await Promise.all([
    poolContract.slot0(),
    poolContract.liquidity(),
  ]);

  const pool = new Pool(
    token0,
    token1,
    Number(position.fee),
    slot0.sqrtPriceX96.toString(),
    liquidity.toString(),
    Number(slot0.tick)
  );

  const sdkPosition = new Position({
    pool,
    liquidity: position.liquidity.toString(),
    tickLower: Number(position.tickLower),
    tickUpper: Number(position.tickUpper),
  });

  const collectOptions = {
    tokenId: positionId.toString(),
    expectedCurrencyOwed0: CurrencyAmount.fromRawAmount(token0, 0),
    expectedCurrencyOwed1: CurrencyAmount.fromRawAmount(token1, 0),
    recipient: wallet.address,
  };

  const removeLiquidityOptions = {
    deadline: Math.floor(Date.now() / 1000) + 60 * 20,
    slippageTolerance: new Percent(50, 10_000), // 0.5%
    tokenId: positionId.toString(),
    liquidityPercentage: new Percent(1, 1), // 100% — withdraw all liquidity
    collectOptions,
  };

  const { calldata, value } = NonfungiblePositionManager.removeCallParameters(
    sdkPosition,
    removeLiquidityOptions
  );

  const receipt = await retryTransaction(() =>
    wallet.sendTransaction({
      to: POSITION_MANAGER_ADDRESS,
      data: calldata,
      value,
    })
  );

  const pairKey = sortTokens(position.token0, position.token1)
    .map((a) => a.toLowerCase())
    .join("-");
  return {
    positionId: positionId.toString(),
    token0: position.token0,
    token1: position.token1,
    outcomeToken: octantTokenByPair.get(pairKey),
    liquidity: position.liquidity.toString(),
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n📋 Wallet  : ${wallet.address}`);
  console.log(`📋 DRY_RUN : ${DRY_RUN}`);
  console.log(`📋 Market  : ${OCTANT_MARKET}\n`);

  // ── Step 1: resolve octant outcome tokens (on-chain) ────────────────────────
  console.log("🔍 Step 1: resolving octant market & outcome tokens...");
  const info = await getMarketInfo(OCTANT_MARKET);
  if (info.collateralToken.toLowerCase() !== SUSDS_ADDRESS.toLowerCase()) {
    throw new Error(
      `Collateral ${info.collateralToken} ≠ sUSDS ${SUSDS_ADDRESS}.`
    );
  }
  const outcomeTokens = info.wrappedTokens; // ALL outcomes incl. Invalid
  console.log(
    `   Market "${info.name}" | ${outcomeTokens.length} outcome tokens (incl. Invalid)`
  );

  // Map each octant pool pair → its outcome token (for logging).
  const octantTokenByPair = new Map();
  for (const outcome of outcomeTokens) {
    const key = sortTokens(outcome, SUSDS_ADDRESS)
      .map((a) => a.toLowerCase())
      .join("-");
    octantTokenByPair.set(key, outcome);
  }

  // ── Step 2: enumerate wallet positions, filter to octant w/ liquidity > 0 ───
  console.log("\n🔍 Step 2: scanning wallet positions...");
  const positionManager = new ethers.Contract(
    POSITION_MANAGER_ADDRESS,
    POSITION_MANAGER_ABI,
    wallet
  );
  const balance = await positionManager.balanceOf(wallet.address);
  const indexes = Array.from({ length: Number(balance) }, (_, i) => i);
  console.log(`   Wallet holds ${Number(balance)} position NFTs.`);

  const tokenIds = await runBatched(indexes, 20, (i) =>
    positionManager.tokenOfOwnerByIndex(wallet.address, i)
  );

  const positionsData = await runBatched(tokenIds, 20, async (tokenId) => {
    const pos = await positionManager.positions(tokenId);
    return { tokenId, pos };
  });

  const octant = positionsData.filter(({ pos }) => {
    const key = sortTokens(pos.token0, pos.token1)
      .map((a) => a.toLowerCase())
      .join("-");
    return octantTokenByPair.has(key) && pos.liquidity > 0n;
  });

  console.log(
    `   Matched ${octant.length} octant positions with liquidity > 0.\n`
  );
  for (const { tokenId, pos } of octant) {
    const key = sortTokens(pos.token0, pos.token1)
      .map((a) => a.toLowerCase())
      .join("-");
    console.log(
      `   #${tokenId.toString()}  outcome ${octantTokenByPair.get(key)}  ` +
        `liquidity ${pos.liquidity.toString()}`
    );
  }

  if (octant.length === 0) {
    console.log("\n✅ Nothing to withdraw — no octant positions with liquidity.");
    return;
  }

  if (DRY_RUN) {
    console.log("\n✅ Dry run complete — set DRY_RUN = false to execute.");
    return;
  }

  // ── Step 3: remove 100% liquidity + collect ─────────────────────────────────
  let progressLog = [];
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      progressLog = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
    } catch {
      progressLog = [];
    }
  }
  const alreadyDone = new Set(progressLog.map((e) => e.positionId));

  console.log(`\n📉 Step 3: withdrawing ${octant.length} positions\n`);
  let successCount = 0;
  for (const { tokenId } of octant) {
    if (alreadyDone.has(tokenId.toString())) {
      console.log(`  ⏭  #${tokenId.toString()}: already in progress log`);
      successCount++;
      continue;
    }
    console.log(`\n--- Position #${tokenId.toString()} ---`);
    try {
      const entry = await withdrawPosition(
        tokenId,
        positionManager,
        octantTokenByPair
      );
      progressLog.push(entry);
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progressLog, null, 2));
      successCount++;
      console.log(`  ✅ Saved to ${PROGRESS_FILE}`);
    } catch (err) {
      console.error(`  ❌ Failed for #${tokenId.toString()}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log(
    `\n🎉 Done! ${successCount}/${octant.length} positions withdrawn. See ${PROGRESS_FILE}.`
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
