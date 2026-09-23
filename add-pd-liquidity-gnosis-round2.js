// Round 2 top-up for the Gnosis PD market pools created by
// add-pd-liquidity-gnosis.js. "No To All" already holds plenty of sDAI
// relative to its need (round 1 gave it 4.269 of the 5 sDAI budget) — this
// round skips it entirely and puts the full remaining 5 sDAI budget into the
// 24 asset pools instead, deepening each by an equal outcome-token quantity.
//
// Adds a SECOND position per pool at the SAME tick range as round 1 (reusing
// the addresses/prices recorded in add-pd-gnosis-execution.json). This does
// NOT change the pool's current price — price only moves on swaps, and no
// swaps have occurred since round 1's mint.

import { Percent, Token } from "@uniswap/sdk-core";
import { Pool, Position, TickMath } from "@uniswap/v3-sdk";
import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import { erc20Abi, formatUnits } from "viem";
import { RouterAbi } from "./abis/RouterAbi.js";

// ── Config ──────────────────────────────────────────────────────────────────
const DRY_RUN = true; // ← set to false to send transactions

const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.GNOSIS_RPC_URL;
const CHAIN_ID = 100; // Gnosis

const MARKET = "0x7d386b7c41b8dab6179fc79cf7986a795305b815";
const ROUND1_PROGRESS_FILE = "./add-pd-gnosis-execution.json";
const PROGRESS_FILE = "./add-pd-gnosis-round2-execution.json";

// Addresses (Gnosis, chain 100) — same as round 1.
const SWAPR_NPM_ADDRESS = "0x91fd594c46d8b01e62dbdebed2401dde01817834";
const GNOSIS_ROUTER_ADDRESS = "0xeC9048b59b3467415b1a38F63416407eA0c70fB8";
const SDAI_ADDRESS = "0xaf204776c7245bf4147c2612bf6e5972ee483701";

const MATH_FEE_TIER = 3000; // maps to tickSpacing 60, matching Algebra
const TICK_SPACING = 60;

const ROUND2_BUDGET = 5n * 10n ** 18n; // 5 sDAI, all going to the 24 asset pools
const SAFE_DOWN = 0.2; // -20%
const SAFE_UP = 0.4; // +40%
const Q0 = 10n ** 17n; // trial outcome quantity, 0.1 token

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

// Rebuild the same Pool + tick bounds used in round 1 (same price, same Safe band).
function buildPoolAndBounds(outcomeToken, centerPrice) {
  const [t0, t1] = sortTokens(outcomeToken, SDAI_ADDRESS);
  const isToken0Outcome = t0.toLowerCase() === outcomeToken.toLowerCase();
  const orientedPrice = isToken0Outcome ? centerPrice : 1 / centerPrice;
  const tickCurrent = priceToTick(orientedPrice);
  const sqrtPriceX96 = TickMath.getSqrtRatioAtTick(tickCurrent);

  const token0 = new Token(CHAIN_ID, t0, 18, "T0");
  const token1 = new Token(CHAIN_ID, t1, 18, "T1");
  const pool = new Pool(token0, token1, MATH_FEE_TIER, sqrtPriceX96.toString(), "0", tickCurrent);

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
  if (tickLower >= tickUpper) throw new Error(`Invalid tick range for ${outcomeToken}`);

  return { pool, token0, token1, isToken0Outcome, tickLower, tickUpper, sqrtPriceX96 };
}

function sizePosition(meta, qOutcome) {
  const HUGE = (qOutcome + 1n) * 1000n;
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
  const sdaiUsed = meta.isToken0Outcome ? a1 : a0;
  return { position, outcomeUsed, sdaiUsed, amount0: a0, amount1: a1 };
}

