import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import { MarketViewAbi } from "./abis/MarketViewAbi.js";
import { markets } from "./markets.js";

// ─────────────────────────────────────────────────────────────────────────────
// Scans every originality market (the parent categorical market + all 98 child
// scalar Up/Down markets) and calls Market.resolve() on any market whose Reality.eth
// question(s) are finalized but whose payout hasn't been reported yet
// (Seer UI status: "Pending execution").
//
// Status is derived on-chain from MarketView.getMarket(...), replicating the Seer
// SDK's getMarketStatus() (see seer-pm-sdk/src/market.ts + reality.ts):
//   !hasOpenQuestions                        -> NOT_OPEN
//   hasAllUnansweredQuestions                -> OPEN
//   isInDispute (any question in arbitration) -> IN_DISPUTE
//   isWaitingResults (any question not final) -> ANSWER_NOT_FINAL
//   !payoutReported                          -> PENDING_EXECUTION  <- resolve these
//   else                                     -> CLOSED
//
// Market.resolve() is a permissionless, no-arg call (src/Market.sol) that forwards
// to realityProxy.resolve(this), reporting the finalized answer as the payout.
// ─────────────────────────────────────────────────────────────────────────────

// ── Config ──────────────────────────────────────────────────────────────────
const DRY_RUN = false; // ← set to false to send transactions

const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL;

// Addresses (Optimism, chain 10)
const MARKET_FACTORY = "0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6";
const MARKET_VIEW = "0x336695ec9efbafd6322fb82eaadbcda02e38f348";
const PARENT_MARKET_ADDRESS = "0xdb3aae8d1c964767eeaa17805be25cded7a17210";

const PROGRESS_FILE = "./resolve-originality-execution.json"; // append-only resolve log

// Reality.eth sentinel for "answered too soon" (see seer-pm-sdk/src/reality.ts)
const ANSWERED_TOO_SOON = "0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe";

// ── ABIs ────────────────────────────────────────────────────────────────────
const MARKET_ABI = ["function resolve() external"];

// ── Provider / wallet ───────────────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = WALLET_PRIVATE_KEY ? new ethers.Wallet(WALLET_PRIVATE_KEY, provider) : undefined;

