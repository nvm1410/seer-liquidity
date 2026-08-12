import { Percent, Token } from "@uniswap/sdk-core";
import { NonfungiblePositionManager, Pool, Position } from "@uniswap/v3-sdk";
import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import JSBI from "jsbi";
import { erc20Abi, formatUnits } from "viem";
import { MarketViewAbi } from "./abis/MarketViewAbi.js";
import { RouterAbi } from "./abis/RouterAbi.js";

// ── Config ──────────────────────────────────────────────────────────────────
const DRY_RUN = true; // ← set to false to send transactions
// Resume switch: if a live run already did the two splits but died partway
// through Phase 3, set this true and re-run. It skips Phases 1-2 (tokens are
// already in the wallet) and only finishes the increaseLiquidity calls not yet
// in the progress log. Leave false for a fresh run.
const SKIP_SPLITS = false;

const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL;
const CHAIN_ID = 10;

// Total sUSDS we are willing to spend this round. This counts BOTH the sUSDS
// locked in splitPosition (to mint outcome tokens) and the sUSDS deposited as
// the collateral side of the pools — the same accounting used for the first 20k.
const TOTAL_SUSDS_BUDGET = 20_000n * 10n ** 18n;

// Addresses (Optimism, chain 10)
const POSITION_MANAGER_ADDRESS = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const ROUTER_ADDRESS = "0x179d8F8c811B8C759c33809dbc6c5ceDc62D05DD";
const SUSDS_ADDRESS = "0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0";
const MARKET_FACTORY = "0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6";
const MARKET_VIEW = "0x336695ec9efbafd6322fb82eaadbcda02e38f348";

// The two markets whose outcome tokens are paired against sUSDS in the L1 pools.
// MARKET_B is conditional on MARKET_A's outcome #66 ("Other repositories…"),
// whose ERC20 is OTHER_TOKEN — the only MARKET_A outcome with no sUSDS pool.
const MARKET_A = "0x3220A208aAf4D2ceECDe5A2e21eC0C9145f40BA6";
const MARKET_B = "0xfea47428981f70110c64dd678889826c3627245b";
const OTHER_TOKEN = "0x63a4F76ef5846F68D069054C271465B7118e8ed9";

const SOURCE_FILE = "./execution.json"; // the 198 L1 positions
const PROGRESS_FILE = "./add-20k-l1-execution.json";

// ── ABIs ────────────────────────────────────────────────────────────────────
const POSITION_MANAGER_ABI = [
  "function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
];
const POOL_ABI = [
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() external view returns (uint128)",
];

// ── Provider / wallet ───────────────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

// ── Helpers (mirror add-20k-originality-liquidity.js) ────────────────────────
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
  const token = new ethers.Contract(ethers.getAddress(tokenAddress), erc20Abi, provider);
  return await token.balanceOf(wallet.address);
}

async function ensureAllowance(tokenAddress, spender, amount) {
  const addr = ethers.getAddress(tokenAddress);
  const ro = new ethers.Contract(addr, erc20Abi, provider);
  const current = await ro.allowance(wallet.address, spender);
  if (current >= amount) {
    console.log(`  ⏭  allowance already sufficient for ${addr}`);
    return;
  }
  const token = new ethers.Contract(addr, erc20Abi, wallet);
  console.log(`  Approving ${addr} → ${spender} for ${formatUnits(amount, 18)} ...`);
  await retryTransaction(() => token.approve(spender, amount));
  await new Promise((r) => setTimeout(r, 2000));
}

