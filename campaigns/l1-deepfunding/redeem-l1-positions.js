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
//   node redeem-l1-positions.js --resume          # dry: full per-outcome table + chunk plan
//   node redeem-l1-positions.js --resume --live   # sends, after a confirmation
//
// --resume is required because the progress file IS the historical record of the
// 2026-09-01 redemption (manifest files.redeem).

import { ethers } from "ethers";
import { erc20Abi, formatUnits } from "viem";
import { RouterAbi } from "../../abis/RouterAbi.js";
import { runBatched } from "../../lib/batch.js";
import { assertMarket, getMarketInfo, makeMarketView } from "../../lib/market.js";
import { run } from "../../lib/run.js";
import { chunkRedemption, getConditionalTokens, planRedemption, readPayouts } from "../../lib/settle.js";
import { ensureAllowance, retryTransaction, sleep } from "../../lib/tx.js";

// Outcomes per redeemPositions call. Each call does a transferFrom + unwrap per outcome
// before the ConditionalTokens redeem, so a 67-outcome market is chunked rather than sent
// as one very large transaction.
const CHUNK_SIZE = 15;

const DELAY_MS = 2000;

await run(
  {
    name: "redeem-l1-positions",
    slug: "l1-deepfunding",
    stage: "settle-redeem",
    mutating: true,
    progress: (m) => m.files.redeem,
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
    const conditionalTokens = await getConditionalTokens(router, provider);

    // ── Step 1: resolve both markets from chain ───────────────────────────────
    log.log("\n🔍 Step 1: reading markets A and B from chain...");
    const marketView = makeMarketView(addr.marketView, provider);
    const mA = await getMarketInfo(marketView, addr.marketFactory, MARKET_A);
    const mB = await getMarketInfo(marketView, addr.marketFactory, MARKET_B);

    await assertMarket(mA, { label: "Market A", collateral: COLLATERAL, topLevel: true });
    await assertMarket(mB, { label: "Market B", parentMarket: MARKET_A });
    const parentOutcome = mB.parentOutcomeIndex;
    if (mB.parentOutcomeToken?.toLowerCase() !== otherLower) {
      throw new Error(`Market B's parent outcome token is not ${OTHER_TOKEN}`);
    }
    if (!mA.payoutReported || !mB.payoutReported) {
      throw new Error(
        `Payouts not reported yet (A ${mA.payoutReported}, B ${mB.payoutReported}) — run resolve-l1-markets.js first.`
      );
    }

    const setA = [...mA.wrappedTokens];
    const setB = [...mB.wrappedTokens];
    log.log(`   Market A ${MARKET_A}: ${setA.length} outcomes, payoutReported ${mA.payoutReported}`);
    log.log(
      `   Market B ${MARKET_B}: ${setB.length} outcomes, payoutReported ${mB.payoutReported}, ` +
        `parent = A #${parentOutcome} (${OTHER_TOKEN})`
    );

    // ── Step 2: read payout vectors ───────────────────────────────────────────
    log.log("\n🔍 Step 2: reading payout vectors...");
    const pA = await readPayouts(MARKET_A, setA.length, { provider, conditionalTokens });
    const pB = await readPayouts(MARKET_B, setB.length, { provider, conditionalTokens });
    if (!pA.isRoot) {
      throw new Error(`Market A parentCollectionId is ${pA.parentCollectionId}, expected zero (root market).`);
    }
    if (pB.isRoot) {
      throw new Error("Market B parentCollectionId is zero — expected a child market.");
    }
    log.log(`   A: conditionId ${pA.conditionId} denominator ${pA.denominator}`);
    log.log(`   B: conditionId ${pB.conditionId} denominator ${pB.denominator}`);

    const susds = new ethers.Contract(COLLATERAL, erc20Abi, provider);
    const susdsBefore = await susds.balanceOf(owner);

    // Batched deliberately: 68 parallel balanceOf calls is how you get throttled.
    const readBalances = (tokens) =>
      runBatched(tokens, (t) => new ethers.Contract(t, erc20Abi, provider).balanceOf(owner), {
        batchSize: 20,
        pauseMs: 500,
      });

    // Build the redemption plan for one market and print the full per-outcome table.
    const plan = (label, info, tokens, numerators, denominator, balances) => {
      const f = (v) => Number(formatUnits(v, 18)).toFixed(4).padStart(13);
      log.log(`\n   ${label}`);
      log.log("     #   outcome                                    balance         payout   action");

      const result = planRedemption({ tokens, balances, numerators, denominator, outcomes: info.outcomes });
      for (const row of result.table) {
        const name = String(row.name).slice(0, 38);
        log.log(`    ${String(row.index).padStart(2)}   ${name.padEnd(38)}${f(row.balance)}${f(row.payout)}   ${row.action}`);
      }

      log.log(
        `\n     to redeem       : ${result.rows.length}/${balances.length} outcomes\n` +
          `     proceeds        : ${formatUnits(result.total, 18)}\n` +
          `     left in wallet  : ${formatUnits(result.zeroPayoutHeld, 18)} zero-payout tokens (worth 0)`
      );
      if (result.dustHeld > 0n) {
        log.log(`     ⚠️  ${formatUnits(result.dustHeld, 18)} tokens redeem to 0 after rounding but are still included`);
      }
      return result;
    };

    // ── Step 3: read balances and preview both phases ─────────────────────────
    log.log("\n🔍 Step 3: reading balances...");
    const balB = await readBalances(setB);
    const balA = await readBalances(setA);

    const b = plan(`Phase 1 — Market B (${setB.length} outcomes) → OTHER_TOKEN`, mB, setB, pB.numerators, pB.denominator, balB);

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

    log.log(
      `\n📊 Projected outcome:\n` +
        `   OTHER_TOKEN from phase 1    : ${formatUnits(b.total, 18)}\n` +
        `   sUSDS from phase 2          : ${formatUnits(a.total, 18)}\n` +
        `   sUSDS now                   : ${formatUnits(susdsBefore, 18)}\n` +
        `   sUSDS after                 : ${formatUnits(susdsBefore + a.total, 18)}\n` +
        `   txs: ${chunkRedemption(b.rows, CHUNK_SIZE).length} + ${chunkRedemption(a.rows, CHUNK_SIZE).length} redeem calls, ` +
        `up to ${b.rows.length + a.rows.length} approvals`
    );

    if (b.rows.length === 0 && a.rows.length === 0) {
      log.log("\n✅ Nothing left to redeem.");
      return { redeemed: 0 };
    }

    if (DRY_RUN) {
      return { toRedeemB: b.rows.length, toRedeemA: a.rows.length, projected: a.total.toString() };
    }

    // ── Step 4: execute, B first then A ───────────────────────────────────────
    // Chunks are always recomputed from LIVE balances: a redeemed outcome ends at zero and
    // drops out of the plan by itself, so the progress file is an audit trail, not the
    // source of truth for what still needs doing.
    const runRedeem = async (label, marketAddress, rows) => {
      if (rows.length === 0) {
        log.log(`\n⏭  ${label}: nothing to redeem — skipping`);
        return;
      }
      const chunks = chunkRedemption(rows, CHUNK_SIZE);
      log.log(`\n💰 ${label}: redeeming ${rows.length} outcomes in ${chunks.length} tx(s)`);

      for (const [ci, c] of chunks.entries()) {
        log.log(
          `\n   Chunk ${ci + 1}/${chunks.length}: outcomes [${c.rows.map((r) => r.index).join(", ")}] ` +
            `worth ${formatUnits(c.expected, 18)}`
        );

        let approvals = 0;
        for (const r of c.rows) if (await ensureAllowance(r.token, addr.router, r.amount, { wallet, log })) approvals++;
        log.log(`   ${approvals} new approval(s), ${c.rows.length - approvals} already sufficient`);

        const outcomeIndexes = c.rows.map((r) => r.index);
        const amounts = c.rows.map((r) => r.amount);

        // estimateGas lives inside the retry so a transient stale-node revert is retried
        // rather than aborting the whole run.
        const receipt = await retryTransaction(
          async () => {
            const gas = await router.redeemPositions.estimateGas(COLLATERAL, marketAddress, outcomeIndexes, amounts);
            log.log(`   estimateGas ${gas}`);
            return router.redeemPositions(COLLATERAL, marketAddress, outcomeIndexes, amounts, {
              gasLimit: (gas * 12n) / 10n,
            });
          },
          { log }
        );

        progress.append({
          phase: label,
          kind: "redeem",
          key: `${marketAddress.toLowerCase()}#${ci}`,
          market: marketAddress,
          chunk: ci,
          outcomeIndexes,
          tokens: c.rows.map((r) => r.token),
          amounts: amounts.map((x) => x.toString()),
          expectedProceeds: c.expected.toString(),
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed.toString(),
          timestamp: new Date().toISOString(),
        });
        await sleep(DELAY_MS);
      }
      log.log(`   ✅ ${label} complete — logged to ${progress.path}`);
    };

    await runRedeem("Phase 1 — Market B", MARKET_B, b.rows);

    // Re-read A's balances from chain — phase 1 just minted OTHER_TOKEN.
    log.log("\n🔍 Re-reading Market A balances after phase 1...");
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
    const susdsAfter = await susds.balanceOf(owner);
    const delta = susdsAfter - susdsBefore;
    log.log(
      `\n🎉 Done. sUSDS ${formatUnits(susdsBefore, 18)} → ${formatUnits(susdsAfter, 18)} ` +
        `(+${formatUnits(delta, 18)})`
    );
    log.log(`   expected +${formatUnits(a2.total, 18)}`);
    const diff = delta > a2.total ? delta - a2.total : a2.total - delta;
    if (diff > 10n ** 12n) {
      log.log(`   ⚠️  off by ${formatUnits(diff, 18)} sUSDS — investigate before assuming success.`);
    } else {
      log.log(`   ✅ matches projection (diff ${formatUnits(diff, 18)}).`);
    }
    log.log(`   Progress: ${progress.path}`);
    log.log("   Re-run this script dry to confirm nothing redeemable is left.");
    return { recovered: delta.toString(), expected: a2.total.toString() };
  }
);
