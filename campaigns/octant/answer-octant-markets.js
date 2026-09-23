import { ethers } from "ethers";
import fs from "fs";
import zlib from "node:zlib";
import { getMarketInfo, makeMarketView, normalizeIdentifier } from "../../lib/market.js";
import { run } from "../../lib/run.js";
import { retryTransaction, sleep } from "../../lib/tx.js";

// ─────────────────────────────────────────────────────────────────────────────
// Submits the Reality.eth answers for the Octant epoch-12 multiscalar market.
//
// Octant is a MULTISCALAR market: one Reality question per outcome (25 projects;
// the 26th "Invalid result" slot has no question). Each question reads:
//   "What will be the total % breakdown of total funding received by [project],
//    both community contributions and matching, in octants epoch 12? [percent]"
//
// UNIT: template 1 (REALITY_UINT_TEMPLATE) answers are scaled by 1e18 — the
// market's upperBound is 100e18 for a [percent] question, and an already-resolved
// sibling market (originality, same factory/template/bounds) stores a score of 60
// as best_answer = 60000000000000000000. So 11.5923% -> 11592300000000000000.
//
// RealityProxy.resolveMultiScalarMarket (src/RealityProxy.sol:157-190) uses the raw
// answer as payouts[i], capped at 2**128-1 ≈ 3.4e38 — 1e19-magnitude values are safe.
//
// Answers come from resolution.xlsx, column B (project) / column C (Actual Weight),
// parsed with zero dependencies (node:zlib + regex over the sheet XML).
//
// This script only SUBMITS answers. Questions finalize 302400 s (3.5 days) later;
// Market.resolve() must be called after that (see resolve-originality-markets.js).
// ─────────────────────────────────────────────────────────────────────────────

// ── Config ──────────────────────────────────────────────────────────────────
const PROJECT_COL = "B"; // "Project"
const WEIGHT_COL = "C"; // "Actual Weight"

const ANSWER_DECIMALS = 18;
const WEIGHT_PRECISION = 4; // decimals kept from the spreadsheet
const EXPECTED_OUTCOMES = 25;
const GAS_BUFFER = ethers.parseEther("0.002");
const DELAY_MS = 2000;

// Spreadsheet labels that don't match the on-chain outcome after normalization.
// key: normalized on-chain outcome → value: normalized spreadsheet name
const ALIASES = {
  aestusmevboostrelay: "aestus",
  ethereumcatherdersinstitute: "ethereumcatherders",
  etheconomiczone: "ethereumeconomiczone",
  greenpill: "greenpilldevguild",
  bluefiltercompany: "bluefilter",
  giliecotrust: "gili",
  shutter: "shutternetwork",
};

// ── ABIs ────────────────────────────────────────────────────────────────────
const REALITY_ABI = ["function submitAnswer(bytes32,bytes32,uint256) external payable"];


// ── Helpers ──────────────────────────────────────────────────────────────────

// ── Zero-dependency .xlsx reader ─────────────────────────────────────────────
// An .xlsx is a ZIP of XML parts. We only need xl/sharedStrings.xml (the string
// pool) and xl/worksheets/sheet1.xml (the cells).

/** Reads every entry of a ZIP archive into { name: Buffer }. */
function unzip(buf) {
  // End Of Central Directory record — scan backwards for its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive: end-of-central-directory not found");

  const entryCount = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = {};

  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("corrupt zip: bad central directory signature");
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);

    // The local header repeats name/extra with its own lengths — skip past them.
    const localNameLen = buf.readUInt16LE(localOff + 26);
    const localExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    if (method === 0) entries[name] = raw; // stored
    else if (method === 8) entries[name] = zlib.inflateRawSync(raw); // deflate
    else throw new Error(`unsupported zip compression method ${method} for ${name}`);

    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Returns the sheet's rows as [{ A: "…", B: "…", … }], one object per <row>. */
