// Read-only status report for the Zcash NU7 coinholder-poll pools on Optimism.
//
// For every pool in the campaign's liquidity log: the seeded price, the live
// price from slot0, and the pool's total liquidity. Also re-checks that each
// market's live prices still sum to ~1, which is the property that makes a
// categorical market arbitrage-free. Three things this is for:
//
//   1. right after seeding — confirm every pool landed on its target tick.
//   2. before a withdraw — a price that has moved means the market traded, which
//      is what shrinks the mergePositions recovery (merge converts only the
//      min of the full set).
//   3. before/after a reprice — pool liquidity larger than what this wallet put
//      in means a third party has LP'd, and a swap-to-price would trade against
//      real depth instead of costing dust.
//
// Sends nothing, ever: declared `mutating: false`, so the harness never builds a
// signer and --live does nothing. Needs only RPC_URL.
//
//   node check-zcash-nu7-pools.js

import { ethers } from "ethers";
import fs from "fs";
import { formatUnits } from "viem";
import { runBatched } from "../../lib/batch.js";
import { run } from "../../lib/run.js";
import { sortTokens, tickToPrice } from "../../lib/ticks.js";
import { POOL_MIN_ABI } from "../../lib/uniswap.js";
import { Token } from "@uniswap/sdk-core";
import { Pool } from "@uniswap/v3-sdk";

// A pool is "moved" once it is further from its seed than tick granularity.
const MOVED_TOLERANCE = 0.0005;

await run(
  { name: "check-zcash-nu7-pools", slug: "zcash-nu7", stage: "check", mutating: false },
  async (ctx) => {
    const { manifest, provider, chainId, log } = ctx;
    const collateral = manifest.chain.collateral.address;
    const { feeTier } = ctx.amm;

    const file = manifest.files.liquidity;
    if (!file || !fs.existsSync(file)) {
      throw new Error(`manifest files.liquidity (${file}) not found — nothing has been seeded.`);
    }
    const pools = JSON.parse(fs.readFileSync(file, "utf8")).filter((e) => e.kind === "pool");
    if (!pools.length) throw new Error(`${file} has no "pool" entries.`);
    log.log(`\n${pools.length} pools from ${file}\n`);

    const rows = await runBatched(
      pools,
      async (p) => {
        const address = Pool.getAddress(
          new Token(chainId, p.outcomeToken, 18, "OUT"),
          new Token(chainId, collateral, 18, "COL"),
          feeTier
        );
        const pool = new ethers.Contract(address, POOL_MIN_ABI, provider);
        const [slot0, liquidity] = await Promise.all([pool.slot0(), pool.liquidity()]);
        const tick = Number(slot0.tick);
        // slot0 prices token1/token0, so invert when the outcome is token1.
        const [t0] = sortTokens(p.outcomeToken, collateral);
        const isToken0Outcome = t0.toLowerCase() === p.outcomeToken.toLowerCase();
        const oriented = tickToPrice(tick);
        return { ...p, address, tick, liquidity, livePrice: isToken0Outcome ? oriented : 1 / oriented };
      },
      { batchSize: 10, pauseMs: 300 }
    );

    log.log("  #  mkt   outcome           seeded    live      tick  pool liquidity");
    let moved = 0;
    let empty = 0;
    const byMarket = new Map();

    for (const r of rows) {
      const seeded = r.seedPrice ?? r.price; // newer logs name it seedPrice
      const diff = r.livePrice - seeded;
      const hasMoved = Math.abs(diff) > MOVED_TOLERANCE;
      if (hasMoved) moved++;
      if (r.liquidity === 0n) empty++;

      const m = byMarket.get(r.shortName) ?? { seeded: 0, live: 0, n: 0 };
      m.seeded += seeded;
      m.live += r.livePrice;
      m.n++;
      byMarket.set(r.shortName, m);

      log.log(
        ` ${String(r.id).padStart(2)}  ${String(r.shortName).padEnd(5)} ${String(r.tag).padEnd(16)} ` +
          `${seeded.toFixed(4)}  ${r.livePrice.toFixed(4)}  ${String(r.tick).padStart(7)}  ${r.liquidity}` +
          (hasMoved ? `   <- MOVED ${diff > 0 ? "+" : ""}${diff.toFixed(4)}` : "") +
          (r.liquidity === 0n ? "   <- EMPTY" : "")
      );
    }

    // A categorical market's outcome prices should sum to 1. Drift here is the
    // headline number: it is exactly the arbitrage a trader can take out of the set.
    log.log("\n  market  outcomes  seeded sum  live sum   drift");
    for (const [shortName, m] of byMarket) {
      const drift = m.live - 1;
      log.log(
        `  ${String(shortName).padEnd(6)}  ${String(m.n).padStart(8)}  ${m.seeded.toFixed(6).padStart(10)}  ` +
          `${m.live.toFixed(6).padStart(8)}  ${(drift >= 0 ? "+" : "") + drift.toFixed(6)}`
      );
    }

    log.log(`\n   Pools whose price moved off the seed: ${moved}/${rows.length}`);
    log.log(`   Pools with zero liquidity            : ${empty}/${rows.length}`);
    log.log(
      moved === 0
        ? "   -> nothing has traded; a full-set merge would recover the whole deployment."
        : "   -> those markets traded; merge recovers only min(all outcomes, Invalid) per market."
    );
    log.log(
      "   Note: a live-sum drift of ~1e-4 is tick granularity, not arbitrage — sqrtPriceX96\n" +
        "   is derived from the clamped tick, so that residual is expected and irreducible."
    );

    return { pools: rows.length, moved, empty };
  }
);
