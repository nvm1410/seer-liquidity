// Re-seed the Zcash Q3 2026 pools at NEW prices, reusing the existing position
// NFTs rather than minting new ones.
//
// WHY THIS IS NOT JUST "RUN add-zcash-liquidity.js AGAIN". A drained Uniswap V3
// pool is not a gone pool: it keeps its last sqrtPriceX96, and
// createAndInitializePoolIfNecessary is a NO-OP on it. Only a swap moves price.
// So each pool that needs re-pricing takes three transactions:
//
//   1/3 dust  a sliver of liquidity, so the pool has something to swap against
//   2/3 swap  walk the price to the target tick
//   3/3 fund  increaseLiquidity the real position at the now-correct price
//
// THE STF TRAP. The price-setting swap is paid out of the same balances the split
// produced. When it pays in the outcome token it eats into them, so the split must
// cover it or the fund step reverts STF, short by exactly the swap's input. The
// shortfall is NOT bounded by DUST_Q — it is set by the dust position's depth over
// the range traversed, and a position spanning the whole band absorbs far more as
// the price falls. SHIELDEDSCAN needed 0.036 against a DUST_Q of 0.02. Hence
// swapInputCap, computed from SqrtPriceMath over the actual range.
//
//   node reseed-zcash-liquidity.js          # dry: full per-pool plan, sends nothing
//   node reseed-zcash-liquidity.js --live   # sends, after a confirmation

import { Percent, Token } from "@uniswap/sdk-core";
import { NonfungiblePositionManager, Pool, Position, SqrtPriceMath, TickMath } from "@uniswap/v3-sdk";
import { ethers } from "ethers";
import fs from "fs";
import JSBI from "jsbi";
import { erc20Abi, formatUnits } from "viem";
import { RouterAbi } from "../../abis/RouterAbi.js";
import { assertMarket, getMarketInfo, makeMarketView, resolveOutcomeTokens } from "../../lib/market.js";
import { run } from "../../lib/run.js";
import { alignBand, priceToTick, sortTokens } from "../../lib/ticks.js";
import { ensureAllowance, retryTransaction, sleep } from "../../lib/tx.js";
import { sizePosition, POOL_MIN_ABI } from "../../lib/uniswap.js";

// Restrict to specific market ids for a targeted re-run; empty means all.
const LIMIT_TO_IDS = [];

const Q0 = 1_000n * 10n ** 18n; // trial quantity for the linear budget solve
const DUST_Q = 20n * 10n ** 15n; // 0.02 outcome tokens — just enough to swap against
const TICK_TOLERANCE = 2; // refuse to fund if the pool is further off than this
const DELAY_MS = 2000;

const SWAP_ROUTER_ADDRESS = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const SWAP_ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)",
  "function factory() external view returns (address)",
];
const POSITION_MANAGER_ABI = [
  "function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function ownerOf(uint256 tokenId) external view returns (address)",
];

/**
 * Exact token input to walk `liquidity` from one sqrt price to another, times a
 * safety multiple. Only what the swap actually consumes is transferred by the
 * SwapRouter callback, so over-supplying the cap costs nothing.
 */
function swapInputCap(sqrtFrom, sqrtTo, liquidity, zeroForOne) {
  const [lo, hi] = sqrtFrom < sqrtTo ? [sqrtFrom, sqrtTo] : [sqrtTo, sqrtFrom];
  const a = JSBI.BigInt(lo.toString());
  const b = JSBI.BigInt(hi.toString());
  const L = JSBI.BigInt(liquidity.toString());
  const exact = zeroForOne
    ? SqrtPriceMath.getAmount0Delta(a, b, L, true)
    : SqrtPriceMath.getAmount1Delta(a, b, L, true);
  const cap = BigInt(exact.toString()) * 4n;
  const floor = 10n ** 15n; // never send a cap so small that rounding stalls the walk
  return cap > floor ? cap : floor;
}

