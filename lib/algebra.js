// Swapr / Algebra V1 on Gnosis.
//
// Algebra is NOT "Uniswap V3 with different addresses", and the differences all
// bite at the ABI and calldata layer:
//
//   - ONE dynamic fee, no fee tiers. `positions()` returns ELEVEN values, not
//     twelve — there is no `uint24 fee`, so every index after token1 shifts by
//     one. This is why lib/positions.js and this file cannot share an ABI.
//   - `globalState()` replaces `slot0()`. Its first field is called `price` but
//     it IS the sqrtPriceX96.
//   - Pool addresses are CREATE2 from the POOL DEPLOYER (not the factory) with a
//     TWO-address salt — no fee in it, unlike Uniswap's three-field salt.
//   - @uniswap/v3-sdk's NonfungiblePositionManager calldata builders emit the
//     Uniswap NPM ABI, which Algebra does not share. Only the Pool/Position MATH
//     is reusable; every call is hand-encoded through multicall.
//
// mathFeeTier (3000) exists solely so the v3 SDK derives tickSpacing 60 for that
// math. It is never sent on chain.

import { Percent, Token } from "@uniswap/sdk-core";
import { Pool, Position } from "@uniswap/v3-sdk";
import { ethers } from "ethers";
import { ALGEBRA_INIT_CODE_HASH } from "./chains.js";
import { sortTokens } from "./ticks.js";

export const MAX_UINT128 = (1n << 128n) - 1n;

export const ALGEBRA_NPM_ABI = [
  "function balanceOf(address owner) external view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)",
  // ELEVEN values — no `uint24 fee`.
  "function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function createAndInitializePoolIfNecessary(address token0, address token1, uint160 sqrtPriceX96) external payable",
  // MintParams minus `uint24 fee`: ten fields, not eleven.
  "function mint((address token0,address token1,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) external payable",
  "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) external payable returns (uint256 amount0, uint256 amount1)",
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max) params) external payable returns (uint256 amount0, uint256 amount1)",
  "function burn(uint256 tokenId) external payable",
  "function multicall(bytes[] data) external payable returns (bytes[] results)",
];

export const ALGEBRA_POOL_ABI = [
  // `price` is the sqrtPriceX96 despite the name.
  "function globalState() external view returns (uint160 price, int24 tick, uint16 lastFee, uint8 pluginConfig, uint16 communityFee, bool unlocked)",
  "function liquidity() external view returns (uint128)",
];

export const algebraInterface = new ethers.Interface(ALGEBRA_NPM_ABI);

/**
 * CREATE2 pool address. Salt is keccak256(abi.encode(token0, token1)) — 64
 * bytes, with NO fee, against the POOL DEPLOYER rather than the factory.
 */
export function computePoolAddress(tokenA, tokenB, { poolDeployer, initCodeHash = ALGEBRA_INIT_CODE_HASH }) {
  const [t0, t1] = sortTokens(tokenA, tokenB);
  const salt = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [t0, t1]));
  return ethers.getCreate2Address(poolDeployer, salt, initCodeHash);
}

/**
 * Read an Algebra pool's live state as a v3-sdk Pool.
 *
 * Returns null when the pool does not exist yet, so callers can distinguish a
 * fresh pool from a drained one — the distinction that makes a re-seed correct.
 */
export async function readLivePool(tokenA, tokenB, { provider, chainId, poolDeployer, mathFeeTier = 3000, decimals = 18 }) {
  const [t0, t1] = sortTokens(tokenA, tokenB);
  const poolAddress = computePoolAddress(t0, t1, { poolDeployer });
  const code = await provider.getCode(poolAddress);
  if (!code || code === "0x") return { poolAddress, pool: null, live: null };

  const contract = new ethers.Contract(poolAddress, ALGEBRA_POOL_ABI, provider);
  const [gs, liq] = await Promise.all([contract.globalState(), contract.liquidity()]);
  const pool = new Pool(
    new Token(chainId, t0, decimals, "T0"),
    new Token(chainId, t1, decimals, "T1"),
    mathFeeTier,
    gs.price.toString(),
    liq.toString(),
    Number(gs.tick)
  );
  // Shaped like Uniswap's slot0 so buildPoolAndBounds takes either.
  return { poolAddress, pool, live: { sqrtPriceX96: gs.price.toString(), tick: Number(gs.tick) } };
}

/**
 * createAndInitializePoolIfNecessary + mint, as one multicall.
 *
 * mintAmountsWithSlippage returns RAW JSBI, not CurrencyAmount — `.toString()`,
 * never `.quotient.toString()`. Getting that backwards throws while building
 * calldata, which is how the first live Gnosis remove run failed.
 */
export function buildMintCalldata({ meta, amount0, amount1, recipient, slippageBps = 50, deadlineSeconds = 1200 }) {
  const create = algebraInterface.encodeFunctionData("createAndInitializePoolIfNecessary", [
    meta.pool.token0.address,
    meta.pool.token1.address,
    meta.sqrtPriceX96.toString(),
  ]);

  const { amount0: amount0Min, amount1: amount1Min } = meta.position.mintAmountsWithSlippage(
    new Percent(slippageBps, 10_000)
  );

  const mint = algebraInterface.encodeFunctionData("mint", [
    [
      meta.pool.token0.address,
      meta.pool.token1.address,
      meta.tickLower,
      meta.tickUpper,
      amount0.toString(),
      amount1.toString(),
      amount0Min.toString(), // raw JSBI
      amount1Min.toString(), // raw JSBI
      recipient,
      Math.floor(Date.now() / 1000) + deadlineSeconds,
    ],
  ]);

  return algebraInterface.encodeFunctionData("multicall", [[create, mint]]);
}

/**
 * decreaseLiquidity + collect (+ burn), as one multicall — the hand-rolled
 * equivalent of NonfungiblePositionManager.removeCallParameters.
 *
 * Note burnNft defaults TRUE here, matching remove-liquidity-gnosis.js:32 and
 * opposite to the Uniswap side, where the NFTs are kept so a later round can
 * increaseLiquidity the same tokenIds.
 */
export function buildRemoveCalldata({ tokenId, position, recipient, slippageBps = 50, burnNft = true, deadlineSeconds = 1200 }) {
  const { amount0: amount0Min, amount1: amount1Min } = position.burnAmountsWithSlippage(
    new Percent(slippageBps, 10_000)
  );

  const decrease = algebraInterface.encodeFunctionData("decreaseLiquidity", [
    [
      tokenId,
      position.liquidity.toString(),
      amount0Min.toString(), // raw JSBI, NOT .quotient
      amount1Min.toString(),
      Math.floor(Date.now() / 1000) + deadlineSeconds,
    ],
  ]);
  const collect = algebraInterface.encodeFunctionData("collect", [
    [tokenId, recipient, MAX_UINT128.toString(), MAX_UINT128.toString()],
  ]);

  const calls = [decrease, collect];
  if (burnNft) calls.push(algebraInterface.encodeFunctionData("burn", [tokenId]));
  return algebraInterface.encodeFunctionData("multicall", [calls]);
}

/** Rebuild an SDK Position from an Algebra positions() row plus its live pool. */
export function buildSdkPosition(pos, pool) {
  return new Position({
    pool,
    liquidity: pos.liquidity.toString(),
    tickLower: Number(pos.tickLower),
    tickUpper: Number(pos.tickUpper),
  });
}
