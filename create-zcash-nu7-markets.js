// Create one single-select categorical Seer market per Zcash NU7 coinholder-poll
// question, on Optimism (chain 10, sUSDS collateral).
//
// Each question in zcash-nu7-questions.json becomes its own market whose outcomes
// are that question's ballot options. The factory appends "Invalid result" as a
// final slot, so a 4-option question has 5 outcome slots and 5 wrapped ERC20s.
//
// Why single-select categorical and not 20 binaries or a multi-scalar market:
// the options within one question are mutually exclusive AND exhaustive, so
// exactly one wins and price == P(that option). The argument in
// CLAUDE_ZCASH_MARKETS_GUIDE.md against folding many questions into one market
// (a multi-categorical pays 1/k to each of k winners, so price reads as "share
// of winners") applies to INDEPENDENT grant approvals — it does not apply here.
// createMultiCategoricalMarket would be wrong (multi-select) and
// createMultiScalarMarket would price vote share, not P(win).
//
// This script ONLY creates markets. Seeding pools is add-zcash-nu7-liquidity.js,
// which reads this script's execution log for addresses and the questions file
// for prices.
//
// Run with DRY_RUN = true first: it staticCalls the factory, estimates gas, checks
// for Reality question-id collisions, and prints every encoded question, without
// sending anything.

import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import { MarketViewAbi } from "./abis/MarketViewAbi.js";

// ── Config ──────────────────────────────────────────────────────────────────
// Re-running live creates ADDITIONAL markets for any question not already in the
// progress file. Questions already logged are skipped, so a resumed run is safe.
const DRY_RUN = false; // ← set to false to send transactions

const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL; // Optimism
const CHAIN_ID = 10;

const QUESTIONS_FILE = "./zcash-nu7-questions-v2.json";
const PROGRESS_FILE = "./create-zcash-nu7-markets-v2-execution.json";

// Addresses (Optimism, chain 10) — same deployment the zcash/octant scripts use.
const MARKET_FACTORY = "0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6";
const MARKET_VIEW = "0x336695ec9efbafd6322fb82eaadbcda02e38f348";
const SUSDS_ADDRESS = "0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0";

// ── Market parameters ───────────────────────────────────────────────────────
const CATEGORY = "misc";
const LANG = "en_US";
const TOKEN_PREFIX = "ZNU7V2";

// Answerable immediately. Answering is gated operationally (see answer-octant-markets.js),
// not at the contract level — Reality places no constraint on a past opening_ts at ask
// time, stateOpen only requires opening_ts <= block.timestamp (RealityETH-3.0.sol:187).
// Pinned to a fixed past instant rather than Date.now() so a resumed run derives the
// same question ids for the markets it still has to create.
const OPENING_TIME_ISO = "2026-09-09T00:00:00Z";

// Reality min bond, in ETH on Optimism. Matches the Zcash Q3 set. Five markets
// means 0.025 ETH to answer them all later — check the wallet before that run.
const MIN_BOND = ethers.parseEther("0.005");

// The factory REVERTS on ERC20 names past 31 bytes (MarketFactory.toString31,
// src/MarketFactory.sol:448 — require(length < 32)), so check here first.
const MAX_TOKEN_NAME_BYTES = 31;

// Reality encodes a question as `title<US>"outcome","outcome"<US>category<US>lang`
// and interpolates it into a JSON template — a raw quote, backslash or unit
// separator breaks parsing. Applies to outcome labels as well as the market name.
const FORBIDDEN_CHARS = ['"', "\\", "␟"];

// Pause between creations so the RPC/sequencer keeps up and a failure is easy to
// locate in the log.
const DELAY_MS = 3000;
const GAS_LIMIT_MULTIPLIER_PCT = 120n;

// ── Factory ABI (from src/MarketFactory.sol) ────────────────────────────────
const MarketFactoryAbi = [
  "function createCategoricalMarket((string marketName,string[] outcomes,string questionStart,string questionEnd,string outcomeType,uint256 parentOutcome,address parentMarket,string category,string lang,uint256 lowerBound,uint256 upperBound,uint256 minBond,uint32 openingTime,string[] tokenNames) params) external returns (address)",
  "function arbitrator() view returns (address)",
  "function realitio() view returns (address)",
  "function questionTimeout() view returns (uint32)",
  "function collateralToken() view returns (address)",
  "event NewMarket(address indexed market, string marketName, address parentMarket, bytes32 conditionId, bytes32 questionId, bytes32[] questionsIds)",
];

