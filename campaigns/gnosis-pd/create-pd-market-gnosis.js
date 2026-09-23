// Create the Gnosis PD (Probability of Default) multi-categorical market: one
// outcome per Credora asset, plus "No To All", plus the factory's "Invalid result".
//
// Nothing in this repo created a market on Gnosis before v2 — v1 was made through
// the Seer web UI — so the wrapped-ERC20 naming convention here is reverse
// engineered from v1's deployed tokens.
//
// Gas is the real constraint: ~759k fixed + ~344k per outcome slot against a 17.0M
// Gnosis block limit, so 35 slots is ~12.8M. Padding is only 5%, because at ~13M
// gas a 20% pad would ask for 92% of a whole block and validators may not fill it.
// Above roughly 44 outcomes this stops fitting in one transaction at all.
//
//   node create-pd-market-gnosis.js          # dry: validates, simulates, prices gas
//   node create-pd-market-gnosis.js --live   # refused unless the manifest is gated
//
// Creation is NOT idempotent, so this now refuses to run when its output file
// already records a market (--force-new overrides), and checks Reality for a
// question-id collision the way the other three creators always did. Before, a
// second run created a duplicate market silently — and because openingTime is
// Date.now() the duplicate asked a DIFFERENT question, so it would not even
// collide visibly with the first.

import { ethers } from "ethers";
import fs from "fs";
import { getMarketInfo, makeMarketView, normalizeName } from "../../lib/market.js";
import { TEMPLATE, checkTokenName, computeQuestionId, encodeQuestionWithOutcomes } from "../../lib/reality.js";
import { run } from "../../lib/run.js";

const MARKET_NAME = "What is the Probability of Default (PD) for the following DeFi assets before 2027?";
const NO_TO_ALL = "No To All";
const CATEGORY = "misc";
const LANG = "en_US";
const TOKEN_SUFFIX = "PD";

const GAS_LIMIT_MULTIPLIER_PCT = 105n;
const GNOSIS_BLOCK_GAS_LIMIT = 17_000_000n;
// Gnosis base fee sits in the hundreds of wei, so a balance check at live prices
// would be meaningless — floor it at something a fee spike could plausibly reach.
const MIN_GAS_PRICE_FOR_CHECK = 2_000_000_000n; // 2 gwei

const MarketFactoryAbi = [
  "function createMultiCategoricalMarket((string marketName,string[] outcomes,string questionStart,string questionEnd,string outcomeType,uint256 parentOutcome,address parentMarket,string category,string lang,uint256 lowerBound,uint256 upperBound,uint256 minBond,uint32 openingTime,string[] tokenNames) params) external returns (address)",
  "function arbitrator() view returns (address)",
  "function realitio() view returns (address)",
  "function questionTimeout() view returns (uint32)",
  "event NewMarket(address indexed market, string marketName, address parentMarket, bytes32 conditionId, bytes32 questionId, bytes32[] questionsIds)",
];

// Reverse-engineered from v1's deployed tokens: uppercase, "+" spelled out,
// everything non-alphanumeric dropped, "PD" suffix.
//   ETH+ -> ETHPLUSPD   GACLO-1 -> GACLO1PD   mF-ONE -> MFONEPD   No To All -> NOTOALLPD
const toTokenName = (outcome) =>
  outcome.replace(/\+/g, "PLUS").toUpperCase().replace(/[^A-Z0-9]/g, "") + TOKEN_SUFFIX;

