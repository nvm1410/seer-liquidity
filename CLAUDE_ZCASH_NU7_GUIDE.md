# Guide: Zcash NU7 coinholder-poll markets on Optimism

Five single-select **categorical** Seer markets, one per question of the Zcash NU7
coinholder poll.

> **Current set is v3**, created and seeded 2026-09-09 with **10,000 sUSDS**, both steps
> clean on the first live run. 5/5 markets created and verified (10,687,314 gas over 5 tx,
> blocks 156661833–156661850), then 14/14 pools seeded with **exactly 10,000.000000 sUSDS**
> (wallet 42,837.64 → 32,837.64). `check-zcash-nu7-pools.js` reports 0/14 drifted,
> 0/14 empty. Logs: `create-zcash-nu7-markets-v3-execution.json`,
> `add-zcash-nu7-liquidity-v3-execution.json`, plus the two `*-v3-run.log` files.
>
> **v1 and v2 are both dead** — created and fully unwound, still live and unresolved
> on-chain but holding no liquidity and not maintained. See §Previous sets.

## The v3 markets

Source: the questions doc at
`https://docs.google.com/document/d/19u7aX2kWlycqIVjRa2lSHWzWUxdGwX8wZMf3SLIz1Ck`,
snapshotted into `zcash-nu7-questions-v3.json`. The doc was **re-read and diffed against
the v2 snapshot before building v3: the ballot is unchanged.** Same five questions, same
options, same base rates, same three general notes. v3 is a rename-only rebuild.

| # | short | Topic | Address | Slots |
|---|---|---|---|---|
| 1 | `Q1` | NSM Issuance Smoothing | `0x29BCd2CEe8d413A2235f7970fCdDE432DCaf10fC` | 4 |
| 2 | `Q2` | NSM Reissuance Start Date | `0xbfdF8eF15ab1ec4Bd44BeC7Ee904270e6AD7ec9C` | 4 |
| 3 | `Q3` | Sprout Deprecation (v4 disable) | `0xd21eaDCf5C30475244aEa8a9Cf7cB6759F0BdAe6` | 4 |
| 4 | `Q4` | Faster Block Times (ZIP-218) | `0xC38Fa340cFdC9C758826DD4a8Dc15B58728d0418` | 3 |
| 5 | `Q5` | NU7 Scope and Readiness | `0xC03Bf1725b72Ab5765b639c582853EDE9AfB26a6` | 4 |

`https://app.seer.pm/markets/10/<address>`. Slots = ballot options + `Invalid result`.
`openingTime` is 1788912000 (2026-09-09T00:00:00Z), i.e. **in the past — all five questions
are answerable now**, gated operationally rather than at the contract level. Same value and
same deliberate stance as v2. `MIN_BOND` 0.005 ETH, `questionTimeout` 302,400s (3.5 days).
Wrapped ERC20 name = `ZNU7V3` + shortName + tag, e.g. `ZNU7V3Q1HALVINGS` — the `V3` is
load-bearing, because leftover v1 (`ZNU7…`) and v2 (`ZNU7V2…`) tokens are still in the
wallet and the bare names would collide in any wallet UI.

## What changed from v2 — the names, and only the names

v2 appended the full resolution rules to every market name, so each one ran past 300
characters and opened with the question buried in front of two sentences of rules. v3
carries the question and nothing else:

| | v3 name | chars (v2 → v3) |
|---|---|---|
| Q1 | Which NSM issuance smoothing approach will be selected in the Zcash NU7 coinholder poll? | 316 → 88 |
| Q2 | When will NSM reissuance of funds removed from circulation begin, per the Zcash NU7 coinholder poll? | 328 → 100 |
| Q3 | When will v4 transactions be disabled, per the Zcash NU7 coinholder poll? | 301 → 73 |
| Q4 | Will the Zcash NU7 coinholder poll approve ZIP-218 (block spacing 75s to 25s, per-pool action limits)? | 375 → 102 |
| Q5 | How will features not ready by the September 30th deadline be handled, per the Zcash NU7 coinholder poll? | 333 → 105 |

Three deliberate calls inside that rewrite, all made with the user on 2026-09-09:

- **Every name still names the poll.** The alternative — dropping the trailing clause on
  Q2/Q3/Q5 — was shown and declined, because "When will v4 transactions be disabled?"
  reads as a generic Zcash question in a Seer search result.
