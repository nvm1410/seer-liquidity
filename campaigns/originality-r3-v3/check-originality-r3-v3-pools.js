// Read-only VERIFY for the corrected (three-level) round-3 originality set. Exits 1 on
// any mismatch.
//
// Every expected value comes from the seed file; every observed value is read live from
// chain. The creation log is used only to learn the market ADDRESSES — what sits at those
// addresses is checked against the seed, not against the log.
//
//   Markets  parent: name, outcomes, templateId 1, sUSDS collateral, top-level, the 3
//            encoded Reality questions, ERC20 symbols ORIG_R3C_A/_B/_C.
//            each middle market: name, parent = this set's parent, parentOutcome = its
//            bundle, the full outcome list in order, templateId 3, encoded Reality
//            question, one ERC20 symbol per repo.
//            each score market: name, parent = ITS BUNDLE'S MIDDLE market, parentOutcome =
//            the repo's slot there, bounds, templateId 1, encoded Reality question,
//            ERC20 symbols. This link is the one the first set got wrong.
//   Pools    (skipped with --markets-only) each of the 196 pools pairs an outcome token
//            with its repo token, exists, holds liquidity and both tokens, and prices its
//            outcome within PRICE_TOLERANCE of the seed. Wallet: 1,000 parent Invalid and
//            1,000 Invalid of each middle market (the splits happened, in full), no idle
//            bundle tokens and no idle repo tokens.
//
//   node campaigns/originality-r3-v3/check-originality-r3-v3-pools.js [--markets-only] [--drift-ok]
//
// --drift-ok reports prices that have moved off the seed without failing on them: the
// tolerance is one tick of floor error, right for "verify immediately after seeding" and
// wrong for a market that has traded (docs/NEXT.md, the first set's checker).
//
// SEED_FILE can be overridden from the environment — that is how the verifier is tested
// against a deliberately corrupted seed before it is trusted.
//
// Sends nothing: declared `mutating: false`, so the harness never builds a signer. The
// wallet ADDRESS is still derived locally, because the wallet-balance checks need it.

import { ethers } from "ethers";
import fs from "fs";
import { formatUnits } from "viem";
import { mapConcurrent } from "../../lib/batch.js";
import { makeMarketView } from "../../lib/market.js";
import { encodeQuestionWithOutcomes, encodeQuestionWithoutOutcomes, TEMPLATE } from "../../lib/reality.js";
import { run } from "../../lib/run.js";
import { sortTokens } from "../../lib/ticks.js";
import { readMarketDirect } from "./read-market.js";

// A fresh pool is initialised at the tick BELOW the seed price (priceToTick floors), so
// the live price sits up to one tick (0.01%) under it before any trade.
const PRICE_TOLERANCE = 0.001;
// Tokens left in the wallet after seeding: integer rounding only.
const MAX_IDLE = 10n ** 15n; // 0.001
const CONCURRENCY = 8;
const Q96 = 2n ** 96n;

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
];
const UNISWAP_FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)"];

function outcomePriceFromSqrt(sqrtPriceX96, outcomeIsToken0) {
  const p = Number(sqrtPriceX96) / Number(Q96);
  const token1PerToken0 = p * p;
  return outcomeIsToken0 ? token1PerToken0 : 1 / token1PerToken0;
}

