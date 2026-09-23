// Calls Market.resolve() on every originality round-2 market whose Reality
// questions are final: the parent plus its 98 scalar children.
//
// resolve() is no-arg and PERMISSIONLESS, so the scan reports status from chain
// rather than trusting a log, and "nothing to resolve" is a normal outcome.
//
// The parent's answer is a multi-select bitmask naming which repos were
// evaluated, so only the children it names ever become resolvable — 33 of 98 on
// the one live run. The other 65 have never been answered and will show as OPEN.
//
//   node resolve-originality-markets.js          # dry: scans all 99, reports status
//   node resolve-originality-markets.js --live   # sends, after a confirmation

import { ethers } from "ethers";
import { getMarketInfo, makeMarketView } from "./lib/market.js";
import { hasAnsweredTooSoon, marketStatus } from "./lib/reality.js";
import { run } from "./lib/run.js";
import { retryTransaction, sleep } from "./lib/tx.js";
import { markets } from "./markets.js";

const MARKET_ABI = ["function resolve() external"];
const DELAY_MS = 2000;

await run(
  {
    name: "resolve-originality-markets",
    slug: "originality-r2",
    stage: "settle-resolve",
    mutating: true,
    // The resolve log is the record of which markets were closed and by us.
    progress: (m) => m.files.resolve,
  },
  async (ctx) => {
    const { manifest, provider, wallet, addr, log, progress, dry: DRY_RUN } = ctx;
    const PARENT = manifest.results.parent;

    console.log(`\n📋 Wallet   : ${wallet ? wallet.address : "(none — read-only)"}\n`);

    const marketView = makeMarketView(addr.marketView, provider);

    // ── Build the full market list: parent + 98 children, deduped ────────────
    const seen = new Set();
    const allMarkets = [];
    for (const address of [PARENT, ...markets.map((m) => m.marketId)]) {
      const key = address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      allMarkets.push(address);
    }
    console.log(`🔍 Scanning ${allMarkets.length} originality markets (1 parent + ${allMarkets.length - 1} children)...\n`);

    const alreadyResolved = new Set(progress.entries.map((e) => e.market.toLowerCase()));

    // ── Scan phase ─────────────────────────────────────────────────────────
    const now = Math.floor(Date.now() / 1000);
    const statusCounts = {};
    const pending = [];
    const answeredTooSoon = [];
    const errors = [];

    for (const address of allMarkets) {
      try {
        const info = await getMarketInfo(marketView, addr.marketFactory, address);
        const status = marketStatus(info, now);
        statusCounts[status] = (statusCounts[status] ?? 0) + 1;

        const label = address.toLowerCase() === PARENT.toLowerCase() ? "PARENT" : "child ";
        console.log(`  [${label}] ${address} → ${status}`);

        if (status === "PENDING_EXECUTION") {
          pending.push(address);
          if (hasAnsweredTooSoon(info)) {
            answeredTooSoon.push(address);
            console.log(`     ⚠️  best_answer = ANSWERED_TOO_SOON — resolve() may need reopenQuestion() first`);
          }
        }
      } catch (err) {
        errors.push({ market: address, error: err.message });
        console.warn(`  [ERR   ] ${address} → ${err.message}`);
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
      if (errors.length) console.log(`⚠️  ${errors.length} error(s) while scanning — see above.`);
      return { scanned: allMarkets.length, pending: 0, resolved: 0 };
    }

    // ── Resolve phase ──────────────────────────────────────────────────────
    console.log(`\n⚙️  Resolve phase (${DRY_RUN ? "DRY RUN — no transactions" : "LIVE"})\n`);

    let resolved = 0;
    let skipped = 0;
    for (const address of pending) {
      if (alreadyResolved.has(address.toLowerCase())) {
        console.log(`  ${address}: already in progress log — skipping`);
        skipped++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`  ${address}: would call resolve()`);
        continue;
      }
      if (!wallet) throw new Error("PRIVATE_KEY not set — cannot send transactions.");

      console.log(`  ${address}: resolving...`);
      const market = new ethers.Contract(address, MARKET_ABI, wallet);
      try {
        const receipt = await retryTransaction(() => market.resolve(), { log });
        progress.append({
          kind: "resolve",
          key: address.toLowerCase(),
          market: address,
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
        });
        resolved++;
        await sleep(DELAY_MS);
      } catch (err) {
        console.error(`  ${address}: resolve() failed after retries: ${err.shortMessage || err.message}`);
        errors.push({ market: address, error: err.message });
      }
    }

    console.log(
      `\n🎉 Done. ${
        DRY_RUN
          ? `Dry run — ${pending.length - skipped} market(s) would be resolved. Pass --live to execute.`
          : `Resolved ${resolved}/${pending.length - skipped} pending market(s) (${skipped} already logged). Log → ${progress.path}.`
      }`
    );
    if (errors.length) console.log(`⚠️  ${errors.length} error(s) occurred — see above.`);
    return { scanned: allMarkets.length, pending: pending.length, resolved, skipped };
  }
);
