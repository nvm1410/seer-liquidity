// Seed the YES and NO Uniswap V3 pools for every Zcash Q3 2026 CDRGP market
// created by create-zcash-markets.js, on Optimism (chain 10, sUSDS collateral).
//
// Per market:
//   1. split Q sUSDS on the market  →  Q YES + Q NO + Q Invalid
//   2. create + initialise + mint the YES/sUSDS pool at yesPrice
//   3. create + initialise + mint the NO/sUSDS pool at 1 - yesPrice
//
// The Invalid tokens from the split are left idle in the wallet, matching
// add-octant-liquidity.js. That is not wasted capital: Q sUSDS is the minimum
// needed to obtain Q YES *and* Q NO, and Invalid is priced at ~0. But see the
// guide — a scheduled-Invalid market (withdrawn proposals resolve Invalid) is a
// different risk profile from L1/octant, where Invalid is a genuine tail.
//
// Both pools use the same outcome-token quantity Q. Equal Q (rather than equal
// value) is what makes the split exact: every token minted by the split gets
// deployed, with nothing left over on either side.
//
// Run with DRY_RUN = true first: it resolves every market on-chain, sizes every
// position and prints the full capital table without sending anything.

import { Percent, Token } from "@uniswap/sdk-core";
import { NonfungiblePositionManager, Pool, Position, TickMath } from "@uniswap/v3-sdk";
import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import { erc20Abi, formatUnits } from "viem";
import { MarketViewAbi } from "./abis/MarketViewAbi.js";
import { RouterAbi } from "./abis/RouterAbi.js";

// ── Config ──────────────────────────────────────────────────────────────────
const DRY_RUN = true; // ← set to false to send transactions

const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL; // Optimism
const CHAIN_ID = 10;

const MARKETS_FILE = "./create-zcash-markets-execution.json";
const PROGRESS_FILE = "./add-zcash-liquidity-execution.json";

// Addresses (Optimism, chain 10)
const POSITION_MANAGER_ADDRESS = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const ROUTER_ADDRESS = "0x179d8F8c811B8C759c33809dbc6c5ceDc62D05DD";
const SUSDS_ADDRESS = "0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0";
const MARKET_FACTORY = "0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6";
const MARKET_VIEW = "0x336695ec9efbafd6322fb82eaadbcda02e38f348";

// Uniswap V3 pool params used across this repo's Seer pools.
const FEE_TIER = 100;
const TICK_SPACING = 1;

// Total capital to deploy across ALL markets: every split plus the sUSDS side of
// every pool must sum to this.
const TOTAL_BUDGET = 20_000n * 10n ** 18n; // 20,000 sUSDS ≈ 540.54 per market

// Liquidity range for every pool, in sUSDS per outcome token. A binary outcome
// token can only ever be worth between 0 and 1, so the band is far tighter than
// the octant/L1 markets use.
const MIN_PRICE = 0.02;
const MAX_PRICE = 0.98;

// Trial outcome-token quantity used to size the (linear) budget.
const Q0 = 1_000n * 10n ** 18n;

const DELAY_MS = 2000;

// ── Provider / wallet ───────────────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

const LN_1_0001 = Math.log(1.0001);

