// Transaction retry and allowance handling.
//
// retryTransaction has 32 copies in this repo and NINE distinct implementations.
// ensureAllowance has 17 copies and TEN. Both canonical versions are lifted from
// add-originality-r3-liquidity.js (:138 and :161), the newest lineage.

import { ethers } from "ethers";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

/**
 * Send a transaction, retrying transient failures.
 *
 * Transient `nonce too low` and RPC lag are routine here — 3 occurrences in the
 * L1 round-2 top-up, 10 in the unwind, all recovered on attempt 2.
 *
 * The error line uses ethers v6 `shortMessage`. Thirty-one of the thirty-two
 * copies log `err.message`, which for an estimateGas revert is a multi-kilobyte
 * transaction dump — that is why the older run logs are unreadable.
 */
export async function retryTransaction(txFn, { retries = 3, delayMs = 3000, logGas = false, log = console } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      log.log(`    Attempt ${attempt}/${retries}...`);
      const tx = await txFn();
      log.log(`    Tx sent: ${tx.hash}`);
      const receipt = await tx.wait();
      log.log(`    Confirmed in block ${receipt.blockNumber}${logGas ? `, gas used ${receipt.gasUsed}` : ""}`);
      return receipt;
    } catch (err) {
      lastError = err;
      log.warn(`    Attempt ${attempt} failed: ${(err.shortMessage || err.message || "").slice(0, 200)}`);
      if (attempt < retries) await sleep(delayMs);
    }
  }
  throw lastError;
}

/**
 * Approve `spender` for at least `amount` of `token`, and do not return until
 * the chain agrees.
 *
 * Sixteen of the seventeen copies approve and then blindly sleep 2000ms. That is
 * a coin flip on a lagging RPC, and it has cost real runs twice:
 *
 *   - originality r3 seeding: "Two mint attempts reverted at estimateGas right
 *     after their approve (RPC lag)."  (lifecycle/originality-r3.json)
 *   - the first live L1 redeem: approved 15 tokens, then estimateGas reverted
 *     with "transfer amount exceeds allowance" off a lagging backend.
 *
 * A confirmed approve receipt is not globally visible state. So poll the
 * allowance back, and throw rather than proceed if it never lands.
 *
 * Note this matters most for a token several positions draw on — a per-item
 * ensureAllowance on a SHARED token reads an allowance the previous item is
 * about to spend. Approve once per spender for the total need.
 */
export async function ensureAllowance(
  token,
  spender,
  amount,
  { wallet, log = console, tries = 10, pollMs = 1500, dry = false } = {}
) {
  const erc20 = new ethers.Contract(token, ERC20_ABI, wallet);
  const owner = await wallet.getAddress();

  const current = await erc20.allowance(owner, spender);
  if (current >= amount) {
    log.log(`    allowance already sufficient (${current})`);
    return current;
  }

  if (dry) {
    log.log(`    [dry] would approve ${amount} of ${token} for ${spender}`);
    return amount;
  }

  await retryTransaction(() => erc20.approve(spender, amount), { log });

  for (let i = 0; i < tries; i++) {
    const got = await erc20.allowance(owner, spender);
    if (got >= amount) return got;
    await sleep(pollMs);
  }
  throw new Error(
    `allowance for ${token} -> ${spender} never reached ${amount} after ${tries} polls. ` +
      "The approve was confirmed, so this is RPC lag; re-run to resume."
  );
}

export { ERC20_ABI };
