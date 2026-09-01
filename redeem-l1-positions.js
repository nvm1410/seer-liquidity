// Redeem the resolved "L1" (Deep Funding GG24) outcome tokens back into sUSDS, on
// Optimism (chain 10). This is the last act of the L1 lifecycle:
//
//   add-back-l1-liquidity.js -> add-20k-l1-liquidity.js -> withdraw-l1-liquidity.js
//   -> merge-l1-positions.js -> answer-l1-markets.js -> resolve-l1-markets.js -> THIS
//
// The unwind on 2026-08-25 merged what it could and left ~487k outcome tokens stranded
// (mergePositions is capped at min(balances) across the whole set). Now that both markets
// report payouts, every stranded token is redeemable for its own weight — redemption is
// NOT capped by the minimum, each outcome pays out independently.
//
// THE ORDER STILL MATTERS, for a different reason than the merge did:
//
//   Phase 1 — redeem Market B's 32 held outcomes. B is a CHILD market
//             (parentCollectionId != 0), so Router.redeemPositions re-wraps the proceeds
//             as market A's outcome #66 ("Other repositories", OTHER_TOKEN) and sends
//             that back to the wallet. Nothing reaches sUSDS yet.
//   Phase 2 — redeem Market A's 67 held outcomes INCLUDING the OTHER_TOKEN minted in
//             phase 1. A is the root market (parentCollectionId == 0), so the Router
//             transfers real sUSDS out.
//
// Redeeming A first would leave B's whole value (~759 sUSDS) stranded behind an
// OTHER_TOKEN balance of zero.
//
// Router.redeemPositions takes the BASE collateral (sUSDS) as its first argument for BOTH
// markets, exactly like mergePositions — _redeemPositions derives the position id from the
// market's own parentCollectionId (src/Router.sol:181-207).
//
// Outcomes with payoutNumerators == 0 (the "Invalid result" slots) are SKIPPED: redeeming
// them would burn the tokens for exactly zero collateral. They stay in the wallet.
//
// Run with DRY_RUN = true first: it reads every balance and payout numerator and prints
// the full per-outcome table plus the chunk plan without sending anything.

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

const PROGRESS_FILE = "./redeem-l1-positions-execution.json";

// Addresses (Optimism, chain 10)
const ROUTER_ADDRESS = "0x179d8F8c811B8C759c33809dbc6c5ceDc62D05DD";
const SUSDS_ADDRESS = "0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0";
const MARKET_FACTORY = "0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6";
const MARKET_VIEW = "0x336695ec9efbafd6322fb82eaadbcda02e38f348";

const MARKET_A = "0x3220A208aAf4D2ceECDe5A2e21eC0C9145f40BA6";
const MARKET_B = "0xfea47428981f70110c64dd678889826c3627245b";
const OTHER_TOKEN = "0x63a4F76ef5846F68D069054C271465B7118e8ed9";

// Outcomes per redeemPositions call. Each call does a transferFrom + unwrap per outcome
// before the ConditionalTokens redeem, so a 67-outcome market is chunked rather than sent
// as one very large transaction.
const CHUNK_SIZE = 15;

const DELAY_MS = 2000;

// ── ABIs ────────────────────────────────────────────────────────────────────
const CONDITIONAL_TOKENS_ABI = [
  "function payoutDenominator(bytes32) view returns (uint256)",
  "function payoutNumerators(bytes32,uint256) view returns (uint256)",
];
const MARKET_ABI = [
  "function conditionId() view returns (bytes32)",
  "function parentCollectionId() view returns (bytes32)",
];

// ── Provider / wallet ───────────────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