// ── Helpers (mirror add-octant-liquidity.js) ────────────────────────────────
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
      console.log(`  Attempt ${attempt}/${retries}...`);
      const tx = await txFn();
      console.log(`  Tx sent: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`  Confirmed in block ${receipt.blockNumber}`);
      return receipt;
    } catch (err) {
      lastError = err;
      console.warn(`  Attempt ${attempt} failed: ${err.message}`);
      if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

async function ensureAllowance(tokenAddress, spender, amount) {
  const ro = new ethers.Contract(tokenAddress, erc20Abi, provider);
  const current = await ro.allowance(wallet.address, spender);
  if (current >= amount) {
    console.log(`  ⏭  allowance already sufficient for ${tokenAddress}`);
    return;
  }
  const token = new ethers.Contract(tokenAddress, erc20Abi, wallet);
  console.log(`  Approving ${tokenAddress} → ${spender} for ${formatUnits(amount, 18)} ...`);
  await retryTransaction(() => token.approve(spender, amount));
  await new Promise((r) => setTimeout(r, 2000));
}

// Build a Pool at a fresh (not-yet-deployed) price plus the tick range for it.
function buildPoolAndBounds(outcomeToken, price) {
  const [t0, t1] = sortTokens(outcomeToken, SUSDS_ADDRESS);
  const isToken0Outcome = t0.toLowerCase() === outcomeToken.toLowerCase();
  // Pool price is token1/token0. token1/token0 = sUSDS/outcome (= price) when
  // outcome is token0, else outcome/sUSDS (= 1/price).
  const orientedPrice = isToken0Outcome ? price : 1 / price;
  const tickCurrent = priceToTick(orientedPrice);
  const sqrtPriceX96 = TickMath.getSqrtRatioAtTick(tickCurrent);

  const token0 = new Token(CHAIN_ID, t0, 18, "T0");
  const token1 = new Token(CHAIN_ID, t1, 18, "T1");
  const pool = new Pool(token0, token1, FEE_TIER, sqrtPriceX96.toString(), "0", tickCurrent);

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

  return { pool, isToken0Outcome, tickLower, tickUpper, tickCurrent };
}

// For a given outcome-token quantity, return the Position plus the amounts it
// actually consumes (the outcome token is forced to be the binding side).
function sizePosition(meta, qOutcome) {
  const HUGE = (qOutcome + 1n) * 1000n; // ensure outcome binds, not sUSDS
  const amount0 = meta.isToken0Outcome ? qOutcome.toString() : HUGE.toString();
  const amount1 = meta.isToken0Outcome ? HUGE.toString() : qOutcome.toString();
  const position = Position.fromAmounts({
    pool: meta.pool,
    tickLower: meta.tickLower,
    tickUpper: meta.tickUpper,
    amount0,
    amount1,
    useFullPrecision: true,
  });
  const a0 = BigInt(position.mintAmounts.amount0.toString());
  const a1 = BigInt(position.mintAmounts.amount1.toString());
  const outcomeUsed = meta.isToken0Outcome ? a0 : a1;
  const susdsUsed = meta.isToken0Outcome ? a1 : a0;
  return { position, outcomeUsed, susdsUsed, amount0: a0, amount1: a1 };
}

// Resolve a market on-chain and check it is the binary categorical market we
// think it is before we put money into it.
async function resolveMarket(marketView, entry) {
  const info = await marketView.getMarket(MARKET_FACTORY, entry.market);

  if (info.collateralToken.toLowerCase() !== SUSDS_ADDRESS.toLowerCase()) {
    throw new Error(`collateral ${info.collateralToken} != sUSDS`);
  }
  if (info.parentCollectionId !== ethers.ZeroHash) {
    throw new Error("market is conditional — expected top-level");
  }
  if (info.outcomes.length !== 3) {
    throw new Error(`expected 3 outcomes (Yes/No/Invalid), got ${info.outcomes.length}`);
  }
  if (info.outcomes[0] !== "Yes" || info.outcomes[1] !== "No") {
    throw new Error(`outcomes are [${info.outcomes.join(", ")}], expected [Yes, No, Invalid result]`);
  }
  if (info.questionsIds.length !== 1) {
    throw new Error(`expected 1 Reality question, got ${info.questionsIds.length}`);
  }
  if (info.wrappedTokens.length !== 3) {
    throw new Error(`expected 3 wrapped tokens, got ${info.wrappedTokens.length}`);
  }

  const [yesToken, noToken, invalidToken] = info.wrappedTokens;
  // The execution log is a record, not a source of truth — cross-check it.
  if (entry.wrappedTokens) {
    for (let i = 0; i < 3; i++) {
      if (entry.wrappedTokens[i].toLowerCase() !== info.wrappedTokens[i].toLowerCase()) {
        throw new Error(`wrappedTokens[${i}] on-chain ${info.wrappedTokens[i]} != logged ${entry.wrappedTokens[i]}`);
      }
    }
  }
  for (const t of [yesToken, noToken]) {
    const code = await provider.getCode(t);
    if (!code || code === "0x") throw new Error(`outcome token ${t} has no code`);
  }

  return { yesToken, noToken, invalidToken, marketName: info.marketName };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n📋 Wallet   : ${wallet.address}`);
  console.log(`📋 DRY_RUN  : ${DRY_RUN}`);
  console.log(`📋 Budget   : ${formatUnits(TOTAL_BUDGET, 18)} sUSDS`);
  console.log(`📋 Range    : [${MIN_PRICE}, ${MAX_PRICE}] sUSDS per outcome token`);

  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) {
    throw new Error(`RPC_URL points at chain ${net.chainId}, expected ${CHAIN_ID} (Optimism).`);
  }

  if (!fs.existsSync(MARKETS_FILE)) {
    throw new Error(`${MARKETS_FILE} not found — run create-zcash-markets.js first.`);
  }
  const markets = JSON.parse(fs.readFileSync(MARKETS_FILE, "utf8"));
  if (!markets.length) throw new Error(`${MARKETS_FILE} is empty.`);
  console.log(`\n🔍 Phase 0: resolving ${markets.length} markets on-chain...`);

  const marketView = new ethers.Contract(MARKET_VIEW, MarketViewAbi, provider);
  const entries = [];
  for (const m of markets) {
    const resolved = await resolveMarket(marketView, m);
    if (!(m.yesPrice > 0 && m.yesPrice < 1)) {
      throw new Error(`[${m.shortName}] yesPrice ${m.yesPrice} must be strictly between 0 and 1.`);
    }
    entries.push({
      ...m,
      ...resolved,
      pools: [
        { side: "YES", outcomeToken: resolved.yesToken, price: m.yesPrice },
        { side: "NO", outcomeToken: resolved.noToken, price: 1 - m.yesPrice },
      ],
    });
  }
  console.log(`   ✅ all ${entries.length} markets verified: binary categorical, sUSDS, top-level`);

  // ── Phase 1: size positions & solve for Q, per market ─────────────────────
  // Budget is split evenly across markets and Q is solved per market, NOT once
  // globally. With one global Q the sUSDS side explodes as a price approaches a
  // band edge — a market seeded at 0.20 would eat ~2x the capital of one at 0.55,
  // spending the most on the proposals we are most confident about. Solving per
  // market keeps every proposal on the same budget whatever its prior.
  //
  // Both sides of a position are linear in the outcome quantity at fixed ticks,
  // so one trial pass at Q0 gives the exact scale factor.
  console.log("\n📐 Phase 1: sizing positions...");
  const allPools = entries.flatMap((e) => e.pools);
  const budgetPerMarket = TOTAL_BUDGET / BigInt(entries.length);
  console.log(`   Budget per market: ${formatUnits(budgetPerMarket, 18)} sUSDS`);

  for (const e of entries) {
    let trialSusds = 0n;
    for (const p of e.pools) {
      p.meta = buildPoolAndBounds(p.outcomeToken, p.price);
      trialSusds += sizePosition(p.meta, Q0).susdsUsed;
    }
    // Capital for this market = one split of Q + the sUSDS side of both pools.
    const trialCapital = Q0 + trialSusds;
    e.Q = (Q0 * budgetPerMarket) / trialCapital;
    if (e.Q === 0n) throw new Error(`[${e.shortName}] solved Q is zero — raise TOTAL_BUDGET.`);
  }

  // Final pass at each market's Q.
  let sumSusds = 0n;
  console.log(
    "\n    #  shortName        side  price   ticks                 outcome       sUSDS    mkt total"
  );
  for (const e of entries) {
    e.splitAmount = 0n;
    e.capital = 0n;
    for (const p of e.pools) {
      const s = sizePosition(p.meta, e.Q);
      p.position = s.position;
      p.outcomeUsed = s.outcomeUsed;
      p.susdsUsed = s.susdsUsed;
      p.amount0 = s.amount0;
      p.amount1 = s.amount1;
      sumSusds += s.susdsUsed;
      e.capital += s.susdsUsed;
      if (s.outcomeUsed > e.splitAmount) e.splitAmount = s.outcomeUsed;
    }
    e.capital += e.splitAmount;
    for (const p of e.pools) {
      console.log(
        `   ${String(e.id).padStart(2)}  ${e.shortName.padEnd(15)} ${p.side.padEnd(4)} ` +
          `${p.price.toFixed(3)}  [${p.meta.tickLower},${p.meta.tickUpper}]`.padEnd(24) +
          `${Number(formatUnits(p.outcomeUsed, 18)).toFixed(2).padStart(11)}` +
          `${Number(formatUnits(p.susdsUsed, 18)).toFixed(2).padStart(12)}` +
          (p.side === "NO" ? `${Number(formatUnits(e.capital, 18)).toFixed(2).padStart(13)}` : "")
      );
    }
  }

  const totalSplit = entries.reduce((a, e) => a + e.splitAmount, 0n);
  const grandTotal = totalSplit + sumSusds;
  console.log(
    `\n   Splits (mint): ${formatUnits(totalSplit, 18)} sUSDS over ${entries.length} markets\n` +
      `   sUSDS side   : ${formatUnits(sumSusds, 18)} sUSDS over ${allPools.length} pools\n` +
      `   GRAND TOTAL  : ${formatUnits(grandTotal, 18)} sUSDS (budget ${formatUnits(TOTAL_BUDGET, 18)})`
  );
  if (grandTotal > TOTAL_BUDGET) {
    console.warn("   ⚠️  grand total exceeds budget — check rounding/sentinel.");
  }

  if (DRY_RUN) {
    console.log("\n✅ Dry run complete — set DRY_RUN = false to execute.");
    return;
  }

  // ── Phase 2: balance guard ────────────────────────────────────────────────
  const susds = new ethers.Contract(SUSDS_ADDRESS, erc20Abi, provider);
  const susdsBalance = await susds.balanceOf(wallet.address);
  console.log(
    `\n💰 sUSDS balance: ${formatUnits(susdsBalance, 18)} | need: ${formatUnits(grandTotal, 18)}`
  );
  if (susdsBalance < grandTotal) throw new Error("Insufficient sUSDS balance — aborting.");

  const router = new ethers.Contract(ROUTER_ADDRESS, RouterAbi, wallet);
  const ct = await router.conditionalTokens();
  if (!ct || ct === ethers.ZeroAddress) throw new Error("Router.conditionalTokens() is zero — wrong Router?");
  console.log(`   Router.conditionalTokens() = ${ct}`);

  // ── Progress log ──────────────────────────────────────────────────────────
  // Splits and pool mints are logged separately so a resumed run never re-splits
  // a market whose pools only partially minted.
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
  const poolDone = new Set(
    progressLog.filter((e) => e.kind === "pool").map((e) => e.outcomeToken.toLowerCase())
  );
  const save = () => fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progressLog, null, 2));

  // sUSDS is one side of every pool and the input to every split — approve both
  // spenders once for the whole programme.
  await ensureAllowance(SUSDS_ADDRESS, ROUTER_ADDRESS, totalSplit);
  await ensureAllowance(SUSDS_ADDRESS, POSITION_MANAGER_ADDRESS, sumSusds);

  // ── Phase 3: split + mint, market by market ───────────────────────────────
  console.log(`\n📈 Phase 3: seeding ${allPools.length} pools across ${entries.length} markets\n`);
  let poolCount = 0;
  for (const e of entries) {
    console.log(`\n=== [${e.id}] ${e.shortName} — ${e.market} ===`);

    if (splitDone.has(e.market.toLowerCase())) {
      console.log(`  ⏭  split already logged`);
    } else {
      try {
        console.log(`  💧 splitting ${formatUnits(e.splitAmount, 18)} sUSDS`);
        const receipt = await retryTransaction(() =>
          router.splitPosition(SUSDS_ADDRESS, e.market, e.splitAmount)
        );
        progressLog.push({
          kind: "split",
          id: e.id,
          shortName: e.shortName,
          market: e.market,
          amount: e.splitAmount.toString(),
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
        });
        save();
      } catch (err) {
        console.error(`  ❌ split failed for ${e.shortName}: ${err.message} — skipping its pools`);
        continue;
      }
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }

    for (const p of e.pools) {
      if (poolDone.has(p.outcomeToken.toLowerCase())) {
        console.log(`  ⏭  ${p.side} pool already logged`);
        poolCount++;
        continue;
      }
      console.log(`\n  --- ${e.shortName} ${p.side} @ ${p.price.toFixed(3)} (${p.outcomeToken}) ---`);
      try {
        const outcomeAmount = p.meta.isToken0Outcome ? p.amount0 : p.amount1;
        await ensureAllowance(p.outcomeToken, POSITION_MANAGER_ADDRESS, outcomeAmount);

        const { calldata, value } = NonfungiblePositionManager.addCallParameters(p.position, {
          recipient: wallet.address, // mint a new position
          createPool: true, // create + initialise the pool if needed, then mint
          slippageTolerance: new Percent(50, 10_000), // 0.5%
          deadline: Math.floor(Date.now() / 1000) + 60 * 20,
        });
        const receipt = await retryTransaction(() =>
          wallet.sendTransaction({ to: POSITION_MANAGER_ADDRESS, data: calldata, value })
        );

        progressLog.push({
          kind: "pool",
          id: e.id,
          shortName: e.shortName,
          market: e.market,
          side: p.side,
          outcomeToken: p.outcomeToken,
          price: p.price,
          tickLower: p.meta.tickLower,
          tickUpper: p.meta.tickUpper,
          amount0: p.amount0.toString(),
          amount1: p.amount1.toString(),
          outcomeUsed: p.outcomeUsed.toString(),
          susdsUsed: p.susdsUsed.toString(),
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
        });
        save();
        poolCount++;
        console.log(`  ✅ Saved to ${PROGRESS_FILE}`);
      } catch (err) {
        console.error(`  ❌ ${e.shortName} ${p.side} failed: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  console.log(`\n🎉 Done! ${poolCount}/${allPools.length} pools seeded. See ${PROGRESS_FILE}.`);
  if (poolCount < allPools.length) {
    console.log("   Re-run to retry the failures — logged splits and pools are skipped.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
