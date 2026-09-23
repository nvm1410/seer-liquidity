// Adds the 26th Octant pool: the Invalid outcome.
//
// add-octant-liquidity.js deliberately drops Invalid from its 25 named pools, so after
// that run the wallet holds the split's Invalid tokens idle. This deploys exactly those
// — it never splits — into one pool at a near-zero price with a tight band, which is
// what makes ~8,760 otherwise-dead tokens worth about 0.0085 sUSDS of depth.
//
// The sizing quantity is therefore the WALLET BALANCE, not a budget: whatever Invalid is
// held gets deployed, and a zero balance is a hard error rather than a no-op, because it
// means the named-outcome run has not happened (or its tokens already moved).
//
//   node add-octant-invalid-liquidity.js --resume          # dry: sizes the position
//   node add-octant-invalid-liquidity.js --resume --live   # mints, after a confirmation
//
// Like add-octant-liquidity.js this prices from a constant and never reads the pool's
// live state — correct for a first seed, wrong for a re-seed. See that script's header.

import { Percent } from "@uniswap/sdk-core";
import { NonfungiblePositionManager } from "@uniswap/v3-sdk";
import { ethers } from "ethers";
import { erc20Abi, formatUnits } from "viem";
import { getMarketInfo, makeMarketView } from "../../lib/market.js";
import { run } from "../../lib/run.js";
import { ensureAllowance, retryTransaction } from "../../lib/tx.js";
import { buildPoolAndBounds, sizePosition } from "../../lib/uniswap.js";

// Invalid-specific pricing: very close to zero, tight concentration. Mirrors
// liquidity-l1.js (initialPrice 0.000011) for consistency across markets. These are this
// script's OWN decision, not the campaign band in the manifest — that one is
// [0.0001, 1] and belongs to the 25 named pools.
const INVALID_INIT_PRICE = 0.000011; // sUSDS per Invalid token
const INVALID_BAND = { minPrice: 0.00001, maxPrice: 0.00005 };
// Safety: abort if the sUSDS side of the position somehow exceeds this.
const MAX_SUSDS_GUARD = 50n * 10n ** 18n;

