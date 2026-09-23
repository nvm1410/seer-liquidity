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

// tools/refactor-diff.js writes the old copy of a script here while it runs.
const TEMP_PREFIX = "_refactor_diff_old_";

// Every directory holding code that depends on a path. Scripts moved under
// campaigns/<slug>/ on 2026-09-23; the golden tests read the committed execution
// JSONs and broke silently the first time that data moved, so they are in here
// too. lib/ and tools/ reference only each other and are checked by Node at
// import time.
const SCAN_DIRS = ["campaigns", "archive", "tests"];

// Explicit relative references: "./x", "../x", "./dir/x".
const RELATIVE = /["'](\.\.?\/[^"'\n]+)["']/g;
// Bare data filenames, e.g. getParticipants.js:87 writes "l2-participants.json"
// with no leading "./". Restricted to data extensions so prose in the header
// comments and ABI type strings don't match.
const BARE = /["']([A-Za-z0-9._-]+\.(?:json|csv|xlsx|ts|log))["']/g;
// Campaign data now lives under campaigns/<slug>/ and is named without a "./"
// prefix, so neither pattern above catches it.
const CAMPAIGN = /["'](campaigns\/[^"'\n]+)["']/g;

function walkJs(dir, out = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = dir + "/" + e.name;
    if (e.isDirectory()) walkJs(rel, out);
    else if (e.name.endsWith(".js") && !e.name.startsWith(TEMP_PREFIX)) out.push(rel);
  }
  return out;
}

function frozenScripts() {
  const out = [];
  for (const d of SCAN_DIRS) walkJs(d, out);
  return out.sort();
}

// Collect {literal, file, line} for every path-looking string in a script.
//
// For the ALSO_SCAN dirs only the CAMPAIGN pattern applies. A test's other
// literals are its own `../lib/x.js` imports and synthetic temp filenames
// ("p.json", "progress.json"), none of which are root-relative — and a broken
// import already fails the test immediately and loudly, so it needs no audit.
function literalsIn(file) {
  const out = [];
  const patterns = file.startsWith("tests/") ? [CAMPAIGN] : [RELATIVE, BARE, CAMPAIGN];
  const fileDir = path.dirname(path.join(ROOT, file));
  const lines = fs.readFileSync(path.join(ROOT, file), "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    // Skip pure comment lines: guides and filenames are cited constantly in the
    // header blocks ("see CLAUDE_ZCASH_MARKETS_GUIDE.md step 5") and those are
    // documentation, not load-bearing reads.
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    for (const re of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        // A "./x" or "../x" literal is relative to the SCRIPT, not the repo
        // root. Once scripts moved into campaigns/<slug>/ their imports became
        // "../../lib/run.js", which resolved against ROOT points outside the
        // repo. Record the repo-relative RESOLVED path, so one dependency has
        // one identity however deep the file that names it.
        const lit = m[1];
        const base = lit.startsWith(".") ? fileDir : ROOT;
        const rel = path.relative(ROOT, path.resolve(base, lit)).split("\\").join("/");
        out.push({ literal: lit, rel, file, line: i + 1 });
      }
    }
  });
  return out;
}

const refs = [];
for (const f of frozenScripts()) refs.push(...literalsIn(f));

// De-duplicate by literal, keeping the first citation for the error message.
const surface = new Map();
for (const r of refs) if (!surface.has(r.rel)) surface.set(r.rel, r);

if (process.argv.includes("--list")) {
  console.log(`Freeze surface: ${surface.size} distinct path literals across ${frozenScripts().length} frozen scripts.\n`);
  for (const [rel, r] of [...surface].sort()) {
    console.log(`  ${rel.padEnd(52)} ${r.file}:${r.line}`);
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
const gone = baseline.filter((lit) => !fs.existsSync(path.resolve(ROOT, lit)));

// A baselined path that has disappeared is only a FAILURE if a script still
// names it. Once the campaign data moved behind the manifests, most of this
// baseline stopped being referenced by any script at all — those entries are
// RETIRED, not broken, and the fix is to re-snapshot rather than to move files
// back. Conflating the two made this tool crash on the first real move.
const broken = gone.filter((lit) => surface.has(lit));
const retired = gone.filter((lit) => !surface.has(lit));

// ── Markdown links ──────────────────────────────────────────────────────────
// The docs are now the map of the repo, and a map with dead links is worse than
// no map. Cheap to check, so it rides along with the freeze-surface audit.
function checkDocLinks() {
  const docs = [];
  const add = (p) => { if (fs.existsSync(path.join(ROOT, p))) docs.push(p); };
  add("README.md");
  add("CLAUDE.md");
  add("docs/README.md");
  add("lifecycle/README.md");
  for (const dir of ["docs/guides"]) {
    const abs = path.join(ROOT, dir);
    if (fs.existsSync(abs)) for (const f of fs.readdirSync(abs)) if (f.endsWith(".md")) docs.push(`${dir}/${f}`);
  }

  const dead = [];
  for (const doc of docs) {
    const text = fs.readFileSync(path.join(ROOT, doc), "utf8");
    const dir = path.dirname(path.join(ROOT, doc));
    const re = /\[[^\]]*\]\(([^)]+)\)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const target = m[1].split("#")[0].trim();
      if (!target || /^(https?:|mailto:)/.test(target)) continue;
      if (!fs.existsSync(path.resolve(dir, target))) dead.push({ doc, target });
    }
  }
  return dead;
}

const deadLinks = checkDocLinks();

if (broken.length === 0 && retired.length === 0 && deadLinks.length === 0) {
  console.log(`Path audit: ${baseline.length} frozen path(s) all resolve.` + (absent.length ? ` (${absent.length} unwritten write target(s) ignored.)` : ""));
  console.log(`Link audit: all markdown links resolve.`);
  process.exit(0);
}

if (deadLinks.length) {
  console.error(`Link audit: ${deadLinks.length} dead markdown link(s).\n`);
  for (const d of deadLinks) console.error(`  ${d.doc} -> ${d.target}`);
  console.error("");
}

if (broken.length) {
  console.error(`Path audit: ${broken.length} file(s) a script STILL REFERENCES have MOVED or been deleted.\n`);
  for (const lit of broken) {
    const r = surface.get(lit);
    console.error(`  ${lit}`);
    console.error(`      referenced by ${r.file}:${r.line}`);
  }
  console.error(`\nThe script that needs them is now broken. Move them back, or update the script.`);
}

if (retired.length) {
  if (broken.length) console.error("");
  console.error(`Path audit: ${retired.length} baselined path(s) are gone and NO script references them.\n`);
  for (const lit of retired.slice(0, 12)) console.error(`  ${lit}`);
  if (retired.length > 12) console.error(`  ... and ${retired.length - 12} more`);
  console.error(`\nNothing is broken — these moved behind the manifests. Re-baseline with:`);
  console.error(`  node tools/audit-paths.js --snapshot`);
}
process.exit(1);
