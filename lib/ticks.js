// Tick and token-ordering math shared by every pool-seeding script.
//
// Lifted from add-originality-r3-liquidity.js / add-zcash-nu7-liquidity.js,
// where sortTokens (22 copies) and priceToTick (11 copies) are byte-identical
// everywhere — so extracting them is provably behaviour-preserving.
//
// clampTickToSpacing is the exception: see the note on alignTick.

import { TickMath } from "@uniswap/v3-sdk";

const LN_1_0001 = Math.log(1.0001);

/** Uniswap/Algebra pool token order: ascending by address. */
export function sortTokens(a, b) {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

/** Order-independent key for a token pair. */
export function pairKey(a, b) {
  const [t0, t1] = sortTokens(a, b);
  return `${t0.toLowerCase()}/${t1.toLowerCase()}`;
}

/**
 * Price (token1 per token0) -> tick.
 *
 * This always FLOORS, which is why a freshly initialised pool sits up to one
 * tick (0.01% at tickSpacing 1) BELOW its seed price. That is the whole reason
 * check-originality-r3-pools.js verifies against PRICE_TOLERANCE = 0.001 rather
 * than demanding equality — the invariant is written down nowhere else, so it
 * travels with this function.
 */
export function priceToTick(price) {
  return Math.floor(Math.log(price) / LN_1_0001);
}

/** Inverse of priceToTick, for display and for checking a live pool's tick. */
export function tickToPrice(tick) {
  return 1.0001 ** tick;
}

/**
 * Snap a tick to the spacing grid, then into the representable range, WITHOUT
 * leaving the grid.
 *
 * The Optimism scripts (add-originality-r3-liquidity.js:222-229) align to the
 * spacing and only then clamp to MIN_TICK/MAX_TICK — which can hand back a
 * bound that is no longer a multiple of the spacing. At tickSpacing 1, which is
 * every Optimism pool, that is invisible. At tickSpacing 60 (Swapr/Algebra) it
 * is a revert: MIN_TICK is -887272, which is not a multiple of 60.
 *
 * So: align first, then clamp, then re-align INWARD so the result is always on
 * the grid and always inside the range. Neither existing copy does this
 * correctly for both spacings.
 */
export function alignTick(tick, { spacing, roundUp = false }) {
  if (!Number.isInteger(spacing) || spacing < 1) throw new Error(`bad tickSpacing ${spacing}`);
  let t = roundUp ? Math.ceil(tick / spacing) * spacing : Math.floor(tick / spacing) * spacing;
  if (t < TickMath.MIN_TICK) t = Math.ceil(TickMath.MIN_TICK / spacing) * spacing; // inward
  if (t > TickMath.MAX_TICK) t = Math.floor(TickMath.MAX_TICK / spacing) * spacing; // inward
  return t;
}

/**
 * The [minPrice, maxPrice] band, in prices of the OUTCOME token, expressed as a
 * pool tick range.
 *
 * When the outcome token is token1 the pool quotes its reciprocal, so the band
 * inverts and swaps ends.
 */
export function alignBand({ minPrice, maxPrice, isToken0Outcome, spacing }) {
  if (!(minPrice > 0) || !(maxPrice > 0)) throw new Error("band prices must be > 0");
  if (minPrice >= maxPrice) throw new Error(`band minPrice ${minPrice} >= maxPrice ${maxPrice}`);

  const lo = isToken0Outcome ? minPrice : 1 / maxPrice;
  const hi = isToken0Outcome ? maxPrice : 1 / minPrice;

  const tickLower = alignTick(priceToTick(lo), { spacing, roundUp: false });
  const tickUpper = alignTick(priceToTick(hi), { spacing, roundUp: true });

  if (tickLower >= tickUpper) throw new Error(`invalid tick range [${tickLower}, ${tickUpper}]`);
  return { tickLower, tickUpper };
}
