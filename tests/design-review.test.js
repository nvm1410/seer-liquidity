// lib/design-review.js and tools/design-review.js, against a throwaway tree.
//
// The design review is the only check that the market STRUCTURE is right, so
// each way it can be missing, failed, or stale has to be observed refusing.
// No network, no chain.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { designReviewProblems, marketsHash, verdictOf } from "../lib/design-review.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const TOOL = path.join(ROOT, "tools", "design-review.js");

const MARKETS = [
  { type: "multiScalar", role: "parent", count: 1, outcomes: ["Bundle A", "Bundle B"] },
  { type: "scalar", role: "child", count: 4, parentOutcome: "bundle index 0/1" },
];

/** A temp root holding a report with the given first line. */
function root(verdictLine = "VERDICT: PASS") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "liq-review-"));
  fs.mkdirSync(path.join(dir, "campaigns", "demo"), { recursive: true });
  if (verdictLine !== null) fs.writeFileSync(path.join(dir, "campaigns", "demo", "design-review.md"), `${verdictLine}\n\n## Intent\n`);
  return dir;
}

function manifest(review, extra = {}) {
  const m = { schemaVersion: 2, setSlug: "demo", mode: "launch", status: "gated", markets: MARKETS, ...extra };
  if (review !== null) {
    m.gate = {
      designReview: { reviewedAt: "2026-10-01T00:00:00Z", verdict: "pass", artifact: "campaigns/demo/design-review.md", marketsHash: `sha256=${marketsHash(m)}`, ...review },
    };
  }
  return m;
}

describe("designReviewProblems", () => {
  it("a passing review of the current markets[]: no problems", () => {
    assert.deepEqual(designReviewProblems(manifest({}), { root: root() }), []);
  });

  it("no review recorded: refuses, and names the command", () => {
    const p = designReviewProblems(manifest(null), { root: root() });
    assert.equal(p.length, 1);
    assert.match(p[0], /no design review recorded/);
    assert.match(p[0], /tools\/design-review\.js demo --record/);
  });

  it("markets[] edited after the review: refuses as stale", () => {
    const m = manifest({});
    m.markets = [m.markets[0], { ...m.markets[1], parentOutcome: "the repo's own outcome" }];
    const p = designReviewProblems(m, { root: root() });
    assert.equal(p.length, 1);
    assert.match(p[0], /markets\[\] has changed since the design review/);
  });

  it("a recorded pass over a report that says FAIL: refuses", () => {
    const p = designReviewProblems(manifest({}), { root: root("VERDICT: FAIL") });
    assert.equal(p.length, 1);
    assert.match(p[0], /does not say VERDICT: PASS/);
  });

  it("a verdict that is not a pass: refuses", () => {
    const p = designReviewProblems(manifest({ verdict: "fail" }), { root: root("VERDICT: FAIL") });
    assert.ok(p.some((x) => /not a pass/.test(x)), p.join("\n"));
  });

  it("the report file is gone: refuses", () => {
    const p = designReviewProblems(manifest({}), { root: root(null) });
    assert.equal(p.length, 1);
    assert.match(p[0], /design-review\.md not found/);
  });

  it("only a launch creates markets: every other mode needs no review", () => {
    for (const mode of ["reseed", "unwind", "settle"]) {
      assert.deepEqual(designReviewProblems(manifest(null, { mode }), { root: root() }), [], mode);
    }
  });
});

describe("verdictOf", () => {
  it("reads the four verdicts and nothing else", () => {
    assert.equal(verdictOf("VERDICT: PASS\n"), "pass");
    assert.equal(verdictOf("VERDICT: PASS WITH NOTES\n"), "pass-with-notes");
    assert.equal(verdictOf("VERDICT: FAIL\n"), "fail");
    assert.equal(verdictOf("VERDICT: BLOCKED\n"), "blocked");
    assert.equal(verdictOf("The verdict is a pass.\n"), null);
    assert.equal(verdictOf("VERDICT: PASS, mostly\n"), null);
  });
});

describe("tools/design-review.js --record", () => {
  // LIFECYCLE_DIR redirects the manifest only; the report is passed by path, so
  // nothing under the real campaigns/ or lifecycle/ is touched.
  function fixture(verdictLine) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "liq-review-tool-"));
    fs.writeFileSync(path.join(dir, "demo.json"), JSON.stringify({ schemaVersion: 2, setSlug: "demo", mode: "launch", status: "draft", chain: { id: 10 }, markets: MARKETS }, null, 2));
    fs.writeFileSync(path.join(dir, "report.md"), `${verdictLine}\n`);
    return dir;
  }
  const record = (dir) =>
    spawnSync(process.execPath, [TOOL, "demo", "--record", `--artifact=${path.relative(ROOT, path.join(dir, "report.md"))}`], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, LIFECYCLE_DIR: dir },
    });

  it("a PASS report: writes gate.designReview bound to markets[]", () => {
    const dir = fixture("VERDICT: PASS WITH NOTES");
    const r = record(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const m = JSON.parse(fs.readFileSync(path.join(dir, "demo.json"), "utf8"));
    assert.equal(m.gate.designReview.verdict, "pass-with-notes");
    assert.equal(m.gate.designReview.marketsHash, `sha256=${marketsHash(m)}`);
    assert.deepEqual(designReviewProblems(m), []);
  });

  for (const v of ["FAIL", "BLOCKED"]) {
    it(`a ${v} report: REFUSED with exit 2, manifest untouched`, () => {
      const dir = fixture(`VERDICT: ${v}`);
      const before = fs.readFileSync(path.join(dir, "demo.json"), "utf8");
      const r = record(dir);
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, new RegExp(`verdict is ${v}`));
      assert.equal(fs.readFileSync(path.join(dir, "demo.json"), "utf8"), before);
    });
  }

  it("a report with no VERDICT line: REFUSED with exit 2", () => {
    const r = record(fixture("Looks fine to me."));
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /has no "VERDICT:/);
  });
});
