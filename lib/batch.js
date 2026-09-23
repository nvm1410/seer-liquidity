// Two different concurrency primitives that must not be merged.
//
// runBatched: fixed-size batches with a pause between them, used by the
// withdraw/merge/redeem family to be gentle on the RPC. Its 10 copies differ
// only in the pause — 1000ms in the withdraw scripts, 500ms in merge/redeem/
// verify — and nothing depends on which, so it is a parameter.
//
// mapConcurrent: a cursor-based worker pool with NO pause, used by
// add-originality-r3-liquidity.js:176 to resolve 98 child markets at
// concurrency 8. Different shape, different purpose; keep both.

/** Split into fixed-size chunks. */
export function chunk(arr, size) {
  if (size < 1) throw new Error(`chunk size must be >= 1, got ${size}`);
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run `fn` over items in batches of `batchSize`, pausing between batches. */
export async function runBatched(items, fn, { batchSize = 10, pauseMs = 500 } = {}) {
  const results = [];
  const batches = chunk(items, batchSize);
  for (let b = 0; b < batches.length; b++) {
    results.push(...(await Promise.all(batches[b].map((item, i) => fn(item, b * batchSize + i)))));
    if (b < batches.length - 1 && pauseMs > 0) await sleep(pauseMs);
  }
  return results;
}

/**
 * Worker-pool map: `concurrency` workers pull from a shared cursor until the
 * list is exhausted. Results keep input order. Unlike runBatched a slow item
 * does not stall the others, which is why the 98-child resolve uses it.
 */
export async function mapConcurrent(items, fn, { concurrency = 8 } = {}) {
  const out = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}
