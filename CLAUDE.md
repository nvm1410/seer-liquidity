# liquidity — operating notes

Scripts that run real Seer prediction markets on **Optimism (10)** and **Gnosis (100)**: creating
markets, seeding Uniswap V3 / Swapr pools, unwinding, answering Reality.eth, redeeming. Every live
run moves real capital.

## Invariants

**1. Every operational script runs on the harness. There is no `DRY_RUN` constant left.**
The hand-edited flag is gone from the repo — `grep -rn '^const DRY_RUN' campaigns` returns nothing. A script
is dry by default and cannot be armed by accident:

```bash
node x.js          # dry run: prints the whole plan, sends nothing, exits 0
node x.js --live   # the only way to send, after a confirmation
```

**2. A change to one of these scripts must be *shown* not to change behaviour.**
They are records of real on-chain runs.

```bash
node tools/refactor-diff.js <script.js>   # runs the old and new versions, diffs the output
```

For a mutating script that compares **dry-run** output — the whole plan, every market resolved and
every amount sized. Identical plan, sound refactor. Some scripts need `--new-args=--resume` because
their progress file is also their historical record; that is the reuse guard doing its job, not a
problem to route around.

Never fork an old script to start a campaign — build on [`lib/`](lib/README.md).

**3. Three scripts are GATED, not migrated, and the distinction matters.**
`index.js`, `liquidity-l1.js` and `liquidity-originality.js` never had a `DRY_RUN` at all: every
line sent real transactions the moment they ran. With no dry mode there is nothing for
refactor-diff to compare, so rewriting them could not satisfy invariant 2. Each instead got a
`parseArgs()` `--live` gate and a header naming its successor — additions only, zero lines deleted,
so everything below each gate is byte-identical. Bare `node campaigns/l1-deepfunding/superseded/index.js` now exits 2 and sends nothing.

`tools/audit-dry-run.js` was blind to exactly this class: it looked only for `const DRY_RUN = false`,
so a script with no flag passed by omission. It now also fails any script that matches a sending
call site while declaring neither a `DRY_RUN` nor an import of `lib/run.js`.

**Status: the root holds no scripts and no campaign data.** Every `.js` lives with the campaign it
belongs to; 52 of them are gated, and `lib/implied-prices.js` is the one piece of shared math that
moved into the library. `grep -rl 'lib/run.js' campaigns` is the live answer.

Four deferred improvements landed separately, each after the migration it belonged to had been
proved identical:

1. `withdraw-zcash-*` now classifies three ways and **sweeps** fees off zero-liquidity positions
   instead of warning about them. Note what this is worth *today*: on nu7 all 28 empty positions
   turn out to be clean, and on q3 all 74 still hold liquidity, so neither set has anything to
   sweep. The path is dormant. What changed is that the scripts now *check* instead of asserting
   that fees "must be collected separately", and a wallet holding only fee-bearing empty positions
   is no longer told "nothing to withdraw".
2. `add-zcash-liquidity` **refuses** to run if any pool already exists, pointing at
   `reseed-zcash-liquidity`. It prices from the seed file, and a drained V3 pool keeps its last
   price. Verified firing against all 74 live q3 pools.
3. `create-pd-market-gnosis` gained the **Reality collision check** the other three creators always
   had, and an **idempotency guard** — it refuses when its output file already records a market
   (`--force-new` overrides). Verified firing against the recorded v2 market.
4. `toString31` is documented as **reverting**, not truncating, in `lib/reality.js`.

**4. Two seeding scripts still price from a constant and never read the pool.**
`add-octant-liquidity.js` and `add-octant-invalid-liquidity.js` pass `live: null`. That is right for
a first seed and **wrong for a re-seed**: a drained pool keeps its `sqrtPriceX96` and
`createAndInitializePoolIfNecessary` is a no-op on it, so the mint would execute at the pool's own
price. `lib/uniswap.js` takes `live` precisely so this is fixable; it was left alone because
changing it inside a migration would have been a behaviour change with nothing to diff against.

**5. A progress log that predates the `kind`/`key` convention must not be read with `progress.has()`.**
Most historical logs carry only `positionId`, `market` or `outcomeToken`. `progress.has(kind, key)`
reads such a log as EMPTY — a *complete* log looks like a fresh one, so a resumed run redoes
everything. Those scripts key off the original field instead, and say so in a comment at the point
of use.

## Where the knowledge lives

Do not copy these into this file — point at them.

