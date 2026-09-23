# liquidity — operating notes

Scripts that run real Seer prediction markets on **Optimism (10)** and **Gnosis (100)**: creating
markets, seeding Uniswap V3 / Swapr pools, unwinding, answering Reality.eth, redeeming. Every live
run moves real capital.

> This file is being built out as the repo is systemized. See
> `~/.claude/plans/anyway-we-can-improve-transient-pearl.md` for the full plan and remaining steps.

## Invariants

**1. The root `.js` scripts are frozen.**
All 53 of them are records of real on-chain runs. Do not edit them and do not refactor them onto
shared modules. A new campaign is a *new* script, never a fork of an old one.

**2. `*-execution.json` is a RESUME LOG, not a record of holdings.**
Every mutating script skips work already listed in its progress file. Pointing a new round at a
previous round's log makes it skip everything and do nothing — silently. Commit `95bdd69` is the
write-up of that happening. Use a fresh filename per round.

**3. `DRY_RUN` is a hand-edited constant in the frozen scripts, not a flag.**
Run `npm run audit:dryrun` before typing `node <anything>.js`. A script committed at
`DRY_RUN = false` sends real transactions immediately, with no prompt and no undo. The guides tell
you to type these commands verbatim, so the flag state is the only thing standing between a read
and a 10,000 sUSDS spend.

**4. The freeze surface is 58 file paths.**
The frozen scripts reference their inputs and resume logs by relative path. `tools/freeze-surface.json`
is the snapshot; `npm run audit:paths` checks every one still resolves. **Run it before and after
moving any file.** Not every literal is an input — a `PROGRESS_FILE` is a write target and may
legitimately not exist (e.g. `./resolve-l1-execution.json`).

> `assets_pd.ts` is **data, not code**, despite the extension: `fetch-credora-pd.js:22` text-parses
> it at runtime. It must stay at the root.

## Where the knowledge lives

Do not copy these into this file — point at them.

| What | Where |
|---|---|
| How to run a campaign end to end | `~/.claude/skills/seer-market-lifecycle/SKILL.md` (+ `references/grill-checklist.md`, `references/repos.md`) |
| What happened in each past campaign | project memory — `~/.claude/projects/D--Code-liquidity/memory/MEMORY.md` |
| Why a campaign was built the way it was | the `CLAUDE_*_GUIDE.md` / `*_GUIDE.md` files at the root |
| What a campaign *is*, machine-readable | `lifecycle/<slug>.json` |
| On-chain contract reference | `src/*.sol` — a read-only copy of the Seer contracts, never compiled |

## Environment

ESM, run as bare `node <script>.js` **from the repo root**. Secrets in `.env`:
`PRIVATE_KEY`, `RPC_URL` (Optimism), `GNOSIS_RPC_URL`, `CREDORA_API`.

## Checks

```bash
npm test              # audit:dryrun + audit:paths
npm run audit:dryrun  # fails if any frozen script is armed to send transactions
npm run audit:paths   # fails if a file a frozen script depends on has moved
```
