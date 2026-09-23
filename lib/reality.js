// Reality.eth question encoding and id derivation.
//
// This is the one place where a silent divergence is unrecoverable. From
// src/MarketFactory.sol:368-390:
//
//     bytes32 question_id = keccak256(abi.encodePacked(content_hash, arbitrator,
//         questionTimeout, minBond, address(realitio), address(this), uint256(0)));
//
//     if (realitio.getTimeout(question_id) != 0) {
//         return question_id;          // <- REUSES the existing question
//     }
//
// So two markets whose encoded questions hash the same are bound to ONE Reality
// question: answer it once and both resolve, and there is no way to unpick that
// afterwards. All four creators now precompute every id and refuse to send on a
// collision — create-pd-market-gnosis.js was the one that never did.

import { ethers } from "ethers";

/** Reality's field separator, U+241F SYMBOL FOR UNIT SEPARATOR. */
export const SEP = "␟";

/**
 * Reality template ids, straight from src/MarketFactory.sol:63-67.
 *
 * MULTI_CATEGORICAL is 3, NOT 2. createMultiCategoricalMarket uses
 * REALITY_MULTI_SELECT_TEMPLATE (MarketFactory.sol:175) while
 * createCategoricalMarket uses REALITY_SINGLE_SELECT_TEMPLATE (:153). Both embed
 * the outcome list in the question, so they share an ENCODER but not a template
 * id — and the id goes into the content hash, so confusing them yields a
 * questionId that matches nothing.
 */
export const TEMPLATE = {
  /** Uint / scalar / multi-scalar: the question carries NO outcome list. */
  UINT: 1,
  /** Single-select categorical. */
  CATEGORICAL: 2,
  /** Multi-select (multi-categorical). */
  MULTI_CATEGORICAL: 3,
};

// Reality interpolates the question into a JSON template, so a raw quote,
// backslash or separator breaks parsing on the other side.
export const FORBIDDEN_CHARS = ['"', "\\", SEP];

/** MarketFactory.toString31 REVERTS above 31 bytes — it does not truncate. */
export const MAX_TOKEN_NAME_BYTES = 31;

/** Mirrors MarketFactory.encodeRealityQuestionWithOutcomes (src/MarketFactory.sol:329). */
export function encodeQuestionWithOutcomes(question, outcomes, category, lang) {
  if (!Array.isArray(outcomes) || outcomes.length === 0) throw new Error("outcomes must be a non-empty array");
  const encodedOutcomes = outcomes.map((o) => `"${o}"`).join(",");
  return `${question}${SEP}${encodedOutcomes}${SEP}${category}${SEP}${lang}`;
}

/** Mirrors MarketFactory.encodeRealityQuestionWithoutOutcomes (src/MarketFactory.sol:352). */
export function encodeQuestionWithoutOutcomes(question, category, lang) {
  return `${question}${SEP}${category}${SEP}${lang}`;
}

/** Pick the encoder by template id, so a campaign declares intent rather than remembering. */
export function encodeQuestion({ templateId, question, outcomes, category, lang }) {
  if (templateId === TEMPLATE.CATEGORICAL || templateId === TEMPLATE.MULTI_CATEGORICAL) {
    return encodeQuestionWithOutcomes(question, outcomes, category, lang);
  }
  if (templateId === TEMPLATE.UINT) return encodeQuestionWithoutOutcomes(question, category, lang);
  throw new Error(`unknown Reality templateId ${templateId}`);
}

/**
 * Mirrors MarketFactory.askRealityQuestion (src/MarketFactory.sol:374-380).
 *
 * `factory` is an explicit parameter here. Two of the three existing copies take
 * it; create-originality-r3-markets.js:127 closes over a module constant, which
 * is exactly how a helper stops being portable.
 */
export function computeQuestionId({
  templateId,
  openingTime,
  encodedQuestion,
  arbitrator,
  questionTimeout,
  minBond,
  realitio,
  factory,
}) {
  for (const [k, v] of Object.entries({ templateId, openingTime, encodedQuestion, arbitrator, questionTimeout, minBond, realitio, factory })) {
    if (v === undefined || v === null) throw new Error(`computeQuestionId: missing ${k}`);
  }
  const contentHash = ethers.solidityPackedKeccak256(
    ["uint256", "uint32", "string"],
    [templateId, openingTime, encodedQuestion]
  );
  return ethers.solidityPackedKeccak256(
    ["bytes32", "address", "uint32", "uint256", "address", "address", "uint256"],
    [contentHash, arbitrator, questionTimeout, minBond, realitio, factory, 0]
  );
}

