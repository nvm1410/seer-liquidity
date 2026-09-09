// Convert the Zcash NU7 coinholder-poll outcome tokens sitting in the wallet back
// into sUSDS, on Optimism (chain 10). Run this AFTER withdraw-zcash-nu7-liquidity.js —
// that script returns outcome tokens + sUSDS to the wallet but deliberately stops there.
//
// Fork of merge-zcash-positions.js (the Q3 binary set). Same structural change as the
// NU7 withdraw script: these are single-select categorical markets with n outcomes +
// Invalid and n differs per market (5/5/5/4/5 slots), so the "expected 3 wrapped
// tokens" assertion becomes a check against the creation log's `outcomes` length.
//
// Merging needs a COMPLETE set: every outcome slot plus Invalid. Invalid was never
// pooled, but every split minted it, so it is already in the wallet (src/Router.sol
// _mergePositions / getPartition). The mergeable amount per market is the MIN balance
// across the whole set — if a market traded, the surplus sides are left over in the
// wallet and stay there until the market resolves.
//
// Run with DRY_RUN = true first: it reads every balance and prints the exact
// per-market merge and leftover table without sending anything.

import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import { erc20Abi, formatUnits } from "viem";
import { MarketViewAbi } from "./abis/MarketViewAbi.js";
import { RouterAbi } from "./abis/RouterAbi.js";

// ── Config ──────────────────────────────────────────────────────────────────
const DRY_RUN = true; // ← set to false to send transactions

const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL; // Optimism
const CHAIN_ID = 10;

const MARKETS_FILE = "./create-zcash-nu7-markets-v3-execution.json";
const PROGRESS_FILE = "./merge-zcash-nu7-positions-v3-execution.json";

// Addresses (Optimism, chain 10)
const ROUTER_ADDRESS = "0x179d8F8c811B8C759c33809dbc6c5ceDc62D05DD";
const SUSDS_ADDRESS = "0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0";
const MARKET_FACTORY = "0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6";
const MARKET_VIEW = "0x336695ec9efbafd6322fb82eaadbcda02e38f348";

const DELAY_MS = 2000;

// ── Provider / wallet ───────────────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

