// Re-seed the Zcash Q3 2026 YES/NO pools on Optimism at NEW prices, reusing the
// pools and the position NFTs that add-zcash-liquidity.js already created.
//
// Why this is not just "re-run add-zcash-liquidity.js with different prices":
// all 74 pools already exist and are initialised. createAndInitializePoolIfNecessary
// is a no-op on a live pool, so a re-run would compute amounts for the new price and
// mint them into a pool still sitting at the old one. In Uniswap V3 only a SWAP moves
// price — adding liquidity never does.
//
// So, per pool:
//   1. dust   — increaseLiquidity a sliver into the existing (empty) tokenId.
//               Needed because Uniswap's SwapRouter callback rejects a swap that
//               produces zero deltas ("swaps entirely within 0-liquidity regions
//               are not supported"), which is exactly what a fully-drained pool does.
//   2. swap   — exactInputSingle with sqrtPriceLimitX96 set to the target tick's
//               sqrt price. The swap stops exactly at the limit, so the pool lands
//               precisely on the new price. Cost is bounded by the dust.
//   3. fund   — increaseLiquidity the full sized position into the same tokenId,
//               against the live (now correct) price.
//
// Prices come from zcash-q3-proposals.json (`yesPrice`, joined by id) — the ballot
// file, which is the source of truth. NOT from create-zcash-markets-execution.json,
// which is a historical record of what was seeded the first time.
//
// Prerequisites: withdraw-zcash-liquidity.js and merge-zcash-positions.js have run,
// so the positions are empty, the NFTs are still held, and the capital is sUSDS.
//
// Run with DRY_RUN = true first: it resolves every market and pool on-chain, shows
// current tick → target tick and the swap direction per pool, and prints the full
// capital table without sending anything.

import { Percent, Token } from "@uniswap/sdk-core";
import { NonfungiblePositionManager, Pool, Position, SqrtPriceMath, TickMath } from "@uniswap/v3-sdk";
import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import JSBI from "jsbi";
import { erc20Abi, formatUnits } from "viem";
import { MarketViewAbi } from "./abis/MarketViewAbi.js";
import { RouterAbi } from "./abis/RouterAbi.js";

// ── Config ──────────────────────────────────────────────────────────────────
const DRY_RUN = true; // ← set to false to send transactions

// Restrict the live run to these proposal ids (empty = all 37). Use this to prove
// the whole three-step sequence on one market before committing the other 36.
const LIMIT_TO_IDS = [];

const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL; // Optimism
const CHAIN_ID = 10;

const MARKETS_FILE = "./create-zcash-markets-execution.json";
const PROPOSALS_FILE = "./zcash-q3-proposals.json";
const WITHDRAW_FILE = "./withdraw-zcash-liquidity-execution.json";
const PROGRESS_FILE = "./reseed-zcash-liquidity-execution.json";

// Addresses (Optimism, chain 10)
const POSITION_MANAGER_ADDRESS = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const SWAP_ROUTER_ADDRESS = "0xE592427A0AEce92De3Edee1F18E0157C05861564"; // Uniswap V3 SwapRouter
const V3_FACTORY_ADDRESS = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const ROUTER_ADDRESS = "0x179d8F8c811B8C759c33809dbc6c5ceDc62D05DD"; // Seer Router
const SUSDS_ADDRESS = "0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0";
const MARKET_FACTORY = "0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6";
const MARKET_VIEW = "0x336695ec9efbafd6322fb82eaadbcda02e38f348";

// Must match add-zcash-liquidity.js — the existing positions were minted with these.
const FEE_TIER = 100;
const TICK_SPACING = 1;
const MIN_PRICE = 0.02;
const MAX_PRICE = 0.98;

const TOTAL_BUDGET = 20_000n * 10n ** 18n; // sUSDS across all markets
const Q0 = 1_000n * 10n ** 18n; // trial quantity for the linear budget solve

// Outcome-token quantity for the price-setting sliver. Small enough that the swap
// costs cents, large enough that the swap's deltas are unambiguously non-zero.
const DUST_Q = 20n * 10n ** 15n; // 0.02 outcome tokens

