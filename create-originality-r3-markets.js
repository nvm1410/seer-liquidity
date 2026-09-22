import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import { MarketViewAbi } from "./abis/MarketViewAbi.js";

// ─────────────────────────────────────────────────────────────────────────────
// Creates the round-3 originality market set on Optimism:
//
//   Phase A  1 multi-scalar PARENT — outcomes Bundle A / B / C plus the factory's
//            "Invalid result" slot, collateral sUSDS, templateId 1, one uint Reality
//            question per bundle ("How many repositories in Bundle A will be…").
//   Phase B  98 conditional scalar CHILDREN — "average originality score of {repo}",
//            bounds 0-100, outcomes [DOWN, UP, Invalid result], templateId 1, each
//            conditional on its BUNDLE's outcome token (parentOutcome 0, 1 or 2).
//
// Reads ./originality-r3-seed.json (built by snapshot-originality-r2-prices.js).
// Writes ./create-originality-r3-v2-execution.json — resumable: the parent and any
// child already in that log are skipped, so a re-run retries only failures and
// never creates a duplicate market.
//
// ── WHY BUNDLES ─────────────────────────────────────────────────────────────
// Round 2 held all 98 repos in a single multi-categorical market, created
// 2025-10-30 in one transaction of 36,804,432 gas (tx 0x03d2f16a…, block
// 143,096,848). That is no longer possible: OP Mainnet has since introduced a
// per-transaction gas cap of 2^24 = 16,777,216, measured 2026-09-21 with zero-value
// self-transfers (accepted at 16,777,216, rejected at 16,873,437 on six independent
// RPC operators).
//
// A multi-categorical parent costs ~372,216 gas per outcome. The multi-scalar
// parent here has three outcomes, so it asks three short Reality questions and
// deploys four wrapped tokens — a small fraction of the cap. The bundles exist
// only to get under that cap; the UI lists the 98 repos flat, as round 2 did.
//
// Do NOT turn the parent back into a 98-outcome market "because round 2 did it".
// ─────────────────────────────────────────────────────────────────────────────

// ── Config ──────────────────────────────────────────────────────────────────
const DRY_RUN = true; // ← set to false to send transactions

const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL;
const CHAIN_ID = 10;

// Addresses (Optimism, chain 10)
const MARKET_FACTORY = "0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6";
const MARKET_VIEW = "0x336695ec9efbafd6322fb82eaadbcda02e38f348";

const SEED_FILE = "./originality-r3-seed.json";
const PROGRESS_FILE = "./create-originality-r3-v2-execution.json";

// Reality template id (src/MarketFactory.sol:63). Both the multi-scalar parent's
// questions and the scalar children's are uint questions.
const REALITY_UINT_TEMPLATE = 1;

const BUNDLE_COUNT = 3;
const REPO_COUNT = 98;

const GAS_MULTIPLIER_PCT = 120n;
// Hard chain limit — see the header. A transaction estimated above this cannot be
// broadcast at all, so fail loudly here rather than at send time.
const MAX_TX_GAS = 16_777_216n;

// The factory REVERTS on ERC20 names past 31 bytes (MarketFactory.toString31,
// src/MarketFactory.sol:448 — require(length < 32)).
const MAX_TOKEN_NAME_BYTES = 31;

// Reality interpolates the question into a JSON template — a raw quote, backslash
// or unit separator breaks parsing. Applies to every string that reaches a question.
const FORBIDDEN_CHARS = ['"', "\\", "␟"];

const DELAY_MS = 2000;

// ── ABIs ────────────────────────────────────────────────────────────────────
const CREATE_MARKET_PARAMS =
  "(string marketName,string[] outcomes,string questionStart,string questionEnd,string outcomeType,uint256 parentOutcome,address parentMarket,string category,string lang,uint256 lowerBound,uint256 upperBound,uint256 minBond,uint32 openingTime,string[] tokenNames)";

const MarketFactoryAbi = [
  `function createMultiScalarMarket(${CREATE_MARKET_PARAMS} params) external returns (address)`,
  `function createScalarMarket(${CREATE_MARKET_PARAMS} params) external returns (address)`,
  "function arbitrator() view returns (address)",
  "function realitio() view returns (address)",
  "function questionTimeout() view returns (uint32)",
  "function collateralToken() view returns (address)",
  "event NewMarket(address indexed market, string marketName, address parentMarket, bytes32 conditionId, bytes32 questionId, bytes32[] questionsIds)",
];

