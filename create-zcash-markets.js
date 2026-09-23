// Create one binary categorical Seer market per Zcash Q3 2026 CDRGP proposal,
// on Optimism (chain 10, sUSDS collateral).
//
// Each proposal becomes its own market with outcomes [Yes, No]; the factory
// appends "Invalid result" as a third slot, so every market has 3 wrapped ERC20s.
//
// Why 37 binaries and not one 37-outcome market: grant approvals are INDEPENDENT
// and non-exclusive — roughly 20 of 37 pass at once — so a multi-categorical
// market pays 1/k to each of k winners and a certain proposal would trade near
// 0.05. Price would read as "share of winners", not P(approved).
//
// This script ONLY creates markets. Seeding is add-zcash-liquidity.js.
//
// MARKET NAMES ARE IMMUTABLE, so the dry run prints every one and that output IS
// the review step. Hence needsGate: --live is refused unless the manifest records
// an approval.
//
// Creation is NOT idempotent: a second live run creates a SECOND market for any
// proposal not already logged. The progress file is therefore the markets log
// itself, and the harness refuses to reuse a non-empty one without --resume.
//
//   node create-zcash-markets.js          # dry: validates, simulates, prices gas
//   node create-zcash-markets.js --live   # refused unless the manifest is gated

import { ethers } from "ethers";
import fs from "fs";
import { getMarketInfo, makeMarketView, normalizeName } from "./lib/market.js";
import {
  TEMPLATE,
  assertNoQuestionCollision,
  checkQuestionText,
  checkTokenName,
  computeQuestionId,
  encodeQuestionWithOutcomes,
} from "./lib/reality.js";
import { run } from "./lib/run.js";
import { retryTransaction, sleep } from "./lib/tx.js";

const CATEGORY = "misc";
const LANG = "en_US";
const OUTCOMES = ["Yes", "No"];
const TOKEN_PREFIX = "ZQ3";

// Pinned to a fixed past instant so a resumed run derives the same question ids.
const OPENING_TIME_ISO = "2026-08-19T00:00:00Z";

const DELAY_MS = 3000;
const GAS_LIMIT_MULTIPLIER_PCT = 120n;

const MarketFactoryAbi = [
  "function createCategoricalMarket((string marketName,string[] outcomes,string questionStart,string questionEnd,string outcomeType,uint256 parentOutcome,address parentMarket,string category,string lang,uint256 lowerBound,uint256 upperBound,uint256 minBond,uint32 openingTime,string[] tokenNames) params) external returns (address)",
  "function arbitrator() view returns (address)",
  "function realitio() view returns (address)",
  "function questionTimeout() view returns (uint32)",
  "function collateralToken() view returns (address)",
  "event NewMarket(address indexed market, string marketName, address parentMarket, bytes32 conditionId, bytes32 questionId, bytes32[] questionsIds)",
];
const RealitioAbi = ["function getTimeout(bytes32 question_id) view returns (uint32)"];

// Seer's published pilot template, verbatim — do not add the applicant or the
// word "Zcash".
const buildMarketName = (p) =>
  `Will ${p.title} be approved in the Q3 2026 Coinholder-Directed Retroactive Grants poll?`;

// tokenNames covers only the NAMED outcomes; the factory names slot 2
// SER-INVALID itself and must not be given one.
const tokenNamesFor = (p) => [`${TOKEN_PREFIX}${p.shortName}YES`, `${TOKEN_PREFIX}${p.shortName}NO`];

function buildParams(p, openingTime, minBond) {
  return [
    p._marketName,
    OUTCOMES,
    "", // questionStart  — multi-scalar only
    "", // questionEnd    — multi-scalar only
    "", // outcomeType    — multi-scalar only
    0n, // parentOutcome  — top-level
    ethers.ZeroAddress, // parentMarket — top-level
    CATEGORY,
    LANG,
    0n, // lowerBound — scalar only
    0n, // upperBound — scalar only
    minBond,
    openingTime,
    tokenNamesFor(p),
  ];
}

