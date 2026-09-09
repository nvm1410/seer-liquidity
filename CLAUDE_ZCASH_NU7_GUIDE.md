# Guide: Zcash NU7 coinholder-poll markets on Optimism

Five single-select **categorical** Seer markets, one per question of the Zcash NU7
coinholder poll.

> **Current set is v2**, created and seeded 2026-09-09 with **10,000 sUSDS**, both steps
> clean on the first live run. 5/5 markets created and verified (12,404,299 gas over 5 tx,
> blocks 156660715–156660730), then 14/14 pools seeded with **exactly 10,000.000000 sUSDS**
> (wallet 42,837.64 → 32,837.64), ~0.00009 ETH of gas. `check-zcash-nu7-pools.js` reports
> 0/14 drifted, 0/14 empty. Logs: `create-zcash-nu7-markets-v2-execution.json`,
> `add-zcash-nu7-liquidity-v2-execution.json`, plus the two `*-v2-run.log` files.
>
> **v1 is dead.** Created 2026-09-03 off an earlier revision of the same doc, fully unwound
> 2026-09-07 for a net 1.57 sUSDS. Its five markets are still live and unresolved on-chain
> but hold no liquidity and are not maintained — see §v1.

## The v2 markets

Source: the questions doc at
`https://docs.google.com/document/d/19u7aX2kWlycqIVjRa2lSHWzWUxdGwX8wZMf3SLIz1Ck`,
snapshotted into `zcash-nu7-questions-v2.json`. The doc was **revised between the v1 and
v2 snapshots** — see §What changed from v1.

| # | short | Topic | Address | Slots |
|---|---|---|---|---|
| 1 | `Q1` | NSM Issuance Smoothing | `0xAB5ff387679eD31d445C29E2A97aA2B7a6BD0716` | 4 |
| 2 | `Q2` | NSM Reissuance Start Date | `0xe00A21CE58f37524A690df0A06d94883C590525f` | 4 |
| 3 | `Q3` | Sprout Deprecation (v4 disable) | `0x0226E074F4E79c898e9F8F4Bcd3F79A0c3544acd` | 4 |
| 4 | `Q4` | Faster Block Times (ZIP-218) | `0xCFb9E0203dE77b326b9B02b0169e4Ff4375462A8` | 3 |
| 5 | `Q5` | NU7 Scope and Readiness | `0xa08C1bA820FaEc9122c3844c25a877BD35EFeCe3` | 4 |

`https://app.seer.pm/markets/10/<address>`. Slots = ballot options + `Invalid result`.
`openingTime` is 1789948800 (2026-09-09T00:00:00Z), i.e. **in the past — all five questions
are answerable now**, gated operationally rather than at the contract level. That was a
deliberate re-decision on 2026-09-09, not inertia: the doc names a reveal date of
September 15, so an opening time of 2026-09-16 was on the table and was declined in favour
of matching v1 and the Q3 grant set. `MIN_BOND` 0.005 ETH, `questionTimeout` 302,400s
(3.5 days). Wrapped ERC20 name = `ZNU7V2` + shortName + tag, e.g. `ZNU7V2Q1HALVINGS` —
the `V2` is load-bearing, because leftover v1 tokens (`ZNU7Q4YES` and friends) are still
in the wallet and the bare names would collide in any wallet UI.

## What changed from v1

The revised doc drops **Abstain from every question**: its General Notes now say outright
that abstain is not an option in these markets, and that an official Abstain plurality
promotes the second highest-voted option. Option counts fall 4/4/4/3/4 → 3/3/3/2/3 and
every base rate moved.

| | v1 seed | v2 seed |
|---|---|---|
| Q1 | .15 / .77 / .05 / .03 abstain | .15 / **.75** / **.10** |
| Q2 | .18 / .04 / .74 / .04 abstain | **.55 / .15 / .30** |
| Q3 | .42 / .08 / .48 / .02 abstain | **.30 / .20 / .50** |
| Q4 | .94 / .04 / .02 abstain | **.90 / .10** |
| Q5 | .87 / .09 / .01 / .03 abstain | **.70 / .25 / .05** |

Three consequences worth stating:

- **v1 hazard 1 is gone.** That hazard was that the base rates read as *vote shares* while
  a single-select market pays the *winner*, most visibly with Abstain seeded at 2–4% when
  P(Abstain wins a plurality) is ~0. With Abstain removed from the ballot, the rates and the
  payout rule now describe the same thing.