- **The reveal date is gone from the names.** v2 put `as revealed on 2026-09-15` in all
  five; it is rules-ish, and it lives in `revealAt` in both JSON files.
- **Q4 keeps both halves of its question.** The doc asks about block spacing *and*
  per-pool action limits; both survive in a parenthetical rather than one being cut.

Outcomes, tags, seed prices, market type, `openingTime` and pool params are **byte-identical
to v2** — verified programmatically before creation, not by eye.

### The cost of the rename: rules are no longer on-chain

This is the one real regression and it should not be discovered later by surprise. v2's
guide argued that "reality resolves off the question text and nothing else, so a rule that
lives only in a repo file does not exist" — and that argument still holds. In v3 the two
non-obvious rules (an official Abstain plurality promotes the second highest-voted option;
a below-quorum question resolves Invalid) live **only** in `zcash-nu7-questions-v3.json`,
`zcash-nu7-markets-v3.json` and the source doc. A resolver reading only the market text has
no basis for either. That trade — legible names over self-contained resolution text — was
the user's explicit instruction, recorded in `resolutionRulesPlacement` in both JSON files.
It sharpens hazard 1 below.

## Why single-select categorical — and why that is not the Q3 answer

`CLAUDE_ZCASH_MARKETS_GUIDE.md` §"Why 37 markets and not one 37-outcome market" argues
*against* folding many questions into one categorical market. That argument does not
apply here, and the difference is worth stating precisely:

- **Grant approvals are independent and non-exclusive.** ~20 of 37 pass at once. A
  multi-categorical market pays `1/k` to each of `k` winners (`src/RealityProxy.sol:109-112`),
  so a certain-to-approve proposal would trade near 0.05, not 1.0. Hence 37 binaries.
- **The NU7 poll's options within one question are mutually exclusive and exhaustive.**
  Exactly one option wins, so `k = 1` and the payout normalisation is the identity —
  price == P(that option). Hence one categorical market per question.

So: `createCategoricalMarket` (`src/MarketFactory.sol:140`, `REALITY_SINGLE_SELECT_TEMPLATE`,
templateId 2). **Not** `createMultiCategoricalMarket` (multi-select, wrong payout rule) and
**not** `createMultiScalarMarket` (prices vote *share*, not P(win)).

## Files

| File | Role |
|---|---|
| `zcash-nu7-questions-v3.json` | The ballot snapshot — 5 questions, outcome labels, token tags, seed prices, and the resolution rules plus an explicit note that they are **off-chain only**. **The only file you should normally edit.** |
| `create-zcash-nu7-markets.js` | Creates one categorical market per question. Writes `create-zcash-nu7-markets-v3-execution.json`. |
| `add-zcash-nu7-liquidity.js` | Splits sUSDS and seeds one Uniswap V3 pool per option. Reads addresses from the creation log and **prices from the questions file**. Writes `add-zcash-nu7-liquidity-v3-execution.json`. |
| `check-zcash-nu7-pools.js` | Read-only. Live price + liquidity per pool, and each market's live price sum against 1. |
| `withdraw-zcash-nu7-liquidity.js` | Removes all liquidity + fees from every pool. See §Unwinding. |
| `merge-zcash-nu7-positions.js` | Converts full outcome sets back to sUSDS. See §Unwinding. |
| `zcash-nu7-markets-v3.json` | Flat reference: addresses, Seer URLs, outcomes, seed prices, token names/addresses, every tx hash. Generated, not read by any script. |

The five scripts are **shared across v1/v2/v3** — only their `*_FILE` constants and
`TOKEN_PREFIX` get repointed. To stand up a v4, bump those constants again rather than
editing the v3 JSONs, so each generation's record survives. Addresses, `.env` keys
(`PRIVATE_KEY`, `RPC_URL` = Optimism) and the `FEE_TIER = 100 / TICK_SPACING = 1` pool
params are identical to the Q3 scripts — see that guide.

## Seeded prices and capital

Prices are the doc's "Base Rate" column **verbatim**; each question sums to exactly 1.000.
Budget is 2,000 sUSDS per question, equal outcome-quantity `Q` per pool within a market,
uniform band `[0.02, 0.98]`. Unchanged from v2, since the prices are unchanged.

