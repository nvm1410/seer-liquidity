import { Token, Percent } from "@uniswap/sdk-core";
import { Pool, Position, TickMath, NonfungiblePositionManager } from "@uniswap/v3-sdk";
import "dotenv/config";
import { ethers } from "ethers";
import JSBI from "jsbi";
import { formatUnits, erc20Abi } from "viem";
import { MarketViewAbi } from "../../../abis/MarketViewAbi.js";
import { UniswapFactoryAbi } from "../../../abis/UniswapFactoryAbi.js";
import { markets } from "../markets.js";
import { ori } from "../originality.js";
import { RouterAbi } from "../../../abis/RouterAbi.js";

// The FIRST-generation originality round-2 seeder, superseded by
// add-back-liquidity.js and add-20k-originality-liquidity.js. This is the script
// that passed minPrice = 0, where priceToTick(0) = -Infinity clamped to MIN_TICK
// and spread depth across a range nobody trades in; round 3 uses [0.02, 0.98]
// and hard-fails outside it.

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
    `liquidity-originality.js is superseded and has no dry-run mode — it sends transactions immediately.
` +
      `  Refusing to run without --live. See add-back-liquidity.js and add-20k-originality-liquidity.js
` +
      `  and lifecycle/originality-r2.json for what replaced it.`
  );
  process.exit(REFUSED);
}

const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL;
const CHAIN_ID = 10;

const POSITION_MANAGER_ADDRESS = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";

// ABIs
const POSITION_MANAGER_ABI = [
  "function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function balanceOf(address owner) external view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)",
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);
const walletAddress = wallet.address;

function sortTokens(tokenA, tokenB) {
  return tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];
}

