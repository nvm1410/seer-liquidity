#!/usr/bin/env node
// Prove a refactored script still does what it did, by running the OLD version
// and the NEW one and diffing their output.
//
// For a mutating script this compares DRY RUN output — which is the whole plan:
// every market resolved, every position sized, every amount computed. If the
// plan is identical, the refactor did not change what would be sent.
//
//   node tools/refactor-diff.js <script.js> [--ref=<git-ref>]
//
// Exit 0 = identical. Exit 1 = differs (the diff is printed). Exit 2 = refused.
//
// SAFETY: the old version is executed, so this refuses to run one whose
// `const DRY_RUN` is not `true`. Anything at `false` would send transactions.

import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const script = args.find((a) => !a.startsWith("--"));
const ref = (args.find((a) => a.startsWith("--ref=")) ?? "--ref=HEAD").slice(6);

if (!script) {
  console.error("usage: node tools/refactor-diff.js <script.js> [--ref=<git-ref>]");
  process.exit(2);
}

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

// Normalize away what legitimately differs between two runs of anything.
function normalize(text) {
  return text
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<ts>")
        .replace(/0x[0-9a-fA-F]{64}/g, "<hash>")
        .replace(/block \d+/gi, "block <n>")
        .replace(/\s+$/, "")
        // "./x" and "x" are the same path: the frozen scripts wrote relative
        // literals with the prefix, the manifest stores them without.
        .replace(/(^|[\s(])\.\//g, "$1")
    )
    // Lines the harness adds that the old script never printed.
    .filter(
      (l) =>
        l.trim() !== "" &&
        !/^[\w-]+ — (DRY RUN|LIVE)/.test(l) &&
        !/^\s{2}campaign /.test(l) &&
        !/^\s{2}chain \d+ ok/.test(l) &&
        !/^\s{2}gate: /.test(l) &&
        !/^\s{2}resuming: /.test(l) &&
        !/Dry run complete/.test(l) &&
        !/^Done\./.test(l) &&
        // The old scripts printed their own mode banner; the harness prints one.
        !/^📋 DRY_RUN/.test(l)
    )
    .join("\n");
}

const tmpName = `_refactor_diff_old_${path.basename(script)}`;
const tmpPath = path.join(ROOT, tmpName);
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
  const before = runScript(tmpName);
  console.log(`running ${script} (working tree) ...`);
  const after = runScript(script);

  const a = normalize(before.out);
  const b = normalize(after.out);

  if (a === b) {
    console.log(`\nIDENTICAL — ${script} behaves the same after the refactor.`);
    console.log(`  (${a.split("\n").length} comparable lines; exit ${before.code} -> ${after.code})`);
    process.exit(before.code === after.code ? 0 : 1);
  }

  // Print a compact line diff rather than pulling in a dependency.
  const al = a.split("\n");
  const bl = b.split("\n");
  console.error(`\nDIFFERS — ${script}`);
  console.error(`  old: ${al.length} lines (exit ${before.code})   new: ${bl.length} lines (exit ${after.code})\n`);
  let shown = 0;
  for (let i = 0; i < Math.max(al.length, bl.length) && shown < 40; i++) {
    if (al[i] !== bl[i]) {
      console.error(`  line ${i + 1}`);
      console.error(`    -  ${al[i] ?? "(absent)"}`);
      console.error(`    +  ${bl[i] ?? "(absent)"}`);
      shown++;
    }
  }
  if (shown === 40) console.error(`  ...further differences suppressed`);
  process.exit(1);
} finally {
  fs.rmSync(tmpPath, { force: true });
}
