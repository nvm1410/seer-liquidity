// Seed one Uniswap V3 pool per outcome for every Zcash NU7 coinholder-poll market.
//
// Per market (a single-select categorical market with n options):
//   1. split Q sUSDS on the market  ->  Q of each of the n outcomes + Q Invalid
//   2. create + initialise + mint one <outcome>/sUSDS pool per option, at that
//      option's seed price
//
// The Invalid tokens from the split are left idle in the wallet. That is not
// wasted capital: Q sUSDS is the minimum needed to obtain Q of every outcome at
// once. But Invalid is a real risk here, not a tail — see the guide.
//
// Every pool uses the same outcome-token quantity Q, which is what makes the
// split exact: every token minted gets deployed, nothing left over. The
// consequence, accepted deliberately, is that a market's favourite takes most of
// its budget on the sUSDS side and long shots get thin depth.
//
// Prices come from the questions file joined by id, NOT from the creation log —
// the questions file is the single source of truth, so a later reprice edits one
// place. (add-zcash-liquidity.js read prices from its creation log and went stale.)
//
//   node add-zcash-nu7-liquidity.js          # dry: resolves every market, sizes
//                                            # every position, prints the capital table
//   node add-zcash-nu7-liquidity.js --live   # sends, after a confirmation

import { Percent } from "@uniswap/sdk-core";
import { NonfungiblePositionManager } from "@uniswap/v3-sdk";
import { ethers } from "ethers";
import fs from "fs";
import { erc20Abi, formatUnits } from "viem";
import { RouterAbi } from "../../abis/RouterAbi.js";
import { assertMarket, getMarketInfo, makeMarketView, resolveOutcomeTokens } from "../../lib/market.js";
import { run } from "../../lib/run.js";
import { ensureAllowance, retryTransaction, sleep } from "../../lib/tx.js";
import { buildPoolAndBounds, readLivePool, sizePosition } from "../../lib/uniswap.js";

const DELAY_MS = 2000;
// Trial outcome quantity for the linear budget solve. Not campaign config: both
// sides of a position are linear in the quantity at fixed ticks, so one pass at
// any Q0 gives the exact scale factor.
const Q0 = 1_000n * 10n ** 18n;

