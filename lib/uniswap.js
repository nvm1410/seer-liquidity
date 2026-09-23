// Pool construction and position sizing for Uniswap V3 style AMMs.
//
// Canonical source: add-originality-r3-liquidity.js:199-262 (generation 3).
// Three generations of buildPoolAndBounds exist in the repo:
//
//   gen 1  (outcomeToken, price)                  - Gnosis PD, add-octant-invalid
//   gen 2  (outcomeToken, price, live)            - add-zcash-nu7-liquidity
//   gen 3  (outcomeToken, collateral, price, live) - add-originality-r3-liquidity
//
// Gen 1 is BROKEN on any re-seed and gen 2 fixes it; gen 3 additionally lets the
// other side of the pool be a parent outcome token rather than base collateral.
// Everything here takes feeTier / tickSpacing / band as explicit parameters,
// because Gnosis needs a per-outcome band and a tickSpacing that does NOT follow
// from its fee. Never derive one from the other.

import { Token } from "@uniswap/sdk-core";
import { Pool, Position, TickMath } from "@uniswap/v3-sdk";
import { alignBand, priceToTick, sortTokens } from "./ticks.js";

/** The 2-entry fragment ~18 scripts inline. `abis/PoolAbi.js` has the full ABI. */
export const POOL_MIN_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
];

export const POSITION_MANAGER_ABI = [
  "function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function balanceOf(address owner) external view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) external payable returns (uint256 amount0, uint256 amount1)",
];

/**
 * Build the Pool to size against, plus the tick range.
 *
 * `live` is the pool's on-chain slot0 ({sqrtPriceX96, tick}) or null when the
 * pool has never been initialised. It is load-bearing on any re-seed: a drained
 * pool still exists and keeps its last price, and
 * createAndInitializePoolIfNecessary is a NO-OP on it — so the mint executes at
 * the pool's own price whatever sqrtPriceX96 we pass. Sizing against the seed
 * price instead fails two ways: silently, by splitting the sides at the wrong
 * ratio; and loudly, because mintAmountsWithSlippage builds amount0Min/amount1Min
 * around the assumed price and a drifted pool reverts the mint outright.
 */
export function buildPoolAndBounds({
  outcomeToken,
  collateral,
  price,
  live = null,
  chainId,
  feeTier,
  tickSpacing,
  band,
  decimals = 18,
}) {
  const [t0, t1] = sortTokens(outcomeToken, collateral);
  const isToken0Outcome = t0.toLowerCase() === outcomeToken.toLowerCase();

  // Pool price is token1/token0: collateral/outcome (= price) when the outcome
  // is token0, else outcome/collateral (= 1/price).
  const orientedPrice = isToken0Outcome ? price : 1 / price;
  const tickCurrent = live ? live.tick : priceToTick(orientedPrice);
  const sqrtPriceX96 = (live ? live.sqrtPriceX96 : TickMath.getSqrtRatioAtTick(tickCurrent)).toString();

  const orientedActual = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
  const effectivePrice = isToken0Outcome ? orientedActual : 1 / orientedActual;

  const pool = new Pool(
    new Token(chainId, t0, decimals, "T0"),
    new Token(chainId, t1, decimals, "T1"),
    feeTier,
    sqrtPriceX96,
    "0",
    tickCurrent
  );

  const { tickLower, tickUpper } = alignBand({
    minPrice: band.minPrice,
    maxPrice: band.maxPrice,
    isToken0Outcome,
    spacing: tickSpacing,
  });

  // Fail rather than mint a position that is entirely on one side of the band:
  // the collateral would be parked where the market cannot trade against it.
  if (tickCurrent <= tickLower || tickCurrent >= tickUpper) {
    throw new Error(
      `price ${effectivePrice} sits outside the band [${band.minPrice}, ${band.maxPrice}] — the ` +
        "position would be entirely one-sided. Widen the band or reprice the outcome."
    );
  }

  return { pool, isToken0Outcome, tickLower, tickUpper, tickCurrent, effectivePrice, live: !!live };
}

// A sentinel that is always far more than the other side can need, so the side
// we care about is the one that binds.
const huge = (q) => (q + 1n) * 1000n;

function amounts(position, meta) {
  const a0 = BigInt(position.mintAmounts.amount0.toString());
  const a1 = BigInt(position.mintAmounts.amount1.toString());
  return {
    position,
    amount0: a0,
    amount1: a1,
    outcomeUsed: meta.isToken0Outcome ? a0 : a1,
    collateralUsed: meta.isToken0Outcome ? a1 : a0,
  };
}

/**
 * Size a position by a fixed OUTCOME-token quantity; the collateral leg falls
 * out. Equal q across a market's outcomes is what makes a split exact — every
 * token the split mints gets deployed, with nothing left over.
 *
 * Note the return field is `collateralUsed`. The zcash/nu7/octant lineage calls
 * it `susdsUsed`; that name does not survive a market whose collateral is a
 * parent outcome token.
 */
export function sizePosition(meta, qOutcome) {
  const position = Position.fromAmounts({
    pool: meta.pool,
    tickLower: meta.tickLower,
    tickUpper: meta.tickUpper,
    amount0: (meta.isToken0Outcome ? qOutcome : huge(qOutcome)).toString(),
    amount1: (meta.isToken0Outcome ? huge(qOutcome) : qOutcome).toString(),
    useFullPrecision: true,
  });
  return amounts(position, meta);
}

/**
 * Size a position by a fixed COLLATERAL amount; the outcome quantity falls out.
 *
 * Needed whenever an outcome's price is near 1, where matching a given outcome
 * quantity consumes almost that much collateral: Gnosis PD v1 put 4.27 of a 5
 * sDAI budget into the single "No To All" pool because its price was ~0.9654.
 * Lifted from add-pd-liquidity-gnosis-v2.js sizePositionBySdai.
 */
export function sizePositionByCollateral(meta, qCollateral) {
  const position = Position.fromAmounts({
    pool: meta.pool,
    tickLower: meta.tickLower,
    tickUpper: meta.tickUpper,
    amount0: (meta.isToken0Outcome ? huge(qCollateral) : qCollateral).toString(),
    amount1: (meta.isToken0Outcome ? qCollateral : huge(qCollateral)).toString(),
    useFullPrecision: true,
  });
  return amounts(position, meta);
}