// How far the post-swap tick may sit from the target before we refuse to fund.
const TICK_TOLERANCE = 2;

const DELAY_MS = 2000;

// ── Provider / wallet ───────────────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

const LN_1_0001 = Math.log(1.0001);

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
];

const POSITION_MANAGER_ABI = [
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function ownerOf(uint256 tokenId) view returns (address)",
];

const SWAP_ROUTER_ABI = [
  "function factory() view returns (address)",
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
];

// ── Helpers (mirror add-zcash-liquidity.js) ─────────────────────────────────
function sortTokens(a, b) {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

function priceToTick(price) {
  return Math.floor(Math.log(price) / LN_1_0001);
}

async function retryTransaction(txFn, retries = 3, delayMs = 3000) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`      attempt ${attempt}/${retries}...`);
      const tx = await txFn();
      console.log(`      tx ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`      confirmed in block ${receipt.blockNumber}`);
      return receipt;
    } catch (err) {
      lastError = err;
      console.warn(`      attempt ${attempt} failed: ${err.message}`);
      if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

async function ensureAllowance(tokenAddress, spender, amount) {
  const ro = new ethers.Contract(tokenAddress, erc20Abi, provider);
  const current = await ro.allowance(wallet.address, spender);
  if (current >= amount) return;
  const token = new ethers.Contract(tokenAddress, erc20Abi, wallet);
  console.log(`      approving ${tokenAddress} -> ${spender}`);
  await retryTransaction(() => token.approve(spender, amount));
  await new Promise((r) => setTimeout(r, 2000));
}

// The tick band and orientation for an outcome/sUSDS pool. Identical maths to
// add-zcash-liquidity.js so the band matches the existing positions exactly.
function poolGeometry(outcomeToken) {
  const [t0, t1] = sortTokens(outcomeToken, SUSDS_ADDRESS);
  const isToken0Outcome = t0.toLowerCase() === outcomeToken.toLowerCase();

  let tickLower, tickUpper;
  if (isToken0Outcome) {
    tickLower = Math.floor(priceToTick(MIN_PRICE) / TICK_SPACING) * TICK_SPACING;
    tickUpper = Math.ceil(priceToTick(MAX_PRICE) / TICK_SPACING) * TICK_SPACING;
  } else {
    tickLower = Math.floor(priceToTick(1 / MAX_PRICE) / TICK_SPACING) * TICK_SPACING;
    tickUpper = Math.ceil(priceToTick(1 / MIN_PRICE) / TICK_SPACING) * TICK_SPACING;
  }
  tickLower = Math.max(tickLower, TickMath.MIN_TICK);
  tickUpper = Math.min(tickUpper, TickMath.MAX_TICK);
  if (tickLower >= tickUpper) throw new Error("Invalid tick range");

  return {
    token0: new Token(CHAIN_ID, t0, 18, "T0"),
    token1: new Token(CHAIN_ID, t1, 18, "T1"),
    isToken0Outcome,
    tickLower,
    tickUpper,
  };
}

// Pool price is token1/token0: sUSDS/outcome when the outcome is token0, else the
// reciprocal. Returns the tick the pool must sit at for `price` sUSDS per outcome.
function targetTickFor(geom, price) {
  return priceToTick(geom.isToken0Outcome ? price : 1 / price);
}

function poolAt(geom, tick) {
  const sqrtPriceX96 = TickMath.getSqrtRatioAtTick(tick);
  return new Pool(geom.token0, geom.token1, FEE_TIER, sqrtPriceX96.toString(), "0", tick);
}

// For a given outcome-token quantity, the Position plus the amounts it consumes
// (the outcome token is forced to be the binding side).
function sizePosition(pool, geom, qOutcome) {
  const HUGE = (qOutcome + 1n) * 1000n; // ensure outcome binds, not sUSDS
  const position = Position.fromAmounts({
    pool,
    tickLower: geom.tickLower,
    tickUpper: geom.tickUpper,
    amount0: (geom.isToken0Outcome ? qOutcome : HUGE).toString(),
    amount1: (geom.isToken0Outcome ? HUGE : qOutcome).toString(),
    useFullPrecision: true,
  });
  const a0 = BigInt(position.mintAmounts.amount0.toString());
  const a1 = BigInt(position.mintAmounts.amount1.toString());
  return {
    position,
    amount0: a0,
    amount1: a1,
    outcomeUsed: geom.isToken0Outcome ? a0 : a1,
    susdsUsed: geom.isToken0Outcome ? a1 : a0,
  };
}

async function readPool(address) {
  const c = new ethers.Contract(address, POOL_ABI, provider);
  const [slot0, liquidity] = await Promise.all([c.slot0(), c.liquidity()]);
  return { sqrtPriceX96: slot0.sqrtPriceX96, tick: Number(slot0.tick), liquidity };
}

// Exact token input needed to walk `liquidity` from one sqrt price to another,
// with a safety multiple. Only the amount actually consumed is transferred by the
// SwapRouter callback, so over-supplying the cap costs nothing.
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

// Resolve a market on-chain and check it is the binary categorical market we think
// it is before we put money into it. (Same guards as add-zcash-liquidity.js.)
async function resolveMarket(marketView, entry) {
  const info = await marketView.getMarket(MARKET_FACTORY, entry.market);
  if (info.collateralToken.toLowerCase() !== SUSDS_ADDRESS.toLowerCase()) {
    throw new Error(`collateral ${info.collateralToken} != sUSDS`);
  }
  if (info.parentCollectionId !== ethers.ZeroHash) throw new Error("market is conditional — expected top-level");
  if (info.outcomes.length !== 3) throw new Error(`expected 3 outcomes, got ${info.outcomes.length}`);
  if (info.outcomes[0] !== "Yes" || info.outcomes[1] !== "No") {
    throw new Error(`outcomes are [${info.outcomes.join(", ")}], expected [Yes, No, Invalid result]`);
  }
  if (info.wrappedTokens.length !== 3) throw new Error(`expected 3 wrapped tokens, got ${info.wrappedTokens.length}`);
  const [yesToken, noToken] = info.wrappedTokens;
  return { yesToken, noToken };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n📋 Wallet   : ${wallet.address}`);
  console.log(`📋 DRY_RUN  : ${DRY_RUN}`);
  console.log(`📋 Budget   : ${formatUnits(TOTAL_BUDGET, 18)} sUSDS`);
  console.log(`📋 Range    : [${MIN_PRICE}, ${MAX_PRICE}] sUSDS per outcome token`);
  if (LIMIT_TO_IDS.length) console.log(`📋 Limited to ids: ${LIMIT_TO_IDS.join(", ")}`);

  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) {
    throw new Error(`RPC_URL points at chain ${net.chainId}, expected ${CHAIN_ID} (Optimism).`);
  }

  const swapRouter = new ethers.Contract(SWAP_ROUTER_ADDRESS, SWAP_ROUTER_ABI, wallet);
  const routerFactory = await swapRouter.factory();
  if (routerFactory.toLowerCase() !== V3_FACTORY_ADDRESS.toLowerCase()) {
    throw new Error(`SwapRouter.factory() = ${routerFactory}, expected ${V3_FACTORY_ADDRESS}`);
  }
  console.log(`   SwapRouter verified against V3 factory ${routerFactory}`);

  for (const f of [MARKETS_FILE, PROPOSALS_FILE, WITHDRAW_FILE]) {
    if (!fs.existsSync(f)) throw new Error(`${f} not found.`);
  }
  const markets = JSON.parse(fs.readFileSync(MARKETS_FILE, "utf8"));
  const proposals = JSON.parse(fs.readFileSync(PROPOSALS_FILE, "utf8")).proposals;
  const withdrawLog = JSON.parse(fs.readFileSync(WITHDRAW_FILE, "utf8"));

  const priceById = new Map(proposals.map((p) => [p.id, p.yesPrice]));
  // (market, side) -> the position NFT minted for that pool the first time round.
  const tokenIdBy = new Map(
    withdrawLog.map((e) => [`${e.market.toLowerCase()}|${e.side}`, e.positionId])
  );

  // ── Phase 0: resolve markets, prices and existing positions ───────────────
  console.log(`\n🔍 Phase 0: resolving ${markets.length} markets on-chain...`);
  const marketView = new ethers.Contract(MARKET_VIEW, MarketViewAbi, provider);
  const positionManager = new ethers.Contract(POSITION_MANAGER_ADDRESS, POSITION_MANAGER_ABI, provider);

  const entries = [];
  for (const m of markets) {
    if (LIMIT_TO_IDS.length && !LIMIT_TO_IDS.includes(m.id)) continue;

    const yesPrice = priceById.get(m.id);
    if (yesPrice === undefined) throw new Error(`[${m.shortName}] id ${m.id} missing from ${PROPOSALS_FILE}`);
    for (const p of [yesPrice, 1 - yesPrice]) {
      if (!(p > MIN_PRICE && p < MAX_PRICE)) {
        throw new Error(`[${m.shortName}] price ${p} outside the pool band (${MIN_PRICE}, ${MAX_PRICE}).`);
      }
    }

    const { yesToken, noToken } = await resolveMarket(marketView, m);
    const pools = [
      { side: "YES", outcomeToken: yesToken, price: yesPrice },
      { side: "NO", outcomeToken: noToken, price: 1 - yesPrice },
    ];

    for (const p of pools) {
      p.geom = poolGeometry(p.outcomeToken);
      p.targetTick = targetTickFor(p.geom, p.price);
      p.poolAddress = Pool.getAddress(p.geom.token0, p.geom.token1, FEE_TIER);

      const tokenId = tokenIdBy.get(`${m.market.toLowerCase()}|${p.side}`);
      if (tokenId === undefined) {
        throw new Error(`[${m.shortName} ${p.side}] no position NFT in ${WITHDRAW_FILE}`);
      }
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
  console.log(`   ✅ ${entries.length} markets verified; ${entries.length * 2} pools + position NFTs matched`);

  // ── Phase 1: size every position at the NEW prices ────────────────────────
  // Same per-market budget solve as add-zcash-liquidity.js: both sides of a
  // position are linear in the outcome quantity at fixed ticks, so one trial pass
  // at Q0 gives the exact scale factor.
  console.log("\n📐 Phase 1: sizing positions at the new prices...");
  const budgetPerMarket = TOTAL_BUDGET / BigInt(entries.length);
  console.log(`   Budget per market: ${formatUnits(budgetPerMarket, 18)} sUSDS`);

  for (const e of entries) {
    let trialSusds = 0n;
    for (const p of e.pools) {
      p.targetPool = poolAt(p.geom, p.targetTick);
      trialSusds += sizePosition(p.targetPool, p.geom, Q0).susdsUsed;
    }
    e.Q = (Q0 * budgetPerMarket) / (Q0 + trialSusds);
    if (e.Q === 0n) throw new Error(`[${e.shortName}] solved Q is zero — raise TOTAL_BUDGET.`);
  }

  let sumSusds = 0n;
  let sumDustSusds = 0n;
  let repriceCount = 0;
  console.log(
    "\n    #  shortName        side  price   now→target        move    outcome       sUSDS    mkt total"
  );
  for (const e of entries) {
    e.splitAmount = 0n;
    e.capital = 0n;
    for (const p of e.pools) {
      const s = sizePosition(p.targetPool, p.geom, e.Q);
      p.sized = s;

      // The sliver is priced against the pool as it stands NOW, not at the target.
      const livePool = poolAt(p.geom, p.live.tick);
      p.dust = sizePosition(livePool, p.geom, DUST_Q);

      p.needsReprice = p.live.tick !== p.targetTick;
      if (p.needsReprice) repriceCount++;

      // The price-setting swap is paid for out of the same balances the split and
      // the budget fund. When it pays in the outcome token it eats into what the
      // split produced, so the split has to cover it — otherwise the fund step
      // reverts STF, short by exactly the swap's input. (It is bounded by the dust
      // position's depth over the traversed range, not by DUST_Q: a position
      // spanning the whole band absorbs far more outcome as the price falls.)
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
      const susdsNeeded = s.susdsUsed + (p.needsReprice ? p.dust.susdsUsed + p.swapSusdsCost : 0n);
      sumSusds += s.susdsUsed;
      if (p.needsReprice) sumDustSusds += p.dust.susdsUsed + p.swapSusdsCost;
      e.capital += susdsNeeded;
      if (outcomeNeeded > e.splitAmount) e.splitAmount = outcomeNeeded;

      const dir = !p.needsReprice
        ? "—"
        : (p.targetTick < p.live.tick) === p.geom.isToken0Outcome
          ? "sell outcome"
          : "buy outcome";
      console.log(
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
  console.log(
    `\n   Pools needing a reprice: ${repriceCount}/${entries.length * 2}\n` +
      `   Splits (mint): ${formatUnits(totalSplit, 18)} sUSDS over ${entries.length} markets\n` +
      `   sUSDS side   : ${formatUnits(sumSusds, 18)} sUSDS over ${entries.length * 2} pools\n` +
      `   price slivers: ${formatUnits(sumDustSusds, 18)} sUSDS (stays in the positions)\n` +
      `   GRAND TOTAL  : ${formatUnits(grandTotal, 18)} sUSDS (budget ${formatUnits(TOTAL_BUDGET, 18)})`
  );

  // Third-party liquidity turns the swap from a dust move into a real trade.
  for (const e of entries) {
    for (const p of e.pools) {
      if (p.needsReprice && p.live.liquidity > p.existingLiquidity) {
        console.warn(
          `   ⚠️  [${e.shortName} ${p.side}] pool liquidity ${p.live.liquidity} exceeds our position ` +
            `${p.existingLiquidity} — someone else has LP'd; the swap would trade against real depth.`
        );
      }
    }
  }

  if (DRY_RUN) {
    console.log("\n✅ Dry run complete — set DRY_RUN = false to execute.");
    return;
  }

  // ── Phase 2: balance guard and approvals ─────────────────────────────────
  const susds = new ethers.Contract(SUSDS_ADDRESS, erc20Abi, provider);
  const susdsBalance = await susds.balanceOf(wallet.address);
  console.log(
    `\n💰 sUSDS balance: ${formatUnits(susdsBalance, 18)} | need: ${formatUnits(grandTotal, 18)}`
  );
  if (susdsBalance < grandTotal) throw new Error("Insufficient sUSDS balance — aborting.");

  const seerRouter = new ethers.Contract(ROUTER_ADDRESS, RouterAbi, wallet);
  const ct = await seerRouter.conditionalTokens();
  if (!ct || ct === ethers.ZeroAddress) throw new Error("Router.conditionalTokens() is zero — wrong Router?");

  await ensureAllowance(SUSDS_ADDRESS, ROUTER_ADDRESS, totalSplit);
  await ensureAllowance(SUSDS_ADDRESS, POSITION_MANAGER_ADDRESS, sumSusds + sumDustSusds);
  await ensureAllowance(SUSDS_ADDRESS, SWAP_ROUTER_ADDRESS, ethers.MaxUint256 / 2n);

  // ── Progress log ─────────────────────────────────────────────────────────
  // Splits and funded pools are the only things worth skipping on a resume. The
  // dust and swap steps are decided from live chain state instead, so a run that
  // died between them self-heals rather than trusting the log.
  let progressLog = [];
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      progressLog = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
    } catch {
      progressLog = [];
    }
  }
  const splitDone = new Set(
    progressLog.filter((e) => e.kind === "split").map((e) => e.market.toLowerCase())
  );
  const fundDone = new Set(
    progressLog.filter((e) => e.kind === "fund").map((e) => e.outcomeToken.toLowerCase())
  );
  const save = () => fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progressLog, null, 2));
  const record = (row) => {
    progressLog.push(row);
    save();
  };

  // ── Phase 3: split, then reprice + fund each pool ────────────────────────
  console.log(`\n📈 Phase 3: re-seeding ${entries.length * 2} pools across ${entries.length} markets\n`);
  let fundedCount = 0;
  for (const e of entries) {
    console.log(`\n=== [${e.id}] ${e.shortName} — ${e.market} ===`);

    if (splitDone.has(e.market.toLowerCase())) {
      console.log(`  ⏭  split already logged`);
    } else {
      try {
        console.log(`  💧 splitting ${formatUnits(e.splitAmount, 18)} sUSDS`);
        const receipt = await retryTransaction(() =>
          seerRouter.splitPosition(SUSDS_ADDRESS, e.market, e.splitAmount)
        );
        record({
          kind: "split",
          id: e.id,
          shortName: e.shortName,
          market: e.market,
          amount: e.splitAmount.toString(),
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
        });
      } catch (err) {
        console.error(`  ❌ split failed for ${e.shortName}: ${err.message} — skipping its pools`);
        continue;
      }
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }

    for (const p of e.pools) {
      if (fundDone.has(p.outcomeToken.toLowerCase())) {
        console.log(`  ⏭  ${p.side} pool already funded`);
        fundedCount++;
        continue;
      }
      console.log(`\n  --- ${e.shortName} ${p.side} → ${p.price.toFixed(3)} (#${p.tokenId}) ---`);
      try {
        let live = await readPool(p.poolAddress);

        // Step 1 + 2: move the pool onto the target price, if it is not there.
        if (live.tick !== p.targetTick) {
          if (live.liquidity === 0n) {
            console.log(`    1/3 dust: ${formatUnits(p.dust.outcomeUsed, 18)} outcome + ` +
              `${formatUnits(p.dust.susdsUsed, 18)} sUSDS`);
            await ensureAllowance(p.outcomeToken, POSITION_MANAGER_ADDRESS, p.dust.outcomeUsed + p.sized.outcomeUsed);
            const dustPos = sizePosition(poolAt(p.geom, live.tick), p.geom, DUST_Q).position;
            const { calldata, value } = NonfungiblePositionManager.addCallParameters(dustPos, {
              tokenId: p.tokenId.toString(), // increaseLiquidity, not mint
              slippageTolerance: new Percent(50, 10_000),
              deadline: Math.floor(Date.now() / 1000) + 60 * 20,
            });
            const receipt = await retryTransaction(() =>
              wallet.sendTransaction({ to: POSITION_MANAGER_ADDRESS, data: calldata, value })
            );
            record({
              kind: "dust", id: e.id, shortName: e.shortName, market: e.market, side: p.side,
              outcomeToken: p.outcomeToken, tokenId: p.tokenId.toString(),
              txHash: receipt.hash, blockNumber: receipt.blockNumber,
            });
            await new Promise((r) => setTimeout(r, DELAY_MS));
            live = await readPool(p.poolAddress);
          } else {
            console.log(`    1/3 dust: skipped — pool already has liquidity ${live.liquidity}`);
          }

          const targetSqrt = BigInt(TickMath.getSqrtRatioAtTick(p.targetTick).toString());
          if (targetSqrt === BigInt(live.sqrtPriceX96)) {
            throw new Error(`pool is already at the target sqrt price but reports tick ${live.tick} — inspect manually`);
          }
          if (live.liquidity === 0n) {
            throw new Error("pool still has zero liquidity after the dust step — a swap would revert");
          }
          const zeroForOne = targetSqrt < BigInt(live.sqrtPriceX96);
          const tokenIn = zeroForOne ? p.geom.token0.address : p.geom.token1.address;
          const tokenOut = zeroForOne ? p.geom.token1.address : p.geom.token0.address;
          const amountIn = swapInputCap(BigInt(live.sqrtPriceX96), targetSqrt, live.liquidity, zeroForOne);

          console.log(
            `    2/3 swap: tick ${live.tick} → ${p.targetTick}, ` +
              `in ${tokenIn === SUSDS_ADDRESS ? "sUSDS" : "outcome"} cap ${formatUnits(amountIn, 18)}`
          );
          await ensureAllowance(tokenIn, SWAP_ROUTER_ADDRESS, amountIn);
          const swapReceipt = await retryTransaction(() =>
            swapRouter.exactInputSingle({
              tokenIn,
              tokenOut,
              fee: FEE_TIER,
              recipient: wallet.address,
              deadline: Math.floor(Date.now() / 1000) + 60 * 20,
              amountIn,
              amountOutMinimum: 0n,
              sqrtPriceLimitX96: targetSqrt,
            })
          );
          record({
            kind: "swap", id: e.id, shortName: e.shortName, market: e.market, side: p.side,
            outcomeToken: p.outcomeToken, fromTick: live.tick, toTick: p.targetTick,
            tokenIn, amountInCap: amountIn.toString(),
            txHash: swapReceipt.hash, blockNumber: swapReceipt.blockNumber,
          });
          await new Promise((r) => setTimeout(r, DELAY_MS));
          live = await readPool(p.poolAddress);
        }

        // Step 3: fund the real position against the live price.
        if (Math.abs(live.tick - p.targetTick) > TICK_TOLERANCE) {
          throw new Error(
            `pool is at tick ${live.tick}, target ${p.targetTick} (tolerance ${TICK_TOLERANCE}) — not funding`
          );
        }
        // Size from what the wallet actually holds. A market split before the swap
        // headroom existed is short by the swap's input, and a re-run must not
        // re-split it — so fall back to the live balance rather than reverting STF.
        let fundQ = e.Q;
        const outcomeBal = await new ethers.Contract(p.outcomeToken, erc20Abi, provider).balanceOf(wallet.address);
        let fundSized = sizePosition(poolAt(p.geom, live.tick), p.geom, fundQ);
        if (outcomeBal < fundSized.outcomeUsed) {
          fundQ = (outcomeBal * 9999n) / 10_000n; // haircut so rounding cannot re-cross the balance
          fundSized = sizePosition(poolAt(p.geom, live.tick), p.geom, fundQ);
          console.log(
            `    ⚠️  outcome balance ${formatUnits(outcomeBal, 18)} < planned ` +
              `${formatUnits(e.Q, 18)} — sizing from balance instead`
          );
          if (fundSized.outcomeUsed === 0n) throw new Error("no outcome tokens left to fund with");
        }
        console.log(
          `    3/3 fund: ${formatUnits(fundSized.outcomeUsed, 18)} outcome + ` +
            `${formatUnits(fundSized.susdsUsed, 18)} sUSDS at tick ${live.tick}`
        );
        await ensureAllowance(p.outcomeToken, POSITION_MANAGER_ADDRESS, fundSized.outcomeUsed);
        const { calldata, value } = NonfungiblePositionManager.addCallParameters(fundSized.position, {
          tokenId: p.tokenId.toString(),
          slippageTolerance: new Percent(50, 10_000),
          deadline: Math.floor(Date.now() / 1000) + 60 * 20,
        });
        const receipt = await retryTransaction(() =>
          wallet.sendTransaction({ to: POSITION_MANAGER_ADDRESS, data: calldata, value })
        );
        record({
          kind: "fund", id: e.id, shortName: e.shortName, market: e.market, side: p.side,
          outcomeToken: p.outcomeToken, tokenId: p.tokenId.toString(), price: p.price,
          tick: live.tick, tickLower: p.geom.tickLower, tickUpper: p.geom.tickUpper,
          amount0: fundSized.amount0.toString(), amount1: fundSized.amount1.toString(),
          outcomeUsed: fundSized.outcomeUsed.toString(), susdsUsed: fundSized.susdsUsed.toString(),
          txHash: receipt.hash, blockNumber: receipt.blockNumber,
        });
        fundedCount++;
        console.log(`  ✅ ${e.shortName} ${p.side} re-seeded at ${p.price.toFixed(3)}`);
      } catch (err) {
        console.error(`  ❌ ${e.shortName} ${p.side} failed: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  console.log(`\n🎉 Done! ${fundedCount}/${entries.length * 2} pools re-seeded. See ${PROGRESS_FILE}.`);
  if (fundedCount < entries.length * 2) {
    console.log("   Re-run to retry the failures — logged splits and funded pools are skipped.");
  }
  console.log("   Verify with: node check-zcash-pools.js");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
