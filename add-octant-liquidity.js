// Seeds the Octant market — a one-level multiscalar market on Optimism, no parent and
// no children — with 20,000 sUSDS across 25 Uniswap V3 pools.
//
//   Phase 1  size every pool and SOLVE the outcome quantity Q against the budget. The
//            sUSDS side of a pool is linear in the outcome quantity at fixed ticks, so
//            one trial pass at Q0 gives Q = Q0 * BUDGET / (Q0 + trialSusds) directly.
//   Phase 2a ONE splitPosition(sUSDS, market, Q) mints Q of every outcome token.
//   Phase 2b mint (outcome, sUSDS) for each of the 25 named outcomes.
//
// The Invalid outcome is deliberately dropped here, so the split's Invalid tokens sit
// idle — add-octant-invalid-liquidity.js deploys those into a 26th pool afterwards.
//
//   node add-octant-liquidity.js --resume          # dry: the full 25-pool sizing table
//   node add-octant-liquidity.js --resume --live   # seeds, after a confirmation
//
// NOTE ON RE-SEEDING. This script prices every pool from the CSV and never reads the
// pool's live state, which is correct for a first seed and WRONG for a re-seed: a
// drained pool keeps its sqrtPriceX96 and createAndInitializePoolIfNecessary is a no-op
// on it, so the mint would execute at the pool's own price. lib/uniswap.js takes `live`
// for exactly that reason; passing null here reproduces the original behaviour rather
// than quietly changing it. Read the pool state first if this is ever re-run.

import { Percent } from "@uniswap/sdk-core";
import { NonfungiblePositionManager } from "@uniswap/v3-sdk";
import { ethers } from "ethers";
import fs from "fs";
import { erc20Abi, formatUnits } from "viem";
import { RouterAbi } from "./abis/RouterAbi.js";
import { getMarketInfo, makeMarketView } from "./lib/market.js";
import { run } from "./lib/run.js";
import { ensureAllowance, retryTransaction, sleep } from "./lib/tx.js";
import { buildPoolAndBounds, sizePosition } from "./lib/uniswap.js";

// Trial outcome-token quantity per pool used to size the (linear) budget.
const Q0 = 1_000n * 10n ** 18n;

// Octant's own name normalizer. lib/market.js deliberately does NOT strip a trailing
// period, because that destroys information outcome-label matching needs elsewhere; the
// Octant CSV needs it, and it must happen BEFORE trim so a name ending in ". " keeps its
// period. Kept local rather than pushed into lib.
const normalizeOctantName = (s) =>
  String(s)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\.$/, "")
    .trim();

// Parse octant-initial-price.csv → Map<normalizedName, {name, rescaled}>.
function parsePriceCsv(path) {
  const lines = fs
    .readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  lines.shift(); // drop header
  const map = new Map();
  let sum = 0;
  for (const line of lines) {
    const idx = line.lastIndexOf(",");
    const name = line.slice(0, idx);
    const rescaled = Number(line.slice(idx + 1));
    if (!Number.isFinite(rescaled)) throw new Error(`Bad CSV row: ${line}`);
    map.set(normalizeOctantName(name), { name, rescaled });
    sum += rescaled;
  }
  return { map, sum };
}

