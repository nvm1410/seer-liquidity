// Plain-ESM port of the *forward* pricing math from useImpliedProbs.ts.
// We already know the per-outcome default probabilities (from assets_pd.csv), so we
// only need the forward direction (probabilities -> prices), not the inverse solver
// (Adam warmup / Newton-Raphson / Web Worker), which is dropped here.

/**
 * Convert a yearly probability of default into a single-quarter probability of
 * default, assuming a constant quarterly hazard rate: survival compounds as
 * (1 - yearlyPD) = (1 - quarterlyPD)^4.
 */
export function yearlyToQuarterly(yearlyPD) {
  return 1 - (1 - yearlyPD) ** (1 / 4);
}

function convolveBernoulli(dist, p) {
  const next = Array(dist.length + 1).fill(0);
  for (let k = 0; k < dist.length; k++) {
    if (dist[k] === 0) continue;
    next[k] += dist[k] * (1 - p);
    next[k + 1] += dist[k] * p;
  }
  return next;
}

function convolve(a, b) {
  const res = Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) res[i + j] += a[i] * b[j];
  return res;
}

function buildPrefixSuffix(p) {
  const n = p.length;
  const prefix = Array(n + 1);
  const suffix = Array(n + 1);
  prefix[0] = [1];
  for (let i = 0; i < n; i++) prefix[i + 1] = convolveBernoulli(prefix[i], p[i]);
  suffix[n] = [1];
  for (let i = n - 1; i >= 0; i--) suffix[i] = convolveBernoulli(suffix[i + 1], p[i]);
  return { prefix, suffix };
}

/**
 * Given per-outcome default probabilities p[], returns:
 *  - priceY: probability that NO outcome defaults ("No To All"), = prod(1 - p_i)
 *  - prices[i]: the initial pool price for outcome i, i.e. p_i weighted by the
 *    expected payout dilution 1/(1+k) where k = number of *other* outcomes that
 *    also default (since defaults share a fixed payout pool).
 */
export function computePrices(p) {
  const n = p.length;
  let priceY = 1;
  for (const pi of p) priceY *= 1 - pi;
  const { prefix, suffix } = buildPrefixSuffix(p);
  const prices = Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const dist = convolve(prefix[i], suffix[i + 1]);
    let expectation = 0;
    for (let k = 0; k < dist.length; k++) expectation += dist[k] * (1 / (1 + k));
    prices[i] = p[i] * expectation;
  }
  return { priceY, prices };
}