const RealitioAbi = ["function getTimeout(bytes32 question_id) view returns (uint32)"];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);
const factory = new ethers.Contract(MARKET_FACTORY, MarketFactoryAbi, wallet);
const marketView = new ethers.Contract(MARKET_VIEW, MarketViewAbi, provider);

// ── Helpers ─────────────────────────────────────────────────────────────────
async function retryTransaction(txFn, retries = 3, delayMs = 4000) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`    Attempt ${attempt}/${retries}...`);
      const tx = await txFn();
      console.log(`    Tx sent: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`    Confirmed in block ${receipt.blockNumber}, gas used ${receipt.gasUsed}`);
      return receipt;
    } catch (err) {
      lastError = err;
      const msg = err.info?.error?.message ?? err.shortMessage ?? err.message ?? "";
      console.warn(`    Attempt ${attempt} failed: ${String(msg).slice(0, 200)}`);
      if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

// Mirrors MarketFactory.encodeRealityQuestionWithoutOutcomes (src/MarketFactory.sol:352).
// Uint questions carry no outcome list (verified against round 2's on-chain child:
// "What will be the average originality score of ethereum/py_ecc…?␟misc␟en_US").
function encodeQuestionWithoutOutcomes(name, category, lang) {
  const SEP = "␟";
  return `${name}${SEP}${category}${SEP}${lang}`;
}

// Mirrors MarketFactory.askRealityQuestion (src/MarketFactory.sol:368). Reality
// derives a question id from its content; if a question with that id already
// exists the factory REUSES it instead of asking a new one, silently binding two
// markets to the same question. Precompute the ids to detect that before sending.
function computeQuestionId({ templateId, openingTime, encodedQuestion, arbitrator, questionTimeout, minBond, realitio }) {
  const contentHash = ethers.solidityPackedKeccak256(
    ["uint256", "uint32", "string"],
    [templateId, openingTime, encodedQuestion]
  );
  return ethers.solidityPackedKeccak256(
    ["bytes32", "address", "uint32", "uint256", "address", "address", "uint256"],
    [contentHash, arbitrator, questionTimeout, minBond, realitio, MARKET_FACTORY, 0]
  );
}

function checkText(label, s, errors) {
  if (typeof s !== "string" || s.length === 0) {
    errors.push(`${label}: empty`);
    return;
  }
  for (const c of FORBIDDEN_CHARS) {
    if (s.includes(c)) errors.push(`${label}: contains forbidden character ${JSON.stringify(c)} — "${s}"`);
  }
}

function checkTokenName(label, s, errors) {
  checkText(label, s, errors);
  if (typeof s === "string" && Buffer.byteLength(s, "utf8") > MAX_TOKEN_NAME_BYTES) {
    errors.push(`${label}: ${Buffer.byteLength(s, "utf8")} bytes, max ${MAX_TOKEN_NAME_BYTES} — "${s}"`);
  }
}

function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) return { openingTime: null, parent: null, children: [] };
  try {
    const p = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
    return { openingTime: p.openingTime ?? null, parent: p.parent ?? null, children: p.children ?? [] };
  } catch {
    return { openingTime: null, parent: null, children: [] };
  }
}

function saveProgress(p) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

// Pull the created address off the NewMarket event — a transaction receipt does
// not carry a function's return value.
function marketFromReceipt(receipt, iface) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== MARKET_FACTORY.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "NewMarket") return parsed.args;
    } catch {
      // not a NewMarket log
    }
  }
  throw new Error("NewMarket event not found in receipt.");
}

// createMultiScalarMarket ignores params.marketName: the factory builds the name
// as questionStart + "[" + outcomeType + "]" + questionEnd (src/MarketFactory.sol:224).
function buildParentParams(parent, openingTime) {
  return {
    marketName: "",
    outcomes: parent.outcomes.slice(),
    questionStart: parent.questionStart,
    questionEnd: parent.questionEnd,
    outcomeType: parent.outcomeType,
    parentOutcome: 0n,
    parentMarket: ethers.ZeroAddress,
    category: parent.category,
    lang: parent.lang,
    lowerBound: 0n,
    upperBound: 0n,
    minBond: BigInt(parent.minBondWei),
    openingTime,
    tokenNames: parent.tokenNames.slice(),
  };
}

function buildChildParams(seed, child, parentMarket, openingTime) {
  const parent = seed.parent;
  return {
    marketName: child.marketName,
    outcomes: child.outcomes.slice(),
    questionStart: "",
    questionEnd: "",
    outcomeType: "",
    parentOutcome: BigInt(child.parentOutcome),
    parentMarket,
    category: parent.category,
    lang: parent.lang,
    lowerBound: BigInt(child.lowerBound),
    upperBound: BigInt(child.upperBound),
    minBond: BigInt(parent.minBondWei),
    openingTime,
    tokenNames: child.tokenNames.slice(),
  };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!RPC_URL) throw new Error("RPC_URL missing from .env");
  if (!WALLET_PRIVATE_KEY) throw new Error("PRIVATE_KEY missing from .env");
  if (!fs.existsSync(SEED_FILE)) {
    throw new Error(`${SEED_FILE} not found — run snapshot-originality-r2-prices.js first.`);
  }

  const seed = JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));
  const progress = loadProgress();
  const parent = seed.parent;

  console.log(`\n${DRY_RUN ? "DRY RUN" : "LIVE RUN"} — originality round 3 market creation (bundled multi-scalar parent)`);
  console.log(`   wallet  : ${wallet.address}`);
  console.log(`   seed    : ${SEED_FILE} (generated ${seed.generatedAt})`);
  console.log(`   bundles : ${seed.bundles.map((b) => `${b.label} ${b.repos.length}`).join(" / ")}`);
  console.log(`   children: ${seed.children.length}\n`);

  // ── Validate the seed file ────────────────────────────────────────────────
  const errors = [];
  if (parent?.marketType !== "multiScalar") errors.push(`parent.marketType is ${parent?.marketType}, expected multiScalar`);
  if (parent.outcomes.length !== BUNDLE_COUNT) errors.push(`parent has ${parent.outcomes.length} outcomes, expected ${BUNDLE_COUNT}`);
  if (parent.tokenNames.length !== parent.outcomes.length) {
    errors.push(`parent tokenNames (${parent.tokenNames.length}) != outcomes (${parent.outcomes.length})`);
  }
  checkText("parent questionStart", parent.questionStart, errors);
  checkText("parent questionEnd", parent.questionEnd, errors);
  checkText("parent outcomeType", parent.outcomeType, errors);
  parent.outcomes.forEach((o, i) => checkText(`parent outcomes[${i}]`, o, errors));
  parent.tokenNames.forEach((t, i) => checkTokenName(`parent tokenNames[${i}]`, t, errors));
  if (new Set(parent.outcomes).size !== parent.outcomes.length) errors.push("parent has duplicate outcomes");
  const expectedName = `${parent.questionStart}[${parent.outcomeType}]${parent.questionEnd}`;
  if (parent.marketName !== expectedName) errors.push(`parent.marketName does not match questionStart[outcomeType]questionEnd`);

  // Bundles: 3 contiguous groups covering the 98 children in order, labels and
  // tokens matching the parent's outcome slots.
  if (seed.bundles.length !== BUNDLE_COUNT) errors.push(`${seed.bundles.length} bundles, expected ${BUNDLE_COUNT}`);
  const bundleOfRepo = new Map();
  seed.bundles.forEach((b, i) => {
    if (b.index !== i) errors.push(`bundles[${i}].index is ${b.index}`);
    if (b.label !== parent.outcomes[i]) errors.push(`bundles[${i}].label "${b.label}" != parent outcome "${parent.outcomes[i]}"`);
    if (b.tokenName !== parent.tokenNames[i]) errors.push(`bundles[${i}].tokenName != parent tokenNames[${i}]`);
    for (const repo of b.repos) {
      if (bundleOfRepo.has(repo)) errors.push(`repo "${repo}" appears in more than one bundle`);
      bundleOfRepo.set(repo, i);
    }
  });
  const flatBundleRepos = seed.bundles.flatMap((b) => b.repos);
  if (flatBundleRepos.length !== REPO_COUNT) errors.push(`bundles cover ${flatBundleRepos.length} repos, expected ${REPO_COUNT}`);

  if (seed.children.length !== REPO_COUNT) errors.push(`${seed.children.length} children, expected ${REPO_COUNT}`);
  const seenRepos = new Set();
  seed.children.forEach((c, i) => {
    const tag = `child "${c.repo}"`;
    if (seenRepos.has(c.repo)) errors.push(`${tag}: duplicate repo`);
    seenRepos.add(c.repo);
    if (flatBundleRepos[i] !== c.repo) errors.push(`${tag}: position ${i} holds "${flatBundleRepos[i]}" in the bundle lists`);
    if (bundleOfRepo.get(c.repo) !== c.parentOutcome) {
      errors.push(`${tag}: parentOutcome ${c.parentOutcome} but the repo is in bundle ${bundleOfRepo.get(c.repo)}`);
    }
    checkText(`${tag}.marketName`, c.marketName, errors);
    if (!c.marketName.includes(c.repo)) errors.push(`${tag}: market name does not name its repo`);
    if (c.outcomes.length !== 2) errors.push(`${tag}: createScalarMarket requires exactly 2 outcomes`);
    c.outcomes.forEach((o, j) => checkText(`${tag}.outcomes[${j}]`, o, errors));
    c.tokenNames.forEach((t, j) => checkTokenName(`${tag}.tokenNames[${j}]`, t, errors));
    if (BigInt(c.upperBound) <= BigInt(c.lowerBound)) errors.push(`${tag}: upperBound must exceed lowerBound`);
  });

  // Every ERC20 symbol across the whole set must be distinct (round 2's 196
  // children were all literally DOWN/UP).
  const allSymbols = [...parent.tokenNames, ...seed.children.flatMap((c) => c.tokenNames)];
  const symbolCounts = new Map();
  for (const s of allSymbols) symbolCounts.set(s, (symbolCounts.get(s) ?? 0) + 1);
  for (const [s, n] of symbolCounts) {
    if (n > 1) errors.push(`ERC20 symbol "${s}" appears ${n} times across the set`);
  }

  if (errors.length) {
    console.error(`${errors.length} validation error(s):`);
    for (const e of errors) console.error(`   - ${e}`);
    process.exit(1);
  }
  console.log(
    `Seed file validated: 1 parent (${BUNDLE_COUNT} bundles), ${REPO_COUNT} children, ` +
      `${allSymbols.length} distinct ERC20 symbols.\n`
  );

  // ── Factory / Reality config ──────────────────────────────────────────────
  const [arbitrator, realitioAddr, questionTimeout, collateralToken] = await Promise.all([
    factory.arbitrator(),
    factory.realitio(),
    factory.questionTimeout(),
    factory.collateralToken(),
  ]);
  console.log("Factory config:");
  console.log(`   arbitrator      : ${arbitrator}`);
  console.log(`   realitio        : ${realitioAddr}`);
  console.log(`   questionTimeout : ${questionTimeout} s`);
  console.log(`   collateralToken : ${collateralToken}`);

  // openingTime is pinned on the first run and reused on every resume: it feeds the
  // Reality content hash, so changing it mid-set would give the parent and the
  // children different questions.
  const openingTime = progress.openingTime ?? Math.floor(Date.now() / 1000);
  if (progress.openingTime) {
    console.log(`   openingTime     : ${openingTime} (pinned by an earlier run)`);
  } else {
    console.log(
      `   openingTime     : ${openingTime} (${new Date(openingTime * 1000).toISOString()}) — answerable immediately, as in round 2`
    );
  }
  console.log();

  const qid = (encodedQuestion) =>
    computeQuestionId({
      templateId: REALITY_UINT_TEMPLATE,
      openingTime,
      encodedQuestion,
      arbitrator,
      questionTimeout: Number(questionTimeout),
      minBond: BigInt(parent.minBondWei),
      realitio: realitioAddr,
    });

  // Mirrors createMultiScalarMarket: one question per outcome, questionStart + outcome + questionEnd.
  parent._encoded = parent.outcomes.map((o) =>
    encodeQuestionWithoutOutcomes(`${parent.questionStart}${o}${parent.questionEnd}`, parent.category, parent.lang)
  );
  parent._questionIds = parent._encoded.map(qid);
  for (const c of seed.children) {
    c._encoded = encodeQuestionWithoutOutcomes(c.marketName, parent.category, parent.lang);
    c._questionId = qid(c._encoded);
  }
  const allQids = [...parent._questionIds, ...seed.children.map((c) => c._questionId)];
  if (new Set(allQids).size !== allQids.length) throw new Error("two questions in this set produce the same Reality question id");

  // ── Reality question-id collision check ───────────────────────────────────
  console.log("Checking Reality for pre-existing question ids...");
  const realitio = new ethers.Contract(realitioAddr, RealitioAbi, provider);
  const collisions = [];
  for (let i = 0; i < parent._questionIds.length; i++) {
    if (Number(await realitio.getTimeout(parent._questionIds[i])) !== 0) collisions.push(`parent ${parent.outcomes[i]}`);
  }
  for (const c of seed.children) {
    if (Number(await realitio.getTimeout(c._questionId)) !== 0) collisions.push(c.repo);
  }
  if (collisions.length) {
    console.warn(`   WARNING: ${collisions.length} question(s) already exist on Reality:`);
    collisions.slice(0, 10).forEach((c) => console.warn(`      ${c}`));
    if (collisions.length > 10) console.warn(`      ... and ${collisions.length - 10} more`);
    console.warn(
      "      The factory reuses an existing question rather than asking a new one\n" +
        "      (MarketFactory.askRealityQuestion). Expected only when resuming a\n" +
        "      partially-completed run for exactly these questions."
    );
  } else {
    console.log(`   OK: no collisions — ${parent._questionIds.length} parent questions and all ${seed.children.length} children are new\n`);
  }

  // ── Pre-flight: every immutable string, before anything is sent ───────────
  if (DRY_RUN) {
    console.log("=".repeat(100));
    console.log("IMMUTABLE ON-CHAIN TEXT — cannot be edited after creation. Review before going live.");
    console.log("=".repeat(100));
    console.log(`\nPARENT market name (${expectedName.length} chars):`);
    console.log(`   ${expectedName}`);
    console.log(`   ${parent.outcomes.length} outcomes + "Invalid result" (factory-added, token SER-INVALID) = ${parent.outcomes.length + 1} slots`);
    seed.bundles.forEach((b) => {
      console.log(`      [${b.index}] ${b.label.padEnd(10)} ${b.tokenName.padEnd(12)} ${b.repos.length} repos: ${b.repos[0]} .. ${b.repos[b.repos.length - 1]}`);
    });
    parent._encoded.forEach((e, i) => {
      console.log(`\nEncoded Reality question — PARENT ${parent.outcomes[i]} (${e.length} chars):`);
      console.log(`   ${e}`);
    });
    console.log(`\nCHILD market names (${seed.children.length}) with outcome labels and ERC20 symbols:`);
    seed.children.forEach((c) => {
      console.log(`   ${parent.outcomes[c.parentOutcome]}[${String(c.indexInBundle).padStart(2)}] ${c.marketName}`);
      console.log(`        outcomes [${c.outcomes.join(", ")}]  symbols [${c.tokenNames.join(", ")}]`);
    });
    const longest = allSymbols.reduce((a, b) => (Buffer.byteLength(b) > Buffer.byteLength(a) ? b : a));
    const longestChild = seed.children.reduce((a, b) => (b.marketName.length > a.marketName.length ? b : a));
    console.log(
      `\n   ${allSymbols.length} ERC20 symbols total, ${new Set(allSymbols).size} unique, ` +
        `longest "${longest}" (${Buffer.byteLength(longest)} of ${MAX_TOKEN_NAME_BYTES} bytes)`
    );
    console.log(`   longest child name: ${longestChild.marketName.length} chars (${longestChild.repo})`);
    console.log(`\nEncoded Reality question — first CHILD:`);
    console.log(`   ${seed.children[0]._encoded}`);
    console.log("\n" + "=".repeat(100));
  }

  // ── Simulate ──────────────────────────────────────────────────────────────
  let parentMarket = progress.parent?.market ?? null;
  let totalGas = 0n;
  if (parentMarket) {
    console.log(`\nParent already created (${parentMarket}) — skipping it.`);
  } else {
    console.log(`\nSimulating the PARENT market (createMultiScalarMarket)...`);
    const gas = await factory.createMultiScalarMarket.estimateGas(buildParentParams(parent, openingTime));
    parent._gas = gas;
    totalGas += gas;
    const pct = (Number(gas) / Number(MAX_TX_GAS)) * 100;
    console.log(`   ${parent.outcomes.length} bundles -> ${gas} gas  (${pct.toFixed(1)}% of the ${MAX_TX_GAS} cap)`);
    if (gas >= MAX_TX_GAS) throw new Error(`parent needs ${gas} gas, above the ${MAX_TX_GAS} per-tx cap`);
  }

  const doneChildren = new Set(progress.children.map((e) => e.repo));
  const childrenTodo = seed.children.filter((c) => !doneChildren.has(c.repo));
  if (doneChildren.size) console.log(`${doneChildren.size} child market(s) already created — skipping them.`);

  if (childrenTodo.length) {
    if (parentMarket) {
      console.log(`\nSimulating CHILD market(s) (createScalarMarket)...`);
      const sample = childrenTodo.slice(0, 3);
      for (const c of sample) {
        const gas = await factory.createScalarMarket.estimateGas(buildChildParams(seed, c, parentMarket, openingTime));
        c._gas = gas;
        console.log(`   ${c.repo.padEnd(44)} gas ${gas}`);
      }
      const avg = sample.reduce((a, c) => a + c._gas, 0n) / BigInt(sample.length);
      totalGas += avg * BigInt(childrenTodo.length);
      console.log(`   sampled ${sample.length}, avg ${avg} -> ~${avg * BigInt(childrenTodo.length)} for ${childrenTodo.length} children`);
    } else {
      // ~1.86M measured against round 2's parent; used only for the cost preview.
      totalGas += 1_863_068n * BigInt(childrenTodo.length);
      console.log(`\nCHILD gas cannot be estimated until the parent exists; using the measured ~1,863,068 each.`);
      console.log(`   ~${1_863_068n * BigInt(childrenTodo.length)} for ${childrenTodo.length} children`);
    }
  }

  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  const balance = await provider.getBalance(wallet.address);
  console.log(
    `\n   Total L2 gas : ${totalGas}\n` +
      `   Gas price    : ${ethers.formatUnits(gasPrice, 9)} gwei\n` +
      `   L2 gas cost  : ~${ethers.formatEther(totalGas * gasPrice)} ETH (EXCLUDES the Optimism L1 data fee)\n` +
      `   ETH balance  : ${ethers.formatEther(balance)} ETH`
  );

  if (DRY_RUN) {
    console.log("\nDry run complete — set DRY_RUN = false to create the markets.");
    return;
  }

  // ── Send ──────────────────────────────────────────────────────────────────
  const iface = new ethers.Interface(MarketFactoryAbi);
  progress.openingTime = openingTime;

  // Phase A — parent
  if (!parentMarket) {
    console.log(`\n--- Phase A: multi-scalar parent (${parent.outcomes.length} bundles) ---`);
    const params = buildParentParams(parent, openingTime);
    const gas = parent._gas ?? (await factory.createMultiScalarMarket.estimateGas(params));
    let gasLimit = (gas * GAS_MULTIPLIER_PCT) / 100n;
    if (gasLimit > MAX_TX_GAS) gasLimit = MAX_TX_GAS; // the buffer must not push us over the cap
    const receipt = await retryTransaction(() => factory.createMultiScalarMarket(params, { gasLimit }));
    const args = marketFromReceipt(receipt, iface);

    // Persist the address BEFORE verifying. The market exists on-chain at this point;
    // if a transient MarketView/RPC failure threw out of here the address would be lost
    // and the next run would create a DUPLICATE parent.
    progress.parent = {
      market: args.market,
      marketName: args.marketName,
      outcomes: parent.outcomes,
      tokenNames: parent.tokenNames,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      conditionId: args.conditionId,
      questionId: args.questionId,
      questionsIds: Array.from(args.questionsIds),
      seerUrl: `https://app.seer.pm/markets/${CHAIN_ID}/${args.market}`,
      timestamp: new Date().toISOString(),
    };
    saveProgress(progress);
    parentMarket = args.market;
    console.log(`  Created ${args.market}`);
    console.log(`  ${progress.parent.seerUrl}`);

    const m = await marketView.getMarket(MARKET_FACTORY, args.market);
    const onChain = Array.from(m.outcomes).map(String);
    const bad = [];
    if (m.marketName !== expectedName) bad.push(`marketName "${m.marketName}"`);
    if (onChain.length !== parent.outcomes.length + 1) bad.push(`${onChain.length} outcomes`);
    if (Number(m.templateId) !== REALITY_UINT_TEMPLATE) bad.push(`templateId ${m.templateId}`);
    if (m.wrappedTokens.length !== parent.outcomes.length + 1) bad.push(`wrappedTokens ${m.wrappedTokens.length}`);
    if (args.questionsIds.length !== parent.outcomes.length) bad.push(`${args.questionsIds.length} Reality questions`);
    args.questionsIds.forEach((q, i) => {
      if (q.toLowerCase() !== parent._questionIds[i].toLowerCase()) bad.push(`question ${i} id ${q} != precomputed`);
    });
    console.log(`  Verified: ${onChain.length} outcomes, templateId ${m.templateId}, wrappedTokens ${m.wrappedTokens.length}`);
    progress.parent.verified = bad.length === 0;
    progress.parent.wrappedTokens = Array.from(m.wrappedTokens);
    saveProgress(progress);
    if (bad.length) throw new Error(`parent verify mismatch: ${bad.join(", ")} — stopping before any child is created`);
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  // Phase B — children
  if (childrenTodo.length) {
    console.log(`\n--- Phase B: ${childrenTodo.length} child market(s) ---`);
    let ok = 0;
    const failures = [];

    for (const c of childrenTodo) {
      console.log(`\n[${ok + 1}/${childrenTodo.length}] ${parent.outcomes[c.parentOutcome]}[${c.indexInBundle}] ${c.repo}`);
      try {
        const params = buildChildParams(seed, c, parentMarket, openingTime);
        const gas = c._gas ?? (await factory.createScalarMarket.estimateGas(params));
        const receipt = await retryTransaction(() =>
          factory.createScalarMarket(params, { gasLimit: (gas * GAS_MULTIPLIER_PCT) / 100n })
        );
        const args = marketFromReceipt(receipt, iface);

        const entry = {
          parentOutcome: c.parentOutcome,
          bundle: parent.outcomes[c.parentOutcome],
          indexInBundle: c.indexInBundle,
          repo: c.repo,
          market: args.market,
          marketName: c.marketName,
          parentMarket,
          tokenNames: c.tokenNames,
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed.toString(),
          conditionId: args.conditionId,
          questionId: args.questionId,
          seedUp: c.seedUp,
          seedDown: c.seedDown,
          seerUrl: `https://app.seer.pm/markets/${CHAIN_ID}/${args.market}`,
          timestamp: new Date().toISOString(),
        };
        progress.children.push(entry);
        saveProgress(progress);
        console.log(`  Created ${args.market}`);
        ok++;

        const m = await marketView.getMarket(MARKET_FACTORY, args.market);
        const bad = [];
        if (m.marketName !== c.marketName) bad.push(`marketName "${m.marketName}"`);
        if (Number(m.templateId) !== REALITY_UINT_TEMPLATE) bad.push(`templateId ${m.templateId}`);
        if (Number(m.parentOutcome) !== c.parentOutcome) bad.push(`parentOutcome ${m.parentOutcome}`);
        if (m.parentMarket.id.toLowerCase() !== parentMarket.toLowerCase()) bad.push(`parentMarket ${m.parentMarket.id}`);
        if (m.upperBound.toString() !== c.upperBound) bad.push(`upperBound ${m.upperBound}`);
        if (m.wrappedTokens.length !== 3) bad.push(`wrappedTokens ${m.wrappedTokens.length}`);
        entry.verified = bad.length === 0;
        if (bad.length) {
          entry.verifyIssues = bad;
          console.warn(`  VERIFY MISMATCH: ${bad.join(", ")}`);
        }
        saveProgress(progress);
      } catch (err) {
        console.error(`  FAILED: ${(err.shortMessage || err.message || "").slice(0, 300)}`);
        failures.push(c.repo);
      }
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }

    console.log(`\n--- Summary ---`);
    console.log(`   parent   : ${parentMarket} (${parent.outcomes.join(" / ")})`);
    console.log(`   children : ${ok}/${childrenTodo.length} created this run, ${progress.children.length}/${REPO_COUNT} total`);
    const mismatched = progress.children.filter((e) => e.verified === false);
    if (mismatched.length) console.log(`   VERIFY MISMATCHES: ${mismatched.map((e) => e.repo).join(", ")}`);
    if (failures.length) {
      console.log(`   failed   : ${failures.length} — re-run to retry only these`);
      failures.forEach((f) => console.log(`      - ${f}`));
    }
  }

  console.log(`\nProgress log: ${PROGRESS_FILE}`);
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
