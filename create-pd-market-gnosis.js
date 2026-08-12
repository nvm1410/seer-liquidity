// Create the v2 Gnosis "Probability of Default" market — a multi-categorical
// Seer market over 33 DeFi assets + "No To All" ("Invalid result" is appended by
// the factory).
//
// Seer markets are immutable, so widening the asset list from 24 to 33 means a
// brand-new market. Nothing in this repo created a market before (v1 was made
// through the Seer web UI), so the factory ABI is hand-written below — the same
// approach add-pd-liquidity-gnosis.js takes for the Algebra position manager.
//
// Every parameter replicates the v1 market
// (0x7d386b7c41b8dab6179fc79cf7986a795305b815) except the outcome list: same
// question text, same category/lang, same 10 xDAI min bond, and an openingTime
// of "now" (v1's opening_ts was its own creation timestamp).
//
// Run with DRY_RUN = true first: it staticCalls the factory to learn the market
// address, estimates gas, and prints the Reality question exactly as it will be
// encoded on-chain, without sending anything.

import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import { MarketViewAbi } from "./abis/MarketViewAbi.js";

// ── Config ──────────────────────────────────────────────────────────────────
// Re-running live would create a SECOND market — this script is not idempotent.
const DRY_RUN = true; // ← set to false to send the transaction

const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.GNOSIS_RPC_URL;

const ASSETS_JSON = "./assets_pd_v2.json"; // written by fetch-credora-pd.js
const OUT_FILE = "./create-pd-market-execution.json";

// Addresses (Gnosis, chain 100)
const MARKET_FACTORY = "0x83183DA839Ce8228E31Ae41222EaD9EDBb5cDcf1";
const MARKET_VIEW = "0x95493F3e3F151eD9ee9338a4Fc1f49c00890F59C";
const SDAI_ADDRESS = "0xaf204776c7245bf4147c2612bf6e5972ee483701";

// Market parameters — identical to v1 apart from `outcomes`.
const MARKET_NAME = "What is the Probability of Default (PD) for the following DeFi assets before 2027?";
const NO_TO_ALL = "No To All";
const CATEGORY = "misc";
const LANG = "en_US";
const MIN_BOND = 10n ** 19n; // 10 xDAI, matches v1
const TOKEN_SUFFIX = "PD";

// The wrapped ERC20 name/symbol is truncated to 31 bytes by the factory's
// toString31 — silently, so check rather than discover it on-chain.
const MAX_TOKEN_NAME_BYTES = 31;

// 35 outcome slots project to ~12.8M gas (measured: v1's 26 slots cost 9.70M,
// the 11-slot market 4.54M ⇒ ~344k/slot + 759k fixed) against a 17.0M Gnosis
// block limit. Too close to leave to the estimator's default margin.
// Only 5% padding: estimateGas simulates this exact call, and at ~13M gas a 20%
// pad would ask for 92% of a whole block, which validators may not fill.
const GAS_LIMIT_MULTIPLIER_PCT = 105n;
const GNOSIS_BLOCK_GAS_LIMIT = 17_000_000n;
// Gnosis base fee sits in the hundreds of wei, so the balance check would be
// meaningless at live prices — floor it at something a fee spike could plausibly
// reach.
const MIN_GAS_PRICE_FOR_CHECK = 2_000_000_000n; // 2 gwei

