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
import { RouterAbi } from "./abis/RouterAbi.js";

// ── Config ──────────────────────────────────────────────────────────────────
const DRY_RUN = false; // ← set to false to send transactions

const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL;
const CHAIN_ID = 10;

// Octant — one-level multiscalar market on Optimism (no parent, no children).
const OCTANT_MARKET = "0xE85aDa7CD6D33CB41Ac596FB4749e3F94d836EcE";
const CSV_FILE = "./octant-initial-price.csv";
const PROGRESS_FILE = "./add-octant-execution.json";

// Addresses (Optimism, chain 10)
const POSITION_MANAGER_ADDRESS = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const ROUTER_ADDRESS = "0x179d8F8c811B8C759c33809dbc6c5ceDc62D05DD";
const SUSDS_ADDRESS = "0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0";
const MARKET_FACTORY = "0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6";
const MARKET_VIEW = "0x336695ec9efbafd6322fb82eaadbcda02e38f348";

// Uniswap V3 pool params used across this repo's Seer pools.
const FEE_TIER = 100;
const TICK_SPACING = 1;

// Total capital to deploy: mint (sUSDS split into outcome tokens) + the sUSDS
// side of every pool must sum to this.
const TOTAL_BUDGET = 20_000n * 10n ** 18n;
// Fixed liquidity range for every pool, in sUSDS per outcome token.
const MIN_PRICE = 0.0001;
const MAX_PRICE = 1;
// Trial outcome-token quantity per pool used to size the (linear) budget.
const Q0 = 1_000n * 10n ** 18n;

// ── Provider / wallet ───────────────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

const LN_1_0001 = Math.log(1.0001);

