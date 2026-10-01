# Lessons

Things that went wrong, what they cost, and the check that now catches them. Append here when a
run surfaces something a future session would otherwise rediscover.

**A lesson is only finished when it has a mechanical check.** Prose in this file prevents nothing;
the entry exists to explain a guard that already exists. If you cannot name the check, the lesson
is not done — say so in the entry rather than pretending.

Where things go:

| What you learned | Where it belongs |
|---|---|
| A repo-wide rule that must hold forever | an invariant in [`../CLAUDE.md`](../CLAUDE.md), with the check |
| A trap that cost time or money, now guarded | here |
| A fact about one campaign (addresses, what is stranded) | that campaign's `lifecycle/<slug>.json`, `evidenceLog` |
| A question worth asking at intake next time | the skill's `references/grill-checklist.md`, **plus a replay case** |
| Something still broken or unfinished | [`NEXT.md`](NEXT.md) |

## Format

```
### <short name>            <date>  ·  cost: <what it cost, or "caught before it cost anything">
What happened. What the wrong assumption was.
**Caught by:** the check that found it, or "nothing — found by hand".
**Now guarded by:** the command that fails if it recurs. Or "NOT GUARDED" and why.
```

---

### A set built exactly as planned, on the wrong structure  2026-09-22 · cost: a second full build, and a withdraw-only set that must still be settled
originality-r3 hung its 98 score markets directly on the bundle tokens. A repo that is never
evaluated then resolves Invalid while its bundle token still pays, so DOWN and UP go to 0, the
Invalid token takes the stake, and every unevaluated repo is counted in P/L. What was wanted: only
evaluated repos count, which needs the repo's own token to pay 0 — a level in between. The wrong
assumption was that "conditional on the bundle" and "conditional on this repo being evaluated" were
close enough, and that the missing rule for unevaluated repos could be settled later. Every check
passed: the dry run, the verifier and the immutable-text gate all compare the run to the plan, and
the plan was the mistake.
**Caught by:** nothing — the user saw the missing level in a diagram, after the set was live and traded.
**Now guarded by:** an independent design review ([`DESIGN-REVIEW.md`](DESIGN-REVIEW.md)), recorded
by `node tools/design-review.js <slug> --record`. `lib/run.js` refuses `--live` on a launch without
a passing review of the current `markets[]`, and `npm run lint:manifest` fails a gated one
(`tests/design-review.test.js`, plus a case in `tests/harness.e2e.test.js`). The review itself is a
judgment, not a mechanical check, so it was made to fail on purpose: on 2026-10-01 it was run on
this defect with the nouns changed (projects and groups for repos and bundles) and on a different
one (independent approvals built as one multi-categorical, which pays 1/k). Both came back `FAIL`
with the scenario named, and the correct three-level version of the first came back `PASS WITH
NOTES`, so it does not fail everything. The review is not only for nested sets: three flat ones were run the
same day — a non-exhaustive single-select (`BLOCKED`), a multi-scalar asked to pay absolute values
(`FAIL`) and three clean yes/no markets (`PASS WITH NOTES`). Re-run those replays (`evals/cases.md`
22-24 and 26-28 in the skill) whenever the brief changes.

### MarketView cannot read a child with more slots than its parent  2026-10-01 · cost: caught on a fork, before anything was sent
`MarketView.getMarket` reverts for a conditional market that has more outcome slots than its parent
has outcomes. `getParentMarketInfo` sizes the PARENT's outcome list by the CHILD's condition
(`src/MarketView.sol:216` passes `market.conditionId()` with `parentMarket`), so it reads
`parentMarket.outcomes(i)` past the end. Every earlier nested set had a small child under a large
parent (3 slots under 4, or under 99), so it never fired. originality-r3-v3's middle markets are the
first the other way round: 34 slots under a 3-outcome parent. The market itself is fine — create,
split, merge and resolve never touch MarketView — but anything that READS it through MarketView
fails, with no revert reason. The same line is still in seer-pm/demo.
**Caught by:** a fork rehearsal of the live create run (hardhat fork of Optimism), at the verify step
after the first middle market was created. A dry run cannot catch it: the market does not exist yet.
**Now guarded by:** `campaigns/originality-r3-v3/read-market.js` reads a market off its own contract,
and the three r3-v3 scripts use it for the middle markets. NOT a general check: a new nested set
whose child is wider than its parent must be fork-rehearsed, or use that reader from the start.

### A plan hash that leaked the wallet balance  2026-09-30 · cost: caught before it cost anything
`planShape` masked wei-length integers (13+ digits) *before* decimals. An 18-decimal `formatUnits`
fraction is itself 13+ digits, so `59251.372969887868268818` became `59251.<n>`, and the integer
part of the balance ended up in the approval hash. The withdraw scripts print short decimals, so
this never fired there. Found while building the first scheduled settle run, whose plan printed full
18-decimal amounts. Two smaller traps turned up in the same work. A padded amount column moves
whitespace in a hashed line whenever an amount's width changes. And a finalization check read
`Date.now()`, while Reality compares against `block.timestamp`.
**Caught by:** inspecting the `planShape` of a real dry run, and a fork rehearsal (hardhat fork of
Optimism, time warped past finalization, live run against the fork) that compared the before/after
hashes.
**Now guarded by:** `tests/settle-schedule.test.js` "masks an 18-decimal amount whole". The script
prints amounts unpadded and reads chain time. It is not a general check; a new schedulable script
should be fork-rehearsed the same way.

