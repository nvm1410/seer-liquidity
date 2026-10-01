# Design review — the cross-check before a market set is created

A market's structure cannot be edited after creation, and a structure can be wrong while every
script, name and amount is right. The dry run, the verifier and the immutable-text gate all check
that what gets built matches the plan. **None of them checks that the plan pays what the request
means.** That is this review.

It is done by a reviewer who did not design the set — a fresh agent given the request and the plan,
and none of the builder's reasoning. The harness refuses `--live` on a `launch` manifest until a
passing review of the current `markets[]` is recorded (see [Recording it](#recording-it)).

## The failure this exists for

Originality round 3, first build (2026-09-22). Request: one scalar "average originality score of
{repo}" per repo, 98 repos, grouped into three bundles only to fit the gas cap. Built as: a
multi-scalar parent "how many repositories in [bundle] will be evaluated", and each score market
conditional directly on its **bundle** token.

Take a repo that is never evaluated. Its bundle token still pays (other repos in the bundle were
evaluated), so the score market's stake is still worth money. Its question has no answer, so it
resolves Invalid: DOWN and UP pay 0 and the Invalid token takes the whole stake
(`src/RealityProxy.sol:137-139`). Every trader in that market loses what they put in, and the loss
is counted in P/L.

What was wanted: an unevaluated repo should simply not count. That needs the stake itself to be
worth zero when the repo is not evaluated — a level in between ("which repositories in this bundle
will be evaluated", one outcome per repo) with each score market on its own repo token. Then the
score market's resolution moves no money at all. It cost a second full build and left a
withdraw-only set on chain that must still be settled.

Nothing mechanical could see it. Names, symbols, prices and pools were all correct.

## What the reviewer is given

1. The request and every source document, **verbatim**. Not a summary.
2. `lifecycle/<slug>.json` and, if it exists, the create script's dry-run output and the seed file.
3. The precedent set this one is modelled on or replaces, if any.

Not given: the builder's explanation of why the structure is right. A reviewer handed the
conclusion tends to return it confirmed.

## How payouts are actually computed

Derive every payoff from these, not from a description in the manifest.

| Market type | Payout | Resolves Invalid when | Source |
|---|---|---|---|
| categorical | the one answered outcome takes all | answer is Invalid, or is not in the outcome list | `src/RealityProxy.sol:73-89` |
| multi-categorical | every selected outcome gets weight 1, so each of k selected pays **1/k** | answer is Invalid, or nothing is selected | `src/RealityProxy.sol:95-121` |
| scalar | DOWN `(high - answer)`, UP `(answer - low)`, clamped at the bounds | answer is Invalid | `src/RealityProxy.sol:128-150` |
| multi-scalar | outcome i pays `answer_i / sum of answers`; an Invalid answer counts as 0 | every answer is 0 or Invalid | `src/RealityProxy.sol:157-190` |

- **Invalid is not a refund.** The Invalid token takes the whole stake and every other outcome pays
  0. Only someone still holding the complete set is made whole. Whoever kept the Invalid tokens
  from a split (usually us, as the seeder) collects from everyone who traded.
- **"Conditional on" means exactly one thing.** A child market's collateral is one outcome token of
  its parent; a child position redeems into that token, not into base collateral
  (`src/Router.sol:201-219`). So a child position is worth (its payout in the child) x (what that
  parent token pays), multiplied down the chain. If the parent token pays 0, everything under it is
  worth 0 whatever the child resolves to. If the parent token pays anything, the child's resolution
  — including Invalid — moves real money.
- The denominator is the sum of the numerators (`ConditionalTokens.sol:94-103`), so only ratios
  matter.

## The procedure

**1. Intent, from the sources alone.** For each market people will actually trade, one sentence:
what is a holder betting on, and under which conditions is the bet supposed to count at all? List
what the request leaves unsaid. Do this before reading the manifest.

**2. The tree, from the plan.** For every market: type, outcomes, the token it uses as collateral,
its Reality question text. Draw it, one line per level.

**3. Two sentences per conditional market.** "Its collateral token pays when …" and "its question
assumes …". They must be the same condition. If the question assumes something the collateral does
not pay on, a level is missing.

**4. Scenarios — the ones the request did not think about.** For every question, list the ways its
premise can fail in the real world, not only the expected outcome:

- the thing never happens, is cancelled, postponed past the opening time, or only partly happens
- an item is dropped, disqualified, merged, renamed, or simply not scored
- zero, a tie, more than one winner, none, an answer outside the bounds or outside the list
- every sibling is zero (a multi-scalar then resolves Invalid)

**5. The payoff table.** For each scenario: the answer each Reality question gets under its literal
text (say so if it would be Invalid or cannot be determined), then what one unit of base collateral
split at the top is worth, per token, at the end. Use small concrete numbers.

**6. Read the table for P/L.** For each scenario:

- Does a trader who was right about what the market *asks* get paid?
- Does anything the request wants left out still move money? **Flag every scenario in which a
  market resolves Invalid while its collateral token is still worth something.** That is the
  round-3 defect in its general form.
- Who collects in the bad scenarios — and is it us, holding unpooled Invalid tokens?
- Does a multi-categorical's 1/k dilution, or a multi-scalar's share-of-sum, match the intent?

**7. Against the precedent,** when the set reshapes or replaces one: what one unit of collateral
pays per leaf, before and after, in the same scenarios. A reshaping for a technical limit must pay
the same.

**8. Settlement.** How many questions must be answered, from what public source, and can each one
be answered as worded in every scenario above?

Out of scope: name length, token symbols, prices, band, gas. The gate and the validator have those.
Mention one if you trip over it; do not go looking.

## The verdict

A scenario whose intended treatment the sources do not state is **not** yours to settle by
assumption. It becomes a question for the user, and it blocks.

| Verdict | When |
|---|---|
| `FAIL` | some scenario pays differently from the stated intent |
| `BLOCKED` | some scenario's intended treatment is unknown — the user must answer first |
| `PASS WITH NOTES` | pays as intended everywhere; something is still worth the user knowing |
| `PASS` | pays as intended in every scenario listed |

The report, in this order:

```
VERDICT: <PASS | PASS WITH NOTES | FAIL | BLOCKED>

## Intent
## Tree
## Payoff table
## Findings        each: the scenario -> who gets what -> how that differs from the intent
## Not verified    what you could not check, and why
## For the user    at most three questions, one plain sentence each, with what goes wrong if the
                   answer is wrong
```

`VERDICT:` is the first line, exactly, because the recorder reads it.

## Recording it

The reviewer is read-only. Whoever ran it saves the report **unedited** as
`campaigns/<slug>/design-review.md`, then:

```bash
node tools/design-review.js <slug>                    # status: is a review recorded, does it still match
node tools/design-review.js <slug> --record           # reads VERDICT from the report, writes gate.designReview
```

`--record` refuses a `FAIL` or `BLOCKED` report. It stores the sha256 of `markets[]` beside the
verdict, so **changing the structure after the review invalidates it** — re-run the review, do not
re-record by hand. `npm run lint:manifest` fails a gated launch manifest without a matching review,
and `lib/run.js` refuses `--live` on one.

A `FAIL` or `BLOCKED` verdict goes to the user as it is, before the gate. Do not redesign around it
silently and do not argue the reviewer down: fix the structure or get the answer, then review again
from a fresh agent.

## Running it

From a Claude Code session, spawn the `seer-market-design-reviewer` agent (defined in
`~/.claude/agents/`). If that agent type is not registered in the session, spawn a general-purpose
agent and tell it to read this file and follow it. Either way the prompt carries only the three
inputs above.