// ── Helpers ─────────────────────────────────────────────────────────────────
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
  if (current >= amount) return;
  const token = new ethers.Contract(tokenAddress, erc20Abi, wallet);
  console.log(`  Approving ${tokenAddress} -> ${spender} for ${formatUnits(amount, 18)} ...`);
  await retryTransaction(() => token.approve(spender, amount));
  await new Promise((r) => setTimeout(r, 2000));
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n📋 Wallet  : ${wallet.address}`);
  console.log(`📋 DRY_RUN : ${DRY_RUN}`);

  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) {
    throw new Error(`RPC_URL points at chain ${net.chainId}, expected ${CHAIN_ID} (Optimism).`);
  }

  if (!fs.existsSync(MARKETS_FILE)) {
    throw new Error(`${MARKETS_FILE} not found — nothing to merge.`);
  }
  const markets = JSON.parse(fs.readFileSync(MARKETS_FILE, "utf8"));
  if (!markets.length) throw new Error(`${MARKETS_FILE} is empty.`);

  const router = new ethers.Contract(ROUTER_ADDRESS, RouterAbi, wallet);
  const ct = await router.conditionalTokens();
  if (!ct || ct === ethers.ZeroAddress) {
    throw new Error("Router.conditionalTokens() is zero — wrong Router?");
  }

  // ── Step 1: resolve the full outcome set from chain and read balances ─────
  console.log(`\n🔍 Step 1: resolving ${markets.length} markets and reading balances...`);
  const marketView = new ethers.Contract(MARKET_VIEW, MarketViewAbi, provider);

  const entries = await runBatched(markets, 8, async (m) => {
    const info = await marketView.getMarket(MARKET_FACTORY, m.market);
    if (info.collateralToken.toLowerCase() !== SUSDS_ADDRESS.toLowerCase()) {
      throw new Error(`[${m.shortName}] collateral ${info.collateralToken} != sUSDS`);
    }
    // Categorical: n outcomes + Invalid, n varies per market.
    const labels = m.outcomes ?? [];
    if (info.wrappedTokens.length !== labels.length) {
      throw new Error(
        `[${m.shortName}] on-chain has ${info.wrappedTokens.length} wrapped tokens, ` +
          `log lists ${labels.length} outcomes`
      );
    }
    // The log is a record, not a source of truth — cross-check it.
    if (m.wrappedTokens) {
      info.wrappedTokens.forEach((tok, i) => {
        if (m.wrappedTokens[i].toLowerCase() !== tok.toLowerCase()) {
          throw new Error(
            `[${m.shortName}] wrappedTokens[${i}] on-chain ${tok} != logged ${m.wrappedTokens[i]}`
          );
        }
      });
    }
    const set = [...info.wrappedTokens]; // [...outcomes, Invalid]
    const balances = await Promise.all(
      set.map((t) => new ethers.Contract(t, erc20Abi, provider).balanceOf(wallet.address))
    );
    return {
      id: m.id,
      shortName: m.shortName,
      market: m.market,
      labels,
      set,
      balances,
      amount: bmin(balances),
    };
  });

  // ── Step 2: the table ─────────────────────────────────────────────────────
  const f = (v) => Number(formatUnits(v, 18)).toFixed(4).padStart(13);
  let totalMerge = 0n;
  let totalLeftover = 0n;
  let blocked = 0;
  for (const e of entries) {
    const leftover = e.balances.reduce((a, b) => a + (b - e.amount), 0n);
    totalMerge += e.amount;
    totalLeftover += leftover;
    if (e.amount === 0n) blocked++;
    console.log(`\n   [${e.id}] ${e.shortName} — ${e.set.length} slots`);
    e.balances.forEach((b, i) => {
      const surplus = b - e.amount;
      console.log(
        `        ${f(b)}  ${e.labels[i].slice(0, 48).padEnd(48)}` +
          (surplus > 0n ? `  (+${Number(formatUnits(surplus, 18)).toFixed(4)} leftover)` : "")
      );
    });
    console.log(
      `        ${f(e.amount)}  ${"MERGEABLE (min of the set)".padEnd(48)}` +
        (e.amount === 0n ? "  ⚠️  one slot is zero — cannot merge" : "")
    );
  }

  const susds = new ethers.Contract(SUSDS_ADDRESS, erc20Abi, provider);
  const susdsBefore = await susds.balanceOf(wallet.address);
  console.log(
    `\n   Recoverable  : ${formatUnits(totalMerge, 18)} sUSDS over ${entries.length} markets\n` +
      `   Stranded     : ${formatUnits(totalLeftover, 18)} outcome tokens (imbalance from trading)\n` +
      `   sUSDS now    : ${formatUnits(susdsBefore, 18)}\n` +
      `   sUSDS after  : ${formatUnits(susdsBefore + totalMerge, 18)}`
  );
  if (blocked) console.log(`   ⚠️  ${blocked} market(s) have a zero outcome balance and are skipped.`);

  if (DRY_RUN) {
    console.log("\n✅ Dry run complete — set DRY_RUN = false to execute.");
    return;
  }

  // ── Step 3: merge, market by market ───────────────────────────────────────
  let progressLog = [];
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      progressLog = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
    } catch {
      progressLog = [];
    }
  }
  const alreadyDone = new Set(progressLog.map((e) => e.market.toLowerCase()));

  console.log(`\n🔀 Step 3: merging ${entries.length - blocked} markets\n`);
  let successCount = 0;
  for (const e of entries) {
    if (e.amount === 0n) continue;
    if (alreadyDone.has(e.market.toLowerCase())) {
      console.log(`  ⏭  [${e.id}] ${e.shortName}: already in progress log`);
      successCount++;
      continue;
    }
    console.log(`\n--- [${e.id}] ${e.shortName} — merging ${formatUnits(e.amount, 18)} ---`);
    try {
      for (const t of e.set) await ensureAllowance(t, ROUTER_ADDRESS, e.amount);
      const receipt = await retryTransaction(() =>
        router.mergePositions(SUSDS_ADDRESS, e.market, e.amount)
      );
      progressLog.push({
        id: e.id,
        shortName: e.shortName,
        market: e.market,
        wrappedTokens: e.set,
        balances: e.balances.map((b) => b.toString()),
        merged: e.amount.toString(),
        leftover: e.balances.reduce((a, b) => a + (b - e.amount), 0n).toString(),
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      });
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progressLog, null, 2));
      successCount++;
      console.log(`  ✅ Saved to ${PROGRESS_FILE}`);
    } catch (err) {
      console.error(`  ❌ Failed for ${e.shortName}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  const susdsAfter = await susds.balanceOf(wallet.address);
  console.log(`\n🎉 Done! ${successCount}/${entries.length - blocked} markets merged.`);
  console.log(
    `   sUSDS ${formatUnits(susdsBefore, 18)} → ${formatUnits(susdsAfter, 18)} ` +
      `(+${formatUnits(susdsAfter - susdsBefore, 18)})`
  );
  if (successCount < entries.length - blocked) {
    console.log("   Re-run to retry the failures — merged markets are skipped.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
