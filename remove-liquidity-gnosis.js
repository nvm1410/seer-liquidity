// Drain a Gnosis PD market: remove 100% of every Swapr position, then merge the
// complete outcome set back into sDAI.
//
// Swapr is Algebra V1, not Uniswap V3. Its NPM has no fee field anywhere,
// positions() returns eleven values rather than twelve, pool addresses are CREATE2
// from the POOL DEPLOYER with a two-address salt, and the Uniswap SDK's calldata
// builders are unusable — only its Pool/Position math is reused, and every call is
// hand-encoded through multicall. See lib/algebra.js.
//
// The merge is capped by the SMALLEST holding in the set. A dry run of v1 once
// projected a perfectly balanced set with zero dust; six weeks of trading broke
// that, and the real merge returned 0.784 sDAI rather than ~5.6. Budget for this:
// recoverable cash is far below deployed capital once a market has traded.
//
//   node remove-liquidity-gnosis.js                    # dry, targets the live market
//   node remove-liquidity-gnosis.js --market=0x...     # target a specific market
//   node remove-liquidity-gnosis.js --live             # sends, after a confirmation
//
// The market now DEFAULTS to the manifest's live market rather than a hardcoded
// address. The old default was v1 (0x7d386b...), which was fully drained on
// 2026-08-12 to fund v2 — so the script as written could only ever re-drain
// something empty. Use --market to target it again.

import { Percent } from "@uniswap/sdk-core";
import { ethers } from "ethers";
import { erc20Abi, formatUnits } from "viem";
import { RouterAbi } from "./abis/RouterAbi.js";
import {
  ALGEBRA_NPM_ABI,
  buildRemoveCalldata,
  buildSdkPosition,
  readLivePool,
} from "./lib/algebra.js";
import { getMarketInfo, makeMarketView } from "./lib/market.js";
import { fromCurrencyAmount } from "./lib/positions.js";
import { run } from "./lib/run.js";
import { bmin, readBalances } from "./lib/settle.js";
import { ensureAllowance, retryTransaction, sleep } from "./lib/tx.js";

const DELAY_MS = 2000;

