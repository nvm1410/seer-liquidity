// Initial liquidity for the v2 Gnosis PD market (33 assets + "No To All"), using
// Swapr (Algebra V1 concentrated-liquidity pools) instead of Uniswap V3.
//
// Market: created by create-pd-market-gnosis.js — address read from
// create-pd-market-execution.json.
//
// Initial prices are derived from assets_pd_v2.csv (yearly PD per asset, pulled
// from Credora's Metrics.psl by fetch-credora-pd.js):
//   1. yearly PD -> quarterly PD, assuming a constant quarterly hazard rate:
//        qPD = 1 - (1 - yearlyPD) ^ (1/4)
//   2. quarterly PDs -> initial pool prices via the multi-categorical pricing
//      model in useImpliedProbs.ts (ported forward-only in implied-prices.js):
//        priceY  = prod(1 - qPD_i)              -> "No To All"
//        price_i = qPD_i * E[1 / (1 + k)]        -> each asset outcome
//
// This is add-pd-liquidity-gnosis.js with one substantive change: "No To All" no
// longer gets the same outcome-token quantity Q as the asset pools. In v1 that
// put 4.27 of the 5 sDAI budget into that single pool, because matching a given
// outcome quantity at a price near 1 needs an enormous sDAI side. Here it gets a
// fixed sDAI allocation instead and its outcome amount falls out — see
// sizePositionBySdai() and the two-regime budget solve in Phase 1. The v2 asset
// set makes this worse, not better: the new high-PD assets pull priceY down to
// ~0.815 while the cheapest asset sits at ~0.000084, a 9700x ratio.

import { Percent, Token } from "@uniswap/sdk-core";
import { Pool, Position, TickMath } from "@uniswap/v3-sdk";
import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import { erc20Abi, formatUnits } from "viem";
import { MarketViewAbi } from "./abis/MarketViewAbi.js";
import { RouterAbi } from "./abis/RouterAbi.js";
import { computePrices, yearlyToQuarterly } from "./implied-prices.js";

// ── Config ──────────────────────────────────────────────────────────────────
const DRY_RUN = true; // ← set to false to send transactions

const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.GNOSIS_RPC_URL;
const CHAIN_ID = 100; // Gnosis

const MARKET_FILE = "./create-pd-market-execution.json";
const CSV_FILE = "./assets_pd_v2.csv";
const PROGRESS_FILE = "./add-pd-gnosis-v2-execution.json";

// Addresses (Gnosis, chain 100)
const SWAPR_NPM_ADDRESS = "0x91fd594c46d8b01e62dbdebed2401dde01817834"; // Algebra NonfungiblePositionManager
const GNOSIS_ROUTER_ADDRESS = "0xeC9048b59b3467415b1a38F63416407eA0c70fB8"; // Seer GnosisRouter (split/merge)
const SDAI_ADDRESS = "0xaf204776c7245bf4147c2612bf6e5972ee483701";
const MARKET_FACTORY = "0x83183DA839Ce8228E31Ae41222EaD9EDBb5cDcf1";
const MARKET_VIEW = "0x95493F3e3F151eD9ee9338a4Fc1f49c00890F59C";

// Swapr's Algebra pools have a single dynamic fee (no fee tiers) and a fixed
// tickSpacing of 60. @uniswap/v3-sdk needs *some* fee to derive a tickSpacing
// for its tick-alignment math; FeeAmount.MEDIUM (3000) maps to tickSpacing 60,
// which matches Algebra exactly. This fee is never sent on-chain.
const MATH_FEE_TIER = 3000;
const TICK_SPACING = 60;

// Total capital to deploy: the single split (mint of every outcome token) +
// the sDAI side of every pool must sum to this.
const TOTAL_BUDGET = 5n * 10n ** 18n; // 5 sDAI
// Fixed sDAI allocation for the "No To All" pool, decoupled from the asset
// pools' equal-Q sizing (see header).
const NO_TO_ALL_SDAI = 5n * 10n ** 17n; // 0.5 sDAI = 10% of budget
// "Safe" preset band around each outcome's own center price (frontend
// web/src/lib/liquidity.ts PRESETS.Safe).
const SAFE_DOWN = 0.2; // -20%
const SAFE_UP = 0.4; // +40%
// Trial outcome-token quantity per pool used to size the (linear) budget.
const Q0 = 10n ** 17n; // 0.1 outcome token