await run(
  {
    name: "create-pd-market-gnosis",
    slug: "gnosis-pd",
    stage: "phase1-create",
    mutating: true,
    needsGate: true, // the market name and 35 outcome labels are immutable
  },
  async (ctx) => {
    const { manifest, provider, wallet, chainId, addr, args, log, dry } = ctx;
    const spec = manifest.markets[0];
    const minBond = ethers.parseEther(spec.minBondEth);
    const outFile = manifest.files.markets;

    log.log(`\n📋 Wallet   : ${wallet.address}`);

    const snapshot = JSON.parse(fs.readFileSync(manifest.files.assets, "utf8"));
    const assets = snapshot.assets.map((a) => a.name);
    if (!assets.length) throw new Error(`${manifest.files.assets} has no assets.`);
    const outcomes = [...assets, NO_TO_ALL];
    const tokenNames = outcomes.map(toTokenName);
    const openingTime = Math.floor(Date.now() / 1000);

    log.log(`\n🔍 PD snapshot: ${assets.length} assets, fetched ${snapshot.fetchedAt}`);
    log.log(
      `   Outcomes: ${outcomes.length} (+ "Invalid result" appended by the factory = ${outcomes.length + 1} slots)`
    );

    // The factory must NOT be handed "Invalid result" — it appends that itself —
    // and tokenNames covers only the user outcomes.
    const seenOutcome = new Set();
    for (const o of outcomes) {
      if (!o.trim()) throw new Error("Empty outcome name.");
      const key = normalizeName(o);
      if (seenOutcome.has(key)) throw new Error(`Duplicate outcome: "${o}"`);
      seenOutcome.add(key);
    }
    const seenToken = new Set();
    for (let i = 0; i < tokenNames.length; i++) {
      const t = tokenNames[i];
      if (!t || t === TOKEN_SUFFIX) throw new Error(`Outcome "${outcomes[i]}" produced an empty token name.`);
      const errs = checkTokenName(t);
      if (errs.length) throw new Error(`${errs[0]} (from "${outcomes[i]}")`);
      if (seenToken.has(t)) throw new Error(`Duplicate token name "${t}" (from "${outcomes[i]}")`);
      seenToken.add(t);
    }
    log.log(`   ✅ ${outcomes.length} unique outcomes, ${tokenNames.length} unique token names, all ≤ 31 bytes`);

    log.log("\n   #   outcome      token name");
    outcomes.forEach((o, i) => log.log(`   ${String(i).padStart(2)}  ${o.padEnd(11)}  ${tokenNames[i]}`));

    const encodedQuestion = encodeQuestionWithOutcomes(MARKET_NAME, outcomes, CATEGORY, LANG);
    log.log(`\n📝 Reality question (␟-separated, as the factory will encode it):\n   ${encodedQuestion}`);

    // ── Idempotency guard ─────────────────────────────────────────────────────
    // This script is not idempotent and never was: a live run creates a market
    // whether or not one already exists. Nothing stopped a second run producing a
    // duplicate — and because openingTime is Date.now(), the duplicate would ask a
    // DIFFERENT Reality question rather than colliding visibly with the first.
    if (fs.existsSync(outFile)) {
      const prior = JSON.parse(fs.readFileSync(outFile, "utf8"));
      if (prior.market && !args.flags.has("--force-new")) {
        throw new Error(
          `${outFile} already records market ${prior.market} (created ${prior.createdAt}). ` +
            `Creating another would be a duplicate. Pass --force-new if a second market is genuinely wanted, ` +
            `and move the existing file aside first — this script overwrites it.`
        );
      }
    }

    // ── Reality collision check ───────────────────────────────────────────────
    // The other three creators do this; this one never did. The factory REUSES an
    // existing question with the same content hash rather than asking a new one,
    // which silently binds two markets to one question.
    const [arbitrator, realitioAddr, questionTimeout] = await Promise.all([
      factory.arbitrator(),
      factory.realitio(),
      factory.questionTimeout(),
    ]);
    const realitio = new ethers.Contract(
      realitioAddr,
      ["function getTimeout(bytes32 question_id) view returns (uint32)"],
      provider
    );
    const questionId = computeQuestionId({
      templateId: TEMPLATE.MULTI_CATEGORICAL, // 3 — createMultiCategoricalMarket
      openingTime,
      encodedQuestion,
      arbitrator,
      questionTimeout: Number(questionTimeout),
      minBond,
      realitio: realitioAddr,
      factory: addr.marketFactory,
    });
    log.log(`   questionId: ${questionId}`);
    if (Number(await realitio.getTimeout(questionId)) !== 0) {
      throw new Error(
        `Reality question ${questionId} already exists — the factory would REUSE it, binding this ` +
          `market to an existing question. Change the question text or openingTime.`
      );
    }
    log.log("   ✅ no Reality collision — this question is new");

    const createArgs = [
      [
        MARKET_NAME,
        outcomes,
        "", // questionStart — multi-scalar only
        "", // questionEnd   — multi-scalar only
        "", // outcomeType   — multi-scalar only
        0n, // parentOutcome — top-level
        ethers.ZeroAddress, // parentMarket — top-level
        CATEGORY,
        LANG,
        0n, // lowerBound — scalar only
        0n, // upperBound — scalar only
        minBond,
        openingTime,
        tokenNames,
      ],
    ];

    log.log(
      `\n⚙️  minBond=${ethers.formatUnits(minBond, 18)} xDAI | ` +
        `openingTime=${openingTime} (${new Date(openingTime * 1000).toISOString()}) | ` +
        `category=${CATEGORY} | lang=${LANG}`
    );

    // ── Simulate ──────────────────────────────────────────────────────────────
    log.log("\n🧪 Simulating createMultiCategoricalMarket ...");
    const predictedMarket = await factory.createMultiCategoricalMarket.staticCall(...createArgs);
    const gasEstimate = await factory.createMultiCategoricalMarket.estimateGas(...createArgs);
    log.log(`   Predicted market : ${predictedMarket}`);
    log.log(`   Gas estimate     : ${gasEstimate.toString()} (block limit ${GNOSIS_BLOCK_GAS_LIMIT})`);

    const gasLimit = (gasEstimate * GAS_LIMIT_MULTIPLIER_PCT) / 100n;
    if (gasLimit >= GNOSIS_BLOCK_GAS_LIMIT) {
      throw new Error(
        `Padded gas limit ${gasLimit} exceeds the Gnosis block gas limit — the market cannot be created in one transaction.`
      );
    }
    log.log(
      `   Gas limit to send: ${gasLimit.toString()} (${((Number(gasLimit) / Number(GNOSIS_BLOCK_GAS_LIMIT)) * 100).toFixed(1)}% of a block)`
    );

    const xdai = await provider.getBalance(wallet.address);
    const feeData = await provider.getFeeData();
    const liveGasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
    const gasPrice = liveGasPrice > MIN_GAS_PRICE_FOR_CHECK ? liveGasPrice : MIN_GAS_PRICE_FOR_CHECK;
    const maxCost = gasLimit * gasPrice;
    log.log(
      `   xDAI balance     : ${ethers.formatUnits(xdai, 18)} | ` +
        `max tx cost ≈ ${ethers.formatUnits(maxCost, 18)} at ${ethers.formatUnits(gasPrice, 9)} gwei ` +
        `(live ${ethers.formatUnits(liveGasPrice, 9)} gwei)`
    );
    if (xdai < maxCost) throw new Error("Insufficient xDAI for gas — aborting.");

    if (dry) return { outcomes: outcomes.length, gasEstimate: gasEstimate.toString(), predictedMarket };

    // ── Send ──────────────────────────────────────────────────────────────────
    log.log("\n🚀 Creating market...");
    const tx = await factory.createMultiCategoricalMarket(...createArgs, { gasLimit });
    log.log(`   Tx sent: ${tx.hash}`);
    const receipt = await tx.wait();
    log.log(`   Confirmed in block ${receipt.blockNumber}, gas used ${receipt.gasUsed.toString()}`);

    // The market address comes from the NewMarket event, not the return value.
    const iface = new ethers.Interface(MarketFactoryAbi);
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
    const market = event.args.market;
    log.log(`   Market address: ${market}`);
    if (market.toLowerCase() !== predictedMarket.toLowerCase()) {
      log.warn(`   ⚠️  differs from the simulated address ${predictedMarket} (another market was created in between)`);
    }

    log.log("\n🔍 Verifying via MarketView...");
    const marketView = makeMarketView(addr.marketView, provider);
    const info = await getMarketInfo(marketView, addr.marketFactory, market);
    const expected = [...outcomes, "Invalid result"];
    if (info.outcomes.length !== expected.length) {
      throw new Error(`verify: ${info.outcomes.length} outcomes on chain, expected ${expected.length}`);
    }
    expected.forEach((want, i) => {
      if (normalizeName(info.outcomes[i]) !== normalizeName(want)) {
        throw new Error(`verify: outcome ${i} is "${info.outcomes[i]}", expected "${want}"`);
      }
    });
    if (info.collateralToken.toLowerCase() !== manifest.chain.collateral.address.toLowerCase()) {
      throw new Error(`verify: collateral ${info.collateralToken} is not sDAI`);
    }
    if (info.isConditional) throw new Error("verify: market is conditional, expected top-level");
    log.log(
      `   ✅ ${expected.length} outcomes, tail ["${info.outcomes.at(-2)}", "${info.outcomes.at(-1)}"], sDAI collateral, top-level`
    );

    fs.writeFileSync(
      outFile,
      JSON.stringify(
        {
          market,
          chainId,
          marketName: MARKET_NAME,
          conditionId: event.args.conditionId,
          questionId: event.args.questionId,
          questionsIds: [...event.args.questionsIds],
          openingTime,
          minBond: minBond.toString(),
          category: CATEGORY,
          lang: LANG,
          encodedQuestion,
          outcomes: info.outcomes,
          wrappedTokens: info.wrappedTokens,
          tokenNames,
          pdSnapshot: snapshot,
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed.toString(),
          createdAt: new Date().toISOString(),
        },
        null,
        2
      ) + "\n"
    );

    log.log(`\n🎉 Market created: ${market}`);
    log.log(`   Written to ${outFile}`);
    log.log(`   https://app.seer.pm/markets/100/${market}`);
    return { market };
  }
);
