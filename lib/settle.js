// Merging and redeeming — turning outcome tokens back into collateral.
//
// The two look alike and behave completely differently, and the Router's own
// signatures say why (abis/RouterAbi.js):
//
//   mergePositions (collateral, market, uint256 amount)      <- ONE amount
//   redeemPositions(collateral, market, indexes[], amounts[]) <- per outcome
//
// So a merge burns an equal amount of EVERY outcome and is therefore capped at
// min(balance) across the full partition INCLUDING Invalid; whatever a market
// traded away is stranded until resolution. A redeem is not capped at all —
// each outcome pays its own weight.
//
// Both take the BASE collateral as argument 0, for child markets too: the Router
// derives the partition from the market's own parentCollectionId
// (src/Router.sol:181-207). Passing a child's own collateralToken would be wrong,
// which is why the flat getMarketInfo is dangerous here.
//
// ORDERING. Child first, both times, for two DIFFERENT reasons:
//   merge   — mergePositions IS min-capped, and on L1 the parent's outcome #66
//             was the binding minimum. Parent-first would have capped the whole
//             unwind at the ~2,749 OTHER tokens lying around instead of 20,476,
//             costing ~17.7k sUSDS.
//   redeem  — not capped, but a child redeems INTO the parent's outcome token,
//             whose standalone balance was zero. Parent-first would have left
//             the child's whole ~759 sUSDS behind a zero balance.

import { ethers } from "ethers";
import { chunk } from "./batch.js";

export const CONDITIONAL_TOKENS_ABI = [
  "function payoutDenominator(bytes32) view returns (uint256)",
  "function payoutNumerators(bytes32,uint256) view returns (uint256)",
];

export const MARKET_ABI = [
  "function conditionId() view returns (bytes32)",
  "function parentCollectionId() view returns (bytes32)",
];

const ERC20_BALANCE_ABI = ["function balanceOf(address) view returns (uint256)"];

/** Smallest of a list of BigInts. */
export const bmin = (values) => values.reduce((a, b) => (b < a ? b : a));

/** Read this wallet's balance of every token in a set. */
export async function readBalances(tokens, { provider, owner }) {
  return Promise.all(tokens.map((t) => new ethers.Contract(t, ERC20_BALANCE_ABI, provider).balanceOf(owner)));
}

/**
 * Plan a merge for one market.
 *
 * `balances` must cover the FULL partition including Invalid. Invalid was never
 * pooled, but every split minted it, so it is already in the wallet — and
 * omitting it would overstate what can be merged.
 */
export function planMerge(balances) {
  if (!balances.length) throw new Error("planMerge: empty balance set");
  const amount = bmin(balances);
  const minIndex = balances.findIndex((b) => b === amount);
  const stranded = balances.reduce((a, b) => a + (b - amount), 0n);
  return {
    amount,
    minIndex, // which outcome is the binding minimum — the diagnostic that matters
    stranded,
    blocked: amount === 0n, // one slot at zero blocks the whole merge
  };
}

/** Read a market's payout vector off ConditionalTokens. */
export async function readPayouts(marketAddress, outcomeCount, { provider, conditionalTokens }) {
  const market = new ethers.Contract(marketAddress, MARKET_ABI, provider);
  const [conditionId, parentCollectionId] = await Promise.all([market.conditionId(), market.parentCollectionId()]);
  const denominator = await conditionalTokens.payoutDenominator(conditionId);
  if (denominator === 0n) {
    throw new Error(`payoutDenominator for ${marketAddress} is 0 — the market is not resolved on ConditionalTokens.`);
  }
  // There is no array getter; read index by index.
  const numerators = [];
  for (let i = 0; i < outcomeCount; i++) numerators.push(await conditionalTokens.payoutNumerators(conditionId, i));
  return { conditionId, parentCollectionId, denominator, numerators, isRoot: parentCollectionId === ethers.ZeroHash };
}

/**
 * Plan a redemption: which outcomes to redeem, and what each returns.
 *
 * Outcomes with payoutNumerators == 0 are SKIPPED — redeeming them burns the
 * tokens for exactly zero collateral. They stay in the wallet. The two "Invalid
 * result" slots are found this way rather than trusted by name.
 */
