// Reading and validating Seer markets through MarketView.
//
// getMarketInfo has nine copies in two generations. The FLAT generation returns
// `result.collateralToken` raw — which for a CONDITIONAL market is the parent's
// outcome token, not the base collateral. Every nested campaign in this repo
// (originality r2/r3, L1's A->B pair) is conditional, so that is a real wrong
// answer, not a stylistic difference.
//
// The conditional-aware generation fixes it by walking to the parent. The modern
// copies of it (add-20k-originality-liquidity.js:111, remove-merge-originality.js:101)
// dropped fields their own ancestors carried — conditionId, lowerBound,
// upperBound, parentCollectionId, parentOutcomeIndex — so the canonical version
// here is the ancestor's field list with the modern injected-marketView shape.
//
// assertMarket is the separate, valuable half: the checks that run BEFORE money
// moves. They exist in only two scripts and neither has all of them.

import { ethers } from "ethers";
import { MarketViewAbi } from "../abis/MarketViewAbi.js";

export const INVALID_LABEL = "Invalid result";

/**
 * Canonical outcome-name normalizer.
 *
 * `String(s)` is load-bearing: MarketView returns ethers Result proxies, and the
 * copies without the wrapper (the Gnosis lineage) throw on anything that is not
 * already a primitive string.
 *
 * The octant variant additionally strips a trailing period — and does it BEFORE
 * trim, so a name ending in ". " keeps its period. Not reproduced.
 */