// ── Factory ABI (from src/MarketFactory.sol) ────────────────────────────────
const MarketFactoryAbi = [
  "function createMultiCategoricalMarket((string marketName,string[] outcomes,string questionStart,string questionEnd,string outcomeType,uint256 parentOutcome,address parentMarket,string category,string lang,uint256 lowerBound,uint256 upperBound,uint256 minBond,uint32 openingTime,string[] tokenNames) params) external returns (address)",
  "event NewMarket(address indexed market, string marketName, address parentMarket, bytes32 conditionId, bytes32 questionId, bytes32[] questionsIds)",
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

// ── Helpers ─────────────────────────────────────────────────────────────────
function normalizeName(s) {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

// Wrapped-ERC20 naming convention, reverse-engineered from v1's deployed tokens:
// uppercase, "+" spelled out, everything non-alphanumeric dropped, "PD" suffix.
//   ETH+ → ETHPLUSPD   GACLO-1 → GACLO1PD   mF-ONE → MFONEPD   No To All → NOTOALLPD
function toTokenName(outcome) {
  return outcome.replace(/\+/g, "PLUS").toUpperCase().replace(/[^A-Z0-9]/g, "") + TOKEN_SUFFIX;
}

// Mirrors MarketFactory.encodeRealityQuestionWithOutcomes (src/MarketFactory.sol:329).
function encodeRealityQuestion(question, outcomes, category, lang) {
  const SEP = "␟";
  const encodedOutcomes = outcomes.map((o) => `"${o}"`).join(",");
  return `${question}${SEP}${encodedOutcomes}${SEP}${category}${SEP}${lang}`;
}

function readOutcomes() {
  const snapshot = JSON.parse(fs.readFileSync(ASSETS_JSON, "utf8"));
  const assets = snapshot.assets.map((a) => a.name);
  if (!assets.length) throw new Error(`${ASSETS_JSON} has no assets.`);
  return { snapshot, assets, outcomes: [...assets, NO_TO_ALL] };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n📋 Wallet   : ${wallet.address}`);
  console.log(`📋 DRY_RUN  : ${DRY_RUN}`);

  const { snapshot, assets, outcomes } = readOutcomes();
  const tokenNames = outcomes.map(toTokenName);
  const openingTime = Math.floor(Date.now() / 1000);

  console.log(`\n🔍 PD snapshot: ${assets.length} assets, fetched ${snapshot.fetchedAt}`);
  console.log(`   Outcomes: ${outcomes.length} (+ "Invalid result" appended by the factory = ${outcomes.length + 1} slots)`);

  // ── Guards ────────────────────────────────────────────────────────────────
  // A duplicate outcome would produce two identical Reality answers and two
  // wrapped tokens with the same name — unrecoverable once created.
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
    const bytes = Buffer.byteLength(t, "utf8");
    if (bytes > MAX_TOKEN_NAME_BYTES) {
      throw new Error(`Token name "${t}" is ${bytes} bytes — toString31 would truncate it.`);
    }
    if (seenToken.has(t)) throw new Error(`Duplicate token name "${t}" (from "${outcomes[i]}")`);
    seenToken.add(t);
  }
  console.log(`   ✅ ${outcomes.length} unique outcomes, ${tokenNames.length} unique token names, all ≤ ${MAX_TOKEN_NAME_BYTES} bytes`);

  console.log("\n   #   outcome      token name");
  outcomes.forEach((o, i) => console.log(`   ${String(i).padStart(2)}  ${o.padEnd(11)}  ${tokenNames[i]}`));

  const encodedQuestion = encodeRealityQuestion(MARKET_NAME, outcomes, CATEGORY, LANG);
  console.log(`\n📝 Reality question (␟-separated, as the factory will encode it):\n   ${encodedQuestion}`);

  const params = {
    marketName: MARKET_NAME,
    outcomes,
    questionStart: "", // multi-scalar only
    questionEnd: "", // multi-scalar only
    outcomeType: "", // multi-scalar only
    parentOutcome: 0n,
    parentMarket: ethers.ZeroAddress,
    category: CATEGORY,
    lang: LANG,
    lowerBound: 0n, // scalar only
    upperBound: 0n, // scalar only
    minBond: MIN_BOND,
    openingTime,
    tokenNames,
  };

  console.log(
    `\n⚙️  minBond=${ethers.formatUnits(MIN_BOND, 18)} xDAI | ` +
      `openingTime=${openingTime} (${new Date(openingTime * 1000).toISOString()}) | ` +
      `category=${CATEGORY} | lang=${LANG}`
  );

  const factory = new ethers.Contract(MARKET_FACTORY, MarketFactoryAbi, wallet);
  const args = [
    [
      params.marketName,
      params.outcomes,
      params.questionStart,
      params.questionEnd,
      params.outcomeType,
      params.parentOutcome,
      params.parentMarket,
      params.category,
      params.lang,
      params.lowerBound,
      params.upperBound,
      params.minBond,
      params.openingTime,
      params.tokenNames,
    ],
  ];

  // ── Simulate ──────────────────────────────────────────────────────────────
  console.log("\n🧪 Simulating createMultiCategoricalMarket ...");
  const predictedMarket = await factory.createMultiCategoricalMarket.staticCall(...args);
  const gasEstimate = await factory.createMultiCategoricalMarket.estimateGas(...args);
  console.log(`   Predicted market : ${predictedMarket}`);
  console.log(`   Gas estimate     : ${gasEstimate.toString()} (block limit ${GNOSIS_BLOCK_GAS_LIMIT})`);

  const gasLimit = (gasEstimate * GAS_LIMIT_MULTIPLIER_PCT) / 100n;
  if (gasLimit >= GNOSIS_BLOCK_GAS_LIMIT) {
    throw new Error(
      `Padded gas limit ${gasLimit} exceeds the Gnosis block gas limit — the market cannot be created in one transaction.`
    );
  }
  console.log(`   Gas limit to send: ${gasLimit.toString()} (${((Number(gasLimit) / Number(GNOSIS_BLOCK_GAS_LIMIT)) * 100).toFixed(1)}% of a block)`);

  const xdai = await provider.getBalance(wallet.address);
  const feeData = await provider.getFeeData();
  const liveGasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  const gasPrice = liveGasPrice > MIN_GAS_PRICE_FOR_CHECK ? liveGasPrice : MIN_GAS_PRICE_FOR_CHECK;
  const maxCost = gasLimit * gasPrice;
  console.log(
    `   xDAI balance     : ${ethers.formatUnits(xdai, 18)} | ` +
      `max tx cost ≈ ${ethers.formatUnits(maxCost, 18)} at ${ethers.formatUnits(gasPrice, 9)} gwei ` +
      `(live ${ethers.formatUnits(liveGasPrice, 9)} gwei)`
  );
  if (xdai < maxCost) throw new Error("Insufficient xDAI for gas — aborting.");

  if (DRY_RUN) {
    console.log("\n✅ Dry run complete — set DRY_RUN = false to create the market.");
    return;
  }

  // ── Send ──────────────────────────────────────────────────────────────────
  console.log("\n🚀 Creating market...");
  const tx = await factory.createMultiCategoricalMarket(...args, { gasLimit });
  console.log(`   Tx sent: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`   Confirmed in block ${receipt.blockNumber}, gas used ${receipt.gasUsed.toString()}`);

  // The return value isn't available from a receipt — take the address from the
  // NewMarket event the factory emits.
  const iface = new ethers.Interface(MarketFactoryAbi);
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
  if (!event) throw new Error("NewMarket event not found in receipt — cannot determine the market address.");

  const market = event.args.market;
  console.log(`   Market address: ${market}`);
  if (market.toLowerCase() !== predictedMarket.toLowerCase()) {
    console.warn(`   ⚠️  differs from the simulated address ${predictedMarket} (another market was created in between)`);
  }

  // ── Verify ────────────────────────────────────────────────────────────────
  console.log("\n🔍 Verifying via MarketView...");
  const marketView = new ethers.Contract(MARKET_VIEW, MarketViewAbi, provider);
  const info = await marketView.getMarket(MARKET_FACTORY, market);

  const onChainOutcomes = [...info.outcomes];
  const expected = [...outcomes, "Invalid result"];
  if (onChainOutcomes.length !== expected.length) {
    throw new Error(`Outcome count ${onChainOutcomes.length} ≠ expected ${expected.length}.`);
  }
  for (let i = 0; i < expected.length; i++) {
    if (normalizeName(onChainOutcomes[i]) !== normalizeName(expected[i])) {
      throw new Error(`Outcome ${i}: on-chain "${onChainOutcomes[i]}" ≠ expected "${expected[i]}".`);
    }
  }
  if (info.collateralToken.toLowerCase() !== SDAI_ADDRESS.toLowerCase()) {
    throw new Error(`Collateral ${info.collateralToken} ≠ sDAI ${SDAI_ADDRESS}.`);
  }
  if (info.parentCollectionId !== ethers.ZeroHash) {
    throw new Error("Market is conditional — expected a top-level market.");
  }
  if (info.wrappedTokens.length !== expected.length) {
    throw new Error(`wrappedTokens ${info.wrappedTokens.length} ≠ outcomes ${expected.length}.`);
  }
  console.log(`   ✅ ${expected.length} outcomes, tail ["${onChainOutcomes.at(-2)}", "${onChainOutcomes.at(-1)}"], sDAI collateral, top-level`);

  fs.writeFileSync(
    OUT_FILE,
    JSON.stringify(
      {
        market,
        chainId: 100,
        marketName: MARKET_NAME,
        conditionId: event.args.conditionId,
        questionId: event.args.questionId,
        questionsIds: [...event.args.questionsIds],
        openingTime,
        minBond: MIN_BOND.toString(),
        category: CATEGORY,
        lang: LANG,
        encodedQuestion,
        outcomes: onChainOutcomes,
        wrappedTokens: [...info.wrappedTokens],
        tokenNames,
        pdSnapshot: { file: ASSETS_JSON, fetchedAt: snapshot.fetchedAt, assetCount: snapshot.assetCount },
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        createdAt: new Date().toISOString(),
      },
      null,
      2
    )
  );

  console.log(`\n🎉 Market created: ${market}`);
  console.log(`   Written to ${OUT_FILE}`);
  console.log(`   https://app.seer.pm/markets/100/${market}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