function validate(doc, ctx) {
  const proposals = doc.proposals;
  const errors = [];

  // A stale ballot snapshot is the failure mode that matters most here: markets
  // are immutable and a withdrawn proposal resolves Invalid.
  const sum = proposals.reduce((a, p) => a + p.requestedUsd, 0);
  if (doc.totalRequestedUsd != null && Math.abs(sum - doc.totalRequestedUsd) > 0.005) {
    errors.push(
      `requestedUsd sums to ${sum.toFixed(2)}, expected ${doc.totalRequestedUsd} — ballot snapshot may be stale.`
    );
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
    checkQuestionText(`${tag}: market name`, marketName, errors);
    const qKey = normalizeName(marketName);
    if (seenQuestion.has(qKey)) errors.push(`${tag}: duplicate market name — would collide on Reality.`);
    seenQuestion.add(qKey);

    for (const tn of tokenNamesFor(p)) {
      checkTokenName(tn, errors);
      if (seenToken.has(tn)) errors.push(`${tag}: duplicate token name "${tn}".`);
      seenToken.add(tn);
    }

    const encodedQuestion = encodeQuestionWithOutcomes(marketName, OUTCOMES, CATEGORY, LANG);
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

await run(
  {
    name: "create-zcash-markets",
    slug: "zcash-q3",
    stage: "phase1-create",
    mutating: true,
    needsGate: true, // market names are immutable
    progress: (m) => m.files.markets, // the resume log IS the markets log
  },
  async (ctx) => {
    const { manifest, provider, wallet, chainId, addr, log, progress, dry } = ctx;
    const spec = manifest.markets[0];
    const minBond = ethers.parseEther(spec.minBondEth);

    log.log(`\n📋 Wallet   : ${wallet.address}`);
    log.log(`📋 Chain    : Optimism (${chainId})`);

    const factory = new ethers.Contract(addr.marketFactory, MarketFactoryAbi, wallet);
    const [arbitrator, realitioAddr, questionTimeout, factoryCollateral] = await Promise.all([
      factory.arbitrator(),
      factory.realitio(),
      factory.questionTimeout(),
      factory.collateralToken(),
    ]);
    const openingTime = Math.floor(new Date(OPENING_TIME_ISO).getTime() / 1000);

    log.log(`\n⚙️  arbitrator      : ${arbitrator}`);
    log.log(`⚙️  realitio        : ${realitioAddr}`);
    log.log(`⚙️  questionTimeout : ${questionTimeout}s (${(Number(questionTimeout) / 86400).toFixed(1)} days)`);
    log.log(`⚙️  minBond         : ${ethers.formatEther(minBond)} ETH`);
    log.log(`⚙️  openingTime     : ${openingTime} (${OPENING_TIME_ISO})`);
    log.log(`⚙️  category/lang   : ${CATEGORY} / ${LANG}`);
    if (openingTime < Math.floor(Date.now() / 1000)) {
      log.log("   ℹ️  openingTime is in the past — questions are answerable immediately, by design.");
    }
    if (factoryCollateral.toLowerCase() !== manifest.chain.collateral.address.toLowerCase()) {
      throw new Error(`factory collateral ${factoryCollateral} != manifest ${manifest.chain.collateral.address}`);
    }

    const doc = JSON.parse(fs.readFileSync(manifest.files.seed, "utf8"));
    log.log(`\n🔍 Ballot snapshot: ${doc.proposals.length} proposals, ${doc.snapshotOf}`);
    if (!doc.ballotFrozenAt) {
      log.warn(
        "   ⚠️  ballotFrozenAt is null — this is the REVIEW-PERIOD list. Proposals can still\n" +
          "      be withdrawn until the review period closes, and Seer markets are immutable.\n" +
          "      Set ballotFrozenAt in the JSON once the ballot is final before running live."
      );
    }

    const idCtx = {
      templateId: TEMPLATE.CATEGORICAL,
      openingTime,
      arbitrator,
      questionTimeout: Number(questionTimeout),
      minBond,
      realitio: realitioAddr,
      factory: addr.marketFactory,
    };
    const errors = validate(doc, idCtx);
    if (errors.length) {
      log.error(`\n❌ ${errors.length} validation error(s):`);
      errors.forEach((e) => log.error(`   - ${e}`));
      throw new Error("Validation failed — nothing sent.");
    }
    log.log(`   ✅ ${doc.proposals.length} proposals valid: unique ids, shortNames, token names, questions`);

    // ── Reality collision check against live state ────────────────────────────
    log.log("\n🔍 Checking Reality for pre-existing question ids...");
    const realitio = new ethers.Contract(realitioAddr, RealitioAbi, provider);
    const existing = [];
    for (const p of doc.proposals) {
      if (Number(await realitio.getTimeout(p._questionId)) !== 0) existing.push(p);
    }
    if (existing.length) {
      log.warn(`   ⚠️  ${existing.length} question(s) already exist on Reality:`);
      existing.forEach((p) => log.warn(`      id ${p.id} ${p.shortName} → ${p._questionId}`));
      log.warn(
        "      The factory reuses an existing question rather than asking a new one\n" +
          "      (MarketFactory.askRealityQuestion:391). That is expected only if you are\n" +
          "      resuming a partially-completed run for exactly these proposals."
      );
    } else {
      log.log(`   ✅ no collisions — all ${doc.proposals.length} questions are new`);
    }
    await assertNoQuestionCollision(
      doc.proposals.map((p) => ({ label: `id ${p.id} ${p.shortName}`, questionId: p._questionId })),
      { log: { log: () => {} } }
    );

    // Match on the log's own `id` field, NOT progress.has(): this log predates the
    // kind/key convention, so keying on those would make an existing creation log
    // look EMPTY and create every market a second time.
    const alreadyDone = new Set(progress.entries.map((e) => e.id));
    const todo = doc.proposals.filter((p) => !alreadyDone.has(p.id));
    if (alreadyDone.size) {
      log.log(`\n⏭  ${alreadyDone.size} proposal(s) already in ${manifest.files.markets} — skipping them.`);
    }
    if (!todo.length) {
      log.log("\n✅ Every proposal already has a market. Nothing to do.");
      return { created: 0 };
    }

    // ── Simulate ──────────────────────────────────────────────────────────────
    log.log(`\n🧪 Simulating createCategoricalMarket for ${todo.length} market(s)...\n`);
    log.log("    #  shortName        requested    YES token             gas");
    let totalGas = 0n;
    for (const p of todo) {
      const gas = await factory.createCategoricalMarket.estimateGas(buildParams(p, openingTime, minBond));
      p._gas = gas;
      totalGas += gas;
      log.log(
        `   ${String(p.id).padStart(2)}  ${p.shortName.padEnd(15)} ` +
          `${("$" + p.requestedUsd.toLocaleString()).padStart(11)}  ` +
          `${tokenNamesFor(p)[0].padEnd(20)} ${gas.toString().padStart(9)}`
      );
    }

    // Clones use CREATE, so the predicted address depends on the factory nonce
    // and shifts as markets are created. Simulate one only as a liveness check.
    const predicted = await factory.createCategoricalMarket.staticCall(buildParams(todo[0], openingTime, minBond));
    log.log(`\n   staticCall OK (first market would land at ${predicted} at the current nonce)`);

    const feeData = await provider.getFeeData();
    const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
    const l2Cost = totalGas * gasPrice;
    const balance = await provider.getBalance(wallet.address);
    log.log(
      `\n   Total L2 gas : ${totalGas} over ${todo.length} tx (avg ${totalGas / BigInt(todo.length)})\n` +
        `   Gas price    : ${ethers.formatUnits(gasPrice, 9)} gwei\n` +
        `   L2 gas cost  : ~${ethers.formatEther(l2Cost)} ETH (EXCLUDES the Optimism L1 data fee)\n` +
        `   ETH balance  : ${ethers.formatEther(balance)} ETH`
    );
    if (balance < l2Cost) {
      log.warn("   ⚠️  balance below the L2 gas estimate alone — top up before running live.");
    }

    log.log("\n📝 Encoded Reality question for the first market, exactly as the factory will encode it:");
    log.log(`   ${todo[0]._encodedQuestion}`);

    if (dry) return { toCreate: todo.length, totalGas: totalGas.toString() };

    // ── Send ──────────────────────────────────────────────────────────────────
    log.log(`\n🚀 Creating ${todo.length} markets...\n`);
    const iface = new ethers.Interface(MarketFactoryAbi);
    const marketView = makeMarketView(addr.marketView, provider);
    let successCount = 0;

    for (const p of todo) {
      log.log(`\n--- [${p.id}] ${p.shortName}: ${p.title} ---`);
      try {
        const gasLimit = (p._gas * GAS_LIMIT_MULTIPLIER_PCT) / 100n;
        const receipt = await retryTransaction(
          () => factory.createCategoricalMarket(buildParams(p, openingTime, minBond), { gasLimit }),
          { log, logGas: true }
        );

        let event = null;
        for (const entry of receipt.logs) {
          if (entry.address.toLowerCase() !== addr.marketFactory.toLowerCase()) continue;
          try {
            const parsed = iface.parseLog(entry);
            if (parsed?.name === "NewMarket") {
              event = parsed;
              break;
            }
          } catch {
            // not a NewMarket log
          }
        }
        if (!event) throw new Error("NewMarket event not found in receipt.");

        // Record the address BEFORE verifying — see create-zcash-nu7-markets.js.
        const stored = progress.append({
          kind: "market",
          key: p.id,
          id: p.id,
          shortName: p.shortName,
          title: p.title,
          applicant: p.applicant,
          requestedUsd: p.requestedUsd,
          tier: p.tier,
          yesPrice: p.yesPrice,
          market: event.args.market,
          chainId,
          marketName: p._marketName,
          encodedQuestion: p._encodedQuestion,
          conditionId: event.args.conditionId,
          questionId: event.args.questionId,
          questionsIds: [...event.args.questionsIds],
          realityQuestionId: p._questionId,
          tokenNames: tokenNamesFor(p),
          openingTime,
          minBond: minBond.toString(),
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed.toString(),
          createdAt: new Date().toISOString(),
          verified: false,
        });
        log.log(`  💾 ${event.args.market} saved to ${progress.path}`);

        const info = await getMarketInfo(marketView, addr.marketFactory, event.args.market);
        const expected = [...OUTCOMES, "Invalid result"];
        if (info.outcomes.length !== expected.length) {
          throw new Error(`verify: ${info.outcomes.length} outcomes on chain, expected ${expected.length}`);
        }
        expected.forEach((want, i) => {
          if (normalizeName(info.outcomes[i]) !== normalizeName(want)) {
            throw new Error(`verify: outcome ${i} is "${info.outcomes[i]}", expected "${want}"`);
          }
        });
        stored.outcomes = info.outcomes;
        stored.wrappedTokens = info.wrappedTokens;
        stored.verified = true;
        progress.flush();

        successCount++;
        log.log(`  ✅ verified — YES ${info.wrappedTokens[0]} / NO ${info.wrappedTokens[1]}`);
        log.log(`     https://app.seer.pm/markets/${chainId}/${event.args.market}`);
      } catch (err) {
        log.error(`  ❌ FAILED [${p.id}] ${p.shortName}: ${err.shortMessage || err.message}`);
      }
      await sleep(DELAY_MS);
    }

    log.log(`\n🎉 Done! ${successCount}/${todo.length} markets created and verified. See ${progress.path}.`);
    return { created: successCount };
  }
);
