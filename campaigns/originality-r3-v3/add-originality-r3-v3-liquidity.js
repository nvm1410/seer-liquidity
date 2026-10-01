// Seeds the CORRECTED round-3 originality markets with 1,000 sUSDS across 196 Uniswap V3
// pools (98 repos x {DOWN, UP}).
//
// The three-level structure (see create-originality-r3-v3-markets.js):
//
//   Phase 1  ONE splitPosition(sUSDS, parent, 1000) -> 1000 each of ORIG_R3C_A / _B / _C
//            (and of the parent's Invalid token). The only place sUSDS is spent.
//   Phase 2  per bundle: splitPosition(sUSDS, middle, 1000) -> 1000 of EVERY repo token
//            in that bundle (and of the middle market's Invalid token). Consumes the
//            bundle token in full.
//   Phase 3  per repo: splitPosition(sUSDS, score, X_i) -> X_i of DOWN, UP and Invalid.
//   Phase 4  per repo: mint (DOWN, repoToken) and (UP, repoToken) positions at the seed
//            prices, band [minPrice, maxPrice].
//
// In every split arg 0 is sUSDS, the BASE collateral, even where what is pulled from the
// wallet is a bundle or repo token — Router._splitPosition derives that from the market's
// parentCollectionId and calls wrapped1155.transferFrom on it (src/Router.sol:58-62).
//
// Budget: unlike the first set, no token is shared. A middle split mints the full 1,000
// of each repo token, so every repo's budget is B = 1000 of its OWN token. A repo token
// is worth about 1/98 sUSDS, so that is the same ~10 sUSDS of depth per repo as before.
//
// Sizing: X_i is SOLVED per repo. Both sides of a position are linear in the outcome
// quantity at fixed ticks, so one trial pass at Q0 gives the exact collateral-per-outcome
// ratios r_down and r_up, and then
//
//     X_i = B / (1 + r_down + r_up)
//
// makes the score split and both collateral legs consume the repo's full B.
//
// Idle by design (round 2 did the same): the parent's and each middle market's 1,000
// Invalid tokens, and each repo's X_i score-market Invalid tokens, are never pooled. They
// come back on a merge.
//
//   node campaigns/originality-r3-v3/add-originality-r3-v3-liquidity.js          # capital table
//   node campaigns/originality-r3-v3/add-originality-r3-v3-liquidity.js --live   # seeds
//
// Before the markets exist (no markets file) the dry run is a PREVIEW: token addresses
// are placeholders, so pool orientation — and with it the tick rounding in the last few
// wei — can differ from the live run. Amounts agree to display precision; the dry run
// after creation is the one to diff.
//
// The progress file is a RESUME LOG, NOT A RECORD — every split and pool already in it is
// skipped. Point --progress at a NEW filename for any re-seed.

import { Percent } from "@uniswap/sdk-core";
import { NonfungiblePositionManager } from "@uniswap/v3-sdk";
import { ethers } from "ethers";
import fs from "fs";
import { erc20Abi, formatUnits } from "viem";
import { RouterAbi } from "../../abis/RouterAbi.js";
import { mapConcurrent } from "../../lib/batch.js";
import { makeMarketView } from "../../lib/market.js";
import { run } from "../../lib/run.js";
import { ensureAllowance, retryTransaction, sleep } from "../../lib/tx.js";
import { buildPoolAndBounds, readLivePool, sizePosition } from "../../lib/uniswap.js";
import { readMarketDirect } from "./read-market.js";

// Trial outcome quantity used to measure the (linear) collateral ratios.
const Q0 = 1_000n * 10n ** 18n;
const ONE = 10n ** 18n;

const DELAY_MS = 1500;
const CONCURRENCY = 8;

// Deterministic stand-in address for the preview mode.
const placeholder = (label) => ethers.getAddress(ethers.dataSlice(ethers.id(`originality-r3-v3-preview:${label}`), 12));

function loadJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

const rowBase = (seedRow) => ({
  parentOutcome: seedRow.parentOutcome,
  indexInBundle: seedRow.indexInBundle,
  repo: seedRow.repo,
  seedDown: seedRow.seedDown,
  seedUp: seedRow.seedUp,
});

