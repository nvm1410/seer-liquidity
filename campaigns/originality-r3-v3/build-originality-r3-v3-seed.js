// Builds the seed file for the CORRECTED round-3 originality set (three levels).
//
// The set created 2026-09-22 (campaigns/originality-r3) is missing its middle level: its
// 98 score markets hang directly off the bundle tokens. The intended structure is
//
//   parent   multi-scalar   "How many repositories in [bundle] will be evaluated…"
//   middle   3 conditional multi-categorical markets, one per bundle
//            "Which repositories in Bundle A will be evaluated…", one outcome per repo
//   score    98 conditional scalars, each on ITS OWN REPO's outcome token
//
// Nothing here is new information: the repos, their order, the bundles and the seed
// prices are copied from the round-3 seed that was already approved. Only the middle
// level, and a token suffix that cannot be confused with the first set's (_R3C, "round 3
// corrected"), are added. The output is deterministic — no timestamp — so re-running it
// reproduces the same bytes and the same gate hash.
//
// Reads no chain and sends nothing.
//
//   node campaigns/originality-r3-v3/build-originality-r3-v3-seed.js              # refuses to overwrite
//   node campaigns/originality-r3-v3/build-originality-r3-v3-seed.js --out=<path>
//   node campaigns/originality-r3-v3/build-originality-r3-v3-seed.js --overwrite

import crypto from "crypto";
import fs from "fs";

const SOURCE = "campaigns/originality-r3/originality-r3-seed.json";
const DEFAULT_OUT = "campaigns/originality-r3-v3/originality-r3-v3-seed.json";
const SUFFIX = "R3C";
const MAX_TOKEN_NAME_BYTES = 31;

const argv = process.argv.slice(2);
const out = argv.find((a) => a.startsWith("--out="))?.slice(6) ?? DEFAULT_OUT;
if (fs.existsSync(out) && !argv.includes("--overwrite")) {
  console.error(`REFUSED: ${out} exists. Its sha256 may be pinned as a gate hash — pass --out=<path> or --overwrite.`);
  process.exit(2);
}

const raw = fs.readFileSync(SOURCE);
const src = JSON.parse(raw);

const parentTokens = src.parent.outcomes.map((o) => `ORIG_${SUFFIX}_${o.slice(-1)}`);
const middleName = (label) => `Which repositories in ${label} will be evaluated for originality during Round 3 of the Deep Funding experiment?`;

const children = src.children.map((c) => ({
  repo: c.repo,
  tokenCode: c.tokenCode,
  parentOutcome: c.parentOutcome, // the bundle: which middle market this repo sits in
  indexInBundle: c.indexInBundle, // its outcome slot in that middle market
  repoTokenName: `${c.tokenCode}_${SUFFIX}`,
  marketName: c.marketName,
  outcomes: c.outcomes,
  tokenNames: [`${c.tokenCode}_D_${SUFFIX}`, `${c.tokenCode}_U_${SUFFIX}`],
  lowerBound: c.lowerBound,
  upperBound: c.upperBound,
  seedUp: c.seedUp,
  seedDown: c.seedDown,
}));

const bundles = src.bundles.map((b, i) => {
  const kids = children.filter((c) => c.parentOutcome === i);
  return {
    index: i,
    label: b.label,
    tokenName: parentTokens[i],
    question: b.question,
    middle: {
      marketType: "multiCategorical",
      marketName: middleName(b.label),
      outcomes: kids.map((c) => c.repo),
      tokenNames: kids.map((c) => c.repoTokenName),
    },
    repos: b.repos,
    globalRange: b.globalRange,
  };
});

const all = [...parentTokens, ...children.flatMap((c) => [c.repoTokenName, ...c.tokenNames])];
const tooLong = all.filter((t) => Buffer.byteLength(t) > MAX_TOKEN_NAME_BYTES);
if (tooLong.length) throw new Error(`token names over ${MAX_TOKEN_NAME_BYTES} bytes: ${tooLong.join(", ")}`);
if (new Set(all).size !== all.length) throw new Error("duplicate token names");
bundles.forEach((b, i) => {
  if (JSON.stringify(b.middle.outcomes) !== JSON.stringify(b.repos)) throw new Error(`bundle ${i}: middle outcomes differ from the bundle's repo list`);
});

const seed = {
  note:
    "Corrected round-3 originality seed (three levels: multi-scalar parent, one multi-categorical market per bundle, " +
    "98 score markets each on its own repo token). Repos, bundles and prices are copied unchanged from the source seed; " +
    "seedUp is the round-2 UP pool's last price and seedDown is 1 - seedUp. Frozen input: rebuild with " +
    "build-originality-r3-v3-seed.js rather than editing by hand.",
  source: { file: SOURCE, sha256: crypto.createHash("sha256").update(raw).digest("hex"), generatedAt: src.generatedAt },
  band: src.band,
  budget: {
    totalSusds: src.budget.totalSusds,
    note: "one parent split, then one split per middle market: every repo token's supply equals totalSusds, and each repo's pools draw only on its own token",
  },
  parent: { ...src.parent, tokenNames: parentTokens },
  bundles,
  children,
};

fs.writeFileSync(out, JSON.stringify(seed, null, 1) + "\n");
console.log(`wrote ${out}: 1 parent, ${bundles.length} middle markets, ${children.length} score markets, ${all.length} token names`);
