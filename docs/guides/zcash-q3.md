# Guide: Zcash Q3 2026 CDRGP markets on Optimism

> **Status: HISTORICAL.** live and seeded at per-proposal prices since 2026-08-24; unresolved  
> Machine-readable: [`lifecycle/zcash-q3.json`](../../lifecycle/zcash-q3.json)  
> Run logs: [`archive/runs/zcash-q3/`](../../archive/runs/zcash-q3/)  
> The scripts named below are **frozen** - do not edit them; a new campaign gets a new script.  
> Any claim in this guide about a script's `DRY_RUN` value is **not authoritative**: run `npm run audit:dryrun`.

Read this before running anything in the `*-zcash-*` scripts. Covers why the markets
are shaped the way they are, the create → seed → withdraw sequence, the numbers each
dry run produced on 2026-08-18, and the hazards specific to this market set.

> **Status: markets created 2026-08-19, liquidity seeded 2026-08-22, drained 2026-08-24.**
> All 37 markets exist on Optimism and are logged in `create-zcash-markets-execution.json`
> (37/37 created and verified, 0 failures, 64,068,263 gas, 0.0000642 ETH all-in).
> **Step 2 ran live 2026-08-22 at `TOTAL_BUDGET = 20,000 sUSDS`**: 74/74 pools seeded,
> 0 failures, exactly 20,000.000000 sUSDS spent (24,552.02 → 4,552.02), 0.000409 ETH gas.
> Logged in `add-zcash-liquidity-execution.json` (37 splits + 74 pools).
> **Steps 3, 4 and 5 all ran live 2026-08-24.** 74/74 positions withdrawn, 37/37 markets
> merged back to sUSDS, then **re-seeded at per-proposal prices**: 74/74 pools, 0 failures,
> 20,007.43 sUSDS deployed (24,551.44 → 4,544.01), ~0.00013 ETH gas over ~370 tx. The
> uniform 0.55 is gone — `yesPrice` now runs 0.16–0.97, mean 0.62. Logged in
> `reseed-zcash-liquidity-execution.json`.

## What this is

