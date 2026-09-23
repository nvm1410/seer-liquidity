# Campaigns

Every market set this repo has operated. The **guide** explains why it was built that way; the
**manifest** is the same campaign as machine-readable data; **runs** holds the stdout transcripts.

| Campaign | Chain | Family | Structure | Capital | Dates | Status |
|---|---|---|---|---|---|---|
| [originality-r3](guides/) *(no guide)* | Optimism | originality | multiScalar parent + 98 conditional scalars | 1,000 sUSDS | 2026-09-22 | live, seeded |
| [zcash-q3](guides/zcash-q3.md) | Optimism | poll | 37 binary categoricals | 20,000 sUSDS | 2026-08-19 → 08-24 | live, re-priced, unresolved |
| [zcash-nu7](guides/zcash-nu7.md) | Optimism | poll | 5 single-select categoricals (v3) | 10,000 sUSDS | 2026-09-09 → 09-14 | live, **zero liquidity**, unresolved |
| [l1-deepfunding](guides/l1-deepfunding.md) | Optimism | deepfunding | nested multiScalar pair (A + B on A#66) | 19,980 sUSDS | 2026-07-27 → 09-01 | **closed out**, redeemed |
| [gnosis-pd](guides/gnosis-pd.md) | Gnosis | credit-pd | 1 multiCategorical, 35 slots | 5 sDAI | 2026-08-12 | live, seeded, unresolved |
| [originality-unwind](guides/originality-unwind.md) | Optimism | originality | round-2 parent + 98 scalar children | — | 2026-06-19 | unwound |

| Campaign | Manifest | Run logs |
|---|---|---|
| originality-r3 | [`lifecycle/originality-r3.json`](../lifecycle/originality-r3.json) | [`archive/runs/originality-r3/`](../archive/runs/originality-r3/) |
| zcash-q3 | [`lifecycle/zcash-q3.json`](../lifecycle/zcash-q3.json) | [`archive/runs/zcash-q3/`](../archive/runs/zcash-q3/) |
| zcash-nu7 | [`lifecycle/zcash-nu7.json`](../lifecycle/zcash-nu7.json) | [`archive/runs/zcash-nu7/`](../archive/runs/zcash-nu7/) |
| l1-deepfunding | [`lifecycle/l1-deepfunding.json`](../lifecycle/l1-deepfunding.json) | [`archive/runs/l1/`](../archive/runs/l1/) |
| gnosis-pd | [`lifecycle/gnosis-pd.json`](../lifecycle/gnosis-pd.json) | — |

## The two chains are not the same shape

Almost every difference between campaigns follows from this one split, so it is worth knowing
before reading any guide:

| | Optimism (10) | Gnosis (100) |
|---|---|---|
| collateral | sUSDS | sDAI |
| AMM | Uniswap V3 | **Swapr = Algebra V1** |
| fee | tier `100`, sent on chain | one *dynamic* fee, **no tiers** |
| tickSpacing | 1 | 60 |
| position manager | Uniswap NPM | Swapr Algebra NPM — `positions()` returns **11** values, not 12 |
| SDK | `@uniswap/v3-sdk` end to end | only the `Pool`/`Position` **math**; all calldata hand-encoded |

The `mathFeeTier: 3000` in the Gnosis manifest exists **solely** so `@uniswap/v3-sdk` derives
`tickSpacing 60`. It is never sent on chain.

## Reading order for a new campaign

1. [`../CLAUDE.md`](../CLAUDE.md) — the invariants. Start here; the frozen-scripts rule and the
   `DRY_RUN` hazard both bite before you run anything.
2. [`../lifecycle/README.md`](../lifecycle/README.md) — what a manifest holds and which half a
   script may read.
3. The guide for the nearest precedent campaign, then its manifest side by side.

## Reference

[`reference/ui/`](reference/ui/) — files that belong to the UI repos, kept here because scripts cite
them. `useImpliedProbs.ts` is the probability-of-default model (`implied-prices.js` is a
forward-only ESM port of it); `get-originality-markets-data.ts` is an Apollo/Supabase data function.
**Neither runs in this repo** — their imports do not resolve here.
