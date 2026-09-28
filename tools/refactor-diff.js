#!/usr/bin/env node
// Prove a refactored script still does what it did, by running the OLD version
// and the NEW one and diffing their output.
//
// For a mutating script this compares DRY RUN output — which is the whole plan:
// every market resolved, every position sized, every amount computed. If the
// plan is identical, the refactor did not change what would be sent.
//
//   node tools/refactor-diff.js <script.js> [--ref=<git-ref>] [--new-args="..."]
//
// Exit 0 = identical. Exit 1 = differs (the diff is printed). Exit 2 = refused.
//
// SAFETY: the old version is executed, so this refuses to run one whose
// `const DRY_RUN` is not `true`. Anything at `false` would send transactions.

import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { normalize } from "../lib/transcript.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const script = args.find((a) => !a.startsWith("--"));
const ref = (args.find((a) => a.startsWith("--ref=")) ?? "--ref=HEAD").slice(6);
// Some migrations deliberately change a DEFAULT (e.g. which market a script
// targets). --new-args lets the new version be pointed back at the old default
// so the LOGIC can still be proved identical, with the default change called out
// separately rather than hidden inside a "differs".
const newArgs = (args.find((a) => a.startsWith("--new-args=")) ?? "--new-args=").slice(11).split(" ").filter(Boolean);

if (!script) {
  console.error("usage: node tools/refactor-diff.js <script.js> [--ref=<git-ref>]");
  process.exit(2);
}

// A run killed by a broken pipe never reaches its finally block, so sweep any
// leftovers from previous runs before starting. They are never wanted. Scripts
// live under campaigns/<slug>/ now, so the temp copy is written THERE and the
// sweep has to recurse.
const sweep = (dir) => {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== ".git") sweep(abs);
    } else if (e.name.startsWith("_refactor_diff_old_")) {
      fs.rmSync(abs, { force: true });
    }
  }
};
sweep(ROOT);

const git = (a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

let oldSource;
try {
  oldSource = git(["show", `${ref}:${script}`]);
} catch {
  console.error(`REFUSED: ${script} does not exist at ${ref}`);
  process.exit(2);
}

// The old version gets executed. Refuse anything that could send.
const dryLine = oldSource.split(/\r?\n/).find((l) => /^\s*const\s+DRY_RUN\s*=/.test(l));
if (dryLine && !/=\s*true\s*;/.test(dryLine)) {
  console.error(`REFUSED: ${script}@${ref} has "${dryLine.trim()}" — running it would send transactions.`);
  console.error(`         Use a ref at or after the flip commit.`);
  process.exit(2);
}


// The copy must sit BESIDE the original: a campaign script imports
// "../../lib/run.js", which only resolves from its own directory.
const tmpName = `_refactor_diff_old_${path.basename(script)}`;
const tmpPath = path.join(path.dirname(path.resolve(ROOT, script)), tmpName);
fs.writeFileSync(tmpPath, oldSource);

const runScript = (file, extra = []) => {
  const r = spawnSync(process.execPath, [file, ...extra], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 15 * 60 * 1000,
    maxBuffer: 256 * 1024 * 1024,
  });
  return { out: `${r.stdout ?? ""}${r.stderr ?? ""}`, code: r.status };
};

try {
  console.log(`running ${script}@${ref} ...`);
  const before = runScript(path.relative(ROOT, tmpPath).split("\\").join("/"));
  console.log(`running ${script} (working tree)${newArgs.length ? " " + newArgs.join(" ") : ""} ...`);
  const after = runScript(script, newArgs);

  const a = normalize(before.out);
  const b = normalize(after.out);

  if (a === b) {
    console.log(`\nIDENTICAL — ${script} behaves the same after the refactor.`);
    console.log(`  (${a.split("\n").length} comparable lines; exit ${before.code} -> ${after.code})`);
    process.exit(before.code === after.code ? 0 : 1);
  }

  // An LCS-aligned diff, not an index-by-index compare. A single inserted line
  // (say a new banner) would otherwise shift everything after it and report the
  // whole run as changed — which is exactly wrong when the question being asked
  // is "did the PLAN change".
  const al = a.split("\n");
  const bl = b.split("\n");

  const n = al.length;
  const m = bl.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = al[i] === bl[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (al[i] === bl[j]) {
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push({ t: "-", line: al[i++], at: i });
    else ops.push({ t: "+", line: bl[j++], at: j });
  }
  while (i < n) ops.push({ t: "-", line: al[i++], at: i });
  while (j < m) ops.push({ t: "+", line: bl[j++], at: j });

  const removed = ops.filter((o) => o.t === "-").length;
  const added = ops.filter((o) => o.t === "+").length;

  console.error(`\nDIFFERS — ${script}`);
  console.error(`  old ${n} lines (exit ${before.code})  new ${m} lines (exit ${after.code})`);
  console.error(`  ${removed} removed, ${added} added\n`);
  for (const o of ops.slice(0, 60)) console.error(`  ${o.t}  ${o.line}`);
  if (ops.length > 60) console.error(`  ...${ops.length - 60} further difference(s) suppressed`);
  process.exit(1);
} finally {
  fs.rmSync(tmpPath, { force: true });
}
