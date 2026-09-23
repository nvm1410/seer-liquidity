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
//   node merge-l1-positions.js --resume          # dry: the exact per-outcome table
//   node merge-l1-positions.js --resume --live   # sends, after a confirmation
//
// --resume is required because the progress file IS the historical record that
// verify-l1-unwind.js reads (manifest files.merge, the two phases of 2026-08-25).

import { ethers } from "ethers";
import { erc20Abi, formatUnits } from "viem";
import { RouterAbi } from "../../abis/RouterAbi.js";
import { runBatched } from "../../lib/batch.js";
import { assertMarket, getMarketInfo, makeMarketView } from "../../lib/market.js";
import { run } from "../../lib/run.js";
import { getConditionalTokens, planMerge } from "../../lib/settle.js";
import { ensureAllowance, retryTransaction, sleep } from "../../lib/tx.js";

const DELAY_MS = 2000;

await run(
  {
    name: "merge-l1-positions",
    slug: "l1-deepfunding",
    stage: "unwind-merge",
    mutating: true,
    progress: (m) => m.files.merge,
  },
  async (ctx) => {
    const { manifest, provider, wallet, addr, log, progress, dry: DRY_RUN } = ctx;

    const COLLATERAL = manifest.chain.collateral.address;
    const [MARKET_A, MARKET_B] = manifest.results.marketAddresses;
    const OTHER_TOKEN = manifest.settle.catchAllOutcome.token;
    const owner = wallet.address;

    log.log(`\n📋 Wallet  : ${owner}`);
    log.log(`📋 DRY_RUN : ${DRY_RUN}`);

    const otherLower = OTHER_TOKEN.toLowerCase();

    const router = new ethers.Contract(addr.router, RouterAbi, wallet);
    // Throws on a Router whose conditionalTokens() is zero — i.e. the wrong Router.
    await getConditionalTokens(router, provider);

    // ── Step 1: resolve both markets from chain ───────────────────────────────
    log.log("\n🔍 Step 1: resolving markets A and B from chain...");
    const marketView = makeMarketView(addr.marketView, provider);
    const mA = await getMarketInfo(marketView, addr.marketFactory, MARKET_A);
    const mB = await getMarketInfo(marketView, addr.marketFactory, MARKET_B);

    await assertMarket(mA, { label: "Market A", collateral: COLLATERAL, topLevel: true });
    await assertMarket(mB, { label: "Market B", parentMarket: MARKET_A });
    const parentOutcome = mB.parentOutcomeIndex;
    if (mB.parentOutcomeToken?.toLowerCase() !== otherLower) {
      throw new Error(`Market B's parent outcome token is not ${OTHER_TOKEN}`);
    }
    const setA = [...mA.wrappedTokens];
    const setB = [...mB.wrappedTokens];
    log.log(`   Market A ${MARKET_A}: ${setA.length} outcomes`);
    log.log(`   Market B ${MARKET_B}: ${setB.length} outcomes, parent = A #${parentOutcome} (${OTHER_TOKEN})`);

    const susds = new ethers.Contract(COLLATERAL, erc20Abi, provider);
    const susdsBefore = await susds.balanceOf(owner);

    // Batched deliberately: 68 parallel balanceOf calls is how you get throttled.
    const readBalances = (tokens) =>
      runBatched(tokens, (t) => new ethers.Contract(t, erc20Abi, provider).balanceOf(owner), {
        batchSize: 20,
        pauseMs: 500,
      });

    // Print a per-outcome balance table and return the plan.
    const report = (label, info, balances) => {
      const plan = planMerge(balances);
      const f = (v) => Number(formatUnits(v, 18)).toFixed(4).padStart(14);
      log.log(`\n   ${label}`);
      log.log("     #   outcome                                    balance      leftover");
      balances.forEach((b, i) => {
        const name = (info.outcomes?.[i] ?? `outcome${i}`).slice(0, 38);
        log.log(
          `    ${String(i).padStart(2)}   ${name.padEnd(38)}${f(b)}${f(b - plan.amount)}` +
            (i === plan.minIndex ? "   ← binding minimum" : "") +
            (b === 0n ? "  ⚠️  ZERO" : "")
        );
      });
      log.log(
        `\n     mergeable (min) : ${formatUnits(plan.amount, 18)}\n` +
          `     stranded        : ${formatUnits(plan.stranded, 18)} across ${balances.length} outcomes`
      );
      return plan;
    };

    // ── Step 2: read balances and preview both phases ─────────────────────────
    log.log("\n🔍 Step 2: reading balances...");
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

    log.log(
      `\n📊 Projected outcome:\n` +
        `   sUSDS recovered by merging : ${formatUnits(a.amount, 18)}\n` +
        `   sUSDS now                  : ${formatUnits(susdsBefore, 18)}\n` +
        `   sUSDS after                : ${formatUnits(susdsBefore + a.amount, 18)}\n` +
        `   stranded in market B       : ${formatUnits(b.stranded, 18)} outcome tokens\n` +
        `   stranded in market A       : ${formatUnits(a.stranded, 18)} outcome tokens\n` +
        `   (stranded tokens stay in the wallet and are redeemable once the markets resolve)`
    );

    if (b.blocked) {
      log.log(
        `\n   ⚠️  Market B has a zero balance at outcome #${b.minIndex} — phase 2 cannot run,` +
          `\n       and phase 3 will then be capped by whatever OTHER_TOKEN is already held.`
      );
    }
    if (a.blocked) {
      log.log(`\n   ⚠️  Market A has a zero balance at outcome #${a.minIndex} — nothing merges to sUSDS.`);
    }

    if (DRY_RUN) {
      return { mergeableB: b.amount.toString(), mergeableA: a.amount.toString() };
    }

    // ── Step 3: execute, B first then A ───────────────────────────────────────
    // The two historical entries carry `market` but no kind/key, so key off the
    // market address exactly as the original did.
    const alreadyDone = new Set(progress.entries.map((e) => e.market.toLowerCase()));

    const runMerge = async (label, marketAddress, set, balances, amount) => {
      if (alreadyDone.has(marketAddress.toLowerCase())) {
        log.log(`\n⏭  ${label}: already in progress log — skipping`);
        return;
      }
      if (amount === 0n) {
        log.log(`\n⚠️  ${label}: mergeable amount is zero — skipping`);
        return;
      }
      log.log(`\n🔀 ${label}: merging ${formatUnits(amount, 18)} across ${set.length} outcomes`);
      let approvals = 0;
      for (const t of set) if (await ensureAllowance(t, addr.router, amount, { wallet, log })) approvals++;
      log.log(`   ${approvals} new approval(s) sent, ${set.length - approvals} already sufficient`);
      const receipt = await retryTransaction(() => router.mergePositions(COLLATERAL, marketAddress, amount), { log });
      progress.append({
        phase: label,
        kind: "merge",
        key: marketAddress.toLowerCase(),
        market: marketAddress,
        wrappedTokens: set,
        balancesBefore: balances.map((x) => x.toString()),
        merged: amount.toString(),
        leftover: balances.reduce((s, x) => s + (x - amount), 0n).toString(),
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      });
      log.log(`   ✅ Saved to ${progress.path}`);
      await sleep(DELAY_MS);
    };

    await runMerge("Phase 2 — Market B", MARKET_B, setB, balB, b.amount);

    // Re-read A's balances from chain — phase 2 just changed OTHER_TOKEN.
    log.log("\n🔍 Re-reading Market A balances after phase 2...");
    const balA2 = await readBalances(setA);
    const a2 = report(`Phase 3 — Market A (${setA.length} outcomes) → sUSDS [live balances]`, mA, balA2);

    await runMerge("Phase 3 — Market A", MARKET_A, setA, balA2, a2.amount);

    const susdsAfter = await susds.balanceOf(owner);
    log.log(
      `\n🎉 Done. sUSDS ${formatUnits(susdsBefore, 18)} → ${formatUnits(susdsAfter, 18)} ` +
        `(+${formatUnits(susdsAfter - susdsBefore, 18)})`
    );
    log.log(`   Progress: ${progress.path}`);
    log.log("   Next: node verify-l1-unwind.js");
    return { recovered: (susdsAfter - susdsBefore).toString() };
  }
);
