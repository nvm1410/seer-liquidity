import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import { MarketViewAbi } from "./abis/MarketViewAbi.js";

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 of resolving the two L1 (Deep Funding GG24) markets. Run this AFTER
// answer-l1-markets.js has submitted all 99 Reality answers and the 3.5-day
// (302400 s) timeout has elapsed on the last of them.
//
// Market.resolve() is a permissionless, no-arg call (src/Market.sol) that forwards
// to realityProxy.resolve(this), reading each finalized Reality answer and writing
// it as the conditional-tokens payout vector. For a MULTI_SCALAR market it reverts
// unless EVERY question is finalized, so a single missing answer blocks the market.
//
// Status is derived on-chain from MarketView.getMarket(...), replicating the Seer
// SDK's getMarketStatus() (see seer-pm-sdk/src/market.ts + reality.ts):
//   !hasOpenQuestions                         -> NOT_OPEN
//   hasAllUnansweredQuestions                 -> OPEN
//   isInDispute (any question in arbitration) -> IN_DISPUTE
//   isWaitingResults (any question not final) -> ANSWER_NOT_FINAL
//   !payoutReported                           -> PENDING_EXECUTION  <- resolve these
//   else                                      -> CLOSED
//
// There is no ordering constraint between A and B here — each market's payout is
// reported independently. (Ordering only matters when REDEEMING afterwards:
// redeem market B first, so its merge mints A's "Other repositories" token before
// market A is redeemed.)
// ─────────────────────────────────────────────────────────────────────────────

// ── Config ──────────────────────────────────────────────────────────────────
const DRY_RUN = true; // ← set to false to send transactions

const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL;
const CHAIN_ID = 10n;

// Addresses (Optimism, chain 10)
const MARKET_FACTORY = "0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6";
const MARKET_VIEW = "0x336695ec9efbafd6322fb82eaadbcda02e38f348";
const MARKETS = [
  { label: "A", address: "0x3220A208aAf4D2ceECDe5A2e21eC0C9145f40BA6" },
  { label: "B", address: "0xfea47428981f70110c64dd678889826c3627245b" },
];

const PROGRESS_FILE = "./resolve-l1-execution.json"; // append-only resolve log

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
  return (marketInfo.questions || []).some((q) => q.best_answer && q.best_answer.toLowerCase() === ANSWERED_TOO_SOON);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n📋 Wallet   : ${wallet ? wallet.address : "(none — read-only)"}`);
  console.log(`📋 DRY_RUN  : ${DRY_RUN}\n`);

  const network = await provider.getNetwork();
  if (network.chainId !== CHAIN_ID) {
    throw new Error(`RPC_URL points at chain ${network.chainId}, expected ${CHAIN_ID} (Optimism)`);
  }

  const marketView = new ethers.Contract(MARKET_VIEW, MarketViewAbi, provider);

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
  const pending = [];
  const errors = [];

  for (const m of MARKETS) {
    try {
      const info = await marketView.getMarket(MARKET_FACTORY, m.address);
      const status = getMarketStatus(info, now);

      const unanswered = info.questions.filter((q) => isQuestionUnanswered(q)).length;
      const notFinal = info.questions.filter((q) => isQuestionPending(q, now)).length;
      const lastFinalize = info.questions.reduce((acc, q) => Math.max(acc, Number(q.finalize_ts)), 0);

      console.log(`  [Market ${m.label}] ${m.address} → ${status}`);
      console.log(
        `     questions ${info.questions.length} | unanswered ${unanswered} | not-yet-final ${notFinal} | ` +
          `payoutReported ${info.payoutReported}`
      );
      if (lastFinalize > 0) {
        console.log(
          `     last finalize_ts ${new Date(lastFinalize * 1000).toISOString()}` +
            (lastFinalize > now ? `  (in ${Math.ceil((lastFinalize - now) / 3600)} h)` : "  (elapsed)")
        );
      }

      if (status === "PENDING_EXECUTION") {
        pending.push({ ...m, info });
        if (hasAnsweredTooSoon(info)) {
          console.log(`     ⚠️  a best_answer is ANSWERED_TOO_SOON — resolve() may need reopenQuestion() first`);
        }
      }
    } catch (err) {
      errors.push({ market: m.address, error: err.message });
      console.warn(`  [Market ${m.label}] ${m.address} → ERROR ${err.message}`);
    }
  }

  console.log(`\n🎯 Pending execution: ${pending.length} market(s)`);
  if (pending.length === 0) {
    console.log("\n✅ Nothing to resolve.");
    if (errors.length) console.log(`⚠️  ${errors.length} error(s) while scanning — see above.`);
    return;
  }

  // ── Resolve phase ──────────────────────────────────────────────────────
  console.log(`\n⚙️  Resolve phase (${DRY_RUN ? "DRY RUN — no transactions" : "LIVE"})\n`);

  let resolved = 0;
  let skipped = 0;
  for (const m of pending) {
    if (alreadyResolved.has(m.address.toLowerCase())) {
      console.log(`  Market ${m.label}: already in progress log — skipping`);
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`  Market ${m.label} ${m.address}: would call resolve()`);
      continue;
    }

    if (!wallet) throw new Error("PRIVATE_KEY not set — cannot send transactions with DRY_RUN=false");

    console.log(`  Market ${m.label} ${m.address}: resolving...`);
    const market = new ethers.Contract(m.address, MARKET_ABI, wallet);
    try {
      const receipt = await retryTransaction(() => market.resolve());
      progressLog.push({
        label: m.label,
        market: m.address,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        timestamp: new Date().toISOString(),
      });
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progressLog, null, 2));
      resolved++;
      await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      console.error(`  Market ${m.label}: resolve() failed after retries: ${err.message}`);
      errors.push({ market: m.address, error: err.message });
    }
  }

  if (DRY_RUN) {
    console.log(
      `\n🎉 Dry run — ${pending.length - skipped} market(s) would be resolved. Set DRY_RUN = false to execute.`
    );
  } else {
    console.log(
      `\n🎉 Resolved ${resolved}/${pending.length - skipped} pending market(s) (${skipped} already logged). ` +
        `Log → ${PROGRESS_FILE}.`
    );
    if (resolved > 0) {
      console.log(`💡 Both markets CLOSED → the stranded outcome tokens are now redeemable via`);
      console.log(`   Router.redeemPositions. Redeem market B FIRST (B → A's "Other repositories"`);
      console.log(`   token), then market A including those freshly minted tokens → sUSDS.`);
    }
  }
  if (errors.length) {
    console.log(`⚠️  ${errors.length} error(s) occurred — see above.`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message ?? err);
  process.exit(1);
});
