import { Percent, Token } from "@uniswap/sdk-core";
import { NonfungiblePositionManager, Pool, Position, TickMath } from "@uniswap/v3-sdk";
import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import { erc20Abi, formatUnits } from "viem";
import { MarketViewAbi } from "./abis/MarketViewAbi.js";
import { RouterAbi } from "./abis/RouterAbi.js";

// ─────────────────────────────────────────────────────────────────────────────
// Seeds the round-3 originality markets with 1,000 sUSDS across 196 Uniswap V3
// pools (98 repos x {DOWN, UP}).
//
// The two-level structure (a bundled multi-scalar parent, see
// create-originality-r3-markets.js for why):
//
//   Phase 1  ONE splitPosition(sUSDS, parent, 1000). A split of S mints S of every
//            outcome token of the parent: 1000 each of ORIG_R3_A / _B / _C (and of
//            its Invalid token). This is the only place sUSDS is spent.
//   Phase 2  per repo: splitPosition(sUSDS, child, X_i) -> X_i of DOWN, UP and
//            Invalid. Note arg 0 is sUSDS, the BASE collateral, even though what
//            actually gets pulled from the wallet is the repo's BUNDLE token —
//            Router._splitPosition derives that from parentCollectionId and calls
//            wrapped1155.transferFrom on it (src/Router.sol:58-62).
//   Phase 3  per repo: mint (DOWN, bundleToken) and (UP, bundleToken) positions at
//            the seed prices, band [MIN_PRICE, MAX_PRICE].
//
// Budget: every repo in a bundle shares that bundle token's 1,000 supply, so a
// repo's budget is B = 1000 / (repos in its bundle) — 1000/33 in Bundles A and B,
// 1000/32 in Bundle C. The remainder wei go to each bundle's first repo so the
// budgets sum to the bundle's supply exactly.
//
// Sizing: X_i is SOLVED per repo. Both sides of a position are linear in the
// outcome quantity at fixed ticks, so one trial pass at Q0 gives the exact
// collateral-per-outcome ratios r_down and r_up, and then
//
//     X_i = B / (1 + r_down + r_up)
//
// makes the child split and both collateral legs consume the repo's full B.
//
// Approvals: ~33 repos draw on the same bundle token, so it is approved ONCE per
// spender (Router for the child splits, PositionManager for the collateral legs)
// for that bundle's total need, and the allowance is polled back before use. A
// per-repo ensureAllowance on a shared token reads an allowance the previous repo
// is about to spend, and a lagging RPC can make it skip a needed approve.
//
// Idle by design (round 2 did the same): the parent's 1,000 Invalid tokens and
// each repo's X_i child Invalid tokens are never pooled. They come back on a merge.
//
//   node add-originality-r3-liquidity.js       # DRY_RUN = true, prints the table
//
// Before the markets exist (no MARKETS_FILE) the dry run is a PREVIEW: token
// addresses are placeholders, so pool orientation — and with it the tick rounding
// in the last few wei — can differ from the live run. Amounts agree to display
// precision; the live dry run after creation is the one to diff.
//
// PROGRESS_FILE is a RESUME LOG, NOT A RECORD — every split and pool already in it
// is skipped. Bump it to a new filename for any re-seed rather than editing or
// deleting the old one.
// ─────────────────────────────────────────────────────────────────────────────

// ── Config ──────────────────────────────────────────────────────────────────
const DRY_RUN = true; // ← set to false to send transactions

const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL; // Optimism
const CHAIN_ID = 10;

const SEED_FILE = "./originality-r3-seed.json";
const MARKETS_FILE = "./create-originality-r3-v2-execution.json";
const PROGRESS_FILE = "./add-originality-r3-v2-liquidity-execution.json";
const MAP_CACHE_FILE = "./originality-r3-v2-map-cache.json";

