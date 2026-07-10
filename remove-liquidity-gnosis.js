// Removes ALL liquidity added by add-pd-liquidity-gnosis.js /
// add-pd-liquidity-gnosis-round2.js from the Gnosis PD market's Swapr
// (Algebra) pools, then merges the recovered outcome tokens back into sDAI.
//
//   Phase 1 — enumerate every Swapr NPM position owned by the wallet whose
//             pair is {sDAI, one of this market's wrapped tokens}, fully
//             decreaseLiquidity + collect each one (100% removal). This does
//             NOT touch the pool's price (only swaps move price).
//   Phase 2 — merge a full complete set (all of the market's wrapped tokens,
//             including "Invalid result") back into sDAI via
//             GnosisRouter.mergePositions. Mergeable amount = min balance
//             across the full set; any imbalance stays as ERC20 dust.
//
// Mirrors the structure of remove-merge-originality.js (Optimism/Uniswap V3),
// adapted for Gnosis/Swapr: positions are enumerated via ERC721Enumerable
// (tokenOfOwnerByIndex) instead of a static tokenId list, and
// decreaseLiquidity/collect/burn are hand-encoded for the Algebra NPM
// (createAndInitializePoolIfNecessary's sibling ABI — no fee tiers, so no
// Uniswap-SDK-generated calldata here either).

import { Percent, Token } from "@uniswap/sdk-core";
import { Pool, Position } from "@uniswap/v3-sdk";
import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import { erc20Abi, formatUnits } from "viem";
import { MarketViewAbi } from "./abis/MarketViewAbi.js";
import { RouterAbi } from "./abis/RouterAbi.js";

// ── Config ──────────────────────────────────────────────────────────────────
const DRY_RUN = true; // ← set to false to send transactions
const BURN_NFT = true; // ← also burn each emptied position NFT in the same tx

const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.GNOSIS_RPC_URL;
const CHAIN_ID = 100; // Gnosis

const MARKET = "0x7d386b7c41b8dab6179fc79cf7986a795305b815";
const PROGRESS_FILE = "./remove-pd-gnosis-execution.json";

// Addresses (Gnosis, chain 100) — same as add-pd-liquidity-gnosis.js.
const SWAPR_NPM_ADDRESS = "0x91fd594c46d8b01e62dbdebed2401dde01817834";
const GNOSIS_ROUTER_ADDRESS = "0xeC9048b59b3467415b1a38F63416407eA0c70fB8";
const SDAI_ADDRESS = "0xaf204776c7245bf4147c2612bf6e5972ee483701";
const MARKET_FACTORY = "0x83183DA839Ce8228E31Ae41222EaD9EDBb5cDcf1";
const MARKET_VIEW = "0x95493F3e3F151eD9ee9338a4Fc1f49c00890F59C";
const POOL_DEPLOYER = "0xC1b576AC6Ec749d5Ace1787bF9Ec6340908ddB47";
const INIT_CODE_HASH = "0xbce37a54eab2fcd71913a0d40723e04238970e7fc1159bfd58ad5b79531697e7";

// Math-only vehicle for @uniswap/v3-sdk (see add-pd-liquidity-gnosis.js) —
// fee 3000 maps to tickSpacing 60, matching Algebra. Never sent on-chain.
const MATH_FEE_TIER = 3000;
const SLIPPAGE_TOLERANCE = new Percent(50, 10_000); // 0.5%

const AlgebraPositionManagerAbi = [
  "function balanceOf(address owner) external view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)",
  "function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) external payable returns (uint256 amount0, uint256 amount1)",
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max) params) external payable returns (uint256 amount0, uint256 amount1)",
  "function burn(uint256 tokenId) external payable",
  "function multicall(bytes[] data) external payable returns (bytes[] results)",
];
const AlgebraPoolAbi = [
  "function globalState() external view returns (uint160 price, int24 tick, uint16 lastFee, uint8 pluginConfig, uint16 communityFee, bool unlocked)",
  "function liquidity() external view returns (uint128)",
];

const MAX_UINT128 = (1n << 128n) - 1n;

// ── Provider / wallet ───────────────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);
const algebraIface = new ethers.Interface(AlgebraPositionManagerAbi);
const npmRead = new ethers.Contract(SWAPR_NPM_ADDRESS, AlgebraPositionManagerAbi, provider);

function sortTokens(a, b) {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}
function bmin(arr) {
  return arr.reduce((m, x) => (x < m ? x : m));
}