// Scale a BigInt by a floating multiplier with 1e9 precision.
const F_SCALE = 1_000_000_000n;
function scaleBy(x, f) {
  return (BigInt(Math.round(f * Number(F_SCALE))) * x) / F_SCALE;
}
const bigMax = (a, b) => (a > b ? a : b);
const fmt = (x) => Number(formatUnits(x, 18)).toFixed(2);

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n📋 Wallet address : ${wallet.address}`);
  console.log(`📋 DRY_RUN        : ${DRY_RUN}`);
  console.log(`📋 SKIP_SPLITS    : ${SKIP_SPLITS}`);
  console.log(`📋 Budget         : ${formatUnits(TOTAL_SUSDS_BUDGET, 18)} sUSDS (split cost + pool side)\n`);

  const positionManager = new ethers.Contract(POSITION_MANAGER_ADDRESS, POSITION_MANAGER_ABI, provider);
  const marketView = new ethers.Contract(MARKET_VIEW, MarketViewAbi, provider);
  const susdsLower = SUSDS_ADDRESS.toLowerCase();
  const otherLower = OTHER_TOKEN.toLowerCase();

  // ── Phase 0: resolve markets and build the per-pool work list ─────────────
  console.log("🔍 Phase 0: resolving markets and building the pool work list...\n");

  const mA = await marketView.getMarket(MARKET_FACTORY, MARKET_A);
  const mB = await marketView.getMarket(MARKET_FACTORY, MARKET_B);
  const tokenMarket = new Map(); // token (lower) → "A" | "B"
  for (const t of mA.wrappedTokens) tokenMarket.set(t.toLowerCase(), "A");
  for (const t of mB.wrappedTokens) tokenMarket.set(t.toLowerCase(), "B");
  console.log(`   Market A ${MARKET_A}: ${mA.wrappedTokens.length} outcomes`);
  console.log(`   Market B ${MARKET_B}: ${mB.wrappedTokens.length} outcomes`);
  if (mB.parentMarket?.id?.toLowerCase() !== MARKET_A.toLowerCase()) {
    console.log(`   ❌ Market B's parent is ${mB.parentMarket?.id}, expected ${MARKET_A} — aborting.`);
    process.exit(1);
  }
  if (mA.wrappedTokens[Number(mB.parentOutcome)]?.toLowerCase() !== otherLower) {
    console.log(`   ❌ Market B's parent outcome token is not ${OTHER_TOKEN} — aborting.`);
    process.exit(1);
  }

  const source = JSON.parse(fs.readFileSync(SOURCE_FILE, "utf8"));
  // Group the source positions by pool (keyed on the non-sUSDS outcome token).
  const byOutcome = new Map();
  for (const e of source) {
    const t0 = e.token0.toLowerCase();
    const t1 = e.token1.toLowerCase();
    if (t0 !== susdsLower && t1 !== susdsLower) {
      console.log(`  ⚠️  #${e.positionId}: not an sUSDS pool — skipping`);
      continue;
    }
    const outcome = t0 === susdsLower ? t1 : t0;
    if (!byOutcome.has(outcome)) byOutcome.set(outcome, []);
    byOutcome.get(outcome).push(e);
  }
  console.log(`   Source positions            : ${source.length}`);
  console.log(`   Distinct sUSDS pools        : ${byOutcome.size}`);

  // For each pool: read every position, sum their liquidity, and pick the
  // largest one as the single top-up target. All positions in a pool share the
  // same fee + tick range (asserted below), so concentrating the add into the
  // biggest NFT is economically identical to topping each up separately.
  const pools = [];
  let mismatched = 0;
  for (const [outcome, entries] of byOutcome) {
    const market = tokenMarket.get(outcome);
    if (!market) {
      console.log(`  ⚠️  ${outcome}: not an outcome of market A or B — skipping`);
      continue;
    }

    const read = [];
    for (const e of entries) {
      const p = await positionManager.positions(BigInt(e.positionId));
      read.push({
        positionId: String(e.positionId),
        fee: Number(p.fee),
        tickLower: Number(p.tickLower),
        tickUpper: Number(p.tickUpper),
        liquidity: p.liquidity,
        token0: ethers.getAddress(p.token0),
        token1: ethers.getAddress(p.token1),
      });
    }

    // Group by (fee, tickLower, tickUpper) so a pool with heterogeneous ranges
    // degrades gracefully into one target per distinct range instead of
    // silently mixing them.
    const byRange = new Map();
    for (const r of read) {
      const key = `${r.fee}:${r.tickLower}:${r.tickUpper}`;
      if (!byRange.has(key)) byRange.set(key, []);
      byRange.get(key).push(r);
    }
    if (byRange.size > 1) {
      mismatched++;
      console.log(
        `  ⚠️  ${outcome}: ${byRange.size} distinct fee/tick ranges — creating one target per range`
      );
    }

    for (const group of byRange.values()) {
      const target = group.reduce((a, b) => (b.liquidity > a.liquidity ? b : a));
      const totalLiquidity = group.reduce((s, r) => s + r.liquidity, 0n);
      if (totalLiquidity === 0n) {
        console.log(`  ⚠️  ${outcome}: zero combined liquidity — skipping`);
        continue;
      }

      const token0 = new Token(CHAIN_ID, target.token0, 18, "T0");
      const token1 = new Token(CHAIN_ID, target.token1, 18, "T1");
      const poolAddress = Pool.getAddress(token0, token1, target.fee);
      const poolContract = new ethers.Contract(poolAddress, POOL_ABI, provider);
      const [slot0, poolLiquidity] = await Promise.all([poolContract.slot0(), poolContract.liquidity()]);
      const pool = new Pool(
        token0,
        token1,
        target.fee,
        slot0.sqrtPriceX96.toString(),
        poolLiquidity.toString(),
        Number(slot0.tick)
      );

      pools.push({
        outcome,
        market,
        positionId: target.positionId,
        mergedFrom: group.map((r) => r.positionId),
        token0: target.token0,
        token1: target.token1,
        tickLower: target.tickLower,
        tickUpper: target.tickUpper,
        currentLiquidity: target.liquidity, // liquidity of the NFT we will increase
        totalLiquidity, // combined liquidity of every NFT in this pool/range
        inRange: Number(slot0.tick) > target.tickLower && Number(slot0.tick) < target.tickUpper,
        pool,
      });
    }
  }

  const covered = pools.reduce((n, p) => n + p.mergedFrom.length, 0);
  console.log(`   Top-up targets              : ${pools.length}`);
  console.log(`   Source positions covered    : ${covered}/${source.length}`);
  console.log(`   Pools with mixed tick ranges: ${mismatched}`);
  console.log(`   In-range targets            : ${pools.filter((p) => p.inRange).length}/${pools.length}`);
  if (pools.length === 0) {
    console.log("\n❌ No pools resolved — aborting.");
    process.exit(1);
  }

  // ── Phase 0.5: solve the add multiplier `f` against the budget ────────────
  // Both the split cost and the pool-side sUSDS scale (near-)linearly in f, so
  // f ← f * BUDGET / total(f) converges in a couple of iterations. The
  // max(0, need - balance) clamp on leftover token balances is what makes it
  // not exactly linear.
  console.log("\n🧮 Phase 0.5: solving the add multiplier against the budget...\n");

  const involved = new Set([susdsLower, otherLower]);
  for (const p of pools) involved.add(p.outcome);
  const balances = new Map();
  for (const t of involved) balances.set(t, await getTokenBalance(t));
  const susdsBalance = balances.get(susdsLower);

  // amountsFor(f) → { needOutcome per token, needSUSDS total, per-pool amounts }
  function amountsFor(f) {
    const needByToken = new Map();
    let needSUSDS = 0n;
    const perPool = [];
    for (const p of pools) {
      const targetLiquidity = scaleBy(p.totalLiquidity, f);
      if (targetLiquidity <= 0n) {
        perPool.push({ p, targetLiquidity: 0n, needOutcome: 0n, needSUSDS: 0n });
        continue;
      }
      const position = new Position({
        pool: p.pool,
        tickLower: p.tickLower,
        tickUpper: p.tickUpper,
        liquidity: JSBI.BigInt(targetLiquidity.toString()),
      });
      const a0 = BigInt(position.mintAmounts.amount0.toString());
      const a1 = BigInt(position.mintAmounts.amount1.toString());
      const isToken0SUSDS = p.token0.toLowerCase() === susdsLower;
      const needO = isToken0SUSDS ? a1 : a0;
      const needS = isToken0SUSDS ? a0 : a1;
      needByToken.set(p.outcome, (needByToken.get(p.outcome) ?? 0n) + needO);
      needSUSDS += needS;
      perPool.push({ p, targetLiquidity, position, needOutcome: needO, needSUSDS: needS });
    }
    return { needByToken, needSUSDS, perPool };
  }

  // splitPosition on market A mints `splitA` of EVERY A outcome (including
  // OTHER_TOKEN); splitPosition on market B burns `splitB` OTHER_TOKEN and
  // mints `splitB` of every B outcome. So one split per market must cover the
  // single largest per-token shortfall in that market.
  function costFor(f) {
    const { needByToken, needSUSDS, perPool } = amountsFor(f);
    let shortA = 0n;
    let shortB = 0n;
    for (const [tok, need] of needByToken) {
      const short = bigMax(0n, need - (balances.get(tok) ?? 0n));
      if (tokenMarket.get(tok) === "A") shortA = bigMax(shortA, short);
      else shortB = bigMax(shortB, short);
    }
    const otherShort = bigMax(0n, shortB - (balances.get(otherLower) ?? 0n));
    const splitA = bigMax(shortA, otherShort);
    return { f, splitA, splitB: shortB, needSUSDS, total: splitA + needSUSDS, perPool, needByToken };
  }

  let f = 1.0;
  let cost = costFor(f);
  console.log(
    `   f=${f.toFixed(4)}  splitA=${fmt(cost.splitA)}  splitB=${fmt(cost.splitB)}  poolSUSDS=${fmt(cost.needSUSDS)}  TOTAL=${fmt(cost.total)}`
  );
  for (let i = 0; i < 6; i++) {
    if (cost.total === 0n) break;
    const next = f * (Number(TOTAL_SUSDS_BUDGET) / Number(cost.total));
    if (Math.abs(next - f) / f < 1e-6) break;
    f = next;
    cost = costFor(f);
    console.log(
      `   f=${f.toFixed(4)}  splitA=${fmt(cost.splitA)}  splitB=${fmt(cost.splitB)}  poolSUSDS=${fmt(cost.needSUSDS)}  TOTAL=${fmt(cost.total)}`
    );
  }
  // Never exceed the budget because of a rounding overshoot.
  while (cost.total > TOTAL_SUSDS_BUDGET) {
    f *= 0.999;
    cost = costFor(f);
  }

  const { splitA, splitB, needSUSDS, perPool } = cost;
  console.log(`\n📊 Plan:`);
  console.log(`   add multiplier f            : ${f.toFixed(4)}x current liquidity`);
  console.log(`   → every pool ends at        : ${(1 + f).toFixed(4)}x`);
  console.log(`   splitPosition on market A   : ${formatUnits(splitA, 18)} sUSDS`);
  console.log(`   splitPosition on market B   : ${formatUnits(splitB, 18)} ${OTHER_TOKEN}`);
  console.log(`   sUSDS deposited into pools  : ${formatUnits(needSUSDS, 18)}`);
  console.log(`   ────────────────────────────────────────────`);
  console.log(`   TOTAL sUSDS outlay          : ${formatUnits(splitA + needSUSDS, 18)}`);
  console.log(`   sUSDS balance               : ${formatUnits(susdsBalance, 18)}`);

  const ethBalance = await provider.getBalance(wallet.address);
  const txEstimate = 2 + 2 + involved.size + pools.length;
  console.log(`   ETH balance (gas)           : ${formatUnits(ethBalance, 18)} (~${txEstimate} txs to send)`);

  if (splitA + needSUSDS > susdsBalance) {
    console.log(`\n❌ Insufficient sUSDS: need ${formatUnits(splitA + needSUSDS, 18)} — aborting.`);
    process.exit(1);
  }
  // After split A the wallet holds balOther + splitA of OTHER_TOKEN; split B burns splitB of it.
  if (splitB > (balances.get(otherLower) ?? 0n) + splitA) {
    console.log(`\n❌ Split A does not mint enough ${OTHER_TOKEN} for split B — aborting.`);
    process.exit(1);
  }

  const router = new ethers.Contract(ROUTER_ADDRESS, RouterAbi, wallet);

  if (SKIP_SPLITS) {
    console.log("\n⏭  Phases 1-2 skipped (SKIP_SPLITS=true) — assuming tokens already minted.");
  } else {
    // ── Phase 1: split sUSDS → market A outcome tokens ──────────────────────
    console.log(`\n💰 Phase 1: split ${formatUnits(splitA, 18)} sUSDS on market A ${MARKET_A}`);
    if (!DRY_RUN) {
      const ct = await router.conditionalTokens();
      if (!ct || ct === ethers.ZeroAddress) {
        console.log("   ❌ Router.conditionalTokens() is zero — wrong Router address? Aborting.");
        process.exit(1);
      }
      console.log(`   Router.conditionalTokens() = ${ct}`);
      await ensureAllowance(SUSDS_ADDRESS, ROUTER_ADDRESS, splitA);
      await retryTransaction(() => router.splitPosition(SUSDS_ADDRESS, MARKET_A, splitA));
      await new Promise((r) => setTimeout(r, 2000));
    } else {
      console.log("   (dry run — no split sent)");
    }

    // ── Phase 2: split OTHER_TOKEN → market B outcome tokens ────────────────
    console.log(
      `\n🪙 Phase 2: split ${formatUnits(splitB, 18)} of ${OTHER_TOKEN} on market B ${MARKET_B}`
    );
    if (!DRY_RUN) {
      if (splitB > 0n) {
        await ensureAllowance(OTHER_TOKEN, ROUTER_ADDRESS, splitB);
        // collateralToken arg = base collateral (sUSDS); the Router pulls/unwraps
        // the parent outcome ERC20 because market B has a non-zero parentCollectionId.
        await retryTransaction(() => router.splitPosition(SUSDS_ADDRESS, MARKET_B, splitB));
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        console.log("   Nothing to split — existing balances already cover market B.");
      }
    } else {
      console.log("   (dry run — no split sent)");
    }
  }

  // ── Phase 3: increase liquidity on each target position ──────────────────
  console.log(`\n📈 Phase 3: increase liquidity on ${pools.length} positions\n`);

  // Spendable balance tracker. In a live run the splits already happened, so
  // re-read on-chain. In a dry run nothing was minted, so add the projected
  // mint deltas to preview realistic amounts.
  const remaining = new Map();
  for (const t of involved) {
    let bal = DRY_RUN ? balances.get(t) : await getTokenBalance(t);
    if (DRY_RUN) {
      if (t === susdsLower) bal -= splitA;
      else if (t === otherLower) bal += splitA - splitB;
      else if (tokenMarket.get(t) === "A") bal += splitA;
      else if (tokenMarket.get(t) === "B") bal += splitB;
    }
    remaining.set(t, bal);
  }
  console.log(`💰 sUSDS available for pools: ${formatUnits(remaining.get(susdsLower), 18)}`);

  // Approvals for the PositionManager (skip in dry run).
  if (!DRY_RUN) {
    console.log("\n🔑 Approving tokens for PositionManager...");
    for (const t of involved) {
      if (t === otherLower) continue; // not pooled
      const amount = t === susdsLower ? needSUSDS : (remaining.get(t) ?? 0n);
      if (amount === 0n) continue;
      await ensureAllowance(t, POSITION_MANAGER_ADDRESS, amount);
    }
  }

  // Progress log (idempotent re-runs).
  let progressLog = [];
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      progressLog = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
    } catch {
      progressLog = [];
    }
  }
  const alreadyDone = new Set(progressLog.map((e) => String(e.positionId)));

  let successCount = 0;
  let skipped = 0;
  let failed = 0;
  const belowTarget = [];

  for (const item of perPool) {
    const p = item.p;
    if (alreadyDone.has(p.positionId)) {
      console.log(`  ⏭  #${p.positionId}: already in progress log — skipping`);
      successCount++;
      continue;
    }
    if (item.targetLiquidity === 0n) {
      console.log(`  ⚠️  #${p.positionId}: target liquidity is zero — skipping`);
      skipped++;
      continue;
    }

    const t0 = p.token0.toLowerCase();
    const t1 = p.token1.toLowerCase();
    const rem0 = remaining.get(t0) ?? 0n;
    const rem1 = remaining.get(t1) ?? 0n;
    const isToken0SUSDS = t0 === susdsLower;
    const want0 = isToken0SUSDS ? item.needSUSDS : item.needOutcome;
    const want1 = isToken0SUSDS ? item.needOutcome : item.needSUSDS;

    let positionToUse = item.position;
    let use0 = want0;
    let use1 = want1;

    if (rem0 < want0 || rem1 < want1) {
      if (rem0 === 0n || rem1 === 0n) {
        console.log(`  ⚠️  #${p.positionId}: one token exhausted — skipping`);
        skipped++;
        continue;
      }
      const capped0 = rem0 < want0 ? rem0 : want0;
      const capped1 = rem1 < want1 ? rem1 : want1;
      positionToUse = Position.fromAmounts({
        pool: p.pool,
        tickLower: p.tickLower,
        tickUpper: p.tickUpper,
        amount0: capped0.toString(),
        amount1: capped1.toString(),
        useFullPrecision: true,
      });
      if (JSBI.equal(positionToUse.liquidity, JSBI.BigInt(0))) {
        console.log(`  ⚠️  #${p.positionId}: capped amounts yield zero liquidity — skipping`);
        skipped++;
        continue;
      }
      use0 = BigInt(positionToUse.mintAmounts.amount0.toString());
      use1 = BigInt(positionToUse.mintAmounts.amount1.toString());
    }

    // Pool-level ratio: the add lands on one NFT but the pool's combined
    // liquidity is what we are scaling by (1 + f).
    const addedLiquidity = BigInt(positionToUse.liquidity.toString());
    const ratio = Number(p.totalLiquidity + addedLiquidity) / Number(p.totalLiquidity);
    if (ratio < 1 + f * 0.99) belowTarget.push({ positionId: p.positionId, ratio: ratio.toFixed(3) });

    console.log(
      `\n--- #${p.positionId} [${p.market}] ${p.outcome} | token0=${formatUnits(use0, 18)} token1=${formatUnits(use1, 18)}` +
        ` | pool ends at ${ratio.toFixed(3)}x ---`
    );

    if (DRY_RUN) {
      remaining.set(t0, rem0 - use0);
      remaining.set(t1, rem1 - use1);
      successCount++;
      continue;
    }

    try {
      const { calldata, value } = NonfungiblePositionManager.addCallParameters(positionToUse, {
        tokenId: p.positionId, // triggers increaseLiquidity
        slippageTolerance: new Percent(50, 10_000), // 0.5%
        deadline: Math.floor(Date.now() / 1000) + 60 * 20,
      });
      const receipt = await retryTransaction(() =>
        wallet.sendTransaction({ to: POSITION_MANAGER_ADDRESS, data: calldata, value })
      );

      remaining.set(t0, rem0 - use0);
      remaining.set(t1, rem1 - use1);

      progressLog.push({
        positionId: p.positionId,
        outcomeToken: p.outcome,
        market: p.market,
        token0: p.token0,
        token1: p.token1,
        amount0Desired: use0.toString(),
        amount1Desired: use1.toString(),
        addedLiquidity: addedLiquidity.toString(),
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      });
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progressLog, null, 2));
      successCount++;
      console.log(`  ✅ Saved to ${PROGRESS_FILE}`);
    } catch (err) {
      failed++;
      console.error(`  ❌ Failed for #${p.positionId}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log(
    `\n🎯 Target check: ${perPool.length - belowTarget.length}/${perPool.length} pools reach ${(1 + f).toFixed(3)}x.`
  );
  if (belowTarget.length > 0) {
    console.log(`   ⚠️  ${belowTarget.length} below target:`);
    for (const b of belowTarget) console.log(`      #${b.positionId}: ${b.ratio}x`);
  }

  console.log(
    `\n🎉 Done! ${successCount} processed, ${skipped} skipped, ${failed} failed.` +
      (DRY_RUN ? "\n   Dry run — set DRY_RUN = false to execute." : ` See ${PROGRESS_FILE}.`)
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
