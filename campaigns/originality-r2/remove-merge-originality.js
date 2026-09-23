// Unwinds ALL originality round-2 liquidity and reconstitutes sUSDS:
//   Phase 1 — remove 100% liquidity from every originality position (Up/Down vs
//             parent-outcome pools) → tokens come back to the wallet.
//   Phase 2 — for each repo, merge a full child set {Down, Up, Invalid} back into
//             that repo's parent-outcome token (Router.mergePositions on the child).
//   Phase 3 — merge the full parent set {all repo outcomes + parent Invalid} back
//             into sUSDS (Router.mergePositions on the parent market).
//
// Merging always needs a COMPLETE set including the Invalid outcome (never pooled but
// minted during the original split and held in the wallet) — see src/Router.sol
// _mergePositions / getPartition. Mergeable amount each step = min balance across the
// set; leftover/imbalance dust stays in the wallet. This is why the round-2 unwind
// stranded 8,300.58 sUSDS: ONE parent outcome (index 63, EIPS) sits at zero and blocks
// phase 3 entirely.
//
// Child-first is not a preference. A child merge MINTS the parent-outcome token that
// phase 3 then needs, so the parent set is short until every child has merged.
//
//   node remove-merge-originality.js --resume          # dry: full projection, sends nothing
//   node remove-merge-originality.js --resume --live   # sends, after a confirmation

import { CurrencyAmount, Percent, Token } from "@uniswap/sdk-core";
import { NonfungiblePositionManager, Position } from "@uniswap/v3-sdk";
import { ethers } from "ethers";
import fs from "fs";
import { erc20Abi, formatUnits } from "viem";
import { RouterAbi } from "../../abis/RouterAbi.js";
import { getMarketInfo, makeMarketView } from "../../lib/market.js";
import { buildPoolFor, POSITION_MANAGER_ABI } from "../../lib/positions.js";
import { run } from "../../lib/run.js";
import { bmin } from "../../lib/settle.js";
import { pairKey, sortTokens } from "../../lib/ticks.js";
import { ensureAllowance, retryTransaction, sleep } from "../../lib/tx.js";
import { markets } from "./markets.js";