```
        prices               sUSDS side per pool           split      total
Q1  .15 / .75 / .10        50.04 / 1604.09 /   25.98      319.89    2,000.00
Q2  .55 / .15 / .30      1035.04 /   91.22 /  290.52      583.21    2,000.00
Q3  .30 / .20 / .50       316.52 /  158.48 /  889.62      635.39    2,000.00
Q4  .90 / .10            1888.92 /    8.34                102.74    2,000.00
Q5  .70 / .25 / .05      1461.06 /  140.86 /    9.23      388.85    2,000.00

splits (mint)  2,030.07   sUSDS side  7,969.93   DEPLOYED  10,000.00
```

Two sizing points, both inherited from the Q3 script and both load-bearing:

- **The budget is solved per market, not globally.** Both sides of a position are linear
  in the outcome quantity at fixed ticks, so one trial pass at `Q0` gives the exact scale
  factor. With a single global `Q` the sUSDS side explodes as a price nears a band edge,
  and the markets with the most confident favourites would eat the whole budget.
- **`splitAmount` is `max(outcomeUsed)` across the market's pools.** Under equal `Q` that
  is just `Q`, so the split is exact: every token minted gets deployed and only the
  unpooled `Invalid` tokens are left idle.

`buildPoolAndBounds` hard-fails on a seed price outside `[MIN_PRICE, MAX_PRICE]` rather
than silently minting an entirely one-sided position.

## Hazards

**1. Invalid is a live outcome with a named trigger, it is unpooled, and in v3 its trigger
is no longer written on-chain.** The doc's rule 3 sends a question that misses official
quorum straight to Invalid. Invalid gets no pool by design, so whoever learns of a quorum
failure first buys it at ~0 and takes the pool. This is the sharpest exposure in the set,
and v3's shorter names make it sharper than v2's: the market text no longer tells a reader
the rule exists. The mitigation is not a pool — it is watching the poll.

**2. `pollUrl` and `pollCloseAt` are still null.** No canonical URL is recorded for the
official result. In v2 the reveal date and rules were at least in the question text; in v3
nothing about resolution is on-chain at all. Fill both in as soon as the poll is published.
The doc itself is also **not frozen** — it was revised once between v1 and v2, which is
what killed v1. It was verified unchanged before v3 was built.

**3. Thin long-shot pools, accepted.** Depth tracks a pool's own token price, so each
market's favourite holds most of that market's sUSDS: Q4 `YES` $1,888.92 against `NO` $8.34.
Pushing a long shot's price *down* is cheap; pushing it up is defended by the outcome-token
side. The alternative — capping the favourite's sUSDS side the way
`add-pd-liquidity-gnosis-v2.js` caps "No To All" — was costed and declined for v1 and has
not been revisited.

**4. Answering all five costs 0.025 ETH in bonds.** Wallet held 0.04076 ETH after seeding,
so this is covered.

**5. Outcome labels are shortened from the doc.** Q1(a) is written in the doc as "Smooth
issuance curve. Replace halvings with a gradual issuance curve. ZEC removed…"; the market
outcome is `Smooth issuance curve`. Same for Q2/Q3/Q5. The full text lives in the source
doc, which the question text does not link to — see hazard 2.

**6. Three live NU7 market sets now exist on Seer.** v1's and v2's markets are unresolved
and searchable. Anyone arriving from a link will find all three, and v2's names are the
*most* explicit about resolution rules despite being the abandoned set. v3 is identifiable
by the `ZNU7V3` token prefix and by the addresses above.

## Runbook

```bash
# 1. Edit zcash-nu7-questions-v3.json. Dry run prints every market name, all outcome
#    labels, token names, the encoded Reality question, gas, and the question-id
#    collision check. Sends nothing.
node create-zcash-nu7-markets.js          # DRY_RUN = true

# 2. Flip DRY_RUN = false, re-run. Resumable — logged questions are skipped, so a
#    re-run retries only failures and never creates a duplicate market.
node create-zcash-nu7-markets.js

# 3. Dry-run seeding. Resolves all markets on-chain against the questions file,
#    sizes every position, prints the capital table. Confirm the GRAND TOTAL.
node add-zcash-nu7-liquidity.js           # DRY_RUN = true

# 4. Flip DRY_RUN = false, re-run. Resumable at both split and pool level.
node add-zcash-nu7-liquidity.js

# 5. Verify.
node check-zcash-nu7-pools.js
```

Both live steps are done for v3. `create-zcash-nu7-markets.js` and
`add-zcash-nu7-liquidity.js` are checked in with `DRY_RUN = false` — flip them back before
touching either file for a new set.

## Unwinding

