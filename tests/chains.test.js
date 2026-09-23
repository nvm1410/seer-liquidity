// lib/chains.js and lifecycle/*.json state the same addresses. This is the test
// that stops them drifting — which is the exact failure the whole library exists
// to prevent, so it would be careless to reintroduce it one level up.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { ethers } from "ethers";
import { CHAINS, chain } from "../lib/chains.js";
import { alignBand, alignTick, pairKey, priceToTick, sortTokens, tickToPrice } from "../lib/ticks.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const manifests = fs
  .readdirSync(path.join(ROOT, "lifecycle"))
  .filter((f) => f.endsWith(".json") && f !== "schema.json")
  .map((f) => ({ file: f, m: JSON.parse(fs.readFileSync(path.join(ROOT, "lifecycle", f), "utf8")) }));

describe("lib/chains.js agrees with every manifest", () => {
  it("has a manifest to check against", () => {
    assert.ok(manifests.length >= 5, `expected the back-filled manifests, found ${manifests.length}`);
  });

  for (const { file, m } of manifests) {
    it(`${file}: addresses, collateral and amm match the address book`, () => {
      const spec = chain(m.chain.id);
      assert.equal(m.chain.name, spec.name);
      assert.equal(ethers.getAddress(m.chain.collateral.address), spec.collateral.address);
      assert.equal(m.chain.collateral.symbol, spec.collateral.symbol);

      for (const [key, value] of Object.entries(m.addresses ?? {})) {
        assert.ok(spec.addresses[key], `${file}: lib/chains.js has no "${key}" for chain ${m.chain.id}`);
        assert.equal(
          ethers.getAddress(value),
          spec.addresses[key],
          `${file}: addresses.${key} differs from lib/chains.js`
        );
      }

      if (m.amm) {
        assert.equal(m.amm.kind, spec.amm.kind);
        assert.equal(m.amm.tickSpacing, spec.amm.tickSpacing);
        if (m.amm.feeTier !== undefined) assert.equal(m.amm.feeTier, spec.amm.feeTier);
        if (m.amm.mathFeeTier !== undefined) assert.equal(m.amm.mathFeeTier, spec.amm.mathFeeTier);
      }
    });
  }

  it("every address in the book is checksummed and non-zero", () => {
    for (const spec of Object.values(CHAINS)) {
      for (const [k, v] of Object.entries({ ...spec.addresses, collateral: spec.collateral.address })) {
        assert.equal(v, ethers.getAddress(v), `${spec.name}.${k} is not checksummed`);
        assert.notEqual(v, ethers.ZeroAddress, `${spec.name}.${k} is the zero address`);
      }
    }
  });

  it("Gnosis carries a mathFeeTier and no feeTier; Optimism the reverse", () => {
    // Algebra has one dynamic fee and no tiers. mathFeeTier 3000 exists only so
    // @uniswap/v3-sdk derives tickSpacing 60, and is never sent on chain.
    assert.equal(CHAINS[100].amm.feeTier, undefined);
    assert.equal(CHAINS[100].amm.mathFeeTier, 3000);
    assert.equal(CHAINS[100].amm.tickSpacing, 60);
    assert.equal(CHAINS[10].amm.feeTier, 100);
    assert.equal(CHAINS[10].amm.mathFeeTier, undefined);
    assert.equal(CHAINS[10].amm.tickSpacing, 1);
  });
});

describe("lib/ticks.js", () => {
  it("sortTokens is ascending and order-independent", () => {
    const a = "0xAAAA000000000000000000000000000000000001";
    const b = "0xBBBB000000000000000000000000000000000002";
    assert.deepEqual(sortTokens(a, b), [a, b]);
    assert.deepEqual(sortTokens(b, a), [a, b]);
    assert.equal(pairKey(a, b), pairKey(b, a));
  });

  it("priceToTick floors, which is why a fresh pool sits one tick low", () => {
    assert.equal(priceToTick(1), 0);
    // 0.02 and 0.98 are the band the Optimism campaigns actually use.
    assert.equal(priceToTick(0.02), Math.floor(Math.log(0.02) / Math.log(1.0001)));
    assert.ok(tickToPrice(priceToTick(0.55)) <= 0.55);
    assert.ok(tickToPrice(priceToTick(0.55) + 1) > 0.55);
  });

  it("alignTick keeps bounds ON the spacing grid even at the extremes", () => {
    // The bug in the Optimism line: align, then clamp to MIN_TICK/MAX_TICK,
    // leaving a bound off the grid. Invisible at spacing 1, a revert at 60.
    for (const spacing of [1, 60]) {
      for (const t of [-1e9, 1e9, -887272, 887272, 12345]) {
        const lo = alignTick(t, { spacing, roundUp: false });
        const hi = alignTick(t, { spacing, roundUp: true });
        assert.equal(Math.abs(lo % spacing), 0, `lo ${lo} off grid at spacing ${spacing}`);
        assert.equal(Math.abs(hi % spacing), 0, `hi ${hi} off grid at spacing ${spacing}`);
        assert.ok(lo >= -887272 && lo <= 887272, `lo ${lo} out of range`);
        assert.ok(hi >= -887272 && hi <= 887272, `hi ${hi} out of range`);
      }
    }
  });

  it("alignBand inverts when the outcome is token1", () => {
    const band = { minPrice: 0.02, maxPrice: 0.98 };
    const asT0 = alignBand({ ...band, isToken0Outcome: true, spacing: 1 });
    const asT1 = alignBand({ ...band, isToken0Outcome: false, spacing: 1 });
    // Reciprocal band: the token1 range brackets the reciprocals of the token0 one.
    assert.ok(asT0.tickLower < asT0.tickUpper);
    assert.ok(asT1.tickLower < asT1.tickUpper);
    assert.ok(Math.abs(asT0.tickLower + asT1.tickUpper) <= 1);
  });

  it("alignBand rejects a band that is not a band", () => {
    assert.throws(() => alignBand({ minPrice: 0.9, maxPrice: 0.1, isToken0Outcome: true, spacing: 1 }));
    assert.throws(() => alignBand({ minPrice: 0, maxPrice: 0.9, isToken0Outcome: true, spacing: 1 }));
  });
});
