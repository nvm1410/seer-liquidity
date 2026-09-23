# Seer contracts — read-only reference

A verbatim copy of the Seer protocol's Solidity sources. **Nothing in this repo compiles,
deploys or imports them.** They are here so that a claim about on-chain behaviour can be checked
against the code that actually runs, instead of against memory.

When a comment in this repo cites a contract it cites a line range — e.g.
`src/Router.sol:181-207` — so the citation stays checkable. If you change what a script assumes
about the protocol, cite the line you read it from.

## The nine that carry this repo's behaviour

These are the only files anything here reasons about. Read these first.

| Contract | What this repo needs from it | Cited at |
|---|---|---|
| `MarketFactory.sol` | Reality question encoding, the template ids (UINT 1 / SINGLE_SELECT 2 / MULTI_SELECT 3), `askRealityQuestion` **reusing** an existing question, `toString31` **reverting** past 31 bytes, and how a market name is assembled from `questionStart + [outcomeType] + questionEnd` | `:63-67`, `:208`, `:224`, `:296-298`, `:329`, `:352`, `:368-390`, `:374-380` |
| `Router.sol` | That `splitPosition` / `mergePositions` / `redeemPositions` all take the **BASE** collateral as argument 0, even for a child market, because the partition is derived from `parentCollectionId` | `:58-62`, `:181-207` |
| `GnosisRouter.sol` | The Gnosis variant of the above, used by both PD campaigns | — |
| `RealityProxy.sol` | How a Reality answer becomes a payout vector — in particular that `resolveMultiScalarMarket` writes the **raw** answers and ConditionalTokens divides by their sum, so only ratios matter | `:157-190` |
| `Market.sol` | `resolve()` is no-arg and **permissionless**, and reverts unless every question is finalized | — |
| `MarketView.sol` | The exact shape `getMarket` returns, which `lib/market.js` destructures | — |
| `interaction/reality/RealityETH-3.0.sol` | Question id derivation, `finalize_ts`, `is_pending_arbitration`, bond rules | `:181-189` |
| `interaction/conditional-tokens/ConditionalTokens.sol` | `payoutNumerators` / `payoutDenominator`, and that a redemption is per-outcome rather than min-capped | — |
| `interaction/1155-to-20/Wrapped1155Factory.sol` | Why an outcome is an ERC20 wrapper over an ERC1155 position, which is what the Router unwraps on a child split | — |

`Interfaces.sol` and `interaction/conditional-tokens/CTHelpers.sol` are supporting types for
those; keep them beside their callers.

## Everything else

The remaining ~32 files are upstream Seer contracts kept **verbatim and unpruned**: the futarchy
set, `airdrop/`, `trading-credits/`, `trade/`, `token/Seer.sol`, `MainnetRouter.sol`,
`MarketViewSubgraph.sol`, the cross-chain arbitration proxies, the appeal arbitrators, the
sDAI-on-Gnosis wrapper and the base ERC1155 implementation.

Nothing in this repo reads them, and no campaign has ever touched an arbitration proxy, a futarchy
market or a trading credit. They are retained deliberately rather than pruned: this is a mirror of
upstream, and a partial mirror is harder to trust than a complete one — you would not know whether
a missing file was irrelevant or simply lost.

**So: absence of a contract from the table above means "no campaign has needed it yet", not "it
does not matter".** If a future campaign needs one, add it to the table with the line range you
read, rather than assuming the table is exhaustive.
