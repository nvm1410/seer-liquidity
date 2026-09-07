# Guide: Zcash NU7 coinholder-poll markets on Optimism

Five single-select **categorical** Seer markets, one per question of the Zcash NU7
coinholder poll, created and seeded 2026-09-03 with **10,000 sUSDS**.

> **Status: created and seeded 2026-09-03, both steps clean on the first live run.**
> 5/5 markets created and verified (12,284,178 gas over 5 tx, blocks 156418642–156418654),
> then 19/19 pools seeded with **exactly 10,000.000000 sUSDS** (wallet 42,839.21 → 32,839.21),
> ~0.000116 ETH gas over ~53 tx. `check-zcash-nu7-pools.js` reports 0/19 pools drifted
> and 0/19 empty. Logs: `create-zcash-nu7-markets-execution.json`,
> `add-zcash-nu7-liquidity-execution.json`, plus the two `*-run.log` files.
>
> **Fully unwound 2026-09-07** — all 19 pools drained and every outcome set merged back
> to sUSDS. See §Unwinding. The markets themselves are still live and unresolved.

## The markets

Source: the questions doc at
`https://docs.google.com/document/d/19u7aX2kWlycqIVjRa2lSHWzWUxdGwX8wZMf3SLIz1Ck`,
snapshotted into `zcash-nu7-questions.json`.

| # | short | Topic | Address | Slots |
|---|---|---|---|---|
| 1 | `Q1` | NSM Issuance Smoothing | `0xF3f00A5Ecc66Bd6EbF32B6fd46bfb8F25289A4aA` | 5 |
| 2 | `Q2` | NSM Reissuance Start Date | `0x1CDDEAEd87aeA58BCee8053EfE413a12537F881A` | 5 |
| 3 | `Q3` | Sprout Deprecation (v4 disable) | `0x9C003F4627D0563359664e8F0B208f354f7acDfF` | 5 |
| 4 | `Q4` | Faster Block Times (ZIP-218) | `0x685d5C8F56e3722f3030Bc0102954dF541541aEb` | 4 |
| 5 | `Q5` | NU7 Scope and Readiness | `0x1e3F03Cd6231027bccf02791483156Bb4a96D6C9` | 5 |

`https://app.seer.pm/markets/10/<address>`. Slots = ballot options + `Invalid result`.
`openingTime` is 1788393600 (2026-09-03T00:00:00Z), i.e. **in the past — all five
questions are answerable now**, gated operationally rather than at the contract level,
same deliberate choice as the Q3 grant set. `MIN_BOND` 0.005 ETH, `questionTimeout`
302,400s (3.5 days).

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
**not** `createMultiScalarMarket` (prices vote *share*, not P(win) — see hazard 1).

## Files

| File | Role |
|---|---|
| `zcash-nu7-questions.json` | The ballot snapshot — 5 questions, their outcome labels, token tags and seed prices. **The only file you should normally edit.** |
| `create-zcash-nu7-markets.js` | Creates one categorical market per question. Writes `create-zcash-nu7-markets-execution.json`. |
| `add-zcash-nu7-liquidity.js` | Splits sUSDS and seeds one Uniswap V3 pool per option. Reads addresses from the creation log and **prices from the questions file**. Writes `add-zcash-nu7-liquidity-execution.json`. |
| `check-zcash-nu7-pools.js` | Read-only. Live price + liquidity per pool, and each market's live price sum against 1. |
| `withdraw-zcash-nu7-liquidity.js` | Removes all liquidity + fees from every pool. See §Unwinding. |
| `merge-zcash-nu7-positions.js` | Converts full outcome sets back to sUSDS. See §Unwinding. |

Wrapped ERC20 name = `ZNU7` + shortName + tag, e.g. `ZNU7Q1HALVINGS`. All 19 unique and
well under the 31-byte `toString31` limit (which **reverts**, `src/MarketFactory.sol:448`).

