// Withdraw 100% of the liquidity this wallet holds in the Zcash Q3 2026 CDRGP
// pools on Optimism, and collect the accrued fees in the same transaction.
//
// Scope is derived from create-zcash-markets-execution.json: every wrapped token
// of every market listed there — YES, NO *and* Invalid — paired against sUSDS.
// Invalid is included even though add-zcash-liquidity.js never seeds it, so that
// "withdraw all" stays true if an Invalid pool is ever added by hand.
//
// This returns outcome tokens + sUSDS to the wallet. It does NOT convert the
// outcome tokens back to sUSDS — that is a separate merge step, see the guide.
//
// Run with DRY_RUN = true first: it lists every matched position and its
// liquidity without sending anything.

import { CurrencyAmount, Percent, Token } from "@uniswap/sdk-core";
import { NonfungiblePositionManager, Pool, Position } from "@uniswap/v3-sdk";
import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import { MarketViewAbi } from "./abis/MarketViewAbi.js";

// ── Config ──────────────────────────────────────────────────────────────────
const DRY_RUN = true; // ← set to false to send transactions

const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL; // Optimism
const CHAIN_ID = 10;

const MARKETS_FILE = "./create-zcash-markets-execution.json";
const PROGRESS_FILE = "./withdraw-zcash-liquidity-execution.json";

// Addresses (Optimism, chain 10)
const POSITION_MANAGER_ADDRESS = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const SUSDS_ADDRESS = "0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0";
const MARKET_FACTORY = "0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6";
const MARKET_VIEW = "0x336695ec9efbafd6322fb82eaadbcda02e38f348";

const DELAY_MS = 2000;

// ── ABIs (mirror withdraw-octant-liquidity.js) ──────────────────────────────
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

