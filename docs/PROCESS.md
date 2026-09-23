# How this repo is worked on

Written 2026-09-23, after the reorganisation, against the practices in *AI driven development —
36h30 study program* (Lesaege & Astra, 16 September 2026 edition). It records what this repo does,
what it does **not** do, and the evidence for both. It is a scorecard, not a manifesto: the gaps
are listed because they are real.

## The one practice everything else rests on

> "Make verification capable of failing." — Day 2
> "A successful run status means the infrastructure completed; it does not prove that the
> requested development outcome is correct." — Day 5 primer

Every guard in this repo has been made to fail on purpose, and the command that did it is
recorded. Not as a formality — each one found something:

| Guard | Broken on purpose by | What it caught when it mattered |
|---|---|---|
| `tools/refactor-diff.js` | running the old script twice to show gas price varies by itself | a creator that would have made 5 duplicate markets on resume |
| `tools/audit-dry-run.js` | staging a script with `const DRY_RUN = false` | 3 scripts that sent transactions with no gate at all |
| `tools/audit-paths.js` | moving a fixture and reading the error | 11 golden tests broken silently by a file move |
| `.githooks/pre-commit` | staging an armed script and running the hook | that it had stopped matching any file and was checking nothing |
| `check-originality-r3-pools.js` | `SEED_FILE=<corrupted copy>` | designed for this from the start |

**Four times a guard reported success while covering nothing.** Each is written up in
[`LESSONS.md`](LESSONS.md). The shared lesson — trust a **count**, not an exit code — is now the
first thing [`NEW-CAMPAIGN.md`](NEW-CAMPAIGN.md) tells you to do.

## Evidence instead of claims

> "Which command actually ran, which artifact supports its claim, what remains untested." — Day 2

A change to an existing script is not accepted because it looks right. It is accepted because the
old and new versions produced the same output:

```bash
node tools/refactor-diff.js campaigns/<slug>/<script>.js
```

This is possible because every script is dry by default and prints its **entire plan** — every
market resolved, every amount sized. The dry run is the artifact.

Two file moves were proved the same way, by snapshotting all 42 scripts before and after and
normalising only the path substitutions: **42/42 identical**, twice. Where a difference remained it
was explained rather than waved through — the live gas price varies between two runs of the *same*
script, which was demonstrated rather than asserted.

Counter-example, kept deliberately: `add-20k-l1-liquidity.js` matched on 112 of 113 lines, but all
112 were the abort path. Its budget solver was never exercised, and the commit message says so.
An unexercised path is not a verified one.

## Retesting inherited rules

> "Remove or simplify one inherited instruction... Keep any constraint that still prevents a
> demonstrated failure." — Day 3

Two were retested during this work:

- **"Never split a version chain across directories."** Held when some versions were still
  referenced. Retested when every file was provably unreferenced, and it no longer applied — the
  chain now sits whole under `campaigns/zcash-nu7/`, dead generations one level down.
- **"The root scripts are frozen; the data cannot move."** True while scripts named their data by
  hardcoded path. The migration dissolved it: paths come from manifests, so moving a data file
  became a manifest edit. 63 files moved that the original plan had ruled immovable.

Both were **facts that expired**, not opinions that changed. That is the distinction worth keeping.

## Where the knowledge lives

> "Keep project-wide rules short. Put large examples and reference material behind explicit
> links." — Day 3 primer

| | |
|---|---|
| [`../CLAUDE.md`](../CLAUDE.md) | the invariants. Loaded every session |
| [`NEW-CAMPAIGN.md`](NEW-CAMPAIGN.md) | the procedure, from request to verified change |
| [`LESSONS.md`](LESSONS.md) | what went wrong, and the check that now catches it |
| [`NEXT.md`](NEXT.md) | known-unfinished, with enough detail to pick up cold |
| [`README.md`](README.md) | the campaign index |
| `lifecycle/<slug>.json` | what a campaign **is**, machine-readable and validated |
| `~/.claude/skills/seer-market-lifecycle/` | the conversation: intake, grilling, the gate |
| project memory | per-set state that is not derivable from the repo |

A lesson is only finished when it names a mechanical check. Prose prevents nothing.

## The four lightweight artifacts

> "A one-page project brief, an acceptance/evidence list, a run-and-cost log, and a short
> next-step note." — Day 1

A retrospective written to the program's own three templates — report, operating plan and
evidence log — is at [`RETROSPECTIVE-2026-09-23.md`](RETROSPECTIVE-2026-09-23.md). It marks the
fields only the account holder can fill, and records the three process items that were never
exercised rather than omitting them.

| Artifact | Here | Status |
|---|---|---|
| project brief | `lifecycle/<slug>.json` — `source`, `markets`, `liquidity` | **yes**, and machine-validated |
| acceptance / evidence | `stages[]`, `evidenceLog[]`, `gate`, plus the paired verify script | **yes** |
| run-and-cost log | `archive/runs/`, `stages[].txCount` | **partial** — transactions and stdout, but no elapsed time, attention or gas spend |
| next-step note | [`NEXT.md`](NEXT.md) | **yes**, new and untested |

## What this repo does not do

Listed because a scorecard that only records passes is not evidence of judgment.

- **No cost or time accounting.** The program asks for elapsed minutes, intervention minutes and
  spend per task. None is captured, and it cannot be reconstructed after the fact.
- **The skill's replay cases have never been run.** `evals/cases.md` holds 15 cases and a negative
  case. The program is explicit that three cases do not establish reliability and that you must not
  judge a skill by asking whether it is good — yet these have not been exercised once.
- **`CLAUDE.md` is ~150 lines.** Against the same primer that says keep project rules short.
- **`NEW-CAMPAIGN.md` is untested.** It was written from what we did, not proved against a real
  request. Its first use is its first test.
- **No independent reviewer.** The program's capstone requires a fresh evaluator session with the
  task, diff and acceptance criteria. Every verification here was done by the same session that
  made the change — mechanically checked, but not independently reviewed.

That last one is the largest gap. The mechanical checks are strong precisely because nothing else
was watching.

## The habit

> "Inspect failed runs, unique reviewer findings, shared misses and actual usage; remove stale
> instructions and improve a repeated procedure." — Day 5

After a campaign, before closing the session:

1. `npm test` — read the counts.
2. Anything that went wrong → [`LESSONS.md`](LESSONS.md), with its check. No check, say so.
3. Anything unfinished → [`NEXT.md`](NEXT.md).
4. Anything worth asking earlier next time → the skill's `grill-checklist.md` **and** a replay case.
5. Anything that did nothing useful for several runs → propose removing it.

Step 5 is the one that gets skipped. A repo of guards that never fire is as misleading as no guards
at all — `LESSONS.md` already records that the fee-sweep path is dormant and that both Octant
seeders carry a known-wrong default, rather than implying everything here is load-bearing.