// ── Helpers (same shapes as merge-l1-positions.js) ──────────────────────────
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
      console.log(`    Attempt ${attempt}/${retries}...`);
      const tx = await txFn();
      console.log(`    Tx sent: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`    Confirmed in block ${receipt.blockNumber} (gas ${receipt.gasUsed})`);
      return receipt;
    } catch (err) {
      lastError = err;
      console.warn(`    Attempt ${attempt} failed: ${err.message}`);
      if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

async function ensureAllowance(tokenAddress, spender, amount) {
  const ro = new ethers.Contract(tokenAddress, erc20Abi, provider);
  let current = await ro.allowance(wallet.address, spender);
  if (current >= amount) return false;
  const token = new ethers.Contract(tokenAddress, erc20Abi, wallet);
  await retryTransaction(() => token.approve(spender, amount));
  // A confirmed receipt does not mean every RPC backend node has the new state yet. Read
  // the allowance back until it is visible: otherwise the redeemPositions estimateGas that
  // follows can hit a lagging node and revert with "ERC20: transfer amount exceeds
  // allowance" even though the approvals are all on chain.
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    current = await ro.allowance(wallet.address, spender);
    if (current >= amount) return true;
  }
  throw new Error(`Allowance for ${tokenAddress} is still ${current} < ${amount} after approve`);
}

async function readBalances(tokens) {
  return runBatched(tokens, 20, (t) =>
    new ethers.Contract(t, erc20Abi, provider).balanceOf(wallet.address)
  );
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Build the redemption plan for one market: which outcomes to redeem, for how much, and
// what each is worth. Prints the full per-outcome table.
function plan(label, info, tokens, numerators, denominator, balances) {
  const f = (v) => Number(formatUnits(v, 18)).toFixed(4).padStart(13);
  console.log(`\n   ${label}`);
  console.log("     #   outcome                                    balance         payout   action");

  const rows = [];
  let total = 0n;
  let zeroPayoutHeld = 0n;
  let dustHeld = 0n;

  balances.forEach((bal, i) => {
    const num = numerators[i];
    const payout = denominator > 0n ? (bal * num) / denominator : 0n;
    let action;
    if (num === 0n) {
      action = bal > 0n ? "skip (payout 0)" : "skip (empty)";
      zeroPayoutHeld += bal;
    } else if (bal === 0n) {
      action = "skip (empty)";
    } else {
      action = "redeem";
      rows.push({ index: i, token: tokens[i], amount: bal, payout });
      total += payout;
      if (payout === 0n) dustHeld += bal;
    }
    const name = (info.outcomes?.[i] ?? `outcome${i}`).slice(0, 38);
    console.log(`    ${String(i).padStart(2)}   ${name.padEnd(38)}${f(bal)}${f(payout)}   ${action}`);
  });

  console.log(
    `\n     to redeem       : ${rows.length}/${balances.length} outcomes\n` +
      `     proceeds        : ${formatUnits(total, 18)}\n` +
      `     left in wallet  : ${formatUnits(zeroPayoutHeld, 18)} zero-payout tokens (worth 0)`
  );
  if (dustHeld > 0n) {
    console.log(
      `     ⚠️  ${formatUnits(dustHeld, 18)} tokens redeem to 0 after rounding but are still included`
    );
  }
  return { rows, total, zeroPayoutHeld };
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
  const ctAddress = await router.conditionalTokens();
  if (!ctAddress || ctAddress === ethers.ZeroAddress) {
    throw new Error("Router.conditionalTokens() is zero — wrong Router?");
  }
  const conditionalTokens = new ethers.Contract(ctAddress, CONDITIONAL_TOKENS_ABI, provider);

  // ── Step 1: resolve both markets from chain ───────────────────────────────
  console.log("\n🔍 Step 1: reading markets A and B from chain...");
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
  if (!mA.payoutReported || !mB.payoutReported) {
    throw new Error(
      `Payouts not reported yet (A ${mA.payoutReported}, B ${mB.payoutReported}) — run resolve-l1-markets.js first.`
    );
  }

  const setA = [...mA.wrappedTokens];
  const setB = [...mB.wrappedTokens];
  console.log(`   Market A ${MARKET_A}: ${setA.length} outcomes, payoutReported ${mA.payoutReported}`);
  console.log(
    `   Market B ${MARKET_B}: ${setB.length} outcomes, payoutReported ${mB.payoutReported}, ` +
      `parent = A #${parentOutcome} (${OTHER_TOKEN})`
  );

  // ── Step 2: read payout vectors ───────────────────────────────────────────
  console.log("\n🔍 Step 2: reading payout vectors...");
  const readPayouts = async (marketAddress, size) => {
    const m = new ethers.Contract(marketAddress, MARKET_ABI, provider);
    const conditionId = await m.conditionId();
    const parentCollectionId = await m.parentCollectionId();
    const denominator = await conditionalTokens.payoutDenominator(conditionId);
    if (denominator === 0n) {
      throw new Error(
        `payoutDenominator for ${marketAddress} is 0 — market not resolved on ConditionalTokens.`
      );
    }
    const numerators = await runBatched([...Array(size).keys()], 20, (i) =>
      conditionalTokens.payoutNumerators(conditionId, i)
    );
    return { conditionId, parentCollectionId, denominator, numerators };
  };
  const pA = await readPayouts(MARKET_A, setA.length);
  const pB = await readPayouts(MARKET_B, setB.length);
  if (pA.parentCollectionId !== ethers.ZeroHash) {
    throw new Error(
      `Market A parentCollectionId is ${pA.parentCollectionId}, expected zero (root market).`
    );
  }
  if (pB.parentCollectionId === ethers.ZeroHash) {
    throw new Error("Market B parentCollectionId is zero — expected a child market.");
  }
  console.log(`   A: conditionId ${pA.conditionId} denominator ${pA.denominator}`);
  console.log(`   B: conditionId ${pB.conditionId} denominator ${pB.denominator}`);

  const susds = new ethers.Contract(SUSDS_ADDRESS, erc20Abi, provider);
  const susdsBefore = await susds.balanceOf(wallet.address);

  // ── Step 3: read balances and preview both phases ─────────────────────────
  console.log("\n🔍 Step 3: reading balances...");
  const balB = await readBalances(setB);
  const balA = await readBalances(setA);

  const b = plan(
    `Phase 1 — Market B (${setB.length} outcomes) → OTHER_TOKEN`,
    mB,
    setB,
    pB.numerators,
    pB.denominator,
    balB
  );

  // Phase 2 sees A's balances plus whatever phase 1 mints onto OTHER_TOKEN.
  const projectedA = balA.map((v, i) => (i === parentOutcome ? v + b.total : v));
  const a = plan(
    `Phase 2 — Market A (${setA.length} outcomes) → sUSDS` +
      `  [#${parentOutcome} shown as balance + ${formatUnits(b.total, 18)} from phase 1]`,
    mA,
    setA,
    pA.numerators,
    pA.denominator,
    projectedA
  );

  console.log(
    `\n📊 Projected outcome:\n` +
      `   OTHER_TOKEN from phase 1    : ${formatUnits(b.total, 18)}\n` +
      `   sUSDS from phase 2          : ${formatUnits(a.total, 18)}\n` +
      `   sUSDS now                   : ${formatUnits(susdsBefore, 18)}\n` +
      `   sUSDS after                 : ${formatUnits(susdsBefore + a.total, 18)}\n` +
      `   txs: ${chunk(b.rows, CHUNK_SIZE).length} + ${chunk(a.rows, CHUNK_SIZE).length} redeem calls, ` +
      `up to ${b.rows.length + a.rows.length} approvals`
  );

  if (b.rows.length === 0 && a.rows.length === 0) {
    console.log("\n✅ Nothing left to redeem.");
    return;
  }

  if (DRY_RUN) {
    console.log("\n✅ Dry run complete — set DRY_RUN = false to execute.");
    return;
  }

  // ── Step 4: execute, B first then A ───────────────────────────────────────
  // Chunks are always recomputed from LIVE balances: a redeemed outcome ends at zero and
  // drops out of the plan by itself, so the progress file is an audit trail, not the
  // source of truth for what still needs doing.
  let progressLog = [];
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      progressLog = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
    } catch {
      progressLog = [];
    }
  }
  const save = () => fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progressLog, null, 2));

  const runRedeem = async (label, marketAddress, rows) => {
    if (rows.length === 0) {
      console.log(`\n⏭  ${label}: nothing to redeem — skipping`);
      return;
    }
    const chunks = chunk(rows, CHUNK_SIZE);
    console.log(`\n💰 ${label}: redeeming ${rows.length} outcomes in ${chunks.length} tx(s)`);

    for (const [ci, c] of chunks.entries()) {
      const expected = c.reduce((s, r) => s + r.payout, 0n);
      console.log(
        `\n   Chunk ${ci + 1}/${chunks.length}: outcomes [${c.map((r) => r.index).join(", ")}] ` +
          `worth ${formatUnits(expected, 18)}`
      );

      let approvals = 0;
      for (const r of c) if (await ensureAllowance(r.token, ROUTER_ADDRESS, r.amount)) approvals++;
      console.log(`   ${approvals} new approval(s), ${c.length - approvals} already sufficient`);

      const outcomeIndexes = c.map((r) => r.index);
      const amounts = c.map((r) => r.amount);

      // estimateGas lives inside the retry so a transient stale-node revert is retried
      // rather than aborting the whole run.
      const receipt = await retryTransaction(async () => {
        const gas = await router.redeemPositions.estimateGas(
          SUSDS_ADDRESS,
          marketAddress,
          outcomeIndexes,
          amounts
        );
        console.log(`   estimateGas ${gas}`);
        return router.redeemPositions(SUSDS_ADDRESS, marketAddress, outcomeIndexes, amounts, {
          gasLimit: (gas * 12n) / 10n,
        });
      });

      progressLog.push({
        phase: label,
        market: marketAddress,
        chunk: ci,
        outcomeIndexes,
        tokens: c.map((r) => r.token),
        amounts: amounts.map((x) => x.toString()),
        expectedProceeds: expected.toString(),
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        timestamp: new Date().toISOString(),
      });
      save();
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
    console.log(`   ✅ ${label} complete — logged to ${PROGRESS_FILE}`);
  };

  await runRedeem("Phase 1 — Market B", MARKET_B, b.rows);

  // Re-read A's balances from chain — phase 1 just minted OTHER_TOKEN.
  console.log("\n🔍 Re-reading Market A balances after phase 1...");
  const balA2 = await readBalances(setA);
  const a2 = plan(
    `Phase 2 — Market A (${setA.length} outcomes) → sUSDS [live balances]`,
    mA,
    setA,
    pA.numerators,
    pA.denominator,
    balA2
  );

  await runRedeem("Phase 2 — Market A", MARKET_A, a2.rows);

  // ── Step 5: verify ────────────────────────────────────────────────────────
  const susdsAfter = await susds.balanceOf(wallet.address);
  const delta = susdsAfter - susdsBefore;
  console.log(
    `\n🎉 Done. sUSDS ${formatUnits(susdsBefore, 18)} → ${formatUnits(susdsAfter, 18)} ` +
      `(+${formatUnits(delta, 18)})`
  );
  console.log(`   expected +${formatUnits(a2.total, 18)}`);
  const diff = delta > a2.total ? delta - a2.total : a2.total - delta;
  if (diff > 10n ** 12n) {
    console.log(`   ⚠️  off by ${formatUnits(diff, 18)} sUSDS — investigate before assuming success.`);
  } else {
    console.log(`   ✅ matches projection (diff ${formatUnits(diff, 18)}).`);
  }
  console.log(`   Progress: ${PROGRESS_FILE}`);
  console.log("   Re-run this script dry to confirm nothing redeemable is left.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
