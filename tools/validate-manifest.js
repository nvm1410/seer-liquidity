#!/usr/bin/env node
// Validate campaign manifests against lifecycle/schema.json — structurally, and
// then semantically, which is where the value is.
//
// The manifest is only worth reading from if it cannot quietly be wrong. A
// typo'd key in a write-only document is invisible; in a document a script
// reads its budget and addresses from, it is a live hazard.
//
//   node tools/validate-manifest.js                    # all of lifecycle/*.json
//   node tools/validate-manifest.js lifecycle/x.json   # just these
//
// Exit 0 = valid. Exit 1 = at least one problem.

import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import { designReviewProblems } from "../lib/design-review.js";
import { entryProblems } from "../lib/schedule.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const LIFECYCLE = path.join(ROOT, "lifecycle");
const schema = JSON.parse(fs.readFileSync(path.join(LIFECYCLE, "schema.json"), "utf8"));

// ── A minimal JSON Schema walker ────────────────────────────────────────────
// Covers only the constructs schema.json actually uses. A full implementation
// would mean adding ajv; this repo has no build step and no devDependencies,
// and the same argument that kept husky out keeps ajv out.
function deref(node) {
  if (node && node.$ref) {
    const key = node.$ref.replace("#/$defs/", "");
    return schema.$defs[key];
  }
  return node;
}

function typeOf(v) {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v;
}

function check(node, value, at, errs) {
  node = deref(node);
  if (!node) return;

  if (node.const !== undefined && value !== node.const) errs.push(`${at}: must be ${JSON.stringify(node.const)}, got ${JSON.stringify(value)}`);

  if (node.enum && !node.enum.includes(value)) errs.push(`${at}: must be one of ${node.enum.join(" | ")}, got ${JSON.stringify(value)}`);

  if (node.type) {
    const want = Array.isArray(node.type) ? node.type : [node.type];
    const got = typeOf(value);
    const ok = want.includes(got) || (want.includes("integer") && Number.isInteger(value)) || (want.includes("number") && got === "number");
    if (!ok) {
      errs.push(`${at}: expected ${want.join("|")}, got ${got}`);
      return; // further checks would cascade meaninglessly
    }
  }

  if (node.pattern && typeof value === "string" && !new RegExp(node.pattern).test(value)) {
    errs.push(`${at}: ${JSON.stringify(value)} does not match ${node.pattern}`);
  }

  if (typeof value === "number") {
    if (node.minimum !== undefined && value < node.minimum) errs.push(`${at}: ${value} < minimum ${node.minimum}`);
    if (node.maximum !== undefined && value > node.maximum) errs.push(`${at}: ${value} > maximum ${node.maximum}`);
    if (node.exclusiveMinimum !== undefined && value <= node.exclusiveMinimum) errs.push(`${at}: ${value} must be > ${node.exclusiveMinimum}`);
  }

  if (node.oneOf) {
    const hits = node.oneOf.filter((sub) => { const e = []; check(sub, value, at, e); return e.length === 0; });
    if (hits.length !== 1) errs.push(`${at}: must match exactly one of the allowed shapes (matched ${hits.length})`);
  }

  if (typeOf(value) === "object") {
    for (const req of node.required || []) {
      if (!(req in value)) errs.push(`${at}: missing required key "${req}"`);
    }
    for (const [k, v] of Object.entries(value)) {
      const sub = node.properties && node.properties[k];
      if (sub) check(sub, v, `${at}.${k}`, errs);
      else if (node.additionalProperties === false) errs.push(`${at}: unknown key "${k}" (typo? schema forbids extras here)`);
      else if (node.additionalProperties && typeof node.additionalProperties === "object") check(node.additionalProperties, v, `${at}.${k}`, errs);
    }
  }

  if (typeOf(value) === "array" && node.items) {
    value.forEach((item, i) => check(node.items, item, `${at}[${i}]`, errs));
  }

  for (const clause of node.allOf || []) {
    if (clause.if) {
      const e = [];
      check(clause.if, value, at, e);
      if (e.length === 0 && clause.then) check(clause.then, value, at, errs);
    } else check(clause, value, at, errs);
  }
}

