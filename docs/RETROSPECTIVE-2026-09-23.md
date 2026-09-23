# Retrospective — repo systemization, 2026-09-23

Written to the three templates on pp. 18–20 of *AI driven development — 36h30 study program*
(16 September 2026 edition): the short training report, the personal operating plan, and the
evidence log.

Two honesty notes, because a retrospective that only records passes is not evidence of judgment:

- **Fields marked `[YOURS]` can only be filled by the account holder.** Plan allocation, quota and
  spend are not observable from inside the session. They are left blank rather than estimated.
- **Three of the six required process-evidence items were never exercised.** They are recorded as
  not-done with the reason, not quietly omitted.

---

## Short training report

**Project and accepted result.** `D:\Code\liquidity` operates real Seer prediction markets on
Optimism and Gnosis, 1k–20k sUSDS a run. It had grown by forking a script per campaign: 163 files
flat at the root, no code sharing, and `DRY_RUN` as a hand-edited constant with **16 scripts
committed at `false`** — so a command typed verbatim from a guide sent real transactions with no
prompt.

Across 56 commits on `systemize/repo-structure` (unmerged, unpushed, `main` untouched): a shared
`lib/` with a run harness; `lifecycle/<slug>.json` manifests as the schema-validated campaign
contract; all 53 scripts migrated onto the harness or explicitly gated; every file moved into
`campaigns/<slug>/` so the root holds only config; four audits wired into `npm test`.

How it was checked: **every migration was proved, not argued.** `tools/refactor-diff.js` runs the
old and new versions and diffs dry-run output — the entire plan, every market resolved and every
amount sized. Two file moves were proved by snapshotting all 42 scripts before and after and
normalising only path substitutions: **42/42 identical, twice.**

Unfinished, in [`NEXT.md`](NEXT.md): 8,300.58 sUSDS stranded behind one zero outcome in
originality-r2; both Octant seeders carry a known-wrong `live: null` for re-seeds;
[`NEW-CAMPAIGN.md`](NEW-CAMPAIGN.md) is untested against a real request.

**One rediscovery.** The approved plan stated a rule: *never split a version chain across
directories*, and *the root scripts are frozen, so their data cannot move*. Both were retested and
both had **expired** — not because the opinion changed, but because the facts had. Once every path
came from a manifest instead of a hardcoded `"./x.json"`, moving a data file became a manifest
edit, and 63 files the plan called immovable moved. The version-chain rule survived in spirit:
the whole nu7 chain sits under one directory with dead generations in `superseded/`. Lesson kept:
distinguish a constraint that still prevents a demonstrated failure from one whose cause is gone.

**Current setup.** Harness: Claude Code (CLI), Opus 5, on Windows with Git Bash and PowerShell.
Skill: `seer-market-lifecycle`, updated and committed this session. `[YOURS]` — two-plan
allocation, reviewer provider, actual spend and quota observations, and why that allocation fits
this work. The course policy asks for one plan from each of two providers; **no second provider was
used here**, which is the single largest deviation from the program.

**Process evidence.**

| Required item | Here |
|---|---|
| A grilling decision | Four rounds of up-front questions with defaults. The `src/` answer (*keep all, document*) overrode my recommendation to prune — the safer call. |
| A tested skill | **Partial.** Updated and mechanically validated: all 34 repo paths it names resolve. Its 15 replay cases were **not run**. |
| A goal or recovery | Session compacted mid-run and resumed from project memory plus branch state, migration queue intact. Two background sweeps resumed on notification. |
| A graph / Ultra decision | **Not exercised.** The work was sequential by construction — each migration had to be proved before the next built on it. |
| A routine result | **Not done.** No scheduled routine exists. |
| A multitasking decision | While a sweep ran, edited only docs and tooling — never a file the sweep would read. |

**Failure and next step.** The wrong claim I caught was my own, and recent:
`NEW-CAMPAIGN.md` told the reader to expect **36** freeze paths when the real number is **35**. I
wrote it from memory of an earlier run instead of reading the output — in the same paragraph that
warns against a remembered number. Caught by running all four audits and comparing them to what I
had written. Both the doc and the skill now explain what the counts are *for*, and the skill
carries no numbers at all.

Earlier, and worse had it shipped: the extended `audit-dry-run` reported 2 ungated scripts where a
standalone reimplementation found 3, because a literal `0x08` byte sat where `\b` was meant —
visible only under `cat -A`. The output looked plausible either way. **Adjustment for the next
month:** when a number would look believable whether right or wrong, compute it a second way
before trusting it, and compare counts rather than exit codes.

