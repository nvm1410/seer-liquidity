// Read-only status report for the Zcash Q3 2026 CDRGP pools on Optimism.
//
// For every pool: the seeded price, the live price from slot0, and the pool's
// total liquidity. A price that has moved means the market traded, which is what
// shrinks the mergePositions recovery — merge converts only the min of the full
// {YES, NO, Invalid} set.
//
// The reference for "what price was this pool seeded at" is whichever seeding ran
// last: the re-seed log if there is one, otherwise the original add log. Those two
// use different entry kinds ("fund" vs "pool"), because a re-seed is a three-step
// dust -> swap -> fund sequence per pool.
//
// Sends nothing: declared `mutating: false`. Needs only RPC_URL.
//
//   node check-zcash-pools.js

import { ethers } from "ethers";
import fs from "fs";
import { runBatched } from "./lib/batch.js";
import { run } from "./lib/run.js";
import { sortTokens, tickToPrice } from "./lib/ticks.js";
import { POOL_MIN_ABI } from "./lib/uniswap.js";
import { Token } from "@uniswap/sdk-core";
import { Pool } from "@uniswap/v3-sdk";

const MOVED_TOLERANCE = 0.0005;

await run(
  { name: "check-zcash-pools", slug: "zcash-q3", stage: "check", mutating: false },
  async (ctx) => {
    const { manifest, provider, chainId, log } = ctx;
    const collateral = manifest.chain.collateral.address;
    const { feeTier } = ctx.amm;

    const reseedFile = manifest.files.reseed;
    const addFile = manifest.files.liquidity;
    const useReseed = reseedFile && fs.existsSync(reseedFile);
    const sourceFile = useReseed ? reseedFile : addFile;
    const kind = useReseed ? "fund" : "pool";
    if (!sourceFile || !fs.existsSync(sourceFile)) {
      throw new Error(`no seeding log found (manifest files.reseed / files.liquidity) — nothing has been seeded.`);
    }

    const pools = JSON.parse(fs.readFileSync(sourceFile, "utf8")).filter((e) => e.kind === kind);
    if (!pools.length) throw new Error(`${sourceFile} has no "${kind}" entries.`);
    log.log(`\n🔍 ${pools.length} pools from ${sourceFile}\n`);

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

    log.log("  #  shortName        side  seeded    live      tick  pool liquidity");
    let moved = 0;
    for (const r of rows) {
      const seeded = r.seedPrice ?? r.price;
      const diff = r.livePrice - seeded;
      const hasMoved = Math.abs(diff) > MOVED_TOLERANCE;
      if (hasMoved) moved++;
      log.log(
        ` ${String(r.id).padStart(2)}  ${String(r.shortName).padEnd(15)} ${String(r.side).padEnd(4)} ` +
          `${seeded.toFixed(4)}  ${r.livePrice.toFixed(4)}  ${String(r.tick).padStart(7)}  ${r.liquidity}` +
          (hasMoved ? `   ← MOVED ${diff > 0 ? "+" : ""}${diff.toFixed(4)}` : "")
      );
    }

    log.log(`\n   Pools whose price moved off the seed: ${moved}/${rows.length}`);
    log.log(
      moved === 0
        ? "   → nothing has traded; a full-set merge should recover the whole deployment."
        : "   → those markets traded; merge recovers only min(YES, NO, Invalid) per market."
    );
    return { pools: rows.length, moved };
  }
);