37 binary prediction markets, one per proposal in the Zcash Q3 2026
[Coinholder-Directed Retroactive Grants Program](https://forum.zcashcommunity.com/t/30-day-review-period-coinholder-directed-retroactive-grants-program-q3/57056)
($9,014,383.20 requested), supporting
[Seer's forecasting pilot](https://forum.zcashcommunity.com/t/seer-prediction-markets-forecasting-q3-2026-coinholder-retroactive-grant-approvals/57063).

Each market is a **categorical market with outcomes `["Yes", "No"]`**; the factory
appends `Invalid result` as a third slot, so every market has 3 outcome slots and
3 wrapped ERC20s. YES seeds at 0.55 (the prior round's approval base rate), NO at 0.45.

The question text is **Seer's published pilot template, verbatim**:

```
Will <title> be approved in the Q3 2026 Coinholder-Directed Retroactive Grants poll?
```

No applicant name, and no "Zcash" before "Coinholder-Directed" — an earlier draft added
both and they were removed to match the spec. All 37 titles are unique on their own, so
the near-collisions (#27 vs #33 Ironwood, #34 vs #35 Orchard) still produce distinct
Reality question ids.

### Why 37 markets and not one 37-outcome market

The tempting shortcut is a single multi-categorical market, the way the Gnosis PD
market handles 33 assets in one pool. It is wrong here, and **not** for gas reasons.

Grant approvals are independent and non-exclusive — a 55% base rate means roughly
20 of 37 approvals happen at once. Both aggregating market types normalise payouts
across winners:

| Type | Payout rule | Source |
|---|---|---|
| Multi-categorical | every selected outcome gets 1, so k winners each pay 1/k | `src/RealityProxy.sol:109-112` |
| Multi-scalar | outcome i pays `value_i / Σ value` | `src/RealityProxy.sol:172-182` |

Under either, a proposal that is *certain* to be approved would trade near **0.05,
not 1.0**. Prices would read as "share of the approvals", not probability of approval,
which is exactly the number the pilot exists to publish. Only a per-question binary
makes price == P(approved).

## Files

| File | Role |
|---|---|
| `zcash-q3-proposals.json` | Ballot snapshot — the 37 proposals, `shortName`, requested USD, tier, seeded `yesPrice`. **The only file you should normally edit.** |
| `create-zcash-markets.js` | Creates one binary categorical market per proposal. Writes `create-zcash-markets-execution.json`. |
| `add-zcash-liquidity.js` | Splits sUSDS and seeds the YES + NO Uniswap V3 pools. Reads the creation log, writes `add-zcash-liquidity-execution.json`. |
| `withdraw-zcash-liquidity.js` | Removes 100% of liquidity from every Zcash pool and collects fees. Writes `withdraw-zcash-liquidity-execution.json`. |
| `merge-zcash-positions.js` | Merges the full {YES, NO, Invalid} set per market back into sUSDS. Writes `merge-zcash-positions-execution.json`. |
| `reseed-zcash-liquidity.js` | Re-seeds the existing pools and position NFTs at new prices, moving each pool's price with a swap first. Writes `reseed-zcash-liquidity-execution.json`. |
| `check-zcash-pools.js` | Read-only. Live price + liquidity of every pool against the price it was last seeded at. |

Creation and liquidity are deliberately separate: markets are immutable and permanent,
pools are disposable and re-seedable. Keeping them apart means a pricing mistake costs
a withdraw-and-reseed, not a rebuilt market set.

## Prerequisites

`.env` needs `PRIVATE_KEY` and `RPC_URL` (Optimism). `RPC_URL` is already the Optimism
endpoint used by the octant scripts — all three scripts assert `chainId == 10` and abort
otherwise.

Addresses (verified live on 2026-08-18, all identical to `add-octant-liquidity.js`):

```
MarketFactory  0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6   collateralToken() == sUSDS
MarketView     0x336695ec9efbafd6322fb82eaadbcda02e38f348
Router         0x179d8F8c811B8C759c33809dbc6c5ceDc62D05DD
sUSDS          0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0
NFPM           0xC36442b4a4522E871399CD717aBDD847Ab11FE88
arbitrator     0x5AFa42b30955f137e10f89dfb5EF1542a186F90e
realitio       0x0eF940F7f053a2eF5D6578841072488aF0c7d89A
```

`questionTimeout` is **302400s (3.5 days)**. A market is not finalised until 3.5 days
after its first uncontested Reality answer, so a 2026-09-30 opening means payouts land
around 2026-10-03 at the earliest.

## Step 0 — the ballot was NOT frozen (deliberate)

The markets were created on 2026-08-19 against the **review-period list**, so that
trading could open 2026-08-20 as Seer's pilot schedule requires. `ballotFrozenAt` is
still `null` (accurately — the ballot does not freeze until 2026-09-16 20:00 UTC); the
decision is recorded in `createdAgainstReviewListAt` / `createdAgainstReviewListNote`.
`create-zcash-markets.js` prints a warning while `ballotFrozenAt` is null. That warning
was read and accepted, not silenced. The tradeoff it describes is real:

- The list in the JSON is the **review-period** list. Proposals can be withdrawn until
  the review period closes on 2026-09-16 20:00 UTC.
- Seer markets are immutable. A withdrawn proposal cannot be removed from a created
  market — the PD v1→v2 rebuild in `gnosis-pd.md` is what fixing this
  looks like.

A proposal withdrawn between now and the freeze therefore resolves **Invalid** — which
is Seer's own stated rule, but see hazard #1 before seeding pools. If you ever build a
second market set, re-read the forum post, correct any title/applicant/amount drift, and
set `ballotFrozenAt` to the ISO date you confirmed it before creating.

The proposal data has been validated against the forum's own tier totals and reconciles
exactly: 14 under $25k = $155,741.20, 12 mid = $821,650, 11 over $150k = $8,036,992,
total $9,014,383.20.

## Step 1 — create the markets

```bash
node create-zcash-markets.js          # DRY_RUN = true
```

The dry run does all of this before printing a table:

- asserts chain 10 and that `factory.collateralToken() == sUSDS`
- validates unique ids, `shortName`s, token names and question texts
- rejects `"`, `\` and `␟` in any question text — Reality interpolates the title into a
  JSON template, so a raw quote breaks parsing
- checks every token name against the 31-byte `toString31` limit (longest here is
  `ZQ3ZEBRACONSENSUSYES`, 20 bytes). Note `toString31` *reverts* above 31 bytes
  (`require(length < 32)`, `src/MarketFactory.sol:448`) — it does not truncate.
- **precomputes each Reality `question_id` exactly as the factory will**
  (`src/MarketFactory.sol:378`) and checks Reality for a pre-existing one

That last check is the important one. If a question with the same content hash already
exists, the factory **reuses it** rather than asking a new one, which would silently bind
two markets to one question. All 37 were confirmed collision-free.

Measured on the 2026-08-18 dry run:

```
avg gas/market  1,774,984
total L2 gas   65,674,426 over 37 tx
L2 gas cost    ~0.0000657 ETH at 0.001 gwei   (EXCLUDES the Optimism L1 data fee)
```

Then set `DRY_RUN = false` and re-run. Each market is created, the address read from
the `NewMarket` event, and verified via MarketView (outcomes `[Yes, No, Invalid result]`,
sUSDS collateral, top-level, 3 wrapped tokens, 1 question, templateId 2) before being
appended to `create-zcash-markets-execution.json`. **The run is resumable** — proposals
already in the log are skipped, so re-running retries only failures.

### Parameters worth a decision before you go live

| Constant | Default | Note |
|---|---|---|
| `OPENING_TIME_ISO` | `2026-08-19T00:00:00Z` | **In the past — all 37 questions are answerable right now, by design.** Answering is gated operationally (see `answer-octant-markets.js`), not at the contract level. Reality allows a past `opening_ts`; `stateOpen` only requires `opening_ts <= block.timestamp` (`RealityETH-3.0.sol:187`). Pinned to a fixed instant rather than `Date.now()` so a resumed run derives the same question ids. |
| `MIN_BOND` | 0.005 ETH | The octant market uses 0.0005. Across 37 markets that is a cheap griefing surface, so this defaults to 10x. Raising it also raises the cost of correcting a wrong answer. |
| `TOKEN_PREFIX` | `ZQ3` | Produces `ZQ3ZODLYES` / `ZQ3ZODLNO`. |

## Step 2 — seed the YES/NO pools

```bash
node add-zcash-liquidity.js           # DRY_RUN = true
```

Per market: split `Q` sUSDS on the market (yielding `Q` YES + `Q` NO + `Q` Invalid),
then create, initialise and mint the YES/sUSDS and NO/sUSDS pools.

**Budget is allocated per market, not per token quantity.** With a single global `Q`,
the sUSDS side explodes as a price nears a band edge — a market seeded at 0.20 ate
~200 sUSDS against ~94 for one at 0.55, i.e. the most capital went to the proposals we
were most confident about. Solving `Q` per market puts every proposal on the same
budget whatever its prior. Verified in the dry run: markets at 0.20, 0.50, 0.55 and
0.80 all land on exactly 100.00 sUSDS.

**Executed 2026-08-22** with `TOTAL_BUDGET = 20,000 sUSDS` across 37 markets:

```
budget/market     540.54 sUSDS
at yesPrice 0.55:  Q = 139.45   YES pool 247.47 sUSDS   NO pool 153.63 sUSDS
splits (mint)    5,159.61 sUSDS over 37 markets
sUSDS side      14,840.39 sUSDS over 74 pools
GRAND TOTAL     20,000.00 sUSDS
```

Every one of the 37 markets landed on exactly 540.54 sUSDS, which is the per-market
budget solve working as intended. The earlier 3,700 sUSDS sizing (100/market, Q = 25.80)
was never deployed — it exists only in the 2026-08-18 dry run.

Range is `[0.02, 0.98]` sUSDS per outcome token — far tighter than the octant/L1 bands,
because a binary outcome token can only ever be worth between 0 and 1.

Both pools use the same outcome quantity `Q`, which is what makes the split exact:
every token the split produces gets deployed, nothing left over.

The live run is **resumable at both levels** — splits and pool mints are logged
separately, so a market whose split succeeded but whose NO mint failed will not be
re-split on the next run. (This is stricter than `add-octant-liquidity.js`, which infers
"split already done" from whether the progress file is non-empty — a heuristic that does
not survive 37 markets.)

Expect roughly **187 transactions**: 2 sUSDS approvals + 37 splits + 74 outcome-token
approvals + 74 mints. The live run matched that and cost **0.000409 ETH** all-in at
0.001 gwei — L1 data fee included, since that is a measured balance delta.

## Step 3 — withdraw

```bash
node withdraw-zcash-liquidity.js      # DRY_RUN = true
```

Derives scope from the creation log, resolves every wrapped token **from chain** (not
from the log), and matches them against the wallet's Uniswap position NFTs. Invalid
pools are included in the match set even though step 2 never seeds one, so "withdraw
all" stays true if one is ever added by hand.

Verified against the live wallet **after step 2**: it enumerated all 494 position NFTs
(420 pre-existing + the 74 minted here) and matched **74 Zcash positions, all with
liquidity > 0** — 37 YES + 37 NO, one pair per market. Before step 2 ran it correctly
reported 0 matches. This dry run is the best end-to-end check that seeding worked.

Positions already at zero liquidity are skipped and reported separately; any residual
uncollected fees on those need a separate collect.

**This returns YES/NO tokens + sUSDS to the wallet — it does not convert the outcome
tokens back to sUSDS.** That is step 4.

**Executed 2026-08-24**: 74/74 positions removed, 0 failures, one transient
`nonce has already been used` that the built-in retry absorbed. The re-run dry check
reported "74 matched, 0 with liquidity". The emptied NFTs are deliberately **not**
burned (no `burnToken: true`) — step 5 refunds those same tokenIds.

## Step 4 — merge the outcome tokens back to sUSDS

```bash
node merge-zcash-positions.js         # DRY_RUN = true
```

Merging needs a **complete set — {YES, NO, Invalid}**. Invalid was never pooled, but
every split minted it, so it is already in the wallet. The mergeable amount per market
is `min(YES, NO, Invalid)`: if a market traded, the surplus side is stranded in the
wallet until the market resolves. That shortfall is the whole reason to read the dry-run
table before executing (the PD v1 case in `gnosis-pd.md` recovered 0.784 of
an expected 5.6).

**Executed 2026-08-24.** Only 4 of 37 markets had traded at all (GRANTSHUB, BONUSORCHARD,
VALARIRONWOOD, ZODL — each by a few ticks), so the shortfall was tiny:

```
recovered by merge   5,159.44 sUSDS over 37 markets
stranded outcome     1.354 tokens across those 4 markets
wallet sUSDS         4,552.02 → 24,551.44   (was 24,552.02 before seeding)
round-trip cost      0.58 sUSDS + gas
```

## Step 5 — re-seed at new prices

```bash
node reseed-zcash-liquidity.js        # DRY_RUN = true
```

**Re-running `add-zcash-liquidity.js` with different prices does not work.** All 74 pools
already exist and are initialised. `createAndInitializePoolIfNecessary` is a no-op on a
live pool, so a re-run computes amounts for the new price and mints them into a pool
still sitting at the old one — wrong ratio, or a slippage revert. In Uniswap V3 **only a
swap moves price**; adding liquidity never does. Draining a pool does not reset it either:
after step 3 every pool still reports its 0.55 tick with zero liquidity behind it.

So the re-seed does three transactions per pool:

1. **dust** — `increaseLiquidity` a sliver (`DUST_Q`, 0.02 outcome tokens) into the pool's
   existing, now-empty tokenId. This is not optional: Uniswap's `SwapRouter` callback has
   `require(amount0Delta > 0 || amount1Delta > 0)` — *"swaps entirely within 0-liquidity
   regions are not supported"* — and a fully drained pool produces exactly `(0, 0)`.
2. **swap** — `exactInputSingle` with `sqrtPriceLimitX96` set to the target tick's sqrt
   price. The swap stops *exactly* at the limit, so the pool lands precisely on the new
   price. `amountIn` is a cap computed from `SqrtPriceMath` × 4; only the portion actually
   consumed is transferred by the callback, so over-supplying costs nothing. Cost is
   bounded by the dust — the whole 74-pool reprice costs well under 1 sUSDS.
3. **fund** — `increaseLiquidity` the full sized position into the same tokenId, against
   the live post-swap price, after re-reading `slot0` and asserting the tick is within
   `TICK_TOLERANCE` of target.

Reusing the existing tokenIds means no new pools, no new NFTs, and the band stays
`[-39123, -203]` / `[202, 39122]` exactly as first minted. The script asserts each
position's on-chain band matches the computed one before it will touch it.

Prices come from **`zcash-q3-proposals.json`** (`yesPrice`, joined by `id`) — the ballot
file, deliberately *not* `create-zcash-markets-execution.json`, which
`add-zcash-liquidity.js` reads and which is a record of the first seeding rather than a
source of truth. Edit `yesPrice` there, dry-run, and read the `now→target` column.

Resume semantics differ from step 2 on purpose: splits and *funded* pools are skipped
from the log, but the dust and swap steps are decided from **live chain state** each run,
so a run that died between them self-heals instead of trusting the log.

### The `STF` trap — read this before changing DUST_Q or the split sizing

The first live attempt reverted `STF` (TransferHelper's SafeTransferFrom) on the fund step
of every pool whose swap direction was *sell outcome*. The cause is easy to miss:

**The price-setting swap is paid for out of the same outcome-token balance the split
produced.** The split was sized as `fund + dust` with nothing for the swap, so those pools
came up short by exactly the swap's input. Markets that happened to hold leftover outcome
tokens from step 4's merge (GRANTSHUB, and the other three that had traded) absorbed it and
succeeded, which is what made the failure look sporadic rather than systematic.

The shortfall is **not** bounded by `DUST_Q`. A dust position spanning the whole
`[0.02, 0.98]` band absorbs far more outcome than it was minted with as the price falls
toward the outcome-heavy end — SHIELDEDSCAN needed 0.036 against `DUST_Q = 0.02`, because
its price moved 0.45 → 0.18. The fix sizes the headroom from `SqrtPriceMath` over the
actual traversed range (`swapInputCap`, the same figure the swap later passes as its cap).

There is a second guard behind it: the fund step reads the live outcome balance and
re-sizes from it if it is short, with a 0.01% haircut. That is what let the four markets
already split at the old sizing recover on the resume without a second split — they landed
0.005–0.036 tokens light out of ~57–129, which is noise.

### What the 2026-08-24 re-seed actually did

```
prices          0.16 .. 0.97 (mean 0.62), from table.tsv via zcash-q3-proposals.json
pools repriced  72/74  (ZECMAP stayed at 0.55, so its two pools needed no swap)
splits (mint)    3,258.52 sUSDS over 37 markets
sUSDS side      16,746.91 sUSDS over 74 pools
slivers              2.00 sUSDS (dust + swap, stays in the positions)
DEPLOYED        20,007.43 sUSDS   (wallet 24,551.44 -> 4,544.01)
gas               ~0.00013 ETH over ~370 tx
```

Every pool landed on its target tick exactly — `check-zcash-pools.js` reports 0/74 drift.

**Known shape issue, accepted deliberately.** Dispersed prices on a fixed `[0.02, 0.98]`
band make each market's *cheap* side thin: depth tracks the pool's own token price, not the
market's probability, so a high-probability market has a thin NO pool and a low-probability
one a thin YES pool, symmetrically. Worst cases are ORCHARDBOUNTY NO at 0.03 ($0.02 moves
it 5 points) and TACHYON NO at 0.05 ($0.24). Those pools also hold almost no capital, so
exposure is a few dollars; the practical cost is a soft price signal on the six markets
whose *YES* side is the cheap one (ZECBOOKS $1.97, ZALLETRPC $2.38, BLINDVAULT $2.83,
CONNAUGH $4.65, FRONTIERSEC $5.84, ZAP1 $6.16 per 5 points, against ~$13.59 at the old
uniform 0.55). The fix, if it ever matters, is a per-market band around each seeded price —
which means minting new NFTs, since tick bands are fixed at mint.

Two guards worth knowing:

- The script warns if a pool's live liquidity exceeds our own position's — that means a
  third party has LP'd and the swap would trade against real depth instead of dust. As of
  2026-08-24 that was true of no pool: every pool's liquidity was exactly ours.
- Between the swap and the fund there is a ~2s window where the pool sits at the target
  price holding only dust. The tick re-check plus the 0.5% `slippageTolerance` are the
  guards; if a pool aborts there, just re-run.

Verify with `node check-zcash-pools.js`, which reads the re-seed log once it exists and
falls back to the original add log otherwise.

## Hazards specific to this market set

**1. Invalid is a scheduled outcome here, not a tail.** Seer's proposal says withdrawn
or omitted proposals resolve Invalid, and trading opens 2026-08-20 while the ballot does
not freeze until 2026-09-16. On L1/octant, Invalid is seeded near zero
(`liquidity-l1.js:249` uses 0.000011) because it is a genuine tail. Here, if a proposal
withdraws mid-window, whoever learns first buys Invalid at ~0 and takes the pool, and the
YES/NO LPs go to zero. `add-zcash-liquidity.js` deliberately does not seed an Invalid
pool. Either create markets only after the ballot freezes (recommended), or price Invalid
explicitly and scale YES/NO down to match.

**2. Seer's "Invalid → traders refunded" language does not match on-chain behaviour.**
On resolution to Invalid the Invalid token becomes the sole winner
(`src/RealityProxy.sol:81-83`); a trader holding only YES gets **zero**, not a refund.
Real refunds require holding a complete set and merging before resolution. Worth raising
with Seer before the pilot goes live.

**3. A flat 0.55 across all 37 is a uniform prior on a non-uniform population.** 14
proposals under $25k account for 1.7% of the dollars; 11 over $150k account for 89.2%.
Seeding a $3,050 ask and the $1.95M ZODL ask at the same price hands informed traders the
tails at the LP's expense. **Seer's proposal explicitly specifies that all projects start
at 0.55**, so moving off it is a deviation from the published pilot spec rather than a
tuning decision. That deviation was taken deliberately on 2026-08-24 (see step 5) — worth
confirming with Seer, since the pilot's published methodology still says 0.55.

One reconciliation note from that re-price: the supplied table listed proposal 14 as
*"ZKMarketer videos — $18,000 amended"*, while this market set's immutable question says
*"Connaugh Zcash Videos"* and the ballot says $22,000. It was seeded at 0.27 on the basis
that it is the same proposal renamed and amended (its slot in the amount-sorted ballot
matches). If it turns out to be a *replacement* rather than an amendment, market 14
resolves Invalid and hazard #1 applies to its ~540 sUSDS.

**4. Answering all 37 questions will need ETH the wallet does not have.**
`answer-octant-markets.js:392` fronts `min_bond` per question. At `MIN_BOND = 0.005`
ETH that is **0.185 ETH** to answer all 37; the wallet held 0.010916 ETH after creation.
Top up before the answering run. If someone answers wrong first, correcting that question
costs double the standing bond.

**5. Gas estimates exclude the Optimism L1 data fee.** The reported ~0.0000657 ETH is L2
execution only. Keep headroom — the wallet held 0.01098 ETH at the time of the dry run.

## Not covered here

- Resolving the markets after the poll (answering Reality, `RealityProxy.resolve`).
- The conditional/parent-child variant discussed for quorum risk — if the participation
  threshold turns out to be genuinely uncertain, a parent market on quorum with the ~11
  headline proposals as children prices merit separately from turnout. That is a
  different script; child pools are denominated in the parent's outcome token
  (`liquidity-l1.js:169-177`), not sUSDS.
