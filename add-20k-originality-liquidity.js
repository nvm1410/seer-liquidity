import { Percent, Token } from "@uniswap/sdk-core";
import { NonfungiblePositionManager, Pool, Position } from "@uniswap/v3-sdk";
import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import JSBI from "jsbi";
import { erc20Abi, formatUnits } from "viem";
import { MarketViewAbi } from "./abis/MarketViewAbi.js";
import { RouterAbi } from "./abis/RouterAbi.js";
import { markets } from "./markets.js";

// ── Config ──────────────────────────────────────────────────────────────────
const DRY_RUN = false; // ← set to false to send transactions
// Resume switch: if a live run already did the sUSDS + parent-outcome splits but
// died partway through Phase 3, set this true and re-run. It skips Phases 1-2
// (tokens are already in the wallet) and only finishes the increaseLiquidity
// calls not yet in the progress log. Leave false for a fresh run.
const SKIP_SPLITS = false;

const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL;
const CHAIN_ID = 10;

// sUSDS to split on the parent market (the full budget). One split mints this
// amount of EVERY parent outcome token (a complete set).
const TOTAL_SUSDS = 20_000n * 10n ** 18n;
// Per repo we reserve 1/3 of the minted parent outcome tokens to split into
// Up/Down and keep 2/3 as the collateral side (mirrors the original
// liquidity-originality.js 13333-split vs 26666-collateral ratio). PER_POOL is
// therefore both the child-split amount per repo AND the per-pool token budget.
const PER_POOL = TOTAL_SUSDS / 3n;
// Sanity target: each position's final liquidity (current + added) should reach
// at least this multiple of its current on-chain liquidity. Checked & reported
// per position (expressed as a fraction to keep the comparison in integer math).
const MIN_FINAL_MULT_NUM = 3n; // 3/2 = 1.5x
const MIN_FINAL_MULT_DEN = 2n;

// Addresses (Optimism, chain 10)
const POSITION_MANAGER_ADDRESS = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const ROUTER_ADDRESS = "0x179d8F8c811B8C759c33809dbc6c5ceDc62D05DD";
const PARENT_MARKET_ADDRESS = "0xdb3aae8d1c964767eeaa17805be25cded7a17210";
const SUSDS_ADDRESS = "0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0";
const MARKET_FACTORY = "0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6";
const MARKET_VIEW = "0x336695ec9efbafd6322fb82eaadbcda02e38f348";

const PROGRESS_FILE = "./add-20k-originality-execution.json";
const ADD_BACK_FILE = "./add-back-execution.json";
// Cache of the resolved repo→tokens/markets/positions map. Built once (e.g. on
// the dry run) and reused by later runs so we don't re-resolve ~98 markets over
// RPC. Delete this file to force a fresh resolve.
const MAP_CACHE_FILE = "./originality-map-cache.json";

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