function buildMintCalldata(p) {
  const createCalldata = algebraIface.encodeFunctionData("createAndInitializePoolIfNecessary", [
    p.meta.token0.address,
    p.meta.token1.address,
    p.meta.sqrtPriceX96.toString(),
  ]);

  const { amount0: amount0Min, amount1: amount1Min } = p.position.mintAmountsWithSlippage(
    new Percent(50, 10_000)
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
  console.log(`\n📋 Wallet      : ${wallet.address}`);
  console.log(`📋 DRY_RUN     : ${DRY_RUN}`);
  console.log(`📋 Round-2 budget : ${formatUnits(ROUND2_BUDGET, 18)} sDAI (24 asset pools only)\n`);

  const round1 = JSON.parse(fs.readFileSync(ROUND1_PROGRESS_FILE, "utf8"));
  const pools = round1
    .filter((e) => e.name !== "No To All")
    .map((e) => ({ name: e.name, outcomeToken: e.outcomeToken, price: e.price }));
  console.log(`   Loaded ${pools.length} asset pools from ${ROUND1_PROGRESS_FILE} (No To All excluded)`);

  // ── Phase 1: size positions & solve for Q2 ──────────────────────────────────
  console.log("\n📐 Phase 1: sizing positions...");
  let trialSdai = 0n;
  for (const p of pools) {
    p.meta = buildPoolAndBounds(p.outcomeToken, p.price);
    const s = sizePosition(p.meta, Q0);
    trialSdai += s.sdaiUsed;
  }
  const totalTrial = Q0 + trialSdai;
  const Q2 = (Q0 * ROUND2_BUDGET) / totalTrial;
  console.log(
    `   Trial Q0=${formatUnits(Q0, 18)} → ΣsDAI=${formatUnits(trialSdai, 18)}, ` +
      `total=${formatUnits(totalTrial, 18)} ⇒ Q2=${formatUnits(Q2, 18)}`
  );

  let sumSdai = 0n;
  let maxOutcome = 0n;
  console.log("\n   outcome                          price       outcome        sDAI");
  for (const p of pools) {
    const s = sizePosition(p.meta, Q2);
    p.position = s.position;
    p.outcomeUsed = s.outcomeUsed;
    p.sdaiUsed = s.sdaiUsed;
    p.amount0 = s.amount0;
    p.amount1 = s.amount1;
    sumSdai += s.sdaiUsed;
    if (s.outcomeUsed > maxOutcome) maxOutcome = s.outcomeUsed;
    console.log(
      `   ${p.name.slice(0, 30).padEnd(30)} ${p.price.toFixed(6).padStart(9)}  ` +
        `${Number(formatUnits(s.outcomeUsed, 18)).toFixed(6).padStart(12)}` +
        `  ${Number(formatUnits(s.sdaiUsed, 18)).toFixed(6).padStart(10)}`
    );
  }
  const splitAmount = maxOutcome > Q2 ? maxOutcome : Q2;
  const grandTotal = splitAmount + sumSdai;
  console.log(
    `\n   Split (mint) : ${formatUnits(splitAmount, 18)} sDAI\n` +
      `   sDAI side    : ${formatUnits(sumSdai, 18)} sDAI\n` +
      `   GRAND TOTAL  : ${formatUnits(grandTotal, 18)} sDAI (budget ${formatUnits(ROUND2_BUDGET, 18)})`
  );
  if (grandTotal > ROUND2_BUDGET) {
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

  let progressLog = [];
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      progressLog = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
    } catch {
      progressLog = [];
    }
  }
  const alreadyDone = new Set(progressLog.map((e) => e.outcomeToken.toLowerCase()));

  let needSplit = !alreadyDone.size;
  if (!needSplit) {
    console.log("\n⏭  Round-2 progress log present — assuming split already done.");
  }
  if (needSplit) {
    console.log(`\n💧 Phase 2a: split ${formatUnits(splitAmount, 18)} sDAI on market`);
    await ensureAllowance(SDAI_ADDRESS, GNOSIS_ROUTER_ADDRESS, splitAmount);
    await retryTransaction(() => router.splitPosition(SDAI_ADDRESS, MARKET, splitAmount));
    await new Promise((r) => setTimeout(r, 3000));
  }

  await ensureAllowance(SDAI_ADDRESS, SWAPR_NPM_ADDRESS, sumSdai);

  // ── Phase 2b: mint a second position per pool (same tick range as round 1) ──
  console.log(`\n📈 Phase 2b: minting ${pools.length} additional positions\n`);
  let successCount = 0;
  for (const p of pools) {
    if (alreadyDone.has(p.outcomeToken.toLowerCase())) {
      console.log(`  ⏭  ${p.name}: already in round-2 progress log — skipping`);
      successCount++;
      continue;
    }

    console.log(`\n--- ${p.name} (${p.outcomeToken}) ---`);
    const outcomeAmount = p.meta.isToken0Outcome ? p.amount0 : p.amount1;
    await ensureAllowance(p.outcomeToken, SWAPR_NPM_ADDRESS, outcomeAmount);

    try {
      const data = buildMintCalldata(p);
      const receipt = await retryTransaction(() =>
        wallet.sendTransaction({ to: SWAPR_NPM_ADDRESS, data, value: 0n })
      );

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
