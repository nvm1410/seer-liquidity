// Calls Market.resolve() on the two L1 markets once their Reality questions are
// final.
//
// resolve() is no-arg and PERMISSIONLESS — it forwards to
// realityProxy.resolve(this) — so anyone can call it, and on this campaign
// somebody else did before we got there. That is why the scan phase reports
// status from chain rather than trusting a progress log, and why a run with
// nothing to do is the expected outcome rather than an error.
//
// Market.resolve() reverts unless EVERY question in the market is finalized, so
// one missed answer blocks the whole market.
//
//   node resolve-l1-markets.js          # dry: scans and reports status
//   node resolve-l1-markets.js --live   # sends, after a confirmation

import { ethers } from "ethers";
import { getMarketInfo, makeMarketView } from "../../lib/market.js";
import {
  hasAnsweredTooSoon,
  isQuestionPending,
  isQuestionUnanswered,
  marketStatus,
} from "../../lib/reality.js";
import { run } from "../../lib/run.js";
import { retryTransaction, sleep } from "../../lib/tx.js";

const MARKET_ABI = ["function resolve() external"];
const DELAY_MS = 2000;

await run(
  {
    name: "resolve-l1-markets",
    slug: "l1-deepfunding",
    stage: "settle-resolve",
    mutating: true,
    // This is the one progress literal that names a file which never existed: a
    // third party resolved both markets first, so this script has never had
    // anything to write. lib/run.js resolves a spec.progress path against the
    // REPO ROOT, so it must name the campaign directory — left bare it would
    // drop a stray file at the root the first time it ever ran.
    progress: () => "campaigns/l1-deepfunding/resolve-l1-execution.json",
  },
  async (ctx) => {
    const { manifest, provider, wallet, addr, log, progress, dry: DRY_RUN } = ctx;
    const MARKETS = manifest.results.marketAddresses.map((address, i) => ({
      label: ["A", "B"][i] ?? String(i),
      address,
    }));

    console.log(`\n📋 Wallet   : ${wallet ? wallet.address : "(none — read-only)"}\n`);

    const marketView = makeMarketView(addr.marketView, provider);
    const alreadyResolved = new Set(progress.entries.map((e) => e.market.toLowerCase()));

    // ── Scan phase ─────────────────────────────────────────────────────────
    const now = Math.floor(Date.now() / 1000);
    const pending = [];
    const errors = [];

    for (const m of MARKETS) {
      try {
        const info = await getMarketInfo(marketView, addr.marketFactory, m.address);
        const status = marketStatus(info, now);

        const unanswered = info.questions.filter(isQuestionUnanswered).length;
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
      return { pending: 0, resolved: 0 };
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
      if (!wallet) throw new Error("PRIVATE_KEY not set — cannot send transactions.");

      console.log(`  Market ${m.label} ${m.address}: resolving...`);
      const market = new ethers.Contract(m.address, MARKET_ABI, wallet);
      try {
        const receipt = await retryTransaction(() => market.resolve(), { log });
        progress.append({
          kind: "resolve",
          key: m.address.toLowerCase(),
          label: m.label,
          market: m.address,
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
        });
        resolved++;
        await sleep(DELAY_MS);
      } catch (err) {
        console.error(`  Market ${m.label}: resolve() failed after retries: ${err.shortMessage || err.message}`);
        errors.push({ market: m.address, error: err.message });
      }
    }

    if (DRY_RUN) {
      console.log(`\n🎉 Dry run — ${pending.length - skipped} market(s) would be resolved. Pass --live to execute.`);
    } else {
      console.log(
        `\n🎉 Resolved ${resolved}/${pending.length - skipped} pending market(s) (${skipped} already logged). ` +
          `Log → ${progress.path}.`
      );
      if (resolved > 0) {
        console.log(`💡 Both markets CLOSED → the stranded outcome tokens are now redeemable via`);
        console.log(`   Router.redeemPositions. Redeem market B FIRST (B → A's "Other repositories"`);
        console.log(`   token), then market A including those freshly minted tokens → sUSDS.`);
      }
    }
    if (errors.length) console.log(`⚠️  ${errors.length} error(s) occurred — see above.`);
    return { pending: pending.length, resolved, skipped };
  }
);