function computePoolAddress(tokenA, tokenB) {
  const [t0, t1] = sortTokens(tokenA, tokenB);
  const salt = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [t0, t1]));
  return ethers.getCreate2Address(POOL_DEPLOYER, salt, INIT_CODE_HASH);
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

// Builds a Pool from the pool's CURRENT on-chain state (for accurate
// burnAmountsWithSlippage), keyed by outcome token so round-1 and round-2
// positions on the same pool share one read.
const poolCache = new Map();
async function getLivePool(outcomeToken) {
  const key = outcomeToken.toLowerCase();
  if (poolCache.has(key)) return poolCache.get(key);
  const [t0, t1] = sortTokens(outcomeToken, SDAI_ADDRESS);
  const poolAddress = computePoolAddress(t0, t1);
  const poolContract = new ethers.Contract(poolAddress, AlgebraPoolAbi, provider);
  const [gs, liq] = await Promise.all([poolContract.globalState(), poolContract.liquidity()]);
  const token0 = new Token(CHAIN_ID, t0, 18, "T0");
  const token1 = new Token(CHAIN_ID, t1, 18, "T1");
  const pool = new Pool(token0, token1, MATH_FEE_TIER, gs.price.toString(), liq.toString(), Number(gs.tick));
  poolCache.set(key, pool);
  return pool;
}

function buildRemoveCalldata(tokenId, position, amount0Min, amount1Min) {
  const decreaseCalldata = algebraIface.encodeFunctionData("decreaseLiquidity", [
    [tokenId, position.liquidity.toString(), amount0Min.toString(), amount1Min.toString(), Math.floor(Date.now() / 1000) + 60 * 20],
  ]);
  const collectCalldata = algebraIface.encodeFunctionData("collect", [
    [tokenId, wallet.address, MAX_UINT128.toString(), MAX_UINT128.toString()],
  ]);
  const calls = [decreaseCalldata, collectCalldata];
  if (BURN_NFT) calls.push(algebraIface.encodeFunctionData("burn", [tokenId]));
  return algebraIface.encodeFunctionData("multicall", [calls]);
}

