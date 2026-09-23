// Create one single-select categorical Seer market per Zcash NU7 coinholder-poll
// question, on Optimism (chain 10, sUSDS collateral).
//
// Each question becomes its own market whose outcomes are that question's ballot
// options. The factory appends "Invalid result" as a final slot, so a 4-option
// question has 5 outcome slots and 5 wrapped ERC20s.
//
// Why single-select categorical and not 20 binaries or a multi-scalar market: the
// options within one question are mutually exclusive AND exhaustive, so exactly
// one wins and price == P(that option). The argument against folding many
// questions into one market applies to INDEPENDENT grant approvals, not here.
// createMultiCategoricalMarket would be wrong (multi-select payout rule) and
// createMultiScalarMarket would price vote share, not P(win).
//
// This script ONLY creates markets. Seeding is add-zcash-nu7-liquidity.js.
//
// MARKET NAMES ARE IMMUTABLE. The dry run prints every one, and that output IS
// the review step — v2 of this set was thrown away entirely because the
// resolution rules had been appended to every name, pushing each past 300 chars.
// Hence needsGate: --live is refused unless the manifest records an approval.
//
// Creation is NOT idempotent: a second live run creates a SECOND market for any
// question not already logged. The progress file is therefore the markets log
// itself, and the harness refuses to reuse a non-empty one without --resume.
//
//   node create-zcash-nu7-markets.js            # dry: validates, simulates, prices gas
//   node create-zcash-nu7-markets.js --live     # refused unless the manifest is gated

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
const TOKEN_PREFIX = "ZNU7V3";

// Pinned to a fixed past instant rather than Date.now(), so a resumed run derives
// the same question ids for the markets it still has to create. Answerable
// immediately: Reality places no constraint on a past opening_ts at ask time.
const OPENING_TIME_ISO = "2026-09-09T00:00:00Z";

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

const outcomeLabels = (q) => q.outcomes.map((o) => o.label);
// tokenNames covers only the NAMED outcomes; the factory names the last slot
// SER-INVALID itself and short-circuits before reading tokenNames[invalidIndex],
// so it must NOT be padded.
const tokenNamesFor = (q) => q.outcomes.map((o) => `${TOKEN_PREFIX}${q.shortName}${o.tag}`);

function buildParams(q, openingTime, minBond) {
  return [
    q.marketName,
    outcomeLabels(q),
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
    tokenNamesFor(q),
  ];
}

