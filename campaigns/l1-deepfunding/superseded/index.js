import { CurrencyAmount, Percent, Token } from "@uniswap/sdk-core";
import { NonfungiblePositionManager, Pool, Position } from "@uniswap/v3-sdk";
import "dotenv/config";
import { ethers } from "ethers";
import { tokenIds } from "../../originality-r2/tokens.js";
import { positionsToWithdraw } from "../positionsToWithdraw.js";
import fs from "fs";
import { wrappedTokens } from "../wrappedTokens.js";
import { originalityPairs } from "../../originality-r2/originality-pairs.js";

// Removes 50% of the liquidity from every position in tokens.js. This is what
// wrote execution.json, the baseline that add-back-l1-liquidity.js reads to
// restore the L1 positions — so the file is a record of one specific 2026 run,
// not a reusable tool.

import { parseArgs, REFUSED } from "../../../lib/run.js";

// ── LIVE-FIRE GATE ──────────────────────────────────────────────────────────
// This script is SUPERSEDED (see the note above) and, unlike every other script
// here, it never had a DRY_RUN flag: every line below sends real transactions
// the moment it runs. There is no dry mode to fall back to and no way to prove
// a rewrite of it preserves behaviour, so it is not migrated to lib/run.js —
// only gated. Everything below this block is unchanged.
const _args = parseArgs();
if (!_args.live) {
  console.error(
    `index.js is superseded and has no dry-run mode — it sends transactions immediately.
` +
      `  Refusing to run without --live. See add-back-l1-liquidity.js / add-back-liquidity.js, which restore what this removed,
` +
      `  and lifecycle/l1-deepfunding.json for what replaced it.`
  );
  process.exit(REFUSED);
}

// Configuration
const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL;
const CHAIN_ID = 10;

// Uniswap V3 NFT Position Manager address (same across networks)
const POSITION_MANAGER_ADDRESS = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";

// ABIs
const POSITION_MANAGER_ABI = [
  "function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function balanceOf(address owner) external view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)",
  "function burn(uint256 tokenId) external",
  "function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) external returns (uint256 amount0, uint256 amount1)",
];

const POOL_ABI = [
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() external view returns (uint128)",
];

const ERC20_ABI = [
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)",
  "function name() external view returns (string)",
];
// const positionsToWithdraw = [];
async function runBatched(items, batchSize, asyncFn) {
  const results = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(asyncFn));
    results.push(...batchResults);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return results;
}

async function withdrawAllPositions() {
  // Setup provider and wallet
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

  console.log("Wallet address:", wallet.address);
  const positionManager = new ethers.Contract(
    POSITION_MANAGER_ADDRESS,
    POSITION_MANAGER_ABI,
    wallet,
  );
  const BATCH_SIZE = 20;

  const balance = await positionManager.balanceOf(wallet.address);
  const indexes = Array.from({ length: Number(balance) }, (_, i) => i);

  // const tokenIds = await runBatched(indexes, BATCH_SIZE, (i) =>
  //   positionManager.tokenOfOwnerByIndex(wallet.address, i),
  // );

  // fs.writeFileSync("./tokens.json", JSON.stringify(tokenIds.map((x) => x.toString())), null, 4);
  // return;
  // Process each position
  // const filteredPositions = [];
  // for (const tokenId of tokenIds) {
  //   try {
  //     console.log(`\n--- Processing Position #${tokenId} ---`);
  //     const isFiltered = await filterPosition(tokenId, wallet);
  //     if (isFiltered) {
  //       filteredPositions.push(tokenId);
  //     }
  //     // await withdrawPosition(BigInt(tokenId), wallet, provider);
  //   } catch (error) {
  //     console.error(`Error processing position #${tokenId}:`, error.message);
  //   }
  // }
  // fs.writeFileSync(
  //   "./positionsToWithdraw.json",
  //   JSON.stringify(filteredPositions.map((x) => x.toString())),
  //   null,
  //   4,
  // );
  for (const tokenId of positionsToWithdraw) {
    try {
      console.log(`\n--- Processing Position #${tokenId} ---`);
      await withdrawPosition(BigInt(tokenId), wallet, provider);
    } catch (error) {
      console.error(`Error processing position #${tokenId}:`, error.message);
    }
  }
}

const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];
function sortTokens(tokenA, tokenB) {
  return tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];
}

