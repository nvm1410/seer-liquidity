// Create one binary categorical Seer market per Zcash Q3 2026 CDRGP proposal,
// on Optimism (chain 10, sUSDS collateral).
//
// Each proposal in zcash-q3-proposals.json becomes its own market with outcomes
// ["Yes", "No"] — the factory appends "Invalid result" as a third slot, so every
// market has 3 outcome slots and 3 wrapped ERC20s.
//
// Why 37 separate binary markets and not one 37-outcome market: the approvals are
// independent and non-exclusive (~55% base rate means ~20 approvals at once).
// A multi-categorical or multi-scalar market normalises payouts across winners
// (RealityProxy.sol:109-112 and :172-182), so a certain-to-approve outcome would
// price near 1/20, not near 1. Only a per-question binary makes price == P(approved).
//
// This script ONLY creates markets. Seeding pools is add-zcash-liquidity.js, which
// reads this script's execution log.
//
// Run with DRY_RUN = true first: it staticCalls the factory, estimates gas, checks
// for Reality question-id collisions, and prints every encoded question, without
// sending anything.

import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import { MarketViewAbi } from "./abis/MarketViewAbi.js";

// ── Config ──────────────────────────────────────────────────────────────────
// Re-running live creates ADDITIONAL markets for any proposal not already in the
// progress file. Proposals already logged are skipped, so a resumed run is safe.
const DRY_RUN = true; // ← set to false to send transactions

const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL; // Optimism
const CHAIN_ID = 10;

const PROPOSALS_FILE = "./zcash-q3-proposals.json";
const PROGRESS_FILE = "./create-zcash-markets-execution.json";

// Addresses (Optimism, chain 10) — same deployment the octant scripts use.
const MARKET_FACTORY = "0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6";
const MARKET_VIEW = "0x336695ec9efbafd6322fb82eaadbcda02e38f348";
const SUSDS_ADDRESS = "0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0";

// ── Market parameters ───────────────────────────────────────────────────────
const OUTCOMES = ["Yes", "No"];
const CATEGORY = "misc";
const LANG = "en_US";
const TOKEN_PREFIX = "ZQ3";

// Answerable immediately. Answering is gated operationally (see answer-octant-markets.js),
// not at the contract level — Reality places no constraint on a past opening_ts at ask
// time, stateOpen only requires opening_ts <= block.timestamp (RealityETH-3.0.sol:187).
// Pinned to a fixed past instant rather than Date.now() so a resumed run derives the
// same question ids for the markets it still has to create.
const OPENING_TIME_ISO = "2026-08-19T00:00:00Z";

// Reality min bond, in ETH on Optimism. The octant market uses 0.0005 ETH; across
// 37 markets that is a cheap griefing surface (one wrong answer per market costs
// the griefer ~$1.50 and costs us a correction bond each time), so default 10x.
const MIN_BOND = ethers.parseEther("0.005");

// The factory silently truncates ERC20 names past 31 bytes (MarketFactory.toString31),
// so check rather than discover it on-chain.
const MAX_TOKEN_NAME_BYTES = 31;

// Reality encodes questions as `title␟outcomes␟category␟lang` and interpolates the
// title into a JSON template — a raw quote, backslash or separator breaks parsing.
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