// Addresses (Optimism, chain 10)
const POSITION_MANAGER_ADDRESS = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const ROUTER_ADDRESS = "0x179d8F8c811B8C759c33809dbc6c5ceDc62D05DD";
const SUSDS_ADDRESS = "0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0";
const MARKET_FACTORY = "0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6";
const MARKET_VIEW = "0x336695ec9efbafd6322fb82eaadbcda02e38f348";
const UNISWAP_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";

// Uniswap V3 pool params used across every Seer pool in this repo, and by round 2.
const FEE_TIER = 100;
const TICK_SPACING = 1;

// The single parent split. Every bundle token's supply equals this.
const TOTAL_SUSDS = 1_000n * 10n ** 18n;

// Per-repo budgets within one bundle, summing exactly to TOTAL_SUSDS.
function perRepoBudgets(count) {
  const each = TOTAL_SUSDS / BigInt(count);
  const budgets = Array.from({ length: count }, () => each);
  budgets[0] += TOTAL_SUSDS - each * BigInt(count);
  return budgets;
}

// Liquidity band, in bundle tokens per child outcome token. See the seed file's
// `band`, and the note in snapshot-originality-r2-prices.js about why this is not
// round 2's minPrice = 0.
const MIN_PRICE = 0.02;
const MAX_PRICE = 0.98;

// Trial outcome quantity used to measure the (linear) collateral ratios.
const Q0 = 1_000n * 10n ** 18n;
const ONE = 10n ** 18n;

const DELAY_MS = 1500;
const CONCURRENCY = 8;

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
];
const UNISWAP_FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);
const marketView = new ethers.Contract(MARKET_VIEW, MarketViewAbi, provider);
const uniFactory = new ethers.Contract(UNISWAP_V3_FACTORY, UNISWAP_FACTORY_ABI, provider);
const router = new ethers.Contract(ROUTER_ADDRESS, RouterAbi, wallet);

const LN_1_0001 = Math.log(1.0001);

