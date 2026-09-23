// Withdraw 100% of the liquidity this wallet holds in the "L1" outcome-token / sUSDS
// pools on Optimism (chain 10), collecting accrued fees in the same transaction.
//
// The L1 pools are fed by TWO nested markets:
//   Market A (top-level, sUSDS collateral)      - 68 outcomes, 67 pooled vs sUSDS
//   Market B (conditional on A's outcome #66)   - 33 outcomes, all 33 pooled vs sUSDS
// A's outcome #66 (OTHER_TOKEN, "Other repositories...") is the only A outcome with no
// sUSDS pool - its whole supply was split into Market B.
//
// Scope is resolved FROM CHAIN via MarketView, and positions are discovered by
// enumerating the wallet's ERC-721 balance - not from a hard-coded tokenId list - so
// anything minted after execution.json was written is still caught. execution.json is
// used only as a cross-check.
//
// This returns outcome tokens + sUSDS to the wallet. It does NOT convert the outcome
// tokens back to sUSDS - that is merge-l1-positions.js (B first, then A).
//
// Run with DRY_RUN = true first: it lists every matched position, its liquidity and the
// projected token amounts without sending anything.

import { CurrencyAmount, Percent, Token } from "@uniswap/sdk-core";
import { NonfungiblePositionManager, Pool, Position } from "@uniswap/v3-sdk";
import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import { formatUnits } from "viem";
import { MarketViewAbi } from "./abis/MarketViewAbi.js";

// ── Config ──────────────────────────────────────────────────────────────────
const DRY_RUN = true; // ← set to false to send transactions
const BURN_NFT = false; // keep the NFTs so a future round can increaseLiquidity them
const COLLECT_EMPTY = true; // sweep fees off matched positions already at zero liquidity

const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL; // Optimism
const CHAIN_ID = 10;

const SOURCE_FILE = "./execution.json"; // 198 known L1 positions — cross-check only
const PROGRESS_FILE = "./withdraw-l1-liquidity-execution.json";

// Addresses (Optimism, chain 10)
const POSITION_MANAGER_ADDRESS = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const SUSDS_ADDRESS = "0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0";
const MARKET_FACTORY = "0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6";
const MARKET_VIEW = "0x336695ec9efbafd6322fb82eaadbcda02e38f348";

const MARKET_A = "0x3220A208aAf4D2ceECDe5A2e21eC0C9145f40BA6";
const MARKET_B = "0xfea47428981f70110c64dd678889826c3627245b";
const OTHER_TOKEN = "0x63a4F76ef5846F68D069054C271465B7118e8ed9";

const DELAY_MS = 2000;
const MAX_UINT128 = (1n << 128n) - 1n;

// ── ABIs ────────────────────────────────────────────────────────────────────
const POSITION_MANAGER_ABI = [
  "function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function balanceOf(address owner) external view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) external payable returns (uint256 amount0, uint256 amount1)",
];

const POOL_ABI = [
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() external view returns (uint128)",
];

// ── Provider / wallet ───────────────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

