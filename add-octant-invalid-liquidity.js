import { Percent, Token } from "@uniswap/sdk-core";
import {
  NonfungiblePositionManager,
  Pool,
  Position,
  TickMath,
} from "@uniswap/v3-sdk";
import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import { erc20Abi, formatUnits } from "viem";
import { MarketViewAbi } from "./abis/MarketViewAbi.js";

// ── Config ──────────────────────────────────────────────────────────────────
const DRY_RUN = false; // ← set to false to send transactions

const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL;
const CHAIN_ID = 10;

// Octant — one-level multiscalar market on Optimism (no parent, no children).
// We add a pool for the Invalid outcome only — the named-outcome run
// (add-octant-liquidity.js) deliberately drops it, leaving the wallet holding
// idle Invalid tokens from the split. We deploy those for capital efficiency.
const OCTANT_MARKET = "0xE85aDa7CD6D33CB41Ac596FB4749e3F94d836EcE";
const PROGRESS_FILE = "./add-octant-invalid-execution.json";

// Addresses (Optimism, chain 10)
const POSITION_MANAGER_ADDRESS = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const SUSDS_ADDRESS = "0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0";
const MARKET_FACTORY = "0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6";
const MARKET_VIEW = "0x336695ec9efbafd6322fb82eaadbcda02e38f348";

// Uniswap V3 pool params used across this repo's Seer pools.
const FEE_TIER = 100;
const TICK_SPACING = 1;

// Invalid-specific pricing: very close to zero, tight concentration.
// Mirrors liquidity-l1.js (initialPrice 0.000011) for consistency across markets.
const INVALID_INIT_PRICE = 0.000011; // sUSDS per Invalid token
const MIN_PRICE = 0.00001; // tight band lower bound
const MAX_PRICE = 0.00005; // tight band upper bound
// Safety: abort if the sUSDS side of the position somehow exceeds this.
const MAX_SUSDS_GUARD = 50n * 10n ** 18n;

// ── Provider / wallet ───────────────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

const LN_1_0001 = Math.log(1.0001);

// ── Helpers (mirror add-octant-liquidity.js) ──────────────────────────────────
function sortTokens(a, b) {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

function priceToTick(price) {
  return Math.floor(Math.log(price) / LN_1_0001);
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
  console.log(
    `  Approving ${tokenAddress} → ${spender} for ${formatUnits(amount, 18)} ...`
  );
  await retryTransaction(() => token.approve(spender, amount));
  await new Promise((r) => setTimeout(r, 2000));
}

// Mirrors getMarketInfo() in add-octant-liquidity.js.
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
    questionsIds: result.questionsIds,
    templateId: result.templateId,
  };
}

// Build a Pool at a fresh (not-yet-deployed) price and the tight tick range for
// the Invalid outcome. Range is collateral(sUSDS)/outcome, in [MIN_PRICE, MAX_PRICE].
function buildPoolAndBounds(outcomeToken, price) {
  const [t0, t1] = sortTokens(outcomeToken, SUSDS_ADDRESS);
  const isToken0Outcome = t0.toLowerCase() === outcomeToken.toLowerCase();
  // Pool price is token1/token0. token1/token0 = sUSDS/outcome (= price) when
  // outcome is token0, else outcome/sUSDS (= 1/price).
  const orientedPrice = isToken0Outcome ? price : 1 / price;
  const tickCurrent = priceToTick(orientedPrice);
  const sqrtPriceX96 = TickMath.getSqrtRatioAtTick(tickCurrent);

  const token0 = new Token(CHAIN_ID, t0, 18, "T0");
  const token1 = new Token(CHAIN_ID, t1, 18, "T1");
  const pool = new Pool(
    token0,
    token1,
    FEE_TIER,
    sqrtPriceX96.toString(),
    "0",
    tickCurrent
  );

  let tickLower, tickUpper;
  if (isToken0Outcome) {
    tickLower = Math.floor(priceToTick(MIN_PRICE) / TICK_SPACING) * TICK_SPACING;
    tickUpper = Math.ceil(priceToTick(MAX_PRICE) / TICK_SPACING) * TICK_SPACING;
  } else {
    tickLower =
      Math.floor(priceToTick(1 / MAX_PRICE) / TICK_SPACING) * TICK_SPACING;
    tickUpper =
      Math.ceil(priceToTick(1 / MIN_PRICE) / TICK_SPACING) * TICK_SPACING;
  }
  tickLower = Math.max(tickLower, TickMath.MIN_TICK);
  tickUpper = Math.min(tickUpper, TickMath.MAX_TICK);
  if (tickLower >= tickUpper) throw new Error("Invalid tick range");

  return { pool, isToken0Outcome, tickLower, tickUpper, tickCurrent };
}