await run(
  { name: "remove-liquidity-gnosis", slug: "gnosis-pd", stage: "unwind", mutating: true },
  async (ctx) => {
    const { manifest, provider, wallet, chainId, addr, amm, args, log, progress, dry } = ctx;
    const collateral = manifest.chain.collateral.address;
    const owner = wallet.address;
    const market = args.opts.market ?? manifest.results?.parent;
    if (!market) throw new Error("no market: pass --market=0x... or set results.parent in the manifest");
    const burnNft = manifest.unwind?.burnNft ?? true;

    log.log(`\n📋 Wallet   : ${owner}`);
    log.log(`📋 Market   : ${market}`);
    log.log(`📋 BURN_NFT : ${burnNft}\n`);

    // ── Phase 0: resolve the market's full outcome set ────────────────────────
    log.log("🔍 Phase 0: resolving market outcomes...");
    const marketView = makeMarketView(addr.marketView, provider);
    const info = await getMarketInfo(marketView, addr.marketFactory, market);
    const { outcomes, wrappedTokens } = info;
    const nameByToken = new Map(wrappedTokens.map((t, i) => [t.toLowerCase(), outcomes[i]]));
    const known = new Set(wrappedTokens.map((t) => t.toLowerCase()));
    log.log(`   Market has ${wrappedTokens.length} outcomes (full set, incl. "Invalid result")`);

    // ── Phase 1a: enumerate every Algebra NPM position for this market ────────
    log.log("\n🔎 Phase 1a: enumerating wallet's Swapr NPM positions...");
    const npm = new ethers.Contract(addr.positionManager, ALGEBRA_NPM_ABI, wallet);
    const balance = await npm.balanceOf(owner);
    const tokenIds = [];
    for (let i = 0n; i < balance; i++) tokenIds.push(await npm.tokenOfOwnerByIndex(owner, i));
    log.log(`   Wallet owns ${tokenIds.length} NPM position NFTs total`);

    const matched = [];
    for (const tokenId of tokenIds) {
      const pos = await npm.positions(tokenId); // ELEVEN values — no fee field
      const t0 = pos.token0.toLowerCase();
      const t1 = pos.token1.toLowerCase();
      const isPair =
        (t0 === collateral.toLowerCase() && known.has(t1)) || (t1 === collateral.toLowerCase() && known.has(t0));
      if (!isPair) continue;
      const outcomeToken = t0 === collateral.toLowerCase() ? pos.token1 : pos.token0;
      matched.push({
        tokenId,
        token0: pos.token0,
        token1: pos.token1,
        tickLower: Number(pos.tickLower),
        tickUpper: Number(pos.tickUpper),
        liquidity: pos.liquidity,
        outcomeToken,
        name: nameByToken.get(outcomeToken.toLowerCase()) ?? outcomeToken,
      });
    }
    const withLiquidity = matched.filter((p) => p.liquidity > 0n);
    log.log(
      `   Matched ${matched.length} positions for this market | ` +
        `${withLiquidity.length} have liquidity > 0 (rest already emptied)`
    );

    // ── Phase 1b: remove 100% liquidity from each ─────────────────────────────
    log.log("\n📉 Phase 1b: removing 100% liquidity from each position\n");

    const withdrawByToken = new Map();
    const addWithdraw = (a, amt) =>
      withdrawByToken.set(a.toLowerCase(), (withdrawByToken.get(a.toLowerCase()) ?? 0n) + amt);

    // One pool read per outcome token, shared by every position on that pool.
    const poolCache = new Map();
    const livePoolFor = async (outcomeToken) => {
      const key = outcomeToken.toLowerCase();
      if (!poolCache.has(key)) {
        poolCache.set(
          key,
          await readLivePool(outcomeToken, collateral, {
            provider,
            chainId,
            poolDeployer: addr.poolFactory,
            mathFeeTier: amm.mathFeeTier,
          })
        );
      }
      return poolCache.get(key);
    };

    let removedCount = 0;
    for (const p of withLiquidity) {
      if (progress.has("remove", String(p.tokenId))) {
        removedCount++;
        continue;
      }
      const { pool } = await livePoolFor(p.outcomeToken);
      if (!pool) throw new Error(`pool for ${p.name} does not exist on chain`);
      const position = buildSdkPosition(p, pool);

      // position.amount0/1 are CurrencyAmount -> .quotient. The slippage variants
      // are raw JSBI -> .toString(). buildRemoveCalldata handles the latter.
      const expected0 = fromCurrencyAmount(position.amount0);
      const expected1 = fromCurrencyAmount(position.amount1);
      addWithdraw(p.token0, expected0);
      addWithdraw(p.token1, expected1);

      log.log(
        `  #${p.tokenId} (${p.name}): liquidity=${p.liquidity.toString()} → ` +
          `~${formatUnits(expected0, 18)} / ~${formatUnits(expected1, 18)}`
      );

      if (!dry) {
        const data = buildRemoveCalldata({
          tokenId: p.tokenId,
          position,
          recipient: owner,
          burnNft,
        });
        const receipt = await retryTransaction(
          () => wallet.sendTransaction({ to: addr.positionManager, data, value: 0n }),
          { log }
        );
        progress.append({
          kind: "remove",
          key: String(p.tokenId),
          tokenId: p.tokenId.toString(),
          name: p.name,
          token0: p.token0,
          token1: p.token1,
          removedLiquidity: p.liquidity.toString(),
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
        });
        await sleep(DELAY_MS);
      }
      removedCount++;
    }
    log.log(`\n   Removed/queued: ${removedCount}/${withLiquidity.length}`);

    // ── Phase 2: merge the complete set back into sDAI ────────────────────────
    // Dry run projects (current + what the removals would return); live reads chain.
    const current = await readBalances(wrappedTokens, { provider, owner });
    const bals = current.map((b, i) => (dry ? b + (withdrawByToken.get(wrappedTokens[i].toLowerCase()) ?? 0n) : b));

    log.log(`\n🔗 Phase 2: merge full outcome set (${wrappedTokens.length} incl. Invalid) → sDAI`);
    const mergeAmount = bmin(bals);
    const zeroOutcomes = bals.filter((b) => b === 0n).length;
    log.log(
      `   min outcome balance = ${formatUnits(mergeAmount, 18)} | outcomes at zero: ${zeroOutcomes}\n` +
        bals.map((b, i) => `     ${outcomes[i].padEnd(16)} ${formatUnits(b, 18)}`).join("\n")
    );

    if (mergeAmount === 0n) {
      log.log("\n   ⚠️  at least one outcome is zero — cannot merge to sDAI (check balances above).");
    } else if (!dry) {
      for (const t of wrappedTokens) await ensureAllowance(t, addr.router, mergeAmount, { wallet, log });
      const router = new ethers.Contract(addr.router, RouterAbi, wallet);
      await retryTransaction(() => router.mergePositions(collateral, market, mergeAmount), { log });
      log.log(`   ✅ recovered ≈ ${formatUnits(mergeAmount, 18)} sDAI`);
    } else {
      log.log(`   ✅ would recover ≈ ${formatUnits(mergeAmount, 18)} sDAI`);
    }

    log.log(
      `\n🎉 Done.` +
        (dry
          ? " Dry run.\n   (Amounts are projections; leftover dust from imbalanced sets stays in the wallet.)"
          : ` Removals logged to ${progress.path}.`)
    );
    return { matched: matched.length, removed: removedCount, mergeAmount: mergeAmount.toString() };
  }
);