// ── Helpers (mirror liquidity-l1.js / add-20k-originality-liquidity.js) ───────
function sortTokens(a, b) {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

function priceToTick(price) {
  return Math.floor(Math.log(price) / LN_1_0001);
}

function tickToPrice(tick) {
  return Math.pow(1.0001, tick);
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

// Mirrors getMarketInfo() in liquidity-l1.js but only the fields we need for a
// top-level (non-conditional) multiscalar market.
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

// Normalize an outcome / project name for matching CSV ↔ on-chain outcomes.
function normalizeName(s) {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\.$/, "")
    .trim();
}

// Parse octant-initial-price.csv → Map<normalizedName, rescaledNumber>.
function parsePriceCsv(path) {
  const lines = fs
    .readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  // drop header
  lines.shift();
  const map = new Map();
  let sum = 0;
  for (const line of lines) {
    const idx = line.lastIndexOf(",");
    const name = line.slice(0, idx);
    const rescaled = Number(line.slice(idx + 1));
    if (!Number.isFinite(rescaled)) throw new Error(`Bad CSV row: ${line}`);
    map.set(normalizeName(name), { name, rescaled });
    sum += rescaled;
  }
  return { map, sum };
}

// Build a Pool with a fresh (not-yet-deployed) price and the tick range for it.
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

  // calculateTickBounds logic from liquidity-l1.js, range is collateral/outcome.
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
  console.log(`📋 Budget      : ${formatUnits(TOTAL_BUDGET, 18)} sUSDS`);
  console.log(`📋 Range       : [${MIN_PRICE}, ${MAX_PRICE}] sUSDS/outcome\n`);

  // ── Phase 0: resolve market + price map ─────────────────────────────────────
  console.log("🔍 Phase 0: resolving market & prices...");
  const info = await getMarketInfo(OCTANT_MARKET);

  if (
    info.parentCollectionId !==
    "0x0000000000000000000000000000000000000000000000000000000000000000"
  ) {
    throw new Error("Market is conditional — expected a top-level market.");
  }
  if (!info.questionsIds || info.questionsIds.length < 2) {
    throw new Error(
      `Expected a multiscalar market (>1 question), got ${info.questionsIds?.length}.`
    );
  }
  if (info.collateralToken.toLowerCase() !== SUSDS_ADDRESS.toLowerCase()) {
    throw new Error(
      `Collateral ${info.collateralToken} ≠ sUSDS ${SUSDS_ADDRESS}.`
    );
  }

  // Drop the Invalid outcome (last entry).
  const outcomeNames = info.outcomes.slice(0, -1);
  const outcomeTokens = info.wrappedTokens.slice(0, -1);
  console.log(
    `   Market "${info.name}" | ${info.questionsIds.length} questions | ` +
      `${outcomeTokens.length} outcomes (+Invalid)`
  );

  const { map: priceMap, sum } = parsePriceCsv(CSV_FILE);
  console.log(`   CSV: ${priceMap.size} rows, Σ rescaled = ${sum.toFixed(4)}`);
  if (priceMap.size !== outcomeTokens.length) {
    throw new Error(
      `CSV rows (${priceMap.size}) ≠ market outcomes (${outcomeTokens.length}).`
    );
  }

  // Match each on-chain outcome to a CSV row by normalized name.
  const pools = [];
  const unmatched = [];
  let priceSum = 0;
  for (let i = 0; i < outcomeTokens.length; i++) {
    const key = normalizeName(outcomeNames[i]);
    const row = priceMap.get(key);
    if (!row) {
      unmatched.push(outcomeNames[i]);
      continue;
    }
    const price = row.rescaled / sum;
    priceSum += price;
    pools.push({
      index: i,
      name: outcomeNames[i],
      outcomeToken: outcomeTokens[i],
      rescaled: row.rescaled,
      price,
    });
  }
  if (unmatched.length) {
    console.error("\n❌ Unmatched on-chain outcomes (fix CSV names):");
    unmatched.forEach((n) => console.error(`   - "${n}"`));
    console.error("\nCSV names available:");
    [...priceMap.values()].forEach((v) => console.error(`   - "${v.name}"`));
    throw new Error(`${unmatched.length} outcomes unmatched.`);
  }
  console.log(`   All ${pools.length} outcomes matched. Σ price = ${priceSum.toFixed(6)}`);

  // ── Phase 0b: verify wrapped outcome ERC20s are deployed ────────────────────
  for (const p of pools) {
    const code = await provider.getCode(p.outcomeToken);
    if (!code || code === "0x") {
      throw new Error(
        `Outcome token ${p.outcomeToken} (${p.name}) has no code — not deployed.`
      );
    }
  }
  console.log("   ✅ all outcome tokens deployed on-chain");

  // ── Phase 1: size positions & solve for Q ───────────────────────────────────
  console.log("\n📐 Phase 1: sizing positions...");
  // Trial pass at Q0 to measure Σ c_i (sUSDS per pool is linear in outcome qty).
  let trialSusds = 0n;
  for (const p of pools) {
    p.meta = buildPoolAndBounds(p.outcomeToken, p.price);
    const s = sizePosition(p.meta, Q0);
    trialSusds += s.susdsUsed;
  }
  const totalTrial = Q0 + trialSusds; // mint (=Q0) + sUSDS side
  const Q = (Q0 * TOTAL_BUDGET) / totalTrial;
  console.log(
    `   Trial Q0=${formatUnits(Q0, 18)} → ΣsUSDS=${formatUnits(trialSusds, 18)}, ` +
      `total=${formatUnits(totalTrial, 18)} ⇒ Q=${formatUnits(Q, 18)}`
  );

  // Final pass at Q.
  let sumSusds = 0n;
  let maxOutcome = 0n;
  console.log(
    "\n   #  outcome                          price     ticks            outcome      sUSDS"
  );
  for (const p of pools) {
    const s = sizePosition(p.meta, Q);
    p.position = s.position;
    p.outcomeUsed = s.outcomeUsed;
    p.susdsUsed = s.susdsUsed;
    p.amount0 = s.amount0;
    p.amount1 = s.amount1;
    sumSusds += s.susdsUsed;
    if (s.outcomeUsed > maxOutcome) maxOutcome = s.outcomeUsed;
    console.log(
      `   ${String(p.index).padStart(2)} ${p.name.slice(0, 30).padEnd(30)} ` +
        `${p.price.toFixed(5)}  [${p.meta.tickLower},${p.meta.tickUpper}]`.padEnd(20) +
        `  ${Number(formatUnits(s.outcomeUsed, 18)).toFixed(2).padStart(10)}` +
        `  ${Number(formatUnits(s.susdsUsed, 18)).toFixed(2).padStart(9)}`
    );
  }
  // Mint cost = the single split size; Q outcome tokens per pool ⇒ split Q.
  const splitAmount = maxOutcome > Q ? maxOutcome : Q;
  const grandTotal = splitAmount + sumSusds;
  console.log(
    `\n   Split (mint) : ${formatUnits(splitAmount, 18)} sUSDS\n` +
      `   sUSDS side   : ${formatUnits(sumSusds, 18)} sUSDS\n` +
      `   GRAND TOTAL  : ${formatUnits(grandTotal, 18)} sUSDS (budget ${formatUnits(TOTAL_BUDGET, 18)})`
  );
  if (grandTotal > TOTAL_BUDGET) {
    console.warn("   ⚠️  grand total exceeds budget — check rounding/sentinel.");
  }

  if (DRY_RUN) {
    console.log("\n✅ Dry run complete — set DRY_RUN = false to execute.");
    return;
  }

  // ── Phase 2a: balance guard + split sUSDS once ──────────────────────────────
  const susdsBalance = await getTokenBalance(SUSDS_ADDRESS);
  console.log(
    `\n💰 sUSDS balance: ${formatUnits(susdsBalance, 18)} | need: ${formatUnits(grandTotal, 18)}`
  );
  if (susdsBalance < grandTotal) {
    throw new Error("Insufficient sUSDS balance — aborting.");
  }

  const router = new ethers.Contract(ROUTER_ADDRESS, RouterAbi, wallet);
  const ct = await router.conditionalTokens();
  if (!ct || ct === ethers.ZeroAddress) {
    throw new Error("Router.conditionalTokens() is zero — wrong Router?");
  }
  console.log(`   Router.conditionalTokens() = ${ct}`);

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

  // Split once → Q (≈ splitAmount) of EVERY outcome token (+ Invalid, ignored).
  // Skip if the wallet already holds enough of every outcome (resume case).
  let needSplit = !alreadyDone.size; // fresh run → split; resume → assume done
  if (!needSplit) {
    console.log("\n⏭  Progress log present — assuming split already done.");
  }
  if (needSplit) {
    console.log(
      `\n💧 Phase 2a: split ${formatUnits(splitAmount, 18)} sUSDS on octant market`
    );
    await ensureAllowance(SUSDS_ADDRESS, ROUTER_ADDRESS, splitAmount);
    await retryTransaction(() =>
      router.splitPosition(SUSDS_ADDRESS, OCTANT_MARKET, splitAmount)
    );
    await new Promise((r) => setTimeout(r, 3000));
  }

  // sUSDS is a token in every pool — approve the full sUSDS side once.
  await ensureAllowance(SUSDS_ADDRESS, POSITION_MANAGER_ADDRESS, sumSusds);

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
    // Approve the outcome side for this pool.
    const outcomeAmount = p.meta.isToken0Outcome ? p.amount0 : p.amount1;
    await ensureAllowance(p.outcomeToken, POSITION_MANAGER_ADDRESS, outcomeAmount);

    try {
      const { calldata, value } = NonfungiblePositionManager.addCallParameters(
        p.position,
        {
          recipient: wallet.address, // mint a new position
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
        index: p.index,
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

  console.log(
    `\n🎉 Done! ${successCount}/${pools.length} positions minted. See ${PROGRESS_FILE}.`
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