// ── Helpers (mirror liquidity-originality.js / add-back-liquidity.js) ─────────
function sortTokens(a, b) {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
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

// Mirrors getMarketInfo() in liquidity-originality.js: resolves the parent
// outcome token (collateral side of the originality pools) and the child
// outcome tokens (Up/Down) for a scalar child market.
async function getMarketInfo(marketView, marketAddress) {
  const result = await marketView.getMarket(MARKET_FACTORY, marketAddress);
  const isConditional =
    result.parentCollectionId !==
    "0x0000000000000000000000000000000000000000000000000000000000000000";
  const parentMarketAddress =
    isConditional && result.parentMarket ? result.parentMarket.id : undefined;
  const parentOutcomeIndex = isConditional ? Number(result.parentOutcome) : undefined;

  let baseCollateralToken = result.collateralToken;
  let parentOutcomeToken = undefined;
  if (isConditional && parentMarketAddress) {
    const parent = await marketView.getMarket(MARKET_FACTORY, parentMarketAddress);
    baseCollateralToken = parent.collateralToken;
    if (parent.wrappedTokens && parent.wrappedTokens[parentOutcomeIndex]) {
      parentOutcomeToken = parent.wrappedTokens[parentOutcomeIndex];
    }
  }

  return {
    id: result.id,
    name: result.marketName,
    collateralToken: baseCollateralToken, // base collateral = sUSDS for conditional markets
    wrappedTokens: result.wrappedTokens,
    parentMarketAddress,
    parentOutcomeToken,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n📋 Wallet address : ${wallet.address}`);
  console.log(`📋 DRY_RUN        : ${DRY_RUN}`);
  console.log(`📋 TOTAL_SUSDS    : ${formatUnits(TOTAL_SUSDS, 18)}`);
  console.log(`📋 PER_POOL       : ${formatUnits(PER_POOL, 18)}\n`);

  const positionManager = new ethers.Contract(POSITION_MANAGER_ADDRESS, POSITION_MANAGER_ABI, provider);
  const marketView = new ethers.Contract(MARKET_VIEW, MarketViewAbi, provider);

  // ── Phase 0: build repo → tokens/markets/positions map ───────────────────
  // Derived from markets.js + static on-chain market metadata + add-back-execution.json,
  // so it is cached to disk after the first resolve and reused on later runs
  // (e.g. the live run reuses the dry-run cache instead of re-querying ~98
  // markets over RPC). Delete MAP_CACHE_FILE to force a fresh resolve.
  let repos; // [{ childMarket, parentOutcomeToken, outcomeTokens[], positions[] }]

  if (fs.existsSync(MAP_CACHE_FILE)) {
    repos = JSON.parse(fs.readFileSync(MAP_CACHE_FILE, "utf8"));
    console.log(`🔍 Phase 0: loaded ${repos.length} repos from cache ${MAP_CACHE_FILE}`);
    console.log(`   (delete ${MAP_CACHE_FILE} to re-resolve from chain)`);
  } else {
    console.log("🔍 Phase 0: resolving child markets and matching positions...\n");

    const addBack = JSON.parse(fs.readFileSync(ADD_BACK_FILE, "utf8"));
    // poolKey "token0Lower-token1Lower" → { positionId, token0, token1 }
    const poolToPosition = new Map();
    for (const e of addBack) {
      const [a, b] = sortTokens(e.token0, e.token1);
      poolToPosition.set(`${a.toLowerCase()}-${b.toLowerCase()}`, {
        positionId: e.positionId,
        token0: a,
        token1: b,
      });
    }

    repos = [];
    const matchedPoolKeys = new Set();
    let parentMismatch = 0;

    for (const m of markets) {
      const info = await getMarketInfo(marketView, m.marketId);

      if (!info.parentMarketAddress || info.parentOutcomeToken === undefined) {
        console.log(`  ⚠️  ${m.marketId}: not a conditional market — skipping`);
        continue;
      }
      if (info.parentMarketAddress.toLowerCase() !== PARENT_MARKET_ADDRESS.toLowerCase()) {
        console.log(
          `  ⚠️  ${m.marketId}: parent ${info.parentMarketAddress} ≠ expected ${PARENT_MARKET_ADDRESS} — skipping`
        );
        parentMismatch++;
        continue;
      }

      const parentOutcomeToken = info.parentOutcomeToken;
      const outcomeTokens = info.wrappedTokens.slice(0, -1); // drop Invalid

      const positions = [];
      for (const outcome of outcomeTokens) {
        const [a, b] = sortTokens(outcome, parentOutcomeToken);
        const key = `${a.toLowerCase()}-${b.toLowerCase()}`;
        const pos = poolToPosition.get(key);
        if (!pos) {
          console.log(
            `  ⚠️  ${m.marketId}: pool ${outcome}/${parentOutcomeToken} not found in ${ADD_BACK_FILE}`
          );
          continue;
        }
        matchedPoolKeys.add(key);
        positions.push({ ...pos, outcomeToken: outcome });
      }

      if (positions.length === 0) continue;
      repos.push({ childMarket: m.marketId, parentOutcomeToken, outcomeTokens, positions });
    }

    console.log(`   Parent-market mismatches    : ${parentMismatch}`);
    console.log(`   add-back positions unmatched: ${addBack.length - matchedPoolKeys.size}`);
    fs.writeFileSync(MAP_CACHE_FILE, JSON.stringify(repos, null, 2));
    console.log(`   Cached map → ${MAP_CACHE_FILE}`);
  }

  const totalPositions = repos.reduce((n, r) => n + r.positions.length, 0);
  console.log(`\n📊 Phase 0 summary:`);
  console.log(`   Repos with positions        : ${repos.length}`);
  console.log(`   Positions to top up         : ${totalPositions}`);

  if (repos.length === 0) {
    console.log("\n❌ No repos/positions matched — aborting.");
    process.exit(1);
  }

  // ── Projected mint deltas (per token, lowercased) ─────────────────────────
  // Parent split: +TOTAL_SUSDS to every parent outcome token we use.
  // Child split:  −PER_POOL parentOutcome, +PER_POOL Up, +PER_POOL Down per repo.
  const projected = new Map();
  const addProjected = (addr, delta) => {
    const k = addr.toLowerCase();
    projected.set(k, (projected.get(k) ?? 0n) + delta);
  };
  for (const r of repos) {
    addProjected(r.parentOutcomeToken, TOTAL_SUSDS - PER_POOL);
    for (const o of r.outcomeTokens) addProjected(o, PER_POOL);
  }

  const router = new ethers.Contract(ROUTER_ADDRESS, RouterAbi, wallet);

  if (SKIP_SPLITS) {
    console.log("\n⏭  Phases 1-2 skipped (SKIP_SPLITS=true) — assuming tokens already minted.");
  } else {
    // ── Phase 1: split sUSDS → parent outcome tokens ───────────────────────
    const susdsBalance = await getTokenBalance(SUSDS_ADDRESS);
    console.log(`\n💰 Phase 1: split sUSDS on parent market ${PARENT_MARKET_ADDRESS}`);
    console.log(`   sUSDS balance: ${formatUnits(susdsBalance, 18)} | need: ${formatUnits(TOTAL_SUSDS, 18)}`);
    if (!DRY_RUN && susdsBalance < TOTAL_SUSDS) {
      console.log("   ❌ Insufficient sUSDS — aborting.");
      process.exit(1);
    }

    if (!DRY_RUN) {
      // sanity-check router before sending value
      const ct = await router.conditionalTokens();
      if (!ct || ct === ethers.ZeroAddress) {
        console.log("   ❌ Router.conditionalTokens() is zero — wrong Router address? Aborting.");
        process.exit(1);
      }
      console.log(`   Router.conditionalTokens() = ${ct}`);

      await ensureAllowance(SUSDS_ADDRESS, ROUTER_ADDRESS, TOTAL_SUSDS);
      console.log("   Splitting sUSDS...");
      await retryTransaction(() => router.splitPosition(SUSDS_ADDRESS, PARENT_MARKET_ADDRESS, TOTAL_SUSDS));
    } else {
      console.log("   (dry run — no split sent)");
    }

    // ── Phase 2: split parent outcomes → Up/Down per repo ──────────────────
    console.log(`\n🪙 Phase 2: split ${formatUnits(PER_POOL, 18)} of each parent outcome into Up/Down`);
    for (const r of repos) {
      console.log(`   Repo ${r.childMarket} (collateral ${r.parentOutcomeToken})`);
      if (!DRY_RUN) {
        await ensureAllowance(r.parentOutcomeToken, ROUTER_ADDRESS, PER_POOL);
        // collateralToken arg = base collateral (sUSDS); Router pulls/unwraps the
        // parent outcome ERC20 because the child market has a non-zero parentCollectionId.
        await retryTransaction(() => router.splitPosition(SUSDS_ADDRESS, r.childMarket, PER_POOL));
        await new Promise((res) => setTimeout(res, 2000));
      } else {
        console.log("     (dry run — no split sent)");
      }
    }
  }

  // ── Phase 3: increase liquidity on each position ─────────────────────────
  console.log(`\n📈 Phase 3: increase liquidity on ${totalPositions} positions\n`);

  // Build the flat work list with on-chain tick ranges + pool state.
  const work = [];
  for (const r of repos) {
    for (const p of r.positions) {
      const pos = await positionManager.positions(BigInt(p.positionId));
      const token0 = new Token(CHAIN_ID, p.token0, 18, "T0");
      const token1 = new Token(CHAIN_ID, p.token1, 18, "T1");
      const poolAddress = Pool.getAddress(token0, token1, Number(pos.fee));
      const poolContract = new ethers.Contract(poolAddress, POOL_ABI, provider);
      const [slot0, poolLiquidity] = await Promise.all([poolContract.slot0(), poolContract.liquidity()]);
      const pool = new Pool(
        token0,
        token1,
        Number(pos.fee),
        slot0.sqrtPriceX96.toString(),
        poolLiquidity.toString(),
        Number(slot0.tick)
      );
      const position = Position.fromAmounts({
        pool,
        tickLower: Number(pos.tickLower),
        tickUpper: Number(pos.tickUpper),
        amount0: PER_POOL.toString(),
        amount1: PER_POOL.toString(),
        useFullPrecision: true,
      });
      work.push({
        positionId: p.positionId,
        token0: p.token0,
        token1: p.token1,
        tickLower: Number(pos.tickLower),
        tickUpper: Number(pos.tickUpper),
        currentLiquidity: pos.liquidity, // on-chain liquidity before this run
        pool,
        position,
        amount0Desired: BigInt(position.mintAmounts.amount0.toString()),
        amount1Desired: BigInt(position.mintAmounts.amount1.toString()),
      });
    }
  }

  // Spendable balance tracker (lowercased → BigInt). In a live run the splits
  // already ran, so on-chain balances reflect the mint. In a dry run nothing was
  // minted, so add the projected deltas to preview realistic amounts.
  const remaining = new Map();
  const involved = new Set();
  for (const w of work) {
    involved.add(w.token0.toLowerCase());
    involved.add(w.token1.toLowerCase());
  }
  for (const key of involved) {
    let bal = await getTokenBalance(key);
    if (DRY_RUN) bal += projected.get(key) ?? 0n;
    remaining.set(key, bal);
  }

  console.log("💰 Available (post-split) per token:");
  for (const [k, v] of remaining) console.log(`   ${k}: ${formatUnits(v, 18)}`);
  console.log("");

  // Approvals for PositionManager (skip in dry run)
  if (!DRY_RUN) {
    console.log("🔑 Approving tokens for PositionManager...");
    for (const key of involved) {
      await ensureAllowance(key, POSITION_MANAGER_ADDRESS, remaining.get(key));
    }
  }

  // Progress log (idempotent re-runs)
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
  const belowTarget = []; // positions whose final liquidity stays under 1.5x
  for (const item of work) {
    if (alreadyDone.has(String(item.positionId))) {
      console.log(`  ⏭  #${item.positionId}: already in progress log — skipping`);
      successCount++;
      continue;
    }

    const t0 = item.token0.toLowerCase();
    const t1 = item.token1.toLowerCase();
    const rem0 = remaining.get(t0) ?? 0n;
    const rem1 = remaining.get(t1) ?? 0n;

    let positionToUse = item.position;
    let use0 = item.amount0Desired;
    let use1 = item.amount1Desired;

    if (rem0 < item.amount0Desired || rem1 < item.amount1Desired) {
      if (rem0 === 0n || rem1 === 0n) {
        console.log(`  ⚠️  #${item.positionId}: one token exhausted — skipping`);
        skipped++;
        continue;
      }
      const capped0 = rem0 < item.amount0Desired ? rem0 : item.amount0Desired;
      const capped1 = rem1 < item.amount1Desired ? rem1 : item.amount1Desired;
      positionToUse = Position.fromAmounts({
        pool: item.pool,
        tickLower: item.tickLower,
        tickUpper: item.tickUpper,
        amount0: capped0.toString(),
        amount1: capped1.toString(),
        useFullPrecision: true,
      });
      if (JSBI.equal(positionToUse.liquidity, JSBI.BigInt(0))) {
        console.log(`  ⚠️  #${item.positionId}: capped amounts yield zero liquidity — skipping`);
        skipped++;
        continue;
      }
      use0 = BigInt(positionToUse.mintAmounts.amount0.toString());
      use1 = BigInt(positionToUse.mintAmounts.amount1.toString());
    }

    // 1.5x sanity check: does (current + added) reach the target multiple of current?
    const addedLiquidity = BigInt(positionToUse.liquidity.toString());
    const current = item.currentLiquidity;
    const finalLiquidity = current + addedLiquidity;
    const meetsTarget =
      current === 0n || finalLiquidity * MIN_FINAL_MULT_DEN >= current * MIN_FINAL_MULT_NUM;
    const ratioStr = current === 0n ? "∞" : (Number(finalLiquidity) / Number(current)).toFixed(2);
    if (!meetsTarget) belowTarget.push({ positionId: item.positionId, ratio: ratioStr });

    console.log(
      `\n--- Position #${item.positionId} | token0=${formatUnits(use0, 18)} token1=${formatUnits(use1, 18)}` +
        ` | final/current=${ratioStr}x ${meetsTarget ? "✅" : "⚠️ <1.5x"} ---`
    );

    if (DRY_RUN) {
      remaining.set(t0, rem0 - use0);
      remaining.set(t1, rem1 - use1);
      successCount++;
      continue;
    }

    try {
      const { calldata, value } = NonfungiblePositionManager.addCallParameters(positionToUse, {
        tokenId: item.positionId.toString(), // triggers increaseLiquidity
        slippageTolerance: new Percent(50, 10_000), // 0.5%
        deadline: Math.floor(Date.now() / 1000) + 60 * 20,
      });
      const receipt = await retryTransaction(() =>
        wallet.sendTransaction({ to: POSITION_MANAGER_ADDRESS, data: calldata, value })
      );

      remaining.set(t0, rem0 - use0);
      remaining.set(t1, rem1 - use1);

      progressLog.push({
        positionId: item.positionId,
        token0: item.token0,
        token1: item.token1,
        amount0Desired: use0.toString(),
        amount1Desired: use1.toString(),
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      });
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progressLog, null, 2));
      successCount++;
      console.log(`  ✅ Saved to ${PROGRESS_FILE}`);
    } catch (err) {
      console.error(`  ❌ Failed for #${item.positionId}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log(
    `\n🎯 1.5x liquidity check: ${work.length - belowTarget.length}/${work.length} positions reach ≥1.5x.`
  );
  if (belowTarget.length > 0) {
    console.log(`   ⚠️  ${belowTarget.length} below 1.5x:`);
    for (const b of belowTarget) console.log(`      #${b.positionId}: ${b.ratio}x`);
  }

  console.log(
    `\n🎉 Done! ${successCount} processed, ${skipped} skipped (insufficient balance).` +
      (DRY_RUN ? "\n   Dry run — set DRY_RUN = false to execute." : ` See ${PROGRESS_FILE}.`)
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