Addresses, `.env` keys (`PRIVATE_KEY`, `RPC_URL` = Optimism) and the `FEE_TIER = 100 /
TICK_SPACING = 1` pool params are identical to the Q3 scripts — see that guide.

## Seeded prices and capital

Prices are the doc's "Base Rate" column **verbatim**; each question sums to exactly 1.000.
Budget is 2,000 sUSDS per question, equal outcome-quantity `Q` per pool within a market,
uniform band `[0.005, 0.98]`.

```
        prices                    sUSDS side per pool            split      total
Q1  .15 / .77 / .05 / .03      53.70 / 1662.16 /  11.78 /  5.74  266.63    2,000.00
Q2  .18 / .04 / .74 / .04      80.64 /    9.95 /1592.28 /  9.95  307.18    2,000.00
Q3  .42 / .08 / .48 / .02     599.44 /   46.47 / 794.42 /  6.45  553.21    2,000.00
Q4  .94 / .04 / .02          1951.86 /    1.49 /   0.54          46.11     2,000.00
Q5  .87 / .09 / .01 / .03    1850.63 /   13.12 /   0.43 /  2.86  132.95    2,000.00

splits (mint)  1,306.08   sUSDS side  8,693.92   DEPLOYED  10,000.00
```

Two sizing points, both inherited from the Q3 script and both load-bearing:

- **The budget is solved per market, not globally.** Both sides of a position are linear
  in the outcome quantity at fixed ticks, so one trial pass at `Q0` gives the exact scale
  factor. With a single global `Q` the sUSDS side explodes as a price nears a band edge,
  and the markets with the most confident favourites would eat the whole budget.
- **`splitAmount` is `max(outcomeUsed)` across the market's pools.** Under equal `Q` that
  is just `Q`, so the split is exact: every token minted gets deployed and only the
  unpooled `Invalid` tokens are left idle.

`MIN_PRICE` is **0.005**, not the Q3 set's 0.02, because Q5's `NOSUPPORT` seeds at 0.01
and a price outside the band produces an entirely one-sided position. `buildPoolAndBounds`
now hard-fails on that rather than silently minting it.

## Hazards

**1. The base rates read as vote shares, but these markets pay on the winner.** Abstain is
seeded at 2–4% and `Q5 NOSUPPORT` at 1%. Under a single-select market those are the
probabilities that Abstain / "I do not support" *wins a plurality*, which is ~0, not 3%.
Taken verbatim as a deliberate decision on 2026-09-03 — the numbers are the doc's own and
"seed at the rate" was the instruction. If the intent turns out to be vote share, the two
fixes are a reprice (fork `reseed-zcash-liquidity.js`; the pools keep their old price when
drained, so only a swap moves them) or a multi-scalar rebuild, which means new markets.

**2. The poll is not frozen and has no recorded resolution source.** `pollUrl` and
`pollCloseAt` are both `null` in the questions file. Seer markets are immutable: a question
reworded or dropped before the poll runs resolves **Invalid**, and Invalid is deliberately
unpooled, so whoever learns first buys it at ~0 and takes the pool. Fill in `pollUrl` and
`pollCloseAt` as soon as the poll is published. This is the same exposure the Q3 set carried
with `ballotFrozenAt: null`.

**3. Thin long-shot pools, accepted.** Depth tracks a pool's own token price, so each
market's favourite holds nearly all of that market's sUSDS. `Q4 ABSTAIN` holds $0.54 of
sUSDS, `Q4 NO` $1.49, `Q5 NOSUPPORT` $0.43. Pushing those prices *down* is cheap; pushing
them up is defended by the outcome-token side. The exposure is a few dollars per pool; the
real cost is a soft price signal on the long shots. The alternative — capping the favourite's
sUSDS side the way `add-pd-liquidity-gnosis-v2.js` caps "No To All" — was costed at 25% and
40% and declined, because it moves capital out of sUSDS and into holding the favourite's
outcome tokens outright.