await run(
  {
    name: "add-originality-r3-v3-liquidity",
    slug: "originality-r3-v3",
    stage: "seed-pools",
    mutating: true,
    needsGate: true,
    progress: (m) => m.files.liquidity,
  },
  async (ctx) => {
    const { manifest, provider, wallet, chainId, addr, log, progress, spend, dry: DRY_RUN } = ctx;

    const SEED_FILE = manifest.files.seed;
    const MARKETS_FILE = manifest.files.markets;
    const MAP_CACHE_FILE = manifest.files.mapCache;
    const COLLATERAL = manifest.chain.collateral.address;
    const FEE_TIER = manifest.amm.feeTier;
    const TICK_SPACING = manifest.amm.tickSpacing;
    const BAND = manifest.liquidity.band;
    // The single parent split. Every bundle token's and every repo token's supply equals this.
    const TOTAL_SUSDS = BigInt(manifest.liquidity.totalCollateral) * ONE;

    if (!fs.existsSync(SEED_FILE)) throw new Error(`${SEED_FILE} not found`);

    const marketView = makeMarketView(addr.marketView, provider);
    const router = new ethers.Contract(addr.router, RouterAbi, wallet);
    const getBalance = (token) => new ethers.Contract(token, erc20Abi, provider).balanceOf(wallet.address);

    const seed = JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));
    const preview = !fs.existsSync(MARKETS_FILE);
    if (preview && !DRY_RUN) throw new Error(`${MARKETS_FILE} not found — run create-originality-r3-v3-markets.js first.`);

    log.log(`\n${DRY_RUN ? (preview ? "PREVIEW (markets not created yet)" : "DRY RUN") : "LIVE RUN"} — corrected originality round 3 liquidity`);
    log.log(`   wallet : ${wallet.address}`);

    // Resolve the parent, the 3 middle markets and the 98 score markets on chain into one
    // map, checking every link in the chain of conditions against the seed.
    const resolveMap = async (created) => {
      const info = await marketView.getMarket(addr.marketFactory, created.parent.market);
      if (info.collateralToken.toLowerCase() !== COLLATERAL.toLowerCase()) {
        throw new Error(`parent collateral ${info.collateralToken} != sUSDS`);
      }
      if (info.parentCollectionId !== ethers.ZeroHash) throw new Error("parent is itself conditional — expected top-level");
      const wrapped = Array.from(info.wrappedTokens).map(String);
      const outcomes = Array.from(info.outcomes).map(String);
      if (wrapped.length !== seed.bundles.length + 1) {
        throw new Error(`parent has ${wrapped.length} wrapped tokens, expected ${seed.bundles.length + 1}`);
      }
      seed.bundles.forEach((b, i) => {
        if (outcomes[i] !== b.label) throw new Error(`parent slot ${i} is "${outcomes[i]}", seed says "${b.label}"`);
      });
      const parent = { market: created.parent.market, outcomes, wrappedTokens: wrapped, invalidToken: wrapped[wrapped.length - 1] };

      const middles = [];
      for (const b of seed.bundles) {
        const entry = created.middles.find((e) => e.parentOutcome === b.index);
        if (!entry) throw new Error(`no middle market for ${b.label} in the creation log`);
        // Not MarketView: it reverts for a middle market — see read-market.js.
        const mi = await readMarketDirect(entry.market, provider);
        if (mi.parentMarket.id.toLowerCase() !== parent.market.toLowerCase()) throw new Error(`${entry.market}: parentMarket is not this set's parent`);
        if (Number(mi.parentOutcome) !== b.index) throw new Error(`${entry.market}: parentOutcome ${mi.parentOutcome}, expected ${b.index}`);
        if (mi.marketName !== b.middle.marketName) throw new Error(`${entry.market}: on-chain name does not match the seed`);
        const mo = Array.from(mi.outcomes).map(String);
        const mw = Array.from(mi.wrappedTokens).map(String);
        if (mw.length !== b.repos.length + 1) throw new Error(`${entry.market}: ${mw.length} wrapped tokens, expected ${b.repos.length + 1}`);
        b.repos.forEach((repo, j) => {
          if (mo[j] !== repo) throw new Error(`${entry.market}: slot ${j} is "${mo[j]}", seed says "${repo}"`);
        });
        middles.push({ parentOutcome: b.index, market: entry.market, bundleToken: wrapped[b.index], wrappedTokens: mw, invalidToken: mw[mw.length - 1] });
      }

      const repos = await mapConcurrent(
        created.children,
        async (entry) => {
          const ci = await marketView.getMarket(addr.marketFactory, entry.market);
          const seedRow = seed.children.find((c) => c.repo === entry.repo);
          if (!seedRow) throw new Error(`${entry.market}: repo ${entry.repo} not in the seed file`);
          const middle = middles[seedRow.parentOutcome];
          if (ci.parentMarket.id.toLowerCase() !== middle.market.toLowerCase()) {
            throw new Error(`${entry.market}: parentMarket ${ci.parentMarket.id} is not ${seed.bundles[seedRow.parentOutcome].label}'s middle market`);
          }
          if (ci.marketName !== seedRow.marketName) throw new Error(`${entry.market}: on-chain name does not match the seed`);
          const pOut = Number(ci.parentOutcome);
          if (pOut !== seedRow.indexInBundle) throw new Error(`${entry.market}: parentOutcome ${pOut}, seed says ${seedRow.indexInBundle}`);
          const cw = Array.from(ci.wrappedTokens).map(String);
          if (cw.length !== 3) throw new Error(`${entry.market}: ${cw.length} wrapped tokens, expected 3`);
          // wrappedTokens order is [DOWN, UP, Invalid].
          return {
            ...rowBase(seedRow),
            childMarket: entry.market,
            repoToken: middle.wrappedTokens[pOut],
            downToken: cw[0],
            upToken: cw[1],
            invalidToken: cw[2],
          };
        },
        { concurrency: CONCURRENCY }
      );
      return { parent, middles, repos };
    };

    const previewMap = () => {
      const wrapped = [...seed.bundles.map((b) => placeholder(b.tokenName)), placeholder("parent-invalid")];
      const parent = { market: placeholder("parent"), outcomes: seed.parent.outcomes, wrappedTokens: wrapped, invalidToken: wrapped[3] };
      const middles = seed.bundles.map((b) => {
        const mw = [...b.middle.tokenNames.map(placeholder), placeholder(`middle-invalid:${b.index}`)];
        return { parentOutcome: b.index, market: placeholder(`middle:${b.index}`), bundleToken: wrapped[b.index], wrappedTokens: mw, invalidToken: mw[mw.length - 1] };
      });
      const repos = seed.children.map((c) => ({
        ...rowBase(c),
        childMarket: placeholder(`child:${c.repo}`),
        repoToken: middles[c.parentOutcome].wrappedTokens[c.indexInBundle],
        downToken: placeholder(c.tokenNames[0]),
        upToken: placeholder(c.tokenNames[1]),
        invalidToken: placeholder(`${c.repo}:invalid`),
      }));
      return { parent, middles, repos };
    };

    // ── Phase 0: resolve the set on chain ────────────────────────────────────
    let map;
    if (preview) {
      map = previewMap();
      log.log(`Phase 0: ${MARKETS_FILE} absent — sizing against placeholder addresses.\n`);
    } else {
      const created = JSON.parse(fs.readFileSync(MARKETS_FILE, "utf8"));
      if (!created.parent?.market) throw new Error("no parent market in the creation log");
      if ((created.middles ?? []).length !== seed.bundles.length) {
        throw new Error(`creation log has ${(created.middles ?? []).length} middle markets, seed has ${seed.bundles.length}`);
      }
      if (created.children.length !== seed.children.length) {
        throw new Error(`creation log has ${created.children.length} score markets, seed has ${seed.children.length}`);
      }
      map = loadJson(MAP_CACHE_FILE, null);
      if (
        !map ||
        map.parent?.market?.toLowerCase() !== created.parent.market.toLowerCase() ||
        map.middles?.length !== seed.bundles.length ||
        map.repos?.length !== seed.children.length
      ) {
        log.log(`Phase 0: resolving the parent, ${created.middles.length} middle and ${created.children.length} score markets on chain...`);
        map = await resolveMap(created);
        fs.writeFileSync(MAP_CACHE_FILE, JSON.stringify(map, null, 2));
        log.log(`   resolved, cached to ${MAP_CACHE_FILE}\n`);
      } else {
        log.log(`Phase 0: using cached map from ${MAP_CACHE_FILE} (${map.repos.length} repos)\n`);
      }
    }
    map.repos.sort((a, b) => a.parentOutcome - b.parentOutcome || a.indexInBundle - b.indexInBundle);
    if (map.repos.length !== seed.children.length) {
      throw new Error(`resolved ${map.repos.length} repos, expected ${seed.children.length}`);
    }
    if (new Set(map.repos.map((r) => r.repoToken.toLowerCase())).size !== map.repos.length) {
      throw new Error("two repos resolve to the same repo token");
    }

    log.log(`   parent : ${map.parent.market}  split ${formatUnits(TOTAL_SUSDS, 18)} sUSDS`);
    seed.bundles.forEach((b, i) => {
      log.log(`   ${b.label} (${b.tokenName}) -> middle ${map.middles[i].market}: split ${formatUnits(TOTAL_SUSDS, 18)} -> ${b.repos.length} repo tokens`);
    });
    log.log(`   budget : ${formatUnits(TOTAL_SUSDS, 18)} of its own token per repo`);
    log.log(`   band   : [${BAND.minPrice}, ${BAND.maxPrice}]\n`);

    // ── Phase 0b: read live pool state, then size every position ─────────────
    log.log("Phase 0b: reading pool state and sizing positions...");
    const plans = await mapConcurrent(
      map.repos,
      async (r) => {
        const sides = [];
        for (const [label, outcomeToken, price] of [
          ["DOWN", r.downToken, r.seedDown],
          ["UP", r.upToken, r.seedUp],
        ]) {
          let poolAddress = ethers.ZeroAddress;
          let live = null;
          if (!preview) {
            const read = await readLivePool(outcomeToken, r.repoToken, { provider, chainId, feeTier: FEE_TIER });
            live = read.live;
            poolAddress = read.live ? read.poolAddress : ethers.ZeroAddress;
          }
          const meta = buildPoolAndBounds({
            outcomeToken,
            collateral: r.repoToken,
            price,
            live,
            chainId,
            feeTier: FEE_TIER,
            tickSpacing: TICK_SPACING,
            band: BAND,
          });
          // Trial pass: at fixed ticks both sides are linear in the outcome quantity, so
          // one measurement gives the exact collateral-per-outcome ratio.
          const trial = sizePosition(meta, Q0);
          if (trial.outcomeUsed === 0n) throw new Error(`${r.repo} ${label}: trial position consumes no outcome token`);
          const ratioScaled = (trial.collateralUsed * ONE) / trial.outcomeUsed;
          sides.push({ label, outcomeToken, price, poolAddress, meta, ratioScaled });
        }

        // X = B / (1 + r_down + r_up), so the score split plus both collateral legs
        // consume exactly this repo's B repo tokens.
        const B = TOTAL_SUSDS;
        const denomScaled = ONE + sides[0].ratioScaled + sides[1].ratioScaled;
        let candidate = (B * ONE) / denomScaled;

        // Uniswap's mintAmounts rounds the required amounts UP, so a position can ask for
        // a wei or two more outcome token than `candidate` — which would leave the mint 1
        // wei short of what the split produced and revert. So: split max(candidate, what
        // the pools actually ask for), then confirm B still covers it, trimming
        // `candidate` if rounding pushed it over.
        let splitAmount = candidate;
        let collateralTotal = 0n;
        let used = 0n;
        for (let attempt = 0; attempt < 4; attempt++) {
          let maxOutcome = 0n;
          collateralTotal = 0n;
          for (const s of sides) {
            s.sized = sizePosition(s.meta, candidate);
            if (s.sized.outcomeUsed > maxOutcome) maxOutcome = s.sized.outcomeUsed;
            collateralTotal += s.sized.collateralUsed;
          }
          splitAmount = candidate > maxOutcome ? candidate : maxOutcome;
          used = splitAmount + collateralTotal;
          if (used <= B) break;
          // Overshoot is only ever a handful of wei; back off by it plus a margin.
          candidate -= used - B + 1_000n;
        }
        if (used > B) {
          throw new Error(`${r.repo}: sizing wants ${formatUnits(used, 18)} of ${formatUnits(B, 18)} repo tokens`);
        }
        for (const s of sides) {
          if (s.sized.outcomeUsed > splitAmount) {
            throw new Error(`${r.repo} ${s.label}: pool needs ${s.sized.outcomeUsed} outcome tokens but the split mints ${splitAmount}`);
          }
        }
        return { ...r, sides, splitAmount, collateralTotal, used, B };
      },
      { concurrency: CONCURRENCY }
    );

    // ── Capital table ────────────────────────────────────────────────────────
    // Amounts are in the repo's OWN token, 1,000 of which exist per repo.
    log.log("\n bundle #  repo                                      seedDOWN  seedUP     split   collDOWN    collUP     used / B");
    let worstUnused = 0n;
    for (const p of plans) {
      const unused = p.B - p.used;
      if (unused > worstUnused) worstUnused = unused;
      log.log(
        `  ${seed.bundles[p.parentOutcome].label.slice(-1)}  ${String(p.indexInBundle).padStart(2)}  ${p.repo.padEnd(41)} ` +
          `${p.seedDown.toFixed(4)}    ${p.seedUp.toFixed(4)}  ` +
          `${Number(formatUnits(p.splitAmount, 18)).toFixed(3).padStart(8)}  ` +
          `${Number(formatUnits(p.sides[0].sized.collateralUsed, 18)).toFixed(3).padStart(8)}  ` +
          `${Number(formatUnits(p.sides[1].sized.collateralUsed, 18)).toFixed(3).padStart(8)}  ` +
          `${Number(formatUnits(p.used, 18)).toFixed(4).padStart(9)} / ${Number(formatUnits(p.B, 18)).toFixed(0)}`
      );
    }

    const preExisting = plans.flatMap((p) => p.sides).filter((s) => s.meta.live).length;
    const offSeed = plans.flatMap((p) => p.sides).filter((s) => Math.abs(s.meta.effectivePrice - s.price) > 5e-4);
    const scoreInvalid = plans.reduce((a, p) => a + p.splitAmount, 0n);

    log.log(`\n  GRAND TOTAL sUSDS committed (one parent split): ${formatUnits(TOTAL_SUSDS, 18)}`);
    log.log(`  middle splits              : ${seed.bundles.length} x ${formatUnits(TOTAL_SUSDS, 18)} bundle tokens (each bundle token used in full)`);
    log.log(`  pools to seed              : ${plans.length * 2}`);
    log.log(`  pools that already exist   : ${preExisting} (their live price is used, not the seed price)`);
    log.log(`  worst per-repo idle tokens : ${Number(formatUnits(worstUnused, 18)).toFixed(6)} (integer rounding)`);
    log.log(
      `  unpooled by design         : ${formatUnits(TOTAL_SUSDS, 18)} parent Invalid + ${formatUnits(TOTAL_SUSDS, 18)} Invalid of each middle market + ` +
        `${Number(formatUnits(scoreInvalid, 18)).toFixed(2)} score-market Invalid tokens`
    );
    if (offSeed.length) {
      log.log(`\n  ${offSeed.length} pool(s) priced >0.0005 off their seed (pre-existing pools):`);
      for (const s of offSeed.slice(0, 10)) {
        log.log(`     ${s.label.padEnd(4)} seed ${s.price.toFixed(4)} live ${s.meta.effectivePrice.toFixed(4)}`);
      }
    }

    const susds = await getBalance(COLLATERAL);
    const eth = await provider.getBalance(wallet.address);
    log.log(`\n  wallet sUSDS : ${formatUnits(susds, 18)}`);
    log.log(`  wallet ETH   : ${ethers.formatEther(eth)}`);
    if (!progress.has("parentSplit", "0") && susds < TOTAL_SUSDS) {
      log.warn(`  WARNING: sUSDS balance is below the ${formatUnits(TOTAL_SUSDS, 18)} to be split.`);
    }

    if (DRY_RUN) {
      return { repos: plans.length, pools: plans.length * 2, preExisting, offSeed: offSeed.length };
    }

    // A first seed must find no pool: these tokens are minutes old, so an existing pool
    // means someone initialised it at a price of their choosing.
    if (preExisting && !progress.count) {
      throw new Error(`${preExisting} pool(s) already exist before the first seed — inspect them before sending anything`);
    }

    // ── Phase 1: split sUSDS on the parent ───────────────────────────────────
    log.log(`\nPhase 1: parent split...`);
    if (progress.has("parentSplit", "0")) {
      log.log(`   already logged — skipping.`);
    } else {
      log.log(`\n  splitting ${formatUnits(TOTAL_SUSDS, 18)} sUSDS on ${map.parent.market}`);
      spend.charge(Number(formatUnits(TOTAL_SUSDS, 18)));
      await ensureAllowance(COLLATERAL, addr.router, TOTAL_SUSDS, { wallet, log });
      const receipt = await retryTransaction(() => router.splitPosition(COLLATERAL, map.parent.market, TOTAL_SUSDS), { log });
      progress.append({
        kind: "parentSplit",
        key: "0",
        market: map.parent.market,
        amount: TOTAL_SUSDS.toString(),
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        timestamp: new Date().toISOString(),
      });
      log.log(`     done — ${formatUnits(TOTAL_SUSDS, 18)} of each of the ${map.parent.wrappedTokens.length} parent outcome tokens minted.`);
      await sleep(DELAY_MS);
    }

    // ── Phase 2: split each bundle token on its middle market ────────────────
    // A failure here stops the run: every repo under that bundle needs its token.
    log.log(`\nPhase 2: ${map.middles.length} middle splits...`);
    for (const mid of map.middles) {
      const label = seed.bundles[mid.parentOutcome].label;
      if (progress.has("middleSplit", String(mid.parentOutcome))) {
        log.log(`   ${label}: already logged — skipping.`);
        continue;
      }
      log.log(`\n  ${label}: splitting ${formatUnits(TOTAL_SUSDS, 18)} ${seed.bundles[mid.parentOutcome].tokenName} on ${mid.market}`);
      const bal = await getBalance(mid.bundleToken);
      if (bal < TOTAL_SUSDS) throw new Error(`${label}: holds ${formatUnits(bal, 18)} of the bundle token, needs ${formatUnits(TOTAL_SUSDS, 18)}`);
      await ensureAllowance(mid.bundleToken, addr.router, TOTAL_SUSDS, { wallet, log });
      const receipt = await retryTransaction(() => router.splitPosition(COLLATERAL, mid.market, TOTAL_SUSDS), { log });
      progress.append({
        kind: "middleSplit",
        key: String(mid.parentOutcome),
        bundle: label,
        market: mid.market,
        amount: TOTAL_SUSDS.toString(),
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        timestamp: new Date().toISOString(),
      });
      await sleep(DELAY_MS);
    }

    // ── Phase 3: split each repo's own token on its score market ─────────────
    log.log(`\nPhase 3: ${plans.length} score-market splits...`);
    let splitCount = 0;
    for (const p of plans) {
      if (progress.has("childSplit", p.repo)) {
        splitCount++;
        continue;
      }
      log.log(`\n  ${seed.bundles[p.parentOutcome].label}[${p.indexInBundle}] ${p.repo}: split ${formatUnits(p.splitAmount, 18)}`);
      try {
        const bal = await getBalance(p.repoToken);
        if (bal < p.used) {
          throw new Error(`holds ${formatUnits(bal, 18)} of the repo token, needs ${formatUnits(p.used, 18)}`);
        }
        await ensureAllowance(p.repoToken, addr.router, p.splitAmount, { wallet, log });
        const receipt = await retryTransaction(() => router.splitPosition(COLLATERAL, p.childMarket, p.splitAmount), { log });
        progress.append({
          kind: "childSplit",
          key: p.repo,
          parentOutcome: p.parentOutcome,
          repo: p.repo,
          market: p.childMarket,
          amount: p.splitAmount.toString(),
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          timestamp: new Date().toISOString(),
        });
        splitCount++;
      } catch (err) {
        log.error(`    FAILED: ${(err.shortMessage || err.message || "").slice(0, 200)}`);
      }
      await sleep(DELAY_MS);
    }
    log.log(`\n   ${splitCount}/${plans.length} score-market splits done.`);

    // ── Phase 4: mint the 196 positions ──────────────────────────────────────
    log.log(`\nPhase 4: minting ${plans.length * 2} positions...`);
    let poolCount = 0;
    const failures = [];

    for (const p of plans) {
      // Both legs draw on the same repo token, so it is approved once for what is still
      // to be minted — a per-leg approve would read an allowance the other leg is about
      // to spend.
      const pmLeft = p.sides.filter((s) => !progress.has("pool", `${p.repo}:${s.label}`)).reduce((a, s) => a + s.sized.collateralUsed, 0n);
      if (pmLeft > 0n) {
        try {
          await ensureAllowance(p.repoToken, addr.positionManager, pmLeft, { wallet, log });
        } catch (err) {
          log.error(`  ${p.repo}: approve FAILED: ${(err.shortMessage || err.message || "").slice(0, 200)}`);
          p.sides.forEach((s) => failures.push(`${p.repo} ${s.label}`));
          continue;
        }
      }
      for (const s of p.sides) {
        const key = `${p.repo}:${s.label}`;
        if (progress.has("pool", key)) {
          poolCount++;
          continue;
        }
        log.log(
          `\n  ${seed.bundles[p.parentOutcome].label}[${p.indexInBundle}] ${p.repo} ${s.label} @ ${s.meta.effectivePrice.toFixed(4)}` +
            `  outcome ${formatUnits(s.sized.outcomeUsed, 18)} / collateral ${formatUnits(s.sized.collateralUsed, 18)}`
        );
        try {
          await ensureAllowance(s.outcomeToken, addr.positionManager, s.sized.outcomeUsed, { wallet, log });

          const { calldata, value } = NonfungiblePositionManager.addCallParameters(s.sized.position, {
            recipient: wallet.address,
            createPool: true, // create + initialise the pool if needed, then mint
            slippageTolerance: new Percent(50, 10_000), // 0.5%
            deadline: Math.floor(Date.now() / 1000) + 60 * 20,
          });
          const receipt = await retryTransaction(
            () => wallet.sendTransaction({ to: addr.positionManager, data: calldata, value }),
            { log }
          );

          progress.append({
            kind: "pool",
            key,
            parentOutcome: p.parentOutcome,
            repo: p.repo,
            market: p.childMarket,
            side: s.label,
            outcomeToken: s.outcomeToken,
            collateralToken: p.repoToken,
            poolAddress: s.poolAddress === ethers.ZeroAddress ? null : s.poolAddress,
            seedPrice: s.price,
            effectivePrice: s.meta.effectivePrice,
            preExisting: s.meta.live,
            tickLower: s.meta.tickLower,
            tickUpper: s.meta.tickUpper,
            amount0: s.sized.amount0.toString(),
            amount1: s.sized.amount1.toString(),
            outcomeUsed: s.sized.outcomeUsed.toString(),
            collateralUsed: s.sized.collateralUsed.toString(),
            txHash: receipt.hash,
            blockNumber: receipt.blockNumber,
            timestamp: new Date().toISOString(),
          });
          poolCount++;
        } catch (err) {
          log.error(`    FAILED: ${(err.shortMessage || err.message || "").slice(0, 200)}`);
          failures.push(`${p.repo} ${s.label}`);
        }
        await sleep(DELAY_MS);
      }
    }

    const susdsAfter = await getBalance(COLLATERAL);
    log.log(`\n--- Summary ---`);
    log.log(`   score splits : ${splitCount}/${plans.length}`);
    log.log(`   pools seeded : ${poolCount}/${plans.length * 2}`);
    log.log(`   wallet sUSDS : ${formatUnits(susds, 18)} -> ${formatUnits(susdsAfter, 18)}`);
    if (failures.length) {
      log.log(`   failed       : ${failures.length} — re-run with --resume to retry only these`);
      failures.slice(0, 20).forEach((f) => log.log(`      - ${f}`));
    }
    log.log(`\nProgress log: ${progress.path}`);
    return { childSplits: splitCount, pools: poolCount, failed: failures.length };
  }
);