await run(
  {
    name: "add-octant-invalid-liquidity",
    slug: "octant",
    stage: "seed-invalid",
    mutating: true,
    progress: (m) => m.files.invalidLiquidity,
  },
  async (ctx) => {
    const { manifest, provider, wallet, chainId, addr, log, progress, dry: DRY_RUN } = ctx;

    const OCTANT_MARKET = manifest.results.parent;
    const COLLATERAL = manifest.chain.collateral.address;
    const FEE_TIER = manifest.amm.feeTier;
    const TICK_SPACING = manifest.amm.tickSpacing;

    log.log(`\n📋 Wallet      : ${wallet.address}`);
    log.log(`📋 DRY_RUN     : ${DRY_RUN}`);
    log.log(`📋 Init price  : ${INVALID_INIT_PRICE} sUSDS/Invalid`);
    log.log(`📋 Range       : [${INVALID_BAND.minPrice}, ${INVALID_BAND.maxPrice}] sUSDS/Invalid\n`);

    const marketView = makeMarketView(addr.marketView, provider);
    const getTokenBalance = (token) => new ethers.Contract(token, erc20Abi, provider).balanceOf(wallet.address);

    // ── Phase 0: resolve market + Invalid outcome ───────────────────────────────
    log.log("🔍 Phase 0: resolving market & Invalid outcome...");
    const info = await getMarketInfo(marketView, addr.marketFactory, OCTANT_MARKET);

    if (info.collateralToken.toLowerCase() !== COLLATERAL.toLowerCase()) {
      throw new Error(`Collateral ${info.collateralToken} ≠ sUSDS ${COLLATERAL}.`);
    }

    // Invalid is the last outcome/token.
    const invalidName = info.outcomes.at(-1);
    const invalidToken = info.wrappedTokens.at(-1);
    if (!/invalid/i.test(invalidName)) {
      throw new Error(`Last outcome is "${invalidName}", expected an Invalid outcome — aborting.`);
    }
    log.log(`   Market "${info.name}"`);
    log.log(`   Invalid outcome: "${invalidName}" → ${invalidToken}`);

    const code = await provider.getCode(invalidToken);
    if (!code || code === "0x") throw new Error(`Invalid token ${invalidToken} has no code — not deployed.`);

    // ── Phase 1: read idle Invalid balance & size the position ──────────────────
    const invalidBalance = await getTokenBalance(invalidToken);
    log.log(`\n💰 Idle Invalid balance: ${formatUnits(invalidBalance, 18)} tokens`);
    if (invalidBalance === 0n) {
      throw new Error(
        "Wallet holds 0 Invalid tokens — nothing to deploy. (A fresh split would " +
          "be required, which this script intentionally does not do.)"
      );
    }

    const meta = buildPoolAndBounds({
      outcomeToken: invalidToken,
      collateral: COLLATERAL,
      price: INVALID_INIT_PRICE,
      live: null, // see the re-seeding note in the header
      chainId,
      feeTier: FEE_TIER,
      tickSpacing: TICK_SPACING,
      band: INVALID_BAND,
    });
    const s = sizePosition(meta, invalidBalance);

    log.log("\n📐 Phase 1: position sizing");
    log.log(`   isToken0Outcome : ${meta.isToken0Outcome}`);
    log.log(`   ticks           : [${meta.tickLower}, ${meta.tickUpper}] (current ${meta.tickCurrent})`);
    log.log(`   Invalid used    : ${Number(formatUnits(s.outcomeUsed, 18)).toFixed(4)}`);
    log.log(`   sUSDS used      : ${Number(formatUnits(s.collateralUsed, 18)).toFixed(6)}`);

    if (DRY_RUN) {
      return { invalidToken, outcomeUsed: s.outcomeUsed.toString(), susdsUsed: s.collateralUsed.toString() };
    }

    // ── Phase 2: guards ─────────────────────────────────────────────────────────
    if (s.collateralUsed > MAX_SUSDS_GUARD) {
      throw new Error(
        `sUSDS side ${formatUnits(s.collateralUsed, 18)} exceeds guard ${formatUnits(MAX_SUSDS_GUARD, 18)} — aborting.`
      );
    }
    const susdsBalance = await getTokenBalance(COLLATERAL);
    log.log(`\n💰 sUSDS balance: ${formatUnits(susdsBalance, 18)} | need: ${formatUnits(s.collateralUsed, 18)}`);
    if (susdsBalance < s.collateralUsed) throw new Error("Insufficient sUSDS balance — aborting.");

    // The historical entry carries outcomeToken with no kind/key, so key off that.
    const alreadyDone = new Set(progress.entries.map((e) => e.outcomeToken.toLowerCase()));
    if (alreadyDone.has(invalidToken.toLowerCase())) {
      log.log("\n⏭  Invalid pool already in progress log — nothing to do.");
      return { skipped: true };
    }

    // ── Phase 2b: approve + create + initialize + mint ──────────────────────────
    const outcomeAmount = meta.isToken0Outcome ? s.amount0 : s.amount1;
    await ensureAllowance(invalidToken, addr.positionManager, outcomeAmount, { wallet, log });
    await ensureAllowance(COLLATERAL, addr.positionManager, s.collateralUsed, { wallet, log });

    log.log(`\n📈 Minting Invalid position (${invalidToken})`);
    const { calldata, value } = NonfungiblePositionManager.addCallParameters(s.position, {
      recipient: wallet.address,
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
      key: invalidToken.toLowerCase(),
      index: info.outcomes.length - 1,
      name: invalidName,
      outcomeToken: invalidToken,
      price: INVALID_INIT_PRICE,
      tickLower: meta.tickLower,
      tickUpper: meta.tickUpper,
      amount0: s.amount0.toString(),
      amount1: s.amount1.toString(),
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
    });
    log.log(`\n🎉 Done! Invalid position minted. See ${progress.path}.`);
    return { minted: 1 };
  }
);