- **The two new resolution rules are written into the question text**, not just the JSON.
  Every v2 market name carries "Abstain is not an outcome here: if Abstain is the
  highest-voted option in the official poll, the second highest-voted option counts as the
  winner. Resolves Invalid if the question does not reach official quorum." Reality resolves
  off the question text and nothing else, so a rule that lives only in a repo file does not
  exist. This is the direct fix for v1 hazard 2 (immutable markets with no recorded
  resolution basis) — though `pollUrl` and `pollCloseAt` are **still null**, so the *source*
  is still unrecorded.
- **The liquidity band tightened to [0.02, 0.98]**, back to the Q3 binaries' range. v1 needed
  a 0.005 floor for Q5 `NOSUPPORT` at 0.01; v2's lowest seed is 0.05, so the wide band would
  only have spread depth across prices no outcome sits in. Concentrating it roughly 5×'d the
  thin pools: Q4 `NO` holds $8.34 of sUSDS against v1's $1.49, and the v2 minimum is Q5
  `NOSUPPORT` at $9.23 against v1's $0.43.

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
| `zcash-nu7-questions-v2.json` | The ballot snapshot — 5 questions, outcome labels, token tags, seed prices and the resolution rules. **The only file you should normally edit.** |
| `create-zcash-nu7-markets.js` | Creates one categorical market per question. Writes `create-zcash-nu7-markets-v2-execution.json`. |
| `add-zcash-nu7-liquidity.js` | Splits sUSDS and seeds one Uniswap V3 pool per option. Reads addresses from the creation log and **prices from the questions file**. Writes `add-zcash-nu7-liquidity-v2-execution.json`. |
| `check-zcash-nu7-pools.js` | Read-only. Live price + liquidity per pool, and each market's live price sum against 1. |
| `withdraw-zcash-nu7-liquidity.js` | Removes all liquidity + fees from every pool. See §Unwinding. |
| `merge-zcash-nu7-positions.js` | Converts full outcome sets back to sUSDS. See §Unwinding. |
| `zcash-nu7-markets-v2.json` | Flat reference: addresses, Seer URLs, outcomes, seed prices, token names/addresses. Generated, not read by any script. |

The five scripts are **shared between v1 and v2** — only their `*_FILE` constants and
`TOKEN_PREFIX` were repointed. To stand up a v3, bump those constants again rather than
editing the v2 JSONs, so the v2 record survives. Addresses, `.env` keys (`PRIVATE_KEY`,
`RPC_URL` = Optimism) and the `FEE_TIER = 100 / TICK_SPACING = 1` pool params are identical
to the Q3 scripts — see that guide.

## Seeded prices and capital

Prices are the doc's "Base Rate" column **verbatim**; each question sums to exactly 1.000.
Budget is 2,000 sUSDS per question, equal outcome-quantity `Q` per pool within a market,
uniform band `[0.02, 0.98]`.

```
        prices               sUSDS side per pool           split      total
Q1  .15 / .75 / .10        50.03 / 1604.13 /   25.98      319.86    2,000.00
Q2  .55 / .15 / .30      1034.98 /   91.23 /  290.56      583.23    2,000.00
Q3  .30 / .20 / .50       316.51 /  158.49 /  889.61      635.38    2,000.00
Q4  .90 / .10            1888.92 /    8.34                102.74    2,000.00
Q5  .70 / .25 / .05      1461.10 /  140.85 /    9.23      388.82    2,000.00

splits (mint)  2,030.03   sUSDS side  7,969.97   DEPLOYED  10,000.00
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

**1. Invalid is a live outcome with a named trigger, and it is unpooled.** The doc's rule 3
sends a question that misses official quorum straight to Invalid. Invalid gets no pool by
design, so whoever learns of a quorum failure first buys it at ~0 and takes the pool. This
is the sharpest exposure in the set. The mitigation is not a pool — it is watching the poll.

**2. `pollUrl` and `pollCloseAt` are still null.** The reveal date (September 15) and the
resolution rules are now in the question text, but no canonical URL is recorded for the
official result. Fill both in as soon as the poll is published. The doc itself is also
**not frozen** — it has already been revised once, which is exactly what killed v1.

**3. Thin long-shot pools, accepted.** Depth tracks a pool's own token price, so each
market's favourite holds most of that market's sUSDS: Q4 `YES` $1,888.92 against `NO` $8.34.
Much better than v1 thanks to the tighter band, but the shape is unchanged. Pushing a long
shot's price *down* is cheap; pushing it up is defended by the outcome-token side. The
alternative — capping the favourite's sUSDS side the way `add-pd-liquidity-gnosis-v2.js`
caps "No To All" — was costed and declined for v1 and not revisited.

**4. Answering all five costs 0.025 ETH in bonds.** Wallet held 0.04085 ETH after seeding,
so this is covered.

**5. Outcome labels are shortened from the doc.** Q1(a) is written in the doc as "Smooth
issuance curve. Replace halvings with a gradual issuance curve. ZEC removed…"; the market
outcome is `Smooth issuance curve`. Same for Q2/Q3/Q5. The full text lives in the source
doc, which the question text does not link to — see hazard 2.

**6. Two live NU7 market sets now exist on Seer.** v1's five markets are unresolved and
searchable. Anyone arriving from a link will find both. v2 is distinguishable by the
resolution rules in the question text and by the `ZNU7V2` token prefix.

## Runbook

```bash
# 1. Edit zcash-nu7-questions-v2.json. Dry run prints every market name, all outcome
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