await run(
  { name: "add-zcash-nu7-liquidity", slug: "zcash-nu7", stage: "phase1-seed", mutating: true },
  async (ctx) => {
    const { manifest, provider, wallet, chainId, addr, amm, log, progress, dry, spend } = ctx;
    const collateral = manifest.chain.collateral.address;
    const band = manifest.liquidity.band;
    const budget = ethers.parseUnits(String(manifest.liquidity.totalCollateral), manifest.chain.collateral.decimals);

    log.log(`\nWallet   : ${wallet.address}`);
    log.log(`Budget   : ${formatUnits(budget, 18)} sUSDS`);
    log.log(`Range    : [${band.minPrice}, ${band.maxPrice}] sUSDS per outcome token`);

    const marketsFile = manifest.files.markets;
    if (!fs.existsSync(marketsFile)) throw new Error(`${marketsFile} not found — create the markets first.`);
    const markets = JSON.parse(fs.readFileSync(marketsFile, "utf8"));
    if (!markets.length) throw new Error(`${marketsFile} is empty.`);

    const doc = JSON.parse(fs.readFileSync(manifest.files.seed, "utf8"));
    const byId = new Map(doc.questions.map((q) => [q.id, q]));

    // ── Phase 0: resolve every market on chain ────────────────────────────────
    log.log(`\nPhase 0: resolving ${markets.length} markets on-chain...`);
    const marketView = makeMarketView(addr.marketView, provider);
    const entries = [];

    for (const m of markets) {
      const question = byId.get(m.id);
      if (!question) throw new Error(`market id ${m.id} (${m.shortName}) is not in ${manifest.files.seed}.`);

      // A categorical market's outcome prices must sum to 1: that is what makes
      // the set arbitrage-free.
      const priceSum = question.outcomes.reduce((a, o) => a + o.price, 0);
      if (Math.abs(priceSum - 1) > 1e-9) {
        throw new Error(`[${m.shortName}] outcome prices sum to ${priceSum} — a categorical market must sum to 1.`);
      }
      for (const o of question.outcomes) {
        if (!(o.price > 0 && o.price < 1)) {
          throw new Error(`[${m.shortName}] price ${o.price} for "${o.label}" must be strictly between 0 and 1.`);
        }
      }

      const info = await getMarketInfo(marketView, addr.marketFactory, m.market);
      const n = question.outcomes.length;
      await assertMarket(info, {
        label: `[${m.shortName}]`,
        collateral,
        topLevel: true,
        templateId: 2,
        outcomes: question.outcomes.map((o) => o.label),
        questionCount: 1,
        loggedWrappedTokens: m.wrappedTokens,
        requireCode: n, // every token about to be pooled must be a live ERC20
        provider,
      });
      const { outcomeTokens, invalidToken } = resolveOutcomeTokens(info, { expectedCount: n });

      entries.push({
        id: m.id,
        shortName: m.shortName,
        topic: question.topic,
        market: m.market,
        invalidToken,
        pools: question.outcomes.map((o, i) => ({
          tag: o.tag,
          label: o.label,
          outcomeToken: outcomeTokens[i],
          price: o.price,
        })),
      });
    }
    const allPools = entries.flatMap((e) => e.pools);
    log.log(
      `   OK: all ${entries.length} markets verified — single-select categorical, sUSDS, top-level; ` +
        `${allPools.length} pools to seed`
    );

    // ── Phase 0b: read live pool state ────────────────────────────────────────
    // On a first seed every pool is missing and every price comes from the
    // questions file. On a RE-seed the pools still exist at whatever price they
    // were left at, and that price — not the questions file — is what the mint
    // will execute against.
    log.log("\nPhase 0b: reading live pool state...");
    let existing = 0;
    let nonEmpty = 0;
    for (const p of allPools) {
      const { poolAddress, live, liquidity } = await readLivePool(p.outcomeToken, collateral, {
        provider,
        chainId,
        feeTier: amm.feeTier,
      });
      p.poolAddress = poolAddress;
      p.live = live;
      if (!live) continue;
      p.liveLiquidity = liquidity;
      existing++;
      if (liquidity !== 0n) nonEmpty++;
    }
    log.log(
      `   ${existing}/${allPools.length} pools already exist and keep their last price` +
        ` (${allPools.length - existing} fresh)`
    );
    if (nonEmpty) {
      log.warn(
        `   WARNING: ${nonEmpty} of those already hold liquidity — this run mints a NEW position\n` +
          "   on top rather than topping up. Check the progress log before going live."
      );
    }

    // ── Phase 1: size positions & solve for Q, per market ─────────────────────
    // Budget is split evenly across markets and Q is solved PER MARKET, not once
    // globally. With one global Q the sUSDS side explodes as a price approaches a
    // band edge, so markets with confident favourites would eat the budget.
    log.log("\nPhase 1: sizing positions...");
    const budgetPerMarket = budget / BigInt(entries.length);
    log.log(`   Budget per market: ${formatUnits(budgetPerMarket, 18)} sUSDS`);

    const sizeArgs = { collateral, chainId, feeTier: amm.feeTier, tickSpacing: amm.tickSpacing, band };

    for (const e of entries) {
      let trialSusds = 0n;
      for (const p of e.pools) {
        p.meta = buildPoolAndBounds({ outcomeToken: p.outcomeToken, price: p.price, live: p.live, ...sizeArgs });
        trialSusds += sizePosition(p.meta, Q0).collateralUsed;
      }
      // Capital for this market = one split of Q + the sUSDS side of every pool.
      e.Q = (Q0 * budgetPerMarket) / (Q0 + trialSusds);
      if (e.Q === 0n) throw new Error(`[${e.shortName}] solved Q is zero — raise the budget.`);
    }

    let sumSusds = 0n;
    log.log("\n    #  mkt  outcome           seed    live    ticks                  outcome        sUSDS");
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
        // Equal Q means every pool binds at exactly Q, but take the max anyway so
        // the split can never come up short if sizing ever stops being equal.
        if (s.outcomeUsed > e.splitAmount) e.splitAmount = s.outcomeUsed;
      }
      e.capital += e.splitAmount;
      for (const p of e.pools) {
        const drifted = Math.abs(p.meta.effectivePrice - p.price) > 0.0005;
        log.log(
          `   ${String(e.id).padStart(2)}  ${e.shortName.padEnd(4)} ${p.tag.padEnd(16)} ` +
            `${p.price.toFixed(3)}  ${p.meta.effectivePrice.toFixed(4)}` +
            `  [${p.meta.tickLower},${p.meta.tickUpper}]`.padEnd(23) +
            `${Number(formatUnits(p.outcomeUsed, 18)).toFixed(2).padStart(12)}` +
            `${Number(formatUnits(p.susdsUsed, 18)).toFixed(2).padStart(13)}` +
            (drifted ? "  <- live" : "")
        );
      }
      log.log(
        `       ${e.shortName} split ${Number(formatUnits(e.splitAmount, 18)).toFixed(2)} + ` +
          `pools ${Number(formatUnits(e.capital - e.splitAmount, 18)).toFixed(2)} = ` +
          `${Number(formatUnits(e.capital, 18)).toFixed(2)} sUSDS\n`
      );
    }

    const totalSplit = entries.reduce((a, e) => a + e.splitAmount, 0n);
    const grandTotal = totalSplit + sumSusds;
    log.log(
      `   Splits (mint): ${formatUnits(totalSplit, 18)} sUSDS over ${entries.length} markets\n` +
        `   sUSDS side   : ${formatUnits(sumSusds, 18)} sUSDS over ${allPools.length} pools\n` +
        `   GRAND TOTAL  : ${formatUnits(grandTotal, 18)} sUSDS (budget ${formatUnits(budget, 18)})`
    );
    if (grandTotal > budget) log.warn("   WARNING: grand total exceeds budget — check rounding/sentinel.");

    if (dry) return { markets: entries.length, pools: allPools.length, grandTotal: grandTotal.toString() };

    // The harness already checked the wallet against manifest.liquidity, but the
    // solved total is the number that actually gets spent.
    spend.charge(Number(formatUnits(grandTotal, 18)));

    const router = new ethers.Contract(addr.router, RouterAbi, wallet);
    const ct = await router.conditionalTokens();
    if (!ct || ct === ethers.ZeroAddress) throw new Error("Router.conditionalTokens() is zero — wrong Router?");
    log.log(`   Router.conditionalTokens() = ${ct}`);

    // sUSDS is one side of every pool and the input to every split — approve both
    // spenders ONCE for the whole programme. A per-pool approval on a shared token
    // reads an allowance the previous pool is about to spend.
    await ensureAllowance(collateral, addr.router, totalSplit, { wallet, log });
    await ensureAllowance(collateral, addr.positionManager, sumSusds, { wallet, log });

    // ── Phase 3: split + mint, market by market ───────────────────────────────
    log.log(`\nPhase 3: seeding ${allPools.length} pools across ${entries.length} markets\n`);
    let poolCount = 0;

    for (const e of entries) {
      log.log(`\n=== [${e.id}] ${e.shortName} ${e.topic} — ${e.market} ===`);

      // Splits and pool mints are logged separately so a resumed run never
      // re-splits a market whose pools only partially minted.
      if (progress.has("split", e.market.toLowerCase())) {
        log.log("  split already logged");
      } else {
        try {
          log.log(`  splitting ${formatUnits(e.splitAmount, 18)} sUSDS`);
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
          log.error(`  split failed for ${e.shortName}: ${err.shortMessage || err.message} — skipping its pools`);
          continue;
        }
        await sleep(DELAY_MS);
      }

      for (const p of e.pools) {
        const key = p.outcomeToken.toLowerCase();
        if (progress.has("pool", key)) {
          log.log(`  ${p.tag} pool already logged`);
          poolCount++;
          continue;
        }
        log.log(`\n  --- ${e.shortName} ${p.tag} @ ${p.price.toFixed(3)} (${p.outcomeToken}) ---`);
        try {
          const outcomeAmount = p.meta.isToken0Outcome ? p.amount0 : p.amount1;
          await ensureAllowance(p.outcomeToken, addr.positionManager, outcomeAmount, { wallet, log });

          const { calldata, value } = NonfungiblePositionManager.addCallParameters(p.position, {
            recipient: wallet.address,
            createPool: true, // create + initialise if needed, then mint
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
            id: e.id,
            shortName: e.shortName,
            market: e.market,
            tag: p.tag,
            label: p.label,
            outcomeToken: p.outcomeToken,
            poolAddress: p.poolAddress,
            price: p.price,
            effectivePrice: p.meta.effectivePrice,
            preExisting: p.meta.live,
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
          log.log(`  Saved to ${progress.path}`);
        } catch (err) {
          log.error(`  ${e.shortName} ${p.tag} failed: ${err.shortMessage || err.message}`);
        }
        await sleep(DELAY_MS);
      }
    }

    log.log(`\nDone. ${poolCount}/${allPools.length} pools seeded. See ${progress.path}.`);
    if (poolCount < allPools.length) {
      log.log("   Re-run with --resume to retry the failures — logged splits and pools are skipped.");
    }
    return { pools: poolCount };
  }
);
