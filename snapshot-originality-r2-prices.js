import { ethers } from "ethers";
import fs from "fs";
import { mapConcurrent } from "./lib/batch.js";
import { makeMarketView } from "./lib/market.js";
import { MAX_TOKEN_NAME_BYTES } from "./lib/reality.js";
import { run } from "./lib/run.js";
import { sortTokens } from "./lib/ticks.js";
import { markets } from "./markets.js";

// -----------------------------------------------------------------------------
// Read-only on chain. Captures the *last* pool prices of the round-2 originality
// markets and freezes them as the seed file for round 3.
//
// Round 2 (parent 0xdb3aae8d...) was fully unwound on 2026-06-19: every one of the
// 196 pools has zero liquidity. A drained Uniswap V3 pool is NOT a gone pool --
// the contract survives and keeps its last sqrtPriceX96 -- so the price each
// market was trading at when the liquidity came out is still readable on chain.
// That is what "use the last market prices" means here, and it is the only
// record of it: nothing in this repo ever logged those prices.
//
// Seed convention (user's call): seedUp = the round-2 UP pool's last price, and
// seedDown = 1 - seedUp. The two raw legs are separate pools and do not sum to 1
// (measured span 0.9654 - 1.0651), so seeding both raw would open round 3 with up
// to a 6.5% arbitrage against its own depth. Deriving DOWN from UP also
// reproduces round 2's own seeding convention, where markets.js[i].prices was
// exactly [1 - Originality, Originality] for all 98 entries.
//
// It also derives round 3's ERC20 symbols -- see TOKEN_CODE_OVERRIDES below. Round 2
// named all 196 of its child tokens literally "DOWN"/"UP"; round 3 carries the repo
// and the round in every symbol instead.
//
//   node snapshot-originality-r2-prices.js
//   node snapshot-originality-r2-prices.js --out=/tmp/seed.json
//
// It writes the seed file and sends no transactions, so --live is meaningless here
// and the harness's dry/live distinction does not apply.
//
// THE DEFAULT OUTPUT IS A GATED FILE. lifecycle/originality-r3.json pins
// sha256(originality-r3-seed.json) as gate.summaryHash, and lib/run.js re-reads that
// hash before any --live seeding run. Re-running this script rewrites generatedAt and
// so changes the hash, which would make the seeder refuse to go live against a seed
// nobody re-approved. Use --out= to write somewhere else unless a fresh snapshot is
// genuinely what is wanted.
// -----------------------------------------------------------------------------

// The band round 3's positions will be minted over. Round 2 passed minPrice = 0,
// where priceToTick(0) = -Infinity got clamped to MIN_TICK (see
// liquidity-originality.js:186-233) — an accidental full-range-to-zero position
// that spreads depth across a range nobody trades in. Round 3 uses the NU7 band
// and hard-fails outside it rather than minting a one-sided position.
const MIN_PRICE = 0.02;
const MAX_PRICE = 0.98;

// Round-3 market text. Round 2 said "second round"; these are the round-3
// equivalents, and they are the strings that go on chain immutably.
//
// THE PARENT IS A 3-OUTCOME MULTI-SCALAR, NOT A 98-OUTCOME MULTI-CATEGORICAL.
// Round 2 held all 98 repos in one multi-categorical market, created 2025-10-30
// in a single 36,804,432-gas transaction. OP Mainnet has since introduced a
// per-transaction gas cap of 2^24 = 16,777,216 (verified: the sequencer accepts a
// send at 16,725,000 and rejects at 16,873,437; the block gas limit was
// 40,000,000 in both eras). A multi-categorical parent costs ~372,216 gas per
// outcome, so 98 outcomes cannot fit in one transaction.
//
// Instead the 98 repos are grouped into three bundles (the first 33, the next 33
// and the last 32, in round 2's outcome order), and the parent asks one uint
// question per bundle: how many of its repos get evaluated. Each repo's score
// market is conditional on its BUNDLE's outcome token. The bundles are a gas
// workaround only: the UI hides them and lists the 98 repos flat, as round 2 did.
//
// MarketFactory.createMultiScalarMarket names the market
// questionStart + "[" + outcomeType + "]" + questionEnd and asks
// questionStart + outcome + questionEnd for each outcome (src/MarketFactory.sol:208).
const BUNDLE_COUNT = 3;
const BUNDLE_LABELS = ["Bundle A", "Bundle B", "Bundle C"];
const BUNDLE_TOKEN_NAMES = ["ORIG_R3_A", "ORIG_R3_B", "ORIG_R3_C"];
const PARENT_QUESTION_START = "How many repositories in ";
const PARENT_QUESTION_END = " will be evaluated for originality during Round 3 of the Deep Funding experiment?";
const PARENT_OUTCOME_TYPE = "bundle";
const childMarketName = (repo) =>
  `What will be the average originality score of ${repo} in Round 3 of the Deep Funding experiment?`;

