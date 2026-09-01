// Convert the "L1" outcome tokens sitting in the wallet back into sUSDS, on Optimism
// (chain 10). Run this AFTER withdraw-l1-liquidity.js — that script returns the outcome
// tokens + sUSDS to the wallet but deliberately stops there.
//
// The L1 pools span two nested markets, so this is a two-step merge and THE ORDER
// MATTERS:
//
//   Phase 2 — merge Market B's full 33-outcome set  → mints A's outcome #66
//             ("Other repositories...", OTHER_TOKEN)
//   Phase 3 — merge Market A's full 68-outcome set (which now includes the OTHER_TOKEN
//             minted in phase 2) → sUSDS
//
// If A were merged first, its set would be short on OTHER_TOKEN and the whole unwind
// would be capped at whatever dust of it happened to be lying around.
//
// Router.mergePositions takes the BASE collateral (sUSDS) as its first argument for BOTH
// markets — the Router derives the right partition from the market's parentCollectionId.
// It burns an equal amount of EVERY outcome in the set, so the mergeable amount is
// min(balances) across the full set including Invalid. Whatever the market traded away
// is stranded in the wallet until resolution.
//
// Run with DRY_RUN = true first: it reads every balance and prints the exact per-outcome
// table without sending anything.

import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import { erc20Abi, formatUnits } from "viem";
import { MarketViewAbi } from "./abis/MarketViewAbi.js";
import { RouterAbi } from "./abis/RouterAbi.js";

// ── Config ──────────────────────────────────────────────────────────────────
const DRY_RUN = false; // ← set to false to send transactions

const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL; // Optimism
const CHAIN_ID = 10;

const PROGRESS_FILE = "./merge-l1-positions-execution.json";

// Addresses (Optimism, chain 10)
const ROUTER_ADDRESS = "0x179d8F8c811B8C759c33809dbc6c5ceDc62D05DD";
const SUSDS_ADDRESS = "0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0";
const MARKET_FACTORY = "0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6";
const MARKET_VIEW = "0x336695ec9efbafd6322fb82eaadbcda02e38f348";

const MARKET_A = "0x3220A208aAf4D2ceECDe5A2e21eC0C9145f40BA6";
const MARKET_B = "0xfea47428981f70110c64dd678889826c3627245b";
const OTHER_TOKEN = "0x63a4F76ef5846F68D069054C271465B7118e8ed9";

const DELAY_MS = 2000;

// ── Provider / wallet ───────────────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

// ── Helpers (mirror merge-zcash-positions.js / remove-merge-originality.js) ──
function bmin(values) {
  return values.reduce((a, b) => (b < a ? b : a));
}