/** Everything checkable before a transaction exists. */
function validate(doc, ctx) {
  const errors = [];
  const seenId = new Set();
  const seenShort = new Set();
  const seenToken = new Set();
  const seenQuestion = new Set();
  const seenQuestionId = new Map();

  for (const q of doc.questions) {
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

    // Prices are the seed prices for the liquidity run. A categorical market's
    // outcome prices must sum to 1 — anything else is arbitrage on day one.
    let priceSum = 0;
    const seenLabel = new Set();
    const seenTag = new Set();
    for (const o of q.outcomes) {
      if (!(o.price > 0 && o.price < 1)) {
        errors.push(`${tag}: outcome "${o.label}" price ${o.price} must be strictly between 0 and 1.`);
      }
      priceSum += o.price;
      if (!o.tag || !/^[A-Z0-9]+$/.test(o.tag)) errors.push(`${tag}: outcome tag "${o.tag}" must be uppercase alphanumeric.`);
      if (seenTag.has(o.tag)) errors.push(`${tag}: duplicate outcome tag "${o.tag}".`);
      seenTag.add(o.tag);

      const key = normalizeName(o.label ?? "");
      if (!key) errors.push(`${tag}: outcome with tag "${o.tag}" has an empty label.`);
      if (seenLabel.has(key)) errors.push(`${tag}: duplicate outcome label "${o.label}".`);
      seenLabel.add(key);
      if (key === "invalid result") errors.push(`${tag}: "Invalid result" must not be listed — the factory appends it.`);
      checkQuestionText(`${tag}: outcome label`, o.label ?? "", errors);
    }
    if (Math.abs(priceSum - 1) > 1e-9) {
      errors.push(`${tag}: outcome prices sum to ${priceSum.toFixed(10)}, expected 1.`);
    }

    const marketName = q.marketName;
    if (!marketName) errors.push(`${tag}: marketName is required.`);
    checkQuestionText(`${tag}: market name`, marketName ?? "", errors);
    const qKey = normalizeName(marketName ?? "");
    if (seenQuestion.has(qKey)) errors.push(`${tag}: duplicate market name — would collide on Reality.`);
    seenQuestion.add(qKey);

    for (const tn of tokenNamesFor(q)) {
      checkTokenName(tn, errors);
      if (seenToken.has(tn)) errors.push(`${tag}: duplicate token name "${tn}".`);
      seenToken.add(tn);
    }

    // Reality question id, computed exactly as the factory will.
    const encodedQuestion = encodeQuestionWithOutcomes(marketName ?? "", outcomeLabels(q), CATEGORY, LANG);
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

await run(
  {
    name: "create-zcash-nu7-markets",
    slug: "zcash-nu7",
    stage: "phase1-create",
    mutating: true,
    needsGate: true, // market names are immutable
    progress: (m) => m.files.markets, // the resume log IS the markets log
  },
  async (ctx) => {
    const { manifest, provider, wallet, chainId, addr, log, progress, dry } = ctx;
    const spec = manifest.markets[0];
    const minBond = ethers.parseEther(spec.minBondEth);

    log.log(`\nWallet   : ${wallet.address}`);
    log.log(`Chain    : Optimism (${chainId})`);

    const factory = new ethers.Contract(addr.marketFactory, MarketFactoryAbi, wallet);
    const [arbitrator, realitioAddr, questionTimeout, factoryCollateral] = await Promise.all([
      factory.arbitrator(),
      factory.realitio(),
      factory.questionTimeout(),
      factory.collateralToken(),
    ]);
    const openingTime = Math.floor(new Date(OPENING_TIME_ISO).getTime() / 1000);

    log.log(`\narbitrator      : ${arbitrator}`);
    log.log(`realitio        : ${realitioAddr}`);
    log.log(`questionTimeout : ${questionTimeout}s (${(Number(questionTimeout) / 86400).toFixed(1)} days)`);
    log.log(`minBond         : ${ethers.formatEther(minBond)} ETH`);
    log.log(`openingTime     : ${openingTime} (${OPENING_TIME_ISO})`);
    log.log(`category/lang   : ${CATEGORY} / ${LANG}`);
    if (openingTime < Math.floor(Date.now() / 1000)) {
      log.log("   openingTime is in the past — questions are answerable immediately, by design.");
    }
    if (factoryCollateral.toLowerCase() !== manifest.chain.collateral.address.toLowerCase()) {
      throw new Error(`factory collateral ${factoryCollateral} != manifest ${manifest.chain.collateral.address}`);
    }

    // ── Load + validate ───────────────────────────────────────────────────────
    const doc = JSON.parse(fs.readFileSync(manifest.files.seed, "utf8"));
    log.log(`\nBallot snapshot : ${doc.questions.length} questions, ${doc.snapshotOf}`);
    log.log(`Source          : ${doc.source}`);

    const idCtx = {
      templateId: TEMPLATE.CATEGORICAL,
      openingTime,
      arbitrator,
      questionTimeout: Number(questionTimeout),
      minBond,
      realitio: realitioAddr,
      factory: addr.marketFactory,
    };
    // The two hazards that killed v1 and v2 of this set: a ballot that was still
    // being edited, and names nobody read before they became immutable.
    if (!doc.ballotFrozenAt) {
      log.warn(
        "\n   WARNING: ballotFrozenAt is null — the poll wording is NOT confirmed final.\n" +
          "      Seer markets are immutable: a question reworded or dropped before the poll\n" +
          "      runs resolves Invalid, and Invalid is deliberately unpooled. Read every\n" +
          "      market name and outcome label below before going live."
      );
    }
    if (!doc.pollUrl) {
      log.warn("   WARNING: pollUrl is null — no resolution source is recorded for these questions.");
    }

    const errors = validate(doc, idCtx);
    if (errors.length) {
      log.error(`\n${errors.length} validation error(s):`);
      errors.forEach((e) => log.error(`   - ${e}`));
      throw new Error("validation failed — nothing was sent.");
    }
    const totalOutcomes = doc.questions.reduce((a, q) => a + q.outcomes.length, 0);
    log.log(
      `\n   OK: ${doc.questions.length} questions / ${totalOutcomes} outcomes valid — unique ids, ` +
        "shortNames, token names and Reality questions; every price set sums to 1"
    );

    log.log("\nMarkets to create:\n");
    for (const q of doc.questions) {
      const names = tokenNamesFor(q);
      log.log(`  [${q.id}] ${q.shortName} — ${q.topic}`);
      log.log(`      "${q.marketName}"`);
      q.outcomes.forEach((o, i) => {
        log.log(`        ${String(i).padStart(2)}. ${o.price.toFixed(2)}  ${names[i].padEnd(18)} ${o.label}`);
      });
      log.log(
        `        ${String(q.outcomes.length).padStart(2)}.  --   ${"SER-INVALID".padEnd(18)} ` +
          "Invalid result (appended by the factory, gets no pool)"
      );
      log.log("");
    }

    // ── Reality collision check against live state ────────────────────────────
    log.log("Checking Reality for pre-existing question ids...");
    const realitio = new ethers.Contract(realitioAddr, RealitioAbi, provider);
    const existing = [];
    for (const q of doc.questions) {
      if (Number(await realitio.getTimeout(q._questionId)) !== 0) existing.push(q);
    }
    if (existing.length) {
      log.warn(`   WARNING: ${existing.length} question(s) already exist on Reality:`);
      existing.forEach((q) => log.warn(`      id ${q.id} ${q.shortName} -> ${q._questionId}`));
      log.warn(
        "      The factory reuses an existing question rather than asking a new one\n" +
          "      (MarketFactory.askRealityQuestion:391). That is expected only if you are\n" +
          "      resuming a partially-completed run for exactly these questions."
      );
    } else {
      log.log(`   OK: no collisions — all ${doc.questions.length} questions are new`);
    }
    // Within the batch, a collision is never acceptable.
    await assertNoQuestionCollision(
      doc.questions.map((q) => ({ label: `id ${q.id} ${q.shortName}`, questionId: q._questionId })),
      { log: { log: () => {} } }
    );

    // Match on the log's own `id` field, NOT progress.has(): this log predates the
    // kind/key convention, so keying on those would make an existing creation log
    // look EMPTY and create every market a second time. Creation is not idempotent.
    const alreadyDone = new Set(progress.entries.map((e) => e.id));
    const todo = doc.questions.filter((q) => !alreadyDone.has(q.id));
    if (alreadyDone.size) {
      log.log(`\n${alreadyDone.size} question(s) already in ${manifest.files.markets} — skipping them.`);
    }
    if (!todo.length) {
      log.log("\nEvery question already has a market. Nothing to do.");
      return { created: 0 };
    }

    // ── Simulate ──────────────────────────────────────────────────────────────
    log.log(`\nSimulating createCategoricalMarket for ${todo.length} market(s)...\n`);
    log.log("    #  shortName  slots  first token           gas");
    let totalGas = 0n;
    for (const q of todo) {
      const gas = await factory.createCategoricalMarket.estimateGas(buildParams(q, openingTime, minBond));
      q._gas = gas;
      totalGas += gas;
      log.log(
        `   ${String(q.id).padStart(2)}  ${q.shortName.padEnd(9)} ` +
          `${String(q.outcomes.length + 1).padStart(5)}  ` +
          `${tokenNamesFor(q)[0].padEnd(20)} ${gas.toString().padStart(9)}`
      );
    }

    // Clones use CREATE, so the predicted address depends on the factory nonce
    // and shifts as markets are created. Simulate one only as a liveness check.
    const predicted = await factory.createCategoricalMarket.staticCall(buildParams(todo[0], openingTime, minBond));
    log.log(`\n   staticCall OK (first market would land at ${predicted} at the current nonce)`);

    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;
    log.log(
      `   total gas ${totalGas} @ ${ethers.formatUnits(gasPrice, "gwei")} gwei ` +
        `= ${ethers.formatEther(totalGas * gasPrice)} ETH (L2 execution only)`
    );
    log.log(`\n   first encoded question:`);
    log.log(`   ${todo[0]._encodedQuestion}`);

    if (dry) return { toCreate: todo.length, totalGas: totalGas.toString() };

    // ── Send ──────────────────────────────────────────────────────────────────
    log.log(`\nCreating ${todo.length} markets...\n`);
    const iface = new ethers.Interface(MarketFactoryAbi);
    const marketView = makeMarketView(addr.marketView, provider);
    let successCount = 0;

    for (const q of todo) {
      log.log(`\n--- [${q.id}] ${q.shortName}: ${q.topic} ---`);
      try {
        const gasLimit = (q._gas * GAS_LIMIT_MULTIPLIER_PCT) / 100n;
        const receipt = await retryTransaction(
          () => factory.createCategoricalMarket(buildParams(q, openingTime, minBond), { gasLimit }),
          { log, logGas: true }
        );

        // The return value is not available from a receipt — read the address off
        // the NewMarket event.
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

        // Record the address BEFORE verifying. The market already exists on chain
        // here; if a transient MarketView failure threw out of this block the
        // address would be lost and the next run would create a DUPLICATE market.
        const stored = progress.append({
          kind: "market",
          key: q.id,
          id: q.id,
          shortName: q.shortName,
          topic: q.topic,
          market: event.args.market,
          chainId,
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
          minBond: minBond.toString(),
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed.toString(),
          createdAt: new Date().toISOString(),
          verified: false,
        });
        log.log(`  ${event.args.market} saved to ${progress.path}`);

        const info = await getMarketInfo(marketView, addr.marketFactory, event.args.market);
        const expected = [...outcomeLabels(q), "Invalid result"];
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
        log.log(`  verified — ${info.outcomes.length} outcomes, ${info.wrappedTokens.length} wrapped tokens`);
        log.log(`     https://app.seer.pm/markets/${chainId}/${event.args.market}`);
      } catch (err) {
        log.error(`  FAILED [${q.id}] ${q.shortName}: ${err.shortMessage || err.message}`);
      }
      await sleep(DELAY_MS);
    }

    log.log(`\nDone. ${successCount}/${todo.length} markets created. See ${progress.path}.`);
    return { created: successCount };
  }
);