// For a given outcome-token quantity, return the Position plus the outcome/sUSDS
// amounts it actually consumes (outcome is forced to be the binding side).
function sizePosition(meta, qOutcome) {
  const HUGE = (qOutcome + 1n) * 1000n; // ensure outcome token binds, not sUSDS
  const amount0 = meta.isToken0Outcome ? qOutcome.toString() : HUGE.toString();
  const amount1 = meta.isToken0Outcome ? HUGE.toString() : qOutcome.toString();
  const position = Position.fromAmounts({
    pool: meta.pool,
    tickLower: meta.tickLower,
    tickUpper: meta.tickUpper,
    amount0,
    amount1,
    useFullPrecision: true,
  });
  const a0 = BigInt(position.mintAmounts.amount0.toString());
  const a1 = BigInt(position.mintAmounts.amount1.toString());
  const outcomeUsed = meta.isToken0Outcome ? a0 : a1;
  const susdsUsed = meta.isToken0Outcome ? a1 : a0;
  return { position, outcomeUsed, susdsUsed, amount0: a0, amount1: a1 };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n📋 Wallet      : ${wallet.address}`);
  console.log(`📋 DRY_RUN     : ${DRY_RUN}`);
  console.log(`📋 Init price  : ${INVALID_INIT_PRICE} sUSDS/Invalid`);
  console.log(`📋 Range       : [${MIN_PRICE}, ${MAX_PRICE}] sUSDS/Invalid\n`);

  // ── Phase 0: resolve market + Invalid outcome ───────────────────────────────
  console.log("🔍 Phase 0: resolving market & Invalid outcome...");
  const info = await getMarketInfo(OCTANT_MARKET);

  if (info.collateralToken.toLowerCase() !== SUSDS_ADDRESS.toLowerCase()) {
    throw new Error(
      `Collateral ${info.collateralToken} ≠ sUSDS ${SUSDS_ADDRESS}.`
    );
  }

  // Invalid is the last outcome/token.
  const invalidName = info.outcomes.at(-1);
  const invalidToken = info.wrappedTokens.at(-1);
  if (!/invalid/i.test(invalidName)) {
    throw new Error(
      `Last outcome is "${invalidName}", expected an Invalid outcome — aborting.`
    );
  }
  console.log(`   Market "${info.name}"`);
  console.log(`   Invalid outcome: "${invalidName}" → ${invalidToken}`);

  const code = await provider.getCode(invalidToken);
  if (!code || code === "0x") {
    throw new Error(`Invalid token ${invalidToken} has no code — not deployed.`);
  }

  // ── Phase 1: read idle Invalid balance & size the position ──────────────────
  const invalidBalance = await getTokenBalance(invalidToken);
  console.log(
    `\n💰 Idle Invalid balance: ${formatUnits(invalidBalance, 18)} tokens`
  );
  if (invalidBalance === 0n) {
    throw new Error(
      "Wallet holds 0 Invalid tokens — nothing to deploy. (A fresh split would " +
        "be required, which this script intentionally does not do.)"
    );
  }

  const meta = buildPoolAndBounds(invalidToken, INVALID_INIT_PRICE);
  const s = sizePosition(meta, invalidBalance);

  console.log("\n📐 Phase 1: position sizing");
  console.log(`   isToken0Outcome : ${meta.isToken0Outcome}`);
  console.log(
    `   ticks           : [${meta.tickLower}, ${meta.tickUpper}] (current ${meta.tickCurrent})`
  );
  console.log(
    `   Invalid used    : ${Number(formatUnits(s.outcomeUsed, 18)).toFixed(4)}`
  );
  console.log(
    `   sUSDS used      : ${Number(formatUnits(s.susdsUsed, 18)).toFixed(6)}`
  );

  if (DRY_RUN) {
    console.log("\n✅ Dry run complete — set DRY_RUN = false to execute.");
    return;
  }

  // ── Phase 2: guards ─────────────────────────────────────────────────────────
  if (s.susdsUsed > MAX_SUSDS_GUARD) {
    throw new Error(
      `sUSDS side ${formatUnits(s.susdsUsed, 18)} exceeds guard ` +
        `${formatUnits(MAX_SUSDS_GUARD, 18)} — aborting.`
    );
  }
  const susdsBalance = await getTokenBalance(SUSDS_ADDRESS);
  console.log(
    `\n💰 sUSDS balance: ${formatUnits(susdsBalance, 18)} | need: ${formatUnits(s.susdsUsed, 18)}`
  );
  if (susdsBalance < s.susdsUsed) {
    throw new Error("Insufficient sUSDS balance — aborting.");
  }

  // Idempotent progress log keyed by outcome token.
  let progressLog = [];
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      progressLog = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
    } catch {
      progressLog = [];
    }
  }
  const alreadyDone = new Set(
    progressLog.map((e) => e.outcomeToken.toLowerCase())
  );
  if (alreadyDone.has(invalidToken.toLowerCase())) {
    console.log("\n⏭  Invalid pool already in progress log — nothing to do.");
    return;
  }

  // ── Phase 2b: approve + create + initialize + mint ──────────────────────────
  const outcomeAmount = meta.isToken0Outcome ? s.amount0 : s.amount1;
  await ensureAllowance(invalidToken, POSITION_MANAGER_ADDRESS, outcomeAmount);
  await ensureAllowance(SUSDS_ADDRESS, POSITION_MANAGER_ADDRESS, s.susdsUsed);

  console.log(`\n📈 Minting Invalid position (${invalidToken})`);
  const { calldata, value } = NonfungiblePositionManager.addCallParameters(
    s.position,
    {
      recipient: wallet.address,
      createPool: true, // create + initialize pool if needed, then mint
      slippageTolerance: new Percent(50, 10_000), // 0.5%
      deadline: Math.floor(Date.now() / 1000) + 60 * 20,
    }
  );
  const receipt = await retryTransaction(() =>
    wallet.sendTransaction({
      to: POSITION_MANAGER_ADDRESS,
      data: calldata,
      value,
    })
  );

  progressLog.push({
    index: info.outcomes.length - 1,
    name: invalidName,
    outcomeToken: invalidToken,
    price: INVALID_INIT_PRICE,
    tickLower: meta.tickLower,
    tickUpper: meta.tickUpper,
    amount0: s.amount0.toString(),
    amount1: s.amount1.toString(),
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
  });
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progressLog, null, 2));
  console.log(`\n🎉 Done! Invalid position minted. See ${PROGRESS_FILE}.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