await run(
  {
    name: "remove-merge-originality",
    slug: "originality-r2",
    stage: "unwind-remove-merge",
    mutating: true,
    progress: (m) => m.files.unwind,
  },
  async (ctx) => {
    const { manifest, provider, wallet, chainId, addr, log, progress, dry: DRY_RUN } = ctx;

    const COLLATERAL = manifest.chain.collateral.address;
    const PARENT_MARKET_ADDRESS = manifest.results.parent;
    const BURN_NFT = manifest.unwind?.burnNft ?? false;
    const ADD_BACK_FILE = manifest.files.addBack; // pool → positionId source
    const MAP_CACHE_FILE = manifest.files.mergeCache; // resolved map (with Invalid)

    log.log(`\n📋 Wallet : ${wallet.address}`);
    log.log(`📋 DRY_RUN : ${DRY_RUN}  |  BURN_NFT: ${BURN_NFT}\n`);

    const positionManager = new ethers.Contract(addr.positionManager, POSITION_MANAGER_ABI, provider);
    const marketView = makeMarketView(addr.marketView, provider);
    const router = new ethers.Contract(addr.router, RouterAbi, wallet);
    const getTokenBalance = (token) => new ethers.Contract(token, erc20Abi, provider).balanceOf(wallet.address);

    // ── Phase 0: resolve repos + parent set (cached) ─────────────────────────
    let parentWrappedTokens; // full parent outcome list incl. Invalid
    let repos; // [{ childMarket, parentOutcomeToken, wrappedTokens(full), positions[] }]

    if (fs.existsSync(MAP_CACHE_FILE)) {
      const cache = JSON.parse(fs.readFileSync(MAP_CACHE_FILE, "utf8"));
      parentWrappedTokens = cache.parentWrappedTokens;
      repos = cache.repos;
      log.log(`🔍 Phase 0: loaded map from cache ${MAP_CACHE_FILE} (delete to re-resolve)`);
    } else {
      log.log("🔍 Phase 0: resolving markets (this queries ~98 markets)...");
      const parent = await getMarketInfo(marketView, addr.marketFactory, PARENT_MARKET_ADDRESS);
      parentWrappedTokens = parent.wrappedTokens;

      const addBack = JSON.parse(fs.readFileSync(ADD_BACK_FILE, "utf8"));
      const poolToPosition = new Map();
      for (const e of addBack) {
        const [a, b] = sortTokens(e.token0, e.token1);
        poolToPosition.set(pairKey(a, b), { positionId: e.positionId, token0: a, token1: b });
      }

      repos = [];
      for (const m of markets) {
        const info = await getMarketInfo(marketView, addr.marketFactory, m.marketId);
        if (!info.parentMarketAddress || info.parentOutcomeToken === undefined) continue;
        if (info.parentMarketAddress.toLowerCase() !== PARENT_MARKET_ADDRESS.toLowerCase()) continue;

        const positions = [];
        for (const outcome of info.wrappedTokens.slice(0, -1)) {
          const pos = poolToPosition.get(pairKey(outcome, info.parentOutcomeToken));
          if (pos) positions.push(pos);
        }
        if (positions.length === 0) continue;
        repos.push({
          childMarket: m.marketId,
          parentOutcomeToken: info.parentOutcomeToken,
          wrappedTokens: info.wrappedTokens, // [Down, Up, Invalid]
          positions,
        });
      }
      fs.writeFileSync(MAP_CACHE_FILE, JSON.stringify({ parentWrappedTokens, repos }, null, 2));
      log.log(`   Cached map → ${MAP_CACHE_FILE}`);
    }

    const totalPositions = repos.reduce((n, r) => n + r.positions.length, 0);
    log.log(`   Repos: ${repos.length} | positions: ${totalPositions} | parent outcomes: ${parentWrappedTokens.length}\n`);

    // ── Phase 1: remove 100% liquidity ───────────────────────────────────────
    log.log("📉 Phase 1: remove 100% liquidity from every originality position\n");

    // The historical entries carry positionId with no kind/key, so key off positionId.
    const alreadyRemoved = new Set(progress.entries.map((e) => String(e.positionId)));

    const withdraw = new Map(); // lowercased token → projected amount returned (dry-run preview)
    const addWithdraw = (token, amt) =>
      withdraw.set(token.toLowerCase(), (withdraw.get(token.toLowerCase()) ?? 0n) + amt);

    let removed = 0;
    let skippedEmpty = 0;
    for (const r of repos) {
      for (const p of r.positions) {
        if (alreadyRemoved.has(String(p.positionId))) {
          removed++;
          continue;
        }
        const pos = await positionManager.positions(BigInt(p.positionId));
        if (pos.liquidity === 0n) {
          skippedEmpty++;
          continue;
        }

        const { pool } = await buildPoolFor(pos, { provider, chainId });
        const token0 = new Token(chainId, p.token0, 18, "T0");
        const token1 = new Token(chainId, p.token1, 18, "T1");
        const sdkPosition = new Position({
          pool,
          liquidity: pos.liquidity.toString(),
          tickLower: Number(pos.tickLower),
          tickUpper: Number(pos.tickUpper),
        });

        // projected tokens returned (principal) for the dry-run merge preview
        const out0 = BigInt(sdkPosition.amount0.quotient.toString());
        const out1 = BigInt(sdkPosition.amount1.quotient.toString());
        addWithdraw(p.token0, out0);
        addWithdraw(p.token1, out1);

        log.log(
          `  #${p.positionId}: liquidity=${formatUnits(pos.liquidity, 18)} → ~${formatUnits(out0, 18)} / ~${formatUnits(out1, 18)}`
        );

        if (!DRY_RUN) {
          const removeOptions = {
            deadline: Math.floor(Date.now() / 1000) + 60 * 20,
            slippageTolerance: new Percent(50, 10_000), // 0.5%
            tokenId: p.positionId.toString(),
            liquidityPercentage: new Percent(1, 1), // 100%
            collectOptions: {
              expectedCurrencyOwed0: CurrencyAmount.fromRawAmount(token0, 0),
              expectedCurrencyOwed1: CurrencyAmount.fromRawAmount(token1, 0),
              recipient: wallet.address,
            },
            ...(BURN_NFT ? { burnToken: true } : {}),
          };
          const { calldata, value } = NonfungiblePositionManager.removeCallParameters(sdkPosition, removeOptions);
          const receipt = await retryTransaction(
            () => wallet.sendTransaction({ to: addr.positionManager, data: calldata, value }),
            { log }
          );
          progress.append({
            positionId: p.positionId,
            kind: "remove",
            key: String(p.positionId),
            token0: p.token0,
            token1: p.token1,
            removedLiquidity: pos.liquidity.toString(),
            txHash: receipt.hash,
            blockNumber: receipt.blockNumber,
          });
          await sleep(2000);
        }
        removed++;
      }
    }
    log.log(`\n   Removed/queued: ${removed} | already-empty skipped: ${skippedEmpty}`);

    // ── Balance model: dry run projects (current + withdrawn); live reads chain.
    const proj = new Map(); // lowercased → BigInt (dry-run only)
    if (DRY_RUN) {
      const all = new Set();
      for (const r of repos) for (const t of r.wrappedTokens) all.add(t.toLowerCase());
      for (const t of parentWrappedTokens) all.add(t.toLowerCase());
      for (const t of all) {
        const cur = await getTokenBalance(t);
        proj.set(t, cur + (withdraw.get(t) ?? 0n));
      }
    }
    const effBal = async (token) => (DRY_RUN ? proj.get(token.toLowerCase()) ?? 0n : getTokenBalance(token));

    // ── Phase 2: merge each child set {Down, Up, Invalid} → parent outcome ────
    log.log(`\n🔗 Phase 2: merge child sets back into parent-outcome tokens`);
    let childMerges = 0;
    for (const r of repos) {
      const set = r.wrappedTokens; // [Down, Up, Invalid]
      const bals = await Promise.all(set.map(effBal));
      const amount = bmin(bals);
      log.log(
        `  ${r.childMarket}: min set balance = ${formatUnits(amount, 18)}` +
          ` (D=${formatUnits(bals[0], 18)} U=${formatUnits(bals[1], 18)} Inv=${formatUnits(bals[2], 18)})`
      );
      if (amount === 0n) {
        log.log("     ⚠️  one outcome is zero — cannot merge this repo");
        continue;
      }
      if (!DRY_RUN) {
        for (const t of set) await ensureAllowance(t, addr.router, amount, { wallet, log });
        await retryTransaction(() => router.mergePositions(COLLATERAL, r.childMarket, amount), { log });
        await sleep(2000);
      } else {
        // project: burn the set, mint parent-outcome token
        for (const t of set) proj.set(t.toLowerCase(), (proj.get(t.toLowerCase()) ?? 0n) - amount);
        const k = r.parentOutcomeToken.toLowerCase();
        proj.set(k, (proj.get(k) ?? 0n) + amount);
      }
      childMerges++;
    }
    log.log(`   Child merges: ${childMerges}/${repos.length}`);

    // ── Phase 3: merge full parent set → sUSDS ───────────────────────────────
    log.log(`\n🔗 Phase 3: merge full parent set (${parentWrappedTokens.length} outcomes incl. Invalid) → sUSDS`);
    const parentBals = await Promise.all(parentWrappedTokens.map(effBal));
    const parentAmount = bmin(parentBals);
    const zeroOutcomes = parentBals.filter((b) => b === 0n).length;
    log.log(`   min parent-outcome balance = ${formatUnits(parentAmount, 18)} | outcomes at zero: ${zeroOutcomes}`);
    if (parentAmount === 0n) {
      log.log("   ⚠️  at least one parent outcome is zero — cannot merge to sUSDS (check balances above).");
    } else {
      if (!DRY_RUN) {
        for (const t of parentWrappedTokens) await ensureAllowance(t, addr.router, parentAmount, { wallet, log });
        await retryTransaction(() => router.mergePositions(COLLATERAL, PARENT_MARKET_ADDRESS, parentAmount), { log });
      }
      log.log(`   ✅ ${DRY_RUN ? "would recover" : "recovered"} ≈ ${formatUnits(parentAmount, 18)} sUSDS`);
    }

    log.log(
      `\n🎉 Done.` +
        (DRY_RUN
          ? "\n   (Amounts are projections; leftover dust from imbalanced sets stays in the wallet.)"
          : ` Removals logged to ${progress.path}.`)
    );
    return { repos: repos.length, removed, skippedEmpty, childMerges, parentAmount: parentAmount.toString() };
  }
);