// ── Helpers ─────────────────────────────────────────────────────────────────
function sortTokens(a, b) {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

function priceToTick(price) {
  return Math.floor(Math.log(price) / LN_1_0001);
}

// Deterministic stand-in address for the preview mode.
function placeholder(label) {
  return ethers.getAddress(ethers.dataSlice(ethers.id(`originality-r3-preview:${label}`), 12));
}

async function retryTransaction(txFn, retries = 3, delayMs = 3000) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`    Attempt ${attempt}/${retries}...`);
      const tx = await txFn();
      console.log(`    Tx sent: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`    Confirmed in block ${receipt.blockNumber}`);
      return receipt;
    } catch (err) {
      lastError = err;
      console.warn(`    Attempt ${attempt} failed: ${(err.shortMessage || err.message || "").slice(0, 200)}`);
      if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

async function getBalance(token) {
  return await new ethers.Contract(token, erc20Abi, provider).balanceOf(wallet.address);
}

async function ensureAllowance(tokenAddress, spender, amount) {
  const ro = new ethers.Contract(tokenAddress, erc20Abi, provider);
  const current = await ro.allowance(wallet.address, spender);
  if (current >= amount) return;
  const token = new ethers.Contract(tokenAddress, erc20Abi, wallet);
  console.log(`    Approving ${tokenAddress} -> ${spender} for ${formatUnits(amount, 18)} ...`);
  await retryTransaction(() => token.approve(spender, amount));
  // RPC backends lag behind a confirmed approve; poll it back before relying on it.
  for (let i = 0; i < 10; i++) {
    if ((await ro.allowance(wallet.address, spender)) >= amount) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`allowance ${tokenAddress} -> ${spender} did not reach ${formatUnits(amount, 18)} after approving`);
}

async function mapConcurrent(items, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await worker(items[i], i);
      }
    })
  );
  return out;
}

// Build the Pool to size against, plus the tick range. `collateral` is the repo's
// bundle token, not sUSDS.
//
// `live` is the pool's on-chain slot0, or null if the pool has never been
// initialised. It is load-bearing on any re-seed: a drained pool still exists and
// keeps its last price, and createAndInitializePoolIfNecessary is a no-op on it,
// so the mint executes at the pool's OWN price whatever sqrtPriceX96 we pass.
// Fresh pool -> seed price; existing pool -> its price as given.
function buildPoolAndBounds(outcomeToken, collateral, price, live) {
  const [t0, t1] = sortTokens(outcomeToken, collateral);
  const isToken0Outcome = t0.toLowerCase() === outcomeToken.toLowerCase();
  // Pool price is token1/token0, i.e. collateral/outcome (= price) when the
  // outcome is token0, else outcome/collateral (= 1/price).
  const orientedPrice = isToken0Outcome ? price : 1 / price;
  const tickCurrent = live ? live.tick : priceToTick(orientedPrice);
  const sqrtPriceX96 = live ? live.sqrtPriceX96 : TickMath.getSqrtRatioAtTick(tickCurrent).toString();

  const orientedActual = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
  const effectivePrice = isToken0Outcome ? orientedActual : 1 / orientedActual;

  const pool = new Pool(
    new Token(CHAIN_ID, t0, 18, "T0"),
    new Token(CHAIN_ID, t1, 18, "T1"),
    FEE_TIER,
    sqrtPriceX96.toString(),
    "0",
    tickCurrent
  );

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

// For a given outcome-token quantity, the Position plus what it consumes. The
// outcome token is forced to be the binding side.
function sizePosition(meta, qOutcome) {
  const HUGE = (qOutcome + 1n) * 1000n;
  const position = Position.fromAmounts({
    pool: meta.pool,
    tickLower: meta.tickLower,
    tickUpper: meta.tickUpper,
    amount0: (meta.isToken0Outcome ? qOutcome : HUGE).toString(),
    amount1: (meta.isToken0Outcome ? HUGE : qOutcome).toString(),
    useFullPrecision: true,
  });
  const a0 = BigInt(position.mintAmounts.amount0.toString());
  const a1 = BigInt(position.mintAmounts.amount1.toString());
  return {
    position,
    amount0: a0,
    amount1: a1,
    outcomeUsed: meta.isToken0Outcome ? a0 : a1,
    collateralUsed: meta.isToken0Outcome ? a1 : a0,
  };
}

function loadJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// Resolve the parent and the 98 children on chain into one map.
async function resolveMap(seed, created) {
  const info = await marketView.getMarket(MARKET_FACTORY, created.parent.market);
  if (info.collateralToken.toLowerCase() !== SUSDS_ADDRESS.toLowerCase()) {
    throw new Error(`parent collateral ${info.collateralToken} != sUSDS`);
  }
  if (info.parentCollectionId !== ethers.ZeroHash) throw new Error("parent is itself conditional — expected top-level");
  const wrapped = Array.from(info.wrappedTokens).map(String);
  const outcomes = Array.from(info.outcomes).map(String);
  if (wrapped.length !== seed.bundles.length + 1) {
    throw new Error(`parent has ${wrapped.length} wrapped tokens, expected ${seed.bundles.length + 1}`);
  }
  seed.bundles.forEach((b, i) => {
    if (outcomes[i] !== b.label) throw new Error(`parent slot ${i} is "${outcomes[i]}", seed says "${b.label}"`);
  });
  const parent = { market: created.parent.market, outcomes, wrappedTokens: wrapped, invalidToken: wrapped[wrapped.length - 1] };

  const repos = await mapConcurrent(created.children, async (entry) => {
    const ci = await marketView.getMarket(MARKET_FACTORY, entry.market);
    if (ci.parentMarket.id.toLowerCase() !== parent.market.toLowerCase()) {
      throw new Error(`${entry.market}: parentMarket ${ci.parentMarket.id} is not the round-3 parent`);
    }
    const seedRow = seed.children.find((c) => c.repo === entry.repo);
    if (!seedRow) throw new Error(`${entry.market}: repo ${entry.repo} not in the seed file`);
    if (ci.marketName !== seedRow.marketName) throw new Error(`${entry.market}: on-chain name does not match the seed`);
    const pOut = Number(ci.parentOutcome);
    if (pOut !== seedRow.parentOutcome) throw new Error(`${entry.market}: parentOutcome ${pOut}, seed says ${seedRow.parentOutcome}`);
    const cw = Array.from(ci.wrappedTokens).map(String);
    if (cw.length !== 3) throw new Error(`${entry.market}: ${cw.length} wrapped tokens, expected 3`);
    // wrappedTokens order is [DOWN, UP, Invalid].
    return { ...rowBase(seedRow), childMarket: entry.market, bundleToken: wrapped[pOut], downToken: cw[0], upToken: cw[1], invalidToken: cw[2] };
  });
  return { parent, repos };
}

function rowBase(seedRow) {
  return {
    parentOutcome: seedRow.parentOutcome,
    indexInBundle: seedRow.indexInBundle,
    repo: seedRow.repo,
    seedDown: seedRow.seedDown,
    seedUp: seedRow.seedUp,
  };
}

function previewMap(seed) {
  const wrapped = [...seed.bundles.map((b) => placeholder(b.tokenName)), placeholder("parent-invalid")];
  const parent = { market: placeholder("parent"), outcomes: seed.parent.outcomes, wrappedTokens: wrapped, invalidToken: wrapped[3] };
  const repos = seed.children.map((c) => ({
    ...rowBase(c),
    childMarket: placeholder(`child:${c.repo}`),
    bundleToken: wrapped[c.parentOutcome],
    downToken: placeholder(c.tokenNames[0]),
    upToken: placeholder(c.tokenNames[1]),
    invalidToken: placeholder(`${c.repo}:invalid`),
  }));
  return { parent, repos };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!RPC_URL) throw new Error("RPC_URL missing from .env");
  if (!WALLET_PRIVATE_KEY) throw new Error("PRIVATE_KEY missing from .env");
  if (!fs.existsSync(SEED_FILE)) throw new Error(`${SEED_FILE} not found`);

  const seed = JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));
  const preview = !fs.existsSync(MARKETS_FILE);
  if (preview && !DRY_RUN) throw new Error(`${MARKETS_FILE} not found — run create-originality-r3-markets.js first.`);

  console.log(`\n${DRY_RUN ? (preview ? "PREVIEW (markets not created yet)" : "DRY RUN") : "LIVE RUN"} — originality round 3 liquidity`);
  console.log(`   wallet : ${wallet.address}`);

  // ── Phase 0: resolve the set on chain ────────────────────────────────────
  let map;
  if (preview) {
    map = previewMap(seed);
    console.log(`Phase 0: ${MARKETS_FILE} absent — sizing against placeholder addresses.\n`);
  } else {
    const created = JSON.parse(fs.readFileSync(MARKETS_FILE, "utf8"));
    if (!created.parent?.market) throw new Error("no parent market in the creation log");
    if (created.children.length !== seed.children.length) {
      throw new Error(`creation log has ${created.children.length} children, seed has ${seed.children.length}`);
    }
    map = loadJson(MAP_CACHE_FILE, null);
    if (!map || map.parent?.market?.toLowerCase() !== created.parent.market.toLowerCase() || map.repos?.length !== seed.children.length) {
      console.log(`Phase 0: resolving the parent and ${created.children.length} children on chain...`);
      map = await resolveMap(seed, created);
      fs.writeFileSync(MAP_CACHE_FILE, JSON.stringify(map, null, 2));
      console.log(`   resolved, cached to ${MAP_CACHE_FILE}\n`);
    } else {
      console.log(`Phase 0: using cached map from ${MAP_CACHE_FILE} (${map.repos.length} repos)\n`);
    }
  }
  map.repos.sort((a, b) => a.parentOutcome - b.parentOutcome || a.indexInBundle - b.indexInBundle);
  if (map.repos.length !== 98) throw new Error(`resolved ${map.repos.length} repos, expected 98`);

  // Per-repo budgets: each bundle's 1,000 tokens shared across its repos.
  const budgetsByBundle = seed.bundles.map((b) => perRepoBudgets(b.repos.length));
  for (const r of map.repos) r.budget = budgetsByBundle[r.parentOutcome][r.indexInBundle];
  seed.bundles.forEach((b, i) => {
    const sum = map.repos.filter((r) => r.parentOutcome === i).reduce((a, r) => a + r.budget, 0n);
    if (sum !== TOTAL_SUSDS) throw new Error(`${b.label} budgets sum to ${sum}, expected ${TOTAL_SUSDS}`);
  });

  console.log(`   parent : ${map.parent.market}  split ${formatUnits(TOTAL_SUSDS, 18)} sUSDS`);
  seed.bundles.forEach((b, i) => {
    console.log(
      `   ${b.label} (${b.tokenName}) ${map.parent.wrappedTokens[i]}: ${b.repos.length} repos, ` +
        `${formatUnits(budgetsByBundle[i][1], 18)} each`
    );
  });
  console.log(`   band   : [${MIN_PRICE}, ${MAX_PRICE}]\n`);

  const progress = loadJson(PROGRESS_FILE, []);
  const done = new Set(progress.map((e) => `${e.kind}:${e.key ?? ""}`));

  // ── Phase 0b: read live pool state, then size every position ─────────────
  console.log("Phase 0b: reading pool state and sizing positions...");
  const plans = await mapConcurrent(map.repos, async (r) => {
    const sides = [];
    for (const [label, outcomeToken, price] of [
      ["DOWN", r.downToken, r.seedDown],
      ["UP", r.upToken, r.seedUp],
    ]) {
      let poolAddress = ethers.ZeroAddress;
      let live = null;
      if (!preview) {
        const [t0, t1] = sortTokens(outcomeToken, r.bundleToken);
        poolAddress = await uniFactory.getPool(t0, t1, FEE_TIER);
        if (poolAddress !== ethers.ZeroAddress) {
          const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
          const [slot0, liq] = await Promise.all([pool.slot0(), pool.liquidity()]);
          live = { sqrtPriceX96: slot0.sqrtPriceX96.toString(), tick: Number(slot0.tick), liquidity: liq.toString() };
        }
      }
      const meta = buildPoolAndBounds(outcomeToken, r.bundleToken, price, live);
      // Trial pass: at fixed ticks both sides are linear in the outcome quantity,
      // so one measurement gives the exact collateral-per-outcome ratio.
      const trial = sizePosition(meta, Q0);
      if (trial.outcomeUsed === 0n) throw new Error(`${r.repo} ${label}: trial position consumes no outcome token`);
      const ratioScaled = (trial.collateralUsed * ONE) / trial.outcomeUsed;
      sides.push({ label, outcomeToken, price, poolAddress, meta, ratioScaled });
    }

    // X = B / (1 + r_down + r_up), so the child split plus both collateral legs
    // consume exactly this repo's B bundle tokens.
    const B = r.budget;
    const denomScaled = ONE + sides[0].ratioScaled + sides[1].ratioScaled;
    let candidate = (B * ONE) / denomScaled;

    // Uniswap's mintAmounts rounds the required amounts UP, so a position can ask
    // for a wei or two more outcome token than `candidate` — which would leave the
    // mint 1 wei short of what the child split produced and revert. So: split
    // max(candidate, what the pools actually ask for), then confirm B still covers
    // it, trimming `candidate` if rounding pushed it over.
    let splitAmount = candidate;
    let collateralTotal = 0n;
    let used = 0n;
    for (let attempt = 0; attempt < 4; attempt++) {
      let maxOutcome = 0n;
      collateralTotal = 0n;
      for (const s of sides) {
        s.sized = sizePosition(s.meta, candidate);
        if (s.sized.outcomeUsed > maxOutcome) maxOutcome = s.sized.outcomeUsed;
        collateralTotal += s.sized.collateralUsed;
      }
      splitAmount = candidate > maxOutcome ? candidate : maxOutcome;
      used = splitAmount + collateralTotal;
      if (used <= B) break;
      // Overshoot is only ever a handful of wei; back off by it plus a margin.
      candidate -= used - B + 1_000n;
    }
    if (used > B) {
      throw new Error(`${r.repo}: sizing wants ${formatUnits(used, 18)} of ${formatUnits(B, 18)} bundle tokens`);
    }
    for (const s of sides) {
      if (s.sized.outcomeUsed > splitAmount) {
        throw new Error(`${r.repo} ${s.label}: pool needs ${s.sized.outcomeUsed} outcome tokens but the split mints ${splitAmount}`);
      }
    }
    return { ...r, sides, splitAmount, collateralTotal, used, B };
  });

  // ── Capital table ────────────────────────────────────────────────────────
  console.log(
    "\n bundle #  repo                                      seedDOWN  seedUP    split   collDOWN   collUP    used / B"
  );
  let worstUnused = 0n;
  for (const p of plans) {
    const unused = p.B - p.used;
    if (unused > worstUnused) worstUnused = unused;
    console.log(
      `  ${seed.bundles[p.parentOutcome].label.slice(-1)}  ${String(p.indexInBundle).padStart(2)}  ${p.repo.padEnd(41)} ` +
        `${p.seedDown.toFixed(4)}    ${p.seedUp.toFixed(4)}  ` +
        `${Number(formatUnits(p.splitAmount, 18)).toFixed(3).padStart(7)}  ` +
        `${Number(formatUnits(p.sides[0].sized.collateralUsed, 18)).toFixed(3).padStart(8)}  ` +
        `${Number(formatUnits(p.sides[1].sized.collateralUsed, 18)).toFixed(3).padStart(8)}  ` +
        `${Number(formatUnits(p.used, 18)).toFixed(4).padStart(8)} / ${Number(formatUnits(p.B, 18)).toFixed(4)}`
    );
  }

  // What each spender needs per bundle token.
  const needByBundle = seed.bundles.map((_, i) => {
    const ps = plans.filter((p) => p.parentOutcome === i);
    return {
      router: ps.reduce((a, p) => a + p.splitAmount, 0n),
      positionManager: ps.reduce((a, p) => a + p.collateralTotal, 0n),
    };
  });

  const preExisting = plans.flatMap((p) => p.sides).filter((s) => s.meta.live).length;
  const offSeed = plans.flatMap((p) => p.sides).filter((s) => Math.abs(s.meta.effectivePrice - s.price) > 5e-4);

  console.log(`\n  GRAND TOTAL sUSDS committed (one parent split): ${formatUnits(TOTAL_SUSDS, 18)}`);
  seed.bundles.forEach((b, i) => {
    const n = needByBundle[i];
    console.log(
      `     ${b.tokenName}: child splits ${Number(formatUnits(n.router, 18)).toFixed(4)} + pool collateral ` +
        `${Number(formatUnits(n.positionManager, 18)).toFixed(4)} = ${Number(formatUnits(n.router + n.positionManager, 18)).toFixed(4)} of 1000`
    );
  });
  console.log(`  pools to seed              : ${plans.length * 2}`);
  console.log(`  pools that already exist   : ${preExisting} (their live price is used, not the seed price)`);
  console.log(`  worst per-repo idle tokens : ${Number(formatUnits(worstUnused, 18)).toFixed(6)} (integer rounding)`);
  console.log(
    `  unpooled by design         : ${formatUnits(TOTAL_SUSDS, 18)} parent Invalid + ` +
      `${Number(formatUnits(plans.reduce((a, p) => a + p.splitAmount, 0n), 18)).toFixed(2)} child Invalid tokens`
  );
  if (offSeed.length) {
    console.log(`\n  ${offSeed.length} pool(s) priced >0.0005 off their seed (pre-existing pools):`);
    for (const s of offSeed.slice(0, 10)) {
      console.log(`     ${s.label.padEnd(4)} seed ${s.price.toFixed(4)} live ${s.meta.effectivePrice.toFixed(4)}`);
    }
  }

  const susds = await getBalance(SUSDS_ADDRESS);
  const eth = await provider.getBalance(wallet.address);
  console.log(`\n  wallet sUSDS : ${formatUnits(susds, 18)}`);
  console.log(`  wallet ETH   : ${ethers.formatEther(eth)}`);
  if (!done.has("parentSplit:0") && susds < TOTAL_SUSDS) {
    console.warn(`  WARNING: sUSDS balance is below the ${formatUnits(TOTAL_SUSDS, 18)} to be split.`);
  }

  if (DRY_RUN) {
    console.log(`\n${preview ? "Preview" : "Dry run"} complete — set DRY_RUN = false to seed.`);
    return;
  }

  const save = () => fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));

  // ── Phase 1: split sUSDS on the parent ───────────────────────────────────
  console.log(`\nPhase 1: parent split...`);
  if (done.has("parentSplit:0")) {
    console.log(`   already logged — skipping.`);
  } else {
    console.log(`\n  splitting ${formatUnits(TOTAL_SUSDS, 18)} sUSDS on ${map.parent.market}`);
    await ensureAllowance(SUSDS_ADDRESS, ROUTER_ADDRESS, TOTAL_SUSDS);
    const receipt = await retryTransaction(() => router.splitPosition(SUSDS_ADDRESS, map.parent.market, TOTAL_SUSDS));
    progress.push({
      kind: "parentSplit",
      key: "0",
      market: map.parent.market,
      amount: TOTAL_SUSDS.toString(),
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      timestamp: new Date().toISOString(),
    });
    save();
    console.log(`     done — ${formatUnits(TOTAL_SUSDS, 18)} of each of the ${map.parent.wrappedTokens.length} parent outcome tokens minted.`);
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  // One approval per bundle token and spender, for that bundle's whole need.
  // Only the part still to be spent is approved on a resume.
  for (let i = 0; i < seed.bundles.length; i++) {
    const ps = plans.filter((p) => p.parentOutcome === i);
    const routerLeft = ps.filter((p) => !done.has(`childSplit:${p.repo}`)).reduce((a, p) => a + p.splitAmount, 0n);
    const pmLeft = ps
      .flatMap((p) => p.sides.filter((s) => !done.has(`pool:${p.repo}:${s.label}`)))
      .reduce((a, s) => a + s.sized.collateralUsed, 0n);
    const token = map.parent.wrappedTokens[i];
    console.log(`\n  ${seed.bundles[i].tokenName}: approving Router ${formatUnits(routerLeft, 18)}, PositionManager ${formatUnits(pmLeft, 18)}`);
    if (routerLeft > 0n) await ensureAllowance(token, ROUTER_ADDRESS, routerLeft);
    if (pmLeft > 0n) await ensureAllowance(token, POSITION_MANAGER_ADDRESS, pmLeft);
  }

  // ── Phase 2: split each repo's bundle token on its child ─────────────────
  console.log(`\nPhase 2: ${plans.length} child splits...`);
  let splitCount = 0;
  for (const p of plans) {
    const key = p.repo;
    if (done.has(`childSplit:${key}`)) {
      splitCount++;
      continue;
    }
    console.log(`\n  ${seed.bundles[p.parentOutcome].label}[${p.indexInBundle}] ${p.repo}: split ${formatUnits(p.splitAmount, 18)}`);
    try {
      const bal = await getBalance(p.bundleToken);
      if (bal < p.splitAmount) {
        throw new Error(`holds ${formatUnits(bal, 18)} of the bundle token, needs ${formatUnits(p.splitAmount, 18)}`);
      }
      // arg 0 is sUSDS (the base collateral); the Router pulls the bundle token
      // itself via parentWrappedOutcome(). See src/Router.sol:_splitPosition.
      const receipt = await retryTransaction(() => router.splitPosition(SUSDS_ADDRESS, p.childMarket, p.splitAmount));
      progress.push({
        kind: "childSplit",
        key,
        parentOutcome: p.parentOutcome,
        repo: p.repo,
        market: p.childMarket,
        amount: p.splitAmount.toString(),
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        timestamp: new Date().toISOString(),
      });
      save();
      splitCount++;
    } catch (err) {
      console.error(`    FAILED: ${(err.shortMessage || err.message || "").slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }
  console.log(`\n   ${splitCount}/${plans.length} child splits done.`);

  // ── Phase 3: mint the 196 positions ──────────────────────────────────────
  console.log(`\nPhase 3: minting ${plans.length * 2} positions...`);
  let poolCount = 0;
  const failures = [];

  for (const p of plans) {
    for (const s of p.sides) {
      const key = `${p.repo}:${s.label}`;
      if (done.has(`pool:${key}`)) {
        poolCount++;
        continue;
      }
      console.log(
        `\n  ${seed.bundles[p.parentOutcome].label}[${p.indexInBundle}] ${p.repo} ${s.label} @ ${s.meta.effectivePrice.toFixed(4)}` +
          `  outcome ${formatUnits(s.sized.outcomeUsed, 18)} / collateral ${formatUnits(s.sized.collateralUsed, 18)}`
      );
      try {
        await ensureAllowance(s.outcomeToken, POSITION_MANAGER_ADDRESS, s.sized.outcomeUsed);

        const { calldata, value } = NonfungiblePositionManager.addCallParameters(s.sized.position, {
          recipient: wallet.address,
          createPool: true, // create + initialise the pool if needed, then mint
          slippageTolerance: new Percent(50, 10_000), // 0.5%
          deadline: Math.floor(Date.now() / 1000) + 60 * 20,
        });
        const receipt = await retryTransaction(() =>
          wallet.sendTransaction({ to: POSITION_MANAGER_ADDRESS, data: calldata, value })
        );

        progress.push({
          kind: "pool",
          key,
          parentOutcome: p.parentOutcome,
          repo: p.repo,
          market: p.childMarket,
          side: s.label,
          outcomeToken: s.outcomeToken,
          collateralToken: p.bundleToken,
          poolAddress: s.poolAddress === ethers.ZeroAddress ? null : s.poolAddress,
          seedPrice: s.price,
          effectivePrice: s.meta.effectivePrice,
          preExisting: s.meta.live,
          tickLower: s.meta.tickLower,
          tickUpper: s.meta.tickUpper,
          amount0: s.sized.amount0.toString(),
          amount1: s.sized.amount1.toString(),
          outcomeUsed: s.sized.outcomeUsed.toString(),
          collateralUsed: s.sized.collateralUsed.toString(),
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          timestamp: new Date().toISOString(),
        });
        save();
        poolCount++;
      } catch (err) {
        console.error(`    FAILED: ${(err.shortMessage || err.message || "").slice(0, 200)}`);
        failures.push(`${p.repo} ${s.label}`);
      }
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  const susdsAfter = await getBalance(SUSDS_ADDRESS);
  console.log(`\n--- Summary ---`);
  console.log(`   child splits : ${splitCount}/${plans.length}`);
  console.log(`   pools seeded : ${poolCount}/${plans.length * 2}`);
  console.log(`   wallet sUSDS : ${formatUnits(susds, 18)} -> ${formatUnits(susdsAfter, 18)}`);
  if (failures.length) {
    console.log(`   failed       : ${failures.length} — re-run to retry only these`);
    failures.slice(0, 20).forEach((f) => console.log(`      - ${f}`));
  }
  console.log(`\nProgress log: ${PROGRESS_FILE}`);
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
