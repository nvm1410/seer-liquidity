// Creates the round-3 originality market set on Optimism:
//
//   Phase A  1 multi-scalar PARENT — outcomes Bundle A / B / C plus the factory's
//            "Invalid result" slot, collateral sUSDS, templateId 1, one uint Reality
//            question per bundle ("How many repositories in Bundle A will be…").
//   Phase B  98 conditional scalar CHILDREN — "average originality score of {repo}",
//            bounds 0-100, outcomes [DOWN, UP, Invalid result], templateId 1, each
//            conditional on its BUNDLE's outcome token (parentOutcome 0, 1 or 2).
//
// Reads the seed file (built by snapshot-originality-r2-prices.js) and writes the
// creation log — resumable: the parent and any child already in that log are skipped,
// so a re-run retries only failures and never creates a duplicate market.
//
// ── WHY BUNDLES ─────────────────────────────────────────────────────────────
// Round 2 held all 98 repos in a single multi-categorical market, created 2025-10-30 in
// one transaction of 36,804,432 gas (tx 0x03d2f16a…, block 143,096,848). That is no
// longer possible: OP Mainnet has since introduced a per-transaction gas cap of
// 2^24 = 16,777,216, measured 2026-09-21 with zero-value self-transfers (accepted at
// 16,777,216, rejected at 16,873,437 on six independent RPC operators).
//
// A multi-categorical parent costs ~372,216 gas per outcome. The multi-scalar parent
// here has three outcomes, so it asks three short Reality questions and deploys four
// wrapped tokens — a small fraction of the cap. The bundles exist only to get under that
// cap; the UI lists the 98 repos flat, as round 2 did.
//
// Do NOT turn the parent back into a 98-outcome market "because round 2 did it".
//
// ── WHY THIS ONE MANAGES ITS OWN LOG ────────────────────────────────────────
// Every other migrated script hands its resume log to lib/progress.js. This one cannot:
// its log is an OBJECT, {openingTime, parent, children}, because openingTime is a
// SET-LEVEL fact that must be pinned across resumes. It feeds the Reality content hash,
// so a resumed run that re-derived it from the clock would give the parent and the
// children different questions. A flat array of entries has nowhere to put it.
//
// The duplicate-market protection therefore stays where it always was: the saved parent
// address and the set of created repos. The harness's own progress file is unused here.
//
//   node create-originality-r3-markets.js          # dry: validates, prints every
//                                                  # immutable string, estimates gas
//   node create-originality-r3-markets.js --live   # creates, after a confirmation

import { ethers } from "ethers";
import fs from "fs";
import { makeMarketView } from "./lib/market.js";
import {
  checkQuestionText,
  checkTokenName,
  computeQuestionId,
  encodeQuestionWithoutOutcomes,
  MAX_TOKEN_NAME_BYTES,
  TEMPLATE,
} from "./lib/reality.js";
import { run } from "./lib/run.js";
import { retryTransaction, sleep } from "./lib/tx.js";

const BUNDLE_COUNT = 3;
const REPO_COUNT = 98;

const GAS_MULTIPLIER_PCT = 120n;
// Hard chain limit — see the header. A transaction estimated above this cannot be
// broadcast at all, so fail loudly here rather than at send time.
const MAX_TX_GAS = 16_777_216n;

const DELAY_MS = 2000;

const CREATE_MARKET_PARAMS =
  "(string marketName,string[] outcomes,string questionStart,string questionEnd,string outcomeType,uint256 parentOutcome,address parentMarket,string category,string lang,uint256 lowerBound,uint256 upperBound,uint256 minBond,uint32 openingTime,string[] tokenNames)";

const MarketFactoryAbi = [
  `function createMultiScalarMarket(${CREATE_MARKET_PARAMS} params) external returns (address)`,
  `function createScalarMarket(${CREATE_MARKET_PARAMS} params) external returns (address)`,
  "function arbitrator() view returns (address)",
  "function realitio() view returns (address)",
  "function questionTimeout() view returns (uint32)",
  "function collateralToken() view returns (address)",
  "event NewMarket(address indexed market, string marketName, address parentMarket, bytes32 conditionId, bytes32 questionId, bytes32[] questionsIds)",
];

