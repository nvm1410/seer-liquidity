// Reading and appending to a campaign manifest.
//
// The CONTRACT half (chain, amm, addresses, files, liquidity, spendingCap,
// gate) is read before acting. The LEDGER half (stages, evidenceLog, results,
// wallet*) is appended after. See lifecycle/README.md.

import fs from "fs";
import path from "path";
import { chain } from "./chains.js";

const ROOT = path.resolve(import.meta.dirname, "..");
// LIFECYCLE_DIR is a test seam: it lets the harness be exercised end to end
// against a throwaway manifest instead of one of the real campaigns.
const LIFECYCLE = () => process.env.LIFECYCLE_DIR ?? path.join(ROOT, "lifecycle");
export const manifestPath = (slug) => path.join(LIFECYCLE(), `${slug}.json`);

export function loadManifest(slug) {
  const file = manifestPath(slug);
  if (!fs.existsSync(file)) {
    throw new Error(`no manifest at ${path.relative(ROOT, file) || file}. Copy the nearest precedent and run \`npm run lint:manifest\`.`);
  }
  const m = JSON.parse(fs.readFileSync(file, "utf8"));
  if (m.schemaVersion !== 2) throw new Error(`lifecycle/${slug}.json is schemaVersion ${m.schemaVersion}, expected 2`);
  return m;
}

function save(slug, m) {
  fs.writeFileSync(manifestPath(slug), JSON.stringify(m, null, 2) + "\n");
}

/**
 * The address book for this campaign: the manifest's own block, falling back to
 * the chain default. The manifest wins, so a campaign can pin an address the
 * chain book later changes.
 */
export function resolveAddresses(m) {
  return { ...chain(m.chain.id).addresses, ...(m.addresses ?? {}) };
}

/** AMM parameters, manifest over chain default. */
export function resolveAmm(m) {
  return { ...chain(m.chain.id).amm, ...(m.amm ?? {}) };
}

/** Append (or update in place) a stage record. Ledger side — never read back to decide anything. */
export function appendStage(slug, stage) {
  const m = loadManifest(slug);
  m.stages = m.stages ?? [];
  const i = m.stages.findIndex((s) => s.name === stage.name);
  const merged = { ...(i >= 0 ? m.stages[i] : {}), ...stage };
  if (i >= 0) m.stages[i] = merged;
  else m.stages.push(merged);
  save(slug, m);
  return merged;
}

export function appendEvidence(slug, entry) {
  const m = loadManifest(slug);
  m.evidenceLog = m.evidenceLog ?? [];
  m.evidenceLog.push(entry);
  save(slug, m);
  return entry;
}
