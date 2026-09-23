# `lib/` — the shared layer

**For new campaigns only.** The 53 scripts under `campaigns/` are frozen records of real on-chain runs and must
never be refactored onto this. `lib/` may not import a frozen script, and no frozen script may
import `lib/`.

## Why it exists

Not one of the 53 scripts imports another. The measured result:

| Helper | Copies | **Distinct implementations** |
|---|---|---|
| `retryTransaction` | 32 | **9** |
| `ensureAllowance` | 17 | **10** |
| `sizePosition` | 9 | 7 |
| `buildPoolAndBounds` | 8 | 7 |
| `getMarketInfo` | 9 | 7 |
| `sortTokens` | 22 | 2 |
| `priceToTick` | 11 | **1** |

Ten implementations of the function that approves token spending. A fix in one never reached the
others — the polling `ensureAllowance` that survives RPC lag exists in exactly one file, and the
readable `shortMessage` error logging in exactly one other.

## Modules

| Module | Holds |
|---|---|
| `chains.js` | the two chain address books; pinned against every manifest by `tests/chains.test.js` |
| `env.js` | `loadEnv` — asserts the env vars **and** the chain id (each lineage had only one) |
| `tx.js` | `retryTransaction`, `ensureAllowance` (polls the allowance back), `sleep` |
| `batch.js` | `runBatched` (paced batches) and `mapConcurrent` (worker pool) — deliberately separate |
| `ticks.js` | `sortTokens`, `priceToTick`, `alignTick`, `alignBand` |
| `uniswap.js` | `buildPoolAndBounds`, `sizePosition`, `sizePositionByCollateral`, the min ABIs |
| `progress.js` | the resume log, which refuses silent reuse |
| `manifest.js` | `loadManifest`, `resolveAddresses`, `resolveAmm`, `appendStage` |
| `log.js` | a console that tees to a file |
| `run.js` | the harness |

## The harness

```js
import { run } from "./lib/run.js";

await run(
  {
    name: "add-originality-r4-liquidity",
    slug: "originality-r4",      // -> lifecycle/originality-r4.json
    stage: "phase1-seed",        // -> the stage recorded in that manifest
    mutating: true,              // false for a read-only verifier
    needsGate: true,             // --live refused without a recorded approval
  },
  async (ctx) => {
    for (const pool of plan) {
      if (ctx.progress.has("pool", pool.key)) continue;   // resume
      const meta = buildPoolAndBounds({ ...pool, chainId: ctx.chainId, ...ctx.amm, band: ctx.manifest.liquidity.band });
      const sized = sizePosition(meta, pool.q);
      ctx.log.log(`${pool.key}: ${sized.collateralUsed}`);
      if (ctx.dry) continue;                              // dry stops here
      ctx.spend.charge(Number(sized.collateralUsed) / 1e18);
      const receipt = await retryTransaction(() => mint(sized), { log: ctx.log });
      ctx.progress.append({ kind: "pool", key: pool.key, txHash: receipt.hash });
    }
  }
);
```

### Flags

| | |
|---|---|
| *(none)* | **dry run.** Prints the plan, exits 0, sends nothing. There is no constant to edit and none to forget to reset. |
| `--live` | the only way to send. Near misses (`--LIVE`, `--live=true`, `-live`) do **not** arm it. |
| `--resume` | required to reopen a non-empty progress log. Without it: exit 2. |
| `--progress=<path>` | default `runs/<slug>/<stage>/progress.json`; the transcript follows it |
| `--yes` | skip the confirmation prompt |

### What `--live` must survive, cheapest check first

1. the manifest is `status: "gated"` with a recorded approval
2. the seed file still hashes to what was approved
3. the progress file is fresh, or `--resume` was passed
4. the env vars are present **and** the RPC is on the expected chain
5. the wallet holds the collateral the plan needs — a hard abort, not a warning
6. a `y/N` confirmation — the first one anywhere in this repo

Exit codes: `0` ok · `1` fatal · `2` refused by a guard. Distinct so a wrapper can tell "you invoked
this wrong" from "it broke".

## Evidence

`npm test` proves the extraction rather than asserting it:

- **284 real positions replayed** from the committed execution JSONs with exact BigInt equality on
  ticks and both legs — 196 originality-r3 (conditional bundle-token collateral), 14 zcash-nu7 v3,
  74 zcash-q3. Offline, deterministic, free.
- **Every guard spawned and observed refusing**, asserting on exit codes.
- **Mutation-tested**: flipping `priceToTick` from floor to ceil, shrinking the `sizePosition`
  sentinel, or shifting a band edge each fails with the offending pool named.
