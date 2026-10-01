// The design review: an independent cross-check that the market STRUCTURE pays
// what the request means, recorded in the manifest and re-checked before --live.
//
// Everything else in the gate proves the run matches the plan. Nothing proved
// the plan was right: originality-r3 was created exactly as planned, with its
// score markets on the wrong collateral, and had to be rebuilt. See
// docs/DESIGN-REVIEW.md.
//
// Shared by lib/run.js (refuses --live), tools/validate-manifest.js (fails a
// gated launch) and tools/design-review.js (records the review).

import crypto from "crypto";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(import.meta.dirname, "..");

export const PASSING = ["pass", "pass-with-notes"];

/**
 * sha256 of markets[] as written. The review is of a structure, so it is bound
 * to that structure: any edit to markets[] after the review makes it stale.
 */
export function marketsHash(manifest) {
  return crypto.createHash("sha256").update(JSON.stringify(manifest.markets ?? [])).digest("hex");
}

/** The report's first line, as a verdict slug — or null if it has none. */
export function verdictOf(reportText) {
  const m = /^VERDICT:\s*(PASS WITH NOTES|PASS|FAIL|BLOCKED)\s*$/m.exec(reportText);
  return m ? m[1].toLowerCase().replace(/ /g, "-") : null;
}

/**
 * Why this manifest may not create markets yet. Empty = a passing review of the
 * current markets[] is on record. Only a launch creates markets, so every other
 * mode has nothing to review.
 */
export function designReviewProblems(manifest, { root = ROOT } = {}) {
  if (manifest.mode !== "launch") return [];
  const review = manifest.gate?.designReview;
  if (!review) {
    return [`no design review recorded. Have the structure cross-checked (docs/DESIGN-REVIEW.md), then: node tools/design-review.js ${manifest.setSlug} --record`];
  }
  const problems = [];
  if (!(manifest.markets ?? []).length) problems.push(`markets[] is empty, so there is no structure the review could have covered`);
  if (!PASSING.includes(review.verdict)) problems.push(`design review verdict is "${review.verdict}", not a pass`);
  if (!review.artifact || !fs.existsSync(path.resolve(root, review.artifact))) {
    problems.push(`design review report ${review.artifact ?? "(none named)"} not found`);
  } else if (verdictOf(fs.readFileSync(path.resolve(root, review.artifact), "utf8")) !== review.verdict) {
    problems.push(`${review.artifact} does not say VERDICT: ${String(review.verdict).toUpperCase().replace(/-/g, " ")}`);
  }
  const now = marketsHash(manifest);
  if (review.marketsHash !== `sha256=${now}`) {
    problems.push(`markets[] has changed since the design review.\n  reviewed: ${review.marketsHash}\n  now:      sha256=${now}\n  Review the new structure; do not re-record the old report.`);
  }
  return problems;
}
