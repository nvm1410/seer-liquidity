import { ethers } from "ethers";
import fs from "fs";
import { RouterAbi } from "../../abis/RouterAbi.js";
import { getMarketInfo, makeMarketView } from "../../lib/market.js";
import { run } from "../../lib/run.js";
import { finalAnswerProblems, getConditionalTokens, planRedemption, readPayouts } from "../../lib/settle.js";
import { ensureAllowance, retryTransaction, sleep } from "../../lib/tx.js";

// ─────────────────────────────────────────────────────────────────────────────
// Resolves the 37 Zcash Q3 CDRGP markets and redeems what the wallet still holds
// of each WINNING outcome back into sUSDS. Written to be scheduled
// (tools/schedule.js), approved before the questions finalize and fired after.
//
//   answer-zcash-markets.js -> [questions finalize] -> THIS
//
// What makes it safe to fire unattended is finalAnswerProblems (lib/settle.js):
// the winning outcome of every market comes from zcash-q3-results.json, fixed at
// approval, and a live run refuses before its first transaction unless EVERY
// question is final AND its best_answer is that approved answer. A re-answered,
// disputed or still-open question stops the whole run; nothing is resolved on a
// contested answer.
//
// Per market, in order:
//   1. Market.resolve() — permissionless; skipped if someone already did it.
//   2. the payout vector is read back and must pay the approved outcome only.
//   3. Router.redeemPositions(sUSDS, market, [winner], [balance]). The losing
//      side and "Invalid result" pay 0 and stay in the wallet (planRedemption
//      skips them rather than burning them for nothing).
//
// Output discipline, because tools/schedule.js hashes the dry run: the PLAN
// (markets, winners, tokens, which hold something) is printed plainly; CHAIN
// STATE (final or not, resolved or not) goes on "~ " status lines, which
// lib/transcript.js planShape drops. So a dry run taken before finalization and
// one taken after have the same shape.
//
// Redeeming is recomputed from LIVE balances, so a resumed run cannot redo or
// skip work; the progress file is an audit trail.
//
//   node campaigns/zcash-q3/resolve-redeem-zcash-markets.js          # dry
//   node campaigns/zcash-q3/resolve-redeem-zcash-markets.js --live   # sends
// ─────────────────────────────────────────────────────────────────────────────

const EXPECTED_MARKETS = 37;
const EXPECTED_OUTCOMES = ["Yes", "No", "Invalid result"];
const MIN_ETH = ethers.parseEther("0.003"); // ~111 txs on Optimism is well under this
const DELAY_MS = 1500;

const MARKET_ABI = ["function resolve() external"];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