const RealitioAbi = ["function getTimeout(bytes32 question_id) view returns (uint32)"];

// createMultiScalarMarket ignores params.marketName: the factory builds the name as
// questionStart + "[" + outcomeType + "]" + questionEnd (src/MarketFactory.sol:224).
function buildParentParams(parent, openingTime) {
  return {
    marketName: "",
    outcomes: parent.outcomes.slice(),
    questionStart: parent.questionStart,
    questionEnd: parent.questionEnd,
    outcomeType: parent.outcomeType,
    parentOutcome: 0n,
    parentMarket: ethers.ZeroAddress,
    category: parent.category,
    lang: parent.lang,
    lowerBound: 0n,
    upperBound: 0n,
    minBond: BigInt(parent.minBondWei),
    openingTime,
    tokenNames: parent.tokenNames.slice(),
  };
}

function buildChildParams(seed, child, parentMarket, openingTime) {
  const parent = seed.parent;
  return {
    marketName: child.marketName,
    outcomes: child.outcomes.slice(),
    questionStart: "",
    questionEnd: "",
    outcomeType: "",
    parentOutcome: BigInt(child.parentOutcome),
    parentMarket,
    category: parent.category,
    lang: parent.lang,
    lowerBound: BigInt(child.lowerBound),
    upperBound: BigInt(child.upperBound),
    minBond: BigInt(parent.minBondWei),
    openingTime,
    tokenNames: child.tokenNames.slice(),
  };
}

