#!/usr/bin/env node
// Show, or record, a campaign's design review — the independent cross-check that
// the market structure pays what the request means. See docs/DESIGN-REVIEW.md.
//
//   node tools/design-review.js <slug>            # status; exit 1 if no passing review matches markets[]
//   node tools/design-review.js <slug> --record   # read VERDICT from the report, write gate.designReview
//
//   --artifact=<path>   the report (default campaigns/<slug>/design-review.md)
//   --reviewer=<who>    recorded as given (default "seer-market-design-reviewer")
//
// --record never takes the verdict as a flag: it is read from the report's own
// first line, so a FAIL cannot be recorded as a pass by typing the wrong word.

import fs from "fs";
import path from "path";
import { PASSING, designReviewProblems, marketsHash, verdictOf } from "../lib/design-review.js";
import { loadManifest, manifestPath } from "../lib/manifest.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const slug = argv.find((a) => !a.startsWith("--"));
const opt = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

if (!slug) {
  console.error("usage: node tools/design-review.js <slug> [--record] [--artifact=<path>] [--reviewer=<who>]");
  process.exit(2);
}

const manifest = loadManifest(slug);
if (manifest.mode !== "launch") {
  console.log(`${slug}: mode "${manifest.mode}" creates no markets — no design review needed.`);
  process.exit(0);
}

if (argv.includes("--record")) {
  const artifact = (opt("artifact") ?? `campaigns/${slug}/design-review.md`).replace(/\\/g, "/");
  const abs = path.resolve(ROOT, artifact);
  if (!fs.existsSync(abs)) {
    console.error(`REFUSED: ${artifact} not found. Save the reviewer's report there, unedited, first.`);
    process.exit(2);
  }
  const verdict = verdictOf(fs.readFileSync(abs, "utf8"));
  if (!verdict) {
    console.error(`REFUSED: ${artifact} has no "VERDICT: PASS | PASS WITH NOTES | FAIL | BLOCKED" line.`);
    process.exit(2);
  }
  if (!PASSING.includes(verdict)) {
    console.error(`REFUSED: the report's verdict is ${verdict.toUpperCase()}. Take it to the user; fix the structure or get the answer, then review again.`);
    process.exit(2);
  }
  if (!(manifest.markets ?? []).length) {
    console.error(`REFUSED: lifecycle/${slug}.json has no markets[] — there is nothing the review could be bound to.`);
    process.exit(2);
  }
  manifest.gate = {
    ...(manifest.gate ?? {}),
    designReview: {
      reviewedAt: new Date().toISOString(),
      reviewer: opt("reviewer") ?? "seer-market-design-reviewer",
      verdict,
      artifact,
      marketsHash: `sha256=${marketsHash(manifest)}`,
    },
  };
  fs.writeFileSync(manifestPath(slug), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`recorded: ${slug} design review ${verdict}, bound to markets[] sha256=${marketsHash(manifest)}`);
  process.exit(0);
}

const problems = designReviewProblems(manifest);
console.log(`${slug}: markets[] sha256=${marketsHash(manifest)}`);
if (problems.length) {
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
const r = manifest.gate.designReview;
console.log(`  design review ${r.verdict} at ${r.reviewedAt} by ${r.reviewer} (${r.artifact})`);
