# Running a new campaign

The path from a request to a verified on-chain change. Written for a session that has never seen
this repo. Every step names the command that proves it.

The `seer-market-lifecycle` skill owns the *conversation* — intake, grilling, the approval gate,
the UI half, the final report. This file owns the *repo*: where things are, what to write, how to
prove it. Read the skill first; it will send you here.

## 0. Orient — 5 minutes, in this order

| Read | For |
|---|---|
| [`../CLAUDE.md`](../CLAUDE.md) | the invariants. Non-negotiable, and short |
| [`README.md`](README.md) | the campaign index: what exists, what is live, what is stranded |
| [`LESSONS.md`](LESSONS.md) | what has already gone wrong. Do not rediscover these |
| project memory `MEMORY.md` | per-set state that is not in the repo |
| [`NEXT.md`](NEXT.md) | known-unfinished work you might be about to collide with |

Then confirm the repo is sound before touching it:

```bash
npm test
```

Expect: **52 scripts gated · 36 freeze paths · 8 manifests · 67 tests**. Read the counts, not the
exit code — see the first entry in LESSONS.md for why.

## 1. Find the precedent

Never start from a blank file, and never fork a frozen script. Pick the closest past campaign by
*market shape*, not by name:

| Your set is | Precedent | Where |
|---|---|---|
| binary / single-select categoricals | zcash-q3 | `campaigns/zcash-q3/` |
| multi-select categorical | gnosis-pd (v2) | `campaigns/gnosis-pd/` |
| multi-scalar, one question per outcome | l1-deepfunding | `campaigns/l1-deepfunding/` |
| a parent with conditional children | originality-r3 | `campaigns/originality-r3/` |
| anything on Gnosis / Swapr (Algebra) | gnosis-pd | `campaigns/gnosis-pd/` |

Read that campaign's `lifecycle/<slug>.json` beside its guide in `docs/guides/`. The manifest tells
you what the campaign *was*; the guide tells you why.

## 2. Write the manifest first

`lifecycle/<new-slug>.json`, copied from the nearest precedent. It is the contract: the script
reads its addresses, band, fee tier, collateral and file paths from here, so **a value that lives
in the manifest must not also live in the script.**

```bash
node tools/validate-manifest.js
```

Checks structure *and* semantics — addresses checksum and match the declared chain, the spending
cap covers the total, every seed price sits strictly inside the band, every artifact path exists.

Two fields decide whether a live run is allowed: `spendingCap` (enforced) and `gate` (re-read
before `--live`, including the sha256 of the seed file).

## 3. Write the script

`campaigns/<new-slug>/<verb>-<slug>.js`, built on [`../lib/README.md`](../lib/README.md). Nothing
goes at the repo root, ever.

```js
await run(
  { name: "...", slug: "<new-slug>", stage: "seed-pools", mutating: true,
    progress: (m) => m.files.liquidity },
  async (ctx) => { /* ctx: manifest, provider, wallet, chainId, addr, log, progress, args, dry */ }
);
```

The harness gives you dry-by-default, `--live`, `--resume`, `--progress=`, `--yes`, the chain-id
assertion, the spend cap, the gate check and a tee'd transcript. You do not re-implement any of it.

Read `lib/README.md` before writing a helper — `ensureAllowance` polls the allowance back,
`alignBand` clamps then re-aligns inward, `getMarketInfo` returns the **base** collateral for a
child market. Each of those exists because a copy that did it differently cost something.

## 4. Make the check capable of failing

This is the step that is easiest to skip and most expensive to skip.

```bash
node campaigns/<slug>/<script>.js            # dry: prints the entire plan
```

Then **break something on purpose** and confirm the check notices:

- corrupt one expected value in the seed file and re-run the verifier — it must exit non-zero and
  name the field. `SEED_FILE=<corrupted copy>` exists on the r3 checker for exactly this.
- stage a script with `const DRY_RUN = false` and run `sh .githooks/pre-commit` — it must refuse.
- move a file the plan depends on and run `node tools/audit-paths.js` — it must name the file and
  the line that needs it.

A verifier that has never failed is not evidence. If you cannot make it fail, it is not checking
what you think.

For a change to an **existing** script, behaviour must be shown unchanged:

```bash
node tools/refactor-diff.js campaigns/<slug>/<script>.js
```

Add `--new-args=--resume` when the progress file is also the historical record.

## 5. Go live

Only after the skill's gate. The dry-run output must match the approved summary exactly.

```bash
node campaigns/<slug>/<script>.js --live
```

For a re-seed, give it a **new** progress path — a progress file is a resume log, and every item
in it is skipped:

```bash
node campaigns/<slug>/<script>.js --progress=campaigns/<slug>/<script>-round2-execution.json --live
```

The reuse guard refuses a non-empty log unless you also pass `--resume`, so getting this wrong
exits 2 rather than silently seeding nothing.

Then verify against **live chain state**, never against the execution JSON:

```bash
node campaigns/<slug>/check-<slug>-pools.js
```

## 6. Record it

| What | Where |
|---|---|
| addresses, totals, wallet before → after | `lifecycle/<slug>.json` — `results`, `stages[]` |
| what you learned about the protocol | `evidenceLog[]` in the same manifest |
| a trap that cost time, and its new guard | [`LESSONS.md`](LESSONS.md) |
| something left unfinished | [`NEXT.md`](NEXT.md) |
| a question worth asking at intake next time | the skill's `references/grill-checklist.md` **and** a replay case in `evals/cases.md` |
| per-set state (live / drained / stranded) | project memory, not the repo |
| the campaign row | [`README.md`](README.md) |

Commit; do not push. `npm test` must pass before you do.

## When to stop

Stop, keep the artifacts, and report a minimal reproducer when:

- dry-run output differs from the approved summary, or the spend would exceed `spendingCap`
- the source document changed after the gate (`gate.summaryHash` catches the seed file)
- a transaction reverts after the script's own retries
- a verifier disagrees with what you expected
- anything needs a decision that the gate did not cover

Repeated attempts with no new evidence is itself a stop condition. Preserve what you have and ask
one focused question rather than trying a sixth variation.
