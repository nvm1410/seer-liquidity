# Next

Known-unfinished work, with enough detail to pick up cold. Nothing here is urgent; nothing here is
blocking a campaign. Entries are ordered by what a future session is most likely to trip over.

Delete an entry when it is done. If an entry turns out to be wrong, say so rather than silently
dropping it.

## Open money

### originality-r2: 8,300.58 sUSDS stranded
One parent outcome (index 63, `EIPS`) sits at zero, and `mergePositions` is capped at
`min(balance)` across the full partition, so phase 3 cannot run at all.
**To recover:** acquire any non-zero amount of that one outcome token, then re-run
`campaigns/originality-r2/remove-merge-originality.js`. The merge amount is then bounded by the
next-smallest holding, not by zero. Confirm the arithmetic in a dry run first — the projection
prints the binding minimum.
**Not attempted.** Nobody has priced what acquiring that token costs against 8,300 sUSDS.

### zcash-nu7 v3: 2,204.29 outcome tokens stranded
Expected, not a fault — the residue of an unbalanced set after unwinding. Redeemable only once the
markets resolve. v1 holds 6.99 tokens and v2 holds 5 wei, and **neither is recoverable**: every
market in both has an outcome at zero, so a merge returns 0. Verified on chain 2026-09-23.

## Known-wrong, guarded by a comment rather than a check

### Both Octant seeders price from a constant and never read the pool
`add-octant-liquidity.js` and `add-octant-invalid-liquidity.js` pass `live: null` to
`buildPoolAndBounds`. Correct for a first seed, **wrong for a re-seed** — a drained pool keeps its
`sqrtPriceX96`. `lib/uniswap.js` takes `live` precisely so this is fixable.
**Why it is still here:** fixing it inside the migration would have been a behaviour change with
nothing to diff against. It needs its own change, with its own proof.
**How to do it:** follow `add-zcash-liquidity.js`, which reads the live pool and refuses if one
already exists. Prove with `tools/refactor-diff.js`; expect the diff to be non-empty, and justify
every differing line.

### check-originality-r3-pools exits 1 on a live market
Its ±0.001 price tolerance is sized for "verify immediately after seeding" — one tick of floor
error. On a market that has traded it decays into a drift report: 11 of 98 repos are outside it as
of 2026-09-23, all 196 pools otherwise healthy.
**Options:** widen the tolerance, or split the check into "structure" (should always pass) and
"drift" (informational). Structure-only already exists as `--markets-only`.

## Documentation debt

### CLAUDE.md is long
~150 lines. The program this repo's process was measured against says project-wide rules should be
short, with reference behind links. The invariants each earn their place, but the explanations
could move to a linked page leaving one-line rules.

### The five guides describe campaigns, not the current way of working
They are accurate history with a `HISTORICAL` header and correct commands. What does **not** exist
is a guide for a campaign that has not happened yet — `docs/NEW-CAMPAIGN.md` is that, and it is
new and untested against a real request.

## Process gaps

### The skill's smoke test has never been run
`SKILL.md` says to judge the skill by its replay cases, and the program says to test a skill with
three prompts: one that should activate it, one similar that should not, and a boundary case with
a missing input. `evals/cases.md` exists but has not been exercised since the repo was
reorganised — and the skill referenced paths that no longer existed until 2026-09-23.

### No run-and-cost log
Elapsed time, intervention time and spend are not recorded anywhere. The evidence log in
[`RETROSPECTIVE-2026-09-23.md`](RETROSPECTIVE-2026-09-23.md) has the row shape; the cost fields in
it are blank for exactly this reason. `archive/runs/` has stdout
and `lifecycle/*.json` has `stages[].txCount`, but nothing says what a campaign cost in gas or in
attention. Would need to be captured at the time; it cannot be reconstructed.

### Verification of a file move costs ~40 minutes
The before/after snapshot of all 42 scripts is thorough and slow. A cheaper tier — only the scripts
whose paths actually changed — would cover most moves. The expensive version is right when imports
are rewritten; it was overkill for the data-only move.

## Deliberately not doing

- **Pruning `src/`.** 45 contracts, 9 referenced. Kept whole on purpose: a partial mirror of
  upstream is harder to trust than a complete one. See `src/README.md`.
- **npm aliases or a root dispatcher** for running scripts. Both were considered and rejected:
  a second invocation path the guides must also teach, and the full path names the campaign whose
  money is at stake.
- **Rewriting the historical guides' narrative.** Their runbook commands are current; their
  history is history.
