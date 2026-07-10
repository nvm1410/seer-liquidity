import { CurrencyAmount, Percent, Token } from "@uniswap/sdk-core";
import { NonfungiblePositionManager, Pool, Position } from "@uniswap/v3-sdk";
import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import { erc20Abi, formatUnits } from "viem";
import { MarketViewAbi } from "./abis/MarketViewAbi.js";
import { RouterAbi } from "./abis/RouterAbi.js";
import { markets } from "./markets.js";

// ─────────────────────────────────────────────────────────────────────────────
// Unwinds ALL originality liquidity and reconstitutes sUSDS:
//   Phase 1 — remove 100% liquidity from every originality position (Up/Down vs
//             parent-outcome pools) → tokens come back to the wallet.
//   Phase 2 — for each repo, merge a full child set {Down, Up, Invalid} back into
//             that repo's parent-outcome token (Router.mergePositions on the child).
//   Phase 3 — merge the full parent set {all repo outcomes + parent Invalid} back
//             into sUSDS (Router.mergePositions on the parent market).
// Merging always needs a COMPLETE set including the Invalid outcome (never pooled
// but minted during the original split and held in the wallet) — see src/Router.sol
// _mergePositions / getPartition. Mergeable amount each step = min balance across
// the set; leftover/imbalance dust stays in the wallet.
// ─────────────────────────────────────────────────────────────────────────────

// ── Config ──────────────────────────────────────────────────────────────────
const DRY_RUN = false; // ← set to false to send transactions
const BURN_NFT = false; // ← set true to also burn each emptied position NFT in the remove tx

const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL;
const CHAIN_ID = 10;

// Addresses (Optimism, chain 10)
const POSITION_MANAGER_ADDRESS = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const ROUTER_ADDRESS = "0x179d8F8c811B8C759c33809dbc6c5ceDc62D05DD";
const PARENT_MARKET_ADDRESS = "0xdb3aae8d1c964767eeaa17805be25cded7a17210";
const SUSDS_ADDRESS = "0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0";
const MARKET_FACTORY = "0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6";
const MARKET_VIEW = "0x336695ec9efbafd6322fb82eaadbcda02e38f348";

const PROGRESS_FILE = "./remove-merge-originality-execution.json"; // Phase 1 removals
const ADD_BACK_FILE = "./add-back-execution.json"; // pool → positionId source
const MAP_CACHE_FILE = "./originality-merge-cache.json"; // resolved map (with Invalid)

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

// ── Helpers ──────────────────────────────────────────────────────────────────
function sortTokens(a, b) {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}
function bmin(arr) {
  return arr.reduce((m, x) => (x < m ? x : m));
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
  if (current >= amount) return;
  const token = new ethers.Contract(tokenAddress, erc20Abi, wallet);
  console.log(`    Approving ${tokenAddress} → ${spender} for ${formatUnits(amount, 18)} ...`);
  await retryTransaction(() => token.approve(spender, amount));
  await new Promise((r) => setTimeout(r, 2000));
}

