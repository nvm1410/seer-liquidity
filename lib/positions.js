// Uniswap V3 position NFTs: enumerate, classify, project, withdraw.
//
// Canonical source is withdraw-l1-liquidity.js, which is the best of the three
// withdraw scripts by a distance. It alone:
//   - factors buildSdkPosition so one positions() read serves both the
//     projection pass and the withdrawal (nu7's re-fetches, costing a second RPC)
//   - classifies THREE ways, so positions at zero liquidity but holding
//     uncollected fees are swept rather than skipped
//   - supports burnToken and a standalone collect sweep
//
// withdraw-zcash-nu7-liquidity.js:246 only PRINTS a warning that residual fees
// "must be collected separately", and its ABI has no collect fragment at all —
// so that lineage leaves fees on the table by omission. Its early exit also
// checks withLiquidity alone, meaning a wallet holding nothing but fee-bearing
// empty positions is told "nothing to withdraw".

import { CurrencyAmount, Percent, Token } from "@uniswap/sdk-core";
import { NonfungiblePositionManager, Pool, Position } from "@uniswap/v3-sdk";
import { ethers } from "ethers";
import { runBatched } from "./batch.js";
import { pairKey } from "./ticks.js";
import { POSITION_MANAGER_ABI, POOL_MIN_ABI } from "./uniswap.js";

export const MAX_UINT128 = (1n << 128n) - 1n;

/**
 * The @uniswap SDK returns two different shapes and the distinction is invisible
 * at the call site. Getting it wrong throws "Cannot read properties of
 * undefined" while BUILDING calldata — which is how the Gnosis remove script
 * failed on its first live run (no transaction was sent, luckily).
 *
 *   position.amount0 / .amount1                -> CurrencyAmount -> .quotient
 *   position.mintAmounts / mintAmountsWithSlippage
 *   position.burnAmountsWithSlippage           -> raw JSBI       -> .toString()
 */
export const fromCurrencyAmount = (c) => BigInt(c.quotient.toString());
export const fromRawAmount = (j) => BigInt(j.toString());

/** Enumerate every position NFT the wallet holds. */
export async function enumerateWalletPositions(positionManager, owner, { batchSize = 20, pauseMs = 1000 } = {}) {
  const balance = await positionManager.balanceOf(owner);
  const indexes = Array.from({ length: Number(balance) }, (_, i) => i);
  const tokenIds = await runBatched(indexes, (i) => positionManager.tokenOfOwnerByIndex(owner, i), { batchSize, pauseMs });
  return runBatched(tokenIds, async (tokenId) => ({ tokenId, pos: await positionManager.positions(tokenId) }), {
    batchSize,
    pauseMs,
  });
}

/**
 * Build a scope map from (outcomeToken, collateral) to metadata, so enumerated
 * positions can be matched without a hard-coded tokenId list — anything minted
 * after the execution log was written is still caught.
 */
export function scopeByPair(markets, collateral) {
  const byPair = new Map();
  for (const { label, address, wrappedTokens, outcomes } of markets) {
    wrappedTokens.forEach((token, index) => {
      byPair.set(pairKey(token, collateral), {
        market: label,
        marketAddress: address,
        index,
        outcomeToken: token,
        name: outcomes?.[index] ?? `outcome${index}`,
      });
    });
  }
  return byPair;
}

/** Keep only the enumerated positions that belong to this campaign. */
export function matchPositions(positionsData, byPair) {
  return positionsData
    .map(({ tokenId, pos }) => ({ tokenId, pos, meta: byPair.get(pairKey(pos.token0, pos.token1)) }))
    .filter((x) => x.meta)
    .sort((a, b) => (a.tokenId < b.tokenId ? -1 : 1));
}

/**
 * Three buckets, not two. `emptyWithFees` is the one the nu7 lineage drops:
 * zero liquidity but non-zero tokensOwed, i.e. real money still claimable.
 */
export function classifyPositions(matched) {
  const withLiquidity = matched.filter((x) => x.pos.liquidity > 0n);
  const emptyWithFees = matched.filter(
    (x) => x.pos.liquidity === 0n && (x.pos.tokensOwed0 > 0n || x.pos.tokensOwed1 > 0n)
  );
  const emptyClean = matched.filter((x) => x.pos.liquidity === 0n && x.pos.tokensOwed0 === 0n && x.pos.tokensOwed1 === 0n);
  return { withLiquidity, emptyWithFees, emptyClean, hasWork: withLiquidity.length > 0 || emptyWithFees.length > 0 };
}