async function filterPosition(positionId, wallet) {
  const positionManager = new ethers.Contract(
    POSITION_MANAGER_ADDRESS,
    POSITION_MANAGER_ABI,
    wallet,
  );

  // Get position details
  const position = await positionManager.positions(positionId);
  const isL1Position = wrappedTokens.some((outcome) => {
    const sorted = sortTokens(outcome, sUSDS);
    return (
      position.token0.toLowerCase() === sorted[0].toLowerCase() &&
      position.token1.toLowerCase() === sorted[1].toLowerCase()
    );
  });
  return isL1Position;
  // if (!isL1Position) {
  //   console.log("Not l1 positionnnnnnnn");
  //   return;
  // }
  // const isOriginalityPosition = originalityPairs.some((pair) => {
  //   return (
  //     position.token0.toLowerCase() === pair.token0.toLowerCase() &&
  //     position.token1.toLowerCase() === pair.token1.toLowerCase()
  //   );
  // });
  // return isOriginalityPosition;
}
const arr = [];
async function getTokenBalance(tokenAddress) {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);
  const walletAddress = wallet.address;
  const token = new ethers.Contract(tokenAddress, erc20Abi, provider);
  return ethers.formatUnits(await token.balanceOf(walletAddress), 18);
}
const sUSDS = "0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0";
async function withdrawPosition(positionId, wallet, provider) {
  const positionManager = new ethers.Contract(
    POSITION_MANAGER_ADDRESS,
    POSITION_MANAGER_ABI,
    wallet,
  );

  // Get position details
  const position = await positionManager.positions(positionId);

  // if (position.liquidity.toString() === "0") {
  //   console.log("Position has no liquidity, burning...");
  //   const burnTx = await positionManager.burn(positionId);
  //   console.log("Burn transaction hash:", burnTx.hash);
  //   await burnTx.wait();
  //   return;
  // }

  console.log("Token0:", position.token0);
  console.log("Token1:", position.token1);
  console.log("Fee Tier:", position.fee);
  console.log("Liquidity:", position.liquidity.toString());

  // Create Token objects
  const token0 = new Token(CHAIN_ID, position.token0, 18, "TOKEN0");
  const token1 = new Token(CHAIN_ID, position.token1, 18, "TOKEN1");

  // Get pool data
  const poolAddress = Pool.getAddress(token0, token1, position.fee);
  arr.push({
    token0: position.token0,
    token1: position.token1,
    liquidity: position.liquidity.toString(),
    positionId: positionId.toString(),
    poolAddress,
  });
  const poolContract = new ethers.Contract(poolAddress, POOL_ABI, provider);
  const [slot0, liquidity] = await Promise.all([poolContract.slot0(), poolContract.liquidity()]);

  // Construct pool
  const pool = new Pool(
    token0,
    token1,
    Number(position.fee),
    slot0.sqrtPriceX96.toString(),
    liquidity.toString(),
    Number(slot0.tick),
  );
  // Construct position
  const sdkPosition = new Position({
    pool: pool,
    liquidity: position.liquidity.toString(),
    tickLower: Number(position.tickLower),
    tickUpper: Number(position.tickUpper),
  });

  // Prepare collect options for fees
  const collectOptions = {
    tokenId: positionId.toString(),
    expectedCurrencyOwed0: CurrencyAmount.fromRawAmount(token0, 0),
    expectedCurrencyOwed1: CurrencyAmount.fromRawAmount(token1, 0),
    recipient: wallet.address,
  };
  // Remove liquidity
  const removeLiquidityOptions = {
    deadline: Math.floor(Date.now() / 1000) + 60 * 20, // 20 minutes
    slippageTolerance: new Percent(10, 10_000), // 0.1%
    tokenId: positionId.toString(),
    liquidityPercentage: new Percent(1, 2), // 50%
    collectOptions,
  };

  // Generate transaction
  const { calldata, value } = NonfungiblePositionManager.removeCallParameters(
    sdkPosition,
    removeLiquidityOptions,
  );

  const transaction = {
    data: calldata,
    to: POSITION_MANAGER_ADDRESS,
    value: value,
    from: wallet.address,
    gasLimit: ethers.toBigInt(500000), // Adjust as needed
  };

  console.log("Sending transaction to remove liquidity...");
  const tx = await wallet.sendTransaction(transaction);
  console.log("Transaction hash:", tx.hash);

  console.log("Waiting for confirmation...");
  const receipt = await tx.wait();
  console.log("Transaction confirmed! Block:", receipt.blockNumber);
  // const burnTx = await positionManager.burn(positionId);
  // console.log("Burn transaction hash:", burnTx.hash);
  // await burnTx.wait();
}

// Run the script
withdrawAllPositions()
  .then(() => {
    console.log("\n✅ All positions processed successfully!");
    fs.writeFileSync("campaigns/l1-deepfunding/execution.json", JSON.stringify(arr, null, 4));
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Error:", error);
    process.exit(1);
  });
