#!/usr/bin/env node
// Derive the "freeze surface" — every file path the 53 frozen root scripts
// reference as a string literal — and check that each one still resolves.
//
// The frozen scripts read their inputs and write their resume logs by relative
// path (`"./originality-r3-seed.json"`, `"./abis/RouterAbi.js"`). Moving one of
// those files breaks the script silently: you find out mid-campaign, months
// later, with money already committed. This turns that into a failing check.
//
// Anything on the list below must stay where it is. Anything NOT on it is free
// to move. That is the whole rule for reorganising this repo.
//
//   node tools/audit-paths.js          # check every literal resolves
//   node tools/audit-paths.js --list   # print the freeze surface and exit 0
//
// Exit 0 = every referenced path exists. Exit 1 = something a frozen script
// needs has moved or been deleted.

import fs from "fs";
import path from "path";

const ROOT = path.resolve(import.meta.dirname, "..");

// Directories that are NOT frozen — new code, free to reference anything.
const NEW_CODE = new Set(["lib", "tools", "tests"]);

// Explicit relative references: "./x", "../x", "./dir/x".
const RELATIVE = /["'](\.\.?\/[^"'\n]+)["']/g;
// Bare data filenames, e.g. getParticipants.js:87 writes "l2-participants.json"
// with no leading "./". Restricted to data extensions so prose in the header
// comments and ABI type strings don't match.
const BARE = /["']([A-Za-z0-9._-]+\.(?:json|csv|xlsx|ts|log))["']/g;

function frozenScripts() {
  return fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".js"))
    .map((e) => e.name)
    .sort();
}

// Collect {literal, file, line} for every path-looking string in a script.
function literalsIn(file) {
  const out = [];
  const lines = fs.readFileSync(path.join(ROOT, file), "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    // Skip pure comment lines: guides and filenames are cited constantly in the
    // header blocks ("see CLAUDE_ZCASH_MARKETS_GUIDE.md step 5") and those are
    // documentation, not load-bearing reads.
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    for (const re of [RELATIVE, BARE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        out.push({ literal: m[1], file, line: i + 1 });
      }
    }
  });
  return out;
}

const refs = [];
for (const f of frozenScripts()) refs.push(...literalsIn(f));

// De-duplicate by literal, keeping the first citation for the error message.
const surface = new Map();
for (const r of refs) if (!surface.has(r.literal)) surface.set(r.literal, r);

if (process.argv.includes("--list")) {
  console.log(`Freeze surface: ${surface.size} distinct path literals across ${frozenScripts().length} frozen scripts.\n`);
  for (const [lit, r] of [...surface].sort()) {
    console.log(`  ${lit.padEnd(52)} ${r.file}:${r.line}`);
  }
  process.exit(0);
}

// Not every literal is an input. A PROGRESS_FILE is a WRITE target, guarded by
// `if (fs.existsSync(...))` — e.g. resolve-l1-markets.js:46 names
// ./resolve-l1-execution.json, which simply never got a committed live run.
// So "does not exist" is not the failure condition.
//
// The real invariant is: a referenced file that EXISTS TODAY must keep existing
// at that path. We snapshot the resolving set into freeze-surface.json and fail
// when one of those disappears — which is exactly what a bad `git mv` does.
const BASELINE = path.join(import.meta.dirname, "freeze-surface.json");

const resolving = [...surface.keys()].filter((lit) => fs.existsSync(path.resolve(ROOT, lit))).sort();
const absent = [...surface.keys()].filter((lit) => !fs.existsSync(path.resolve(ROOT, lit))).sort();

if (process.argv.includes("--snapshot")) {
  fs.writeFileSync(
    BASELINE,
    JSON.stringify(
      {
        note: "Files referenced by the frozen root scripts that existed when this was taken. Moving or deleting any of them breaks a frozen script. Regenerate only when you have deliberately retired one.",
        generated: new Date().toISOString().slice(0, 10),
        paths: resolving,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`Wrote ${resolving.length} path(s) to ${path.relative(ROOT, BASELINE).replace(/\\/g, "/")}.`);
  if (absent.length) console.log(`(${absent.length} literal(s) are write targets that do not exist yet — not baselined.)`);
  process.exit(0);
}

if (!fs.existsSync(BASELINE)) {
  console.error(`Path audit: no baseline. Run \`node tools/audit-paths.js --snapshot\` first.`);
  process.exit(1);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8")).paths;
const broken = baseline.filter((lit) => !fs.existsSync(path.resolve(ROOT, lit)));

if (broken.length === 0) {
  console.log(`Path audit: ${baseline.length} frozen path(s) all resolve.` + (absent.length ? ` (${absent.length} unwritten write target(s) ignored.)` : ""));
  process.exit(0);
}

console.error(`Path audit: ${broken.length} file(s) a frozen script depends on have MOVED or been deleted.\n`);
for (const lit of broken) {
  const r = surface.get(lit);
  console.error(`  ${lit}`);
  console.error(`      referenced by ${r.file}:${r.line}`);
}
console.error(`\nThese are part of the freeze surface and must stay at the repo root.`);
console.error(`Move them back — the script that needs them is now broken.`);
process.exit(1);