async function runBatched(items, batchSize, asyncFn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    results.push(...(await Promise.all(batch.map(asyncFn))));
    await new Promise((r) => setTimeout(r, 500));
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

async function ensureAllowance(tokenAddress, spender, amount) {
  const ro = new ethers.Contract(tokenAddress, erc20Abi, provider);
  const current = await ro.allowance(wallet.address, spender);
  if (current >= amount) return false;
  const token = new ethers.Contract(tokenAddress, erc20Abi, wallet);
  console.log(`  Approving ${tokenAddress} -> ${spender} for ${formatUnits(amount, 18)} ...`);
  await retryTransaction(() => token.approve(spender, amount));
  await new Promise((r) => setTimeout(r, 2000));
  return true;
}

async function readBalances(tokens) {
  return runBatched(tokens, 20, (t) =>
    new ethers.Contract(t, erc20Abi, provider).balanceOf(wallet.address)
  );
}

// Print a per-outcome balance table and return {amount, leftover, minIndex}.
function report(label, info, balances) {
  const amount = bmin(balances);
  const minIndex = balances.findIndex((b) => b === amount);
  const leftover = balances.reduce((a, b) => a + (b - amount), 0n);
  const f = (v) => Number(formatUnits(v, 18)).toFixed(4).padStart(14);
  console.log(`\n   ${label}`);
  console.log("     #   outcome                                    balance      leftover");
  balances.forEach((b, i) => {
    const name = (info.outcomes?.[i] ?? `outcome${i}`).slice(0, 38);
    console.log(
      `    ${String(i).padStart(2)}   ${name.padEnd(38)}${f(b)}${f(b - amount)}` +
        (i === minIndex ? "   ← binding minimum" : "") +
        (b === 0n ? "  ⚠️  ZERO" : "")
    );
  });
  console.log(
    `\n     mergeable (min) : ${formatUnits(amount, 18)}\n` +
      `     stranded        : ${formatUnits(leftover, 18)} across ${balances.length} outcomes`
  );
  return { amount, leftover, minIndex };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n📋 Wallet  : ${wallet.address}`);
  console.log(`📋 DRY_RUN : ${DRY_RUN}`);

  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) {
    throw new Error(`RPC_URL points at chain ${net.chainId}, expected ${CHAIN_ID} (Optimism).`);
  }

  const susdsLower = SUSDS_ADDRESS.toLowerCase();
  const otherLower = OTHER_TOKEN.toLowerCase();

  const router = new ethers.Contract(ROUTER_ADDRESS, RouterAbi, wallet);
  const ct = await router.conditionalTokens();
  if (!ct || ct === ethers.ZeroAddress) {
    throw new Error("Router.conditionalTokens() is zero — wrong Router?");
  }

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
  const parentOutcome = Number(mB.parentOutcome);
  if (mA.wrappedTokens[parentOutcome]?.toLowerCase() !== otherLower) {
    throw new Error(`Market B's parent outcome token is not ${OTHER_TOKEN}`);
  }
  const setA = [...mA.wrappedTokens];
  const setB = [...mB.wrappedTokens];
  console.log(`   Market A ${MARKET_A}: ${setA.length} outcomes`);
  console.log(`   Market B ${MARKET_B}: ${setB.length} outcomes, parent = A #${parentOutcome} (${OTHER_TOKEN})`);

  const susds = new ethers.Contract(SUSDS_ADDRESS, erc20Abi, provider);
  const susdsBefore = await susds.balanceOf(wallet.address);

  // ── Step 2: read balances and preview both phases ─────────────────────────
  console.log("\n🔍 Step 2: reading balances...");
  const balB = await readBalances(setB);
  const balA = await readBalances(setA);

  const b = report(`Phase 2 — Market B (${setB.length} outcomes) → OTHER_TOKEN`, mB, balB);

  // Phase 3 sees A's balances plus whatever phase 2 mints onto OTHER_TOKEN.
  const projectedA = balA.map((v, i) => (i === parentOutcome ? v + b.amount : v));
  const a = report(
    `Phase 3 — Market A (${setA.length} outcomes) → sUSDS` +
      `  [#${parentOutcome} shown as balance + ${formatUnits(b.amount, 18)} from phase 2]`,
    mA,
    projectedA
  );

  console.log(
    `\n📊 Projected outcome:\n` +
      `   sUSDS recovered by merging : ${formatUnits(a.amount, 18)}\n` +
      `   sUSDS now                  : ${formatUnits(susdsBefore, 18)}\n` +
      `   sUSDS after                : ${formatUnits(susdsBefore + a.amount, 18)}\n` +
      `   stranded in market B       : ${formatUnits(b.leftover, 18)} outcome tokens\n` +
      `   stranded in market A       : ${formatUnits(a.leftover, 18)} outcome tokens\n` +
      `   (stranded tokens stay in the wallet and are redeemable once the markets resolve)`
  );

  if (b.amount === 0n) {
    console.log(
      `\n   ⚠️  Market B has a zero balance at outcome #${b.minIndex} — phase 2 cannot run,` +
        `\n       and phase 3 will then be capped by whatever OTHER_TOKEN is already held.`
    );
  }
  if (a.amount === 0n) {
    console.log(`\n   ⚠️  Market A has a zero balance at outcome #${a.minIndex} — nothing merges to sUSDS.`);
  }

  if (DRY_RUN) {
    console.log("\n✅ Dry run complete — set DRY_RUN = false to execute.");
    return;
  }

  // ── Step 3: execute, B first then A ───────────────────────────────────────
  let progressLog = [];
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      progressLog = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
    } catch {
      progressLog = [];
    }
  }
  const alreadyDone = new Set(progressLog.map((e) => e.market.toLowerCase()));
  const save = () => fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progressLog, null, 2));

  const runMerge = async (label, marketAddress, set, balances, amount) => {
    if (alreadyDone.has(marketAddress.toLowerCase())) {
      console.log(`\n⏭  ${label}: already in progress log — skipping`);
      return;
    }
    if (amount === 0n) {
      console.log(`\n⚠️  ${label}: mergeable amount is zero — skipping`);
      return;
    }
    console.log(`\n🔀 ${label}: merging ${formatUnits(amount, 18)} across ${set.length} outcomes`);
    let approvals = 0;
    for (const t of set) if (await ensureAllowance(t, ROUTER_ADDRESS, amount)) approvals++;
    console.log(`   ${approvals} new approval(s) sent, ${set.length - approvals} already sufficient`);
    const receipt = await retryTransaction(() => router.mergePositions(SUSDS_ADDRESS, marketAddress, amount));
    progressLog.push({
      phase: label,
      market: marketAddress,
      wrappedTokens: set,
      balancesBefore: balances.map((x) => x.toString()),
      merged: amount.toString(),
      leftover: balances.reduce((s, x) => s + (x - amount), 0n).toString(),
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
    });
    save();
    console.log(`   ✅ Saved to ${PROGRESS_FILE}`);
    await new Promise((r) => setTimeout(r, DELAY_MS));
  };

  await runMerge("Phase 2 — Market B", MARKET_B, setB, balB, b.amount);

  // Re-read A's balances from chain — phase 2 just changed OTHER_TOKEN.
  console.log("\n🔍 Re-reading Market A balances after phase 2...");
  const balA2 = await readBalances(setA);
  const a2 = report(`Phase 3 — Market A (${setA.length} outcomes) → sUSDS [live balances]`, mA, balA2);

  await runMerge("Phase 3 — Market A", MARKET_A, setA, balA2, a2.amount);

  const susdsAfter = await susds.balanceOf(wallet.address);
  console.log(
    `\n🎉 Done. sUSDS ${formatUnits(susdsBefore, 18)} → ${formatUnits(susdsAfter, 18)} ` +
      `(+${formatUnits(susdsAfter - susdsBefore, 18)})`
  );
  console.log(`   Progress: ${PROGRESS_FILE}`);
  console.log("   Next: node verify-l1-unwind.js");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