/**
 * Build the SDK Position for an already-fetched on-chain position.
 *
 * Takes `pos` rather than a tokenId deliberately: callers read positions() once
 * and reuse it for both the projection and the withdrawal.
 */
export async function buildSdkPosition(pos, { provider, chainId, decimals = 18 }) {
  const token0 = new Token(chainId, pos.token0, decimals, "TOKEN0");
  const token1 = new Token(chainId, pos.token1, decimals, "TOKEN1");
  const poolAddress = Pool.getAddress(token0, token1, Number(pos.fee));
  const poolContract = new ethers.Contract(poolAddress, POOL_MIN_ABI, provider);
  const [slot0, poolLiquidity] = await Promise.all([poolContract.slot0(), poolContract.liquidity()]);
  const pool = new Pool(
    token0,
    token1,
    Number(pos.fee),
    slot0.sqrtPriceX96.toString(),
    poolLiquidity.toString(),
    Number(slot0.tick)
  );
  const sdkPosition = new Position({
    pool,
    liquidity: pos.liquidity.toString(),
    tickLower: Number(pos.tickLower),
    tickUpper: Number(pos.tickUpper),
  });
  return { token0, token1, pool, sdkPosition };
}

/**
 * What the wallet gets back if everything is withdrawn now, per token.
 *
 * This is what a dry run should print before anyone decides: it includes owed
 * fees from BOTH buckets, and caches the per-position figures back onto the item
 * so the table and the execution see the same numbers.
 */
export async function projectReturns({ withLiquidity, emptyWithFees }, { provider, chainId }) {
  const byToken = new Map();
  const add = (addr, amt) => byToken.set(addr.toLowerCase(), (byToken.get(addr.toLowerCase()) ?? 0n) + amt);
  let totalLiquidity = 0n;

  for (const item of withLiquidity) {
    const { sdkPosition } = await buildSdkPosition(item.pos, { provider, chainId });
    const out0 = fromCurrencyAmount(sdkPosition.amount0);
    const out1 = fromCurrencyAmount(sdkPosition.amount1);
    add(item.pos.token0, out0 + item.pos.tokensOwed0);
    add(item.pos.token1, out1 + item.pos.tokensOwed1);
    totalLiquidity += item.pos.liquidity;
    item.projected = { out0, out1 };
  }
  for (const item of emptyWithFees) {
    add(item.pos.token0, item.pos.tokensOwed0);
    add(item.pos.token1, item.pos.tokensOwed1);
    item.projected = { out0: 0n, out1: 0n };
  }
  return { byToken, totalLiquidity };
}

/**
 * Remove 100% of a position's liquidity and collect everything to the wallet.
 *
 * burnNft defaults to FALSE, matching withdraw-l1-liquidity.js:31 — keeping the
 * NFT lets a later round increaseLiquidity the same tokenId. The Gnosis remove
 * script defaults the other way.
 */
export async function withdrawPosition(
  tokenId,
  pos,
  { wallet, provider, chainId, positionManagerAddress, burnNft = false, slippageBps = 50, retry }
) {
  const { token0, token1, sdkPosition } = await buildSdkPosition(pos, { provider, chainId });

  const { calldata, value } = NonfungiblePositionManager.removeCallParameters(sdkPosition, {
    deadline: Math.floor(Date.now() / 1000) + 60 * 20,
    slippageTolerance: new Percent(slippageBps, 10_000),
    tokenId: tokenId.toString(),
    liquidityPercentage: new Percent(1, 1), // 100%
    collectOptions: {
      tokenId: tokenId.toString(),
      expectedCurrencyOwed0: CurrencyAmount.fromRawAmount(token0, 0),
      expectedCurrencyOwed1: CurrencyAmount.fromRawAmount(token1, 0),
      recipient: wallet.address,
    },
    ...(burnNft ? { burnToken: true } : {}),
  });

  const receipt = await retry(() => wallet.sendTransaction({ to: positionManagerAddress, data: calldata, value }));
  return {
    token0: pos.token0,
    token1: pos.token1,
    liquidity: pos.liquidity.toString(),
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
  };
}

/** Sweep fees off a position that already has zero liquidity. */
export async function collectFees(tokenId, { positionManager, wallet, retry }) {
  const receipt = await retry(() =>
    positionManager.collect({
      tokenId,
      recipient: wallet.address,
      amount0Max: MAX_UINT128,
      amount1Max: MAX_UINT128,
    })
  );
  return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
}

export { POSITION_MANAGER_ABI, POOL_MIN_ABI };