await run(
  {
    name: "resolve-redeem-zcash-markets",
    slug: "zcash-q3",
    stage: "settle-resolve-redeem",
    mutating: true,
  },
  async (ctx) => {
    const { manifest, provider, wallet, addr, log, progress, dry: DRY_RUN } = ctx;
    const COLLATERAL = manifest.chain.collateral.address;
    const owner = await wallet.getAddress();
    const fmt = (v) => ethers.formatUnits(v, 18);

    // ── Inputs ──────────────────────────────────────────────────────────────
    const created = JSON.parse(fs.readFileSync(manifest.files.markets, "utf8"));
    const results = JSON.parse(fs.readFileSync(manifest.files.results, "utf8"));
    log.log(`\n📋 Wallet  : ${owner}`);
    log.log(`📄 Results : ${manifest.files.results} (${results.counts.funded} Yes / ${results.counts.rejected} No)`);
    if (created.length !== EXPECTED_MARKETS) throw new Error(`expected ${EXPECTED_MARKETS} markets, got ${created.length}`);
    const byId = new Map(results.results.map((r) => [r.id, r]));
    if (byId.size !== EXPECTED_MARKETS) throw new Error(`expected ${EXPECTED_MARKETS} distinct results, got ${byId.size}`);

    // ── Read every market, check it is the one the logs say ─────────────────
    const marketView = makeMarketView(addr.marketView, provider);
    const markets = [];
    for (const c of created) {
      const r = byId.get(c.id);
      if (!r || r.shortName !== c.shortName) throw new Error(`id ${c.id} ${c.shortName}: no matching result`);
      if (r.answer !== "Yes" && r.answer !== "No") throw new Error(`${c.shortName}: answer must be Yes or No, got ${r.answer}`);
      const info = await getMarketInfo(marketView, addr.marketFactory, c.market);
      if (info.name !== c.marketName) throw new Error(`${c.shortName}: on-chain name differs from the creation log`);
      if (info.isConditional) throw new Error(`${c.shortName}: expected a top-level market`);
      if (info.collateralToken.toLowerCase() !== COLLATERAL.toLowerCase()) throw new Error(`${c.shortName}: collateral is not sUSDS`);
      if (info.outcomes.join("|") !== EXPECTED_OUTCOMES.join("|")) throw new Error(`${c.shortName}: outcomes ${info.outcomes.join("/")}`);
      if (info.questionsIds.length !== 1 || info.questionsIds[0].toLowerCase() !== c.realityQuestionId.toLowerCase()) {
        throw new Error(`${c.shortName}: question id does not match the creation log`);
      }
      const winner = info.outcomes.indexOf(r.answer);
      const balances = await Promise.all(info.wrappedTokens.map((t) => new ethers.Contract(t, ERC20_ABI, provider).balanceOf(owner)));
      markets.push({ id: c.id, label: `[${String(c.id).padStart(2)}] ${c.shortName}`, address: c.market, answer: r.answer, winner, info, balances });
    }

    // ── The plan ────────────────────────────────────────────────────────────
    // Amounts are unpadded: a padded column would move whitespace in the hashed
    // line whenever an amount's width changed.
    log.log(`\n id  market           winner  token                                       action                       held (winner)`);
    let expectedTotal = 0n;
    for (const m of markets) {
      const held = m.balances[m.winner];
      expectedTotal += held; // a binary pays its winner 1:1
      const action = held > 0n ? "resolve, redeem" : "resolve, nothing to redeem";
      log.log(`${m.label.padEnd(20)}  ${m.answer.padEnd(6)}  ${m.info.wrappedTokens[m.winner]}  ${action.padEnd(27)}  ${fmt(held)}`);
    }
    const losing = markets.reduce((a, m) => a + m.balances.reduce((s, b, i) => (i === m.winner ? s : s + b), 0n), 0n);
    const susds = new ethers.Contract(COLLATERAL, ERC20_ABI, provider);
    const susdsBefore = await susds.balanceOf(owner);
    const toRedeem = markets.filter((m) => m.balances[m.winner] > 0n);
    log.log(
      `\n📊 ${markets.length} markets to resolve, ${toRedeem.length} to redeem\n` +
        `   expected proceeds : ${fmt(expectedTotal)} sUSDS\n` +
        `   losing + Invalid  : ${fmt(losing)} tokens held, worth 0, left in the wallet`
    );

    // ── Chain state (status lines: not part of the plan's shape) ────────────
    // Chain time, not the local clock: Reality compares against block.timestamp.
    const now = (await provider.getBlock("latest")).timestamp;
    const problems = finalAnswerProblems(
      markets.map((m) => ({ label: m.label.trim(), questions: m.info.questions, expected: [ethers.toBeHex(m.winner, 32)] })),
      now
    );
    const lastFinal = Math.max(...markets.map((m) => Number(m.info.questions[0].finalize_ts)));
    const resolvedAlready = markets.filter((m) => m.info.payoutReported).length;
    log.log(`\n~ ${problems.length} problem(s) against the approved answers; last question finalizes ${new Date(lastFinal * 1000).toISOString()}`);
    log.log(`~ ${resolvedAlready}/${markets.length} market(s) already resolved`);
    for (const p of problems) log.log(`~   ${p}`);
    const eth = await provider.getBalance(owner);
    log.log(`~ wallet ETH ${fmt(eth)}, sUSDS ${fmt(susdsBefore)}`);

    if (DRY_RUN) {
      log.log(
        problems.length
          ? `~ a live run NOW would refuse before sending anything`
          : `~ every answer is final and matches — a live run would proceed`
      );
      return { markets: markets.length, toRedeem: toRedeem.length, expected: expectedTotal.toString() };
    }

    // ── Live: refuse before the first transaction ───────────────────────────
    if (problems.length) {
      throw new Error(`nothing sent — ${problems.length} question(s) are not final with the approved answer:\n  ${problems.join("\n  ")}`);
    }
    if (eth < MIN_ETH) throw new Error(`nothing sent — wallet ETH ${fmt(eth)} < ${fmt(MIN_ETH)} for gas`);

    const router = new ethers.Contract(addr.router, RouterAbi, wallet);
    const conditionalTokens = await getConditionalTokens(router, provider);
    const errors = [];

    // Phase 1: resolve.
    log.log(`\n⚙️  Resolve phase`);
    for (const m of markets) {
      if (m.info.payoutReported) {
        log.log(`  ${m.label}: already resolved`);
        continue;
      }
      try {
        const receipt = await retryTransaction(() => new ethers.Contract(m.address, MARKET_ABI, wallet).resolve(), { log });
        progress.append({ kind: "resolve", key: m.address.toLowerCase(), market: m.address, shortName: m.label.trim(), txHash: receipt.hash, blockNumber: receipt.blockNumber, timestamp: new Date().toISOString() });
        log.log(`  ${m.label}: resolved (${receipt.hash})`);
        await sleep(DELAY_MS);
      } catch (err) {
        log.error(`  ${m.label}: resolve() failed: ${err.shortMessage || err.message}`);
        errors.push(`${m.label.trim()} resolve: ${err.shortMessage || err.message}`);
      }
    }

    // Phase 2: check the payouts, then redeem from live balances.
    log.log(`\n💰 Redeem phase`);
    for (const m of markets) {
      try {
        const p = await readPayouts(m.address, m.info.outcomes.length, { provider, conditionalTokens });
        const paysOnlyWinner = p.numerators.every((n, i) => (i === m.winner ? n > 0n : n === 0n));
        if (!paysOnlyWinner) throw new Error(`payout [${p.numerators.join(",")}] does not pay ${m.answer} alone — not redeeming`);
        const balances = await Promise.all(m.info.wrappedTokens.map((t) => new ethers.Contract(t, ERC20_ABI, provider).balanceOf(owner)));
        const plan = planRedemption({ tokens: m.info.wrappedTokens, balances, numerators: p.numerators, denominator: p.denominator, outcomes: m.info.outcomes });
        if (!plan.rows.length) {
          log.log(`  ${m.label}: nothing to redeem`);
          continue;
        }
        for (const r of plan.rows) await ensureAllowance(r.token, addr.router, r.amount, { wallet, log });
        const indexes = plan.rows.map((r) => r.index);
        const amounts = plan.rows.map((r) => r.amount);
        const receipt = await retryTransaction(() => router.redeemPositions(COLLATERAL, m.address, indexes, amounts), { log });
        progress.append({
          kind: "redeem",
          key: m.address.toLowerCase(),
          market: m.address,
          shortName: m.label.trim(),
          outcomeIndexes: indexes,
          amounts: amounts.map(String),
          expectedProceeds: plan.total.toString(),
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          timestamp: new Date().toISOString(),
        });
        log.log(`  ${m.label}: redeemed ${fmt(plan.total)} sUSDS (${receipt.hash})`);
        await sleep(DELAY_MS);
      } catch (err) {
        log.error(`  ${m.label}: ${err.shortMessage || err.message}`);
        errors.push(`${m.label.trim()} redeem: ${err.shortMessage || err.message}`);
      }
    }

    // ── Verify against the chain ────────────────────────────────────────────
    const susdsAfter = await susds.balanceOf(owner);
    const delta = susdsAfter - susdsBefore;
    log.log(`\n🎉 sUSDS ${fmt(susdsBefore)} → ${fmt(susdsAfter)} (+${fmt(delta)}), expected +${fmt(expectedTotal)}`);
    const diff = delta > expectedTotal ? delta - expectedTotal : expectedTotal - delta;
    if (diff > 10n ** 12n) errors.push(`proceeds off by ${fmt(diff)} sUSDS from the plan`);
    log.log(`   Progress: ${progress.path}. Re-run dry to confirm nothing redeemable is left.`);
    if (errors.length) throw new Error(`${errors.length} problem(s):\n  ${errors.join("\n  ")}`);
    return { recovered: delta.toString(), expected: expectedTotal.toString() };
  }
);
