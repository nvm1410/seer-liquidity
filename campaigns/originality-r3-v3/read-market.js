// Reads a market straight off its own contract, without MarketView.
//
// WHY: MarketView.getMarket REVERTS for this set's three middle markets. Its
// getParentMarketInfo sizes the PARENT's outcome list by the CHILD's condition
// (src/MarketView.sol:216 passes market.conditionId() with parentMarket), so it walks
// parentMarket.outcomes(i) for as many slots as the child has. A middle market has 33 or
// 34 slots and its parent has 3 outcomes, so outcomes(3) is out of bounds. Found on a
// fork rehearsal 2026-10-01; the same line is still in seer-pm/demo.
//
// The bug only bites a conditional market with MORE slots than its parent has outcomes.
// The parent (unconditional) and the score markets (3 slots under a 33-outcome middle
// market) read through MarketView as usual. Nothing on the write path — create, split,
// merge, resolve, redeem — touches MarketView.
//
// Returns the same field names the scripts use from MarketView.getMarket, with the
// factory's "Invalid result" slot appended to `outcomes` as MarketView does.

import { ethers } from "ethers";
import { INVALID_LABEL } from "../../lib/market.js";

const MARKET_ABI = [
  "function marketName() view returns (string)",
  "function outcomes(uint256) view returns (string)",
  "function numOutcomes() view returns (uint256)",
  "function parentMarket() view returns (address)",
  "function parentOutcome() view returns (uint256)",
  "function parentCollectionId() view returns (bytes32)",
  "function conditionId() view returns (bytes32)",
  "function templateId() view returns (uint256)",
  "function questionsIds() view returns (bytes32[])",
  "function encodedQuestions(uint256) view returns (string)",
  "function wrappedOutcome(uint256) view returns (address wrapped1155, bytes data)",
];

export async function readMarketDirect(address, provider) {
  const m = new ethers.Contract(address, MARKET_ABI, provider);
  const [marketName, numOutcomes, parentMarket, parentOutcome, parentCollectionId, conditionId, templateId, questionsIds] =
    await Promise.all([
      m.marketName(),
      m.numOutcomes(),
      m.parentMarket(),
      m.parentOutcome(),
      m.parentCollectionId(),
      m.conditionId(),
      m.templateId(),
      m.questionsIds(),
    ]);
  // numOutcomes excludes the Invalid slot; wrappedOutcome covers it.
  const n = Number(numOutcomes);
  const outcomes = [];
  const wrappedTokens = [];
  for (let i = 0; i <= n; i++) {
    outcomes.push(i === n ? INVALID_LABEL : await m.outcomes(i));
    wrappedTokens.push((await m.wrappedOutcome(i)).wrapped1155);
  }
  const ids = Array.from(questionsIds).map(String);
  const encodedQuestions = [];
  for (let i = 0; i < ids.length; i++) encodedQuestions.push(await m.encodedQuestions(i));
  return {
    id: address,
    marketName,
    outcomes,
    wrappedTokens,
    parentMarket: { id: parentMarket },
    parentOutcome,
    parentCollectionId,
    conditionId,
    templateId,
    questionsIds: ids,
    encodedQuestions,
  };
}
