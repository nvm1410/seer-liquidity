// Seed the YES/sUSDS and NO/sUSDS pools for every Zcash Q3 2026 CDRGP market.
//
// Per market:
//   1. split Q sUSDS on the market  ->  Q YES + Q NO + Q Invalid
//   2. create + initialise + mint the YES/sUSDS pool at yesPrice
//   3. create + initialise + mint the NO/sUSDS pool at 1 - yesPrice
//
// The Invalid tokens from the split are left idle in the wallet. That is not
// wasted capital: Q sUSDS is the minimum needed to obtain Q of every outcome at
// once. But on this market set Invalid is a scheduled outcome with a named
// trigger, not a tail — see the guide.
//
// Both pools of a market use the same outcome quantity Q, which is what makes the
// split exact.
//
// THIS IS A FIRST-SEED SCRIPT, and it now REFUSES to run if any pool already
// exists. It prices every pool from the seed file, but a drained V3 pool keeps
// its last sqrtPriceX96 and createAndInitializePoolIfNecessary is a no-op on it,
// so the mint would execute at the pool's own price — wrong ratio, and a revert
// once the drift exceeds the slippage bound. Re-pricing an existing set is
// reseed-zcash-liquidity.js, which walks each pool to its target with a swap.
//
//   node add-zcash-liquidity.js          # dry: sizes every position, prints the table
//   node add-zcash-liquidity.js --live   # sends, after a confirmation

import { Percent } from "@uniswap/sdk-core";
import { NonfungiblePositionManager } from "@uniswap/v3-sdk";
import { ethers } from "ethers";
import fs from "fs";
import { formatUnits } from "viem";
import { RouterAbi } from "../../abis/RouterAbi.js";
import { assertMarket, getMarketInfo, makeMarketView, resolveOutcomeTokens } from "../../lib/market.js";
import { run } from "../../lib/run.js";
import { ensureAllowance, retryTransaction, sleep } from "../../lib/tx.js";
import { buildPoolAndBounds, readLivePool, sizePosition } from "../../lib/uniswap.js";

const DELAY_MS = 2000;
const Q0 = 1_000n * 10n ** 18n; // trial quantity for the linear budget solve

