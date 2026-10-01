// Creates the CORRECTED round-3 originality market set on Optimism — three levels:
//
//   Phase A  1 multi-scalar PARENT — outcomes Bundle A / B / C plus the factory's
//            "Invalid result" slot, collateral sUSDS, templateId 1, one uint Reality
//            question per bundle ("How many repositories in Bundle A will be…").
//   Phase B  3 conditional multi-categorical MIDDLE markets, one per bundle — "Which
//            repositories in Bundle A will be evaluated…", one outcome per repo in that
//            bundle (33 / 33 / 32) plus Invalid, templateId 3, each conditional on its
//            bundle's parent outcome token.
//   Phase C  98 conditional scalar SCORE markets — "average originality score of {repo}",
//            bounds 0-100, outcomes [DOWN, UP, Invalid result], templateId 1, each
//            conditional on ITS OWN REPO's outcome token in its bundle's middle market.
//
// ── WHY THIS SET EXISTS ─────────────────────────────────────────────────────
// campaigns/originality-r3 (2026-09-22) skipped Phase B: its score markets hang directly
// off the bundle tokens, so a score position pays out on the bundle's COUNT rather than on
// whether that repo was evaluated. That set stays live, untouched, so its users can exit.
// This one is a separate parent and shares nothing with it — every ERC20 symbol carries
// _R3C, and openingTime is new, so every Reality question id is new as well.
//
// ── THE GAS CAP ─────────────────────────────────────────────────────────────
// OP Mainnet rejects a transaction above 2^24 = 16,777,216 gas. A multi-categorical
// market costs ~400k gas per outcome, so a 33-outcome middle market estimates at ~13.7M —
// 82% of the cap. It fits; a single 98-outcome market does not, which is what the bundles
// are for. The 20% gas buffer is clamped to the cap.
//
// ── THE LOG ─────────────────────────────────────────────────────────────────
// Like its precedent this script manages its own log, an OBJECT
// {openingTime, parent, middles, children}: openingTime is a set-level fact that feeds
// every Reality content hash and must be pinned across resumes. The parent, each middle
// market and each child already in the log are skipped, so a re-run retries only failures
// and never creates a duplicate. The harness's own progress file is unused.
//
//   node campaigns/originality-r3-v3/create-originality-r3-v3-markets.js          # dry
//   node campaigns/originality-r3-v3/create-originality-r3-v3-markets.js --live   # creates

import { ethers } from "ethers";
import fs from "fs";
import { makeMarketView } from "../../lib/market.js";
import {
  checkQuestionText,
  checkTokenName,
  computeQuestionId,
  encodeQuestionWithOutcomes,
  encodeQuestionWithoutOutcomes,
  MAX_TOKEN_NAME_BYTES,
  TEMPLATE,
} from "../../lib/reality.js";
import { run } from "../../lib/run.js";
import { retryTransaction, sleep } from "../../lib/tx.js";
import { readMarketDirect } from "./read-market.js";

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
  `function createMultiCategoricalMarket(${CREATE_MARKET_PARAMS} params) external returns (address)`,
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

function buildMiddleParams(seed, bundle, parentMarket, openingTime) {
  const parent = seed.parent;
  return {
    marketName: bundle.middle.marketName,
    outcomes: bundle.middle.outcomes.slice(),
    questionStart: "",
    questionEnd: "",
    outcomeType: "",
    parentOutcome: BigInt(bundle.index),
    parentMarket,
    category: parent.category,
    lang: parent.lang,
    lowerBound: 0n,
    upperBound: 0n,
    minBond: BigInt(parent.minBondWei),
    openingTime,
    tokenNames: bundle.middle.tokenNames.slice(),
  };
}

