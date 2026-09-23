# liquidity — operating notes

Scripts that run real Seer prediction markets on **Optimism (10)** and **Gnosis (100)**: creating
markets, seeding Uniswap V3 / Swapr pools, unwinding, answering Reality.eth, redeeming. Every live
run moves real capital.

## Invariants

**1. The root scripts are being migrated onto `lib/`, one at a time, with proof.**
They are records of real on-chain runs, so a migration must be *shown* not to change behaviour:

```bash
node tools/refactor-diff.js <script.js>   # runs the old and new versions, diffs the output
```

For a mutating script that compares **dry-run** output — the whole plan, every market resolved and
every amount sized. Identical plan, sound refactor. The tool refuses to execute an old version
whose `DRY_RUN` is not `true`.

Until a script is migrated it keeps its old shape. **The two generations are invoked differently**,
which is the thing most likely to catch you out:

| | invocation | to send |
|---|---|---|
| migrated | `node x.js` | `node x.js --live` |
| not yet | `node x.js` | edit `const DRY_RUN` in the source |

A migrated script is dry by default and cannot be armed by accident. Never fork an old script to
start a campaign — build on [`lib/`](lib/README.md).

**Migrated so far** (9 of 53 — `grep -l 'lib/run.js' *.js` is the live answer):
`add-zcash-liquidity` · `add-zcash-nu7-liquidity` · `check-zcash-pools` · `check-zcash-nu7-pools` ·
`merge-zcash-positions` · `merge-zcash-nu7-positions` · `remove-liquidity-gnosis` ·
`withdraw-zcash-liquidity` · `withdraw-zcash-nu7-liquidity`

Next, in order of how likely they are to be re-run: `reseed-zcash-liquidity`,
`add-pd-liquidity-gnosis-v2`, the two `create-*-markets`, `create-pd-market-gnosis`,
`fetch-credora-pd`. The l1 / octant / originality scripts are last — those campaigns are closed
out, so migrating them buys consistency and nothing else.

All four deferred improvements are now **done**, each as its own visible change after the
migration it belonged to had been proved identical:

1. `withdraw-zcash-*` now classifies three ways and **sweeps** fees off zero-liquidity positions
   instead of warning about them. (On the current nu7 set all 28 empty positions turn out to be
   clean, so nothing is swept — but that is now *checked* rather than asserted.)
2. `add-zcash-liquidity` **refuses** to run if any pool already exists, pointing at
   `reseed-zcash-liquidity`. It prices from the seed file, and a drained V3 pool keeps its last
   price. Verified firing against all 74 live q3 pools.
3. `create-pd-market-gnosis` gained the **Reality collision check** the other three creators always
   had, and an **idempotency guard** — it refuses when its output file already records a market
   (`--force-new` overrides). Verified firing against the recorded v2 market.
4. `toString31` is documented as **reverting**, not truncating, in `lib/reality.js`.

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
| `test.json`, `data.json`, `participants.json` | `archive/dead/` (unreferenced; `test.json` was a byte-identical copy of `execution.json`) |

Everything on the freeze surface stayed at the root. `npm run audit:paths` is what proves it.

## Environment

ESM, run as bare `node <script>.js` **from the repo root**. Secrets in `.env`:
`PRIVATE_KEY`, `RPC_URL` (Optimism), `GNOSIS_RPC_URL`, `CREDORA_API`.

## Checks

```bash
npm test              # all three audits below
npm run audit:dryrun  # fails if any frozen script is armed to send transactions
npm run audit:paths   # fails if a frozen script's file moved, or a doc link is dead
npm run lint:manifest # validates lifecycle/*.json, structurally and semantically
```