await run(
  { name: "add-zcash-liquidity", slug: "zcash-q3", stage: "phase1-seed", mutating: true },
  async (ctx) => {
    const { manifest, provider, wallet, chainId, addr, amm, log, progress, dry, spend } = ctx;
    const collateral = manifest.chain.collateral.address;
    const band = manifest.liquidity.band;
    const budget = ethers.parseUnits(String(manifest.liquidity.totalCollateral), manifest.chain.collateral.decimals);

    log.log(`\n📋 Wallet   : ${wallet.address}`);
    log.log(`📋 Budget   : ${formatUnits(budget, 18)} sUSDS`);
    log.log(`📋 Range    : [${band.minPrice}, ${band.maxPrice}] sUSDS per outcome token`);

    const marketsFile = manifest.files.markets;
    if (!fs.existsSync(marketsFile)) throw new Error(`${marketsFile} not found — create the markets first.`);
    const markets = JSON.parse(fs.readFileSync(marketsFile, "utf8"));
    if (!markets.length) throw new Error(`${marketsFile} is empty.`);
    log.log(`\n🔍 Phase 0: resolving ${markets.length} markets on-chain...`);

    const marketView = makeMarketView(addr.marketView, provider);
    const entries = [];

    for (const m of markets) {
      const info = await getMarketInfo(marketView, addr.marketFactory, m.market);
      await assertMarket(info, {
        label: `[${m.shortName}]`,
        collateral,
        topLevel: true,
        outcomes: ["Yes", "No"],
        questionCount: 1,
        loggedWrappedTokens: m.wrappedTokens,
        requireCode: 2, // YES and NO must be live ERC20s; Invalid is never pooled
        provider,
      });
      const { outcomeTokens } = resolveOutcomeTokens(info, { expectedCount: 2 });
      const [yesToken, noToken] = outcomeTokens;

      if (!(m.yesPrice > 0 && m.yesPrice < 1)) {
        throw new Error(`[${m.shortName}] yesPrice ${m.yesPrice} must be strictly between 0 and 1.`);
      }
      entries.push({
        ...m,
        yesToken,
        noToken,
        pools: [
          { side: "YES", outcomeToken: yesToken, price: m.yesPrice },
          { side: "NO", outcomeToken: noToken, price: 1 - m.yesPrice },
        ],
      });
    }
    log.log(`   ✅ all ${entries.length} markets verified: binary categorical, sUSDS, top-level`);

    // ── Phase 0b: refuse to seed a pool that already exists ───────────────────
    // This script prices every pool from the seed file. A drained V3 pool keeps
    // its last sqrtPriceX96 and createAndInitializePoolIfNecessary is a no-op on
    // it, so the mint would execute at the pool's OWN price: the sides split at
    // the wrong ratio, and mintAmountsWithSlippage is built around a price the
    // pool is not at, so a drifted pool reverts outright.
    log.log("\n🔍 Phase 0b: checking no pool exists yet...");
    const live = [];
    for (const p of entries.flatMap((e) => e.pools)) {
      const state = await readLivePool(p.outcomeToken, collateral, { provider, chainId, feeTier: amm.feeTier });
      p.poolAddress = state.poolAddress;
      if (state.live) live.push({ p, ...state });
    }
    if (live.length) {
      log.error(`\n❌ ${live.length} of ${entries.length * 2} pools already exist and hold a price:`);
      for (const { p, live: l, liquidity } of live.slice(0, 8)) {
        log.error(`   ${p.outcomeToken} tick ${l.tick}, liquidity ${liquidity}`);
      }
      if (live.length > 8) log.error(`   ...and ${live.length - 8} more`);
      throw new Error(
        "This is a FIRST-SEED script and would mint at the pools' own prices, not the seed prices. " +
          "Use reseed-zcash-liquidity.js, which walks each pool to its target with a swap first."
      );
    }
    log.log(`   ✅ all ${entries.length * 2} pools are fresh`);

    // ── Phase 1: size positions & solve for Q, per market ─────────────────────
    // Q is solved PER MARKET, not once globally. With one global Q the sUSDS side
    // explodes as a price approaches a band edge — a market at 0.20 would eat ~2x
    // the capital of one at 0.55, spending most on the proposals we are most
    // confident about.
    log.log("\n📐 Phase 1: sizing positions...");
    const allPools = entries.flatMap((e) => e.pools);
    const budgetPerMarket = budget / BigInt(entries.length);
    log.log(`   Budget per market: ${formatUnits(budgetPerMarket, 18)} sUSDS`);

    // live: null — see the header. This script prices from the seed, always.
    const sizeArgs = { collateral, chainId, feeTier: amm.feeTier, tickSpacing: amm.tickSpacing, band, live: null };

    for (const e of entries) {
      let trialSusds = 0n;
      for (const p of e.pools) {
        p.meta = buildPoolAndBounds({ outcomeToken: p.outcomeToken, price: p.price, ...sizeArgs });
        trialSusds += sizePosition(p.meta, Q0).collateralUsed;
      }
      e.Q = (Q0 * budgetPerMarket) / (Q0 + trialSusds);
      if (e.Q === 0n) throw new Error(`[${e.shortName}] solved Q is zero — raise the budget.`);
    }

    let sumSusds = 0n;
    log.log("\n    #  shortName        side  price   ticks                 outcome       sUSDS    mkt total");
    for (const e of entries) {
      e.splitAmount = 0n;
      e.capital = 0n;
      for (const p of e.pools) {
        const s = sizePosition(p.meta, e.Q);
        Object.assign(p, {
          position: s.position,
          outcomeUsed: s.outcomeUsed,
          susdsUsed: s.collateralUsed,
          amount0: s.amount0,
          amount1: s.amount1,
        });
        sumSusds += s.collateralUsed;
        e.capital += s.collateralUsed;
        if (s.outcomeUsed > e.splitAmount) e.splitAmount = s.outcomeUsed;
      }
      e.capital += e.splitAmount;
      for (const p of e.pools) {
        log.log(
          `   ${String(e.id).padStart(2)}  ${e.shortName.padEnd(15)} ${p.side.padEnd(4)} ` +
            `${p.price.toFixed(3)}  [${p.meta.tickLower},${p.meta.tickUpper}]`.padEnd(24) +
            `${Number(formatUnits(p.outcomeUsed, 18)).toFixed(2).padStart(11)}` +
            `${Number(formatUnits(p.susdsUsed, 18)).toFixed(2).padStart(12)}` +
            (p.side === "NO" ? `${Number(formatUnits(e.capital, 18)).toFixed(2).padStart(13)}` : "")
        );
      }
    }

    const totalSplit = entries.reduce((a, e) => a + e.splitAmount, 0n);
    const grandTotal = totalSplit + sumSusds;
    log.log(
      `\n   Splits (mint): ${formatUnits(totalSplit, 18)} sUSDS over ${entries.length} markets\n` +
        `   sUSDS side   : ${formatUnits(sumSusds, 18)} sUSDS over ${allPools.length} pools\n` +
        `   GRAND TOTAL  : ${formatUnits(grandTotal, 18)} sUSDS (budget ${formatUnits(budget, 18)})`
    );
    if (grandTotal > budget) log.warn("   ⚠️  grand total exceeds budget — check rounding/sentinel.");

    if (dry) return { markets: entries.length, pools: allPools.length, grandTotal: grandTotal.toString() };

    spend.charge(Number(formatUnits(grandTotal, 18)));

    const router = new ethers.Contract(addr.router, RouterAbi, wallet);
    const ct = await router.conditionalTokens();
    if (!ct || ct === ethers.ZeroAddress) throw new Error("Router.conditionalTokens() is zero — wrong Router?");
    log.log(`   Router.conditionalTokens() = ${ct}`);

    await ensureAllowance(collateral, addr.router, totalSplit, { wallet, log });
    await ensureAllowance(collateral, addr.positionManager, sumSusds, { wallet, log });

    // ── Phase 3: split + mint, market by market ───────────────────────────────
    log.log(`\n📈 Phase 3: seeding ${allPools.length} pools across ${entries.length} markets\n`);
    let poolCount = 0;

    for (const e of entries) {
      log.log(`\n=== [${e.id}] ${e.shortName} — ${e.market} ===`);

      if (progress.has("split", e.market.toLowerCase())) {
        log.log(`  ⏭  split already logged`);
      } else {
        try {
          log.log(`  💧 splitting ${formatUnits(e.splitAmount, 18)} sUSDS`);
          const receipt = await retryTransaction(
            () => router.splitPosition(collateral, e.market, e.splitAmount),
            { log }
          );
          progress.append({
            kind: "split",
            key: e.market.toLowerCase(),
            id: e.id,
            shortName: e.shortName,
            market: e.market,
            amount: e.splitAmount.toString(),
            txHash: receipt.hash,
            blockNumber: receipt.blockNumber,
          });
        } catch (err) {
          log.error(`  ❌ split failed for ${e.shortName}: ${err.shortMessage || err.message} — skipping its pools`);
          continue;
        }
        await sleep(DELAY_MS);
      }

      for (const p of e.pools) {
        const key = p.outcomeToken.toLowerCase();
        if (progress.has("pool", key)) {
          log.log(`  ⏭  ${p.side} pool already logged`);
          poolCount++;
          continue;
        }
        log.log(`\n  --- ${e.shortName} ${p.side} @ ${p.price.toFixed(3)} (${p.outcomeToken}) ---`);
        try {
          const outcomeAmount = p.meta.isToken0Outcome ? p.amount0 : p.amount1;
          await ensureAllowance(p.outcomeToken, addr.positionManager, outcomeAmount, { wallet, log });

          const { calldata, value } = NonfungiblePositionManager.addCallParameters(p.position, {
            recipient: wallet.address,
            createPool: true,
            slippageTolerance: new Percent(50, 10_000),
            deadline: Math.floor(Date.now() / 1000) + 60 * 20,
          });
          const receipt = await retryTransaction(
            () => wallet.sendTransaction({ to: addr.positionManager, data: calldata, value }),
            { log }
          );

          progress.append({
            kind: "pool",
            key,
            id: e.id,
            shortName: e.shortName,
            market: e.market,
            side: p.side,
            outcomeToken: p.outcomeToken,
            price: p.price,
            tickLower: p.meta.tickLower,
            tickUpper: p.meta.tickUpper,
            amount0: p.amount0.toString(),
            amount1: p.amount1.toString(),
            outcomeUsed: p.outcomeUsed.toString(),
            susdsUsed: p.susdsUsed.toString(),
            txHash: receipt.hash,
            blockNumber: receipt.blockNumber,
          });
          poolCount++;
          log.log(`  ✅ Saved to ${progress.path}`);
        } catch (err) {
          log.error(`  ❌ ${e.shortName} ${p.side} failed: ${err.shortMessage || err.message}`);
        }
        await sleep(DELAY_MS);
      }
    }

    log.log(`\n🎉 Done! ${poolCount}/${allPools.length} pools seeded. See ${progress.path}.`);
    if (poolCount < allPools.length) {
      log.log("   Re-run with --resume to retry the failures — logged splits and pools are skipped.");
    }
    return { pools: poolCount };
  }
);