await run(
  { name: "create-originality-r3-markets", slug: "originality-r3", stage: "create-markets", mutating: true },
  async (ctx) => {
    const { manifest, provider, wallet, chainId, addr, log, dry: DRY_RUN } = ctx;

    const SEED_FILE = manifest.files.seed;
    const PROGRESS_FILE = manifest.files.markets;

    if (!fs.existsSync(SEED_FILE)) {
      throw new Error(`${SEED_FILE} not found — run snapshot-originality-r2-prices.js first.`);
    }

    const factory = new ethers.Contract(addr.marketFactory, MarketFactoryAbi, wallet);
    const marketView = makeMarketView(addr.marketView, provider);

    const loadProgress = () => {
      if (!fs.existsSync(PROGRESS_FILE)) return { openingTime: null, parent: null, children: [] };
      try {
        const p = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
        return { openingTime: p.openingTime ?? null, parent: p.parent ?? null, children: p.children ?? [] };
      } catch {
        return { openingTime: null, parent: null, children: [] };
      }
    };
    const saveProgress = (p) => fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));

    // Pull the created address off the NewMarket event — a transaction receipt does not
    // carry a function's return value.
    const marketFromReceipt = (receipt, iface) => {
      for (const entry of receipt.logs) {
        if (entry.address.toLowerCase() !== addr.marketFactory.toLowerCase()) continue;
        try {
          const parsed = iface.parseLog(entry);
          if (parsed?.name === "NewMarket") return parsed.args;
        } catch {
          // not a NewMarket log
        }
      }
      throw new Error("NewMarket event not found in receipt.");
    };

    const seed = JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));
    const progress = loadProgress();
    const parent = seed.parent;

    log.log(`\n${DRY_RUN ? "DRY RUN" : "LIVE RUN"} — originality round 3 market creation (bundled multi-scalar parent)`);
    log.log(`   wallet  : ${wallet.address}`);
    log.log(`   seed    : ${SEED_FILE} (generated ${seed.generatedAt})`);
    log.log(`   bundles : ${seed.bundles.map((b) => `${b.label} ${b.repos.length}`).join(" / ")}`);
    log.log(`   children: ${seed.children.length}\n`);

    // ── Validate the seed file ────────────────────────────────────────────────
    const errors = [];
    const checkText = (label, s) => checkQuestionText(label, s, errors);
    const checkName = (label, s) => {
      checkQuestionText(label, s, errors);
      checkTokenName(s, errors);
    };

    if (parent?.marketType !== "multiScalar") errors.push(`parent.marketType is ${parent?.marketType}, expected multiScalar`);
    if (parent.outcomes.length !== BUNDLE_COUNT) errors.push(`parent has ${parent.outcomes.length} outcomes, expected ${BUNDLE_COUNT}`);
    if (parent.tokenNames.length !== parent.outcomes.length) {
      errors.push(`parent tokenNames (${parent.tokenNames.length}) != outcomes (${parent.outcomes.length})`);
    }
    checkText("parent questionStart", parent.questionStart);
    checkText("parent questionEnd", parent.questionEnd);
    checkText("parent outcomeType", parent.outcomeType);
    parent.outcomes.forEach((o, i) => checkText(`parent outcomes[${i}]`, o));
    parent.tokenNames.forEach((t, i) => checkName(`parent tokenNames[${i}]`, t));
    if (new Set(parent.outcomes).size !== parent.outcomes.length) errors.push("parent has duplicate outcomes");
    const expectedName = `${parent.questionStart}[${parent.outcomeType}]${parent.questionEnd}`;
    if (parent.marketName !== expectedName) errors.push(`parent.marketName does not match questionStart[outcomeType]questionEnd`);

    // Bundles: 3 contiguous groups covering the 98 children in order, labels and tokens
    // matching the parent's outcome slots.
    if (seed.bundles.length !== BUNDLE_COUNT) errors.push(`${seed.bundles.length} bundles, expected ${BUNDLE_COUNT}`);
    const bundleOfRepo = new Map();
    seed.bundles.forEach((b, i) => {
      if (b.index !== i) errors.push(`bundles[${i}].index is ${b.index}`);
      if (b.label !== parent.outcomes[i]) errors.push(`bundles[${i}].label "${b.label}" != parent outcome "${parent.outcomes[i]}"`);
      if (b.tokenName !== parent.tokenNames[i]) errors.push(`bundles[${i}].tokenName != parent tokenNames[${i}]`);
      for (const repo of b.repos) {
        if (bundleOfRepo.has(repo)) errors.push(`repo "${repo}" appears in more than one bundle`);
        bundleOfRepo.set(repo, i);
      }
    });
    const flatBundleRepos = seed.bundles.flatMap((b) => b.repos);
    if (flatBundleRepos.length !== REPO_COUNT) errors.push(`bundles cover ${flatBundleRepos.length} repos, expected ${REPO_COUNT}`);

    if (seed.children.length !== REPO_COUNT) errors.push(`${seed.children.length} children, expected ${REPO_COUNT}`);
    const seenRepos = new Set();
    seed.children.forEach((c, i) => {
      const tag = `child "${c.repo}"`;
      if (seenRepos.has(c.repo)) errors.push(`${tag}: duplicate repo`);
      seenRepos.add(c.repo);
      if (flatBundleRepos[i] !== c.repo) errors.push(`${tag}: position ${i} holds "${flatBundleRepos[i]}" in the bundle lists`);
      if (bundleOfRepo.get(c.repo) !== c.parentOutcome) {
        errors.push(`${tag}: parentOutcome ${c.parentOutcome} but the repo is in bundle ${bundleOfRepo.get(c.repo)}`);
      }
      checkText(`${tag}.marketName`, c.marketName);
      if (!c.marketName.includes(c.repo)) errors.push(`${tag}: market name does not name its repo`);
      if (c.outcomes.length !== 2) errors.push(`${tag}: createScalarMarket requires exactly 2 outcomes`);
      c.outcomes.forEach((o, j) => checkText(`${tag}.outcomes[${j}]`, o));
      c.tokenNames.forEach((t, j) => checkName(`${tag}.tokenNames[${j}]`, t));
      if (BigInt(c.upperBound) <= BigInt(c.lowerBound)) errors.push(`${tag}: upperBound must exceed lowerBound`);
    });

    // Every ERC20 symbol across the whole set must be distinct (round 2's 196 children
    // were all literally DOWN/UP).
    const allSymbols = [...parent.tokenNames, ...seed.children.flatMap((c) => c.tokenNames)];
    const symbolCounts = new Map();
    for (const s of allSymbols) symbolCounts.set(s, (symbolCounts.get(s) ?? 0) + 1);
    for (const [s, n] of symbolCounts) {
      if (n > 1) errors.push(`ERC20 symbol "${s}" appears ${n} times across the set`);
    }

    if (errors.length) {
      log.error(`${errors.length} validation error(s):`);
      for (const e of errors) log.error(`   - ${e}`);
      process.exit(1);
    }
    log.log(
      `Seed file validated: 1 parent (${BUNDLE_COUNT} bundles), ${REPO_COUNT} children, ` +
        `${allSymbols.length} distinct ERC20 symbols.\n`
    );

    // ── Factory / Reality config ──────────────────────────────────────────────
    const [arbitrator, realitioAddr, questionTimeout, collateralToken] = await Promise.all([
      factory.arbitrator(),
      factory.realitio(),
      factory.questionTimeout(),
      factory.collateralToken(),
    ]);
    log.log("Factory config:");
    log.log(`   arbitrator      : ${arbitrator}`);
    log.log(`   realitio        : ${realitioAddr}`);
    log.log(`   questionTimeout : ${questionTimeout} s`);
    log.log(`   collateralToken : ${collateralToken}`);

    // openingTime is pinned on the first run and reused on every resume: it feeds the
    // Reality content hash, so changing it mid-set would give the parent and the children
    // different questions.
    const openingTime = progress.openingTime ?? Math.floor(Date.now() / 1000);
    if (progress.openingTime) {
      log.log(`   openingTime     : ${openingTime} (pinned by an earlier run)`);
    } else {
      log.log(
        `   openingTime     : ${openingTime} (${new Date(openingTime * 1000).toISOString()}) — answerable immediately, as in round 2`
      );
    }
    log.log();

    const qid = (encodedQuestion) =>
      computeQuestionId({
        templateId: TEMPLATE.UINT,
        openingTime,
        encodedQuestion,
        arbitrator,
        questionTimeout: Number(questionTimeout),
        minBond: BigInt(parent.minBondWei),
        realitio: realitioAddr,
        factory: addr.marketFactory,
      });

    // Mirrors createMultiScalarMarket: one question per outcome, questionStart + outcome
    // + questionEnd.
    parent._encoded = parent.outcomes.map((o) =>
      encodeQuestionWithoutOutcomes(`${parent.questionStart}${o}${parent.questionEnd}`, parent.category, parent.lang)
    );
    parent._questionIds = parent._encoded.map(qid);
    for (const c of seed.children) {
      c._encoded = encodeQuestionWithoutOutcomes(c.marketName, parent.category, parent.lang);
      c._questionId = qid(c._encoded);
    }
    const allQids = [...parent._questionIds, ...seed.children.map((c) => c._questionId)];
    if (new Set(allQids).size !== allQids.length) throw new Error("two questions in this set produce the same Reality question id");

    // ── Reality question-id collision check ───────────────────────────────────
    // A WARNING here rather than a throw, unlike assertNoQuestionCollision: this script
    // resumes, and a resumed run legitimately finds its own earlier questions on chain.
    log.log("Checking Reality for pre-existing question ids...");
    const realitio = new ethers.Contract(realitioAddr, RealitioAbi, provider);
    const collisions = [];
    for (let i = 0; i < parent._questionIds.length; i++) {
      if (Number(await realitio.getTimeout(parent._questionIds[i])) !== 0) collisions.push(`parent ${parent.outcomes[i]}`);
    }
    for (const c of seed.children) {
      if (Number(await realitio.getTimeout(c._questionId)) !== 0) collisions.push(c.repo);
    }
    if (collisions.length) {
      log.warn(`   WARNING: ${collisions.length} question(s) already exist on Reality:`);
      collisions.slice(0, 10).forEach((c) => log.warn(`      ${c}`));
      if (collisions.length > 10) log.warn(`      ... and ${collisions.length - 10} more`);
      log.warn(
        "      The factory reuses an existing question rather than asking a new one\n" +
          "      (MarketFactory.askRealityQuestion). Expected only when resuming a\n" +
          "      partially-completed run for exactly these questions."
      );
    } else {
      log.log(`   OK: no collisions — ${parent._questionIds.length} parent questions and all ${seed.children.length} children are new\n`);
    }

    // ── Pre-flight: every immutable string, before anything is sent ───────────
    if (DRY_RUN) {
      log.log("=".repeat(100));
      log.log("IMMUTABLE ON-CHAIN TEXT — cannot be edited after creation. Review before going live.");
      log.log("=".repeat(100));
      log.log(`\nPARENT market name (${expectedName.length} chars):`);
      log.log(`   ${expectedName}`);
      log.log(`   ${parent.outcomes.length} outcomes + "Invalid result" (factory-added, token SER-INVALID) = ${parent.outcomes.length + 1} slots`);
      seed.bundles.forEach((b) => {
        log.log(`      [${b.index}] ${b.label.padEnd(10)} ${b.tokenName.padEnd(12)} ${b.repos.length} repos: ${b.repos[0]} .. ${b.repos[b.repos.length - 1]}`);
      });
      parent._encoded.forEach((e, i) => {
        log.log(`\nEncoded Reality question — PARENT ${parent.outcomes[i]} (${e.length} chars):`);
        log.log(`   ${e}`);
      });
      log.log(`\nCHILD market names (${seed.children.length}) with outcome labels and ERC20 symbols:`);
      seed.children.forEach((c) => {
        log.log(`   ${parent.outcomes[c.parentOutcome]}[${String(c.indexInBundle).padStart(2)}] ${c.marketName}`);
        log.log(`        outcomes [${c.outcomes.join(", ")}]  symbols [${c.tokenNames.join(", ")}]`);
      });
      const longest = allSymbols.reduce((a, b) => (Buffer.byteLength(b) > Buffer.byteLength(a) ? b : a));
      const longestChild = seed.children.reduce((a, b) => (b.marketName.length > a.marketName.length ? b : a));
      log.log(
        `\n   ${allSymbols.length} ERC20 symbols total, ${new Set(allSymbols).size} unique, ` +
          `longest "${longest}" (${Buffer.byteLength(longest)} of ${MAX_TOKEN_NAME_BYTES} bytes)`
      );
      log.log(`   longest child name: ${longestChild.marketName.length} chars (${longestChild.repo})`);
      log.log(`\nEncoded Reality question — first CHILD:`);
      log.log(`   ${seed.children[0]._encoded}`);
      log.log("\n" + "=".repeat(100));
    }

    // ── Simulate ──────────────────────────────────────────────────────────────
    let parentMarket = progress.parent?.market ?? null;
    let totalGas = 0n;
    if (parentMarket) {
      log.log(`\nParent already created (${parentMarket}) — skipping it.`);
    } else {
      log.log(`\nSimulating the PARENT market (createMultiScalarMarket)...`);
      const gas = await factory.createMultiScalarMarket.estimateGas(buildParentParams(parent, openingTime));
      parent._gas = gas;
      totalGas += gas;
      const pct = (Number(gas) / Number(MAX_TX_GAS)) * 100;
      log.log(`   ${parent.outcomes.length} bundles -> ${gas} gas  (${pct.toFixed(1)}% of the ${MAX_TX_GAS} cap)`);
      if (gas >= MAX_TX_GAS) throw new Error(`parent needs ${gas} gas, above the ${MAX_TX_GAS} per-tx cap`);
    }

    const doneChildren = new Set(progress.children.map((e) => e.repo));
    const childrenTodo = seed.children.filter((c) => !doneChildren.has(c.repo));
    if (doneChildren.size) log.log(`${doneChildren.size} child market(s) already created — skipping them.`);

    if (childrenTodo.length) {
      if (parentMarket) {
        log.log(`\nSimulating CHILD market(s) (createScalarMarket)...`);
        const sample = childrenTodo.slice(0, 3);
        for (const c of sample) {
          const gas = await factory.createScalarMarket.estimateGas(buildChildParams(seed, c, parentMarket, openingTime));
          c._gas = gas;
          log.log(`   ${c.repo.padEnd(44)} gas ${gas}`);
        }
        const avg = sample.reduce((a, c) => a + c._gas, 0n) / BigInt(sample.length);
        totalGas += avg * BigInt(childrenTodo.length);
        log.log(`   sampled ${sample.length}, avg ${avg} -> ~${avg * BigInt(childrenTodo.length)} for ${childrenTodo.length} children`);
      } else {
        // ~1.86M measured against round 2's parent; used only for the cost preview.
        totalGas += 1_863_068n * BigInt(childrenTodo.length);
        log.log(`\nCHILD gas cannot be estimated until the parent exists; using the measured ~1,863,068 each.`);
        log.log(`   ~${1_863_068n * BigInt(childrenTodo.length)} for ${childrenTodo.length} children`);
      }
    }

    const feeData = await provider.getFeeData();
    const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
    const balance = await provider.getBalance(wallet.address);
    log.log(
      `\n   Total L2 gas : ${totalGas}\n` +
        `   Gas price    : ${ethers.formatUnits(gasPrice, 9)} gwei\n` +
        `   L2 gas cost  : ~${ethers.formatEther(totalGas * gasPrice)} ETH (EXCLUDES the Optimism L1 data fee)\n` +
        `   ETH balance  : ${ethers.formatEther(balance)} ETH`
    );

    if (DRY_RUN) {
      return { children: seed.children.length, todo: childrenTodo.length, totalGas: totalGas.toString() };
    }

    // ── Send ──────────────────────────────────────────────────────────────────
    const iface = new ethers.Interface(MarketFactoryAbi);
    progress.openingTime = openingTime;

    // Phase A — parent
    if (!parentMarket) {
      log.log(`\n--- Phase A: multi-scalar parent (${parent.outcomes.length} bundles) ---`);
      const params = buildParentParams(parent, openingTime);
      const gas = parent._gas ?? (await factory.createMultiScalarMarket.estimateGas(params));
      let gasLimit = (gas * GAS_MULTIPLIER_PCT) / 100n;
      if (gasLimit > MAX_TX_GAS) gasLimit = MAX_TX_GAS; // the buffer must not push us over the cap
      const receipt = await retryTransaction(() => factory.createMultiScalarMarket(params, { gasLimit }), { log });
      const args = marketFromReceipt(receipt, iface);

      // Persist the address BEFORE verifying. The market exists on-chain at this point;
      // if a transient MarketView/RPC failure threw out of here the address would be lost
      // and the next run would create a DUPLICATE parent.
      progress.parent = {
        market: args.market,
        marketName: args.marketName,
        outcomes: parent.outcomes,
        tokenNames: parent.tokenNames,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        conditionId: args.conditionId,
        questionId: args.questionId,
        questionsIds: Array.from(args.questionsIds),
        seerUrl: `https://app.seer.pm/markets/${chainId}/${args.market}`,
        timestamp: new Date().toISOString(),
      };
      saveProgress(progress);
      parentMarket = args.market;
      log.log(`  Created ${args.market}`);
      log.log(`  ${progress.parent.seerUrl}`);

      const m = await marketView.getMarket(addr.marketFactory, args.market);
      const onChain = Array.from(m.outcomes).map(String);
      const bad = [];
      if (m.marketName !== expectedName) bad.push(`marketName "${m.marketName}"`);
      if (onChain.length !== parent.outcomes.length + 1) bad.push(`${onChain.length} outcomes`);
      if (Number(m.templateId) !== TEMPLATE.UINT) bad.push(`templateId ${m.templateId}`);
      if (m.wrappedTokens.length !== parent.outcomes.length + 1) bad.push(`wrappedTokens ${m.wrappedTokens.length}`);
      if (args.questionsIds.length !== parent.outcomes.length) bad.push(`${args.questionsIds.length} Reality questions`);
      args.questionsIds.forEach((q, i) => {
        if (q.toLowerCase() !== parent._questionIds[i].toLowerCase()) bad.push(`question ${i} id ${q} != precomputed`);
      });
      log.log(`  Verified: ${onChain.length} outcomes, templateId ${m.templateId}, wrappedTokens ${m.wrappedTokens.length}`);
      progress.parent.verified = bad.length === 0;
      progress.parent.wrappedTokens = Array.from(m.wrappedTokens);
      saveProgress(progress);
      if (bad.length) throw new Error(`parent verify mismatch: ${bad.join(", ")} — stopping before any child is created`);
      await sleep(DELAY_MS);
    }

    // Phase B — children
    if (childrenTodo.length) {
      log.log(`\n--- Phase B: ${childrenTodo.length} child market(s) ---`);
      let ok = 0;
      const failures = [];

      for (const c of childrenTodo) {
        log.log(`\n[${ok + 1}/${childrenTodo.length}] ${parent.outcomes[c.parentOutcome]}[${c.indexInBundle}] ${c.repo}`);
        try {
          const params = buildChildParams(seed, c, parentMarket, openingTime);
          const gas = c._gas ?? (await factory.createScalarMarket.estimateGas(params));
          const receipt = await retryTransaction(
            () => factory.createScalarMarket(params, { gasLimit: (gas * GAS_MULTIPLIER_PCT) / 100n }),
            { log }
          );
          const args = marketFromReceipt(receipt, iface);

          const entry = {
            parentOutcome: c.parentOutcome,
            bundle: parent.outcomes[c.parentOutcome],
            indexInBundle: c.indexInBundle,
            repo: c.repo,
            market: args.market,
            marketName: c.marketName,
            parentMarket,
            tokenNames: c.tokenNames,
            txHash: receipt.hash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
            conditionId: args.conditionId,
            questionId: args.questionId,
            seedUp: c.seedUp,
            seedDown: c.seedDown,
            seerUrl: `https://app.seer.pm/markets/${chainId}/${args.market}`,
            timestamp: new Date().toISOString(),
          };
          progress.children.push(entry);
          saveProgress(progress);
          log.log(`  Created ${args.market}`);
          ok++;

          const m = await marketView.getMarket(addr.marketFactory, args.market);
          const bad = [];
          if (m.marketName !== c.marketName) bad.push(`marketName "${m.marketName}"`);
          if (Number(m.templateId) !== TEMPLATE.UINT) bad.push(`templateId ${m.templateId}`);
          if (Number(m.parentOutcome) !== c.parentOutcome) bad.push(`parentOutcome ${m.parentOutcome}`);
          if (m.parentMarket.id.toLowerCase() !== parentMarket.toLowerCase()) bad.push(`parentMarket ${m.parentMarket.id}`);
          if (m.upperBound.toString() !== c.upperBound) bad.push(`upperBound ${m.upperBound}`);
          if (m.wrappedTokens.length !== 3) bad.push(`wrappedTokens ${m.wrappedTokens.length}`);
          entry.verified = bad.length === 0;
          if (bad.length) {
            entry.verifyIssues = bad;
            log.warn(`  VERIFY MISMATCH: ${bad.join(", ")}`);
          }
          saveProgress(progress);
        } catch (err) {
          log.error(`  FAILED: ${(err.shortMessage || err.message || "").slice(0, 300)}`);
          failures.push(c.repo);
        }
        await sleep(DELAY_MS);
      }

      log.log(`\n--- Summary ---`);
      log.log(`   parent   : ${parentMarket} (${parent.outcomes.join(" / ")})`);
      log.log(`   children : ${ok}/${childrenTodo.length} created this run, ${progress.children.length}/${REPO_COUNT} total`);
      const mismatched = progress.children.filter((e) => e.verified === false);
      if (mismatched.length) log.log(`   VERIFY MISMATCHES: ${mismatched.map((e) => e.repo).join(", ")}`);
      if (failures.length) {
        log.log(`   failed   : ${failures.length} — re-run to retry only these`);
        failures.forEach((f) => log.log(`      - ${f}`));
      }
    }

    log.log(`\nProgress log: ${PROGRESS_FILE}`);
    return { parent: parentMarket, children: progress.children.length };
  }
);