export function normalizeName(s) {
  return String(s).toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * A much more aggressive normalizer, for matching REPO names between a CSV and
 * on-chain outcome labels. Deliberately separate from normalizeName: it destroys
 * information that outcome-label matching needs.
 */
export function normalizeIdentifier(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function makeMarketView(address, provider) {
  return new ethers.Contract(address, MarketViewAbi, provider);
}

/**
 * Read a market, resolving conditional markets to their BASE collateral.
 *
 * `collateralToken` is the value the Router wants: splitPosition,
 * mergePositions and redeemPositions all take the base collateral as argument 0
 * for child markets too, because the Router derives the partition from the
 * market's own parentCollectionId (src/Router.sol:181-207).
 */
export async function getMarketInfo(marketView, factory, marketAddress) {
  const result = await marketView.getMarket(factory, marketAddress);

  // ethers.ZeroHash, not the 64-char string literal the older copies compare to.
  const isConditional = result.parentCollectionId !== ethers.ZeroHash;
  const parentMarketAddress = isConditional && result.parentMarket ? result.parentMarket.id : undefined;
  const parentOutcomeIndex = isConditional ? Number(result.parentOutcome) : undefined;

  let collateralToken = result.collateralToken;
  let parentOutcomeToken;
  let parentInfo;
  if (isConditional && parentMarketAddress) {
    parentInfo = await marketView.getMarket(factory, parentMarketAddress);
    collateralToken = parentInfo.collateralToken; // the BASE collateral
    parentOutcomeToken = parentInfo.wrappedTokens?.[parentOutcomeIndex];
  }

  return {
    id: result.id,
    name: result.marketName,
    conditionId: result.conditionId,
    collateralToken,
    rawCollateralToken: result.collateralToken, // what the flat generation returned
    outcomes: Array.from(result.outcomes ?? []).map(String),
    wrappedTokens: Array.from(result.wrappedTokens ?? []).map(String),
    questionsIds: Array.from(result.questionsIds ?? []).map(String),
    templateId: Number(result.templateId),
    lowerBound: result.lowerBound,
    upperBound: result.upperBound,
    payoutReported: result.payoutReported,
    parentCollectionId: result.parentCollectionId,
    isConditional,
    parentMarketAddress,
    parentOutcomeIndex,
    parentOutcomeToken,
  };
}

/**
 * Assert a market on chain is the market the campaign file says it is, before
 * any money moves.
 *
 * The union of the two validating resolvers, neither of which has everything:
 *
 *   add-zcash-nu7-liquidity.js:205  collateral, top-level, templateId,
 *                                   normalized labels, question count,
 *                                   wrappedTokens length, log cross-check, and
 *                                   a getCode bytecode check
 *   add-originality-r3-liquidity.js:274  parent<->child linkage — but it has NO
 *                                   bytecode check, NO log cross-check, does not
 *                                   check templateId, and compares labels with
 *                                   raw !== rather than normalizing
 *
 * Every check is opt-in by passing the expectation, so a campaign asserts what
 * it actually knows.
 */
export async function assertMarket(
  info,
  {
    collateral,
    topLevel,
    templateId,
    outcomes,
    outcomeCount,
    questionCount,
    parentMarket,
    parentOutcome,
    loggedWrappedTokens,
    requireCode,
    provider,
    label = info.id ?? "market",
  } = {}
) {
  const fail = (msg) => {
    throw new Error(`${label}: ${msg}`);
  };

  if (collateral && info.collateralToken.toLowerCase() !== collateral.toLowerCase()) {
    fail(`collateral ${info.collateralToken} != expected ${collateral}`);
  }
  if (topLevel === true && info.isConditional) fail("market is conditional — expected top-level");
  if (topLevel === false && !info.isConditional) fail("market is top-level — expected conditional");

  // Number(), not a BigInt literal: answer-l1-markets.js compares `!== 1n` while
  // add-zcash-nu7-liquidity.js compares `Number(...) !== 2`. One convention.
  if (templateId !== undefined && info.templateId !== Number(templateId)) {
    fail(`expected templateId ${templateId}, got ${info.templateId}`);
  }

  if (outcomes) {
    // The factory appends its Invalid slot; expectations name the user outcomes.
    const expected = [...outcomes, INVALID_LABEL];
    if (info.outcomes.length !== expected.length) {
      fail(`expected ${expected.length} outcomes (${outcomes.length} + Invalid), got ${info.outcomes.length}`);
    }
    expected.forEach((want, i) => {
      if (normalizeName(info.outcomes[i]) !== normalizeName(want)) {
        fail(`outcome ${i}: on-chain "${info.outcomes[i]}" != expected "${want}"`);
      }
    });
  } else if (outcomeCount !== undefined && info.outcomes.length !== outcomeCount) {
    fail(`expected ${outcomeCount} outcomes, got ${info.outcomes.length}`);
  }

  if (questionCount !== undefined && info.questionsIds.length !== questionCount) {
    fail(`expected ${questionCount} Reality question(s), got ${info.questionsIds.length}`);
  }
  if (outcomes && info.wrappedTokens.length !== outcomes.length + 1) {
    fail(`expected ${outcomes.length + 1} wrapped tokens, got ${info.wrappedTokens.length}`);
  }

  if (parentMarket && info.parentMarketAddress?.toLowerCase() !== parentMarket.toLowerCase()) {
    fail(`parentMarket ${info.parentMarketAddress} != expected ${parentMarket}`);
  }
  if (parentOutcome !== undefined && info.parentOutcomeIndex !== Number(parentOutcome)) {
    fail(`parentOutcome ${info.parentOutcomeIndex} != expected ${parentOutcome}`);
  }

  // An execution log is a RECORD, not a source of truth. Cross-check it.
  if (loggedWrappedTokens) {
    info.wrappedTokens.forEach((token, i) => {
      const logged = loggedWrappedTokens[i];
      if (logged && logged.toLowerCase() !== token.toLowerCase()) {
        fail(`wrappedTokens[${i}] on-chain ${token} != logged ${logged}`);
      }
    });
  }

  // Every token about to be pooled must actually be a deployed ERC20. Invalid is
  // never pooled, so requireCode is a count of the leading tokens to check.
  if (requireCode) {
    if (!provider) fail("requireCode needs a provider");
    for (const token of info.wrappedTokens.slice(0, requireCode)) {
      const code = await provider.getCode(token);
      if (!code || code === "0x") fail(`outcome token ${token} has no code`);
    }
  }

  return info;
}

/** Split a market's wrapped tokens into the pooled outcomes and the Invalid slot. */
export function resolveOutcomeTokens(info, { expectedCount } = {}) {
  const tokens = info.wrappedTokens;
  if (tokens.length < 2) throw new Error(`${info.id}: only ${tokens.length} wrapped tokens`);
  const n = expectedCount ?? tokens.length - 1;
  if (normalizeName(info.outcomes[tokens.length - 1]) !== normalizeName(INVALID_LABEL)) {
    throw new Error(`${info.id}: last outcome is "${info.outcomes[tokens.length - 1]}", expected "${INVALID_LABEL}"`);
  }
  return { outcomeTokens: tokens.slice(0, n), invalidToken: tokens[tokens.length - 1], all: tokens };
}