const RealitioAbi = [
  "function getTimeout(bytes32 question_id) view returns (uint32)",
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

// ── Helpers ─────────────────────────────────────────────────────────────────
function normalizeName(s) {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

// Mirrors MarketFactory.encodeRealityQuestionWithOutcomes (src/MarketFactory.sol:329).
function encodeRealityQuestion(question, outcomes, category, lang) {
  const SEP = "␟";
  const encodedOutcomes = outcomes.map((o) => `"${o}"`).join(",");
  return `${question}${SEP}${encodedOutcomes}${SEP}${category}${SEP}${lang}`;
}

// The question text traders and Reality answerers actually see. This is Seer's
// published pilot template verbatim — do not add the applicant or the word "Zcash".
function buildMarketName(p) {
  return `Will ${p.title} be approved in the Q3 2026 Coinholder-Directed Retroactive Grants poll?`;
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

function loadProposals() {
  const doc = JSON.parse(fs.readFileSync(PROPOSALS_FILE, "utf8"));
  if (!Array.isArray(doc.proposals) || !doc.proposals.length) {
    throw new Error(`${PROPOSALS_FILE} has no proposals.`);
  }
  return doc;
}

// Everything that must hold before a single transaction is sent. Markets are
// immutable, so a bad name or a duplicate question cannot be fixed afterwards —
// the only remedy is creating a replacement set, as the PD v1→v2 rebuild showed.
function validate(doc, ctx) {
  const proposals = doc.proposals;
  const errors = [];

  const sum = proposals.reduce((a, p) => a + p.requestedUsd, 0);
  if (doc.totalRequestedUsd != null && Math.abs(sum - doc.totalRequestedUsd) > 0.005) {
    errors.push(`requestedUsd sums to ${sum.toFixed(2)}, expected ${doc.totalRequestedUsd} — ballot snapshot may be stale.`);
  }

  const seenId = new Set();
  const seenShort = new Set();
  const seenToken = new Set();
  const seenQuestion = new Set();
  const seenQuestionId = new Map();

  for (const p of proposals) {
    const tag = `id ${p.id} (${p.shortName})`;

    if (seenId.has(p.id)) errors.push(`${tag}: duplicate id.`);
    seenId.add(p.id);

    if (!p.shortName || !/^[A-Z0-9]+$/.test(p.shortName)) {
      errors.push(`${tag}: shortName must be non-empty uppercase alphanumeric.`);
    }
    if (seenShort.has(p.shortName)) errors.push(`${tag}: duplicate shortName.`);
    seenShort.add(p.shortName);

    if (!(p.yesPrice > 0 && p.yesPrice < 1)) {
      errors.push(`${tag}: yesPrice ${p.yesPrice} must be strictly between 0 and 1.`);
    }
    if (!(p.requestedUsd > 0)) errors.push(`${tag}: requestedUsd must be positive.`);

    const marketName = buildMarketName(p);
    for (const c of FORBIDDEN_CHARS) {
      if (marketName.includes(c)) {
        errors.push(`${tag}: market name contains forbidden character ${JSON.stringify(c)}.`);
      }
    }
    const qKey = normalizeName(marketName);
    if (seenQuestion.has(qKey)) errors.push(`${tag}: duplicate market name — would collide on Reality.`);
    seenQuestion.add(qKey);

    for (const tn of tokenNamesFor(p)) {
      const bytes = Buffer.byteLength(tn, "utf8");
      if (bytes > MAX_TOKEN_NAME_BYTES) {
        errors.push(`${tag}: token name "${tn}" is ${bytes} bytes — toString31 would truncate it.`);
      }
      if (seenToken.has(tn)) errors.push(`${tag}: duplicate token name "${tn}".`);
      seenToken.add(tn);
    }

    // Reality question-id collision, computed exactly as the factory will.
    const encodedQuestion = encodeRealityQuestion(marketName, OUTCOMES, CATEGORY, LANG);
    const questionId = computeQuestionId({ ...ctx, encodedQuestion });
    if (seenQuestionId.has(questionId)) {
      errors.push(`${tag}: Reality questionId collides with id ${seenQuestionId.get(questionId)}.`);
    }
    seenQuestionId.set(questionId, p.id);
    p._marketName = marketName;
    p._encodedQuestion = encodedQuestion;
    p._questionId = questionId;
  }

  return errors;
}

function tokenNamesFor(p) {
  // tokenNames covers only the named outcomes; the factory names slot 2
  // "SER-INVALID" itself (MarketFactory.deployERC20Positions:428).
  return [`${TOKEN_PREFIX}${p.shortName}YES`, `${TOKEN_PREFIX}${p.shortName}NO`];
}

function buildParams(p, openingTime) {
  return [
    p._marketName,
    OUTCOMES,
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
    tokenNamesFor(p),
  ];
}

async function verifyMarket(marketAddress, p) {
  const marketView = new ethers.Contract(MARKET_VIEW, MarketViewAbi, provider);
  const info = await marketView.getMarket(MARKET_FACTORY, marketAddress);

  const expected = [...OUTCOMES, "Invalid result"];
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
  console.log(`\n📋 Wallet   : ${wallet.address}`);
  console.log(`📋 DRY_RUN  : ${DRY_RUN}`);
  console.log(`📋 Chain    : Optimism (${CHAIN_ID})`);

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

  console.log(`\n⚙️  arbitrator      : ${arbitrator}`);
  console.log(`⚙️  realitio        : ${realitioAddr}`);
  console.log(`⚙️  questionTimeout : ${questionTimeout}s (${(Number(questionTimeout) / 86400).toFixed(1)} days)`);
  console.log(`⚙️  minBond         : ${ethers.formatEther(MIN_BOND)} ETH`);
  console.log(`⚙️  openingTime     : ${openingTime} (${OPENING_TIME_ISO})`);
  console.log(`⚙️  category/lang   : ${CATEGORY} / ${LANG}`);

  if (openingTime < Math.floor(Date.now() / 1000)) {
    console.log("   ℹ️  openingTime is in the past — questions are answerable immediately, by design.");
  }

  // ── Load + validate ───────────────────────────────────────────────────────
  const doc = loadProposals();
  console.log(`\n🔍 Ballot snapshot: ${doc.proposals.length} proposals, ${doc.snapshotOf}`);
  if (!doc.ballotFrozenAt) {
    console.warn(
      "   ⚠️  ballotFrozenAt is null — this is the REVIEW-PERIOD list. Proposals can still\n" +
      "      be withdrawn until the review period closes, and Seer markets are immutable.\n" +
      "      Set ballotFrozenAt in the JSON once the ballot is final before running live."
    );
  }

  const errors = validate(doc, ctx);
  if (errors.length) {
    console.error(`\n❌ ${errors.length} validation error(s):`);
    errors.forEach((e) => console.error(`   - ${e}`));
    throw new Error("Validation failed — nothing sent.");
  }
  console.log(`   ✅ ${doc.proposals.length} proposals valid: unique ids, shortNames, token names, questions`);

  // ── Reality question-id collision check against live state ────────────────
  console.log("\n🔍 Checking Reality for pre-existing question ids...");
  const realitio = new ethers.Contract(realitioAddr, RealitioAbi, provider);
  const existing = [];
  for (const p of doc.proposals) {
    const timeout = await realitio.getTimeout(p._questionId);
    if (Number(timeout) !== 0) existing.push(p);
  }
  if (existing.length) {
    console.warn(`   ⚠️  ${existing.length} question(s) already exist on Reality:`);
    existing.forEach((p) => console.warn(`      id ${p.id} ${p.shortName} → ${p._questionId}`));
    console.warn(
      "      The factory reuses an existing question rather than asking a new one\n" +
      "      (MarketFactory.askRealityQuestion:391). That is expected only if you are\n" +
      "      resuming a partially-completed run for exactly these proposals."
    );
  } else {
    console.log("   ✅ no collisions — all 37 questions are new");
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
  const todo = doc.proposals.filter((p) => !alreadyDone.has(p.id));
  if (alreadyDone.size) {
    console.log(`\n⏭  ${alreadyDone.size} proposal(s) already in ${PROGRESS_FILE} — skipping them.`);
  }
  if (!todo.length) {
    console.log("\n✅ Every proposal already has a market. Nothing to do.");
    return;
  }

  // ── Simulate ──────────────────────────────────────────────────────────────
  console.log(`\n🧪 Simulating createCategoricalMarket for ${todo.length} market(s)...\n`);
  console.log("    #  shortName        requested    YES token             gas");
  let totalGas = 0n;
  for (const p of todo) {
    const args = [buildParams(p, openingTime)];
    const gas = await factory.createCategoricalMarket.estimateGas(...args);
    p._gas = gas;
    totalGas += gas;
    console.log(
      `   ${String(p.id).padStart(2)}  ${p.shortName.padEnd(15)} ` +
        `${("$" + p.requestedUsd.toLocaleString()).padStart(11)}  ` +
        `${tokenNamesFor(p)[0].padEnd(20)} ${gas.toString().padStart(9)}`
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
      `   ETH balance  : ${ethers.formatEther(balance)} ETH`
  );
  if (balance < l2Cost) {
    console.warn("   ⚠️  balance below the L2 gas estimate alone — top up before running live.");
  }

  console.log("\n📝 Encoded Reality question for the first market, exactly as the factory will encode it:");
  console.log(`   ${todo[0]._encodedQuestion}`);

  if (DRY_RUN) {
    console.log("\n✅ Dry run complete — set DRY_RUN = false to create the markets.");
    return;
  }

  // ── Send ──────────────────────────────────────────────────────────────────
  console.log(`\n🚀 Creating ${todo.length} markets...\n`);
  const iface = new ethers.Interface(MarketFactoryAbi);
  let successCount = 0;

  for (const p of todo) {
    console.log(`\n--- [${p.id}] ${p.shortName}: ${p.title} ---`);
    try {
      const args = [buildParams(p, openingTime)];
      const gasLimit = (p._gas * GAS_LIMIT_MULTIPLIER_PCT) / 100n;
      const receipt = await retryTransaction(() =>
        factory.createCategoricalMarket(...args, { gasLimit })
      );

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
      // be lost and the next run would create a DUPLICATE market for the same proposal.
      // The verified fields are merged into this same entry below.
      const entry = {
        id: p.id,
        shortName: p.shortName,
        title: p.title,
        applicant: p.applicant,
        requestedUsd: p.requestedUsd,
        tier: p.tier,
        yesPrice: p.yesPrice,
        market,
        chainId: CHAIN_ID,
        marketName: p._marketName,
        encodedQuestion: p._encodedQuestion,
        conditionId: event.args.conditionId,
        questionId: event.args.questionId,
        questionsIds: [...event.args.questionsIds],
        realityQuestionId: p._questionId,
        tokenNames: tokenNamesFor(p),
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
      console.log(`  💾 ${market} saved to ${PROGRESS_FILE}`);

      const verified = await verifyMarket(market, p);
      entry.outcomes = verified.outcomes;
      entry.wrappedTokens = verified.wrappedTokens;
      entry.verified = true;
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progressLog, null, 2));
      successCount++;
      console.log(`  ✅ verified — YES ${verified.wrappedTokens[0]} / NO ${verified.wrappedTokens[1]}`);
      console.log(`     https://app.seer.pm/markets/${CHAIN_ID}/${market}`);
    } catch (err) {
      console.error(`  ❌ Failed for ${p.shortName}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  console.log(`\n🎉 Done! ${successCount}/${todo.length} markets created and verified. See ${PROGRESS_FILE}.`);
  const unverified = progressLog.filter((e) => e.verified !== true);
  if (unverified.length) {
    console.warn("");
    console.warn(`   ⚠️  ${unverified.length} market(s) were created but NOT verified. They ARE logged,`);
    console.warn("      so a re-run skips them rather than creating duplicates. Check by hand:");
    unverified.forEach((e) => console.warn(`      [${e.id}] ${e.shortName} ${e.market}`));
  }
  if (successCount < todo.length) {
    console.log("   Re-run to retry the failures — logged proposals are skipped.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