// Reality config, copied from round 2's on-chain questions.
const MIN_BOND_WEI = "500000000000000"; // 0.0005 ETH
const QUESTION_TIMEOUT = 302400; // 3.5 days
const CATEGORY = "misc";
const LANG = "en_US";

// Scalar bounds for the children: 0-100, an originality score in percent.
const LOWER_BOUND = "0";
const UPPER_BOUND = ethers.parseUnits("100", 18).toString();

// On-chain OUTCOME LABELS stay DOWN/UP: that is what Seer displays, and the
// frontend indexes wrappedTokens[0]/[1] positionally (see
// get-originality-markets-data.ts). Only the ERC20 symbols change.
const CHILD_OUTCOMES = ["DOWN", "UP"];

// ERC20 SYMBOLS carry the repo and the round, so a round-3 token is never
// confused with round 2's — round 2 named all 196 of its child tokens literally
// "DOWN" and "UP", which is unreadable in any wallet and would collide outright
// with round 3.
//
// Scheme: <REPO>_D_R3 / <REPO>_U_R3 for the score markets, where <REPO> is the
// repo's basename uppercased with non-alphanumerics folded to "_". Repo-first
// rather than side-first because "DOWN_" + the longest basename + "_R3" is 33
// bytes, which MarketFactory.toString31 would revert on. The parent's outcome
// tokens are the three bundles, ORIG_R3_A / _B / _C. The 31-byte ceiling itself
// is MAX_TOKEN_NAME_BYTES in lib/reality.js.

// Two basenames each cover two different repos in this list, so those four are
// qualified by org. Any OTHER collision is a hard failure below rather than a
// silent rename — if the repo list ever changes, that check is what catches it.
const TOKEN_CODE_OVERRIDES = {
  "LFDT-web3j/web3j": "LFDT_WEB3J",
  "hyperledger-web3j/web3j": "HYPERLEDGER_WEB3J",
  "flashbots/mev-boost-relay": "FLASHBOTS_MEV_BOOST_RELAY",
  "aestus-relay/mev-boost-relay": "AESTUS_MEV_BOOST_RELAY",
};

function repoTokenCode(repo) {
  if (TOKEN_CODE_OVERRIDES[repo]) return TOKEN_CODE_OVERRIDES[repo];
  const base = repo.split("/")[1];
  if (!base) throw new Error(`cannot derive a token code from "${repo}" — no "/" in the outcome`);
  const code = base.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  if (!code) throw new Error(`token code for "${repo}" is empty after normalisation`);
  return code;
}

const CONCURRENCY = 8;
const Q96 = 2n ** 96n;

const ERC20_ABI = ["function symbol() view returns (string)"];
const UNISWAP_FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
];

// Pool price is always token1-per-token0. Flip it when the outcome token is
// token1 so the result is always "collateral per outcome token".
function outcomePriceFromSqrt(sqrtPriceX96, outcomeIsToken0) {
  const p = Number(sqrtPriceX96) / Number(Q96);
  const token1PerToken0 = p * p;
  return outcomeIsToken0 ? token1PerToken0 : 1 / token1PerToken0;
}