// ── Semantic checks ─────────────────────────────────────────────────────────
function semantic(m, errs, warns) {
  // 1. Every address must checksum and be non-zero. MARKET_VIEW is lowercase in
  //    all 27 script copies while the rest are checksummed, so compare
  //    normalized forms, never raw strings.
  const walkAddrs = (obj, at) => {
    for (const [k, v] of Object.entries(obj || {})) {
      if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) {
        try {
          if (ethers.getAddress(v) === ethers.ZeroAddress) errs.push(`${at}.${k}: zero address`);
        } catch {
          errs.push(`${at}.${k}: ${v} fails checksum`);
        }
      }
    }
  };
  walkAddrs(m.addresses, "addresses");
  walkAddrs(m.chain && m.chain.collateral, "chain.collateral");

  // 2. chain.id and chain.name must agree.
  const NAMES = { 10: "optimism", 100: "gnosis" };
  if (m.chain && NAMES[m.chain.id] !== m.chain.name) {
    errs.push(`chain: id ${m.chain.id} is ${NAMES[m.chain.id]}, but name says "${m.chain.name}"`);
  }

  // 3. The spending cap must actually cover the plan.
  if (m.spendingCap && m.liquidity && m.spendingCap.collateral < m.liquidity.totalCollateral) {
    errs.push(`spendingCap.collateral ${m.spendingCap.collateral} < liquidity.totalCollateral ${m.liquidity.totalCollateral}`);
  }

  // 4. The band must be a band.
  const band = m.liquidity && m.liquidity.band;
  if (band && band.minPrice >= band.maxPrice) errs.push(`liquidity.band: minPrice ${band.minPrice} >= maxPrice ${band.maxPrice}`);

  // 5. Every seed price must lie STRICTLY inside the band. This is the exact
  //    precondition buildPoolAndBounds throws on — checked here before anyone
  //    spends gas discovering it.
  const seedPath = m.files && m.files.seed;
  if (band && seedPath) {
    const abs = path.join(ROOT, seedPath);
    if (!seedPath.endsWith(".json")) {
      // Gnosis PD seeds from a CSV of yearly PD figures, which are model INPUTS,
      // not pool prices — the price comes out of implied-prices.js. There is
      // nothing here a band check could meaningfully compare.
      warns.push(`files.seed: ${seedPath} is not JSON — band check not applicable`);
    } else if (fs.existsSync(abs)) {
      let doc = null;
      try { doc = JSON.parse(fs.readFileSync(abs, "utf8")); } catch { /* reported below */ }
      if (doc === null) errs.push(`files.seed (${seedPath}): not valid JSON`);
      else {
        // Seed files nest prices differently per campaign: a flat array of repos
        // with seedUp/seedDown, {proposals:[{yesPrice}]}, {questions:[{outcomes:
        // [{price}]}]}. Walk for the price-shaped keys instead of assuming a shape,
        // so a new campaign's file is covered without touching this.
        const PRICE_KEYS = new Set(["price", "seedPrice", "seedUp", "seedDown", "yesPrice"]);
        const bad = [];
        const walk = (node, at) => {
          if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${at}[${i}]`));
          if (!node || typeof node !== "object") return;
          for (const [k, v] of Object.entries(node)) {
            if (PRICE_KEYS.has(k) && typeof v === "number") {
              const check = [[k, v]];
              // A binary market's other leg is 1 - p and is pooled too, so it must
              // also clear the band: yesPrice 0.99 means a NO pool at 0.01.
              if (k === "yesPrice") check.push(["noPrice(1-yesPrice)", 1 - v]);
              for (const [label, p] of check) {
                if (p <= band.minPrice || p >= band.maxPrice) bad.push(`${at}.${label}=${p}`);
              }
            } else walk(v, `${at}.${k}`);
          }
        };
        walk(doc, "");
        if (bad.length) {
          errs.push(`files.seed (${seedPath}): ${bad.length} price(s) outside band [${band.minPrice}, ${band.maxPrice}]`);
          for (const b of bad.slice(0, 5)) errs.push(`    ${b}`);
          if (bad.length > 5) errs.push(`    ...and ${bad.length - 5} more`);
        }
      }
    } else warns.push(`files.seed: ${seedPath} not found — price/band check skipped`);
  }

  // 6. Declared input files must exist.
  for (const [k, v] of Object.entries(m.files || {})) {
    if (!fs.existsSync(path.join(ROOT, v))) warns.push(`files.${k}: ${v} not found`);
  }

  // 7. A stage claiming "done" must point at evidence, and that evidence must
  //    exist. A done stage with no artifact is a claim, not a record.
  for (const st of m.stages || []) {
    if (st.status !== "done") continue;
    const arts = st.artifacts || [];
    if (arts.length === 0 && st.name !== "gate") warns.push(`stages.${st.name}: status "done" with no artifacts`);
    for (const a of arts) {
      if (/^https?:\/\//.test(a) || a.includes(" ")) continue; // URLs and prose refs
      if (!fs.existsSync(path.join(ROOT, a))) warns.push(`stages.${st.name}: artifact "${a}" not found`);
    }
  }

  // 8. Algebra needs mathFeeTier; Uniswap must not carry one.
  if (m.amm) {
    if (m.amm.kind === "algebra-v1" && m.amm.mathFeeTier === undefined) {
      warns.push(`amm: algebra-v1 without mathFeeTier — the v3 SDK will derive the wrong tickSpacing`);
    }
    if (m.amm.kind === "uniswap-v3" && m.amm.mathFeeTier !== undefined) {
      errs.push(`amm: mathFeeTier is an Algebra-only workaround, not valid for uniswap-v3`);
    }
  }

  // 10. A scheduled run skips the y/N prompt, so what may be scheduled is
  //     enforced here too, not only by the tool that writes entries: withdraw
  //     or remove scripts on the harness, in an unwind stage, with a recorded
  //     approval and plan hash. See lib/schedule.js.
  const ids = new Set();
  (m.schedule || []).forEach((e, i) => {
    if (ids.has(e.id)) errs.push(`schedule[${i}]: duplicate id ${e.id}`);
    ids.add(e.id);
    if (e.script && !e.script.startsWith(`campaigns/${m.setSlug}/`)) errs.push(`schedule[${i}]: ${e.script} is not in campaigns/${m.setSlug}/`);
    errs.push(...entryProblems(e, `schedule[${i}]`));
  });

  // 11. A launch that is approved to go live must carry a passing design review
  //     of its CURRENT markets[]. Manifests that ran before the review existed
  //     have none and are left alone; one that does carry a review which no
  //     longer matches is reported, since it would mislead a reader.
  const review = designReviewProblems(m);
  if (m.status === "gated" || m.status === "executing") errs.push(...review.map((p) => `gate.designReview: ${p}`));
  else if (m.gate && m.gate.designReview) warns.push(...review.map((p) => `gate.designReview: ${p}`));
}

// ── Cross-manifest consistency ──────────────────────────────────────────────
// Rather than assert a hardcoded address book, require every manifest on the
// same chain to agree. That catches a Gnosis address pasted into an Optimism
// manifest without anyone having to maintain a second copy of the truth.
function crossCheck(all, errs) {
  const byChain = new Map();
  for (const { file, m } of all) {
    if (!m.chain || !m.addresses) continue;
    if (!byChain.has(m.chain.id)) byChain.set(m.chain.id, []);
    byChain.get(m.chain.id).push({ file, addresses: m.addresses, collateral: m.chain.collateral });
  }
  for (const [chainId, entries] of byChain) {
    if (entries.length < 2) continue;
    const keys = new Set(entries.flatMap((e) => Object.keys(e.addresses)));
    for (const key of keys) {
      const seen = new Map();
      for (const e of entries) {
        const v = e.addresses[key];
        if (!v) continue;
        let norm;
        try { norm = ethers.getAddress(v); } catch { continue; }
        if (!seen.has(norm)) seen.set(norm, []);
        seen.get(norm).push(e.file);
      }
      if (seen.size > 1) {
        errs.push(`chain ${chainId}: manifests disagree on addresses.${key}:`);
        for (const [addr, files] of seen) errs.push(`    ${addr}  ${files.join(", ")}`);
      }
    }
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const targets = args.length
  ? args
  : fs.readdirSync(LIFECYCLE).filter((f) => f.endsWith(".json") && f !== "schema.json").map((f) => path.join("lifecycle", f));

let failed = 0;
const loaded = [];

for (const t of targets) {
  const rel = path.relative(ROOT, path.resolve(ROOT, t)).replace(/\\/g, "/");
  let m;
  try {
    m = JSON.parse(fs.readFileSync(path.resolve(ROOT, t), "utf8"));
  } catch (e) {
    console.error(`FAIL ${rel}\n    not valid JSON: ${e.message}`);
    failed++;
    continue;
  }
  loaded.push({ file: rel, m });

  const errs = [];
  const warns = [];
  check(schema, m, "", errs);
  semantic(m, errs, warns);

  if (errs.length) {
    failed++;
    console.error(`FAIL ${rel}`);
    for (const e of errs) console.error(`    ${e}`);
  } else {
    console.log(`ok   ${rel}  (${m.mode}/${m.family}, chain ${m.chain && m.chain.id}, ${m.status})`);
  }
  for (const w of warns) console.log(`     note: ${w}`);
}

const crossErrs = [];
crossCheck(loaded, crossErrs);
if (crossErrs.length) {
  failed++;
  console.error(`\nFAIL cross-manifest consistency`);
  for (const e of crossErrs) console.error(`    ${e}`);
}

if (failed) {
  console.error(`\n${failed} manifest check(s) failed.`);
  process.exit(1);
}
console.log(`\n${loaded.length} manifest(s) valid.`);
