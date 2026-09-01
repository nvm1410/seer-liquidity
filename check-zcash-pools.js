// Read-only status report for the Zcash Q3 2026 pools on Optimism.
//
// For every pool in add-zcash-liquidity-execution.json: the seeded price, the
// live price from slot0, and the pool's total liquidity. Two things this is for:
//
//   1. before a withdraw — a price that has moved means the market traded, which
//      is what shrinks the mergePositions recovery (merge converts only the
//      min of the full set).
//   2. before/after a reprice — pool liquidity that is larger than what this
//      wallet put in means a third party has LP'd, and a swap-to-price would
//      trade against real depth instead of costing dust.
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
// The reference for "what price was this pool seeded at" is whichever seeding ran
// last: the re-seed log if there is one, otherwise the original add log.
const RESEED_FILE = "./reseed-zcash-liquidity-execution.json";
const ADD_FILE = "./add-zcash-liquidity-execution.json";

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

  const useReseed = fs.existsSync(RESEED_FILE);
  const sourceFile = useReseed ? RESEED_FILE : ADD_FILE;
  const kind = useReseed ? "fund" : "pool";
  const pools = JSON.parse(fs.readFileSync(sourceFile, "utf8")).filter((e) => e.kind === kind);
  if (!pools.length) throw new Error(`${sourceFile} has no "${kind}" entries.`);
  console.log(`\n🔍 ${pools.length} pools from ${sourceFile}\n`);

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
            liquidity: liquidity,
            livePrice: isToken0Outcome ? oriented : 1 / oriented,
          };
        })
      ))
    );
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log("  #  shortName        side  seeded    live      tick  pool liquidity");
  let moved = 0;
  for (const r of rows) {
    const diff = r.livePrice - r.price;
    const hasMoved = Math.abs(diff) > 0.0005;
    if (hasMoved) moved++;
    console.log(
      ` ${String(r.id).padStart(2)}  ${r.shortName.padEnd(15)} ${r.side.padEnd(4)} ` +
        `${r.price.toFixed(4)}  ${r.livePrice.toFixed(4)}  ${String(r.tick).padStart(7)}  ${r.liquidity}` +
        (hasMoved ? `   ← MOVED ${diff > 0 ? "+" : ""}${diff.toFixed(4)}` : "")
    );
  }

  console.log(`\n   Pools whose price moved off the seed: ${moved}/${rows.length}`);
  if (moved === 0) {
    console.log("   → nothing has traded; a full-set merge should recover the whole deployment.");
  } else {
    console.log("   → those markets traded; merge recovers only min(YES, NO, Invalid) per market.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