Both live steps are done for v2. `create-zcash-nu7-markets.js` and
`add-zcash-nu7-liquidity.js` are checked in with `DRY_RUN = false` — flip them back before
touching either file for a new set.

## Unwinding

Not yet run for v2. `withdraw-zcash-nu7-liquidity.js` then `merge-zcash-nu7-positions.js`,
both currently `DRY_RUN = true` and both repointed at the v2 logs.

| File | Role |
|---|---|
| `withdraw-zcash-nu7-liquidity.js` | Removes 100% of liquidity + collects fees, one tx per position. Scope = every wrapped token of every market in the creation log, paired against sUSDS, **including Invalid** so "withdraw all" stays true if an Invalid pool is ever added by hand. Resumable per position. |
| `merge-zcash-nu7-positions.js` | Converts a full outcome set per market back to sUSDS via `Router.mergePositions`. One approval per slot then one merge, so a 4-slot market is 5 tx. Resumable per market. |

**The merge is capped by the smallest balance in the set**, so a market that has traded
recovers less than was deployed — see the PD v1 case in `GNOSIS_PD_MARKET_GUIDE.md`, and
the v1 round trip below.

## v1 (dead)

Created 2026-09-03 off the pre-revision doc, seeded with 10,000 sUSDS across 19 pools,
fully unwound 2026-09-07 for a **net cost of 1.57 sUSDS** plus ~0.0002 ETH of gas — tick
rounding plus the single trade the set ever took (Q4 `YES` +0.0008, `NO` +0.0035). The
merge stranded 6.99 tokens in the wallet (2.40 each of Q4 `ABSTAIN` and `Invalid`, 1.33 of
Q4 `YES`, 0.87 across Q1, 1 wei of `Invalid` in each of Q2/Q3/Q5). Those are **not lost** —
the v1 markets are still live, so they redeem or not at resolution; buying back the missing
sides to merge them is not worth the gas at this size.

| # | short | Address | Slots |
|---|---|---|---|
| 1 | `Q1` | `0xF3f00A5Ecc66Bd6EbF32B6fd46bfb8F25289A4aA` | 5 |
| 2 | `Q2` | `0x1CDDEAEd87aeA58BCee8053EfE413a12537F881A` | 5 |
| 3 | `Q3` | `0x9C003F4627D0563359664e8F0B208f354f7acDfF` | 5 |
| 4 | `Q4` | `0x685d5C8F56e3722f3030Bc0102954dF541541aEb` | 4 |
| 5 | `Q5` | `0x1e3F03Cd6231027bccf02791483156Bb4a96D6C9` | 5 |

v1 artifacts retained as-is: `zcash-nu7-questions.json`, `zcash-nu7-markets.json`, and the
`create-` / `add-` / `withdraw-` / `merge-zcash-nu7-*-execution.json` files without a `-v2`
infix, plus their `*-run.log`s. No script points at them any more.

Related: `CLAUDE_ZCASH_MARKETS_GUIDE.md` (the Q3 grant markets these scripts fork from),
`GNOSIS_PD_MARKET_GUIDE.md` (the other N-outcome categorical market).
