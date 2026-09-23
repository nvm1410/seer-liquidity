#!/usr/bin/env node
// Refuse to let a frozen script sit in the repo armed to send transactions.
//
// The 53 root scripts gate every transaction on a hand-edited `const DRY_RUN`.
// A script committed at `false` is a live-fire hazard: `node <script>.js` typed
// verbatim from a guide sends real transactions with no prompt and no undo.
// Commit 357b262 ("Both are checked back in at DRY_RUN = true") shows the
// intent was always to reset the flag after a live run; this makes that
// ritual mechanical instead of remembered.
//
// There is a SECOND, worse hazard this also checks for: a script that sends
// transactions and has no dry-run gate AT ALL. Such a script cannot be "armed"
// in the DRY_RUN sense, so the original check passed it by omission — which is
// exactly how index.js, liquidity-l1.js and liquidity-originality.js sat in the
// repo firing real transactions on `node <script>.js` with nothing to flip.
//
//   node tools/audit-dry-run.js            # all root scripts
//   node tools/audit-dry-run.js a.js b.js  # only these (used by the pre-commit hook)
//
// Exit 0 = every script is gated. Exit 1 = at least one is armed or ungated.

import fs from "fs";
import path from "path";

const ROOT = path.resolve(import.meta.dirname, "..");

// tools/refactor-diff.js writes the old copy of a script here while it runs.
const TEMP_PREFIX = "_refactor_diff_old_";

// `const DRY_RUN = false` with any spacing. Deliberately not a general
// expression parser: the frozen scripts all use this one literal form, and a
// looser pattern would start matching prose in the header comments.
const ARMED = /^\s*const\s+DRY_RUN\s*=\s*false\s*;/;

// A script is GATED if it either declares a DRY_RUN constant or runs under the
// harness, which is dry unless --live. Anything else that can send is ungated.
const HAS_DRY_RUN = /^\s*const\s+DRY_RUN\s*=/m;
// Depth-agnostic: a campaign script imports "../../lib/run.js", one under
// superseded/ imports "../../../lib/run.js". Matching only "./lib/run.js" made
// this audit report all 26 harness scripts as ungated the moment they moved.
const USES_HARNESS = /from\s+"(?:\.\.?\/)+lib\/run\.js"/;

// Call sites that move money or state. estimateGas and callStatic are excluded
// on purpose: they simulate.
const SENDS = [
  /wallet\.sendTransaction\s*\(/,
  /\.approve\s*\(/,
  /\.splitPosition\s*\(/,
  /\.mergePositions\s*\(/,
  /\.redeemPositions\s*\(/,
  /\.submitAnswer\s*\(/,
  /\.resolve\s*\(\s*\)/,
  /positionManager\.collect\s*\(/,
];

// Scripts live under campaigns/<slug>/ (and archive/ for the orphans) since the
// 2026-09-23 reorganisation. Walk those rather than the root, which now holds no
// scripts at all -- and treat an EMPTY scan as a failure, because a safety audit
// that silently checks nothing is worse than no audit.
const SCRIPT_DIRS = ["campaigns", "archive"];

function walk(dir, out = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = dir + "/" + e.name;
    if (e.isDirectory()) walk(rel, out);
    else if (e.name.endsWith(".js") && !e.name.startsWith(TEMP_PREFIX)) out.push(rel);
  }
  return out;
}

function rootScripts() {
  const out = [];
  for (const d of SCRIPT_DIRS) walk(d, out);
  return out.sort();
}

function scan(file) {
  const abs = path.resolve(ROOT, file);
  if (!fs.existsSync(abs)) return { armed: [], ungated: null };
  const rel = path.relative(ROOT, abs).replace(/\\/g, "/");
  const source = fs.readFileSync(abs, "utf8");

  const armed = [];
  source.split(/\r?\n/).forEach((line, i) => {
    if (ARMED.test(line)) armed.push({ file: rel, line: i + 1, text: line.trim() });
  });

  let ungated = null;
  if (!HAS_DRY_RUN.test(source) && !USES_HARNESS.test(source)) {
    const sends = SENDS.filter((re) => re.test(source));
    if (sends.length) ungated = { file: rel, calls: sends.length };
  }
  return { armed, ungated };
}

const args = process.argv.slice(2);
// The hook passes staged paths, which may include files outside the root or
// non-scripts; filter to root-level .js so the hook and a full run agree.
const targets = args.length ? args.filter((f) => f.endsWith(".js")).map((f) => f.split("\\").join("/")) : rootScripts();

if (!args.length && targets.length === 0) {
  console.error("DRY_RUN audit: found NO scripts to check under " + SCRIPT_DIRS.join(", ") + ".");
  console.error("That is a bug in this audit, not a clean repo -- fix SCRIPT_DIRS.");
  process.exit(1);
}

const results = targets.map(scan);
const armed = results.flatMap((r) => r.armed);
const ungated = results.map((r) => r.ungated).filter(Boolean);

if (armed.length === 0 && ungated.length === 0) {
  console.log(`DRY_RUN audit: ${targets.length} script(s) checked, all gated.`);
  process.exit(0);
}

if (armed.length) {
  console.error(`DRY_RUN audit: ${armed.length} script(s) are ARMED to send transactions.\n`);
  for (const hit of armed) console.error(`  ${hit.file}:${hit.line}  ${hit.text}`);
  console.error(`\nSet these back to \`const DRY_RUN = true;\` before committing.`);
  console.error(`A committed \`false\` is residue from a live run, not a record of it —`);
  console.error(`the record is the *-execution.json and the run log.`);
}

if (ungated.length) {
  if (armed.length) console.error("");
  console.error(`DRY_RUN audit: ${ungated.length} script(s) can send transactions with NO dry-run gate.\n`);
  for (const hit of ungated) console.error(`  ${hit.file}  (${hit.calls} kind(s) of sending call, no DRY_RUN and no lib/run.js)`);
  console.error(`\nThese are worse than an armed DRY_RUN: there is no flag to flip, so`);
  console.error(`\`node <script>.js\` sends immediately. Migrate to lib/run.js, or add the`);
  console.error(`--live gate from parseArgs() before anything else runs.`);
}
process.exit(1);
