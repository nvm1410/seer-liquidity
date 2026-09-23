// Pull yearly probability-of-default per asset from the Credora GraphQL API and
// freeze it to disk.
//
// Market creation and liquidity seeding are separate transactions run minutes or
// hours apart, and Credora's psl moves between publishes. Every downstream step
// must price against the *same* snapshot, so this script is the only place that
// talks to Credora: it writes assets_pd_v2.csv (consumed by
// add-pd-liquidity-gnosis-v2.js, same Asset,PD format as assets_pd.csv) plus
// assets_pd_v2.json as the audit record.
//
// The query mirrors risk-pricing-ui's server-side proxy
// (src/app/api/credora/route.ts) — same endpoint, same ClientSecret header, same
// ratings(product:["assets"]) filter. The number we want is Metrics.psl.

import "dotenv/config";
import fs from "fs";
import { loadManifest } from "./lib/manifest.js";

// ── Config ──────────────────────────────────────────────────────────────────
const CREDORA_GRAPHQL_URL = "https://api.staging.credora.io/graphql";
const CLIENT_SECRET = process.env.CREDORA_API;
if (!CLIENT_SECRET) throw new Error("CREDORA_API is not set — see .env.example.");

// This script talks to no chain, so it deliberately does NOT use lib/run.js:
// the harness asserts a network and builds a provider, neither of which means
// anything here. It does take its file paths from the manifest, so they are not
// a second copy of what lifecycle/gnosis-pd.json already states.
const manifest = loadManifest("gnosis-pd");
const ASSETS_FILE = manifest.files.assetList;
const OUT_CSV = manifest.files.seed;
const OUT_JSON = manifest.files.assets;

// ── Asset list ──────────────────────────────────────────────────────────────
// assets_pd.ts is a hand-maintained `export const assets_pd = [...]`. Parse the
// string literals out of it rather than importing, so this stays a plain .js
// script with no TS toolchain. Duplicates are dropped (solvBTC is listed twice)
// keeping first-occurrence order — that order becomes the market's outcome order.
function readAssetList(path) {
  const src = fs.readFileSync(path, "utf8");
  const body = src.slice(src.indexOf("["), src.lastIndexOf("]") + 1);
  const names = [...body.matchAll(/"([^"]+)"|'([^']+)'/g)].map((m) => m[1] ?? m[2]);
  if (!names.length) throw new Error(`No asset names found in ${path}`);

  const seen = new Set();
  const unique = [];
  const dupes = [];
  for (const n of names) {
    const key = n.toLowerCase();
    if (seen.has(key)) {
      dupes.push(n);
      continue;
    }
    seen.add(key);
    unique.push(n);
  }
  return { names, unique, dupes };
}

// ── Credora ─────────────────────────────────────────────────────────────────
const QUERY = `
query {
  ratings(filter: { product: ["assets"], chainId: 1, address: [] }, page: 0, limit: 100) {
    totalCount
    items {
      id
      address
      name
      chainId
      Metrics {
        rating
        psl
        publishDate
      }
    }
  }
}`;

async function fetchRatings() {
  const res = await fetch(CREDORA_GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ClientSecret: CLIENT_SECRET },
    body: JSON.stringify({ query: QUERY }),
  });
  if (!res.ok) throw new Error(`Credora HTTP ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (json.errors) throw new Error(`Credora GraphQL errors: ${JSON.stringify(json.errors)}`);

  const ratings = json.data?.ratings;
  const items = ratings?.items ?? [];
  if (!items.length) throw new Error("Credora returned no rating items.");
  // limit is 100 and there is no pagination loop here — fail loudly rather than
  // silently pricing off a truncated list.
  if (ratings.totalCount > items.length) {
    throw new Error(`Credora totalCount ${ratings.totalCount} > returned ${items.length} — raise the page limit.`);
  }
  return items;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!CLIENT_SECRET) {
    throw new Error("CREDORA_API is not set — copy it from risk-pricing-ui/.env.local into .env");
  }

  const { names, unique, dupes } = readAssetList(ASSETS_FILE);
  console.log(`\n📋 ${ASSETS_FILE}: ${names.length} entries → ${unique.length} unique`);
  if (dupes.length) console.log(`   ⏭  dropped duplicates: ${dupes.join(", ")}`);

  console.log(`\n🌐 Querying ${CREDORA_GRAPHQL_URL} ...`);
  const items = await fetchRatings();
  console.log(`   ${items.length} rated assets returned`);

  // The Seer↔Credora join is on lowercased name (same as the frontend's
  // Details.tsx: outcome.outcome.toLowerCase() → Credora item.name.toLowerCase()).
  const byName = new Map();
  for (const item of items) byName.set(item.name.toLowerCase(), item);

  const rows = [];
  const problems = [];
  for (const name of unique) {
    const hit = byName.get(name.toLowerCase());
    if (!hit) {
      problems.push(`${name}: not rated by Credora`);
      continue;
    }
    const psl = hit.Metrics?.psl;
    if (typeof psl !== "number" || !Number.isFinite(psl) || psl <= 0 || psl >= 1) {
      problems.push(`${name}: unusable psl (${psl})`);
      continue;
    }
    rows.push({
      name, // the Seer outcome name, from assets_pd.ts
      credoraName: hit.name, // Credora's spelling, may differ in case
      yearlyPD: psl,
      rating: hit.Metrics?.rating ?? "",
      publishDate: hit.Metrics?.publishDate ?? null,
      address: hit.address,
    });
  }

  if (problems.length) {
    console.error("\n❌ Unusable assets:");
    problems.forEach((p) => console.error(`   - ${p}`));
    throw new Error(`${problems.length} of ${unique.length} assets have no usable PD.`);
  }

  const csv = ["Asset,PD", ...rows.map((r) => `${r.name},${r.yearlyPD}`)].join("\n") + "\n";
  fs.writeFileSync(OUT_CSV, csv);
  fs.writeFileSync(
    OUT_JSON,
    JSON.stringify(
      {
        source: CREDORA_GRAPHQL_URL,
        metric: "Metrics.psl (yearly probability of default)",
        fetchedAt: new Date().toISOString(),
        assetCount: rows.length,
        assets: rows,
      },
      null,
      2
    )
  );

  console.log(`\n   asset       yearly PD    rating   published`);
  for (const r of rows) {
    console.log(
      `   ${r.name.padEnd(10)}  ${(r.yearlyPD * 100).toFixed(3).padStart(8)}%  ` +
        `${r.rating.padEnd(6)}  ${r.publishDate ?? "—"}`
    );
  }
  console.log(`\n✅ Wrote ${rows.length} assets to ${OUT_CSV} and ${OUT_JSON}`);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