function readXlsx(path) {
  const zip = unzip(fs.readFileSync(path));

  const sharedXml = zip["xl/sharedStrings.xml"]?.toString("utf8") ?? "";
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    unescapeXml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""))
  );

  const sheetXml = zip["xl/worksheets/sheet1.xml"]?.toString("utf8");
  if (!sheetXml) throw new Error(`${path}: xl/worksheets/sheet1.xml not found`);

  const rows = [];
  for (const row of sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    // The `\/>` branch matters: empty cells are self-closing (<c r="A4" s="9"/>),
    // and without it the regex swallows the next cell and mis-assigns columns.
    for (const c of row[1].matchAll(/<c\s([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const inner = c[3] ?? "";
      const col = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1];
      if (!col) continue;
      const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      if (v === undefined) continue; // empty cell, or formula with no cached value
      cells[col] = /t="s"/.test(attrs) ? shared[Number(v)] : unescapeXml(v);
    }
    rows.push(cells);
  }
  return rows;
}


// ── Main ─────────────────────────────────────────────────────────────────────
await run(
  {
    name: "answer-octant-markets",
    slug: "octant",
    stage: "settle-answer",
    mutating: true,
    // The answer log IS the resume log: re-answering a question costs DOUBLE the
    // standing bond, so skipping what is already submitted is the whole point.
    progress: (m) => m.files.answerLog,
  },
  async (ctx) => {
  const { manifest, provider, wallet, addr, log, progress, dry: DRY_RUN } = ctx;
  const OCTANT_MARKET = manifest.results.parent;
  const XLSX_FILE = manifest.files.answers;

  console.log(`\n📋 Wallet   : ${wallet ? wallet.address : "(none — read-only)"}`);
  console.log(`📋 Market   : ${OCTANT_MARKET}\n`);

  // ── Read the spreadsheet ────────────────────────────────────────────────
  const sheetRows = readXlsx(XLSX_FILE)
    .map((r) => ({ project: r[PROJECT_COL], weightRaw: r[WEIGHT_COL] }))
    .filter((r) => r.project && r.weightRaw !== undefined && r.weightRaw !== "" && !isNaN(Number(r.weightRaw)))
    // The sheet stores float artifacts (9.934699999999999) — round to 4 decimals.
    .map((r) => ({ project: r.project, weight: Math.round(Number(r.weightRaw) * 1e4) / 1e4 }));

  console.log(`📄 ${XLSX_FILE}: ${sheetRows.length} data row(s) parsed`);
  if (sheetRows.length !== EXPECTED_OUTCOMES) {
    throw new Error(`expected ${EXPECTED_OUTCOMES} data rows in ${XLSX_FILE}, got ${sheetRows.length}`);
  }

  const byName = new Map();
  for (const row of sheetRows) {
    const key = normalizeIdentifier(row.project);
    if (byName.has(key)) throw new Error(`duplicate project in ${XLSX_FILE}: "${row.project}"`);
    byName.set(key, row);
  }

  // ── Read the market ─────────────────────────────────────────────────────
  const marketView = makeMarketView(addr.marketView, provider);
  const info = await getMarketInfo(marketView, addr.marketFactory, OCTANT_MARKET);

  console.log(`🔗 ${info.name}`);
  console.log(`   templateId ${info.templateId} | bounds ${info.lowerBound}..${info.upperBound}`);
  console.log(`   outcomes ${info.outcomes.length} | questions ${info.questionsIds.length}\n`);

  if (info.templateId !== 1) throw new Error(`expected templateId 1 (uint), got ${info.templateId}`);
  if (info.questionsIds.length !== EXPECTED_OUTCOMES) {
    throw new Error(`expected ${EXPECTED_OUTCOMES} questions, got ${info.questionsIds.length}`);
  }
  const upperBound = info.upperBound;

  // ── Map on-chain outcomes → spreadsheet rows ────────────────────────────
  const used = new Set();
  const plan = [];
  const unmatched = [];

  for (let i = 0; i < EXPECTED_OUTCOMES; i++) {
    const outcome = info.outcomes[i];
    const key = normalizeIdentifier(outcome);
    const row = byName.get(key) ?? byName.get(ALIASES[key]);
    if (!row) {
      unmatched.push(outcome);
      continue;
    }
    const matchKey = normalizeIdentifier(row.project);
    if (used.has(matchKey)) throw new Error(`spreadsheet row "${row.project}" matched by two outcomes`);
    used.add(matchKey);

    const answerWei = ethers.parseUnits(row.weight.toFixed(WEIGHT_PRECISION), ANSWER_DECIMALS);
    plan.push({
      index: i,
      outcome,
      sheetProject: row.project,
      weight: row.weight,
      answerWei,
      answerHex: ethers.toBeHex(answerWei, 32),
      questionId: info.questionsIds[i],
    });
  }

  const leftovers = sheetRows.filter((r) => !used.has(normalizeIdentifier(r.project)));

  console.log("   #  outcome                          sheet row                        weight   answer (wei)");
  for (const p of plan) {
    console.log(
      `  ${String(p.index).padStart(2)}  ${p.outcome.padEnd(32)} ${p.sheetProject.padEnd(32)} ${p.weight
        .toFixed(WEIGHT_PRECISION)
        .padStart(8)}   ${p.answerWei}`
    );
  }

  if (unmatched.length) {
    console.error(`\n❌ ${unmatched.length} on-chain outcome(s) have no spreadsheet row:`);
    unmatched.forEach((o) => console.error(`     "${o}" (normalized "${normalizeIdentifier(o)}")`));
  }
  if (leftovers.length) {
    console.error(`\n❌ ${leftovers.length} spreadsheet row(s) unused:`);
    leftovers.forEach((r) => console.error(`     "${r.project}" (normalized "${normalizeIdentifier(r.project)}")`));
  }
  if (unmatched.length || leftovers.length) {
    throw new Error("outcome ↔ spreadsheet mapping is incomplete — aborting before any transaction");
  }

  // ── Sanity checks on the values ─────────────────────────────────────────
  for (const p of plan) {
    if (p.weight < 0 || p.weight > 100) throw new Error(`${p.outcome}: weight ${p.weight} outside 0..100`);
    if (p.answerWei >= upperBound) {
      throw new Error(`${p.outcome}: answer ${p.answerWei} >= upperBound ${upperBound}`);
    }
  }
  const total = plan.reduce((acc, p) => acc + p.weight, 0);
  console.log(`\n🧮 Weights sum to ${total.toFixed(WEIGHT_PRECISION)}%`);
  if (Math.abs(total - 100) > 0.01) {
    console.warn(`⚠️  Sum deviates from 100% by ${(total - 100).toFixed(4)} — double-check the spreadsheet.`);
  }

  // ── Resume: which questions are already answered ────────────────────────
  const alreadyAnswered = new Set(progress.entries.map((e) => e.questionId.toLowerCase()));

  // ── Bonds / balance ─────────────────────────────────────────────────────
  // Only count questions this run would actually bond — otherwise a resume after
  // a partial (or complete) run fails closed on an already-spent budget.
  const now = Math.floor(Date.now() / 1000);
  const timeout = Number(info.questions[0].timeout);
  const outstanding = plan.filter((p) => {
    const q = info.questions[p.index];
    return !alreadyAnswered.has(p.questionId.toLowerCase()) && q.bond === 0n;
  });
  const totalBond = outstanding.reduce((acc, p) => acc + info.questions[p.index].min_bond, 0n);
  console.log(
    `💰 Bond required: ${ethers.formatEther(totalBond)} ETH for ${outstanding.length} unanswered question(s)`
  );

  if (wallet && outstanding.length > 0) {
    const balance = await provider.getBalance(wallet.address);
    console.log(`💰 Wallet balance: ${ethers.formatEther(balance)} ETH`);
    if (balance < totalBond + GAS_BUFFER) {
      throw new Error(
        `insufficient balance: need ${ethers.formatEther(totalBond + GAS_BUFFER)} ETH ` +
          `(bonds + gas buffer), have ${ethers.formatEther(balance)} ETH`
      );
    }
  }

  // ── Submit phase ────────────────────────────────────────────────────────
  console.log(`\n⚙️  Submit phase (${DRY_RUN ? "DRY RUN — no transactions" : "LIVE"})\n`);

  const reality = wallet ? new ethers.Contract(addr.realitio, REALITY_ABI, wallet) : undefined;
  let submitted = 0;
  let skipped = 0;
  const errors = [];

  for (const p of plan) {
    const label = `[${String(p.index).padStart(2)}] ${p.outcome}`;
    const q = info.questions[p.index];

    if (alreadyAnswered.has(p.questionId.toLowerCase())) {
      console.log(`  ${label}: already in progress log — skipping`);
      skipped++;
      continue;
    }

    // Reality's stateOpen modifier (src/interaction/reality/RealityETH-3.0.sol:181-189)
    if (q.is_pending_arbitration) {
      console.warn(`  ${label}: ⚠️  pending arbitration — skipping`);
      skipped++;
      continue;
    }
    if (Number(q.opening_ts) > now) {
      console.warn(`  ${label}: ⚠️  not open until ${new Date(Number(q.opening_ts) * 1000).toISOString()} — skipping`);
      skipped++;
      continue;
    }
    if (Number(q.finalize_ts) !== 0 && Number(q.finalize_ts) <= now) {
      console.warn(`  ${label}: ⚠️  already finalized — skipping`);
      skipped++;
      continue;
    }
    // bondMustDoubleAndMatchMinimum (same file, lines 210-219): re-answering would
    // cost bond*2, which is a spend decision to make by hand.
    if (q.bond > 0n) {
      const existing = BigInt(q.best_answer);
      if (existing === p.answerWei) {
        console.log(`  ${label}: already answered with the correct value — skipping`);
      } else {
        console.warn(
          `  ${label}: ⚠️  ALREADY ANSWERED ${ethers.formatUnits(existing, ANSWER_DECIMALS)} ` +
            `(bond ${ethers.formatEther(q.bond)} ETH) — expected ${p.weight}. ` +
            `Overriding needs ≥ ${ethers.formatEther(q.bond * 2n)} ETH; skipping.`
        );
      }
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(
        `  ${label}: would submitAnswer(${p.questionId}, ${p.answerHex}, 0) ` +
          `= ${p.weight}% with ${ethers.formatEther(q.min_bond)} ETH bond`
      );
      continue;
    }

    if (!wallet) throw new Error("PRIVATE_KEY not set — cannot send transactions.");

    console.log(`  ${label}: submitting ${p.weight}% (${p.answerWei})...`);
    try {
      // max_previous = 0 disables the previous-bond check; safe because we just
      // verified bond == 0 above.
      const receipt = await retryTransaction(() =>
        reality.submitAnswer(p.questionId, p.answerHex, 0, { value: q.min_bond })
      );
      progress.append({
        kind: "answer",
        key: p.questionId.toLowerCase(),
        outcome: p.outcome,
        sheetProject: p.sheetProject,
        questionId: p.questionId,
        weight: p.weight,
        answerWei: p.answerWei.toString(),
        bondWei: q.min_bond.toString(),
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        timestamp: new Date().toISOString(),
      });
      submitted++;
      await sleep(DELAY_MS);
    } catch (err) {
      console.error(`  ${label}: submitAnswer() failed after retries: ${err.message}`);
      errors.push({ outcome: p.outcome, questionId: p.questionId, error: err.message });
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  const pending = plan.length - skipped;
  if (DRY_RUN) {
    console.log(
      `\n🎉 Dry run — ${pending} answer(s) would be submitted (${skipped} skipped), ` +
        `bonding ${ethers.formatEther(totalBond)} ETH. Pass --live to execute.`
    );
  } else {
    console.log(`\n🎉 Submitted ${submitted}/${pending} answer(s) (${skipped} skipped). Log → ${progress.path}.`);
    if (submitted > 0) {
      const finalizeAt = new Date((now + timeout) * 1000).toISOString();
      console.log(
        `⏳ Questions finalize ~${finalizeAt} (timeout ${timeout}s). ` +
          `Call Market.resolve() on ${OCTANT_MARKET} after that.`
      );
    }
  }
  if (errors.length) {
    console.log(`⚠️  ${errors.length} error(s):`);
    errors.forEach((e) => console.log(`     ${e.outcome}: ${e.error}`));
  }
  return { submitted, skipped, errors: errors.length };
  }
);
