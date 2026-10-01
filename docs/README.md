# Campaigns

Every market set this repo has operated. The **guide** explains why it was built that way; the
**manifest** is the same campaign as machine-readable data; **data** holds its seeds, CSVs and
execution logs; **runs** holds the stdout transcripts.

A campaign is four things in four places, all keyed by the same slug:

```
docs/guides/<slug>.md      why it was built that way            (prose)
lifecycle/<slug>.json      what it is, and where its files are  (data)
campaigns/<slug>/          its scripts, seeds, CSVs and logs    (code + records)
archive/runs/<campaign>/   the stdout of the live runs          (transcripts)
```

Nothing reads a campaign file by a hardcoded path: a script gets its paths from its manifest, so
moving one is a manifest edit. The root itself holds only configuration — no scripts, no data.

Run a script from the repo root by its full path, e.g.
`node campaigns/zcash-q3/add-zcash-liquidity.js --live`. Several read CWD-relative files, so the
working directory matters.

| Campaign | Chain | Family | Structure | Capital | Dates | Status |
|---|---|---|---|---|---|---|
| [originality-r3-v3](guides/) *(no guide)* | Optimism | originality | multiScalar parent + 3 conditional multiCategoricals (one per bundle) + 98 conditional scalars, one per repo token | 1,000 sUSDS | 2026-10-01 | live, seeded |
| [originality-r3](guides/) *(no guide)* | Optimism | originality | multiScalar parent + 98 conditional scalars | 1,000 sUSDS | 2026-09-22 | **incorrect** (middle level missing), replaced by r3-v3; left live and seeded so its users can exit |
| [zcash-q3](guides/zcash-q3.md) | Optimism | poll | 37 binary categoricals | 20,000 sUSDS | 2026-08-19 → 08-24 | live, re-priced, unresolved |
| [zcash-nu7](guides/zcash-nu7.md) | Optimism | poll | 5 single-select categoricals (v3) | 10,000 sUSDS | 2026-09-09 → 09-14 | live, **zero liquidity**, unresolved |
| [l1-deepfunding](guides/l1-deepfunding.md) | Optimism | deepfunding | nested multiScalar pair (A + B on A#66) | 19,980 sUSDS | 2026-07-27 → 09-01 | **closed out**, redeemed |
| [gnosis-pd](guides/gnosis-pd.md) | Gnosis | credit-pd | 1 multiCategorical, 35 slots | 5 sDAI | 2026-08-12 | live, seeded, unresolved |
| [gnosis-pd-v1](guides/gnosis-pd.md) | Gnosis | credit-pd | 1 multiCategorical, 26 slots | 5 + 5 sDAI | 2026-07-04 → 08-12 | **superseded**, drained to fund v2 |
| [octant](guides/) *(no guide)* | Optimism | other | 1 multiScalar, 26 slots | 20,000 sUSDS | 2026-?? | **closed out**, answered + resolved |
| [originality-r2](guides/originality-unwind.md) | Optimism | originality | round-2 parent + 98 scalar children | 60,000 sUSDS | 2026-06-19 | unwound; 8,300.58 sUSDS stranded behind one zero outcome |

| Campaign | Manifest | Data | Run logs |
|---|---|---|---|
| originality-r3-v3 | [`lifecycle/originality-r3-v3.json`](../lifecycle/originality-r3-v3.json) | [`campaigns/originality-r3-v3/`](../campaigns/originality-r3-v3/) | [`archive/runs/originality-r3-v3/`](../archive/runs/originality-r3-v3/) |
| originality-r3 | [`lifecycle/originality-r3.json`](../lifecycle/originality-r3.json) | [`campaigns/originality-r3/`](../campaigns/originality-r3/) | [`archive/runs/originality-r3/`](../archive/runs/originality-r3/) |
| zcash-q3 | [`lifecycle/zcash-q3.json`](../lifecycle/zcash-q3.json) | [`campaigns/zcash-q3/`](../campaigns/zcash-q3/) | [`archive/runs/zcash-q3/`](../archive/runs/zcash-q3/) |
| zcash-nu7 | [`lifecycle/zcash-nu7.json`](../lifecycle/zcash-nu7.json) | [`campaigns/zcash-nu7/`](../campaigns/zcash-nu7/) | [`archive/runs/zcash-nu7/`](../archive/runs/zcash-nu7/) |
| l1-deepfunding | [`lifecycle/l1-deepfunding.json`](../lifecycle/l1-deepfunding.json) | [`campaigns/l1-deepfunding/`](../campaigns/l1-deepfunding/) | [`archive/runs/l1/`](../archive/runs/l1/) |
| octant | [`lifecycle/octant.json`](../lifecycle/octant.json) | [`campaigns/octant/`](../campaigns/octant/) | — |
| gnosis-pd | [`lifecycle/gnosis-pd.json`](../lifecycle/gnosis-pd.json) | [`campaigns/gnosis-pd/`](../campaigns/gnosis-pd/) | — |
| gnosis-pd-v1 | [`lifecycle/gnosis-pd-v1.json`](../lifecycle/gnosis-pd-v1.json) | [`campaigns/gnosis-pd-v1/`](../campaigns/gnosis-pd-v1/) | — |
| originality-r2 | [`lifecycle/originality-r2.json`](../lifecycle/originality-r2.json) | [`campaigns/originality-r2/`](../campaigns/originality-r2/) | — |

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

1. [`../CLAUDE.md`](../CLAUDE.md) — the invariants. Start here: every script is dry unless you
   pass `--live`, but three are *gated* rather than migrated and behave differently.
2. [`NEW-CAMPAIGN.md`](NEW-CAMPAIGN.md) — the procedure for a campaign that has not happened yet.
3. [`LESSONS.md`](LESSONS.md) — what has already gone wrong here. Read before writing anything.
4. [`../lifecycle/README.md`](../lifecycle/README.md) — what a manifest holds and which half a
   script may read.
5. The guide for the nearest precedent campaign, then its manifest side by side.

[`NEXT.md`](NEXT.md) lists known-unfinished work; [`PROCESS.md`](PROCESS.md) records how this repo
is worked on and where that process still has gaps.

## Reference

[`reference/ui/`](reference/ui/) — files that belong to the UI repos, kept here because scripts cite
them. `useImpliedProbs.ts` is the probability-of-default model (`implied-prices.js` is a
forward-only ESM port of it); `get-originality-markets-data.ts` is an Apollo/Supabase data function.
**Neither runs in this repo** — their imports do not resolve here.