// ── Helpers ──────────────────────────────────────────────────────────────────
async function retryTransaction(txFn, retries = 3, delayMs = 3000) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`    Attempt ${attempt}/${retries}...`);
      const tx = await txFn();
      console.log(`    Tx sent: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`    Confirmed in block ${receipt.blockNumber}`);
      return receipt;
    } catch (err) {
      lastError = err;
      console.warn(`    Attempt ${attempt} failed: ${err.message}`);
      if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

// Reality.eth per-question predicates — mirrors seer-pm-sdk/src/reality.ts
function isFinalized(q, now) {
  const finalizeTs = Number(q.finalize_ts);
  return !q.is_pending_arbitration && finalizeTs > 0 && now > finalizeTs;
}
function isQuestionUnanswered(q) {
  return Number(q.finalize_ts) === 0;
}
function isQuestionInDispute(q) {
  return q.is_pending_arbitration;
}
function isQuestionPending(q, now) {
  return Number(q.finalize_ts) === 0 || !isFinalized(q, now);
}

// Aggregate market status — mirrors seer-pm-sdk/src/market.ts getMarketStatus()
function getMarketStatus(marketInfo, now) {
  const questions = marketInfo.questions;
  if (!questions || questions.length === 0) return "NO_QUESTIONS";

  const hasOpenQuestions = Number(questions[0].opening_ts) < now;
  if (!hasOpenQuestions) return "NOT_OPEN";

  const hasAllUnanswered = questions.every((q) => isQuestionUnanswered(q));
  if (hasAllUnanswered) return "OPEN";

  const inDispute = questions.some((q) => isQuestionInDispute(q));
  if (inDispute) return "IN_DISPUTE";

  const waitingResults = questions.some((q) => isQuestionPending(q, now));
  if (waitingResults) return "ANSWER_NOT_FINAL";

  if (!marketInfo.payoutReported) return "PENDING_EXECUTION";

  return "CLOSED";
}

function hasAnsweredTooSoon(marketInfo) {
  return (marketInfo.questions || []).some(
    (q) => q.best_answer && q.best_answer.toLowerCase() === ANSWERED_TOO_SOON
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n📋 Wallet   : ${wallet ? wallet.address : "(none — read-only)"}`);
  console.log(`📋 DRY_RUN  : ${DRY_RUN}\n`);

  const marketView = new ethers.Contract(MARKET_VIEW, MarketViewAbi, provider);

  // ── Build the full market list: parent + 98 children, deduped ────────────
  const seen = new Set();
  const allMarkets = [];
  for (const addr of [PARENT_MARKET_ADDRESS, ...markets.map((m) => m.marketId)]) {
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    allMarkets.push(addr);
  }
  console.log(`🔍 Scanning ${allMarkets.length} originality markets (1 parent + ${allMarkets.length - 1} children)...\n`);

  // ── Load progress log (audit trail of past resolve() calls) ──────────────
  let progressLog = [];
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      progressLog = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
    } catch {
      progressLog = [];
    }
  }
  const alreadyResolved = new Set(progressLog.map((e) => e.market.toLowerCase()));

  // ── Scan phase ─────────────────────────────────────────────────────────
  const now = Math.floor(Date.now() / 1000);
  const statusCounts = {};
  const pending = [];
  const answeredTooSoon = [];
  const errors = [];

  for (const addr of allMarkets) {
    try {
      const info = await marketView.getMarket(MARKET_FACTORY, addr);
      const status = getMarketStatus(info, now);
      statusCounts[status] = (statusCounts[status] ?? 0) + 1;

      const label = addr.toLowerCase() === PARENT_MARKET_ADDRESS.toLowerCase() ? "PARENT" : "child ";
      console.log(`  [${label}] ${addr} → ${status}`);

      if (status === "PENDING_EXECUTION") {
        pending.push(addr);
        if (hasAnsweredTooSoon(info)) {
          answeredTooSoon.push(addr);
          console.log(`     ⚠️  best_answer = ANSWERED_TOO_SOON — resolve() may need reopenQuestion() first`);
        }
      }
    } catch (err) {
      errors.push({ market: addr, error: err.message });
      console.warn(`  [ERR   ] ${addr} → ${err.message}`);
    }
  }

  console.log(`\n📊 Status summary:`);
  for (const [status, count] of Object.entries(statusCounts)) {
    console.log(`   ${status}: ${count}`);
  }
  if (errors.length) console.log(`   ERRORS while scanning: ${errors.length}`);
  console.log(`\n🎯 Pending execution: ${pending.length} market(s)`);
  if (answeredTooSoon.length) {
    console.log(`⚠️  ${answeredTooSoon.length} of those have an ANSWERED_TOO_SOON best answer — flagged above.`);
  }

  if (pending.length === 0) {
    console.log("\n✅ Nothing to resolve.");
    return;
  }

  // ── Resolve phase ──────────────────────────────────────────────────────
  console.log(`\n⚙️  Resolve phase (${DRY_RUN ? "DRY RUN — no transactions" : "LIVE"})\n`);

  let resolved = 0;
  let skipped = 0;
  for (const addr of pending) {
    if (alreadyResolved.has(addr.toLowerCase())) {
      console.log(`  ${addr}: already in progress log — skipping`);
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`  ${addr}: would call resolve()`);
      continue;
    }

    if (!wallet) {
      throw new Error("PRIVATE_KEY not set — cannot send transactions with DRY_RUN=false");
    }

    console.log(`  ${addr}: resolving...`);
    const market = new ethers.Contract(addr, MARKET_ABI, wallet);
    try {
      const receipt = await retryTransaction(() => market.resolve());
      progressLog.push({
        market: addr,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        timestamp: new Date().toISOString(),
      });
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progressLog, null, 2));
      resolved++;
      await new Promise((res) => setTimeout(res, 2000));
    } catch (err) {
      console.error(`  ${addr}: resolve() failed after retries: ${err.message}`);
      errors.push({ market: addr, error: err.message });
    }
  }

  console.log(
    `\n🎉 Done. ${DRY_RUN ? `Dry run — ${pending.length - skipped} market(s) would be resolved. Set DRY_RUN = false to execute.` : `Resolved ${resolved}/${pending.length - skipped} pending market(s) (${skipped} already logged). Log → ${PROGRESS_FILE}.`}`
  );
  if (errors.length) {
    console.log(`⚠️  ${errors.length} error(s) occurred — see above.`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