async function retryTransaction(txFn, retries = 3, delayMs = 3000) {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`Attempt ${attempt}/${retries}...`);
      const tx = await txFn(); // send transaction
      console.log(`Tx sent: ${tx.hash}`);

      const receipt = await tx.wait(); // wait for it to be mined
      console.log(`Tx confirmed in block ${receipt.blockNumber}`);
      return receipt; // success ✅
    } catch (err) {
      lastError = err;
      console.warn(`Attempt ${attempt} failed: ${err.message}`);

      if (attempt < retries) {
        console.log(`Retrying in ${delayMs / 1000}s...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError; // all retries failed ❌
}

async function getTokenBalance(tokenAddress) {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);
  const walletAddress = wallet.address;
  const token = new ethers.Contract(tokenAddress, erc20Abi, provider);
  return await token.balanceOf(walletAddress);
}

async function approveBalance(tokenAddress, spender, amount) {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);
  const token = new ethers.Contract(tokenAddress, erc20Abi, wallet);
  await retryTransaction(async () => token.approve(spender, amount));
}

const POOL_ABI = [
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() external view returns (uint128)",
];

const LN_1_0001 = Math.log(1.0001);

export function priceToTick(price) {
  return Math.floor(Math.log(price) / LN_1_0001);
}

export function tickToPrice(tick) {
  return Math.pow(1.0001, tick);
}

function calculateTickBounds(minPrice, maxPrice, tickSpacing, isToken0Outcome) {
  let tickLower;
  let tickUpper;

  if (isToken0Outcome) {
    // token0 is outcome, token1 is collateral
    // Price = collateral/outcome
    // Valid range: [minPrice, maxPrice] collateral per outcome
    tickLower = Math.floor(priceToTick(minPrice) / tickSpacing) * tickSpacing;
    tickUpper = Math.ceil(priceToTick(maxPrice) / tickSpacing) * tickSpacing;
  } else {
    // token0 is collateral, token1 is outcome
    // Price = outcome/collateral
    // Valid range: [1/maxPrice, 1/minPrice] outcome per collateral
    tickLower = Math.floor(priceToTick(1 / maxPrice) / tickSpacing) * tickSpacing;
    tickUpper = Math.ceil(priceToTick(1 / minPrice) / tickSpacing) * tickSpacing;
  }

  // Ensure ticks are within valid range
  const MIN_TICK = TickMath.MIN_TICK;
  const MAX_TICK = TickMath.MAX_TICK;

  tickLower = Math.max(tickLower, MIN_TICK);
  tickUpper = Math.min(tickUpper, MAX_TICK);

  // Ensure tickLower < tickUpper
  if (tickLower >= tickUpper) {
    throw new Error("Invalid tick range: tickLower must be less than tickUpper");
  }

  // Ensure ticks are aligned to tick spacing
  tickLower = Math.floor(tickLower / tickSpacing) * tickSpacing;
  tickUpper = Math.ceil(tickUpper / tickSpacing) * tickSpacing;

  return { tickLower, tickUpper };
}
// 0x00DC3E0AcAdB8dBA21BB08fF30540222FF8836e0

async function getMarketInfo(marketAddress) {
  const marketFactory = "0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6";
  // Get MarketView contract instance
  const marketView = new ethers.Contract(
    "0x336695ec9efbafd6322fb82eaadbcda02e38f348",
    MarketViewAbi,
    provider
  );

  // Fetch market data from MarketView
  const result = await marketView.getMarket(marketFactory, marketAddress);

  // Extract parent market information if this is a conditional market
  const isConditional =
    result.parentCollectionId !==
    "0x0000000000000000000000000000000000000000000000000000000000000000";
  const parentMarketAddress =
    isConditional && result.parentMarket ? result.parentMarket.id : undefined;
  const parentOutcomeIndex = isConditional ? Number(result.parentOutcome) : undefined;
  let parentOutcomeToken = undefined;

  // For conditional markets, we need to get the base collateral token and parent outcome token from the parent market
  let baseCollateralToken = result.collateralToken;
  if (isConditional && parentMarketAddress) {
    const parentMarketInfo = await marketView.getMarket(marketFactory, parentMarketAddress);
    baseCollateralToken = parentMarketInfo.collateralToken;
    // Get the parent outcome token from the parent market's wrapped tokens
    if (parentMarketInfo.wrappedTokens && parentMarketInfo.wrappedTokens[parentOutcomeIndex]) {
      parentOutcomeToken = parentMarketInfo.wrappedTokens[parentOutcomeIndex];
    }
  }

  return {
    id: result.id,
    name: result.marketName,
    conditionId: result.conditionId,
    collateralToken: baseCollateralToken,
    wrappedTokens: result.wrappedTokens,
    outcomeTokens: "0x", // Not directly provided by MarketView, will need to compute
    lowerBound: result.lowerBound,
    upperBound: result.upperBound,
    parentCollectionId: result.parentCollectionId,
    parentMarketAddress,
    parentOutcomeIndex,
    parentOutcomeToken,
  };
}

async function addLiquidityUpAndDown({ marketAddress, initialPrices }) {
  const feeTier = 100;
  const tickSpacing = 1;
  const slippage = 0.01;
  try {
    // Get market information
    console.log("\n1. Fetching market information...");
    const marketInfo = await getMarketInfo(marketAddress);

    // Exclude the last token (Invalid result token)
    const outcomeTokens = marketInfo.wrappedTokens.slice(0, -1);

    if (initialPrices.length !== outcomeTokens.length) {
      throw new Error(
        `Mismatch: ${initialPrices.length} prices provided but market has ${outcomeTokens.length} outcomes (excluding Invalid)`
      );
    }

    const availableCollateralPerPool = 13333333333333333333300n;
    const collateralBalance = await getTokenBalance(marketInfo.parentOutcomeToken);
    console.log({ collateralBalance: formatUnits(collateralBalance, 18) });
    if (collateralBalance / 2n < availableCollateralPerPool) {
      throw new Error("not enough collateral");
    }
    const availableOutcome = availableCollateralPerPool;
    // Add liquidity to each pool
    console.log("\n2. Adding liquidity to each outcome pool...");

    for (let i = 0; i < outcomeTokens.length; i++) {
      const wrappedToken = outcomeTokens[i];

      const minPrice = 0;
      const maxPrice = 0.95;

      // Sort tokens
      const [token0, token1] = sortTokens(wrappedToken, marketInfo.parentOutcomeToken);
      const isToken0Outcome = token0 === wrappedToken;
      const poolAddress = Pool.getAddress(
        new Token(CHAIN_ID, token0, 18, "TOKEN0"),
        new Token(CHAIN_ID, token1, 18, "TOKEN1"),
        feeTier
      );
      const poolContract = new ethers.Contract(poolAddress, POOL_ABI, provider);
      const [slot0, liquidity] = await Promise.all([
        poolContract.slot0(),
        poolContract.liquidity(),
      ]);

      // Create Pool instance
      const pool = new Pool(
        new Token(CHAIN_ID, token0, 18, "TOKEN0"),
        new Token(CHAIN_ID, token1, 18, "TOKEN1"),
        feeTier,
        slot0.sqrtPriceX96.toString(),
        liquidity.toString(),
        Number(slot0.tick)
      );
      const bounds = calculateTickBounds(minPrice, maxPrice, tickSpacing, isToken0Outcome);
      const { tickLower, tickUpper } = bounds;
      const availableAmount0 = isToken0Outcome ? availableOutcome : availableCollateralPerPool;
      const availableAmount1 = isToken0Outcome ? availableCollateralPerPool : availableOutcome;
      const position = Position.fromAmounts({
        pool,
        tickLower,
        tickUpper,
        amount0: availableAmount0.toString(),
        amount1: availableAmount1.toString(),
        useFullPrecision: true,
      });
      const amount0 = BigInt(position.mintAmounts.amount0.toString());
      const amount1 = BigInt(position.mintAmounts.amount1.toString());

      console.log({
        amount0: formatUnits(amount0, 18),
        amount1: formatUnits(amount1, 18),
        availableAmount0: formatUnits(availableAmount0, 18),
        availableAmount1: formatUnits(availableAmount1, 18),
      });

      // Approve tokens
      console.log(`     Approving tokens...`);
      const positionManagerAddress = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";

      await approveBalance(token0, positionManagerAddress, availableAmount0);
      await approveBalance(token1, positionManagerAddress, availableAmount1);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      // Mint position
      console.log(`     Minting liquidity position...`);

      const { calldata, value } = NonfungiblePositionManager.addCallParameters(position, {
        slippageTolerance: new Percent(10, 10_000),
        recipient: wallet.address,
        deadline: Math.floor(Date.now() / 1000) + 60 * 20, // 20 minutes
      });
      // Send transaction
      console.log("\nMinting position...");
      const nonce = await provider.getTransactionCount(wallet.address, "pending");
      const transaction = {
        to: positionManagerAddress,
        data: calldata,
        value: value,
        nonce,
      };
      const receipt = await retryTransaction(async () => wallet.sendTransaction(transaction));
      console.log("Transaction confirmed! Block:", receipt.blockNumber);
      await new Promise((res) => setTimeout(res, 3000));
    }

    console.log("\n✅ Successfully added liquidity to all outcome pools!");
  } catch (error) {
    console.error("\n❌ Error adding liquidity:", error);
    throw error;
  }
}

async function run() {
  const startIndex = markets.findIndex(
    (x) => x.marketId === "0x46ebAd092625c58A1B4084eF08c07c8dBbc4636B"
  );
  console.log(startIndex);
  for (const market of markets.slice(startIndex)) {
    console.log("start market ", market.marketId);

    await addLiquidityUpAndDown({
      marketAddress: market.marketId,
      initialPrices: market.prices,
    });
  }
}

run()
  .then(() => {
    console.log("\n✅ All markets processed successfully!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Error:", error);
    process.exit(1);
  });