// ── Helpers ─────────────────────────────────────────────────────────────────
function sortTokens(a, b) {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

function pairKey(a, b) {
  return sortTokens(a, b)
    .map((x) => x.toLowerCase())
    .join("-");
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

// Remove 100% of a position's liquidity and collect everything to the wallet.
async function withdrawPosition(positionId, positionManager) {
  const position = await positionManager.positions(positionId);

  const token0 = new Token(CHAIN_ID, position.token0, 18, "TOKEN0");
  const token1 = new Token(CHAIN_ID, position.token1, 18, "TOKEN1");

  const poolAddress = Pool.getAddress(token0, token1, Number(position.fee));
  const poolContract = new ethers.Contract(poolAddress, POOL_ABI, provider);
  const [slot0, liquidity] = await Promise.all([poolContract.slot0(), poolContract.liquidity()]);

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

  const { calldata, value } = NonfungiblePositionManager.removeCallParameters(sdkPosition, {
    deadline: Math.floor(Date.now() / 1000) + 60 * 20,
    slippageTolerance: new Percent(50, 10_000), // 0.5%
    tokenId: positionId.toString(),
    liquidityPercentage: new Percent(1, 1), // 100% — withdraw all liquidity
    collectOptions: {
      tokenId: positionId.toString(),
      expectedCurrencyOwed0: CurrencyAmount.fromRawAmount(token0, 0),
      expectedCurrencyOwed1: CurrencyAmount.fromRawAmount(token1, 0),
      recipient: wallet.address,
    },
  });

  const receipt = await retryTransaction(() =>
    wallet.sendTransaction({ to: POSITION_MANAGER_ADDRESS, data: calldata, value })
  );

  return {
    token0: position.token0,
    token1: position.token1,
    liquidity: position.liquidity.toString(),
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n📋 Wallet  : ${wallet.address}`);
  console.log(`📋 DRY_RUN : ${DRY_RUN}`);

  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) {
    throw new Error(`RPC_URL points at chain ${net.chainId}, expected ${CHAIN_ID} (Optimism).`);
  }

  if (!fs.existsSync(MARKETS_FILE)) {
    throw new Error(`${MARKETS_FILE} not found — nothing to withdraw from.`);
  }
  const markets = JSON.parse(fs.readFileSync(MARKETS_FILE, "utf8"));
  if (!markets.length) throw new Error(`${MARKETS_FILE} is empty.`);

  // ── Step 1: resolve every outcome token from chain, not from the log ──────
  console.log(`\n🔍 Step 1: resolving outcome tokens for ${markets.length} markets...`);
  const marketView = new ethers.Contract(MARKET_VIEW, MarketViewAbi, provider);
  const SIDES = ["YES", "NO", "Invalid"];
  const byPair = new Map();

  for (const m of markets) {
    const info = await marketView.getMarket(MARKET_FACTORY, m.market);
    if (info.collateralToken.toLowerCase() !== SUSDS_ADDRESS.toLowerCase()) {
      throw new Error(`[${m.shortName}] collateral ${info.collateralToken} != sUSDS`);
    }
    info.wrappedTokens.forEach((tok, i) => {
      byPair.set(pairKey(tok, SUSDS_ADDRESS), {
        id: m.id,
        shortName: m.shortName,
        market: m.market,
        side: SIDES[i] ?? `slot${i}`,
        outcomeToken: tok,
      });
    });
  }
  console.log(`   ${byPair.size} candidate pools (YES + NO + Invalid across ${markets.length} markets)`);

  // ── Step 2: enumerate wallet positions, filter to ours ────────────────────
  console.log("\n🔍 Step 2: scanning wallet positions...");
  const positionManager = new ethers.Contract(POSITION_MANAGER_ADDRESS, POSITION_MANAGER_ABI, wallet);
  const balance = await positionManager.balanceOf(wallet.address);
  console.log(`   Wallet holds ${Number(balance)} position NFTs.`);

  const indexes = Array.from({ length: Number(balance) }, (_, i) => i);
  const tokenIds = await runBatched(indexes, 20, (i) =>
    positionManager.tokenOfOwnerByIndex(wallet.address, i)
  );
  const positionsData = await runBatched(tokenIds, 20, async (tokenId) => ({
    tokenId,
    pos: await positionManager.positions(tokenId),
  }));

  const matched = positionsData
    .map(({ tokenId, pos }) => ({ tokenId, pos, meta: byPair.get(pairKey(pos.token0, pos.token1)) }))
    .filter((x) => x.meta);

  const withLiquidity = matched.filter((x) => x.pos.liquidity > 0n);
  const empty = matched.filter((x) => x.pos.liquidity === 0n);

  console.log(`   Matched ${matched.length} Zcash positions — ${withLiquidity.length} with liquidity > 0.\n`);
  for (const { tokenId, pos, meta } of withLiquidity) {
    console.log(
      `   #${tokenId.toString().padEnd(7)} [${String(meta.id).padStart(2)}] ` +
        `${meta.shortName.padEnd(15)} ${meta.side.padEnd(7)} liquidity ${pos.liquidity.toString()}`
    );
  }
  if (empty.length) {
    console.log(
      `\n   ℹ️  ${empty.length} matched position(s) already have zero liquidity and are skipped.` +
        `\n      Any residual uncollected fees on those must be collected separately.`
    );
  }

  if (withLiquidity.length === 0) {
    console.log("\n✅ Nothing to withdraw — no Zcash positions with liquidity.");
    return;
  }

  if (DRY_RUN) {
    console.log("\n✅ Dry run complete — set DRY_RUN = false to execute.");
    return;
  }

  // ── Step 3: remove 100% liquidity + collect ───────────────────────────────
  let progressLog = [];
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      progressLog = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
    } catch {
      progressLog = [];
    }
  }
  const alreadyDone = new Set(progressLog.map((e) => e.positionId));

  console.log(`\n📉 Step 3: withdrawing ${withLiquidity.length} positions\n`);
  let successCount = 0;
  for (const { tokenId, meta } of withLiquidity) {
    if (alreadyDone.has(tokenId.toString())) {
      console.log(`  ⏭  #${tokenId.toString()}: already in progress log`);
      successCount++;
      continue;
    }
    console.log(`\n--- #${tokenId.toString()} [${meta.id}] ${meta.shortName} ${meta.side} ---`);
    try {
      const entry = await withdrawPosition(tokenId, positionManager);
      progressLog.push({
        positionId: tokenId.toString(),
        id: meta.id,
        shortName: meta.shortName,
        market: meta.market,
        side: meta.side,
        outcomeToken: meta.outcomeToken,
        ...entry,
      });
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progressLog, null, 2));
      successCount++;
      console.log(`  ✅ Saved to ${PROGRESS_FILE}`);
    } catch (err) {
      console.error(`  ❌ Failed for #${tokenId.toString()}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  console.log(`\n🎉 Done! ${successCount}/${withLiquidity.length} positions withdrawn. See ${PROGRESS_FILE}.`);
  console.log(
    "   The wallet now holds YES/NO tokens + sUSDS. To convert the outcome tokens\n" +
      "   back to sUSDS, merge a full set per market (Router.mergePositions) — see\n" +
      "   remove-merge-originality.js for that pattern."
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
