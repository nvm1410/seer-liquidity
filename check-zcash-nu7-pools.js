// Read-only status report for the Zcash NU7 coinholder-poll pools on Optimism.
//
// For every pool in add-zcash-nu7-liquidity-execution.json: the seeded price, the
// live price from slot0, and the pool's total liquidity. Also re-checks that each
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
// Sends nothing. Safe to run at any time.

import { Token } from "@uniswap/sdk-core";
import { Pool } from "@uniswap/v3-sdk";
import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";

const RPC_URL = process.env.RPC_URL;
const CHAIN_ID = 10;
const SUSDS_ADDRESS = "0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0";
const FEE_TIER = 100;
const ADD_FILE = "./add-zcash-nu7-liquidity-v2-execution.json";

const LN_1_0001 = Math.log(1.0001);

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
];

const provider = new ethers.JsonRpcProvider(RPC_URL);

async function main() {
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) {
    throw new Error(`RPC_URL points at chain ${net.chainId}, expected ${CHAIN_ID} (Optimism).`);
  }

  if (!fs.existsSync(ADD_FILE)) {
    throw new Error(`${ADD_FILE} not found — run add-zcash-nu7-liquidity.js first.`);
  }
  const pools = JSON.parse(fs.readFileSync(ADD_FILE, "utf8")).filter((e) => e.kind === "pool");
  if (!pools.length) throw new Error(`${ADD_FILE} has no "pool" entries.`);
  console.log(`\n${pools.length} pools from ${ADD_FILE}\n`);

  const rows = [];
  for (let i = 0; i < pools.length; i += 10) {
    const batch = pools.slice(i, i + 10);
    rows.push(
      ...(await Promise.all(
        batch.map(async (p) => {
          const outcome = new Token(CHAIN_ID, p.outcomeToken, 18, "OUT");
          const susds = new Token(CHAIN_ID, SUSDS_ADDRESS, 18, "SUSDS");
          const address = Pool.getAddress(outcome, susds, FEE_TIER);
          const pool = new ethers.Contract(address, POOL_ABI, provider);
          const [slot0, liquidity] = await Promise.all([pool.slot0(), pool.liquidity()]);
          const tick = Number(slot0.tick);
          // slot0 price is token1/token0; invert when the outcome token is token1.
          const isToken0Outcome = p.outcomeToken.toLowerCase() < SUSDS_ADDRESS.toLowerCase();
          const oriented = Math.exp(tick * LN_1_0001);
          return {
            ...p,
            address,
            tick,
            liquidity,
            livePrice: isToken0Outcome ? oriented : 1 / oriented,
          };
        })
      ))
    );
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log("  #  mkt   outcome           seeded    live      tick  pool liquidity");
  let moved = 0;
  let empty = 0;
  const byMarket = new Map();
  for (const r of rows) {
    const diff = r.livePrice - r.price;
    const hasMoved = Math.abs(diff) > 0.0005;
    if (hasMoved) moved++;
    if (r.liquidity === 0n) empty++;
    const m = byMarket.get(r.shortName) ?? { seeded: 0, live: 0, n: 0 };
    m.seeded += r.price;
    m.live += r.livePrice;
    m.n++;
    byMarket.set(r.shortName, m);
    console.log(
      ` ${String(r.id).padStart(2)}  ${r.shortName.padEnd(5)} ${r.tag.padEnd(16)} ` +
        `${r.price.toFixed(4)}  ${r.livePrice.toFixed(4)}  ${String(r.tick).padStart(7)}  ${r.liquidity}` +
        (hasMoved ? `   <- MOVED ${diff > 0 ? "+" : ""}${diff.toFixed(4)}` : "") +
        (r.liquidity === 0n ? "   <- EMPTY" : "")
    );
  }

  // A categorical market's outcome prices should sum to 1. Drift here is the
  // headline number: it is exactly the arbitrage a trader can take out of the set.
  console.log("\n  market  outcomes  seeded sum  live sum   drift");
  for (const [shortName, m] of byMarket) {
    const drift = m.live - 1;
    console.log(
      `  ${shortName.padEnd(6)}  ${String(m.n).padStart(8)}  ${m.seeded.toFixed(6).padStart(10)}  ` +
        `${m.live.toFixed(6).padStart(8)}  ${(drift >= 0 ? "+" : "") + drift.toFixed(6)}`
    );
  }

  console.log(`\n   Pools whose price moved off the seed: ${moved}/${rows.length}`);
  console.log(`   Pools with zero liquidity            : ${empty}/${rows.length}`);
  if (moved === 0) {
    console.log("   -> nothing has traded; a full-set merge would recover the whole deployment.");
  } else {
    console.log("   -> those markets traded; merge recovers only min(all outcomes, Invalid) per market.");
  }
  console.log(
    "   Note: a live-sum drift of ~1e-4 is tick granularity, not arbitrage — sqrtPriceX96\n" +
      "   is derived from the clamped tick, so that residual is expected and irreducible."
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