// ── Helpers (mirror withdraw-zcash-liquidity.js) ────────────────────────────
function sortTokens(a, b) {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

function pairKey(a, b) {
  return sortTokens(a, b)
    .map((x) => x.toLowerCase())
    .join("-");
}

async function runBatched(items, batchSize, asyncFn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    results.push(...(await Promise.all(batch.map(asyncFn))));
    await new Promise((r) => setTimeout(r, 1000));
  }
  return results;
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

// Build the SDK Position for an on-chain position (needed for both preview and removal).
async function buildSdkPosition(pos) {
  const token0 = new Token(CHAIN_ID, pos.token0, 18, "TOKEN0");
  const token1 = new Token(CHAIN_ID, pos.token1, 18, "TOKEN1");
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
  const sdkPosition = new Position({
    pool,
    liquidity: pos.liquidity.toString(),
    tickLower: Number(pos.tickLower),
    tickUpper: Number(pos.tickUpper),
  });
  return { token0, token1, sdkPosition };
}

// Remove 100% of a position's liquidity and collect everything to the wallet.
async function withdrawPosition(positionId, pos) {
  const { token0, token1, sdkPosition } = await buildSdkPosition(pos);

  const { calldata, value } = NonfungiblePositionManager.removeCallParameters(sdkPosition, {
    deadline: Math.floor(Date.now() / 1000) + 60 * 20,
    slippageTolerance: new Percent(50, 10_000), // 0.5%
    tokenId: positionId.toString(),
    liquidityPercentage: new Percent(1, 1), // 100% — withdraw all liquidity
    collectOptions: {
      tokenId: positionId.toString(),
      expectedCurrencyOwed0: CurrencyAmount.fromRawAmount(token0, 0),
      expectedCurrencyOwed1: CurrencyAmount.fromRawAmount(token1, 0),
      recipient: wallet.address,
    },
    ...(BURN_NFT ? { burnToken: true } : {}),
  });

  const receipt = await retryTransaction(() =>
    wallet.sendTransaction({ to: POSITION_MANAGER_ADDRESS, data: calldata, value })
  );

  return {
    liquidity: pos.liquidity.toString(),
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n📋 Wallet  : ${wallet.address}`);
  console.log(`📋 DRY_RUN : ${DRY_RUN}  |  BURN_NFT: ${BURN_NFT}  |  COLLECT_EMPTY: ${COLLECT_EMPTY}`);

  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) {
    throw new Error(`RPC_URL points at chain ${net.chainId}, expected ${CHAIN_ID} (Optimism).`);
  }

  const susdsLower = SUSDS_ADDRESS.toLowerCase();
  const otherLower = OTHER_TOKEN.toLowerCase();

  // ── Step 1: resolve both markets from chain ───────────────────────────────
  console.log("\n🔍 Step 1: resolving markets A and B from chain...");
  const marketView = new ethers.Contract(MARKET_VIEW, MarketViewAbi, provider);
  const mA = await marketView.getMarket(MARKET_FACTORY, MARKET_A);
  const mB = await marketView.getMarket(MARKET_FACTORY, MARKET_B);

  if (mA.collateralToken.toLowerCase() !== susdsLower) {
    throw new Error(`Market A collateral ${mA.collateralToken} != sUSDS`);
  }
  if (mB.parentMarket?.id?.toLowerCase() !== MARKET_A.toLowerCase()) {
    throw new Error(`Market B's parent is ${mB.parentMarket?.id}, expected ${MARKET_A}`);
  }
  if (mA.wrappedTokens[Number(mB.parentOutcome)]?.toLowerCase() !== otherLower) {
    throw new Error(`Market B's parent outcome token is not ${OTHER_TOKEN}`);
  }
  console.log(`   Market A ${MARKET_A}: ${mA.wrappedTokens.length} outcomes`);
  console.log(`   Market B ${MARKET_B}: ${mB.wrappedTokens.length} outcomes (parentOutcome ${mB.parentOutcome})`);

  // pairKey(outcome, sUSDS) → metadata. OTHER_TOKEN has no pool; harmless to include.
  const byPair = new Map();
  const addMarket = (m, label, info) => {
    info.wrappedTokens.forEach((tok, i) => {
      byPair.set(pairKey(tok, SUSDS_ADDRESS), {
        market: label,
        marketAddress: m,
        index: i,
        outcomeToken: tok,
        name: info.outcomes?.[i] ?? `outcome${i}`,
      });
    });
  };
  addMarket(MARKET_A, "A", mA);
  addMarket(MARKET_B, "B", mB);
  console.log(`   ${byPair.size} candidate pools (all outcomes of A + B vs sUSDS)`);

  // ── Step 2: discover positions by ERC-721 enumeration ─────────────────────
  console.log("\n🔍 Step 2: scanning wallet positions...");
  const positionManager = new ethers.Contract(POSITION_MANAGER_ADDRESS, POSITION_MANAGER_ABI, wallet);
  const balance = await positionManager.balanceOf(wallet.address);
  console.log(`   Wallet holds ${Number(balance)} position NFTs.`);

  const indexes = Array.from({ length: Number(balance) }, (_, i) => i);
  const tokenIds = await runBatched(indexes, 20, (i) => positionManager.tokenOfOwnerByIndex(wallet.address, i));
  const positionsData = await runBatched(tokenIds, 20, async (tokenId) => ({
    tokenId,
    pos: await positionManager.positions(tokenId),
  }));

  const matched = positionsData
    .map(({ tokenId, pos }) => ({ tokenId, pos, meta: byPair.get(pairKey(pos.token0, pos.token1)) }))
    .filter((x) => x.meta)
    .sort((a, b) => (a.tokenId < b.tokenId ? -1 : 1));

  const withLiquidity = matched.filter((x) => x.pos.liquidity > 0n);
  const emptyWithFees = matched.filter(
    (x) => x.pos.liquidity === 0n && (x.pos.tokensOwed0 > 0n || x.pos.tokensOwed1 > 0n)
  );
  const emptyClean = matched.length - withLiquidity.length - emptyWithFees.length;

  const countA = matched.filter((x) => x.meta.market === "A").length;
  const countB = matched.filter((x) => x.meta.market === "B").length;
  const distinctPools = new Set(matched.map((x) => x.meta.outcomeToken.toLowerCase())).size;
  console.log(
    `   Matched ${matched.length} L1 positions (A: ${countA}, B: ${countB}) across ${distinctPools} distinct pools\n` +
      `   ${withLiquidity.length} with liquidity > 0 | ${emptyWithFees.length} empty with uncollected fees | ${emptyClean} empty and clean`
  );

  // ── Step 2b: cross-check against the known 198 from execution.json ────────
  if (fs.existsSync(SOURCE_FILE)) {
    const source = JSON.parse(fs.readFileSync(SOURCE_FILE, "utf8"));
    const known = new Set(source.map((e) => String(e.positionId)));
    const found = new Set(matched.map((x) => x.tokenId.toString()));
    const missing = [...known].filter((id) => !found.has(id));
    const extra = [...found].filter((id) => !known.has(id));
    console.log(`\n   Cross-check vs ${SOURCE_FILE} (${known.size} known L1 positions):`);
    console.log(`     missing from wallet/scan : ${missing.length}${missing.length ? " → " + missing.join(", ") : ""}`);
    console.log(`     found but not in file    : ${extra.length}${extra.length ? " → " + extra.join(", ") : ""}`);
  }

  if (withLiquidity.length === 0 && emptyWithFees.length === 0) {
    console.log("\n✅ Nothing to withdraw — no L1 positions with liquidity or owed fees.");
    return;
  }

  // ── Step 3: projected returns (drives the dry-run decision) ───────────────
  console.log("\n🔍 Step 3: computing projected returns...");
  const projected = new Map(); // token (lower) → BigInt returned
  const add = (addr, amt) => projected.set(addr.toLowerCase(), (projected.get(addr.toLowerCase()) ?? 0n) + amt);

  let totalLiquidity = 0n;
  for (const item of withLiquidity) {
    const { sdkPosition } = await buildSdkPosition(item.pos);
    const out0 = BigInt(sdkPosition.amount0.quotient.toString());
    const out1 = BigInt(sdkPosition.amount1.quotient.toString());
    add(item.pos.token0, out0 + item.pos.tokensOwed0);
    add(item.pos.token1, out1 + item.pos.tokensOwed1);
    totalLiquidity += item.pos.liquidity;
    item.projected = { out0, out1 };
  }
  for (const item of emptyWithFees) {
    add(item.pos.token0, item.pos.tokensOwed0);
    add(item.pos.token1, item.pos.tokensOwed1);
  }

  const f = (v) => Number(formatUnits(v, 18)).toFixed(4).padStart(14);
  console.log("\n    tokenId   mkt  #   outcome                        liquidity      outcome-out       sUSDS-out");
  for (const item of [...withLiquidity, ...emptyWithFees]) {
    const isT0Susds = item.pos.token0.toLowerCase() === susdsLower;
    const p = item.projected ?? { out0: 0n, out1: 0n };
    const outcomeOut = (isT0Susds ? p.out1 : p.out0) + (isT0Susds ? item.pos.tokensOwed1 : item.pos.tokensOwed0);
    const susdsOut = (isT0Susds ? p.out0 : p.out1) + (isT0Susds ? item.pos.tokensOwed0 : item.pos.tokensOwed1);
    console.log(
      `   ${item.tokenId.toString().padEnd(9)} ${item.meta.market}  ${String(item.meta.index).padStart(2)}  ` +
        `${item.meta.name.slice(0, 28).padEnd(28)}${f(item.pos.liquidity)}${f(outcomeOut)}${f(susdsOut)}`
    );
  }

  const susdsOutTotal = projected.get(susdsLower) ?? 0n;
  let outcomeOutTotal = 0n;
  for (const [k, v] of projected) if (k !== susdsLower) outcomeOutTotal += v;
  console.log(
    `\n   Total liquidity to remove : ${formatUnits(totalLiquidity, 18)}\n` +
      `   sUSDS returned directly   : ${formatUnits(susdsOutTotal, 18)}\n` +
      `   Outcome tokens returned   : ${formatUnits(outcomeOutTotal, 18)} across ${projected.size - 1} tokens\n` +
      `   (the outcome tokens convert to sUSDS only via merge-l1-positions.js, capped by\n` +
      `    the smallest balance in each market's full outcome set)`
  );

  if (DRY_RUN) {
    console.log("\n✅ Dry run complete — set DRY_RUN = false to execute.");
    return;
  }

  // ── Step 4: remove 100% liquidity + collect ───────────────────────────────
  let progressLog = [];
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      progressLog = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
    } catch {
      progressLog = [];
    }
  }
  const alreadyDone = new Set(progressLog.map((e) => e.positionId));
  const save = () => fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progressLog, null, 2));

  console.log(`\n📉 Step 4: withdrawing ${withLiquidity.length} positions\n`);
  let successCount = 0;
  let failCount = 0;
  for (const { tokenId, pos, meta } of withLiquidity) {
    const id = tokenId.toString();
    if (alreadyDone.has(id)) {
      console.log(`  ⏭  #${id}: already in progress log`);
      successCount++;
      continue;
    }
    console.log(`\n--- #${id} [${meta.market}${meta.index}] ${meta.name.slice(0, 40)} ---`);
    try {
      const entry = await withdrawPosition(tokenId, pos);
      progressLog.push({
        positionId: id,
        kind: "remove",
        market: meta.market,
        marketAddress: meta.marketAddress,
        outcomeIndex: meta.index,
        outcomeToken: meta.outcomeToken,
        token0: pos.token0,
        token1: pos.token1,
        ...entry,
      });
      save();
      successCount++;
      console.log(`  ✅ Saved to ${PROGRESS_FILE}`);
    } catch (err) {
      failCount++;
      console.error(`  ❌ Failed for #${id}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  // ── Step 5: sweep fees off positions that were already empty ──────────────
  if (COLLECT_EMPTY && emptyWithFees.length) {
    console.log(`\n🧹 Step 5: collecting fees from ${emptyWithFees.length} already-empty position(s)\n`);
    for (const { tokenId, meta } of emptyWithFees) {
      const id = tokenId.toString();
      if (alreadyDone.has(id)) {
        console.log(`  ⏭  #${id}: already in progress log`);
        continue;
      }
      console.log(`\n--- collect #${id} [${meta.market}${meta.index}] ---`);
      try {
        const receipt = await retryTransaction(() =>
          positionManager.collect({
            tokenId,
            recipient: wallet.address,
            amount0Max: MAX_UINT128,
            amount1Max: MAX_UINT128,
          })
        );
        progressLog.push({
          positionId: id,
          kind: "collect",
          market: meta.market,
          outcomeToken: meta.outcomeToken,
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
        });
        save();
        console.log(`  ✅ Saved to ${PROGRESS_FILE}`);
      } catch (err) {
        failCount++;
        console.error(`  ❌ Collect failed for #${id}: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  console.log(`\n🎉 Done! ${successCount}/${withLiquidity.length} positions withdrawn, ${failCount} failure(s).`);
  console.log(`   Progress: ${PROGRESS_FILE}`);
  console.log(
    "   The wallet now holds A/B outcome tokens + sUSDS. Next: node merge-l1-positions.js\n" +
      "   (merges Market B first — it mints the 'Other repositories' token Market A needs.)"
  );
  if (failCount) console.log("   Re-run to retry the failures — completed positions are skipped.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
