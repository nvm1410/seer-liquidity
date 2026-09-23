import { ethers } from "ethers";
import fs from "fs";
import { getMarketInfo, makeMarketView, normalizeIdentifier } from "./lib/market.js";
import { run } from "./lib/run.js";
import { retryTransaction, sleep } from "./lib/tx.js";

// ─────────────────────────────────────────────────────────────────────────────
// Submits the Reality.eth answers for the two L1 (Deep Funding GG24) markets on
// Optimism, using the juror weights in l1weightsForResolution.csv.
//
// Both markets are MULTI_SCALAR (templateId 1): one Reality question per outcome,
// and the "Invalid result" slot has no question — hence 67 questions for A's 68
// outcomes and 32 for B's 33.
//
//   Market A  0x3220…0BA6  top-level, sUSDS collateral
//             outcomes 0-65  = 66 repos
//             outcome  66    = "Other repositories not present on the market…"
//             outcome  67    = "Invalid result" (no question)
//   Market B  0xfea4…245b  conditional on A#66, collateral = A's OTHER token
//             outcomes 0-31  = 32 repos (the tail of the same ranking)
//             outcome  32    = "Invalid result" (no question)
//
// UNIT: the question reads "What will be the juror weight … of [repository]…?"
// with upperBound = 1e18, so the answer is the weight as a FRACTION OF 1 scaled
// by 1e18: 0.0456649495 -> 45664949500000000.  (The Octant market was a [percent]
// question with upperBound = 100e18 — do not copy that scale here.)
//
// A#66 is answered with the SUM of B's 32 weights. That makes redemption exact
// end to end: a B token redeems to w_j/ΣB of an OTHER token, which redeems to
// ΣB/ΣA_total sUSDS — the product is exactly w_j.
//
// RealityProxy.resolveMultiScalarMarket (src/RealityProxy.sol:157-190) uses each
// raw answer as payouts[i], capped at 2**128-1 ≈ 3.4e38, so only RATIOS matter.
//
// This script only SUBMITS answers. Questions finalize 302400 s (3.5 days) later;
// Market.resolve() must then be called on each (see resolve-l1-markets.js).
// ─────────────────────────────────────────────────────────────────────────────

// ── Config ──────────────────────────────────────────────────────────────────
const ANSWER_DECIMALS = 18;
const GAS_BUFFER = ethers.parseEther("0.002");
const DELAY_MS = 2000;

// The catch-all outcome on market A that market B hangs off. Answered with the
// SUM of market B's weights — that is what makes two-level redemption exact.
const OTHER_PREFIX = "Other repositories";
const INVALID_LABEL = "Invalid result";

// ── ABIs ────────────────────────────────────────────────────────────────────
const REALITY_ABI = ["function submitAnswer(bytes32,bytes32,uint256) external payable"];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];


// ── Helpers ──────────────────────────────────────────────────────────────────


// On-chain outcome names that don't match the CSV after normalization.
// key: normalized on-chain outcome → value: normalized CSV repo name
const ALIASES = {
  // Market B#31 is stored on-chain as "lambdaclass/lambda_ethereum_consensus\t"
  // — a literal backslash + "t" (bytes 0x5c 0x74), a stray escape sequence baked
  // in when the market was created. normalizeIdentifier() drops the backslash but keeps
  // the "t", so it needs an explicit mapping.
  lambdaclasslambdaethereumconsensust: "lambdaclasslambdaethereumconsensus",
};

/** repo,parent,weight — weight kept as a STRING so parseUnits stays exact. */
function readCsv(path) {
  const lines = fs.readFileSync(path, "utf8").trim().split(/\r?\n/);
  const header = lines[0].split(",").map((h) => h.trim());
  const iRepo = header.indexOf("repo");
  const iWeight = header.indexOf("weight");
  if (iRepo < 0 || iWeight < 0) throw new Error(`${path}: expected "repo" and "weight" columns, got ${header}`);

  return lines
    .slice(1)
    .filter(Boolean)
    .map((line, n) => {
      const cells = line.split(",").map((c) => c.trim());
      const repo = cells[iRepo];
      const weight = cells[iWeight];
      if (!repo || !weight || isNaN(Number(weight))) {
        throw new Error(`${path} line ${n + 2}: unparseable row "${line}"`);
      }
      return { repo, weight, answerWei: ethers.parseUnits(weight, ANSWER_DECIMALS) };
    });
}