export function planRedemption({ tokens, balances, numerators, denominator, outcomes = [] }) {
  const rows = [];
  let total = 0n;
  let zeroPayoutHeld = 0n;
  let dustHeld = 0n;
  const table = [];

  balances.forEach((balance, i) => {
    const numerator = numerators[i];
    const payout = denominator > 0n ? (balance * numerator) / denominator : 0n; // integer floor
    let action;
    if (numerator === 0n) {
      action = balance > 0n ? "skip (payout 0)" : "skip (empty)";
      zeroPayoutHeld += balance;
    } else if (balance === 0n) {
      action = "skip (empty)";
    } else {
      action = "redeem";
      rows.push({ index: i, token: tokens[i], amount: balance, payout });
      total += payout;
      if (payout === 0n) dustHeld += balance; // rounds to zero but still worth sending
    }
    table.push({ index: i, name: outcomes[i] ?? `outcome${i}`, balance, payout, action });
  });

  return { rows, total, zeroPayoutHeld, dustHeld, table };
}

/**
 * Split a redemption into transactions.
 *
 * Each call does a transferFrom and an unwrap per outcome before the
 * ConditionalTokens redeem, so a 67-outcome market is chunked. 15 is caution,
 * not a limit — 67 outcomes in one call is ~2.4M gas against an OP block limit
 * of 40M.
 */
export function chunkRedemption(rows, size = 15) {
  return chunk(rows, size).map((c) => ({ rows: c, expected: c.reduce((s, r) => s + r.payout, 0n) }));
}

/**
 * Discover ConditionalTokens from the Router rather than hardcoding it — and
 * refuse a Router that returns zero, which means the wrong Router.
 */
export async function getConditionalTokens(router, provider) {
  const address = await router.conditionalTokens();
  if (!address || address === ethers.ZeroAddress) throw new Error("Router.conditionalTokens() is zero — wrong Router?");
  return new ethers.Contract(address, CONDITIONAL_TOKENS_ABI, provider);
}

/**
 * Whether a resumed redemption still has work.
 *
 * Deliberately recomputed from LIVE balances, not from the progress file: a
 * redeemed outcome ends at zero and drops out of the plan by itself. The merge
 * scripts gate on the progress file instead; this is the safer of the two
 * models, because it cannot skip work that did not actually happen.
 */
export function redemptionIsComplete(plan) {
  return plan.rows.length === 0;
}

/**
 * Why a settle run must not send yet: one line per problem, [] when every
 * question is final AND carries the answer that was approved.
 *
 * This is what makes resolve/redeem schedulable (lib/schedule.js requires a
 * scheduled settle script to import it). Answering is a judgment; resolving is
 * not, provided the answers it would lock in are the ones approved. So the
 * judgment is pinned in a results file at approval time, and the fire-time run
 * checks the chain against it — a re-answered, disputed or not-yet-final
 * question stops the whole run before its first transaction.
 *
 * @param markets [{ label, questions: [Reality question struct], expected: [bytes32 hex] }]
 * @param now     unix seconds
 */
export function finalAnswerProblems(markets, now) {
  const problems = [];
  for (const m of markets) {
    if (m.questions.length !== m.expected.length) {
      problems.push(`${m.label}: ${m.questions.length} question(s), ${m.expected.length} expected answer(s)`);
      continue;
    }
    m.questions.forEach((q, i) => {
      const at = m.questions.length > 1 ? `${m.label} q${i}` : m.label;
      const finalizeTs = Number(q.finalize_ts);
      if (q.is_pending_arbitration) problems.push(`${at}: pending arbitration`);
      else if (finalizeTs === 0) problems.push(`${at}: unanswered`);
      else if (!(now > finalizeTs)) problems.push(`${at}: not final until ${new Date(finalizeTs * 1000).toISOString()}`);
      if (finalizeTs !== 0 && BigInt(q.best_answer) !== BigInt(m.expected[i])) {
        problems.push(`${at}: best_answer ${q.best_answer}, approved ${m.expected[i]}`);
      }
    });
  }
  return problems;
}
