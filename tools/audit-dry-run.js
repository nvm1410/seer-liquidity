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
//   node tools/audit-dry-run.js            # all root scripts
//   node tools/audit-dry-run.js a.js b.js  # only these (used by the pre-commit hook)
//
// Exit 0 = every script is dry. Exit 1 = at least one is armed.

import fs from "fs";
import path from "path";

const ROOT = path.resolve(import.meta.dirname, "..");

// `const DRY_RUN = false` with any spacing. Deliberately not a general
// expression parser: the frozen scripts all use this one literal form, and a
// looser pattern would start matching prose in the header comments.
const ARMED = /^\s*const\s+DRY_RUN\s*=\s*false\s*;/;

function rootScripts() {
  return fs
    .readdirSync(ROOT)
    .filter((f) => f.endsWith(".js"))
    .sort();
}

function scan(file) {
  const abs = path.resolve(ROOT, file);
  if (!fs.existsSync(abs)) return [];
  const hits = [];
  const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (ARMED.test(line)) hits.push({ file: path.relative(ROOT, abs).replace(/\\/g, "/"), line: i + 1, text: line.trim() });
  });
  return hits;
}

const args = process.argv.slice(2);
// The hook passes staged paths, which may include files outside the root or
// non-scripts; filter to root-level .js so the hook and a full run agree.
const targets = args.length
  ? args.filter((f) => f.endsWith(".js") && !f.includes("/") && !f.includes("\\"))
  : rootScripts();

const armed = targets.flatMap(scan);

if (armed.length === 0) {
  console.log(`DRY_RUN audit: ${targets.length} script(s) checked, all dry.`);
  process.exit(0);
}

console.error(`DRY_RUN audit: ${armed.length} script(s) are ARMED to send transactions.\n`);
for (const hit of armed) console.error(`  ${hit.file}:${hit.line}  ${hit.text}`);
console.error(`\nSet these back to \`const DRY_RUN = true;\` before committing.`);
console.error(`A committed \`false\` is residue from a live run, not a record of it —`);
console.error(`the record is the *-execution.json and the run log.`);
process.exit(1);