// ── Algebra NonfungiblePositionManager ABI (verified on-chain via Sourcify) ──
const AlgebraPositionManagerAbi = [
  "function createAndInitializePoolIfNecessary(address token0, address token1, uint160 sqrtPriceX96) external payable",
  "function mint((address token0,address token1,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) external payable",
  "function multicall(bytes[] data) external payable returns (bytes[] results)",
];

// ── Provider / wallet ───────────────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);
const algebraIface = new ethers.Interface(AlgebraPositionManagerAbi);

const LN_1_0001 = Math.log(1.0001);

// ── Helpers ─────────────────────────────────────────────────────────────────
function sortTokens(a, b) {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

function priceToTick(price) {
  return Math.floor(Math.log(price) / LN_1_0001);
}

function clampTickToSpacing(tick, roundUp) {
  let t = roundUp ? Math.ceil(tick / TICK_SPACING) * TICK_SPACING : Math.floor(tick / TICK_SPACING) * TICK_SPACING;
  if (t < TickMath.MIN_TICK) t = Math.ceil(TickMath.MIN_TICK / TICK_SPACING) * TICK_SPACING;
  if (t > TickMath.MAX_TICK) t = Math.floor(TickMath.MAX_TICK / TICK_SPACING) * TICK_SPACING;
  return t;
}

async function retryTransaction(txFn, retries = 3, delayMs = 3000) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`  Attempt ${attempt}/${retries}...`);
      const tx = await txFn();
      console.log(`  Tx sent: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`  Confirmed in block ${receipt.blockNumber}`);
      return receipt;
    } catch (err) {
      lastError = err;
      console.warn(`  Attempt ${attempt} failed: ${err.message}`);
      if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

async function getTokenBalance(tokenAddress) {
  const token = new ethers.Contract(tokenAddress, erc20Abi, provider);
  return await token.balanceOf(wallet.address);
}

async function ensureAllowance(tokenAddress, spender, amount) {
  const ro = new ethers.Contract(tokenAddress, erc20Abi, provider);
  const current = await ro.allowance(wallet.address, spender);
  if (current >= amount) {
    console.log(`  ⏭  allowance already sufficient for ${tokenAddress}`);
    return;
  }
  const token = new ethers.Contract(tokenAddress, erc20Abi, wallet);
  console.log(`  Approving ${tokenAddress} → ${spender} for ${formatUnits(amount, 18)} ...`);
  await retryTransaction(() => token.approve(spender, amount));
  await new Promise((r) => setTimeout(r, 2000));
}

async function getMarketInfo(marketAddress) {
  const marketView = new ethers.Contract(MARKET_VIEW, MarketViewAbi, provider);
  const result = await marketView.getMarket(MARKET_FACTORY, marketAddress);
  return {
    id: result.id,
    name: result.marketName,
    collateralToken: result.collateralToken,
    outcomes: result.outcomes,
    wrappedTokens: result.wrappedTokens,
    parentCollectionId: result.parentCollectionId,
    templateId: result.templateId,
  };
}

function normalizeName(s) {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

// Parse assets_pd_v2.csv (Asset,PD) -> Map<normalizedName, { name, yearlyPD }>.
function parsePdCsv(path) {
  const lines = fs
    .readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  lines.shift(); // drop header
  const map = new Map();
  for (const line of lines) {
    const idx = line.lastIndexOf(",");
    const name = line.slice(0, idx);
    const yearlyPD = Number(line.slice(idx + 1));
    if (!Number.isFinite(yearlyPD)) throw new Error(`Bad CSV row: ${line}`);
    map.set(normalizeName(name), { name, yearlyPD });
  }
  return map;
}

// Build a Pool at the outcome's own center price, and its own Safe-preset tick
// bounds — both vary per outcome.
function buildPoolAndBounds(outcomeToken, centerPrice) {
  const [t0, t1] = sortTokens(outcomeToken, SDAI_ADDRESS);
  const isToken0Outcome = t0.toLowerCase() === outcomeToken.toLowerCase();
  // Pool price is token1/token0. token1/token0 = sDAI/outcome (= centerPrice)
  // when outcome is token0, else outcome/sDAI (= 1/centerPrice).
  const orientedPrice = isToken0Outcome ? centerPrice : 1 / centerPrice;
  const tickCurrent = priceToTick(orientedPrice);
  const sqrtPriceX96 = TickMath.getSqrtRatioAtTick(tickCurrent);

  const token0 = new Token(CHAIN_ID, t0, 18, "T0");
  const token1 = new Token(CHAIN_ID, t1, 18, "T1");
  const pool = new Pool(token0, token1, MATH_FEE_TIER, sqrtPriceX96.toString(), "0", tickCurrent);

  // Safe preset band, in sDAI-per-outcome (probability) terms, clamped to (0,1).
  const minPrice = Math.max(1e-9, centerPrice * (1 - SAFE_DOWN));
  const maxPrice = Math.min(0.999999, centerPrice * (1 + SAFE_UP));

  let tickLower, tickUpper;
  if (isToken0Outcome) {
    tickLower = clampTickToSpacing(priceToTick(minPrice), false);
    tickUpper = clampTickToSpacing(priceToTick(maxPrice), true);
  } else {
    tickLower = clampTickToSpacing(priceToTick(1 / maxPrice), false);
    tickUpper = clampTickToSpacing(priceToTick(1 / minPrice), true);
  }
  if (tickLower >= tickUpper) throw new Error(`Invalid tick range for ${outcomeToken} (${tickLower}, ${tickUpper})`);

  return { pool, token0, token1, isToken0Outcome, tickLower, tickUpper, tickCurrent, sqrtPriceX96, minPrice, maxPrice };
}

function positionAmounts(meta, position) {
  const a0 = BigInt(position.mintAmounts.amount0.toString());
  const a1 = BigInt(position.mintAmounts.amount1.toString());
  return {
    position,
    outcomeUsed: meta.isToken0Outcome ? a0 : a1,
    sdaiUsed: meta.isToken0Outcome ? a1 : a0,
    amount0: a0,
    amount1: a1,
  };
}

// For a given outcome-token quantity, return the Position plus the outcome/sDAI
// amounts it actually consumes (outcome is forced to be the binding side).
function sizePosition(meta, qOutcome) {
  const HUGE = (qOutcome + 1n) * 1000n; // ensure outcome token binds, not sDAI
  const amount0 = meta.isToken0Outcome ? qOutcome.toString() : HUGE.toString();
  const amount1 = meta.isToken0Outcome ? HUGE.toString() : qOutcome.toString();
  return positionAmounts(
    meta,
    Position.fromAmounts({ pool: meta.pool, tickLower: meta.tickLower, tickUpper: meta.tickUpper, amount0, amount1, useFullPrecision: true })
  );
}

// The mirror of sizePosition: the sDAI side is the binding constraint and the
// outcome-token amount falls out. Used only for "No To All", whose price sits so
// close to 1 that equal-Q sizing would swallow most of the budget.
function sizePositionBySdai(meta, sdaiAmount) {
  const HUGE = (sdaiAmount + 1n) * 1000n; // ensure sDAI binds, not the outcome token
  const amount0 = meta.isToken0Outcome ? HUGE.toString() : sdaiAmount.toString();
  const amount1 = meta.isToken0Outcome ? sdaiAmount.toString() : HUGE.toString();
  return positionAmounts(
    meta,
    Position.fromAmounts({ pool: meta.pool, tickLower: meta.tickLower, tickUpper: meta.tickUpper, amount0, amount1, useFullPrecision: true })
  );
}

// Encode createAndInitializePoolIfNecessary + mint as one multicall payload.
function buildMintCalldata(p) {
  const createCalldata = algebraIface.encodeFunctionData("createAndInitializePoolIfNecessary", [
    p.meta.token0.address,
    p.meta.token1.address,
    p.meta.sqrtPriceX96.toString(),
  ]);

  const { amount0: amount0Min, amount1: amount1Min } = p.position.mintAmountsWithSlippage(
    new Percent(50, 10_000) // 0.5%
  );

  const mintCalldata = algebraIface.encodeFunctionData("mint", [
    [
      p.meta.token0.address,
      p.meta.token1.address,
      p.meta.tickLower,
      p.meta.tickUpper,
      p.amount0.toString(),
      p.amount1.toString(),
      amount0Min.toString(),
      amount1Min.toString(),
      wallet.address,
      Math.floor(Date.now() / 1000) + 60 * 20,
    ],
  ]);

  return algebraIface.encodeFunctionData("multicall", [[createCalldata, mintCalldata]]);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const MARKET = JSON.parse(fs.readFileSync(MARKET_FILE, "utf8")).market;

  console.log(`\n📋 Wallet      : ${wallet.address}`);
  console.log(`📋 Market      : ${MARKET}`);
  console.log(`📋 DRY_RUN     : ${DRY_RUN}`);
  console.log(`📋 Budget      : ${formatUnits(TOTAL_BUDGET, 18)} sDAI (No To All capped at ${formatUnits(NO_TO_ALL_SDAI, 18)})`);
  console.log(`📋 Band        : Safe (-${SAFE_DOWN * 100}% / +${SAFE_UP * 100}%) per outcome\n`);

  // ── Phase 0: resolve market + prices ────────────────────────────────────────
  console.log("🔍 Phase 0: resolving market & prices...");
  const info = await getMarketInfo(MARKET);

  if (info.parentCollectionId !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
    throw new Error("Market is conditional — expected a top-level market.");
  }
  if (info.collateralToken.toLowerCase() !== SDAI_ADDRESS.toLowerCase()) {
    throw new Error(`Collateral ${info.collateralToken} ≠ sDAI ${SDAI_ADDRESS}.`);
  }
  console.log(`   Market "${info.name}" | ${info.outcomes.length} outcomes | templateId=${info.templateId}`);

  const last = info.outcomes[info.outcomes.length - 1];
  const secondLast = info.outcomes[info.outcomes.length - 2];
  if (normalizeName(last) !== "invalid result") {
    throw new Error(`Expected last outcome to be "Invalid result", got "${last}".`);
  }
  if (normalizeName(secondLast) !== "no to all") {
    throw new Error(`Expected second-to-last outcome to be "No To All", got "${secondLast}".`);
  }

  // Asset outcomes are everything except "No To All" and "Invalid result".
  const assetNames = info.outcomes.slice(0, -2);
  const assetTokens = info.wrappedTokens.slice(0, -2);
  const noToAllToken = info.wrappedTokens[info.wrappedTokens.length - 2];

  const pdMap = parsePdCsv(CSV_FILE);
  console.log(`   CSV: ${pdMap.size} rows`);
  if (pdMap.size !== assetNames.length) {
    throw new Error(`CSV rows (${pdMap.size}) ≠ market asset outcomes (${assetNames.length}).`);
  }

  // Match each on-chain asset outcome to a CSV row by normalized name, in
  // ON-CHAIN order (the probability array must line up index-for-index with
  // assetTokens so prices map back to the right outcome).
  const unmatched = [];
  const quarterlyPDs = [];
  for (const name of assetNames) {
    const row = pdMap.get(normalizeName(name));
    if (!row) {
      unmatched.push(name);
      continue;
    }
    quarterlyPDs.push(yearlyToQuarterly(row.yearlyPD));
  }
  if (unmatched.length) {
    console.error("\n❌ Unmatched on-chain outcomes (fix CSV names):");
    unmatched.forEach((n) => console.error(`   - "${n}"`));
    throw new Error(`${unmatched.length} outcomes unmatched.`);
  }

  const { priceY, prices } = computePrices(quarterlyPDs);
  const priceSum = prices.reduce((a, b) => a + b, 0) + priceY;
  console.log(`   priceY ("No To All") = ${priceY.toFixed(6)} | Σ all prices = ${priceSum.toFixed(8)}`);

  const assetPools = assetTokens.map((outcomeToken, i) => ({
    name: assetNames[i],
    outcomeToken,
    price: prices[i],
    isNoToAll: false,
  }));
  const noToAllPool = { name: "No To All", outcomeToken: noToAllToken, price: priceY, isNoToAll: true };
  const pools = [...assetPools, noToAllPool];

  // ── Phase 0b: verify wrapped outcome ERC20s are deployed ────────────────────
  for (const p of pools) {
    const code = await provider.getCode(p.outcomeToken);
    if (!code || code === "0x") {
      throw new Error(`Outcome token ${p.outcomeToken} (${p.name}) has no code — not deployed.`);
    }
  }
  console.log("   ✅ all outcome tokens deployed on-chain");

  // ── Phase 1: size positions & solve for Q ───────────────────────────────────
  console.log("\n📐 Phase 1: sizing positions...");
  for (const p of pools) p.meta = buildPoolAndBounds(p.outcomeToken, p.price);

  // "No To All" is sized first and independently — its cost is fixed, so the
  // asset pools get whatever the budget has left.
  const noToAllSized = sizePositionBySdai(noToAllPool.meta, NO_TO_ALL_SDAI);
  console.log(
    `   No To All: ${formatUnits(noToAllSized.sdaiUsed, 18)} sDAI ⇒ ` +
      `${formatUnits(noToAllSized.outcomeUsed, 18)} outcome tokens (price ${priceY.toFixed(6)})`
  );

  let trialSdaiAssets = 0n;
  for (const p of assetPools) trialSdaiAssets += sizePosition(p.meta, Q0).sdaiUsed;

  // The split mints `splitAmount` of *every* outcome token for exactly
  // `splitAmount` sDAI, so it is driven by whichever pool wants the most outcome
  // tokens — either an asset pool (at Q) or No To All (fixed). Solve for the
  // scale factor under both regimes and take the tighter one, so the grand total
  // respects the budget either way.
  //   regime A (split = Q):        f*(Q0 + trialSdaiAssets) + NO_TO_ALL_SDAI          <= BUDGET
  //   regime B (split = noToAll):  f*trialSdaiAssets + NO_TO_ALL_SDAI + noToAllQty    <= BUDGET
  const assetBudget = TOTAL_BUDGET - NO_TO_ALL_SDAI;
  if (assetBudget <= 0n) throw new Error("NO_TO_ALL_SDAI is >= the whole budget.");
  const qRegimeA = (Q0 * assetBudget) / (Q0 + trialSdaiAssets);
  const remainderB = assetBudget - noToAllSized.outcomeUsed;
  const qRegimeB = remainderB > 0n ? (Q0 * remainderB) / trialSdaiAssets : 0n;
  const Q = qRegimeA < qRegimeB ? qRegimeA : qRegimeB;
  if (Q <= 0n) throw new Error("No budget left for the asset pools — lower NO_TO_ALL_SDAI.");
  console.log(
    `   Trial Q0=${formatUnits(Q0, 18)} → ΣsDAI(assets)=${formatUnits(trialSdaiAssets, 18)} ⇒ ` +
      `Q=${formatUnits(Q, 18)} (regime A ${formatUnits(qRegimeA, 18)}, B ${formatUnits(qRegimeB, 18)})`
  );

  let sumSdai = 0n;
  let maxOutcome = 0n;
  console.log("\n   outcome                          price       ticks              outcome        sDAI");
  for (const p of pools) {
    const s = p.isNoToAll ? noToAllSized : sizePosition(p.meta, Q);
    p.position = s.position;
    p.outcomeUsed = s.outcomeUsed;
    p.sdaiUsed = s.sdaiUsed;
    p.amount0 = s.amount0;
    p.amount1 = s.amount1;
    sumSdai += s.sdaiUsed;
    if (s.outcomeUsed > maxOutcome) maxOutcome = s.outcomeUsed;
    console.log(
      `   ${p.name.slice(0, 30).padEnd(30)} ${p.price.toFixed(6).padStart(9)}  ` +
        `[${p.meta.tickLower},${p.meta.tickUpper}]`.padEnd(18) +
        `  ${Number(formatUnits(s.outcomeUsed, 18)).toFixed(6).padStart(12)}` +
        `  ${Number(formatUnits(s.sdaiUsed, 18)).toFixed(6).padStart(10)}`
    );
  }
  const splitAmount = maxOutcome > Q ? maxOutcome : Q;
  const grandTotal = splitAmount + sumSdai;
  const noToAllShare = (Number(noToAllSized.sdaiUsed) / Number(grandTotal)) * 100;
  console.log(
    `\n   Split (mint) : ${formatUnits(splitAmount, 18)} sDAI\n` +
      `   sDAI side    : ${formatUnits(sumSdai, 18)} sDAI\n` +
      `   GRAND TOTAL  : ${formatUnits(grandTotal, 18)} sDAI (budget ${formatUnits(TOTAL_BUDGET, 18)})\n` +
      `   No To All    : ${noToAllShare.toFixed(1)}% of total (v1's equal-Q sizing was 85%)`
  );
  if (grandTotal > TOTAL_BUDGET) {
    console.warn("   ⚠️  grand total exceeds budget — check rounding/sentinel.");
  }

  if (DRY_RUN) {
    console.log("\n✅ Dry run complete — set DRY_RUN = false to execute.");
    return;
  }

  // ── Phase 2a: balance guard + split sDAI once ───────────────────────────────
  const sdaiBalance = await getTokenBalance(SDAI_ADDRESS);
  console.log(`\n💰 sDAI balance: ${formatUnits(sdaiBalance, 18)} | need: ${formatUnits(grandTotal, 18)}`);
  if (sdaiBalance < grandTotal) {
    throw new Error("Insufficient sDAI balance — aborting.");
  }

  const router = new ethers.Contract(GNOSIS_ROUTER_ADDRESS, RouterAbi, wallet);
  const ct = await router.conditionalTokens();
  if (!ct || ct === ethers.ZeroAddress) {
    throw new Error("Router.conditionalTokens() is zero — wrong Router?");
  }
  console.log(`   Router.conditionalTokens() = ${ct}`);

  let progressLog = [];
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      progressLog = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
    } catch {
      progressLog = [];
    }
  }
  const alreadyDone = new Set(progressLog.map((e) => e.outcomeToken.toLowerCase()));

  const needSplit = !alreadyDone.size; // fresh run → split; resume → assume done
  if (!needSplit) {
    console.log("\n⏭  Progress log present — assuming split already done.");
  }
  if (needSplit) {
    console.log(`\n💧 Phase 2a: split ${formatUnits(splitAmount, 18)} sDAI on market`);
    await ensureAllowance(SDAI_ADDRESS, GNOSIS_ROUTER_ADDRESS, splitAmount);
    await retryTransaction(() => router.splitPosition(SDAI_ADDRESS, MARKET, splitAmount));
    await new Promise((r) => setTimeout(r, 3000));
  }

  // sDAI is a token in every pool — approve the full sDAI side once.
  await ensureAllowance(SDAI_ADDRESS, SWAPR_NPM_ADDRESS, sumSdai);

  // ── Phase 2b: create + initialize + mint each pool ──────────────────────────
  console.log(`\n📈 Phase 2b: minting ${pools.length} positions\n`);
  let successCount = 0;
  for (const p of pools) {
    if (alreadyDone.has(p.outcomeToken.toLowerCase())) {
      console.log(`  ⏭  ${p.name}: already in progress log — skipping`);
      successCount++;
      continue;
    }

    console.log(`\n--- ${p.name} (${p.outcomeToken}) ---`);
    const outcomeAmount = p.meta.isToken0Outcome ? p.amount0 : p.amount1;
    await ensureAllowance(p.outcomeToken, SWAPR_NPM_ADDRESS, outcomeAmount);

    try {
      const data = buildMintCalldata(p);
      const receipt = await retryTransaction(() => wallet.sendTransaction({ to: SWAPR_NPM_ADDRESS, data, value: 0n }));

      progressLog.push({
        name: p.name,
        outcomeToken: p.outcomeToken,
        price: p.price,
        tickLower: p.meta.tickLower,
        tickUpper: p.meta.tickUpper,
        amount0: p.amount0.toString(),
        amount1: p.amount1.toString(),
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      });
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progressLog, null, 2));
      successCount++;
      console.log(`  ✅ Saved to ${PROGRESS_FILE}`);
    } catch (err) {
      console.error(`  ❌ Failed for ${p.name}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log(`\n🎉 Done! ${successCount}/${pools.length} positions minted. See ${PROGRESS_FILE}.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