await run(
  {
    name: "add-octant-liquidity",
    slug: "octant",
    stage: "seed-pools",
    mutating: true,
    progress: (m) => m.files.liquidity,
  },
  async (ctx) => {
    const { manifest, provider, wallet, chainId, addr, log, progress, dry: DRY_RUN } = ctx;

    const OCTANT_MARKET = manifest.results.parent;
    const CSV_FILE = manifest.files.seed;
    const COLLATERAL = manifest.chain.collateral.address;
    const FEE_TIER = manifest.amm.feeTier;
    const TICK_SPACING = manifest.amm.tickSpacing;
    const BAND = manifest.liquidity.band;
    // Total capital to deploy: the split (sUSDS minted into outcome tokens) plus the
    // sUSDS side of every pool must sum to this.
    const TOTAL_BUDGET = BigInt(manifest.liquidity.totalCollateral) * 10n ** 18n;

    log.log(`\n📋 Wallet      : ${wallet.address}`);
    log.log(`📋 DRY_RUN     : ${DRY_RUN}`);
    log.log(`📋 Budget      : ${formatUnits(TOTAL_BUDGET, 18)} sUSDS`);
    log.log(`📋 Range       : [${BAND.minPrice}, ${BAND.maxPrice}] sUSDS/outcome\n`);

    const marketView = makeMarketView(addr.marketView, provider);
    const getTokenBalance = (token) => new ethers.Contract(token, erc20Abi, provider).balanceOf(wallet.address);

    // ── Phase 0: resolve market + price map ─────────────────────────────────────
    log.log("🔍 Phase 0: resolving market & prices...");
    const info = await getMarketInfo(marketView, addr.marketFactory, OCTANT_MARKET);

    if (info.isConditional) throw new Error("Market is conditional — expected a top-level market.");
    if (!info.questionsIds || info.questionsIds.length < 2) {
      throw new Error(`Expected a multiscalar market (>1 question), got ${info.questionsIds?.length}.`);
    }
    if (info.collateralToken.toLowerCase() !== COLLATERAL.toLowerCase()) {
      throw new Error(`Collateral ${info.collateralToken} ≠ sUSDS ${COLLATERAL}.`);
    }

    // Drop the Invalid outcome (last entry).
    const outcomeNames = info.outcomes.slice(0, -1);
    const outcomeTokens = info.wrappedTokens.slice(0, -1);
    log.log(
      `   Market "${info.name}" | ${info.questionsIds.length} questions | ` +
        `${outcomeTokens.length} outcomes (+Invalid)`
    );

    const { map: priceMap, sum } = parsePriceCsv(CSV_FILE);
    log.log(`   CSV: ${priceMap.size} rows, Σ rescaled = ${sum.toFixed(4)}`);
    if (priceMap.size !== outcomeTokens.length) {
      throw new Error(`CSV rows (${priceMap.size}) ≠ market outcomes (${outcomeTokens.length}).`);
    }

    // Match each on-chain outcome to a CSV row by normalized name.
    const pools = [];
    const unmatched = [];
    let priceSum = 0;
    for (let i = 0; i < outcomeTokens.length; i++) {
      const row = priceMap.get(normalizeOctantName(outcomeNames[i]));
      if (!row) {
        unmatched.push(outcomeNames[i]);
        continue;
      }
      const price = row.rescaled / sum;
      priceSum += price;
      pools.push({ index: i, name: outcomeNames[i], outcomeToken: outcomeTokens[i], rescaled: row.rescaled, price });
    }
    if (unmatched.length) {
      log.error("\n❌ Unmatched on-chain outcomes (fix CSV names):");
      unmatched.forEach((n) => log.error(`   - "${n}"`));
      log.error("\nCSV names available:");
      [...priceMap.values()].forEach((v) => log.error(`   - "${v.name}"`));
      throw new Error(`${unmatched.length} outcomes unmatched.`);
    }
    log.log(`   All ${pools.length} outcomes matched. Σ price = ${priceSum.toFixed(6)}`);

    // ── Phase 0b: verify wrapped outcome ERC20s are deployed ────────────────────
    for (const p of pools) {
      const code = await provider.getCode(p.outcomeToken);
      if (!code || code === "0x") {
        throw new Error(`Outcome token ${p.outcomeToken} (${p.name}) has no code — not deployed.`);
      }
    }
    log.log("   ✅ all outcome tokens deployed on-chain");

    // ── Phase 1: size positions & solve for Q ───────────────────────────────────
    log.log("\n📐 Phase 1: sizing positions...");
    // Trial pass at Q0 to measure Σ c_i (sUSDS per pool is linear in outcome qty).
    let trialSusds = 0n;
    for (const p of pools) {
      p.meta = buildPoolAndBounds({
        outcomeToken: p.outcomeToken,
        collateral: COLLATERAL,
        price: p.price,
        live: null, // see the re-seeding note in the header
        chainId,
        feeTier: FEE_TIER,
        tickSpacing: TICK_SPACING,
        band: BAND,
      });
      trialSusds += sizePosition(p.meta, Q0).collateralUsed;
    }
    const totalTrial = Q0 + trialSusds; // mint (=Q0) + sUSDS side
    const Q = (Q0 * TOTAL_BUDGET) / totalTrial;
    log.log(
      `   Trial Q0=${formatUnits(Q0, 18)} → ΣsUSDS=${formatUnits(trialSusds, 18)}, ` +
        `total=${formatUnits(totalTrial, 18)} ⇒ Q=${formatUnits(Q, 18)}`
    );

    // Final pass at Q.
    let sumSusds = 0n;
    let maxOutcome = 0n;
    log.log("\n   #  outcome                          price     ticks            outcome      sUSDS");
    for (const p of pools) {
      const s = sizePosition(p.meta, Q);
      p.position = s.position;
      p.outcomeUsed = s.outcomeUsed;
      p.susdsUsed = s.collateralUsed;
      p.amount0 = s.amount0;
      p.amount1 = s.amount1;
      sumSusds += s.collateralUsed;
      if (s.outcomeUsed > maxOutcome) maxOutcome = s.outcomeUsed;
      log.log(
        `   ${String(p.index).padStart(2)} ${p.name.slice(0, 30).padEnd(30)} ` +
          `${p.price.toFixed(5)}  [${p.meta.tickLower},${p.meta.tickUpper}]`.padEnd(20) +
          `  ${Number(formatUnits(s.outcomeUsed, 18)).toFixed(2).padStart(10)}` +
          `  ${Number(formatUnits(s.collateralUsed, 18)).toFixed(2).padStart(9)}`
      );
    }
    // Mint cost = the single split size; Q outcome tokens per pool ⇒ split Q.
    const splitAmount = maxOutcome > Q ? maxOutcome : Q;
    const grandTotal = splitAmount + sumSusds;
    log.log(
      `\n   Split (mint) : ${formatUnits(splitAmount, 18)} sUSDS\n` +
        `   sUSDS side   : ${formatUnits(sumSusds, 18)} sUSDS\n` +
        `   GRAND TOTAL  : ${formatUnits(grandTotal, 18)} sUSDS (budget ${formatUnits(TOTAL_BUDGET, 18)})`
    );
    if (grandTotal > TOTAL_BUDGET) {
      log.warn("   ⚠️  grand total exceeds budget — check rounding/sentinel.");
    }

    if (DRY_RUN) {
      return { pools: pools.length, Q: Q.toString(), grandTotal: grandTotal.toString() };
    }

    // ── Phase 2a: balance guard + split sUSDS once ──────────────────────────────
    const susdsBalance = await getTokenBalance(COLLATERAL);
    log.log(`\n💰 sUSDS balance: ${formatUnits(susdsBalance, 18)} | need: ${formatUnits(grandTotal, 18)}`);
    if (susdsBalance < grandTotal) throw new Error("Insufficient sUSDS balance — aborting.");

    const router = new ethers.Contract(addr.router, RouterAbi, wallet);
    const ct = await router.conditionalTokens();
    if (!ct || ct === ethers.ZeroAddress) throw new Error("Router.conditionalTokens() is zero — wrong Router?");
    log.log(`   Router.conditionalTokens() = ${ct}`);

    // The historical entries carry outcomeToken with no kind/key, so key off that.
    const alreadyDone = new Set(progress.entries.map((e) => e.outcomeToken.toLowerCase()));

    // Split once → Q (≈ splitAmount) of EVERY outcome token (+ Invalid, ignored).
    // Skip if the progress log is non-empty (resume case).
    const needSplit = !alreadyDone.size; // fresh run → split; resume → assume done
    if (!needSplit) log.log("\n⏭  Progress log present — assuming split already done.");
    if (needSplit) {
      log.log(`\n💧 Phase 2a: split ${formatUnits(splitAmount, 18)} sUSDS on octant market`);
      await ensureAllowance(COLLATERAL, addr.router, splitAmount, { wallet, log });
      await retryTransaction(() => router.splitPosition(COLLATERAL, OCTANT_MARKET, splitAmount), { log });
      await sleep(3000);
    }

    // sUSDS is a token in every pool — approve the full sUSDS side once.
    await ensureAllowance(COLLATERAL, addr.positionManager, sumSusds, { wallet, log });

    // ── Phase 2b: create + initialize + mint each pool ──────────────────────────
    log.log(`\n📈 Phase 2b: minting ${pools.length} positions\n`);
    let successCount = 0;
    for (const p of pools) {
      if (alreadyDone.has(p.outcomeToken.toLowerCase())) {
        log.log(`  ⏭  ${p.name}: already in progress log — skipping`);
        successCount++;
        continue;
      }

      log.log(`\n--- ${p.name} (${p.outcomeToken}) ---`);
      // Approve the outcome side for this pool.
      const outcomeAmount = p.meta.isToken0Outcome ? p.amount0 : p.amount1;
      await ensureAllowance(p.outcomeToken, addr.positionManager, outcomeAmount, { wallet, log });

      try {
        const { calldata, value } = NonfungiblePositionManager.addCallParameters(p.position, {
          recipient: wallet.address, // mint a new position
          createPool: true, // create + initialize pool if needed, then mint
          slippageTolerance: new Percent(50, 10_000), // 0.5%
          deadline: Math.floor(Date.now() / 1000) + 60 * 20,
        });
        const receipt = await retryTransaction(
          () => wallet.sendTransaction({ to: addr.positionManager, data: calldata, value }),
          { log }
        );

        progress.append({
          kind: "pool",
          key: p.outcomeToken.toLowerCase(),
          index: p.index,
          name: p.name,
          outcomeToken: p.outcomeToken,
          price: p.price,
          tickLower: p.meta.tickLower,
          tickUpper: p.meta.tickUpper,
          amount0: p.amount0.toString(),
          amount1: p.amount1.toString(),
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
        });
        successCount++;
        log.log(`  ✅ Saved to ${progress.path}`);
      } catch (err) {
        log.error(`  ❌ Failed for ${p.name}: ${err.shortMessage || err.message}`);
      }
      await sleep(2000);
    }

    log.log(`\n🎉 Done! ${successCount}/${pools.length} positions minted. See ${progress.path}.`);
    return { minted: successCount, pools: pools.length };
  }
);
