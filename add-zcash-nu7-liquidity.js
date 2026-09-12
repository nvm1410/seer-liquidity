// Seed one Uniswap V3 pool per outcome for every Zcash NU7 coinholder-poll market
// created by create-zcash-nu7-markets.js, on Optimism (chain 10, sUSDS collateral).
//
// Per market (a single-select categorical market with n options):
//   1. split Q sUSDS on the market  ->  Q of each of the n outcomes + Q Invalid
//   2. create + initialise + mint one <outcome>/sUSDS pool per option, at that
//      option's seed price
//
// The Invalid tokens from the split are left idle in the wallet, matching
// add-zcash-liquidity.js / add-octant-liquidity.js. That is not wasted capital:
// Q sUSDS is the minimum needed to obtain Q of every outcome at once. But note
// that Invalid is a real risk here, not a tail — see the guide.
//
// Every pool uses the same outcome-token quantity Q. Equal Q (rather than equal
// value) is what makes the split exact: every token minted by the split gets
// deployed, with nothing left over. The consequence, accepted deliberately, is
// that a market's favourite takes most of the market's budget on its sUSDS side
// and the long-shot options get thin sUSDS depth.
//
// Prices come from zcash-nu7-questions.json joined by id, NOT from the creation
// log — the questions file is the single source of truth, so a later reprice
// edits one place. (add-zcash-liquidity.js read prices from its creation log and
// went stale; see CLAUDE_ZCASH_MARKETS_GUIDE.md step 5.)
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
const DRY_RUN = false; // ← set to false to send transactions

const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL; // Optimism
const CHAIN_ID = 10;

const QUESTIONS_FILE = "./zcash-nu7-questions-v3.json";
const MARKETS_FILE = "./create-zcash-nu7-markets-v3-execution.json";
const PROGRESS_FILE = "./add-zcash-nu7-liquidity-v3-round2-execution.json";

// Addresses (Optimism, chain 10)
const POSITION_MANAGER_ADDRESS = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const ROUTER_ADDRESS = "0x179d8F8c811B8C759c33809dbc6c5ceDc62D05DD";
const SUSDS_ADDRESS = "0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0";
const MARKET_FACTORY = "0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6";
const MARKET_VIEW = "0x336695ec9efbafd6322fb82eaadbcda02e38f348";

// Uniswap V3 pool params used across this repo's Seer pools.
const FEE_TIER = 100;
const TICK_SPACING = 1;

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
];

// Total capital to deploy across ALL markets: every split plus the sUSDS side of
// every pool must sum to this. Split evenly per market.
const TOTAL_BUDGET = 10_000n * 10n ** 18n; // 10,000 sUSDS = 2,000 per question

// Liquidity range for every pool, in sUSDS per outcome token. An outcome token of
// a categorical market can only ever be worth between 0 and 1. Back to the Zcash
// Q3 binaries' [0.02, 0.98] now that the v2 ballot has dropped Abstain: the lowest
// seed price is 0.05, so the v1 floor of 0.005 would only spread depth across a
// range no outcome sits in. Every seed price must stay strictly inside the band.
const MIN_PRICE = 0.02;
const MAX_PRICE = 0.98;

// Trial outcome-token quantity used to size the (linear) budget.
const Q0 = 1_000n * 10n ** 18n;

const DELAY_MS = 2000;

// ── Provider / wallet ───────────────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

const LN_1_0001 = Math.log(1.0001);

// ── Helpers (mirror add-zcash-liquidity.js) ─────────────────────────────────
function sortTokens(a, b) {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

function priceToTick(price) {
  return Math.floor(Math.log(price) / LN_1_0001);
}

function normalizeName(s) {
  return String(s).toLowerCase().replace(/\s+/g, " ").trim();
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
    console.log(`  allowance already sufficient for ${tokenAddress}`);
    return;
  }
  const token = new ethers.Contract(tokenAddress, erc20Abi, wallet);
  console.log(`  Approving ${tokenAddress} -> ${spender} for ${formatUnits(amount, 18)} ...`);
  await retryTransaction(() => token.approve(spender, amount));
  await new Promise((r) => setTimeout(r, 2000));
}

