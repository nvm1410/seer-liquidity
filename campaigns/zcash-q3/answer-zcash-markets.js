import { ethers } from "ethers";
import fs from "fs";
import { getMarketInfo, makeMarketView, normalizeName } from "../../lib/market.js";
import { run } from "../../lib/run.js";
import { retryTransaction, sleep } from "../../lib/tx.js";

// ─────────────────────────────────────────────────────────────────────────────
// Submits the Reality.eth answers for the 37 Zcash Q3 CDRGP binary markets.
//
// Each market is a single-select categorical (template 2) with outcomes
// [Yes, No, Invalid result] and ONE Reality question. A single-select answer is
// the outcome's INDEX as bytes32: Yes = 0x…00, No = 0x…01. The index is looked
// up by label on the market itself rather than assumed.
//
// Answers come from zcash-q3-results.json, transcribed by market id from the FPF
// results post (see its `source` / `sourceNote`). Funded -> Yes, Rejected -> No.
// Nothing resolves Invalid: the Abstain and "Would Reconsider" sections are empty.
//
// Questions are PERMISSIONLESS to answer and someone else got to 21 of the 37
// first. So every question is classified against the live chain:
//   unanswered         -> submit, bonding min_bond
//   answered, correct  -> skip
//   answered, WRONG    -> never overridden here. Re-answering costs 2x the
//                         standing bond (bondMustDoubleAndMatchMinimum), which
//                         is a spend decision to make by hand. The run fails at
//                         the end so it cannot pass unnoticed.
//
// This script only SUBMITS answers. A question finalizes `timeout` (302400 s,
// 3.5 days) after its LAST answer; Market.resolve() comes after that, then the
// redeem. Bonds come back through Realitio.claimWinnings after finalization.
// ─────────────────────────────────────────────────────────────────────────────

const EXPECTED_MARKETS = 37;
const EXPECTED_OUTCOMES = ["Yes", "No", "Invalid result"];
const GAS_BUFFER = ethers.parseEther("0.002");
const DELAY_MS = 2000;

const REALITY_ABI = ["function submitAnswer(bytes32,bytes32,uint256) external payable"];