---

## Personal operating plan

A half-page default process. `[YOURS]` marks what the account holder must decide.

- **Plan allocation.** `[YOURS]`. The program's default is one plan from each of two providers, with
  a same-provider exception only where one is strictly superior. This work used a single provider
  with **no independent reviewer**, which is a known gap, not a justified exception.
- **Primary model and reviewer.** Primary: Opus 5 in Claude Code. Reviewer: `[YOURS]` — currently
  none. The mechanical checks here are strong *because* nothing else was watching; that is not a
  substitute for a fresh evaluator session with the task, diff and acceptance criteria.
- **Routing by task.** Mechanical, provable work (migrations, moves) → proceed directly, prove with
  `refactor-diff` or a before/after snapshot. Anything that spends money or writes immutable text →
  stop at the skill's gate and show the full immutable block. Anything ambiguous about intent →
  ask up front with recommended defaults, at most a handful of questions.
- **Project rules vs. skills.** Repo invariants live in `CLAUDE.md` (short, linked). Procedure lives
  in `docs/NEW-CAMPAIGN.md`. The conversation — intake, grilling, gate, report — lives in the
  `seer-market-lifecycle` skill. A per-set fact goes to project memory, never to the skill.
- **When graphs help.** Not for this repo's migration work, which is sequential by construction.
  They would help for independent per-campaign work, e.g. verifying several campaigns' on-chain
  state at once.
- **Required acceptance evidence.** A dry run whose printed plan matches the approved summary; a
  verifier that reads live chain state and has been shown to fail; `npm test` counts, not its exit
  code. A confident summary is not acceptance.
- **Budget escalation.** `spendingCap` in the manifest is enforced by the harness. Exceeding it is a
  stop condition, not a judgement call.
- **Concurrency limit.** At most two background runs, and never one that writes a file another
  reads. Clear a pending verification before starting the next migration — the rule that a
  migration and a behaviour change cannot be proved in the same step is the same rule.
- **Weekly maintenance habit.** Run `npm test` and read the counts; check `NEXT.md` for anything
  that has become urgent; remove one instruction that has not prevented a failure in several runs.
  That last step is the one that gets skipped.
- **Next review date:** `[YOURS]` — suggest at the next campaign, whichever comes first.

---

## Evidence log

The program's template, filled for this body of work. For Web3 it also asks for the chain and
fixture block.

| Field | Record |
|---|---|
| **Task and starting state** | Systemize `D:\Code\liquidity`. Start: 163 root files, 16 scripts committed at `DRY_RUN = false`, no shared code. Branch `systemize/repo-structure` from `main`. Acceptance agreed up front: the frozen scripts' behaviour must be provably unchanged; `npm test` must pass; `main` untouched and nothing pushed. |
| **Configuration** | Opus 5; Claude Code CLI on Windows (Git Bash + PowerShell); Node 22.18.0, engines `>=20.19`; skill `seer-market-lifecycle`; no subagents, no workflow graph. |
| **Cost and time** | `[YOURS]` — quota and subscription cost. Observed from inside the session: two verification sweeps of ~40 min each (42 scripts against live RPC), plus ~84 dry transcripts since deleted. **No per-task elapsed or intervention time was captured**; this is a known gap recorded in NEXT.md and cannot be reconstructed. |
| **Chain / environment** | Optimism (10, sUSDS) and Gnosis (100, sDAI), live mainnet RPC, read-only throughout. **No transaction was sent in this work.** Fixtures are the committed `*-execution.json` logs: 284 pool sizings, 143 Reality question ids and both L1 merge phases replay offline. |
| **Evidence** | `tools/refactor-diff.js` per migration; two 42-script before/after snapshots, 42/42 identical after normalising paths; `npm test` = 67 tests, 52 scripts gated, 35 freeze paths, 8 manifests. Guards demonstrated failing on purpose — table in [`PROCESS.md`](PROCESS.md). Accepted. |
| **Learning** | Four guards reported success while covering nothing after files moved; one tool returned plausible-but-wrong counts from an invisible control character; a complete progress log read as empty and would have created 5 duplicate markets. All three, with their checks, are in [`LESSONS.md`](LESSONS.md). Next adjustment: compute a suspicious number a second way, and read counts rather than exit codes. |