**4. Answering all five costs 0.025 ETH in bonds.** Wallet held 0.0409 ETH after seeding,
so this one is covered — unlike the Q3 set.

**5. Q1's outcome labels are shortened from the doc.** The doc writes option (a) as
"Smooth issuance curve. Replace halvings with a gradual issuance curve. ZEC removed…";
the market outcome is `Smooth issuance curve`. Same for Q2/Q3/Q5. The full text lives in
the source doc, which the question text does not link to — see hazard 2.

## Runbook

```bash
# 1. Edit zcash-nu7-questions.json. Dry run prints every market name, all 19 outcome
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

Both live steps are already done. `create-zcash-nu7-markets.js` and
`add-zcash-nu7-liquidity.js` are currently checked in with `DRY_RUN = false` — flip them
back before touching either file for a new set.

## Unwinding

**Status: fully unwound 2026-09-07, both steps clean on the first live run.** 19/19
positions withdrawn (blocks 156581676–156581733), then 5/5 markets merged (blocks
156581877–156581950). `check-zcash-nu7-pools.js` reports 19/19 pools empty. Logs:
`withdraw-zcash-nu7-liquidity-execution.json`, `merge-zcash-nu7-positions-execution.json`,
plus the two `*-run.log` files.

```
                         sUSDS        outcome tokens
pre-seed  (2026-09-03)  42,839.21     —
after seeding           32,839.21     1,306.08 minted
after withdraw          41,534.14     +8,694.93 back (8,693.92 side + fees)
after merge             42,837.64     +1,303.51 merged, 6.99 stranded
```

Net cost of the full round trip: **1.57 sUSDS**, plus ~0.0002 ETH of gas. That 1.57 is
tick rounding plus the one trade the set ever took — Q4 (`YES` +0.0008, `NO` +0.0035);
Q1 shows sub-dollar dust from the same effect. Nothing else moved off its seed price.

| File | Role |
|---|---|
| `withdraw-zcash-nu7-liquidity.js` | Removes 100% of liquidity + collects fees, one tx per position. Scope = every wrapped token of every market in the creation log, paired against sUSDS, **including Invalid** so "withdraw all" stays true if an Invalid pool is ever added by hand. Resumable per position. |
| `merge-zcash-nu7-positions.js` | Converts a full outcome set per market back to sUSDS via `Router.mergePositions`. One approval per slot then one merge, so a 5-slot market is 6 tx. Resumable per market. |

Both are forks of the Q3 pair (`withdraw-zcash-liquidity.js`, `merge-zcash-positions.js`)
with the same single structural change `add-zcash-nu7-liquidity.js` makes: the fixed
`[YES, NO, Invalid]` triple becomes `n + 1` slots read from the creation log's `outcomes`
array, and the `length !== 3` assertion becomes a length cross-check against that array.
Both are checked in with `DRY_RUN = false` after the live run — flip them back first.

**The merge is capped by the smallest balance in the set**, so a market that has traded
recovers less than was deployed — see the PD v1 case in `GNOSIS_PD_MARKET_GUIDE.md`. Here
that cost 6.99 tokens, left in the wallet: 2.40 each of Q4 `ABSTAIN` and `Invalid`, 1.33 of
Q4 `YES`, 0.87 across Q1, and 1 wei of `Invalid` in each of Q2/Q3/Q5. Those are **not
lost** — the markets are still live, so they redeem (or not) at resolution. Merging them
would need buying back the missing sides, which is not worth the gas at this size.

Wallet after the unwind: **42,837.64 sUSDS, 0.04094 ETH**.

Related: `CLAUDE_ZCASH_MARKETS_GUIDE.md` (the Q3 grant markets these scripts fork from),
`GNOSIS_PD_MARKET_GUIDE.md` (the other N-outcome categorical market).