Not yet run for v3. `withdraw-zcash-nu7-liquidity.js` then `merge-zcash-nu7-positions.js`,
in that order, both currently `DRY_RUN = true` and both repointed at the v3 logs.

| File | Role |
|---|---|
| `withdraw-zcash-nu7-liquidity.js` | Removes 100% of liquidity + collects fees, one tx per position. Scope = every wrapped token of every market in the creation log, paired against sUSDS, **including Invalid** so "withdraw all" stays true if an Invalid pool is ever added by hand. Resumable per position. |
| `merge-zcash-nu7-positions.js` | Converts a full outcome set per market back to sUSDS via `Router.mergePositions`. One approval per slot then one merge, so a 4-slot market is 5 tx. Resumable per market. |

**The merge is capped by the smallest balance in the set**, so a market that has traded
recovers less than was deployed — see the PD v1 case in `GNOSIS_PD_MARKET_GUIDE.md`. Run
`check-zcash-nu7-pools.js` first: if it reports 0 pools drifted, the round trip is whole.

## Previous sets (dead)

Both are still live and unresolved on-chain, hold no liquidity, and are not maintained.
Their artifacts are retained as-is and no script points at them.

**v2** — created 2026-09-09 off the same (unchanged) ballot, seeded with 10,000 sUSDS over
14 pools, and fully unwound the **same day** because the names were unusable. Nothing had
traded, so the round trip was exact: all 14 positions withdrawn, all 5 sets merged, wallet
40,807.61 → 42,837.643357528231391641 — **the identical balance it held before v2 was
seeded**. Net cost 0 sUSDS plus ~0.0001 ETH of gas, with 5 wei of outcome tokens stranded.
Files: `zcash-nu7-questions-v2.json`, `zcash-nu7-markets-v2.json`, and the `*-v2-*.json` /
`*-v2-run.log` artifacts.

| # | short | Address | Slots |
|---|---|---|---|
| 1 | `Q1` | `0xAB5ff387679eD31d445C29E2A97aA2B7a6BD0716` | 4 |
| 2 | `Q2` | `0xe00A21CE58f37524A690df0A06d94883C590525f` | 4 |
| 3 | `Q3` | `0x0226E074F4E79c898e9F8F4Bcd3F79A0c3544acd` | 4 |
| 4 | `Q4` | `0xCFb9E0203dE77b326b9B02b0169e4Ff4375462A8` | 3 |
| 5 | `Q5` | `0xa08C1bA820FaEc9122c3844c25a877BD35EFeCe3` | 4 |

**v1** — created 2026-09-03 off a **pre-revision** ballot (every question still carried an
Abstain option and every base rate differed), seeded with 10,000 sUSDS across 19 pools,
fully unwound 2026-09-07 for a net cost of 1.57 sUSDS plus ~0.0002 ETH — tick rounding plus
the single trade the set ever took. The merge stranded 6.99 tokens, which are not lost: the
v1 markets are still live, so they redeem or not at resolution. Files:
`zcash-nu7-questions.json`, `zcash-nu7-markets.json`, and the `*-execution.json` /
`*-run.log` artifacts with no version infix.

| # | short | Address | Slots |
|---|---|---|---|
| 1 | `Q1` | `0xF3f00A5Ecc66Bd6EbF32B6fd46bfb8F25289A4aA` | 5 |
| 2 | `Q2` | `0x1CDDEAEd87aeA58BCee8053EfE413a12537F881A` | 5 |
| 3 | `Q3` | `0x9C003F4627D0563359664e8F0B208f354f7acDfF` | 5 |
| 4 | `Q4` | `0x685d5C8F56e3722f3030Bc0102954dF541541aEb` | 4 |
| 5 | `Q5` | `0x1e3F03Cd6231027bccf02791483156Bb4a96D6C9` | 5 |

### The v1→v2→v3 lesson

Three builds of the same five markets in seven days, two of them thrown away. v1 died to a
**stale input** (a silently revised doc). v2 died to an **unreviewed output** (names written
without showing them to the user first). The guard for the first is in the runbook — re-read
and diff the live doc. The guard for the second is simpler: **market names are immutable, so
show them before creating anything.** The v3 dry run prints every name; that output is the
review step, not a formality.

Related: `CLAUDE_ZCASH_MARKETS_GUIDE.md` (the Q3 grant markets these scripts fork from),
`GNOSIS_PD_MARKET_GUIDE.md` (the other N-outcome categorical market).