await run(
  { name: "reseed-zcash-liquidity", slug: "zcash-q3", stage: "reseed", mutating: true },
  async (ctx) => {
    const { manifest, provider, wallet, chainId, addr, amm, log, progress, dry, spend } = ctx;
    const collateral = manifest.chain.collateral.address;
    const band = manifest.liquidity.band;
    const { feeTier, tickSpacing } = amm;
    const budget = ethers.parseUnits(String(manifest.liquidity.totalCollateral), manifest.chain.collateral.decimals);

    log.log(`\n📋 Wallet   : ${wallet.address}`);
    log.log(`📋 Budget   : ${formatUnits(budget, 18)} sUSDS`);
    log.log(`📋 Range    : [${band.minPrice}, ${band.maxPrice}] sUSDS per outcome token`);
    if (LIMIT_TO_IDS.length) log.log(`📋 Limited to ids: ${LIMIT_TO_IDS.join(", ")}`);

    // ── Geometry helpers, bound to this campaign's band ───────────────────────
    // Geometry is kept separate from the Pool here, unlike the other seeders,
    // because sizing has to happen against a pool at a TARGET tick as well as at
    // the live one.
    const poolGeometry = (outcomeToken) => {
      const [t0, t1] = sortTokens(outcomeToken, collateral);
      const isToken0Outcome = t0.toLowerCase() === outcomeToken.toLowerCase();
      const { tickLower, tickUpper } = alignBand({ ...band, isToken0Outcome, spacing: tickSpacing });
      return {
        token0: new Token(chainId, t0, 18, "T0"),
        token1: new Token(chainId, t1, 18, "T1"),
        isToken0Outcome,
        tickLower,
        tickUpper,
      };
    };
    // Pool price is token1/token0: collateral/outcome when the outcome is token0,
    // else the reciprocal.
    const targetTickFor = (geom, price) => priceToTick(geom.isToken0Outcome ? price : 1 / price);
    const poolAt = (geom, tick) =>
      new Pool(geom.token0, geom.token1, feeTier, TickMath.getSqrtRatioAtTick(tick).toString(), "0", tick);
    // lib's sizePosition reads only these four fields off its meta.
    const sizeAt = (geom, pool, q) =>
      sizePosition({ pool, isToken0Outcome: geom.isToken0Outcome, tickLower: geom.tickLower, tickUpper: geom.tickUpper }, q);

    const readPool = async (address) => {
      const c = new ethers.Contract(address, POOL_MIN_ABI, provider);
      const [slot0, liquidity] = await Promise.all([c.slot0(), c.liquidity()]);
      return { sqrtPriceX96: slot0.sqrtPriceX96, tick: Number(slot0.tick), liquidity };
    };

    const swapRouter = new ethers.Contract(SWAP_ROUTER_ADDRESS, SWAP_ROUTER_ABI, wallet);
    const routerFactory = await swapRouter.factory();
    if (routerFactory.toLowerCase() !== addr.poolFactory.toLowerCase()) {
      throw new Error(`SwapRouter.factory() = ${routerFactory}, expected ${addr.poolFactory}`);
    }
    log.log(`   SwapRouter verified against V3 factory ${routerFactory}`);

    const marketsFile = manifest.files.markets;
    const proposalsFile = manifest.files.seed;
    const withdrawFile = manifest.files.withdraw;
    for (const f of [marketsFile, proposalsFile, withdrawFile]) {
      if (!f || !fs.existsSync(f)) throw new Error(`${f} not found.`);
    }
    const markets = JSON.parse(fs.readFileSync(marketsFile, "utf8"));
    const proposals = JSON.parse(fs.readFileSync(proposalsFile, "utf8")).proposals;
    const withdrawLog = JSON.parse(fs.readFileSync(withdrawFile, "utf8"));

    const priceById = new Map(proposals.map((p) => [p.id, p.yesPrice]));
    // (market, side) -> the position NFT minted for that pool the first time round.
    const tokenIdBy = new Map(withdrawLog.map((e) => [`${e.market.toLowerCase()}|${e.side}`, e.positionId]));

    // ── Phase 0: resolve markets, prices and existing positions ───────────────
    log.log(`\n🔍 Phase 0: resolving ${markets.length} markets on-chain...`);
    const marketView = makeMarketView(addr.marketView, provider);
    const positionManager = new ethers.Contract(addr.positionManager, POSITION_MANAGER_ABI, provider);

    const entries = [];
    for (const m of markets) {
      if (LIMIT_TO_IDS.length && !LIMIT_TO_IDS.includes(m.id)) continue;

      const yesPrice = priceById.get(m.id);
      if (yesPrice === undefined) throw new Error(`[${m.shortName}] id ${m.id} missing from ${proposalsFile}`);
      for (const p of [yesPrice, 1 - yesPrice]) {
        if (!(p > band.minPrice && p < band.maxPrice)) {
          throw new Error(`[${m.shortName}] price ${p} outside the pool band (${band.minPrice}, ${band.maxPrice}).`);
        }
      }

      const info = await getMarketInfo(marketView, addr.marketFactory, m.market);
      await assertMarket(info, {
        label: `[${m.shortName}]`,
        collateral,
        topLevel: true,
        outcomes: ["Yes", "No"],
        questionCount: 1,
        loggedWrappedTokens: m.wrappedTokens,
        requireCode: 2,
        provider,
      });
      const { outcomeTokens } = resolveOutcomeTokens(info, { expectedCount: 2 });

      const pools = [
        { side: "YES", outcomeToken: outcomeTokens[0], price: yesPrice },
        { side: "NO", outcomeToken: outcomeTokens[1], price: 1 - yesPrice },
      ];

      for (const p of pools) {
        p.geom = poolGeometry(p.outcomeToken);
        p.targetTick = targetTickFor(p.geom, p.price);
        p.poolAddress = Pool.getAddress(p.geom.token0, p.geom.token1, feeTier);

        const tokenId = tokenIdBy.get(`${m.market.toLowerCase()}|${p.side}`);
        if (tokenId === undefined) throw new Error(`[${m.shortName} ${p.side}] no position NFT in ${withdrawFile}`);
        p.tokenId = tokenId;

        const [onChain, owner, live] = await Promise.all([
          positionManager.positions(tokenId),
          positionManager.ownerOf(tokenId),
          readPool(p.poolAddress),
        ]);
        if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
          throw new Error(`[${m.shortName} ${p.side}] position #${tokenId} is owned by ${owner}, not this wallet`);
        }
        if (Number(onChain.tickLower) !== p.geom.tickLower || Number(onChain.tickUpper) !== p.geom.tickUpper) {
          throw new Error(
            `[${m.shortName} ${p.side}] position #${tokenId} band [${onChain.tickLower},${onChain.tickUpper}] ` +
              `!= computed [${p.geom.tickLower},${p.geom.tickUpper}]`
          );
        }
        p.existingLiquidity = onChain.liquidity;
        p.live = live;
      }

      entries.push({ ...m, yesPrice, pools });
    }
    log.log(`   ✅ ${entries.length} markets verified; ${entries.length * 2} pools + position NFTs matched`);

    // ── Phase 1: size every position at the NEW prices ────────────────────────
    log.log("\n📐 Phase 1: sizing positions at the new prices...");
    const budgetPerMarket = budget / BigInt(entries.length);
    log.log(`   Budget per market: ${formatUnits(budgetPerMarket, 18)} sUSDS`);

    for (const e of entries) {
      let trialSusds = 0n;
      for (const p of e.pools) {
        p.targetPool = poolAt(p.geom, p.targetTick);
        trialSusds += sizeAt(p.geom, p.targetPool, Q0).collateralUsed;
      }
      e.Q = (Q0 * budgetPerMarket) / (Q0 + trialSusds);
      if (e.Q === 0n) throw new Error(`[${e.shortName}] solved Q is zero — raise the budget.`);
    }

    let sumSusds = 0n;
    let sumDustSusds = 0n;
    let repriceCount = 0;
    log.log("\n    #  shortName        side  price   now→target        move    outcome       sUSDS    mkt total");

    for (const e of entries) {
      e.splitAmount = 0n;
      e.capital = 0n;
      for (const p of e.pools) {
        const s = sizeAt(p.geom, p.targetPool, e.Q);
        p.sized = s;

        // The sliver is priced against the pool as it stands NOW, not at the target.
        p.dust = sizeAt(p.geom, poolAt(p.geom, p.live.tick), DUST_Q);
        p.needsReprice = p.live.tick !== p.targetTick;
        if (p.needsReprice) repriceCount++;

        // See the STF note in the header: the swap's input has to come out of the
        // split, and it is bounded by the traversed range, not by DUST_Q.
        p.swapOutcomeCost = 0n;
        p.swapSusdsCost = 0n;
        if (p.needsReprice) {
          const curSqrt = BigInt(TickMath.getSqrtRatioAtTick(p.live.tick).toString());
          const tgtSqrt = BigInt(TickMath.getSqrtRatioAtTick(p.targetTick).toString());
          const zeroForOne = tgtSqrt < curSqrt;
          const cap = swapInputCap(curSqrt, tgtSqrt, p.dust.position.liquidity.toString(), zeroForOne);
          if (zeroForOne === p.geom.isToken0Outcome) p.swapOutcomeCost = cap;
          else p.swapSusdsCost = cap;
        }

        const outcomeNeeded = s.outcomeUsed + (p.needsReprice ? p.dust.outcomeUsed + p.swapOutcomeCost : 0n);
        const susdsNeeded = s.collateralUsed + (p.needsReprice ? p.dust.collateralUsed + p.swapSusdsCost : 0n);
        sumSusds += s.collateralUsed;
        if (p.needsReprice) sumDustSusds += p.dust.collateralUsed + p.swapSusdsCost;
        e.capital += susdsNeeded;
        if (outcomeNeeded > e.splitAmount) e.splitAmount = outcomeNeeded;

        const dir = !p.needsReprice
          ? "—"
          : (p.targetTick < p.live.tick) === p.geom.isToken0Outcome
            ? "sell outcome"
            : "buy outcome";
        log.log(
          `   ${String(e.id).padStart(2)}  ${e.shortName.padEnd(15)} ${p.side.padEnd(4)} ` +
            `${p.price.toFixed(3)}  ${String(p.live.tick).padStart(6)}→${String(p.targetTick).padStart(6)}  ` +
            `${dir.padEnd(12)}` +
            `${Number(formatUnits(outcomeNeeded, 18)).toFixed(2).padStart(11)}` +
            `${Number(formatUnits(susdsNeeded, 18)).toFixed(2).padStart(12)}` +
            (p.side === "NO" ? `${Number(formatUnits(e.capital, 18)).toFixed(2).padStart(13)}` : "")
        );
      }
      e.capital += e.splitAmount;
    }

    const totalSplit = entries.reduce((a, e) => a + e.splitAmount, 0n);
    const grandTotal = totalSplit + sumSusds + sumDustSusds;
    log.log(
      `\n   Pools needing a reprice: ${repriceCount}/${entries.length * 2}\n` +
        `   Splits (mint): ${formatUnits(totalSplit, 18)} sUSDS over ${entries.length} markets\n` +
        `   sUSDS side   : ${formatUnits(sumSusds, 18)} sUSDS over ${entries.length * 2} pools\n` +
        `   price slivers: ${formatUnits(sumDustSusds, 18)} sUSDS (stays in the positions)\n` +
        `   GRAND TOTAL  : ${formatUnits(grandTotal, 18)} sUSDS (budget ${formatUnits(budget, 18)})`
    );

    // Third-party liquidity turns the swap from a dust move into a real trade.
    for (const e of entries) {
      for (const p of e.pools) {
        if (p.needsReprice && p.live.liquidity > p.existingLiquidity) {
          log.warn(
            `   ⚠️  [${e.shortName} ${p.side}] pool liquidity ${p.live.liquidity} exceeds our position ` +
              `${p.existingLiquidity} — someone else has LP'd; the swap would trade against real depth.`
          );
        }
      }
    }

    if (dry) return { pools: entries.length * 2, repriceCount, grandTotal: grandTotal.toString() };

    spend.charge(Number(formatUnits(grandTotal, 18)));

    // ── Phase 2: balance guard and approvals ──────────────────────────────────
    const susds = new ethers.Contract(collateral, erc20Abi, provider);
    const susdsBalance = await susds.balanceOf(wallet.address);
    log.log(`\n💰 sUSDS balance: ${formatUnits(susdsBalance, 18)} | need: ${formatUnits(grandTotal, 18)}`);
    if (susdsBalance < grandTotal) throw new Error("Insufficient sUSDS balance — aborting.");

    const seerRouter = new ethers.Contract(addr.router, RouterAbi, wallet);
    const ct = await seerRouter.conditionalTokens();
    if (!ct || ct === ethers.ZeroAddress) throw new Error("Router.conditionalTokens() is zero — wrong Router?");

    await ensureAllowance(collateral, addr.router, totalSplit, { wallet, log });
    await ensureAllowance(collateral, addr.positionManager, sumSusds + sumDustSusds, { wallet, log });
    await ensureAllowance(collateral, SWAP_ROUTER_ADDRESS, ethers.MaxUint256 / 2n, { wallet, log });

    // Splits and funded pools are the only things worth skipping on a resume. The
    // dust and swap steps are decided from LIVE CHAIN STATE instead, so a run that
    // died between them self-heals rather than trusting the log.
    log.log(`\n📈 Phase 3: re-seeding ${entries.length * 2} pools across ${entries.length} markets\n`);
    let fundedCount = 0;

    for (const e of entries) {
      log.log(`\n=== [${e.id}] ${e.shortName} — ${e.market} ===`);

      if (progress.has("split", e.market.toLowerCase())) {
        log.log(`  ⏭  split already logged`);
      } else {
        try {
          log.log(`  💧 splitting ${formatUnits(e.splitAmount, 18)} sUSDS`);
          const receipt = await retryTransaction(
            () => seerRouter.splitPosition(collateral, e.market, e.splitAmount),
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
        const fundKey = p.outcomeToken.toLowerCase();
        if (progress.has("fund", fundKey)) {
          log.log(`  ⏭  ${p.side} pool already funded`);
          fundedCount++;
          continue;
        }
        log.log(`\n  --- ${e.shortName} ${p.side} → ${p.price.toFixed(3)} (#${p.tokenId}) ---`);
        try {
          let live = await readPool(p.poolAddress);

          // Steps 1 + 2: move the pool onto the target price, if it is not there.
          if (live.tick !== p.targetTick) {
            if (live.liquidity === 0n) {
              log.log(
                `    1/3 dust: ${formatUnits(p.dust.outcomeUsed, 18)} outcome + ` +
                  `${formatUnits(p.dust.collateralUsed, 18)} sUSDS`
              );
              await ensureAllowance(
                p.outcomeToken,
                addr.positionManager,
                p.dust.outcomeUsed + p.sized.outcomeUsed,
                { wallet, log }
              );
              const dustPos = sizeAt(p.geom, poolAt(p.geom, live.tick), DUST_Q).position;
              const { calldata, value } = NonfungiblePositionManager.addCallParameters(dustPos, {
                tokenId: p.tokenId.toString(), // increaseLiquidity, not mint
                slippageTolerance: new Percent(50, 10_000),
                deadline: Math.floor(Date.now() / 1000) + 60 * 20,
              });
              const receipt = await retryTransaction(
                () => wallet.sendTransaction({ to: addr.positionManager, data: calldata, value }),
                { log }
              );
              progress.append({
                kind: "dust",
                key: `${fundKey}|${live.tick}`,
                id: e.id,
                shortName: e.shortName,
                market: e.market,
                side: p.side,
                outcomeToken: p.outcomeToken,
                tokenId: p.tokenId.toString(),
                txHash: receipt.hash,
                blockNumber: receipt.blockNumber,
              });
              await sleep(DELAY_MS);
              live = await readPool(p.poolAddress);
            } else {
              log.log(`    1/3 dust: skipped — pool already has liquidity ${live.liquidity}`);
            }

            const targetSqrt = BigInt(TickMath.getSqrtRatioAtTick(p.targetTick).toString());
            if (targetSqrt === BigInt(live.sqrtPriceX96)) {
              throw new Error(`pool is already at the target sqrt price but reports tick ${live.tick} — inspect manually`);
            }
            if (live.liquidity === 0n) throw new Error("pool still has zero liquidity after the dust step — a swap would revert");

            const zeroForOne = targetSqrt < BigInt(live.sqrtPriceX96);
            const tokenIn = zeroForOne ? p.geom.token0.address : p.geom.token1.address;
            const tokenOut = zeroForOne ? p.geom.token1.address : p.geom.token0.address;
            const amountIn = swapInputCap(BigInt(live.sqrtPriceX96), targetSqrt, live.liquidity, zeroForOne);

            log.log(
              `    2/3 swap: tick ${live.tick} → ${p.targetTick}, ` +
                `in ${tokenIn.toLowerCase() === collateral.toLowerCase() ? "sUSDS" : "outcome"} cap ${formatUnits(amountIn, 18)}`
            );
            await ensureAllowance(tokenIn, SWAP_ROUTER_ADDRESS, amountIn, { wallet, log });
            const swapReceipt = await retryTransaction(
              () =>
                swapRouter.exactInputSingle({
                  tokenIn,
                  tokenOut,
                  fee: feeTier,
                  recipient: wallet.address,
                  deadline: Math.floor(Date.now() / 1000) + 60 * 20,
                  amountIn,
                  amountOutMinimum: 0n,
                  sqrtPriceLimitX96: targetSqrt,
                }),
              { log }
            );
            progress.append({
              kind: "swap",
              key: `${fundKey}|${live.tick}->${p.targetTick}`,
              id: e.id,
              shortName: e.shortName,
              market: e.market,
              side: p.side,
              outcomeToken: p.outcomeToken,
              fromTick: live.tick,
              toTick: p.targetTick,
              tokenIn,
              amountInCap: amountIn.toString(),
              txHash: swapReceipt.hash,
              blockNumber: swapReceipt.blockNumber,
            });
            await sleep(DELAY_MS);
            live = await readPool(p.poolAddress);
          }

          // Step 3: fund the real position against the LIVE price.
          if (Math.abs(live.tick - p.targetTick) > TICK_TOLERANCE) {
            throw new Error(`pool is at tick ${live.tick}, target ${p.targetTick} (tolerance ${TICK_TOLERANCE}) — not funding`);
          }

          // Size from what the wallet actually HOLDS. A market split before the
          // swap headroom existed is short by the swap's input, and a re-run must
          // not re-split it — so fall back to the live balance rather than
          // reverting STF.
          let fundQ = e.Q;
          const outcomeBal = await new ethers.Contract(p.outcomeToken, erc20Abi, provider).balanceOf(wallet.address);
          let fundSized = sizeAt(p.geom, poolAt(p.geom, live.tick), fundQ);
          if (outcomeBal < fundSized.outcomeUsed) {
            fundQ = (outcomeBal * 9999n) / 10_000n; // haircut so rounding cannot re-cross the balance
            fundSized = sizeAt(p.geom, poolAt(p.geom, live.tick), fundQ);
            log.log(
              `    ⚠️  outcome balance ${formatUnits(outcomeBal, 18)} < planned ` +
                `${formatUnits(e.Q, 18)} — sizing from balance instead`
            );
            if (fundSized.outcomeUsed === 0n) throw new Error("no outcome tokens left to fund with");
          }
          log.log(
            `    3/3 fund: ${formatUnits(fundSized.outcomeUsed, 18)} outcome + ` +
              `${formatUnits(fundSized.collateralUsed, 18)} sUSDS at tick ${live.tick}`
          );
          await ensureAllowance(p.outcomeToken, addr.positionManager, fundSized.outcomeUsed, { wallet, log });
          const { calldata, value } = NonfungiblePositionManager.addCallParameters(fundSized.position, {
            tokenId: p.tokenId.toString(),
            slippageTolerance: new Percent(50, 10_000),
            deadline: Math.floor(Date.now() / 1000) + 60 * 20,
          });
          const receipt = await retryTransaction(
            () => wallet.sendTransaction({ to: addr.positionManager, data: calldata, value }),
            { log }
          );
          progress.append({
            kind: "fund",
            key: fundKey,
            id: e.id,
            shortName: e.shortName,
            market: e.market,
            side: p.side,
            outcomeToken: p.outcomeToken,
            tokenId: p.tokenId.toString(),
            price: p.price,
            tick: live.tick,
            tickLower: p.geom.tickLower,
            tickUpper: p.geom.tickUpper,
            amount0: fundSized.amount0.toString(),
            amount1: fundSized.amount1.toString(),
            outcomeUsed: fundSized.outcomeUsed.toString(),
            susdsUsed: fundSized.collateralUsed.toString(),
            txHash: receipt.hash,
            blockNumber: receipt.blockNumber,
          });
          fundedCount++;
          log.log(`  ✅ ${e.shortName} ${p.side} re-seeded at ${p.price.toFixed(3)}`);
        } catch (err) {
          log.error(`  ❌ ${e.shortName} ${p.side} failed: ${err.shortMessage || err.message}`);
        }
        await sleep(DELAY_MS);
      }
    }

    log.log(`\n🎉 Done! ${fundedCount}/${entries.length * 2} pools re-seeded. See ${progress.path}.`);
    if (fundedCount < entries.length * 2) {
      log.log("   Re-run with --resume to retry the failures — logged splits and funded pools are skipped.");
    }
    log.log("   Verify with: node check-zcash-pools.js");
    return { reseeded: fundedCount };
  }
);