// Build the Pool to size against, plus the tick range for it.
//
// `live` is the pool's on-chain slot0, or null if the pool has never been
// initialised. It is load-bearing on a re-seed: a pool that was drained still
// exists and keeps its last price, and `createAndInitializePoolIfNecessary` is a
// no-op on it — so the mint executes at the pool's OWN price no matter what
// sqrtPriceX96 we pass. Sizing against the seed price there would (a) mis-split
// the two sides and (b) blow the 0.5% slippage guard on any pool that has
// traded. So: existing pool -> take its price as given; fresh pool -> seed price.
function buildPoolAndBounds(outcomeToken, price, live) {
  const [t0, t1] = sortTokens(outcomeToken, SUSDS_ADDRESS);
  const isToken0Outcome = t0.toLowerCase() === outcomeToken.toLowerCase();
  // Pool price is token1/token0. token1/token0 = sUSDS/outcome (= price) when
  // outcome is token0, else outcome/sUSDS (= 1/price).
  const orientedPrice = isToken0Outcome ? price : 1 / price;
  const tickCurrent = live ? live.tick : priceToTick(orientedPrice);
  const sqrtPriceX96 = live
    ? live.sqrtPriceX96
    : TickMath.getSqrtRatioAtTick(tickCurrent).toString();

  // The price this position will actually be built around, in sUSDS per outcome
  // token, read back from sqrtPriceX96 so it reflects a mid-tick pool exactly.
  const orientedActual = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
  const effectivePrice = isToken0Outcome ? orientedActual : 1 / orientedActual;

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
  if (tickCurrent <= tickLower || tickCurrent >= tickUpper) {
    throw new Error(
      `price ${effectivePrice} sits outside the band [${MIN_PRICE}, ${MAX_PRICE}] — the position ` +
        "would be entirely one-sided. Widen the band or reprice the outcome."
    );
  }

  return { pool, isToken0Outcome, tickLower, tickUpper, tickCurrent, effectivePrice, live: !!live };
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

// Resolve a market on-chain and check it is the categorical market the questions
// file says it is before we put money into it.
async function resolveMarket(marketView, entry, question) {
  const info = await marketView.getMarket(MARKET_FACTORY, entry.market);

  if (info.collateralToken.toLowerCase() !== SUSDS_ADDRESS.toLowerCase()) {
    throw new Error(`collateral ${info.collateralToken} != sUSDS`);
  }
  if (info.parentCollectionId !== ethers.ZeroHash) {
    throw new Error("market is conditional — expected top-level");
  }
  if (Number(info.templateId) !== 2) {
    throw new Error(`expected templateId 2 (single-select), got ${info.templateId}`);
  }

  const n = question.outcomes.length;
  const expected = [...question.outcomes.map((o) => o.label), "Invalid result"];
  const onChain = [...info.outcomes];
  if (onChain.length !== expected.length) {
    throw new Error(`expected ${expected.length} outcomes (${n} options + Invalid), got ${onChain.length}`);
  }
  for (let i = 0; i < expected.length; i++) {
    if (normalizeName(onChain[i]) !== normalizeName(expected[i])) {
      throw new Error(`outcome ${i}: on-chain "${onChain[i]}" != questions file "${expected[i]}"`);
    }
  }
  if (info.questionsIds.length !== 1) {
    throw new Error(`expected 1 Reality question, got ${info.questionsIds.length}`);
  }
  if (info.wrappedTokens.length !== expected.length) {
    throw new Error(`expected ${expected.length} wrapped tokens, got ${info.wrappedTokens.length}`);
  }

  const wrappedTokens = [...info.wrappedTokens];
  // The execution log is a record, not a source of truth — cross-check it.
  if (entry.wrappedTokens) {
    for (let i = 0; i < wrappedTokens.length; i++) {
      if (entry.wrappedTokens[i].toLowerCase() !== wrappedTokens[i].toLowerCase()) {
        throw new Error(
          `wrappedTokens[${i}] on-chain ${wrappedTokens[i]} != logged ${entry.wrappedTokens[i]}`
        );
      }
    }
  }
  // Every pooled token must actually be a deployed ERC20. Invalid is not pooled.
  for (const t of wrappedTokens.slice(0, n)) {
    const code = await provider.getCode(t);
    if (!code || code === "0x") throw new Error(`outcome token ${t} has no code`);
  }

  return {
    outcomeTokens: wrappedTokens.slice(0, n),
    invalidToken: wrappedTokens[n],
    marketName: info.marketName,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nWallet   : ${wallet.address}`);
  console.log(`DRY_RUN  : ${DRY_RUN}`);
  console.log(`Budget   : ${formatUnits(TOTAL_BUDGET, 18)} sUSDS`);
  console.log(`Range    : [${MIN_PRICE}, ${MAX_PRICE}] sUSDS per outcome token`);

  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) {
    throw new Error(`RPC_URL points at chain ${net.chainId}, expected ${CHAIN_ID} (Optimism).`);
  }

  if (!fs.existsSync(MARKETS_FILE)) {
    throw new Error(`${MARKETS_FILE} not found — run create-zcash-nu7-markets.js first.`);
  }
  const markets = JSON.parse(fs.readFileSync(MARKETS_FILE, "utf8"));
  if (!markets.length) throw new Error(`${MARKETS_FILE} is empty.`);

  // Prices come from the questions file, joined by id — see the header comment.
  const doc = JSON.parse(fs.readFileSync(QUESTIONS_FILE, "utf8"));
  const byId = new Map(doc.questions.map((q) => [q.id, q]));

  console.log(`\nPhase 0: resolving ${markets.length} markets on-chain...`);

  const marketView = new ethers.Contract(MARKET_VIEW, MarketViewAbi, provider);
  const entries = [];
  for (const m of markets) {
    const question = byId.get(m.id);
    if (!question) throw new Error(`market id ${m.id} (${m.shortName}) is not in ${QUESTIONS_FILE}.`);

    const priceSum = question.outcomes.reduce((a, o) => a + o.price, 0);
    if (Math.abs(priceSum - 1) > 1e-9) {
      throw new Error(`[${m.shortName}] outcome prices sum to ${priceSum} — a categorical market must sum to 1.`);
    }
    for (const o of question.outcomes) {
      if (!(o.price > 0 && o.price < 1)) {
        throw new Error(`[${m.shortName}] price ${o.price} for "${o.label}" must be strictly between 0 and 1.`);
      }
    }

    const resolved = await resolveMarket(marketView, m, question);
    entries.push({
      id: m.id,
      shortName: m.shortName,
      topic: question.topic,
      market: m.market,
      invalidToken: resolved.invalidToken,
      pools: question.outcomes.map((o, i) => ({
        tag: o.tag,
        label: o.label,
        outcomeToken: resolved.outcomeTokens[i],
        price: o.price,
      })),
    });
  }
  const allPools = entries.flatMap((e) => e.pools);
  console.log(
    `   OK: all ${entries.length} markets verified — single-select categorical, sUSDS, top-level; ` +
      `${allPools.length} pools to seed`
  );

  // ── Phase 0b: read live pool state ────────────────────────────────────────
  // On a first seed every pool is missing and every price comes from the
  // questions file. On a RE-seed the pools still exist at whatever price they
  // were left at, and that price — not the questions file — is what the mint
  // will execute against. See buildPoolAndBounds.
  console.log("\nPhase 0b: reading live pool state...");
  let existing = 0;
  let nonEmpty = 0;
  for (const p of allPools) {
    const outcome = new Token(CHAIN_ID, p.outcomeToken, 18, "OUT");
    const susds = new Token(CHAIN_ID, SUSDS_ADDRESS, 18, "SUSDS");
    p.poolAddress = Pool.getAddress(outcome, susds, FEE_TIER);
    const code = await provider.getCode(p.poolAddress);
    if (!code || code === "0x") {
      p.live = null;
      continue;
    }
    const pool = new ethers.Contract(p.poolAddress, POOL_ABI, provider);
    const [slot0, liquidity] = await Promise.all([pool.slot0(), pool.liquidity()]);
    if (slot0.sqrtPriceX96 === 0n) {
      p.live = null; // deployed but never initialised
      continue;
    }
    p.live = { sqrtPriceX96: slot0.sqrtPriceX96.toString(), tick: Number(slot0.tick) };
    p.liveLiquidity = liquidity;
    existing++;
    if (liquidity !== 0n) nonEmpty++;
  }
  console.log(
    `   ${existing}/${allPools.length} pools already exist and keep their last price` +
      ` (${allPools.length - existing} fresh)`
  );
  if (nonEmpty) {
    console.warn(
      `   WARNING: ${nonEmpty} of those already hold liquidity — this run mints a NEW position
` +
        "   on top rather than topping up. Check the progress log before going live."
    );
  }

  // ── Phase 1: size positions & solve for Q, per market ─────────────────────
  // Budget is split evenly across markets and Q is solved per market, NOT once
  // globally. With one global Q the sUSDS side explodes as a price approaches a
  // band edge, so the markets with the most confident favourites would eat the
  // budget. Solving per market puts every question on the same 2,000 sUSDS.
  //
  // Both sides of a position are linear in the outcome quantity at fixed ticks,
  // so one trial pass at Q0 gives the exact scale factor.
  console.log("\nPhase 1: sizing positions...");
  const budgetPerMarket = TOTAL_BUDGET / BigInt(entries.length);
  console.log(`   Budget per market: ${formatUnits(budgetPerMarket, 18)} sUSDS`);

  for (const e of entries) {
    let trialSusds = 0n;
    for (const p of e.pools) {
      p.meta = buildPoolAndBounds(p.outcomeToken, p.price, p.live);
      trialSusds += sizePosition(p.meta, Q0).susdsUsed;
    }
    // Capital for this market = one split of Q + the sUSDS side of every pool.
    const trialCapital = Q0 + trialSusds;
    e.Q = (Q0 * budgetPerMarket) / trialCapital;
    if (e.Q === 0n) throw new Error(`[${e.shortName}] solved Q is zero — raise TOTAL_BUDGET.`);
  }

  // Final pass at each market's Q.
  let sumSusds = 0n;
  console.log(
    "\n    #  mkt  outcome           seed    live    ticks                  outcome        sUSDS"
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
      // Equal Q means every pool binds at exactly Q, but take the max anyway so
      // the split can never come up short if the sizing ever stops being equal.
      if (s.outcomeUsed > e.splitAmount) e.splitAmount = s.outcomeUsed;
    }
    e.capital += e.splitAmount;
    for (const p of e.pools) {
      const drifted = Math.abs(p.meta.effectivePrice - p.price) > 0.0005;
      console.log(
        `   ${String(e.id).padStart(2)}  ${e.shortName.padEnd(4)} ${p.tag.padEnd(16)} ` +
          `${p.price.toFixed(3)}  ${p.meta.effectivePrice.toFixed(4)}` +
          `  [${p.meta.tickLower},${p.meta.tickUpper}]`.padEnd(23) +
          `${Number(formatUnits(p.outcomeUsed, 18)).toFixed(2).padStart(12)}` +
          `${Number(formatUnits(p.susdsUsed, 18)).toFixed(2).padStart(13)}` +
          (drifted ? "  <- live" : "")
      );
    }
    console.log(
      `       ${e.shortName} split ${Number(formatUnits(e.splitAmount, 18)).toFixed(2)} + ` +
        `pools ${Number(formatUnits(e.capital - e.splitAmount, 18)).toFixed(2)} = ` +
        `${Number(formatUnits(e.capital, 18)).toFixed(2)} sUSDS\n`
    );
  }

  const totalSplit = entries.reduce((a, e) => a + e.splitAmount, 0n);
  const grandTotal = totalSplit + sumSusds;
  console.log(
    `   Splits (mint): ${formatUnits(totalSplit, 18)} sUSDS over ${entries.length} markets\n` +
      `   sUSDS side   : ${formatUnits(sumSusds, 18)} sUSDS over ${allPools.length} pools\n` +
      `   GRAND TOTAL  : ${formatUnits(grandTotal, 18)} sUSDS (budget ${formatUnits(TOTAL_BUDGET, 18)})`
  );
  if (grandTotal > TOTAL_BUDGET) {
    console.warn("   WARNING: grand total exceeds budget — check rounding/sentinel.");
  }

  if (DRY_RUN) {
    console.log("\nDry run complete — set DRY_RUN = false to execute.");
    return;
  }

  // ── Phase 2: balance guard ────────────────────────────────────────────────
  const susds = new ethers.Contract(SUSDS_ADDRESS, erc20Abi, provider);
  const susdsBalance = await susds.balanceOf(wallet.address);
  console.log(`\nsUSDS balance: ${formatUnits(susdsBalance, 18)} | need: ${formatUnits(grandTotal, 18)}`);
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
  const splitDone = new Set(progressLog.filter((e) => e.kind === "split").map((e) => e.market.toLowerCase()));
  const poolDone = new Set(progressLog.filter((e) => e.kind === "pool").map((e) => e.outcomeToken.toLowerCase()));
  const save = () => fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progressLog, null, 2));

  // sUSDS is one side of every pool and the input to every split — approve both
  // spenders once for the whole programme.
  await ensureAllowance(SUSDS_ADDRESS, ROUTER_ADDRESS, totalSplit);
  await ensureAllowance(SUSDS_ADDRESS, POSITION_MANAGER_ADDRESS, sumSusds);

  // ── Phase 3: split + mint, market by market ───────────────────────────────
  console.log(`\nPhase 3: seeding ${allPools.length} pools across ${entries.length} markets\n`);
  let poolCount = 0;
  for (const e of entries) {
    console.log(`\n=== [${e.id}] ${e.shortName} ${e.topic} — ${e.market} ===`);

    if (splitDone.has(e.market.toLowerCase())) {
      console.log("  split already logged");
    } else {
      try {
        console.log(`  splitting ${formatUnits(e.splitAmount, 18)} sUSDS`);
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
        console.error(`  split failed for ${e.shortName}: ${err.message} — skipping its pools`);
        continue;
      }
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }

    for (const p of e.pools) {
      if (poolDone.has(p.outcomeToken.toLowerCase())) {
        console.log(`  ${p.tag} pool already logged`);
        poolCount++;
        continue;
      }
      console.log(`\n  --- ${e.shortName} ${p.tag} @ ${p.price.toFixed(3)} (${p.outcomeToken}) ---`);
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
          tag: p.tag,
          label: p.label,
          outcomeToken: p.outcomeToken,
          poolAddress: p.poolAddress,
          price: p.price,
          effectivePrice: p.meta.effectivePrice,
          preExisting: p.meta.live,
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
        console.log(`  Saved to ${PROGRESS_FILE}`);
      } catch (err) {
        console.error(`  ${e.shortName} ${p.tag} failed: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  console.log(`\nDone. ${poolCount}/${allPools.length} pools seeded. See ${PROGRESS_FILE}.`);
  if (poolCount < allPools.length) {
    console.log("   Re-run to retry the failures — logged splits and pools are skipped.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