async function getMarketOutcomes() {
  const marketView = new ethers.Contract(MARKET_VIEW, MarketViewAbi, provider);
  const result = await marketView.getMarket(MARKET_FACTORY, MARKET);
  return { outcomes: result.outcomes, wrappedTokens: result.wrappedTokens };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n📋 Wallet   : ${wallet.address}`);
  console.log(`📋 DRY_RUN  : ${DRY_RUN}  |  BURN_NFT: ${BURN_NFT}\n`);

  // ── Phase 0: resolve the market's full outcome set + our known tokens ──────
  console.log("🔍 Phase 0: resolving market outcomes...");
  const { outcomes, wrappedTokens } = await getMarketOutcomes();
  const nameByToken = new Map(wrappedTokens.map((t, i) => [t.toLowerCase(), outcomes[i]]));
  const knownOutcomeTokens = new Set(wrappedTokens.map((t) => t.toLowerCase()));
  console.log(`   Market has ${wrappedTokens.length} outcomes (full set, incl. "Invalid result")`);

  // ── Phase 1: enumerate every NPM position for this market's pools ──────────
  console.log("\n🔎 Phase 1a: enumerating wallet's Swapr NPM positions...");
  const balance = await npmRead.balanceOf(wallet.address);
  const tokenIds = [];
  for (let i = 0n; i < balance; i++) {
    tokenIds.push(await npmRead.tokenOfOwnerByIndex(wallet.address, i));
  }
  console.log(`   Wallet owns ${tokenIds.length} NPM position NFTs total`);

  const matched = [];
  for (const tokenId of tokenIds) {
    const pos = await npmRead.positions(tokenId);
    const t0 = pos.token0.toLowerCase();
    const t1 = pos.token1.toLowerCase();
    const isSdaiPair =
      (t0 === SDAI_ADDRESS.toLowerCase() && knownOutcomeTokens.has(t1)) ||
      (t1 === SDAI_ADDRESS.toLowerCase() && knownOutcomeTokens.has(t0));
    if (!isSdaiPair) continue;
    const outcomeToken = t0 === SDAI_ADDRESS.toLowerCase() ? pos.token1 : pos.token0;
    matched.push({
      tokenId,
      token0: pos.token0,
      token1: pos.token1,
      tickLower: Number(pos.tickLower),
      tickUpper: Number(pos.tickUpper),
      liquidity: pos.liquidity,
      name: nameByToken.get(outcomeToken.toLowerCase()) ?? outcomeToken,
    });
  }
  const withLiquidity = matched.filter((p) => p.liquidity > 0n);
  console.log(
    `   Matched ${matched.length} positions for this market | ` +
      `${withLiquidity.length} have liquidity > 0 (rest already emptied)`
  );

  // ── Phase 1b: remove 100% liquidity from each ───────────────────────────────
  console.log("\n📉 Phase 1b: removing 100% liquidity from each position\n");

  let progressLog = [];
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      progressLog = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
    } catch {
      progressLog = [];
    }
  }
  const alreadyRemoved = new Set(progressLog.map((e) => String(e.tokenId)));

  // Projected withdrawal per token (for dry-run balance projection).
  const withdrawByToken = new Map();
  const addWithdraw = (addr, amt) =>
    withdrawByToken.set(addr.toLowerCase(), (withdrawByToken.get(addr.toLowerCase()) ?? 0n) + amt);

  let removedCount = 0;
  for (const p of withLiquidity) {
    if (alreadyRemoved.has(String(p.tokenId))) {
      removedCount++;
      continue;
    }
    const pool = await getLivePool(p.token0.toLowerCase() === SDAI_ADDRESS.toLowerCase() ? p.token1 : p.token0);
    const position = new Position({
      pool,
      liquidity: p.liquidity.toString(),
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
    });
    const { amount0: amount0Min, amount1: amount1Min } = position.burnAmountsWithSlippage(SLIPPAGE_TOLERANCE);
    const expected0 = BigInt(position.amount0.quotient.toString());
    const expected1 = BigInt(position.amount1.quotient.toString());
    addWithdraw(p.token0, expected0);
    addWithdraw(p.token1, expected1);

    console.log(
      `  #${p.tokenId} (${p.name}): liquidity=${p.liquidity.toString()} → ` +
        `~${formatUnits(expected0, 18)} / ~${formatUnits(expected1, 18)}`
    );

    if (!DRY_RUN) {
      const data = buildRemoveCalldata(p.tokenId, position, amount0Min.quotient.toString(), amount1Min.quotient.toString());
      const receipt = await retryTransaction(() => wallet.sendTransaction({ to: SWAPR_NPM_ADDRESS, data, value: 0n }));
      progressLog.push({
        tokenId: p.tokenId.toString(),
        name: p.name,
        token0: p.token0,
        token1: p.token1,
        removedLiquidity: p.liquidity.toString(),
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      });
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progressLog, null, 2));
      await new Promise((r) => setTimeout(r, 2000));
    }
    removedCount++;
  }
  console.log(`\n   Removed/queued: ${removedCount}/${withLiquidity.length}`);

  // ── Balance model: dry run projects (current + withdrawn); live reads chain.
  const effBal = async (addr) => {
    const cur = await getTokenBalance(addr);
    return DRY_RUN ? cur + (withdrawByToken.get(addr.toLowerCase()) ?? 0n) : cur;
  };

  // ── Phase 2: merge the full complete set back into sDAI ─────────────────────
  console.log(`\n🔗 Phase 2: merge full outcome set (${wrappedTokens.length} incl. Invalid) → sDAI`);
  const bals = await Promise.all(wrappedTokens.map(effBal));
  const mergeAmount = bmin(bals);
  const zeroOutcomes = bals.filter((b) => b === 0n).length;
  console.log(
    `   min outcome balance = ${formatUnits(mergeAmount, 18)} | outcomes at zero: ${zeroOutcomes}\n` +
      bals.map((b, i) => `     ${outcomes[i].padEnd(16)} ${formatUnits(b, 18)}`).join("\n")
  );

  if (mergeAmount === 0n) {
    console.log("\n   ⚠️  at least one outcome is zero — cannot merge to sDAI (check balances above).");
  } else if (!DRY_RUN) {
    for (const t of wrappedTokens) await ensureAllowance(t, GNOSIS_ROUTER_ADDRESS, mergeAmount);
    const router = new ethers.Contract(GNOSIS_ROUTER_ADDRESS, RouterAbi, wallet);
    await retryTransaction(() => router.mergePositions(SDAI_ADDRESS, MARKET, mergeAmount));
    console.log(`   ✅ recovered ≈ ${formatUnits(mergeAmount, 18)} sDAI`);
  } else {
    console.log(`   ✅ would recover ≈ ${formatUnits(mergeAmount, 18)} sDAI`);
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