await run(
  {
    name: "answer-zcash-markets",
    slug: "zcash-q3",
    stage: "settle-answer",
    mutating: true,
    // The answer log IS the resume log: re-answering a question costs DOUBLE the
    // standing bond, so skipping what is already submitted is the whole point.
    progress: (m) => m.files.answerLog,
  },
  async (ctx) => {
    const { manifest, provider, wallet, addr, progress, dry: DRY_RUN } = ctx;

    // ── Inputs ──────────────────────────────────────────────────────────────
    const created = JSON.parse(fs.readFileSync(manifest.files.markets, "utf8"));
    const results = JSON.parse(fs.readFileSync(manifest.files.results, "utf8"));
    console.log(`\n📋 Wallet  : ${wallet ? wallet.address : "(none — read-only)"}`);
    console.log(`📄 Results : ${results.source}`);
    console.log(`            ${results.sourcePost}\n`);

    if (created.length !== EXPECTED_MARKETS) throw new Error(`expected ${EXPECTED_MARKETS} markets, got ${created.length}`);
    if (results.results.length !== EXPECTED_MARKETS) {
      throw new Error(`expected ${EXPECTED_MARKETS} results, got ${results.results.length}`);
    }
    const byId = new Map();
    for (const r of results.results) {
      if (byId.has(r.id)) throw new Error(`duplicate result id ${r.id}`);
      if (r.answer !== "Yes" && r.answer !== "No") throw new Error(`result ${r.id}: answer must be Yes or No, got ${r.answer}`);
      byId.set(r.id, r);
    }
    const yes = results.results.filter((r) => r.answer === "Yes").length;
    if (yes !== results.counts.funded || EXPECTED_MARKETS - yes !== results.counts.rejected) {
      throw new Error(`answers are ${yes} Yes / ${EXPECTED_MARKETS - yes} No, source says ${results.counts.funded} / ${results.counts.rejected}`);
    }

    // ── Read every market and build the plan ────────────────────────────────
    const marketView = makeMarketView(addr.marketView, provider);
    const now = Math.floor(Date.now() / 1000);
    const plan = [];

    for (const c of created) {
      const r = byId.get(c.id);
      if (!r) throw new Error(`market ${c.id} ${c.shortName} has no result`);
      if (r.shortName !== c.shortName) throw new Error(`id ${c.id}: result is ${r.shortName}, market is ${c.shortName}`);

      const info = await getMarketInfo(marketView, addr.marketFactory, c.market);
      if (info.templateId !== 2) throw new Error(`${c.shortName}: templateId ${info.templateId}, expected 2`);
      if (info.name !== c.marketName) throw new Error(`${c.shortName}: on-chain name "${info.name}" != creation log "${c.marketName}"`);
      if (info.outcomes.join("|") !== EXPECTED_OUTCOMES.join("|")) {
        throw new Error(`${c.shortName}: outcomes ${info.outcomes.join("/")}, expected ${EXPECTED_OUTCOMES.join("/")}`);
      }
      if (info.questionsIds.length !== 1 || info.questionsIds[0].toLowerCase() !== c.realityQuestionId.toLowerCase()) {
        throw new Error(`${c.shortName}: question id does not match the creation log`);
      }
      // The market name must name the proposal the result is for.
      if (!normalizeName(info.name).includes(normalizeName(r.title))) {
        throw new Error(`${c.shortName}: market name does not contain "${r.title}"`);
      }

      const index = info.outcomes.findIndex((o) => o === r.answer);
      const q = info.questions[0];
      plan.push({
        id: c.id,
        shortName: c.shortName,
        market: c.market,
        name: info.name,
        forumTitle: r.forumTitle,
        answer: r.answer,
        answerHex: ethers.toBeHex(index, 32),
        questionId: info.questionsIds[0],
        q,
      });
    }

    // ── Classify against the chain ──────────────────────────────────────────
    const alreadyLogged = new Set(progress.entries.map((e) => e.key));
    for (const p of plan) {
      const { q } = p;
      if (alreadyLogged.has(p.questionId.toLowerCase())) p.state = "logged";
      else if (q.is_pending_arbitration) p.state = "arbitration";
      else if (Number(q.opening_ts) > now) p.state = "not-open";
      else if (Number(q.finalize_ts) !== 0 && Number(q.finalize_ts) <= now) {
        p.state = BigInt(q.best_answer) === BigInt(p.answerHex) ? "final-correct" : "final-WRONG";
      } else if (q.bond > 0n) {
        p.state = BigInt(q.best_answer) === BigInt(p.answerHex) ? "correct" : "WRONG";
      } else p.state = "submit";
    }

    console.log(" id  market           answer  state          forum title");
    for (const p of plan) {
      const extra = p.q.bond > 0n ? `  (bond ${ethers.formatEther(p.q.bond)}, finalizes ${new Date(Number(p.q.finalize_ts) * 1000).toISOString()})` : "";
      console.log(`${String(p.id).padStart(3)}  ${p.shortName.padEnd(15)}  ${p.answer.padEnd(6)}  ${p.state.padEnd(13)}  ${p.forumTitle}${extra}`);
    }

    const toSubmit = plan.filter((p) => p.state === "submit");
    const wrong = plan.filter((p) => /WRONG/.test(p.state));
    const blocked = plan.filter((p) => p.state === "arbitration" || p.state === "not-open");
    const count = (s) => plan.filter((p) => p.state === s).length;
    console.log(
      `\n🧮 ${toSubmit.length} to submit, ${count("correct") + count("final-correct")} already answered correctly, ` +
        `${count("logged")} in this run's log, ${wrong.length} answered WRONG, ${blocked.length} blocked`
    );

    // ── Bonds / balance ─────────────────────────────────────────────────────
    const totalBond = toSubmit.reduce((acc, p) => acc + p.q.min_bond, 0n);
    console.log(`💰 Bond required: ${ethers.formatEther(totalBond)} ETH for ${toSubmit.length} question(s)`);
    if (wallet && toSubmit.length > 0) {
      const balance = await provider.getBalance(wallet.address);
      console.log(`💰 Wallet balance: ${ethers.formatEther(balance)} ETH`);
      if (balance < totalBond + GAS_BUFFER) {
        const msg =
          `insufficient ETH: need ${ethers.formatEther(totalBond + GAS_BUFFER)} (bonds + gas buffer), ` +
          `have ${ethers.formatEther(balance)}`;
        if (!DRY_RUN) throw new Error(msg);
        console.warn(`⚠️  ${msg} — a live run would refuse.`);
      }
    }

    // ── Submit ──────────────────────────────────────────────────────────────
    console.log(`\n⚙️  Submit phase (${DRY_RUN ? "DRY RUN — no transactions" : "LIVE"})\n`);
    const reality = wallet ? new ethers.Contract(addr.realitio, REALITY_ABI, wallet) : undefined;
    let submitted = 0;
    const errors = [];

    for (const p of toSubmit) {
      const label = `[${String(p.id).padStart(2)}] ${p.shortName}`;
      if (DRY_RUN) {
        console.log(`  ${label}: would submitAnswer(${p.questionId}, ${p.answerHex}, 0) = ${p.answer}, bond ${ethers.formatEther(p.q.min_bond)} ETH`);
        continue;
      }
      console.log(`  ${label}: submitting ${p.answer}...`);
      try {
        // max_previous = 0 disables the previous-bond check; safe because the
        // question was read with bond == 0. If someone answers in between, the
        // tx reverts rather than overpaying, and a rerun classifies it afresh.
        const receipt = await retryTransaction(() =>
          reality.submitAnswer(p.questionId, p.answerHex, 0, { value: p.q.min_bond })
        );
        progress.append({
          kind: "answer",
          key: p.questionId.toLowerCase(),
          id: p.id,
          shortName: p.shortName,
          market: p.market,
          questionId: p.questionId,
          answer: p.answer,
          answerHex: p.answerHex,
          bondWei: p.q.min_bond.toString(),
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          timestamp: new Date().toISOString(),
        });
        submitted++;
        await sleep(DELAY_MS);
      } catch (err) {
        console.error(`  ${label}: submitAnswer() failed after retries: ${err.shortMessage || err.message}`);
        errors.push({ shortName: p.shortName, error: err.shortMessage || err.message });
      }
    }

    // ── Summary ─────────────────────────────────────────────────────────────
    if (DRY_RUN) {
      console.log(`\n🎉 Dry run — ${toSubmit.length} answer(s) would be submitted, bonding ${ethers.formatEther(totalBond)} ETH. Pass --live to execute.`);
    } else {
      console.log(`\n🎉 Submitted ${submitted}/${toSubmit.length} answer(s). Log → ${progress.path}.`);
    }
    const lastFinalize = Math.max(
      ...plan.map((p) => (p.q.bond > 0n ? Number(p.q.finalize_ts) : 0)),
      toSubmit.length ? now + Number(plan[0].q.timeout) : 0
    );
    console.log(`⏳ Last question finalizes ~${new Date(lastFinalize * 1000).toISOString()} if unchallenged; then Market.resolve() on all 37.`);

    if (wrong.length) {
      console.error(`\n❌ ${wrong.length} question(s) carry an answer that contradicts the results — NOT overridden:`);
      wrong.forEach((p) =>
        console.error(`     [${p.id}] ${p.shortName}: best_answer ${p.q.best_answer}, expected ${p.answerHex} (${p.answer}); override needs ≥ ${ethers.formatEther(p.q.bond * 2n)} ETH`)
      );
    }
    if (errors.length) {
      console.error(`\n⚠️  ${errors.length} error(s):`);
      errors.forEach((e) => console.error(`     ${e.shortName}: ${e.error}`));
    }
    if (wrong.length || errors.length) throw new Error(`${wrong.length} wrong answer(s), ${errors.length} failed submission(s) — see above`);
    return { submitted, toSubmit: toSubmit.length };
  }
);