const RealitioAbi = ["function getTimeout(bytes32 question_id) view returns (uint32)"];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

// ── Helpers ─────────────────────────────────────────────────────────────────
function normalizeName(s) {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function outcomeLabels(q) {
  return q.outcomes.map((o) => o.label);
}

function tokenNamesFor(q) {
  // tokenNames covers only the named outcomes; the factory names the last slot
  // "SER-INVALID" itself (MarketFactory.deployERC20Positions:428) and
  // short-circuits before reading tokenNames[invalidIndex], so do NOT pad it.
  return q.outcomes.map((o) => `${TOKEN_PREFIX}${q.shortName}${o.tag}`);
}

// Mirrors MarketFactory.encodeRealityQuestionWithOutcomes (src/MarketFactory.sol:329).
function encodeRealityQuestion(question, outcomes, category, lang) {
  const SEP = "␟";
  const encodedOutcomes = outcomes.map((o) => `"${o}"`).join(",");
  return `${question}${SEP}${encodedOutcomes}${SEP}${category}${SEP}${lang}`;
}

// Mirrors MarketFactory.askRealityQuestion (src/MarketFactory.sol:378). Reality
// derives a question id from its content; if a question with that id already
// exists the factory REUSES it instead of asking a new one, which would silently
// bind two markets to the same question. Precompute the id so we can detect that
// before sending anything.
function computeQuestionId({ templateId, openingTime, encodedQuestion, arbitrator, questionTimeout, minBond, realitio, factory }) {
  const contentHash = ethers.solidityPackedKeccak256(
    ["uint256", "uint32", "string"],
    [templateId, openingTime, encodedQuestion]
  );
  return ethers.solidityPackedKeccak256(
    ["bytes32", "address", "uint32", "uint256", "address", "address", "uint256"],
    [contentHash, arbitrator, questionTimeout, minBond, realitio, factory, 0]
  );
}

async function retryTransaction(txFn, retries = 3, delayMs = 3000) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`  Attempt ${attempt}/${retries}...`);
      const tx = await txFn();
      console.log(`  Tx sent: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`  Confirmed in block ${receipt.blockNumber}, gas used ${receipt.gasUsed}`);
      return receipt;
    } catch (err) {
      lastError = err;
      console.warn(`  Attempt ${attempt} failed: ${err.message}`);
      if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

function loadQuestions() {
  const doc = JSON.parse(fs.readFileSync(QUESTIONS_FILE, "utf8"));
  if (!Array.isArray(doc.questions) || !doc.questions.length) {
    throw new Error(`${QUESTIONS_FILE} has no questions.`);
  }
  return doc;
}

// Everything that must hold before a single transaction is sent. Markets are
// immutable, so a bad question text, a bad outcome label or a duplicate Reality
// question cannot be fixed afterwards — the only remedy is creating a replacement
// set, as the PD v1→v2 rebuild showed.
function validate(doc, ctx) {
  const questions = doc.questions;
  const errors = [];

  const seenId = new Set();
  const seenShort = new Set();
  const seenToken = new Set();
  const seenQuestion = new Set();
  const seenQuestionId = new Map();

  for (const q of questions) {
    const tag = `id ${q.id} (${q.shortName})`;

    if (seenId.has(q.id)) errors.push(`${tag}: duplicate id.`);
    seenId.add(q.id);

    if (!q.shortName || !/^[A-Z0-9]+$/.test(q.shortName)) {
      errors.push(`${tag}: shortName must be non-empty uppercase alphanumeric.`);
    }
    if (seenShort.has(q.shortName)) errors.push(`${tag}: duplicate shortName.`);
    seenShort.add(q.shortName);

    if (!Array.isArray(q.outcomes) || q.outcomes.length < 2) {
      errors.push(`${tag}: needs at least 2 outcomes (MarketFactory.sol:141).`);
      continue;
    }

    // Prices are the seed prices for add-zcash-nu7-liquidity.js. A categorical
    // market's outcome prices must sum to 1 — anything else is arbitrage on day one.
    let priceSum = 0;
    const seenLabel = new Set();
    const seenTag = new Set();
    for (const o of q.outcomes) {
      if (!(o.price > 0 && o.price < 1)) {
        errors.push(`${tag}: outcome "${o.label}" price ${o.price} must be strictly between 0 and 1.`);
      }
      priceSum += o.price;

      if (!o.tag || !/^[A-Z0-9]+$/.test(o.tag)) {
        errors.push(`${tag}: outcome tag "${o.tag}" must be uppercase alphanumeric.`);
      }
      if (seenTag.has(o.tag)) errors.push(`${tag}: duplicate outcome tag "${o.tag}".`);
      seenTag.add(o.tag);

      const key = normalizeName(o.label ?? "");
      if (!key) errors.push(`${tag}: outcome with tag "${o.tag}" has an empty label.`);
      if (seenLabel.has(key)) errors.push(`${tag}: duplicate outcome label "${o.label}".`);
      seenLabel.add(key);
      if (key === "invalid result") {
        errors.push(`${tag}: "Invalid result" must not be listed — the factory appends it.`);
      }
      for (const c of FORBIDDEN_CHARS) {
        if ((o.label ?? "").includes(c)) {
          errors.push(`${tag}: outcome label contains forbidden character ${JSON.stringify(c)}.`);
        }
      }
    }
    if (Math.abs(priceSum - 1) > 1e-9) {
      errors.push(`${tag}: outcome prices sum to ${priceSum.toFixed(10)}, expected 1.`);
    }

    const marketName = q.marketName;
    if (!marketName) errors.push(`${tag}: marketName is required.`);
    for (const c of FORBIDDEN_CHARS) {
      if ((marketName ?? "").includes(c)) {
        errors.push(`${tag}: market name contains forbidden character ${JSON.stringify(c)}.`);
      }
    }
    const qKey = normalizeName(marketName ?? "");
    if (seenQuestion.has(qKey)) errors.push(`${tag}: duplicate market name — would collide on Reality.`);
    seenQuestion.add(qKey);

    for (const tn of tokenNamesFor(q)) {
      const bytes = Buffer.byteLength(tn, "utf8");
      if (bytes > MAX_TOKEN_NAME_BYTES) {
        errors.push(`${tag}: token name "${tn}" is ${bytes} bytes — toString31 would revert.`);
      }
      if (seenToken.has(tn)) errors.push(`${tag}: duplicate token name "${tn}".`);
      seenToken.add(tn);
    }

    // Reality question-id collision, computed exactly as the factory will.
    const encodedQuestion = encodeRealityQuestion(marketName ?? "", outcomeLabels(q), CATEGORY, LANG);
    const questionId = computeQuestionId({ ...ctx, encodedQuestion });
    if (seenQuestionId.has(questionId)) {
      errors.push(`${tag}: Reality questionId collides with id ${seenQuestionId.get(questionId)}.`);
    }
    seenQuestionId.set(questionId, q.id);
    q._encodedQuestion = encodedQuestion;
    q._questionId = questionId;
  }

  return errors;
}

function buildParams(q, openingTime) {
  return [
    q.marketName,
    outcomeLabels(q),
    "", // questionStart  — multi-scalar only
    "", // questionEnd    — multi-scalar only
    "", // outcomeType    — multi-scalar only
    0n, // parentOutcome  — top-level market
    ethers.ZeroAddress, // parentMarket — top-level market
    CATEGORY,
    LANG,
    0n, // lowerBound — scalar only
    0n, // upperBound — scalar only
    MIN_BOND,
    openingTime,
    tokenNamesFor(q),
  ];
}

async function verifyMarket(marketAddress, q) {
  const marketView = new ethers.Contract(MARKET_VIEW, MarketViewAbi, provider);
  const info = await marketView.getMarket(MARKET_FACTORY, marketAddress);

  const expected = [...outcomeLabels(q), "Invalid result"];
  const onChain = [...info.outcomes];
  if (onChain.length !== expected.length) {
    throw new Error(`Outcome count ${onChain.length} != expected ${expected.length}.`);
  }
  for (let i = 0; i < expected.length; i++) {
    if (normalizeName(onChain[i]) !== normalizeName(expected[i])) {
      throw new Error(`Outcome ${i}: on-chain "${onChain[i]}" != expected "${expected[i]}".`);
    }
  }
  if (info.collateralToken.toLowerCase() !== SUSDS_ADDRESS.toLowerCase()) {
    throw new Error(`Collateral ${info.collateralToken} != sUSDS ${SUSDS_ADDRESS}.`);
  }
  if (info.parentCollectionId !== ethers.ZeroHash) {
    throw new Error("Market is conditional — expected a top-level market.");
  }
  if (info.wrappedTokens.length !== expected.length) {
    throw new Error(`wrappedTokens ${info.wrappedTokens.length} != outcomes ${expected.length}.`);
  }
  if (info.questionsIds.length !== 1) {
    throw new Error(`Expected 1 Reality question, got ${info.questionsIds.length}.`);
  }
  if (Number(info.templateId) !== 2) {
    throw new Error(`Expected templateId 2 (single-select), got ${info.templateId}.`);
  }
  return {
    outcomes: onChain,
    wrappedTokens: [...info.wrappedTokens],
    questionsIds: [...info.questionsIds],
  };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nWallet   : ${wallet.address}`);
  console.log(`DRY_RUN  : ${DRY_RUN}`);
  console.log(`Chain    : Optimism (${CHAIN_ID})`);

  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) {
    throw new Error(`RPC_URL points at chain ${net.chainId}, expected ${CHAIN_ID} (Optimism).`);
  }

  const factory = new ethers.Contract(MARKET_FACTORY, MarketFactoryAbi, wallet);
  const [arbitrator, realitioAddr, questionTimeout, factoryCollateral] = await Promise.all([
    factory.arbitrator(),
    factory.realitio(),
    factory.questionTimeout(),
    factory.collateralToken(),
  ]);
  if (factoryCollateral.toLowerCase() !== SUSDS_ADDRESS.toLowerCase()) {
    throw new Error(`Factory collateral ${factoryCollateral} != sUSDS ${SUSDS_ADDRESS}.`);
  }

  const openingTime = Math.floor(new Date(OPENING_TIME_ISO).getTime() / 1000);
  const ctx = {
    templateId: 2, // REALITY_SINGLE_SELECT_TEMPLATE
    openingTime,
    arbitrator,
    questionTimeout: Number(questionTimeout),
    minBond: MIN_BOND,
    realitio: realitioAddr,
    factory: MARKET_FACTORY,
  };

  console.log(`\narbitrator      : ${arbitrator}`);
  console.log(`realitio        : ${realitioAddr}`);
  console.log(`questionTimeout : ${questionTimeout}s (${(Number(questionTimeout) / 86400).toFixed(1)} days)`);
  console.log(`minBond         : ${ethers.formatEther(MIN_BOND)} ETH`);
  console.log(`openingTime     : ${openingTime} (${OPENING_TIME_ISO})`);
  console.log(`category/lang   : ${CATEGORY} / ${LANG}`);

  if (openingTime < Math.floor(Date.now() / 1000)) {
    console.log("   openingTime is in the past — questions are answerable immediately, by design.");
  }

  // ── Load + validate ───────────────────────────────────────────────────────
  const doc = loadQuestions();
  console.log(`\nBallot snapshot : ${doc.questions.length} questions, ${doc.snapshotOf}`);
  console.log(`Source          : ${doc.source}`);
  if (!doc.ballotFrozenAt) {
    console.warn(
      "\n   WARNING: ballotFrozenAt is null — the poll wording is NOT confirmed final.\n" +
        "      Seer markets are immutable: a question reworded or dropped before the poll\n" +
        "      runs resolves Invalid, and Invalid is deliberately unpooled. Read every\n" +
        "      market name and outcome label below before setting DRY_RUN = false."
    );
  }
  if (!doc.pollUrl) {
    console.warn("   WARNING: pollUrl is null — no resolution source is recorded for these questions.");
  }

  const errors = validate(doc, ctx);
  if (errors.length) {
    console.error(`\n${errors.length} validation error(s):`);
    errors.forEach((e) => console.error(`   - ${e}`));
    throw new Error("Validation failed — nothing sent.");
  }
  const totalOutcomes = doc.questions.reduce((a, q) => a + q.outcomes.length, 0);
  console.log(
    `\n   OK: ${doc.questions.length} questions / ${totalOutcomes} outcomes valid — unique ids, ` +
      "shortNames, token names and Reality questions; every price set sums to 1"
  );

  // ── The full ballot, printed for review ───────────────────────────────────
  console.log("\nMarkets to create:\n");
  for (const q of doc.questions) {
    console.log(`  [${q.id}] ${q.shortName} — ${q.topic}`);
    console.log(`      "${q.marketName}"`);
    const names = tokenNamesFor(q);
    q.outcomes.forEach((o, i) => {
      console.log(`        ${String(i).padStart(2)}. ${o.price.toFixed(2)}  ${names[i].padEnd(18)} ${o.label}`);
    });
    console.log(
      `        ${String(q.outcomes.length).padStart(2)}.  --   ${"SER-INVALID".padEnd(18)} ` +
        "Invalid result (appended by the factory, gets no pool)"
    );
    console.log("");
  }

  // ── Reality question-id collision check against live state ────────────────
  console.log("Checking Reality for pre-existing question ids...");
  const realitio = new ethers.Contract(realitioAddr, RealitioAbi, provider);
  const existing = [];
  for (const q of doc.questions) {
    const timeout = await realitio.getTimeout(q._questionId);
    if (Number(timeout) !== 0) existing.push(q);
  }
  if (existing.length) {
    console.warn(`   WARNING: ${existing.length} question(s) already exist on Reality:`);
    existing.forEach((q) => console.warn(`      id ${q.id} ${q.shortName} -> ${q._questionId}`));
    console.warn(
      "      The factory reuses an existing question rather than asking a new one\n" +
        "      (MarketFactory.askRealityQuestion:391). That is expected only if you are\n" +
        "      resuming a partially-completed run for exactly these questions."
    );
  } else {
    console.log(`   OK: no collisions — all ${doc.questions.length} questions are new`);
  }

  // ── Progress log ──────────────────────────────────────────────────────────
  let progressLog = [];
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      progressLog = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
    } catch {
      progressLog = [];
    }
  }
  const alreadyDone = new Set(progressLog.map((e) => e.id));
  const todo = doc.questions.filter((q) => !alreadyDone.has(q.id));
  if (alreadyDone.size) {
    console.log(`\n${alreadyDone.size} question(s) already in ${PROGRESS_FILE} — skipping them.`);
  }
  if (!todo.length) {
    console.log("\nEvery question already has a market. Nothing to do.");
    return;
  }

  // ── Simulate ──────────────────────────────────────────────────────────────
  console.log(`\nSimulating createCategoricalMarket for ${todo.length} market(s)...\n`);
  console.log("    #  shortName  slots  first token           gas");
  let totalGas = 0n;
  for (const q of todo) {
    const args = [buildParams(q, openingTime)];
    const gas = await factory.createCategoricalMarket.estimateGas(...args);
    q._gas = gas;
    totalGas += gas;
    console.log(
      `   ${String(q.id).padStart(2)}  ${q.shortName.padEnd(9)} ` +
        `${String(q.outcomes.length + 1).padStart(5)}  ` +
        `${tokenNamesFor(q)[0].padEnd(20)} ${gas.toString().padStart(9)}`
    );
  }

  // Clones use CREATE, so the predicted address depends on the factory nonce and
  // shifts as markets are created. Simulate one only as a liveness check.
  const predicted = await factory.createCategoricalMarket.staticCall(buildParams(todo[0], openingTime));
  console.log(`\n   staticCall OK (first market would land at ${predicted} at the current nonce)`);

  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  const l2Cost = totalGas * gasPrice;
  const balance = await provider.getBalance(wallet.address);
  console.log(
    `\n   Total L2 gas : ${totalGas} over ${todo.length} tx (avg ${totalGas / BigInt(todo.length)})\n` +
      `   Gas price    : ${ethers.formatUnits(gasPrice, 9)} gwei\n` +
      `   L2 gas cost  : ~${ethers.formatEther(l2Cost)} ETH (EXCLUDES the Optimism L1 data fee)\n` +
      `   ETH balance  : ${ethers.formatEther(balance)} ETH\n` +
      `   Answering all ${doc.questions.length} later costs ${ethers.formatEther(
        MIN_BOND * BigInt(doc.questions.length)
      )} ETH in bonds.`
  );
  if (balance < l2Cost) {
    console.warn("   WARNING: balance below the L2 gas estimate alone — top up before running live.");
  }

  console.log("\nEncoded Reality question for the first market, exactly as the factory will encode it:");
  console.log(`   ${todo[0]._encodedQuestion}`);

  if (DRY_RUN) {
    console.log("\nDry run complete — set DRY_RUN = false to create the markets.");
    return;
  }

  // ── Send ──────────────────────────────────────────────────────────────────
  console.log(`\nCreating ${todo.length} markets...\n`);
  const iface = new ethers.Interface(MarketFactoryAbi);
  let successCount = 0;

  for (const q of todo) {
    console.log(`\n--- [${q.id}] ${q.shortName}: ${q.topic} ---`);
    try {
      const args = [buildParams(q, openingTime)];
      const gasLimit = (q._gas * GAS_LIMIT_MULTIPLIER_PCT) / 100n;
      const receipt = await retryTransaction(() => factory.createCategoricalMarket(...args, { gasLimit }));

      // The return value is not available from a receipt — read the address off
      // the NewMarket event the factory emits.
      let event = null;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== MARKET_FACTORY.toLowerCase()) continue;
        try {
          const parsed = iface.parseLog(log);
          if (parsed?.name === "NewMarket") {
            event = parsed;
            break;
          }
        } catch {
          // not a NewMarket log
        }
      }
      if (!event) throw new Error("NewMarket event not found in receipt.");

      const market = event.args.market;

      // Record the address BEFORE verifying. The market already exists on-chain at this
      // point; if a transient MarketView/RPC failure threw out of here the address would
      // be lost and the next run would create a DUPLICATE market for the same question.
      // The verified fields are merged into this same entry below.
      const entry = {
        id: q.id,
        shortName: q.shortName,
        topic: q.topic,
        market,
        chainId: CHAIN_ID,
        marketName: q.marketName,
        outcomeLabels: outcomeLabels(q),
        prices: q.outcomes.map((o) => o.price),
        encodedQuestion: q._encodedQuestion,
        conditionId: event.args.conditionId,
        questionId: event.args.questionId,
        questionsIds: [...event.args.questionsIds],
        realityQuestionId: q._questionId,
        tokenNames: tokenNamesFor(q),
        openingTime,
        minBond: MIN_BOND.toString(),
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        createdAt: new Date().toISOString(),
        verified: false,
      };
      progressLog.push(entry);
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progressLog, null, 2));
      console.log(`  ${market} saved to ${PROGRESS_FILE}`);

      const verified = await verifyMarket(market, q);
      entry.outcomes = verified.outcomes;
      entry.wrappedTokens = verified.wrappedTokens;
      entry.verified = true;
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progressLog, null, 2));
      successCount++;
      console.log(`  verified — ${verified.outcomes.length} outcomes, ${verified.wrappedTokens.length} wrapped tokens`);
      console.log(`     https://app.seer.pm/markets/${CHAIN_ID}/${market}`);
    } catch (err) {
      console.error(`  FAILED for ${q.shortName}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  console.log(`\nDone. ${successCount}/${todo.length} markets created and verified. See ${PROGRESS_FILE}.`);
  const unverified = progressLog.filter((e) => e.verified !== true);
  if (unverified.length) {
    console.warn("");
    console.warn(`   WARNING: ${unverified.length} market(s) were created but NOT verified. They ARE logged,`);
    console.warn("      so a re-run skips them rather than creating duplicates. Check by hand:");
    unverified.forEach((e) => console.warn(`      [${e.id}] ${e.shortName} ${e.market}`));
  }
  if (successCount < todo.length) {
    console.log("   Re-run to retry the failures — logged questions are skipped.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
