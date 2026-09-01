// Read-only checker for the L1 unwind (withdraw-l1-liquidity.js + merge-l1-positions.js).
// Confirms every L1 position is drained, every logged tx actually succeeded on-chain,
// and reports what is left: residual outcome-token dust per market and the sUSDS balance.

import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import { erc20Abi, formatUnits } from "viem";
import { MarketViewAbi } from "./abis/MarketViewAbi.js";

const RPC_URL = process.env.RPC_URL;
const CHAIN_ID = 10;
const WALLET_ADDRESS = process.env.PRIVATE_KEY
  ? new ethers.Wallet(process.env.PRIVATE_KEY).address
  : "0x00DC3E0AcAdB8dBA21BB08fF30540222FF8836e0";

const POSITION_MANAGER_ADDRESS = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const SUSDS_ADDRESS = "0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0";
const MARKET_FACTORY = "0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6";
const MARKET_VIEW = "0x336695ec9efbafd6322fb82eaadbcda02e38f348";

const MARKET_A = "0x3220A208aAf4D2ceECDe5A2e21eC0C9145f40BA6";
const MARKET_B = "0xfea47428981f70110c64dd678889826c3627245b";

const WITHDRAW_LOG = "./withdraw-l1-liquidity-execution.json";
const MERGE_LOG = "./merge-l1-positions-execution.json";

const POSITION_MANAGER_ABI = [
  "function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function balanceOf(address owner) external view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)",
];

const provider = new ethers.JsonRpcProvider(RPC_URL);

function sortTokens(a, b) {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}
function pairKey(a, b) {
  return sortTokens(a, b)
    .map((x) => x.toLowerCase())
    .join("-");
}
async function runBatched(items, batchSize, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += batchSize) {
    out.push(...(await Promise.all(items.slice(i, i + batchSize).map(fn))));
    await new Promise((r) => setTimeout(r, 500));
  }
  return out;
}

async function main() {
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) {
    throw new Error(`RPC_URL points at chain ${net.chainId}, expected ${CHAIN_ID} (Optimism).`);
  }
  console.log(`\n📋 Wallet : ${WALLET_ADDRESS}`);

  const marketView = new ethers.Contract(MARKET_VIEW, MarketViewAbi, provider);
  const mA = await marketView.getMarket(MARKET_FACTORY, MARKET_A);
  const mB = await marketView.getMarket(MARKET_FACTORY, MARKET_B);
  const setA = [...mA.wrappedTokens];
  const setB = [...mB.wrappedTokens];

  const byPair = new Map();
  setA.forEach((t, i) => byPair.set(pairKey(t, SUSDS_ADDRESS), { market: "A", index: i }));
  setB.forEach((t, i) => byPair.set(pairKey(t, SUSDS_ADDRESS), { market: "B", index: i }));

  // ── 1. Every L1 position drained? ─────────────────────────────────────────
  const pm = new ethers.Contract(POSITION_MANAGER_ADDRESS, POSITION_MANAGER_ABI, provider);
  const bal = Number(await pm.balanceOf(WALLET_ADDRESS));
  const ids = await runBatched(
    Array.from({ length: bal }, (_, i) => i),
    20,
    (i) => pm.tokenOfOwnerByIndex(WALLET_ADDRESS, i)
  );
  const data = await runBatched(ids, 20, async (tokenId) => ({ tokenId, pos: await pm.positions(tokenId) }));
  const matched = data
    .map((x) => ({ ...x, meta: byPair.get(pairKey(x.pos.token0, x.pos.token1)) }))
    .filter((x) => x.meta);

  const stillFunded = matched.filter((x) => x.pos.liquidity > 0n);
  const owedFees = matched.filter((x) => x.pos.tokensOwed0 > 0n || x.pos.tokensOwed1 > 0n);
  console.log(`\n📉 L1 positions : ${matched.length} matched of ${bal} NFTs held`);
  console.log(`   drained (liquidity = 0)  : ${matched.length - stillFunded.length}`);
  console.log(`   still funded             : ${stillFunded.length}`);
  console.log(`   with uncollected fees    : ${owedFees.length}`);
  for (const x of stillFunded) {
    console.log(`     ⚠️  #${x.tokenId} [${x.meta.market}${x.meta.index}] liquidity ${formatUnits(x.pos.liquidity, 18)}`);
  }

  // ── 2. Logged transactions actually succeeded? ────────────────────────────
  for (const [label, file] of [
    ["withdraw", WITHDRAW_LOG],
    ["merge", MERGE_LOG],
  ]) {
    if (!fs.existsSync(file)) {
      console.log(`\n📄 ${label}: ${file} not found (not run yet?)`);
      continue;
    }
    const log = JSON.parse(fs.readFileSync(file, "utf8"));
    const hashes = log.map((e) => e.txHash).filter(Boolean);
    const receipts = await runBatched(hashes, 20, (h) => provider.getTransactionReceipt(h));
    const reverted = receipts.filter((r) => r && r.status !== 1).length;
    const pending = receipts.filter((r) => !r).length;
    console.log(`\n📄 ${label}: ${log.length} entries | ok ${hashes.length - reverted - pending} | reverted ${reverted} | pending ${pending}`);
  }

  // ── 3. Residual balances ──────────────────────────────────────────────────
  const readBal = (tokens) =>
    runBatched(tokens, 20, (t) => new ethers.Contract(t, erc20Abi, provider).balanceOf(WALLET_ADDRESS));
  const balA = await readBal(setA);
  const balB = await readBal(setB);
  const sum = (arr) => arr.reduce((a, x) => a + x, 0n);
  const nonZero = (arr) => arr.filter((x) => x > 0n).length;

  console.log(`\n🧾 Residual outcome tokens (stranded until the markets resolve):`);
  console.log(`   Market A : ${formatUnits(sum(balA), 18)} across ${nonZero(balA)}/${balA.length} outcomes`);
  console.log(`   Market B : ${formatUnits(sum(balB), 18)} across ${nonZero(balB)}/${balB.length} outcomes`);

  const susds = new ethers.Contract(SUSDS_ADDRESS, erc20Abi, provider);
  console.log(`\n💰 sUSDS balance : ${formatUnits(await susds.balanceOf(WALLET_ADDRESS), 18)}`);

  if (stillFunded.length === 0) {
    console.log(`\n🎉 All ${matched.length} L1 positions are fully drained.`);
  } else {
    console.log(`\n⚠️  ${stillFunded.length} position(s) still hold liquidity — re-run withdraw-l1-liquidity.js.`);
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