### A green check that checked nothing — four times  2026-09-23 · cost: caught before it cost anything

Every time files moved, a guard kept passing while silently covering nothing:

- `audit-dry-run` printed `0 script(s) checked, all gated` and exited 0 once the root emptied.
- Its harness test matched only `"./lib/run.js"`, so all 26 migrated scripts read as *ungated* at
  `"../../lib/run.js"` — a 26-wide false positive in the other direction.
- `audit-paths` resolved every literal against the repo root, wrong for `"../../lib/run.js"`, and
  before that crashed outright with a `TypeError`.
- `.githooks/pre-commit` filtered staged files with `^[^/]+\.js$` — root-level only — so after the
  move it matched nothing and stopped checking anything at all.

The shared mistake is trusting an **exit code** instead of a **count**.

**Caught by:** re-running each audit after the move and reading the number, not the status.
**Now guarded by:** `node tools/audit-dry-run.js` treats an empty scan as a hard failure. After any
move, run `npm test` and confirm the counts: 52 scripts gated, 36 freeze paths, 8 manifests, 67
tests.

---

### A tool that reported plausible-but-wrong numbers  2026-09-23 · cost: caught before it cost anything

The first run of the extended `audit-dry-run` found 2 ungated scripts; a standalone
reimplementation of the same logic found 3, and disagreed on the per-file counts. Cause: a literal
`0x08` byte where `\b` was meant, visible only under `cat -A` as `/^Hwallet\./`. The tool's output
was entirely believable.

**Caught by:** writing the check a second way and comparing counts.
**Now guarded by:** nothing automatic. When a tool's output would be believable either way, compute
it twice by different means before trusting it.

---

### A complete progress log that reads as empty  2026-09-23 · cost: would have created 5 duplicate markets

`progress.has(kind, key)` returns false for every entry in a log written before the `kind`/`key`
convention — and those logs carry only `positionId`, `market` or `outcomeToken`. A *complete* log
therefore looks exactly like a fresh one, so a resumed run redoes everything. On a creator that
means duplicate markets, and market creation is not idempotent.

**Caught by:** `tools/refactor-diff.js` comparing dry-run output before and after a migration.
**Now guarded by:** every script reading a historical log keys off the original field and says so
in a comment at the point of use. Invariant 5 in CLAUDE.md.

---

### Verifying a migration rewrote a gated file  2026-09-23 · cost: caught and reverted within the session

Proving `snapshot-originality-r2-prices.js` unchanged required running it — and it **writes**
`originality-r3-seed.json`, whose sha256 is pinned as `gate.summaryHash`. Two runs moved the hash
from `c14e5a19…` to `ac623825…`, which would have made the seeder refuse to go live against a seed
nobody re-approved.

**Caught by:** hashing the file before and after on purpose, because the manifest said it was gated.
**Now guarded by:** the script takes `--out=`, and its header states the hazard. Before running
anything that writes, check whether its output is named in a manifest's `gate`.

---

### A near-1 outcome eats the whole budget  2026-07-04 · cost: 4.269 of 5 sDAI into one pool

Gnosis PD v1 sized every outcome by the same token quantity `Q`. Collateral consumed scales with
price, so "No To All" at 0.9654 took 85% of the budget across 25 pools. Round 2 worked around it by
excluding that pool; v2 fixed it by sizing that outcome **by collateral** at a fixed cap.

**Caught by:** reading v1's own dry-run capital table — it was visible before sending.
**Now guarded by:** `lib/uniswap.js` exports `sizePositionByCollateral` for exactly this. Not
automatic: a dry run's capital table is the check, and someone has to read it.

---

### Merge order on a nested pair  2026-08-25 · cost: would have been ~17.7k sUSDS

`mergePositions` is capped at `min(balance)` across the **full** partition including Invalid.
Merging the L1 parent first would have capped the whole unwind at the ~2,749 stray OTHER tokens
instead of 20,476. Redeem is also child-first, but for a different reason: a child redeems *into*
the parent's outcome token, whose standalone balance was zero.

**Caught by:** the dry run's per-outcome table showing which outcome was the binding minimum.
**Now guarded by:** `unwind.order` and `unwind.orderNote` in `lifecycle/l1-deepfunding.json`, and
the header of `lib/settle.js`. Not automatic — the manifest states the order, it does not enforce it.

---

### A drained pool keeps its price  2026-08-24 · cost: a mispriced re-seed, caught in dry run

A Uniswap V3 pool with zero liquidity is not a gone pool: it keeps its `sqrtPriceX96`, and
`createAndInitializePoolIfNecessary` is a **no-op** on it. Pricing a re-seed from the seed file
mints at the pool's own price instead, and `mintAmountsWithSlippage` can revert outright.

**Caught by:** comparing the dry run's effective price against the intended seed price.
**Now guarded by:** `buildPoolAndBounds` takes `live`; `add-zcash-liquidity.js` refuses if any pool
already exists. **Still open:** both Octant seeders pass `live: null` — see NEXT.md.

---

### Market names are immutable and nobody reads them twice  2026-09-09 · cost: a whole market set rebuilt

Zcash NU7 v2 appended full resolution rules to every market name, pushing them to 301–375
characters with the question buried in front of two sentences of rules. Names cannot be edited, so
the only fix was a third build.

**Caught by:** the user reading the dry run's immutable-text block.
**Now guarded by:** every creator prints every immutable string before sending, and the skill's gate
requires it be shown in full. The memory note `show-immutable-output-before-committing` exists
because this is the expensive class of mistake: not a bug, an un-editable decision.