/**
 * The market's CTF questionId — NOT a Reality question id.
 *
 * Mirrors src/MarketFactory.sol:296-298. Two different hashes are easy to
 * confuse, and the creation logs record both:
 *
 *   questionsIds[i]  the Reality ids, one per question (a multi-scalar asks one
 *                    per outcome; everything else asks one)
 *   questionId       keccak256(abi.encode(questionsIds, outcomes.length,
 *                    templateId, lowerBound, upperBound))
 *
 * The contract's own comment explains why the second exists: "questionId must be
 * a hash of all the values that RealityProxy.resolve() uses to resolve a market,
 * this way if an attacker tries to resolve a fake market by changing some value
 * its questionId will not match the id of a valid market."
 *
 * `outcomeCount` is the number of USER outcomes — params.outcomes.length, before
 * the factory appends its Invalid slot.
 */
export function computeMarketQuestionId({ questionsIds, outcomeCount, templateId, lowerBound = 0, upperBound = 0 }) {
  const packed = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32[]", "uint256", "uint256", "uint256", "uint256"],
    [questionsIds, outcomeCount, templateId, lowerBound, upperBound]
  );
  return ethers.keccak256(packed);
}

/**
 * Refuse to proceed if any two planned questions share an id, or if one collides
 * with a question already asked on chain.
 *
 * `plans` is [{label, questionId}]. Pass `realitio` (an ethers Contract with
 * getTimeout) to also check the chain — an id that already exists there will be
 * REUSED by the factory rather than asked afresh.
 */
export async function assertNoQuestionCollision(plans, { realitio = null, log = console } = {}) {
  const byId = new Map();
  for (const p of plans) {
    if (!byId.has(p.questionId)) byId.set(p.questionId, []);
    byId.get(p.questionId).push(p.label);
  }

  const dupes = [...byId].filter(([, labels]) => labels.length > 1);
  if (dupes.length) {
    const lines = dupes.map(([id, labels]) => `  ${id}\n      ${labels.join("\n      ")}`).join("\n");
    throw new Error(
      `Reality question id collision between planned markets — they would share ONE question:\n${lines}`
    );
  }

  if (!realitio) {
    log.log(`  question ids: ${plans.length} planned, all distinct (chain not checked)`);
    return { distinct: plans.length, existing: [] };
  }

  const existing = [];
  for (const p of plans) {
    const timeout = await realitio.getTimeout(p.questionId);
    if (Number(timeout) !== 0) existing.push(p);
  }
  if (existing.length) {
    throw new Error(
      `${existing.length} planned question(s) ALREADY EXIST on Reality and would be reused, ` +
        `silently binding a new market to an old question:\n` +
        existing.map((p) => `  ${p.label}  ${p.questionId}`).join("\n")
    );
  }
  log.log(`  question ids: ${plans.length} planned, all distinct and none on chain`);
  return { distinct: plans.length, existing: [] };
}

/** Reject text Reality cannot carry, before anything is sent. */
export function checkQuestionText(label, s, errors = []) {
  if (typeof s !== "string" || s.length === 0) {
    errors.push(`${label}: empty`);
    return errors;
  }
  for (const c of FORBIDDEN_CHARS) {
    if (s.includes(c)) errors.push(`${label}: contains forbidden character ${JSON.stringify(c)}`);
  }
  return errors;
}

/** ERC20 names go through MarketFactory.toString31, which REVERTS past 31 bytes. */
export function checkTokenName(name, errors = []) {
  const bytes = Buffer.byteLength(name, "utf8");
  if (bytes > MAX_TOKEN_NAME_BYTES) {
    errors.push(`token name ${JSON.stringify(name)} is ${bytes} bytes; toString31 reverts above ${MAX_TOKEN_NAME_BYTES}`);
  }
  return errors;
}

/** Reality's "answered too soon" sentinel. */
export const ANSWERED_TOO_SOON = "0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe";

/**
 * Scale a real-world value onto a scalar market's answer range.
 *
 * THE trap in this repo: L1's juror-weight questions are a fraction of 1 against
 * upperBound 1e18, while the Octant market was a [percent] question against
 * upperBound 100e18. Copying the Octant scale to L1 would have been 100x wrong.
 * So the bound is a required argument — always read it off the market, never
 * assume it.
 *
 * Note RealityProxy.resolveMultiScalarMarket writes the raw answers as the payout
 * vector and ConditionalTokens divides by their sum, so only RATIOS matter: L1's
 * answers summed to 999999999800000000 and the 2e-10 shortfall was irrelevant.
 */
export function scaleAnswer(value, { lowerBound = 0n, upperBound, decimals = 18 }) {
  if (upperBound === undefined) throw new Error("scaleAnswer: upperBound is required — read it off the market");
  const lo = BigInt(lowerBound);
  const hi = BigInt(upperBound);
  if (hi <= lo) throw new Error(`scaleAnswer: upperBound ${hi} must exceed lowerBound ${lo}`);
  const scaled = ethers.parseUnits(String(value), decimals);
  if (scaled < lo || scaled > hi) {
    throw new Error(`scaleAnswer: ${value} -> ${scaled} is outside the market's [${lo}, ${hi}]`);
  }
  return scaled;
}
