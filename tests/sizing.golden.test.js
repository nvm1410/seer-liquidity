// Golden tests: prove lib/ reproduces, exactly, what the frozen scripts did.
//
// The committed execution JSONs hold BOTH the inputs and the outputs of the
// functions being extracted — outcomeToken, collateralToken, seedPrice and
// preExisting go in; tickLower/tickUpper/amount0/amount1/outcomeUsed/
// collateralUsed come out. So the extraction can be checked against several
// hundred real on-chain positions with no RPC, no chain state and no cost.
//
//   node --test tests/
//
// Assertions are exact BigInt equality. Fresh pools only: for a preExisting
// pool the log records effectivePrice rather than the raw sqrtPriceX96, and
// inverting that loses the low bits, so those rows cannot be reproduced to the
// wei from what was written down. They are counted and reported, not faked.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { buildPoolAndBounds, sizePosition } from "../lib/uniswap.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));

// Two generations of log field names, which is itself the drift this library
// exists to end: the originality lineage writes seedPrice/collateralUsed, while
// the zcash/nu7/octant lineage writes price/susdsUsed — a name that stops making
// sense the moment a pool's other side is a parent outcome token rather than
// sUSDS. Read both; emit one.
const seedPriceOf = (row) => (row.seedPrice !== undefined ? row.seedPrice : row.price);
const collateralUsedOf = (row) => (row.collateralUsed !== undefined ? row.collateralUsed : row.susdsUsed);
const labelOf = (row) => row.key ?? `${row.shortName ?? row.id}:${row.side ?? row.tag ?? ""}`;

/**
 * Replay every `pool` row of an execution log through lib/ and compare.
 * Returns {checked, skipped} so a fixture that silently stops covering
 * anything shows up as a failure rather than as a green run.
 */
function replay({ log, chainId, feeTier, tickSpacing, band, collateralOf }) {
  const rows = read(log).filter((e) => e.kind === "pool");
  assert.ok(rows.length > 0, `${log}: no pool rows`);

  let checked = 0;
  let skipped = 0;

  for (const row of rows) {
    if (row.preExisting) {
      skipped++;
      continue;
    }
    const at = labelOf(row);
    const meta = buildPoolAndBounds({
      outcomeToken: row.outcomeToken,
      collateral: collateralOf(row),
      price: seedPriceOf(row),
      live: null,
      chainId,
      feeTier,
      tickSpacing,
      band,
    });

    assert.equal(meta.tickLower, row.tickLower, `${at}: tickLower`);
    assert.equal(meta.tickUpper, row.tickUpper, `${at}: tickUpper`);

    // The recorded outcome quantity is what produced this position, so feeding
    // it back must reproduce both legs to the wei.
    const sized = sizePosition(meta, BigInt(row.outcomeUsed));
    assert.equal(sized.amount0.toString(), row.amount0, `${at}: amount0`);
    assert.equal(sized.amount1.toString(), row.amount1, `${at}: amount1`);
    assert.equal(sized.outcomeUsed.toString(), row.outcomeUsed, `${at}: outcomeUsed`);
    assert.equal(sized.collateralUsed.toString(), collateralUsedOf(row), `${at}: collateralUsed`);

    if (row.effectivePrice !== undefined) {
      // effectivePrice is a float; one tick of granularity is the floor.
      assert.ok(
        Math.abs(meta.effectivePrice - row.effectivePrice) / row.effectivePrice < 1e-6,
        `${at}: effectivePrice ${meta.effectivePrice} vs ${row.effectivePrice}`
      );
    }
    checked++;
  }
  return { checked, skipped };
}

describe("golden: originality-r3 sizing (196 pools, conditional collateral)", () => {
  it("reproduces every fresh pool exactly", () => {
    const m = read("lifecycle/originality-r3.json");
    const { checked, skipped } = replay({
      log: "add-originality-r3-v2-liquidity-execution.json",
      chainId: m.chain.id,
      feeTier: m.amm.feeTier,
      tickSpacing: m.amm.tickSpacing,
      band: m.liquidity.band,
      // The other side of these pools is the repo's BUNDLE token, not sUSDS —
      // the case that only generation 3 of buildPoolAndBounds handles.
      collateralOf: (row) => row.collateralToken,
    });
    assert.ok(checked >= 150, `expected to check most of the 196 pools, checked ${checked} (skipped ${skipped})`);
    console.log(`      ${checked} fresh pools reproduced exactly, ${skipped} pre-existing skipped`);
  });
});

describe("golden: zcash-nu7 v3 round 1 sizing (n-outcome categorical, sUSDS)", () => {
  it("reproduces every fresh pool exactly", () => {
    const m = read("lifecycle/zcash-nu7.json");
    const { checked } = replay({
      log: "add-zcash-nu7-liquidity-v3-execution.json",
      chainId: m.chain.id,
      feeTier: m.amm.feeTier,
      tickSpacing: m.amm.tickSpacing,
      band: m.liquidity.band,
      collateralOf: () => m.chain.collateral.address,
    });
    assert.equal(checked, 14);
    console.log(`      ${checked} fresh pools reproduced exactly`);
  });
});

describe("golden: zcash-q3 sizing (74 binary pools, sUSDS)", () => {
  it("reproduces every fresh pool exactly", () => {
    const m = read("lifecycle/zcash-q3.json");
    const { checked } = replay({
      log: "add-zcash-liquidity-execution.json",
      chainId: m.chain.id,
      feeTier: m.amm.feeTier,
      tickSpacing: m.amm.tickSpacing,
      band: m.liquidity.band,
      collateralOf: () => m.chain.collateral.address,
    });
    assert.equal(checked, 74);
    console.log(`      ${checked} fresh pools reproduced exactly`);
  });
});

describe("golden: the round-2 re-seed is NOT reproducible from seed prices", () => {
  it("records that every round-2 pool was pre-existing", () => {
    // Round 2 re-seeded pools that already existed, so every row was priced off
    // live slot0. Nothing there can be reproduced from the seed price alone.
    // Asserted explicitly so this stays a documented gap rather than a silent one.
    const rows = read("add-zcash-nu7-liquidity-v3-round2-execution.json").filter((e) => e.kind === "pool");
    assert.equal(rows.length, 14);
    assert.equal(rows.filter((r) => !r.preExisting).length, 0);
  });
});