// Run `worker` over 0..n-1 with a fixed pool of in-flight calls.
const overIndexes = (n, worker) =>
  mapConcurrent(Array.from({ length: n }, (_, i) => i), worker, { concurrency: CONCURRENCY });

await run(
  { name: "snapshot-originality-r2-prices", slug: "originality-r3", stage: "snapshot-prices", mutating: false },
  async (ctx) => {
    const { manifest, provider, chainId, addr, log, args } = ctx;

    const R2_PARENT_MARKET = manifest.precedents.roundTwoParent;
    const OUT_FILE = args.opts.out ?? manifest.files.seed;
    const FEE_TIER = manifest.amm.feeTier;
    const TICK_SPACING = manifest.amm.tickSpacing;
    const CHAIN_ID = chainId;

    const marketView = makeMarketView(addr.marketView, provider);
    const uniFactory = new ethers.Contract(addr.poolFactory, UNISWAP_FACTORY_ABI, provider);
    const MARKET_FACTORY = addr.marketFactory;

    log.log("\nSnapshotting round-2 originality prices for round 3");
    log.log(`   round-2 parent : ${R2_PARENT_MARKET}`);
    log.log(`   child markets  : ${markets.length} (from markets.js)\n`);

    const r2Parent = await marketView.getMarket(MARKET_FACTORY, R2_PARENT_MARKET);
    const r2Outcomes = Array.from(r2Parent.outcomes).map(String);
    const r2WrappedTokens = Array.from(r2Parent.wrappedTokens).map(String);

    // 99 slots = 98 repos + the factory's own "Invalid result".
    if (r2Outcomes.length !== 99) {
      throw new Error(`expected 99 round-2 parent outcomes, got ${r2Outcomes.length}`);
    }
    if (r2Outcomes[98] !== "Invalid result") {
      throw new Error(`expected slot 98 to be "Invalid result", got "${r2Outcomes[98]}"`);
    }
    log.log(`  round-2 parent: "${r2Parent.marketName}"`);
    log.log(`  ${r2Outcomes.length} outcomes, templateId ${r2Parent.templateId}\n`);

    // Parent token symbols — reused verbatim for round 3 (98, excluding SER-INVALID,
    // which the factory names itself).
    log.log("1/3  Reading round-2 parent token symbols...");
    const parentTokenNames = await overIndexes(98, async (i) =>
      String(await new ethers.Contract(r2WrappedTokens[i], ERC20_ABI, provider).symbol())
    );

    for (let i = 0; i < 98; i++) {
      const s = parentTokenNames[i];
      // MarketFactory.toString31 rejects >= 32 bytes; deployERC20Positions rejects empty.
      if (!s || s.length === 0) throw new Error(`empty token symbol at slot ${i}`);
      if (Buffer.byteLength(s, "utf8") >= 32) throw new Error(`token symbol too long at slot ${i}: "${s}"`);
    }
    const dupes = parentTokenNames.length - new Set(parentTokenNames).size;
    log.log(
      `     98 symbols, max ${Math.max(...parentTokenNames.map((s) => s.length))} chars, ${dupes} duplicates\n`
    );

    // Resolve each child and read both of its pools.
    log.log("2/3  Resolving children and reading last pool prices...");
    const rows = await overIndexes(markets.length, async (i) => {
      const childAddress = markets[i].marketId;
      const child = await marketView.getMarket(MARKET_FACTORY, childAddress);

      // Join on the on-chain parentOutcome, not on array position. Index alignment
      // happens to hold for all 98, but this field is the authority.
      const parentOutcome = Number(child.parentOutcome);
      const repo = r2Outcomes[parentOutcome];
      if (!repo || repo === "Invalid result") {
        throw new Error(`${childAddress}: parentOutcome ${parentOutcome} does not name a repo`);
      }

      const collateral = r2WrappedTokens[parentOutcome];
      const childTokens = Array.from(child.wrappedTokens).map(String);
      if (childTokens.length !== 3) {
        throw new Error(`${childAddress}: expected 3 wrapped tokens, got ${childTokens.length}`);
      }

      // wrappedTokens order is [DOWN, UP, Invalid].
      const legs = [];
      for (const outcomeToken of [childTokens[0], childTokens[1]]) {
        const [token0, token1] = sortTokens(outcomeToken, collateral);
        const poolAddress = await uniFactory.getPool(token0, token1, FEE_TIER);
        if (poolAddress === ethers.ZeroAddress) {
          throw new Error(`${repo}: no pool for ${outcomeToken} / ${collateral}`);
        }
        const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
        const [slot0, liquidity] = await Promise.all([pool.slot0(), pool.liquidity()]);
        legs.push({
          pool: poolAddress,
          price: outcomePriceFromSqrt(
            slot0.sqrtPriceX96,
            token0.toLowerCase() === outcomeToken.toLowerCase()
          ),
          tick: Number(slot0.tick),
          liquidity: liquidity.toString(),
        });
      }

      const rawDown = legs[0].price;
      const rawUp = legs[1].price;
      const code = repoTokenCode(repo);
      return {
        // Position in ROUND 2's single 98-outcome parent. Kept for traceability and
        // to preserve ordering; round 3's parentOutcome (the bundle) is assigned below.
        r2ParentOutcome: parentOutcome,
        repo,
        tokenCode: code,
        marketName: childMarketName(repo),
        outcomes: CHILD_OUTCOMES,
        tokenNames: [`${code}_D_R3`, `${code}_U_R3`],
        lowerBound: LOWER_BOUND,
        upperBound: UPPER_BOUND,
        r2ChildMarket: childAddress,
        r2ParentOutcomeToken: collateral,
        r2TokenSymbol: parentTokenNames[parentOutcome],
        r2DownPool: legs[0].pool,
        r2UpPool: legs[1].pool,
        r2PoolLiquidity: [legs[0].liquidity, legs[1].liquidity],
        rawDown,
        rawUp,
        seedUp: rawUp,
        seedDown: 1 - rawUp,
      };
    });

    // Validate the set before writing anything.
    log.log("3/3  Validating...");
    const errors = [];
    const seenOutcomes = new Set();
    const seenRepos = new Set();

    for (const r of rows) {
      if (seenOutcomes.has(r.r2ParentOutcome)) errors.push(`duplicate round-2 outcome index ${r.r2ParentOutcome}`);
      seenOutcomes.add(r.r2ParentOutcome);
      if (seenRepos.has(r.repo)) errors.push(`duplicate repo ${r.repo}`);
      seenRepos.add(r.repo);

      for (const [label, price] of [
        ["seedUp", r.seedUp],
        ["seedDown", r.seedDown],
      ]) {
        if (!Number.isFinite(price)) errors.push(`${r.repo}: ${label} is not finite`);
        else if (price <= MIN_PRICE || price >= MAX_PRICE) {
          errors.push(
            `${r.repo}: ${label} ${price.toFixed(6)} outside band [${MIN_PRICE}, ${MAX_PRICE}]`
          );
        }
      }
      const sum = r.seedUp + r.seedDown;
      if (Math.abs(sum - 1) > 1e-12) errors.push(`${r.repo}: seed prices sum to ${sum}, expected 1`);

      // Every symbol must clear MarketFactory.toString31 (require(length < 32)).
      for (const name of r.tokenNames) {
        const bytes = Buffer.byteLength(name, "utf8");
        if (bytes > MAX_TOKEN_NAME_BYTES) {
          errors.push(`${r.repo}: token symbol "${name}" is ${bytes} bytes, max ${MAX_TOKEN_NAME_BYTES}`);
        }
      }
    }

    // Derived token codes must be unique across the 98 repos, or two repos would
    // mint identically-named tokens.
    const byCode = new Map();
    for (const r of rows) {
      if (!byCode.has(r.tokenCode)) byCode.set(r.tokenCode, []);
      byCode.get(r.tokenCode).push(r.repo);
    }
    for (const [code, repos] of byCode) {
      if (repos.length > 1) {
        errors.push(
          `token code "${code}" is shared by ${repos.length} repos (${repos.join(", ")}) — ` +
            "add an org-qualified entry to TOKEN_CODE_OVERRIDES"
        );
      }
    }
    if (rows.length !== 98) errors.push(`expected 98 children, got ${rows.length}`);
    if (seenOutcomes.size !== 98) errors.push(`round-2 outcome coverage is ${seenOutcomes.size}, expected 98`);

    if (errors.length) {
      log.error(`\n${errors.length} validation error(s):`);
      for (const e of errors) log.error(`   - ${e}`);
      process.exit(1);
    }

    // Round 3 keeps round 2's exact repo order, so a repo's position in the global
    // list is unchanged between generations even though the parent is now split.
    const byOutcome = [...rows].sort((a, b) => a.r2ParentOutcome - b.r2ParentOutcome);
    const globalOrder = byOutcome.map((r) => r.repo);
    for (let i = 0; i < 98; i++) {
      if (globalOrder[i] !== r2Outcomes[i]) {
        throw new Error(`outcome order drifted at ${i}: "${globalOrder[i]}" vs round 2's "${r2Outcomes[i]}"`);
      }
    }

    // Split the 98 repos into BUNDLE_COUNT contiguous groups, largest first, so the
    // sizes differ by at most one (33/33/32 for three).
    const base = Math.floor(98 / BUNDLE_COUNT);
    const remainder = 98 % BUNDLE_COUNT;
    const bundles = [];
    let cursor = 0;
    for (let b = 0; b < BUNDLE_COUNT; b++) {
      const size = base + (b < remainder ? 1 : 0);
      const group = byOutcome.slice(cursor, cursor + size);
      // parentOutcome is the BUNDLE index: every score market in a bundle is
      // conditional on the same parent outcome token.
      group.forEach((r, i) => {
        r.parentOutcome = b;
        r.indexInBundle = i;
        r.bundleTokenName = BUNDLE_TOKEN_NAMES[b];
      });
      bundles.push({
        index: b,
        label: BUNDLE_LABELS[b],
        tokenName: BUNDLE_TOKEN_NAMES[b],
        question: `${PARENT_QUESTION_START}${BUNDLE_LABELS[b]}${PARENT_QUESTION_END}`,
        repos: group.map((r) => r.repo),
        globalRange: [cursor, cursor + size - 1],
      });
      cursor += size;
    }
    if (cursor !== 98) throw new Error(`bundle grouping covered ${cursor} repos, expected 98`);

    const parent = {
      marketType: "multiScalar",
      marketName: `${PARENT_QUESTION_START}[${PARENT_OUTCOME_TYPE}]${PARENT_QUESTION_END}`,
      questionStart: PARENT_QUESTION_START,
      questionEnd: PARENT_QUESTION_END,
      outcomeType: PARENT_OUTCOME_TYPE,
      outcomes: BUNDLE_LABELS,
      tokenNames: BUNDLE_TOKEN_NAMES,
      category: CATEGORY,
      lang: LANG,
      minBondWei: MIN_BOND_WEI,
      questionTimeout: QUESTION_TIMEOUT,
    };

    const seed = {
      generatedAt: new Date().toISOString(),
      note:
        "Round-3 originality seed (v2, bundled multi-scalar parent). Prices are the LAST traded prices " +
        "of the round-2 pools, read from each drained pool's surviving sqrtPriceX96. seedUp is the " +
        "round-2 UP pool's last price; seedDown is 1 - seedUp (the raw legs are separate pools and do " +
        "not sum to 1). Frozen input: edit this file, not the scripts.",
      source: {
        chainId: CHAIN_ID,
        r2ParentMarket: R2_PARENT_MARKET,
        r2ParentMarketName: String(r2Parent.marketName),
        feeTier: FEE_TIER,
        tickSpacing: TICK_SPACING,
      },
      band: { minPrice: MIN_PRICE, maxPrice: MAX_PRICE },
      // One split of the parent mints totalSusds of EVERY bundle token; each bundle's
      // supply is then shared evenly across that bundle's repos.
      budget: {
        totalSusds: 1000,
        note: "one parent split of totalSusds; each bundle token's supply is divided evenly across its repos",
      },
      parent,
      bundles,
      children: byOutcome,
    };

    fs.writeFileSync(OUT_FILE, JSON.stringify(seed, null, 2));

    const ups = rows.map((r) => r.seedUp).sort((a, b) => a - b);
    const mean = ups.reduce((a, b) => a + b, 0) / ups.length;
    const rawSums = rows.map((r) => r.rawDown + r.rawUp);
    const withLiquidity = rows.filter((r) => r.r2PoolLiquidity.some((l) => l !== "0")).length;

    log.log(`     98 rows, 0 out of band, outcome order matches round 2\n`);
    log.log(
      `seedUP   min ${ups[0].toFixed(4)}   median ${ups[49].toFixed(4)}   max ${ups[97].toFixed(4)}   mean ${mean.toFixed(4)}`
    );
    log.log(
      `   raw DOWN+UP sums span ${Math.min(...rawSums).toFixed(4)} - ${Math.max(...rawSums).toFixed(4)}  (normalised away by seedDown = 1 - seedUp)`
    );
    log.log(`   round-2 pools still holding liquidity: ${withLiquidity}/98 markets\n`);

    log.log("   sample:");
    for (const r of [...byOutcome.slice(0, 4), ...byOutcome.slice(-2)]) {
      log.log(
        `     ${BUNDLE_LABELS[r.parentOutcome]}[${String(r.indexInBundle).padStart(2)}] ${r.repo.padEnd(40)} rawDown ${r.rawDown.toFixed(4)} rawUp ${r.rawUp.toFixed(4)}` +
          `  ->  UP ${r.seedUp.toFixed(4)} / DOWN ${r.seedDown.toFixed(4)}`
      );
    }

    log.log(`\n   parent (${parent.marketName.length} chars): ${parent.marketName}`);
    for (const b of bundles) {
      log.log(
        `     ${b.label} (${b.tokenName}): ${String(b.repos.length).padStart(2)} repos ` +
          `(global ${b.globalRange[0]}-${b.globalRange[1]}), ${b.repos[0]} .. ${b.repos[b.repos.length - 1]}`
      );
    }

    const allNames = [...BUNDLE_TOKEN_NAMES, ...byOutcome.flatMap((r) => r.tokenNames)];
    const longest = allNames.reduce((a, b) => (Buffer.byteLength(b) > Buffer.byteLength(a) ? b : a));
    log.log(
      `\n   token symbols: ${allNames.length} unique, longest "${longest}" (${Buffer.byteLength(longest)} of ${MAX_TOKEN_NAME_BYTES} bytes)`
    );
    for (const r of byOutcome.slice(0, 3)) {
      log.log(`     ${r.repo.padEnd(40)} ${r.bundleTokenName} | ${r.tokenNames.join(" | ")}`);
    }
    for (const repo of Object.keys(TOKEN_CODE_OVERRIDES)) {
      const r = byOutcome.find((x) => x.repo === repo);
      if (r) log.log(`     ${r.repo.padEnd(40)} ${r.bundleTokenName} | ${r.tokenNames.join(" | ")}   (org-qualified)`);
    }

    log.log(`\nWrote ${OUT_FILE}`);
    return { rows: rows.length, out: OUT_FILE };
  }
);
