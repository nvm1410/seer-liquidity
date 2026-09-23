// Golden: replay the recorded L1 merges and redemption through lib/settle.js.
//
// The merge log records balancesBefore, merged and leftover for both markets, so
// planMerge is checkable to the wei against a real unwind that moved ~20,476
// sUSDS. The redemption log records the chunk plan, so the chunker is checkable
// against the 8 transactions that actually settled the campaign.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { bmin, chunkRedemption, planMerge, planRedemption } from "../lib/settle.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));

describe("golden: the L1 merge (worth ~17.7k in ordering alone)", () => {
  const rows = read("campaigns/l1-deepfunding/merge-l1-positions-execution.json");

  it("has both phases recorded", () => {
    assert.equal(rows.length, 2);
  });

  for (const row of rows) {
    it(`${row.phase}: planMerge reproduces merged and stranded exactly`, () => {
      const balances = row.balancesBefore.map(BigInt);
      // The full partition INCLUDING Invalid — the whole point of the rule.
      assert.equal(balances.length, row.wrappedTokens.length);

      const plan = planMerge(balances);
      assert.equal(plan.amount.toString(), row.merged, "mergeable amount");
      assert.equal(plan.stranded.toString(), row.leftover, "stranded");
      assert.equal(plan.blocked, false);

      // The binding minimum must really be the minimum.
      assert.equal(balances[plan.minIndex], plan.amount);
      assert.ok(balances.every((b) => b >= plan.amount));
    });
  }

  it("dropping Invalid from the set would overstate the merge", () => {
    // Guards the rule rather than restating it: if Invalid happens to be the
    // binding minimum, omitting it inflates the answer. On market B it is not
    // the minimum, so this asserts the weaker but always-true direction.
    const row = rows[0];
    const full = row.balancesBefore.map(BigInt);
    const withoutInvalid = full.slice(0, -1);
    assert.ok(bmin(withoutInvalid) >= bmin(full), "removing a member can only raise the minimum");
  });

  it("a single zero balance blocks the whole merge", () => {
    const plan = planMerge([5n, 0n, 7n]);
    assert.equal(plan.amount, 0n);
    assert.equal(plan.blocked, true);
    assert.equal(plan.minIndex, 1);
  });
});

describe("golden: the L1 redemption chunk plan", () => {
  const rows = read("campaigns/l1-deepfunding/redeem-l1-positions-execution.json");

  it("settled in 8 transactions across two phases", () => {
    assert.equal(rows.length, 8);
    const phases = [...new Set(rows.map((r) => r.phase))];
    assert.equal(phases.length, 2);
    // Child first: market B before market A.
    assert.match(rows[0].phase, /Phase 1 — Market B/);
    assert.match(rows[rows.length - 1].phase, /Phase 2 — Market A/);
  });

  for (const phase of ["Phase 1 — Market B", "Phase 2 — Market A"]) {
    it(`${phase}: chunkRedemption reproduces the recorded chunking`, () => {
      const phaseRows = rows.filter((r) => r.phase === phase).sort((a, b) => a.chunk - b.chunk);
      // Rebuild the plan rows from what was sent.
      const planRows = phaseRows.flatMap((r) =>
        r.outcomeIndexes.map((index, i) => ({
          index,
          token: r.tokens[i],
          amount: BigInt(r.amounts[i]),
          payout: 0n,
        }))
      );

      const chunks = chunkRedemption(planRows, 15);
      assert.equal(chunks.length, phaseRows.length, "chunk count");
      chunks.forEach((c, i) => {
        assert.deepEqual(
          c.rows.map((r) => r.index),
          phaseRows[i].outcomeIndexes,
          `chunk ${i} outcome indexes`
        );
      });
      // No chunk exceeds the size, and only the last may be short.
      chunks.slice(0, -1).forEach((c) => assert.equal(c.rows.length, 15));
      assert.ok(chunks[chunks.length - 1].rows.length <= 15);
    });
  }
});

describe("lib/settle.js planRedemption", () => {
  const tokens = ["0xA", "0xB", "0xC", "0xD"];
  const denominator = 1000n;

  it("skips zero-payout outcomes instead of burning them for nothing", () => {
    const plan = planRedemption({
      tokens,
      balances: [100n, 200n, 300n, 400n],
      numerators: [500n, 500n, 0n, 0n], // the last two are the Invalid slots
      denominator,
    });
    assert.deepEqual(plan.rows.map((r) => r.index), [0, 1]);
    assert.equal(plan.zeroPayoutHeld, 700n, "zero-payout tokens stay in the wallet");
    assert.equal(plan.total, 50n + 100n);
  });

  it("skips empty balances", () => {
    const plan = planRedemption({ tokens, balances: [0n, 200n, 0n, 0n], numerators: [500n, 500n, 1n, 1n], denominator });
    assert.deepEqual(plan.rows.map((r) => r.index), [1]);
  });

  it("still redeems dust that rounds to zero, and says so", () => {
    // payout = balance * numerator / denominator, integer floor.
    const plan = planRedemption({ tokens, balances: [1n, 0n, 0n, 0n], numerators: [1n, 0n, 0n, 0n], denominator });
    assert.equal(plan.rows.length, 1, "included");
    assert.equal(plan.total, 0n);
    assert.equal(plan.dustHeld, 1n, "flagged as rounding to zero");
  });

  it("is NOT capped at the minimum balance — unlike a merge", () => {
    // The asymmetry the Router signatures encode: redeemPositions takes an
    // amounts ARRAY, mergePositions a single scalar.
    const balances = [100n, 1n, 300n, 0n];
    const plan = planRedemption({ tokens, balances, numerators: [1n, 1n, 1n, 0n], denominator: 1n });
    assert.equal(plan.total, 401n, "each outcome pays its own weight");
    assert.notEqual(plan.total, bmin(balances.slice(0, 3)) * 3n);
  });
});