// Resolves the parent-outcome token + FULL child outcome list (Down/Up/Invalid).
async function getMarketInfo(marketView, marketAddress) {
  const result = await marketView.getMarket(MARKET_FACTORY, marketAddress);
  const isConditional =
    result.parentCollectionId !==
    "0x0000000000000000000000000000000000000000000000000000000000000000";
  const parentMarketAddress =
    isConditional && result.parentMarket ? result.parentMarket.id : undefined;
  const parentOutcomeIndex = isConditional ? Number(result.parentOutcome) : undefined;

  let parentOutcomeToken = undefined;
  if (isConditional && parentMarketAddress) {
    const parent = await marketView.getMarket(MARKET_FACTORY, parentMarketAddress);
    if (parent.wrappedTokens && parent.wrappedTokens[parentOutcomeIndex]) {
      parentOutcomeToken = parent.wrappedTokens[parentOutcomeIndex];
    }
  }
  return {
    wrappedTokens: result.wrappedTokens, // FULL list incl. Invalid (last)
    parentMarketAddress,
    parentOutcomeToken,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n📋 Wallet : ${wallet.address}`);
  console.log(`📋 DRY_RUN : ${DRY_RUN}  |  BURN_NFT: ${BURN_NFT}\n`);

  const positionManager = new ethers.Contract(POSITION_MANAGER_ADDRESS, POSITION_MANAGER_ABI, provider);
  const marketView = new ethers.Contract(MARKET_VIEW, MarketViewAbi, provider);
  const router = new ethers.Contract(ROUTER_ADDRESS, RouterAbi, wallet);

  // ── Phase 0: resolve repos + parent set (cached) ─────────────────────────
  let parentWrappedTokens; // full parent outcome list incl. Invalid
  let repos; // [{ childMarket, parentOutcomeToken, wrappedTokens(full), positions[] }]

  if (fs.existsSync(MAP_CACHE_FILE)) {
    const cache = JSON.parse(fs.readFileSync(MAP_CACHE_FILE, "utf8"));
    parentWrappedTokens = cache.parentWrappedTokens;
    repos = cache.repos;
    console.log(`🔍 Phase 0: loaded map from cache ${MAP_CACHE_FILE} (delete to re-resolve)`);
  } else {
    console.log("🔍 Phase 0: resolving markets (this queries ~98 markets)...");
    const parent = await marketView.getMarket(MARKET_FACTORY, PARENT_MARKET_ADDRESS);
    parentWrappedTokens = parent.wrappedTokens;

    const addBack = JSON.parse(fs.readFileSync(ADD_BACK_FILE, "utf8"));
    const poolToPosition = new Map();
    for (const e of addBack) {
      const [a, b] = sortTokens(e.token0, e.token1);
      poolToPosition.set(`${a.toLowerCase()}-${b.toLowerCase()}`, { positionId: e.positionId, token0: a, token1: b });
    }

    repos = [];
    for (const m of markets) {
      const info = await getMarketInfo(marketView, m.marketId);
      if (!info.parentMarketAddress || info.parentOutcomeToken === undefined) continue;
      if (info.parentMarketAddress.toLowerCase() !== PARENT_MARKET_ADDRESS.toLowerCase()) continue;

      const positions = [];
      for (const outcome of info.wrappedTokens.slice(0, -1)) {
        const [a, b] = sortTokens(outcome, info.parentOutcomeToken);
        const pos = poolToPosition.get(`${a.toLowerCase()}-${b.toLowerCase()}`);
        if (pos) positions.push(pos);
      }
      if (positions.length === 0) continue;
      repos.push({
        childMarket: m.marketId,
        parentOutcomeToken: info.parentOutcomeToken,
        wrappedTokens: info.wrappedTokens, // [Down, Up, Invalid]
        positions,
      });
    }
    fs.writeFileSync(MAP_CACHE_FILE, JSON.stringify({ parentWrappedTokens, repos }, null, 2));
    console.log(`   Cached map → ${MAP_CACHE_FILE}`);
  }

  const totalPositions = repos.reduce((n, r) => n + r.positions.length, 0);
  console.log(`   Repos: ${repos.length} | positions: ${totalPositions} | parent outcomes: ${parentWrappedTokens.length}\n`);

  // ── Phase 1: remove 100% liquidity ───────────────────────────────────────
  console.log("📉 Phase 1: remove 100% liquidity from every originality position\n");

  let progressLog = [];
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      progressLog = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
    } catch {
      progressLog = [];
    }
  }
  const alreadyRemoved = new Set(progressLog.map((e) => String(e.positionId)));

  const withdraw = new Map(); // lowercased token → projected amount returned (dry-run preview)
  const addWithdraw = (addr, amt) => withdraw.set(addr.toLowerCase(), (withdraw.get(addr.toLowerCase()) ?? 0n) + amt);

  let removed = 0;
  let skippedEmpty = 0;
  for (const r of repos) {
    for (const p of r.positions) {
      if (alreadyRemoved.has(String(p.positionId))) {
        removed++;
        continue;
      }
      const pos = await positionManager.positions(BigInt(p.positionId));
      if (pos.liquidity === 0n) {
        skippedEmpty++;
        continue;
      }

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
      const sdkPosition = new Position({
        pool,
        liquidity: pos.liquidity.toString(),
        tickLower: Number(pos.tickLower),
        tickUpper: Number(pos.tickUpper),
      });

      // projected tokens returned (principal) for the dry-run merge preview
      const out0 = BigInt(sdkPosition.amount0.quotient.toString());
      const out1 = BigInt(sdkPosition.amount1.quotient.toString());
      addWithdraw(p.token0, out0);
      addWithdraw(p.token1, out1);

      console.log(
        `  #${p.positionId}: liquidity=${formatUnits(pos.liquidity, 18)} → ~${formatUnits(out0, 18)} / ~${formatUnits(out1, 18)}`
      );

      if (!DRY_RUN) {
        const removeOptions = {
          deadline: Math.floor(Date.now() / 1000) + 60 * 20,
          slippageTolerance: new Percent(50, 10_000), // 0.5%
          tokenId: p.positionId.toString(),
          liquidityPercentage: new Percent(1, 1), // 100%
          collectOptions: {
            expectedCurrencyOwed0: CurrencyAmount.fromRawAmount(token0, 0),
            expectedCurrencyOwed1: CurrencyAmount.fromRawAmount(token1, 0),
            recipient: wallet.address,
          },
          ...(BURN_NFT ? { burnToken: true } : {}),
        };
        const { calldata, value } = NonfungiblePositionManager.removeCallParameters(sdkPosition, removeOptions);
        const receipt = await retryTransaction(() =>
          wallet.sendTransaction({ to: POSITION_MANAGER_ADDRESS, data: calldata, value })
        );
        progressLog.push({
          positionId: p.positionId,
          token0: p.token0,
          token1: p.token1,
          removedLiquidity: pos.liquidity.toString(),
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
        });
        fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progressLog, null, 2));
        await new Promise((res) => setTimeout(res, 2000));
      }
      removed++;
    }
  }
  console.log(`\n   Removed/queued: ${removed} | already-empty skipped: ${skippedEmpty}`);

  // ── Balance model: dry run projects (current + withdrawn); live reads chain.
  const proj = new Map(); // lowercased → BigInt (dry-run only)
  if (DRY_RUN) {
    const all = new Set();
    for (const r of repos) for (const t of r.wrappedTokens) all.add(t.toLowerCase());
    for (const t of parentWrappedTokens) all.add(t.toLowerCase());
    for (const t of all) {
      const cur = await getTokenBalance(t);
      proj.set(t, cur + (withdraw.get(t) ?? 0n));
    }
  }
  const effBal = async (addr) => (DRY_RUN ? proj.get(addr.toLowerCase()) ?? 0n : getTokenBalance(addr));

  // ── Phase 2: merge each child set {Down, Up, Invalid} → parent outcome ────
  console.log(`\n🔗 Phase 2: merge child sets back into parent-outcome tokens`);
  let childMerges = 0;
  for (const r of repos) {
    const set = r.wrappedTokens; // [Down, Up, Invalid]
    const bals = await Promise.all(set.map(effBal));
    const amount = bmin(bals);
    console.log(
      `  ${r.childMarket}: min set balance = ${formatUnits(amount, 18)}` +
        ` (D=${formatUnits(bals[0], 18)} U=${formatUnits(bals[1], 18)} Inv=${formatUnits(bals[2], 18)})`
    );
    if (amount === 0n) {
      console.log("     ⚠️  one outcome is zero — cannot merge this repo");
      continue;
    }
    if (!DRY_RUN) {
      for (const t of set) await ensureAllowance(t, ROUTER_ADDRESS, amount);
      await retryTransaction(() => router.mergePositions(SUSDS_ADDRESS, r.childMarket, amount));
      await new Promise((res) => setTimeout(res, 2000));
    } else {
      // project: burn the set, mint parent-outcome token
      for (const t of set) proj.set(t.toLowerCase(), (proj.get(t.toLowerCase()) ?? 0n) - amount);
      const k = r.parentOutcomeToken.toLowerCase();
      proj.set(k, (proj.get(k) ?? 0n) + amount);
    }
    childMerges++;
  }
  console.log(`   Child merges: ${childMerges}/${repos.length}`);

  // ── Phase 3: merge full parent set → sUSDS ───────────────────────────────
  console.log(`\n🔗 Phase 3: merge full parent set (${parentWrappedTokens.length} outcomes incl. Invalid) → sUSDS`);
  const parentBals = await Promise.all(parentWrappedTokens.map(effBal));
  const parentAmount = bmin(parentBals);
  const zeroOutcomes = parentBals.filter((b) => b === 0n).length;
  console.log(`   min parent-outcome balance = ${formatUnits(parentAmount, 18)} | outcomes at zero: ${zeroOutcomes}`);
  if (parentAmount === 0n) {
    console.log("   ⚠️  at least one parent outcome is zero — cannot merge to sUSDS (check balances above).");
  } else {
    if (!DRY_RUN) {
      for (const t of parentWrappedTokens) await ensureAllowance(t, ROUTER_ADDRESS, parentAmount);
      await retryTransaction(() => router.mergePositions(SUSDS_ADDRESS, PARENT_MARKET_ADDRESS, parentAmount));
    }
    console.log(`   ✅ ${DRY_RUN ? "would recover" : "recovered"} ≈ ${formatUnits(parentAmount, 18)} sUSDS`);
  }

  console.log(
    `\n🎉 Done.` +
      (DRY_RUN
        ? " Dry run — set DRY_RUN = false to execute.\n   (Amounts are projections; leftover dust from imbalanced sets stays in the wallet.)"
        : ` Removals logged to ${PROGRESS_FILE}.`)
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