// The score market's parent is its bundle's MIDDLE market, and its parentOutcome is the
// repo's own slot there — not the bundle index, which is what the first set used.
function buildChildParams(seed, child, middleMarket, openingTime) {
  const parent = seed.parent;
  return {
    marketName: child.marketName,
    outcomes: child.outcomes.slice(),
    questionStart: "",
    questionEnd: "",
    outcomeType: "",
    parentOutcome: BigInt(child.indexInBundle),
    parentMarket: middleMarket,
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
  { name: "create-originality-r3-v3-markets", slug: "originality-r3-v3", stage: "create-markets", mutating: true, needsGate: true },
  async (ctx) => {
    const { manifest, provider, wallet, chainId, addr, log, dry: DRY_RUN } = ctx;

    const SEED_FILE = manifest.files.seed;
    const PROGRESS_FILE = manifest.files.markets;

    if (!fs.existsSync(SEED_FILE)) {
      throw new Error(`${SEED_FILE} not found — run build-originality-r3-v3-seed.js first.`);
    }

    const factory = new ethers.Contract(addr.marketFactory, MarketFactoryAbi, wallet);
    const marketView = makeMarketView(addr.marketView, provider);

    const loadProgress = () => {
      const empty = { openingTime: null, parent: null, middles: [], children: [] };
      if (!fs.existsSync(PROGRESS_FILE)) return empty;
      const p = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
      return { openingTime: p.openingTime ?? null, parent: p.parent ?? null, middles: p.middles ?? [], children: p.children ?? [] };
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

    const capGas = (gas) => {
      const limit = (gas * GAS_MULTIPLIER_PCT) / 100n;
      return limit > MAX_TX_GAS ? MAX_TX_GAS : limit; // the buffer must not push us over the cap
    };

    const seed = JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));
    const progress = loadProgress();
    const parent = seed.parent;

    log.log(`\n${DRY_RUN ? "DRY RUN" : "LIVE RUN"} — corrected originality round 3 market creation (three levels)`);
    log.log(`   wallet  : ${wallet.address}`);
    log.log(`   seed    : ${SEED_FILE} (prices from ${seed.source.file}, generated ${seed.source.generatedAt})`);
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

    // Bundles: 3 contiguous groups covering the 98 children in order. Each bundle's
    // middle market lists exactly that bundle's repos, in order, so a repo's
    // indexInBundle IS its outcome slot there.
    if (seed.bundles.length !== BUNDLE_COUNT) errors.push(`${seed.bundles.length} bundles, expected ${BUNDLE_COUNT}`);
    const slotOfRepo = new Map();
    seed.bundles.forEach((b, i) => {
      const tag = `bundles[${i}]`;
      if (b.index !== i) errors.push(`${tag}.index is ${b.index}`);
      if (b.label !== parent.outcomes[i]) errors.push(`${tag}.label "${b.label}" != parent outcome "${parent.outcomes[i]}"`);
      if (b.tokenName !== parent.tokenNames[i]) errors.push(`${tag}.tokenName != parent tokenNames[${i}]`);
      const mid = b.middle;
      if (mid?.marketType !== "multiCategorical") errors.push(`${tag}.middle.marketType is ${mid?.marketType}`);
      checkText(`${tag}.middle.marketName`, mid.marketName);
      if (!mid.marketName.includes(b.label)) errors.push(`${tag}: middle market name does not name its bundle`);
      if (mid.outcomes.length !== b.repos.length) errors.push(`${tag}: ${mid.outcomes.length} middle outcomes for ${b.repos.length} repos`);
      if (mid.tokenNames.length !== mid.outcomes.length) errors.push(`${tag}: middle tokenNames != outcomes`);
      mid.outcomes.forEach((o, j) => {
        checkText(`${tag}.middle.outcomes[${j}]`, o);
        if (o !== b.repos[j]) errors.push(`${tag}: middle outcome ${j} is "${o}", the bundle lists "${b.repos[j]}"`);
        if (slotOfRepo.has(o)) errors.push(`repo "${o}" appears in more than one bundle`);
        slotOfRepo.set(o, { bundle: i, slot: j });
      });
      mid.tokenNames.forEach((t, j) => checkName(`${tag}.middle.tokenNames[${j}]`, t));
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
      const at = slotOfRepo.get(c.repo);
      if (!at || at.bundle !== c.parentOutcome || at.slot !== c.indexInBundle) {
        errors.push(`${tag}: bundle ${c.parentOutcome} slot ${c.indexInBundle}, but its middle market has it at ${JSON.stringify(at)}`);
      } else if (seed.bundles[at.bundle].middle.tokenNames[at.slot] !== c.repoTokenName) {
        errors.push(`${tag}: repoTokenName ${c.repoTokenName} != its middle-market token name`);
      }
      checkText(`${tag}.marketName`, c.marketName);
      if (!c.marketName.includes(c.repo)) errors.push(`${tag}: market name does not name its repo`);
      if (c.outcomes.length !== 2) errors.push(`${tag}: createScalarMarket requires exactly 2 outcomes`);
      c.outcomes.forEach((o, j) => checkText(`${tag}.outcomes[${j}]`, o));
      c.tokenNames.forEach((t, j) => checkName(`${tag}.tokenNames[${j}]`, t));
      if (BigInt(c.upperBound) <= BigInt(c.lowerBound)) errors.push(`${tag}: upperBound must exceed lowerBound`);
    });

    // Every ERC20 symbol across the whole set must be distinct.
    const allSymbols = [
      ...parent.tokenNames,
      ...seed.bundles.flatMap((b) => b.middle.tokenNames),
      ...seed.children.flatMap((c) => c.tokenNames),
    ];
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
      `Seed file validated: 1 parent, ${BUNDLE_COUNT} middle markets, ${REPO_COUNT} score markets, ` +
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
    // Reality content hash, so changing it mid-set would give the levels different questions.
    const openingTime = progress.openingTime ?? Math.floor(Date.now() / 1000);
    if (progress.openingTime) {
      log.log(`   openingTime     : ${openingTime} (pinned by an earlier run)`);
    } else {
      log.log(`   openingTime     : ${openingTime} (${new Date(openingTime * 1000).toISOString()}) — answerable immediately, as in round 2`);
    }
    log.log();

    const qid = (templateId, encodedQuestion) =>
      computeQuestionId({
        templateId,
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
    parent._questionIds = parent._encoded.map((e) => qid(TEMPLATE.UINT, e));
    for (const b of seed.bundles) {
      b._encoded = encodeQuestionWithOutcomes(b.middle.marketName, b.middle.outcomes, parent.category, parent.lang);
      b._questionId = qid(TEMPLATE.MULTI_CATEGORICAL, b._encoded);
    }
    for (const c of seed.children) {
      c._encoded = encodeQuestionWithoutOutcomes(c.marketName, parent.category, parent.lang);
      c._questionId = qid(TEMPLATE.UINT, c._encoded);
    }
    const allQids = [...parent._questionIds, ...seed.bundles.map((b) => b._questionId), ...seed.children.map((c) => c._questionId)];
    if (new Set(allQids).size !== allQids.length) throw new Error("two questions in this set produce the same Reality question id");

    // ── Reality question-id collision check ───────────────────────────────────
    // A WARNING here rather than a throw, unlike assertNoQuestionCollision: this script
    // resumes, and a resumed run legitimately finds its own earlier questions on chain.
    // On a FRESH run a collision is fatal — it would bind a new market to the first set's
    // question, whose text is the same.
    log.log("Checking Reality for pre-existing question ids...");
    const realitio = new ethers.Contract(realitioAddr, RealitioAbi, provider);
    const collisions = [];
    for (let i = 0; i < parent._questionIds.length; i++) {
      if (Number(await realitio.getTimeout(parent._questionIds[i])) !== 0) collisions.push(`parent ${parent.outcomes[i]}`);
    }
    for (const b of seed.bundles) {
      if (Number(await realitio.getTimeout(b._questionId)) !== 0) collisions.push(`middle ${b.label}`);
    }
    for (const c of seed.children) {
      if (Number(await realitio.getTimeout(c._questionId)) !== 0) collisions.push(c.repo);
    }
    if (collisions.length) {
      if (!progress.openingTime) {
        throw new Error(`${collisions.length} question id(s) already exist on Reality before anything was created: ${collisions.slice(0, 5).join(", ")}`);
      }
      log.warn(`   WARNING: ${collisions.length} question(s) already exist on Reality:`);
      collisions.slice(0, 10).forEach((c) => log.warn(`      ${c}`));
      if (collisions.length > 10) log.warn(`      ... and ${collisions.length - 10} more`);
      log.warn("      Expected only when resuming a partially-completed run for exactly these questions.");
    } else {
      log.log(`   OK: no collisions — ${allQids.length} questions (3 parent, 3 middle, ${seed.children.length} score) are all new\n`);
    }

    // ── Pre-flight: every immutable string, before anything is sent ───────────
    if (DRY_RUN) {
      log.log("=".repeat(100));
      log.log("IMMUTABLE ON-CHAIN TEXT — cannot be edited after creation. Review before going live.");
      log.log("=".repeat(100));
      log.log(`\nPARENT market name (${expectedName.length} chars):`);
      log.log(`   ${expectedName}`);
      log.log(`   ${parent.outcomes.length} outcomes + "Invalid result" (factory-added, token SER-INVALID) = ${parent.outcomes.length + 1} slots`);
      seed.bundles.forEach((b) => log.log(`      [${b.index}] ${b.label.padEnd(10)} ${b.tokenName}`));
      parent._encoded.forEach((e, i) => {
        log.log(`\nEncoded Reality question — PARENT ${parent.outcomes[i]} (${e.length} chars):`);
        log.log(`   ${e}`);
      });
      seed.bundles.forEach((b) => {
        log.log(`\nMIDDLE market — ${b.label} (${b.middle.marketName.length} chars), conditional on ${b.tokenName}:`);
        log.log(`   ${b.middle.marketName}`);
        log.log(`   ${b.middle.outcomes.length} outcomes + "Invalid result" = ${b.middle.outcomes.length + 1} slots — outcome label / ERC20 symbol:`);
        b.middle.outcomes.forEach((o, j) => log.log(`      [${String(j).padStart(2)}] ${o.padEnd(40)} ${b.middle.tokenNames[j]}`));
        log.log(`   Encoded Reality question (${b._encoded.length} chars):`);
        log.log(`   ${b._encoded}`);
      });
      log.log(`\nSCORE market names (${seed.children.length}) with outcome labels and ERC20 symbols, each conditional on its repo token:`);
      seed.children.forEach((c) => {
        log.log(`   ${parent.outcomes[c.parentOutcome]}[${String(c.indexInBundle).padStart(2)}] ${c.marketName}`);
        log.log(`        on ${c.repoTokenName}  outcomes [${c.outcomes.join(", ")}]  symbols [${c.tokenNames.join(", ")}]`);
      });
      const longest = allSymbols.reduce((a, b) => (Buffer.byteLength(b) > Buffer.byteLength(a) ? b : a));
      const longestChild = seed.children.reduce((a, b) => (b.marketName.length > a.marketName.length ? b : a));
      log.log(
        `\n   ${allSymbols.length} ERC20 symbols total, ${new Set(allSymbols).size} unique, ` +
          `longest "${longest}" (${Buffer.byteLength(longest)} of ${MAX_TOKEN_NAME_BYTES} bytes)`
      );
      log.log(`   longest score market name: ${longestChild.marketName.length} chars (${longestChild.repo})`);
      log.log(`\nEncoded Reality question — first SCORE market:`);
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
      log.log(`   ${parent.outcomes.length} bundles -> ${gas} gas  (${((Number(gas) / Number(MAX_TX_GAS)) * 100).toFixed(1)}% of the ${MAX_TX_GAS} cap)`);
      if (gas >= MAX_TX_GAS) throw new Error(`parent needs ${gas} gas, above the ${MAX_TX_GAS} per-tx cap`);
    }

    const middleByIndex = new Map(progress.middles.map((e) => [e.parentOutcome, e]));
    const middlesTodo = seed.bundles.filter((b) => !middleByIndex.has(b.index));
    if (middleByIndex.size) log.log(`${middleByIndex.size} middle market(s) already created — skipping them.`);
    if (middlesTodo.length) {
      if (parentMarket) {
        log.log(`\nSimulating MIDDLE market(s) (createMultiCategoricalMarket)...`);
        for (const b of middlesTodo) {
          const gas = await factory.createMultiCategoricalMarket.estimateGas(buildMiddleParams(seed, b, parentMarket, openingTime));
          b._gas = gas;
          totalGas += gas;
          log.log(`   ${b.label}: ${b.middle.outcomes.length} outcomes -> ${gas} gas  (${((Number(gas) / Number(MAX_TX_GAS)) * 100).toFixed(1)}% of the cap)`);
          if (gas >= MAX_TX_GAS) throw new Error(`${b.label} middle market needs ${gas} gas, above the ${MAX_TX_GAS} per-tx cap`);
        }
      } else {
        // Measured 2026-10-01 against the first set's parent: 13.31M-13.71M.
        totalGas += 13_706_527n * BigInt(middlesTodo.length);
        log.log(`\nMIDDLE gas cannot be estimated until the parent exists; using the measured ~13,706,527 each (81.7% of the cap).`);
      }
    }

    const doneChildren = new Set(progress.children.map((e) => e.repo));
    const childrenTodo = seed.children.filter((c) => !doneChildren.has(c.repo));
    if (doneChildren.size) log.log(`${doneChildren.size} score market(s) already created — skipping them.`);
    if (childrenTodo.length) {
      const sample = childrenTodo.filter((c) => middleByIndex.has(c.parentOutcome)).slice(0, 3);
      if (sample.length) {
        log.log(`\nSimulating SCORE market(s) (createScalarMarket)...`);
        for (const c of sample) {
          const gas = await factory.createScalarMarket.estimateGas(
            buildChildParams(seed, c, middleByIndex.get(c.parentOutcome).market, openingTime)
          );
          c._gas = gas;
          log.log(`   ${c.repo.padEnd(44)} gas ${gas}`);
        }
        const avg = sample.reduce((a, c) => a + c._gas, 0n) / BigInt(sample.length);
        totalGas += avg * BigInt(childrenTodo.length);
        log.log(`   sampled ${sample.length}, avg ${avg} -> ~${avg * BigInt(childrenTodo.length)} for ${childrenTodo.length} score markets`);
      } else {
        // ~1.86M measured for the first set's children; used only for the cost preview.
        totalGas += 1_863_068n * BigInt(childrenTodo.length);
        log.log(`\nSCORE gas cannot be estimated until the middle markets exist; using ~1,863,068 each.`);
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
      return { middles: middlesTodo.length, children: seed.children.length, todo: childrenTodo.length, totalGas: totalGas.toString() };
    }

    // ── Send ──────────────────────────────────────────────────────────────────
    const iface = new ethers.Interface(MarketFactoryAbi);
    progress.openingTime = openingTime;

    // Phase A — parent
    if (!parentMarket) {
      log.log(`\n--- Phase A: multi-scalar parent (${parent.outcomes.length} bundles) ---`);
      const params = buildParentParams(parent, openingTime);
      const gas = parent._gas ?? (await factory.createMultiScalarMarket.estimateGas(params));
      const receipt = await retryTransaction(() => factory.createMultiScalarMarket(params, { gasLimit: capGas(gas) }), { log });
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
      if (bad.length) throw new Error(`parent verify mismatch: ${bad.join(", ")} — stopping before any other market is created`);
      await sleep(DELAY_MS);
    }

    // Phase B — the three middle markets. A failure or a verify mismatch here stops the
    // run: every score market under that bundle would be built on it. A middle market
    // already in the log but not yet verified (the run died between the two) is verified
    // now rather than trusted.
    const middlesToVerify = seed.bundles.filter((b) => middleByIndex.has(b.index) && middleByIndex.get(b.index).verified !== true);
    if (middlesTodo.length || middlesToVerify.length) {
      log.log(`
--- Phase B: ${middlesTodo.length} multi-categorical middle market(s) to create, ${middlesToVerify.length} to re-verify ---`);
      for (const b of seed.bundles) {
        let entry = middleByIndex.get(b.index);
        if (entry?.verified === true) continue;
        log.log(`
${b.label}: ${b.middle.outcomes.length} outcomes`);
        if (!entry) {
          const params = buildMiddleParams(seed, b, parentMarket, openingTime);
          const gas = b._gas ?? (await factory.createMultiCategoricalMarket.estimateGas(params));
          if (gas >= MAX_TX_GAS) throw new Error(`${b.label} middle market needs ${gas} gas, above the ${MAX_TX_GAS} per-tx cap`);
          log.log(`  gas ${gas} (${((Number(gas) / Number(MAX_TX_GAS)) * 100).toFixed(1)}% of the cap), limit ${capGas(gas)}`);
          const receipt = await retryTransaction(() => factory.createMultiCategoricalMarket(params, { gasLimit: capGas(gas) }), { log });
          const args = marketFromReceipt(receipt, iface);

          // Persisted BEFORE verifying, for the same reason as the parent.
          entry = {
            parentOutcome: b.index,
            bundle: b.label,
            market: args.market,
            marketName: b.middle.marketName,
            parentMarket,
            outcomes: b.middle.outcomes,
            tokenNames: b.middle.tokenNames,
            txHash: receipt.hash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
            conditionId: args.conditionId,
            questionId: args.questionId,
            questionsIds: Array.from(args.questionsIds),
            seerUrl: `https://app.seer.pm/markets/${chainId}/${args.market}`,
            timestamp: new Date().toISOString(),
          };
          progress.middles.push(entry);
          saveProgress(progress);
          middleByIndex.set(b.index, entry);
          log.log(`  Created ${entry.market}`);
        } else {
          log.log(`  already created (${entry.market}) but not verified — verifying now`);
        }

        // Not MarketView: it reverts for a middle market — see read-market.js.
        const m = await readMarketDirect(entry.market, provider);
        const onChain = Array.from(m.outcomes).map(String);
        const bad = [];
        if (m.marketName !== b.middle.marketName) bad.push(`marketName "${m.marketName}"`);
        if (JSON.stringify(onChain.slice(0, -1)) !== JSON.stringify(b.middle.outcomes)) bad.push("outcome list differs");
        if (Number(m.templateId) !== TEMPLATE.MULTI_CATEGORICAL) bad.push(`templateId ${m.templateId}`);
        if (Number(m.parentOutcome) !== b.index) bad.push(`parentOutcome ${m.parentOutcome}`);
        if (m.parentMarket.id.toLowerCase() !== parentMarket.toLowerCase()) bad.push(`parentMarket ${m.parentMarket.id}`);
        if (m.wrappedTokens.length !== b.middle.outcomes.length + 1) bad.push(`wrappedTokens ${m.wrappedTokens.length}`);
        if (m.questionsIds.length !== 1 || m.questionsIds[0].toLowerCase() !== b._questionId.toLowerCase()) {
          bad.push(`question id ${m.questionsIds[0]} != precomputed`);
        }
        entry.verified = bad.length === 0;
        entry.wrappedTokens = Array.from(m.wrappedTokens);
        saveProgress(progress);
        log.log(`  Verified: ${onChain.length} outcomes, templateId ${m.templateId}, wrappedTokens ${m.wrappedTokens.length}`);
        if (bad.length) throw new Error(`${b.label} middle verify mismatch: ${bad.join(", ")} — stopping before any score market is created`);
        await sleep(DELAY_MS);
      }
    }

    // Phase C — score markets
    if (childrenTodo.length) {
      log.log(`\n--- Phase C: ${childrenTodo.length} score market(s) ---`);
      let ok = 0;
      const failures = [];

      for (const c of childrenTodo) {
        log.log(`\n[${ok + 1}/${childrenTodo.length}] ${parent.outcomes[c.parentOutcome]}[${c.indexInBundle}] ${c.repo}`);
        try {
          const middle = middleByIndex.get(c.parentOutcome);
          if (!middle) throw new Error(`no middle market for bundle ${c.parentOutcome}`);
          const params = buildChildParams(seed, c, middle.market, openingTime);
          const gas = c._gas ?? (await factory.createScalarMarket.estimateGas(params));
          const receipt = await retryTransaction(() => factory.createScalarMarket(params, { gasLimit: capGas(gas) }), { log });
          const args = marketFromReceipt(receipt, iface);

          const entry = {
            parentOutcome: c.parentOutcome,
            bundle: parent.outcomes[c.parentOutcome],
            indexInBundle: c.indexInBundle,
            repo: c.repo,
            market: args.market,
            marketName: c.marketName,
            parentMarket: middle.market,
            repoToken: middle.wrappedTokens?.[c.indexInBundle] ?? null,
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
          if (Number(m.parentOutcome) !== c.indexInBundle) bad.push(`parentOutcome ${m.parentOutcome}`);
          if (m.parentMarket.id.toLowerCase() !== middle.market.toLowerCase()) bad.push(`parentMarket ${m.parentMarket.id}`);
          if (m.upperBound.toString() !== c.upperBound) bad.push(`upperBound ${m.upperBound}`);
          if (m.wrappedTokens.length !== 3) bad.push(`wrappedTokens ${m.wrappedTokens.length}`);
          if (args.questionsIds.length !== 1 || args.questionsIds[0].toLowerCase() !== c._questionId.toLowerCase()) {
            bad.push(`question id != precomputed`);
          }
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
      log.log(`   parent  : ${parentMarket} (${parent.outcomes.join(" / ")})`);
      log.log(`   middles : ${progress.middles.length}/${BUNDLE_COUNT}`);
      log.log(`   scores  : ${ok}/${childrenTodo.length} created this run, ${progress.children.length}/${REPO_COUNT} total`);
      const mismatched = progress.children.filter((e) => e.verified === false);
      if (mismatched.length) log.log(`   VERIFY MISMATCHES: ${mismatched.map((e) => e.repo).join(", ")}`);
      if (failures.length) {
        log.log(`   failed  : ${failures.length} — re-run to retry only these`);
        failures.forEach((f) => log.log(`      - ${f}`));
      }
    }

    log.log(`\nProgress log: ${PROGRESS_FILE}`);
    return { parent: parentMarket, middles: progress.middles.length, children: progress.children.length };
  }
);