| What | Where |
|---|---|
| How to run a campaign end to end | `~/.claude/skills/seer-market-lifecycle/SKILL.md` (+ `references/grill-checklist.md`, `references/repos.md`) |
| What happened in each past campaign | project memory — `~/.claude/projects/D--Code-liquidity/memory/MEMORY.md` |
| The campaign index (chain, structure, capital, dates, status) | [`docs/README.md`](docs/README.md) |
| Why a campaign was built the way it was | [`docs/guides/`](docs/guides/) |
| What a campaign *is*, machine-readable | `lifecycle/<slug>.json` ([schema](lifecycle/README.md)) |
| How to write a new campaign script | [`lib/README.md`](lib/README.md) — the harness, its flags and its guards |
| On-chain contract reference | `src/*.sol` — a read-only copy of the Seer contracts, never compiled |

## Files that moved

The frozen scripts cite guides **by name** in their header comments — e.g.
`add-zcash-nu7-liquidity.js:23` says *"see CLAUDE_ZCASH_MARKETS_GUIDE.md step 5"*. Those names no
longer exist, so grep lands here instead:

| Cited as | Now at |
|---|---|
| `CLAUDE_L1_ADDBACK_GUIDE.md` | `docs/guides/l1-deepfunding.md` |
| `CLAUDE_ZCASH_MARKETS_GUIDE.md` | `docs/guides/zcash-q3.md` |
| `CLAUDE_ZCASH_NU7_GUIDE.md` | `docs/guides/zcash-nu7.md` |
| `GNOSIS_PD_MARKET_GUIDE.md` | `docs/guides/gnosis-pd.md` |
| `REMOVE_MERGE_ORIGINALITY_GUIDE.md` | `docs/guides/originality-unwind.md` |
| `useImpliedProbs.ts`, `get-originality-markets-data.ts` | `docs/reference/ui/` (UI-repo files, not runnable here) |
| `*-run.log`, `*-dryrun.log` | `archive/runs/<campaign>/` |
| every campaign's `*-execution.json`, seed, CSV and cache | `campaigns/<slug>/` — see below |
| `test.json`, `data.json`, `participants.json` | `archive/dead/` (unreferenced; `test.json` was a byte-identical copy of `execution.json`) |

## Layout

```
root        package.json, CLAUDE.md, README.md, .env*, .gitignore, .nvmrc   config only
lib/        the harness and shared modules      <- build the next campaign on this
lifecycle/  manifests + schema                  <- declare the next campaign here
tools/      audits, refactor-diff               <- the guards
tests/      golden tests
docs/       guides + the campaign index
campaigns/  every past campaign, self-contained: its scripts AND its data
archive/    run transcripts, dead files, orphan tools
src/ abis/  read-only contract reference
runs/       harness output (dry transcripts, gitignored)
```

A campaign is one directory. `campaigns/zcash-q3/` holds the six scripts that ran it, its seed CSV,
its proposals JSON and every execution log. A superseded generation goes one level down in
`superseded/` — `campaigns/zcash-nu7/superseded/` has the twelve v1/v2 files, so the whole version
chain stays in one place, and `campaigns/l1-deepfunding/superseded/` holds the two ungated scripts.

**A new campaign is a new `campaigns/<slug>/` plus a new `lifecycle/<slug>.json`, written against
`lib/`.** Nothing is added to the root, ever.

Scripts are run **from the repo root** by their full path, because several read CWD-relative paths:

```bash
node campaigns/zcash-q3/add-zcash-liquidity.js          # dry
node campaigns/zcash-q3/add-zcash-liquidity.js --live   # sends
```

Three cross-campaign imports are deliberate and correct — `originality-r3`'s snapshot script imports
`../originality-r2/markets.js` because its entire job is reading round-2 data.

## Environment

ESM, Node >= 20.19. Run scripts **from the repo root** by their full path
(`node campaigns/<slug>/<script>.js`) — several read CWD-relative files, so the working
directory is load-bearing. Secrets in `.env`: `PRIVATE_KEY`, `RPC_URL` (Optimism),
`GNOSIS_RPC_URL`, `CREDORA_API`.

## Checks

```bash
npm test              # all three audits below
npm run audit:dryrun  # fails if any frozen script is armed to send transactions
npm run audit:paths   # fails if a frozen script's file moved, or a doc link is dead
npm run lint:manifest # validates lifecycle/*.json, structurally and semantically
```