await run(
  { name: "check-originality-r3-v3-pools", slug: "originality-r3-v3", stage: "verify-pools", mutating: false },
  async (ctx) => {
    const { manifest, provider, chainId, addr, log, args } = ctx;

    const SEED_FILE = process.env.SEED_FILE ?? manifest.files.seed;
    const MARKETS_FILE = manifest.files.markets;
    const COLLATERAL = manifest.chain.collateral.address;
    const FEE_TIER = manifest.amm.feeTier;
    const SPLIT = BigInt(manifest.liquidity.totalCollateral) * 10n ** 18n;

    const marketView = makeMarketView(addr.marketView, provider);
    const uniFactory = new ethers.Contract(addr.poolFactory, UNISWAP_FACTORY_ABI, provider);
    const erc20 = (a) => new ethers.Contract(a, ERC20_ABI, provider);
    const symbolsOf = (tokens) => mapConcurrent(tokens, (a) => erc20(a).symbol(), { concurrency: CONCURRENCY });

    const marketsOnly = args.flags.has("--markets-only");
    const driftOk = args.flags.has("--drift-ok");
    const seed = JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));
    const created = JSON.parse(fs.readFileSync(MARKETS_FILE, "utf8"));
    const sp = seed.parent;
    const fails = [];
    const fail = (m) => fails.push(m);
    const drift = [];

    log.log(`\nVerify corrected round-3 originality (${marketsOnly ? "markets only" : "markets + pools"}), seed ${SEED_FILE}`);

    // ── Parent ────────────────────────────────────────────────────────────────
    const parentAddr = created.parent?.market;
    if (!parentAddr) throw new Error("no parent in the creation log");
    const pm = await marketView.getMarket(addr.marketFactory, parentAddr);
    const pWrapped = Array.from(pm.wrappedTokens).map(String);
    const expectedName = `${sp.questionStart}[${sp.outcomeType}]${sp.questionEnd}`;
    if (pm.marketName !== expectedName) fail(`parent name "${pm.marketName}"`);
    const pOutcomes = Array.from(pm.outcomes).map(String);
    if (JSON.stringify(pOutcomes.slice(0, 3)) !== JSON.stringify(sp.outcomes) || pOutcomes.length !== 4) {
      fail(`parent outcomes ${JSON.stringify(pOutcomes)}`);
    }
    if (Number(pm.templateId) !== TEMPLATE.UINT) fail(`parent templateId ${pm.templateId}`);
    if (pm.collateralToken.toLowerCase() !== COLLATERAL.toLowerCase()) fail(`parent collateral ${pm.collateralToken}`);
    if (pm.parentCollectionId !== ethers.ZeroHash) fail("parent is conditional");
    const pQuestions = Array.from(pm.encodedQuestions).map(String);
    if (pQuestions.length !== 3) fail(`parent has ${pQuestions.length} Reality questions`);
    sp.outcomes.forEach((o, i) => {
      const want = encodeQuestionWithoutOutcomes(`${sp.questionStart}${o}${sp.questionEnd}`, sp.category, sp.lang);
      if (pQuestions[i] !== want) fail(`parent question ${i} is "${pQuestions[i]}"`);
    });
    const pSymbols = await symbolsOf(pWrapped);
    sp.tokenNames.forEach((t, i) => {
      if (pSymbols[i] !== t) fail(`parent token ${i} symbol ${pSymbols[i]}, expected ${t}`);
    });
    if (pSymbols[3] !== "SER-INVALID") fail(`parent invalid symbol ${pSymbols[3]}`);
    log.log(`   parent ${parentAddr}: ${pOutcomes.join(" / ")}, symbols ${pSymbols.join(" / ")}`);

    // ── Middle markets ────────────────────────────────────────────────────────
    if ((created.middles ?? []).length !== seed.bundles.length) {
      fail(`${(created.middles ?? []).length} middle markets in the log, seed has ${seed.bundles.length}`);
    }
    const middles = [];
    for (const b of seed.bundles) {
      const entry = (created.middles ?? []).find((e) => e.parentOutcome === b.index);
      if (!entry) {
        fail(`${b.label}: no middle market in the creation log`);
        middles.push(null);
        continue;
      }
      // Not MarketView: it reverts for a middle market — see read-market.js.
      const m = await readMarketDirect(entry.market, provider);
      const wrapped = Array.from(m.wrappedTokens).map(String);
      const outcomes = Array.from(m.outcomes).map(String);
      const tag = `${b.label} middle`;
      if (m.marketName !== b.middle.marketName) fail(`${tag}: name "${m.marketName}"`);
      if (m.parentMarket.id.toLowerCase() !== parentAddr.toLowerCase()) fail(`${tag}: parentMarket ${m.parentMarket.id}`);
      if (Number(m.parentOutcome) !== b.index) fail(`${tag}: parentOutcome ${m.parentOutcome}, expected ${b.index}`);
      if (Number(m.templateId) !== TEMPLATE.MULTI_CATEGORICAL) fail(`${tag}: templateId ${m.templateId}`);
      if (outcomes.length !== b.middle.outcomes.length + 1) fail(`${tag}: ${outcomes.length} outcome slots, expected ${b.middle.outcomes.length + 1}`);
      b.middle.outcomes.forEach((o, j) => {
        if (outcomes[j] !== o) fail(`${tag}: outcome ${j} is "${outcomes[j]}", expected "${o}"`);
      });
      const q = Array.from(m.encodedQuestions).map(String);
      if (q.length !== 1 || q[0] !== encodeQuestionWithOutcomes(b.middle.marketName, b.middle.outcomes, sp.category, sp.lang)) {
        fail(`${tag}: Reality question "${(q[0] ?? "").slice(0, 120)}…"`);
      }
      const symbols = await symbolsOf(wrapped);
      b.middle.tokenNames.forEach((t, j) => {
        if (symbols[j] !== t) fail(`${tag}: token ${j} symbol ${symbols[j]}, expected ${t}`);
      });
      if (symbols[symbols.length - 1] !== "SER-INVALID") fail(`${tag}: invalid symbol ${symbols[symbols.length - 1]}`);
      middles.push({ market: entry.market, wrapped, invalidToken: wrapped[wrapped.length - 1] });
      log.log(`   ${tag} ${entry.market}: ${outcomes.length - 1} repos + Invalid, on ${pSymbols[b.index]}`);
    }

    // ── Score markets ─────────────────────────────────────────────────────────
    const byRepo = new Map(created.children.map((e) => [e.repo, e.market]));
    if (created.children.length !== seed.children.length) {
      fail(`${created.children.length} score markets in the log, seed has ${seed.children.length}`);
    }
    const children = await mapConcurrent(
      seed.children,
      async (c) => {
        const address = byRepo.get(c.repo);
        if (!address) return { c, missing: true };
        const m = await marketView.getMarket(addr.marketFactory, address);
        const wrapped = Array.from(m.wrappedTokens).map(String);
        const symbols = await Promise.all(wrapped.map((a) => erc20(a).symbol()));
        return { c, addr: address, m, wrapped, symbols };
      },
      { concurrency: CONCURRENCY }
    );
    for (const x of children) {
      const { c } = x;
      if (x.missing) {
        fail(`${c.repo}: no market in the creation log`);
        continue;
      }
      const { m } = x;
      const middle = middles[c.parentOutcome];
      if (m.marketName !== c.marketName) fail(`${c.repo}: name "${m.marketName}"`);
      if (!middle || m.parentMarket.id.toLowerCase() !== middle.market.toLowerCase()) {
        fail(`${c.repo}: parentMarket ${m.parentMarket.id} is not its bundle's middle market`);
      }
      if (Number(m.parentOutcome) !== c.indexInBundle) fail(`${c.repo}: parentOutcome ${m.parentOutcome}, expected ${c.indexInBundle}`);
      if (m.lowerBound.toString() !== c.lowerBound || m.upperBound.toString() !== c.upperBound) {
        fail(`${c.repo}: bounds ${m.lowerBound}-${m.upperBound}`);
      }
      if (Number(m.templateId) !== TEMPLATE.UINT) fail(`${c.repo}: templateId ${m.templateId}`);
      const q = Array.from(m.encodedQuestions).map(String);
      if (q.length !== 1 || q[0] !== encodeQuestionWithoutOutcomes(c.marketName, sp.category, sp.lang)) fail(`${c.repo}: Reality question "${q[0]}"`);
      if (x.symbols[0] !== c.tokenNames[0] || x.symbols[1] !== c.tokenNames[1]) fail(`${c.repo}: symbols ${x.symbols.join("/")}`);
    }
    const present = children.filter((x) => !x.missing);
    const addrs = present.map((x) => x.addr.toLowerCase());
    if (new Set(addrs).size !== addrs.length) fail("two repos point at the same score market");
    log.log(`   score markets: ${present.length}/${seed.children.length} checked`);

    // ── Pools ─────────────────────────────────────────────────────────────────
    if (!marketsOnly) {
      const poolable = present.filter((x) => middles[x.c.parentOutcome]);
      const pools = await mapConcurrent(
        poolable,
        async (x) => {
          const repoToken = middles[x.c.parentOutcome].wrapped[x.c.indexInBundle];
          const sides = [];
          for (const [label, token, seedPrice] of [
            ["DOWN", x.wrapped[0], x.c.seedDown],
            ["UP", x.wrapped[1], x.c.seedUp],
          ]) {
            const [t0, t1] = sortTokens(token, repoToken);
            const pool = await uniFactory.getPool(t0, t1, FEE_TIER);
            if (pool === ethers.ZeroAddress) {
              sides.push({ label, missing: true });
              continue;
            }
            const pc = new ethers.Contract(pool, POOL_ABI, provider);
            const [slot0, liq, balOutcome, balRepo] = await Promise.all([
              pc.slot0(),
              pc.liquidity(),
              erc20(token).balanceOf(pool),
              erc20(repoToken).balanceOf(pool),
            ]);
            const price = outcomePriceFromSqrt(slot0.sqrtPriceX96, t0.toLowerCase() === token.toLowerCase());
            sides.push({ label, pool, price, seedPrice, liq, balOutcome, balRepo });
          }
          return { ...x, repoToken, sides };
        },
        { concurrency: CONCURRENCY }
      );
      let ok = 0;
      for (const r of pools) {
        for (const s of r.sides) {
          const tag = `${r.c.repo} ${s.label}`;
          if (s.missing) {
            fail(`${tag}: pool not created`);
            continue;
          }
          if (s.liq === 0n) fail(`${tag}: pool has no liquidity`);
          if (s.balOutcome === 0n || s.balRepo === 0n) fail(`${tag}: pool is one-sided`);
          if (Math.abs(s.price - s.seedPrice) > PRICE_TOLERANCE) {
            const msg = `${tag}: price ${s.price.toFixed(6)}, seed ${s.seedPrice.toFixed(6)}`;
            if (driftOk) drift.push(msg);
            else fail(msg);
          } else if (s.liq > 0n) ok++;
        }
      }
      log.log(`   pools: ${ok}/${seed.children.length * 2} live and on their seed price (±${PRICE_TOLERANCE})`);
      if (drift.length) {
        log.log(`   drift (${drift.length}, reported only under --drift-ok):`);
        drift.slice(0, 40).forEach((d) => log.log(`      ${d}`));
      }

      // Read-only, so the harness built no signer — derive the address alone.
      const walletAddress = new ethers.Wallet(process.env.PRIVATE_KEY).address;
      const bal = (a) => erc20(a).balanceOf(walletAddress);
      const [susds, invalid, ...bundles] = await Promise.all([bal(COLLATERAL), bal(pWrapped[3]), ...pWrapped.slice(0, 3).map(bal)]);
      if (invalid !== SPLIT) fail(`wallet holds ${formatUnits(invalid, 18)} parent Invalid tokens, expected ${manifest.liquidity.totalCollateral}`);
      bundles.forEach((b, i) => {
        if (b > MAX_IDLE) fail(`wallet holds ${formatUnits(b, 18)} ${sp.tokenNames[i]} idle`);
      });
      const midInvalid = await Promise.all(middles.map((m) => (m ? bal(m.invalidToken) : 0n)));
      midInvalid.forEach((b, i) => {
        if (b !== SPLIT) fail(`wallet holds ${formatUnits(b, 18)} ${seed.bundles[i].label} middle Invalid tokens, expected ${manifest.liquidity.totalCollateral}`);
      });
      const idleRepo = await mapConcurrent(pools, (r) => bal(r.repoToken), { concurrency: CONCURRENCY });
      let worstIdle = 0n;
      idleRepo.forEach((b, i) => {
        if (b > worstIdle) worstIdle = b;
        if (b > MAX_IDLE) fail(`wallet holds ${formatUnits(b, 18)} ${pools[i].c.repoTokenName} idle`);
      });
      log.log(
        `   wallet ${walletAddress}: sUSDS ${formatUnits(susds, 18)}, parent Invalid ${formatUnits(invalid, 18)}, ` +
          `middle Invalid ${midInvalid.map((b) => formatUnits(b, 18)).join(" / ")}, ` +
          `idle bundle tokens ${bundles.map((b) => formatUnits(b, 18)).join(" / ")}, worst idle repo token ${formatUnits(worstIdle, 18)}`
      );
    }

    if (fails.length) {
      log.error(`\nVERIFY FAILED — ${fails.length} mismatch(es):`);
      fails.slice(0, 40).forEach((f) => log.error(`   - ${f}`));
      if (fails.length > 40) log.error(`   ... and ${fails.length - 40} more`);
      process.exit(1);
    }
    log.log(`\nVERIFY OK${marketsOnly ? " (markets)" : ""}: https://app.seer.pm/markets/${chainId}/${parentAddr}`);
    return { children: children.length, fails: 0, drift: drift.length };
  }
);