async function balancesOf(tokens, owner, provider) {
  const out = [];
  for (let i = 0; i < tokens.length; i += 20) {
    const chunk = tokens.slice(i, i + 20);
    out.push(...(await Promise.all(chunk.map((t) => new ethers.Contract(t, ERC20_ABI, provider).balanceOf(owner)))));
  }
  return out;
}

// ── Main ─────────────────────────────────────────────────────────────────────
await run(
  {
    name: "answer-l1-markets",
    slug: "l1-deepfunding",
    stage: "settle-answer",
    mutating: true,
    // The answer log IS the resume log: re-answering costs DOUBLE the standing
    // bond, so skipping what is already submitted is the point.
    progress: (m) => m.files.answerLog,
  },
  async (ctx) => {
  const { manifest, provider, wallet, addr, log, progress, dry: DRY_RUN } = ctx;
  const [MARKET_A, MARKET_B] = manifest.results.marketAddresses;
  const CSV_FILE = manifest.files.answers;
  const MARKETS = [
    { label: "A", address: MARKET_A, expectedOutcomes: 68, expectedQuestions: 67, repoCount: 66 },
    { label: "B", address: MARKET_B, expectedOutcomes: 33, expectedQuestions: 32, repoCount: 32 },
  ];

  console.log(`\n📋 Wallet   : ${wallet ? wallet.address : "(none — read-only)"}`);
  console.log(`📋 Markets  : A ${MARKET_A}\n              B ${MARKET_B}\n`);

  // ── Read the weights ────────────────────────────────────────────────────
  const csvRows = readCsv(CSV_FILE);
  console.log(`📄 ${CSV_FILE}: ${csvRows.length} data row(s) parsed`);

  const byName = new Map();
  for (const row of csvRows) {
    const key = normalizeIdentifier(row.repo);
    if (byName.has(key)) throw new Error(`duplicate repo in ${CSV_FILE}: "${row.repo}" (normalized "${key}")`);
    byName.set(key, row);
  }

  const csvTotal = csvRows.reduce((acc, r) => acc + r.answerWei, 0n);
  console.log(`🧮 CSV weights sum to ${ethers.formatUnits(csvTotal, ANSWER_DECIMALS)}`);
  const one = 10n ** BigInt(ANSWER_DECIMALS);
  const drift = csvTotal > one ? csvTotal - one : one - csvTotal;
  if (drift > one / 1_000_000n) {
    throw new Error(`CSV weights sum to ${ethers.formatUnits(csvTotal, 18)}, expected 1.0 within 1e-6`);
  }

  // ── Read both markets and build the plan ────────────────────────────────
  const marketView = makeMarketView(addr.marketView, provider);
  const used = new Set();
  const unmatched = [];
  const state = {};

  for (const m of MARKETS) {
    const info = await getMarketInfo(marketView, addr.marketFactory, m.address);
    console.log(`\n🔗 Market ${m.label}  ${m.address}`);
    console.log(`   ${info.name}`);
    console.log(
      `   templateId ${info.templateId} | bounds ${info.lowerBound}..${info.upperBound} | ` +
        `outcomes ${info.outcomes.length} | questions ${info.questionsIds.length} | payoutReported ${info.payoutReported}`
    );

    // ── Structural assertions ───────────────────────────────────────────
    if (info.templateId !== 1) {
      throw new Error(`market ${m.label}: expected templateId 1 (uint), got ${info.templateId}`);
    }
    if (info.outcomes.length !== m.expectedOutcomes) {
      throw new Error(`market ${m.label}: expected ${m.expectedOutcomes} outcomes, got ${info.outcomes.length}`);
    }
    if (info.questionsIds.length !== m.expectedQuestions) {
      throw new Error(`market ${m.label}: expected ${m.expectedQuestions} questions, got ${info.questionsIds.length}`);
    }
    if (info.outcomes[m.expectedOutcomes - 1] !== INVALID_LABEL) {
      throw new Error(
        `market ${m.label}: last outcome is "${info.outcomes[m.expectedOutcomes - 1]}", expected "${INVALID_LABEL}"`
      );
    }
    if (info.payoutReported) throw new Error(`market ${m.label}: payout already reported — nothing to answer`);

    // Every outcome up to repoCount must be a repo present in the CSV. Market A
    // additionally has the OTHER slot at index 66, answered with ΣB below.
    const plan = [];
    for (let i = 0; i < m.expectedQuestions; i++) {
      const outcome = info.outcomes[i];

      if (m.label === "A" && i === m.repoCount) {
        if (!outcome.startsWith(OTHER_PREFIX)) {
          throw new Error(`market A outcome ${i} is "${outcome}", expected it to start with "${OTHER_PREFIX}"`);
        }
        plan.push({ index: i, outcome, repo: null, weight: null, answerWei: null, questionId: info.questionsIds[i] });
        continue;
      }

      const nk = normalizeIdentifier(outcome);
      const row = byName.get(nk) ?? byName.get(ALIASES[nk]);
      if (!row) {
        unmatched.push(`${m.label}#${i} "${outcome}"`);
        continue;
      }
      const key = normalizeIdentifier(row.repo);
      if (used.has(key)) throw new Error(`CSV row "${row.repo}" matched by two outcomes`);
      used.add(key);

      plan.push({
        index: i,
        outcome,
        repo: row.repo,
        weight: row.weight,
        answerWei: row.answerWei,
        questionId: info.questionsIds[i],
      });
    }

    state[m.label] = { m, info, plan };
  }

  // ── Mapping must be exhaustive in both directions ───────────────────────
  const leftovers = csvRows.filter((r) => !used.has(normalizeIdentifier(r.repo)));
  if (unmatched.length) {
    console.error(`\n❌ ${unmatched.length} on-chain outcome(s) have no CSV row:`);
    unmatched.forEach((o) => console.error(`     ${o}`));
  }
  if (leftovers.length) {
    console.error(`\n❌ ${leftovers.length} CSV row(s) unused:`);
    leftovers.forEach((r) => console.error(`     "${r.repo}"`));
  }
  if (unmatched.length || leftovers.length) {
    throw new Error("outcome ↔ CSV mapping is incomplete — aborting before any transaction");
  }

  // ── A#66 = Σ (market B's 32 weights) ────────────────────────────────────
  const sumB = state.B.plan.reduce((acc, p) => acc + p.answerWei, 0n);
  const otherEntry = state.A.plan.find((p) => p.repo === null);
  otherEntry.answerWei = sumB;
  otherEntry.weight = ethers.formatUnits(sumB, ANSWER_DECIMALS);

  const sumARepos = state.A.plan.filter((p) => p.repo !== null).reduce((acc, p) => acc + p.answerWei, 0n);
  const sumA = sumARepos + sumB;

  if (sumA !== csvTotal) {
    throw new Error(`market A payouts sum to ${sumA} but the CSV totals ${csvTotal} — mapping is inconsistent`);
  }
  if (otherEntry.answerWei !== sumB) throw new Error("A#66 identity check failed");

  // ── Per-answer sanity ───────────────────────────────────────────────────
  for (const { m, info, plan } of Object.values(state)) {
    for (const p of plan) {
      if (p.answerWei === null) throw new Error(`market ${m.label}#${p.index}: no answer computed`);
      if (p.answerWei <= info.lowerBound) {
        throw new Error(`market ${m.label}#${p.index} "${p.outcome}": answer ${p.answerWei} <= lowerBound ${info.lowerBound}`);
      }
      if (p.answerWei >= info.upperBound) {
        throw new Error(`market ${m.label}#${p.index} "${p.outcome}": answer ${p.answerWei} >= upperBound ${info.upperBound}`);
      }
      p.answerHex = ethers.toBeHex(p.answerWei, 32);
    }
  }

  // ── Print the full plan ─────────────────────────────────────────────────
  for (const { m, plan } of Object.values(state)) {
    console.log(`\n📊 Market ${m.label} — ${plan.length} answer(s)`);
    console.log("    #  outcome                                             weight          answer (wei)");
    for (const p of plan) {
      console.log(
        `   ${String(p.index).padStart(2)}  ${p.outcome.replace(/\s+/g, " ").slice(0, 50).padEnd(50)} ` +
          `${String(p.weight).padStart(14)}  ${p.answerWei}`
      );
    }
  }
  console.log(`\n🧮 Σ market A payouts (66 repos + Other) = ${sumA}  (${ethers.formatUnits(sumA, 18)})`);
  console.log(`🧮 Σ market B payouts (32 repos)          = ${sumB}  (${ethers.formatUnits(sumB, 18)})`);
  console.log(`🧮 A#66 "Other repositories"              = ${otherEntry.answerWei} — equals Σ market B ✅`);

  // ── Economic check: what these answers make the stranded tokens worth ────
  if (wallet) {
    console.log(`\n💵 Implied redemption for ${wallet.address} at these payouts:`);
    const payoutsA = state.A.info.outcomes.map((_, i) => state.A.plan.find((p) => p.index === i)?.answerWei ?? 0n);
    const payoutsB = state.B.info.outcomes.map((_, i) => state.B.plan.find((p) => p.index === i)?.answerWei ?? 0n);

    const balA = await balancesOf(state.A.info.wrappedTokens, wallet.address, provider);
    const balB = await balancesOf(state.B.info.wrappedTokens, wallet.address, provider);

    // A tokens redeem straight to sUSDS at payout_i / ΣA.
    const fromA = balA.reduce((acc, b, i) => acc + (b * payoutsA[i]) / sumA, 0n);
    // B tokens redeem to OTHER at w_j / ΣB, and OTHER then redeems to sUSDS at ΣB / ΣA.
    const otherFromB = balB.reduce((acc, b, j) => acc + (b * payoutsB[j]) / sumB, 0n);
    const fromB = (otherFromB * sumB) / sumA;

    console.log(`   market A holdings → ${ethers.formatUnits(fromA, 18)} sUSDS (includes any OTHER already held)`);
    console.log(
      `   market B holdings → ${ethers.formatUnits(otherFromB, 18)} OTHER → ${ethers.formatUnits(fromB, 18)} sUSDS`
    );
    console.log(`   ─────────────────────────────────────────────`);
    console.log(`   total            → ${ethers.formatUnits(fromA + fromB, 18)} sUSDS`);
    console.log(`   (sanity: weights sum to 1, so Σ balance×weight ≈ the MEAN per-outcome`);
    console.log(`    balance, not the ~487k total the unwind stranded. With ~351k spread`);
    console.log(`    over 67 A outcomes, ~5k sUSDS is the expected order of magnitude.`);
    console.log(`    A result far outside that means the weights or the mapping are`);
    console.log(`    wrong — stop before bonding.)`);
  }

  // ── Load progress log (resume after a crash) ────────────────────────────
  const alreadyAnswered = new Set(progress.entries.map((e) => e.questionId.toLowerCase()));

  // ── Bonds / balance ─────────────────────────────────────────────────────
  // Only count questions this run would actually bond — otherwise a resume after
  // a partial (or complete) run fails closed on an already-spent budget.
  const now = Math.floor(Date.now() / 1000);
  let totalBond = 0n;
  let outstanding = 0;
  for (const { info, plan } of Object.values(state)) {
    for (const p of plan) {
      const q = info.questions[p.index];
      if (alreadyAnswered.has(p.questionId.toLowerCase()) || q.bond !== 0n) continue;
      totalBond += q.min_bond;
      outstanding++;
    }
  }
  console.log(`\n💰 Bond required: ${ethers.formatEther(totalBond)} ETH for ${outstanding} unanswered question(s)`);

  if (wallet && outstanding > 0) {
    const balance = await provider.getBalance(wallet.address);
    console.log(`💰 Wallet balance: ${ethers.formatEther(balance)} ETH`);
    if (balance < totalBond + GAS_BUFFER) {
      throw new Error(
        `insufficient balance: need ${ethers.formatEther(totalBond + GAS_BUFFER)} ETH ` +
          `(bonds + gas buffer), have ${ethers.formatEther(balance)} ETH`
      );
    }
  }

  // ── Submit phase ────────────────────────────────────────────────────────
  console.log(`\n⚙️  Submit phase (${DRY_RUN ? "DRY RUN — no transactions" : "LIVE"})\n`);

  const reality = wallet ? new ethers.Contract(addr.realitio, REALITY_ABI, wallet) : undefined;
  let submitted = 0;
  let skipped = 0;
  let pending = 0;
  const errors = [];

  for (const { m, info, plan } of Object.values(state)) {
    console.log(`  ── Market ${m.label} ──`);
    for (const p of plan) {
      const label = `[${m.label}#${String(p.index).padStart(2)}] ${p.outcome.replace(/\s+/g, " ").slice(0, 44)}`;
      const q = info.questions[p.index];

      if (alreadyAnswered.has(p.questionId.toLowerCase())) {
        console.log(`  ${label}: already in progress log — skipping`);
        skipped++;
        continue;
      }

      // Reality's stateOpen modifier (src/interaction/reality/RealityETH-3.0.sol:181-189)
      if (q.is_pending_arbitration) {
        console.warn(`  ${label}: ⚠️  pending arbitration — skipping`);
        skipped++;
        continue;
      }
      if (Number(q.opening_ts) > now) {
        console.warn(`  ${label}: ⚠️  not open until ${new Date(Number(q.opening_ts) * 1000).toISOString()} — skipping`);
        skipped++;
        continue;
      }
      if (Number(q.finalize_ts) !== 0 && Number(q.finalize_ts) <= now) {
        console.warn(`  ${label}: ⚠️  already finalized — skipping`);
        skipped++;
        continue;
      }
      // bondMustDoubleAndMatchMinimum (same file, lines 210-219): re-answering would
      // cost bond*2, which is a spend decision to make by hand.
      if (q.bond > 0n) {
        const existing = BigInt(q.best_answer);
        if (existing === p.answerWei) {
          console.log(`  ${label}: already answered with the correct value — skipping`);
        } else {
          console.warn(
            `  ${label}: ⚠️  ALREADY ANSWERED ${ethers.formatUnits(existing, ANSWER_DECIMALS)} ` +
              `(bond ${ethers.formatEther(q.bond)} ETH) — expected ${p.weight}. ` +
              `Overriding needs ≥ ${ethers.formatEther(q.bond * 2n)} ETH; skipping.`
          );
        }
        skipped++;
        continue;
      }

      pending++;

      if (DRY_RUN) {
        console.log(
          `  ${label}: would submitAnswer(${p.questionId}, ${p.answerHex}, 0) ` +
            `= ${p.weight} with ${ethers.formatEther(q.min_bond)} ETH bond`
        );
        continue;
      }

      if (!wallet) throw new Error("PRIVATE_KEY not set — cannot send transactions.");

      console.log(`  ${label}: submitting ${p.weight} (${p.answerWei})...`);
      try {
        // max_previous = 0 disables the previous-bond check; safe because we just
        // verified bond == 0 above.
        const receipt = await retryTransaction(() =>
          reality.submitAnswer(p.questionId, p.answerHex, 0, { value: q.min_bond })
        );
        progress.append({
        kind: "answer",
        key: p.questionId.toLowerCase(),
          market: m.label,
          marketAddress: m.address,
          outcomeIndex: p.index,
          outcome: p.outcome,
          repo: p.repo,
          questionId: p.questionId,
          weight: p.weight,
          answerWei: p.answerWei.toString(),
          bondWei: q.min_bond.toString(),
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          timestamp: new Date().toISOString(),
        });
        submitted++;
        await sleep(DELAY_MS);
      } catch (err) {
        console.error(`  ${label}: submitAnswer() failed after retries: ${err.message}`);
        errors.push({ market: m.label, outcome: p.outcome, questionId: p.questionId, error: err.message });
      }
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  const timeout = Number(state.A.info.questions[0].timeout);
  if (DRY_RUN) {
    console.log(
      `\n🎉 Dry run — ${pending} answer(s) would be submitted (${skipped} skipped), ` +
        `bonding ${ethers.formatEther(totalBond)} ETH. Pass --live to execute.`
    );
  } else {
    console.log(`\n🎉 Submitted ${submitted}/${pending} answer(s) (${skipped} skipped). Log → ${progress.path}.`);
    if (submitted > 0) {
      const finalizeAt = new Date((Math.floor(Date.now() / 1000) + timeout) * 1000).toISOString();
      console.log(`⏳ Questions finalize ~${finalizeAt} (timeout ${timeout}s). Then run resolve-l1-markets.js.`);
    }
  }
  if (errors.length) {
    console.log(`⚠️  ${errors.length} error(s):`);
    errors.forEach((e) => console.log(`     ${e.market} ${e.outcome}: ${e.error}`));
  }
  return { submitted, skipped };
  }
);
