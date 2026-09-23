// Read-only checker for the L1 unwind (withdraw-l1-liquidity.js + merge-l1-positions.js).
// Confirms every L1 position is drained, every logged tx actually succeeded on-chain,
// and reports what is left: residual outcome-token dust per market and the sUSDS balance.
//
// Sends nothing: declared `mutating: false`, so the harness never builds a signer.
//
//   node verify-l1-unwind.js

import { ethers } from "ethers";
import fs from "fs";
import { erc20Abi, formatUnits } from "viem";
import { runBatched } from "./lib/batch.js";
import { getMarketInfo, makeMarketView } from "./lib/market.js";
import { enumerateWalletPositions, POSITION_MANAGER_ABI } from "./lib/positions.js";
import { run } from "./lib/run.js";
import { pairKey } from "./lib/ticks.js";

await run(
  { name: "verify-l1-unwind", slug: "l1-deepfunding", stage: "verify-unwind", mutating: false },
  async (ctx) => {
    const { manifest, provider, addr, log } = ctx;
    const collateral = manifest.chain.collateral.address;
    // No signer in a read-only run, so the wallet under inspection comes from the
    // key if one is set, else the address the campaign actually used.
    const owner = process.env.PRIVATE_KEY
      ? new ethers.Wallet(process.env.PRIVATE_KEY).address
      : "0x00DC3E0AcAdB8dBA21BB08fF30540222FF8836e0";
    const [MARKET_A, MARKET_B] = manifest.results.marketAddresses;

    log.log(`\n📋 Wallet : ${owner}`);

    const marketView = makeMarketView(addr.marketView, provider);
    const mA = await getMarketInfo(marketView, addr.marketFactory, MARKET_A);
    const mB = await getMarketInfo(marketView, addr.marketFactory, MARKET_B);
    const setA = mA.wrappedTokens;
    const setB = mB.wrappedTokens;

    const byPair = new Map();
    setA.forEach((t, i) => byPair.set(pairKey(t, collateral), { market: "A", index: i }));
    setB.forEach((t, i) => byPair.set(pairKey(t, collateral), { market: "B", index: i }));

    // ── 1. Every L1 position drained? ─────────────────────────────────────────
    const pm = new ethers.Contract(addr.positionManager, POSITION_MANAGER_ABI, provider);
    const bal = Number(await pm.balanceOf(owner));
    const data = await enumerateWalletPositions(pm, owner, { batchSize: 20, pauseMs: 500 });
    const matched = data
      .map((x) => ({ ...x, meta: byPair.get(pairKey(x.pos.token0, x.pos.token1)) }))
      .filter((x) => x.meta);

    const stillFunded = matched.filter((x) => x.pos.liquidity > 0n);
    const owedFees = matched.filter((x) => x.pos.tokensOwed0 > 0n || x.pos.tokensOwed1 > 0n);
    log.log(`\n📉 L1 positions : ${matched.length} matched of ${bal} NFTs held`);
    log.log(`   drained (liquidity = 0)  : ${matched.length - stillFunded.length}`);
    log.log(`   still funded             : ${stillFunded.length}`);
    log.log(`   with uncollected fees    : ${owedFees.length}`);
    for (const x of stillFunded) {
      log.log(`     ⚠️  #${x.tokenId} [${x.meta.market}${x.meta.index}] liquidity ${formatUnits(x.pos.liquidity, 18)}`);
    }

    // ── 2. Logged transactions actually succeeded? ────────────────────────────
    // A progress log records what was SENT. Only a receipt says it landed.
    //
    // A null receipt is reported as "pending", but for a transaction months old
    // that is almost always the RPC throttling rather than a real pending state —
    // and a verifier that cries pending is a verifier nobody believes. Retry
    // before concluding anything.
    const receiptOf = async (hash, tries = 3) => {
      for (let i = 0; i < tries; i++) {
        const rc = await provider.getTransactionReceipt(hash);
        if (rc) return rc;
        if (i < tries - 1) await new Promise((r) => setTimeout(r, 750));
      }
      return null;
    };

    for (const [label, file] of [
      ["withdraw", manifest.files.withdraw],
      ["merge", manifest.files.merge],
    ]) {
      if (!file || !fs.existsSync(file)) {
        log.log(`\n📄 ${label}: ${file} not found (not run yet?)`);
        continue;
      }
      const entries = JSON.parse(fs.readFileSync(file, "utf8"));
      const hashes = entries.map((e) => e.txHash).filter(Boolean);
      const receipts = await runBatched(hashes, (h) => receiptOf(h), { batchSize: 20, pauseMs: 500 });
      const reverted = receipts.filter((r) => r && r.status !== 1).length;
      const pending = receipts.filter((r) => !r).length;
      log.log(
        `\n📄 ${label}: ${entries.length} entries | ok ${hashes.length - reverted - pending} | ` +
          `reverted ${reverted} | pending ${pending}`
      );
    }

    // ── 3. Residual balances ──────────────────────────────────────────────────
    const readBal = (tokens) =>
      runBatched(tokens, (t) => new ethers.Contract(t, erc20Abi, provider).balanceOf(owner), {
        batchSize: 20,
        pauseMs: 500,
      });
    const balA = await readBal(setA);
    const balB = await readBal(setB);
    const sum = (arr) => arr.reduce((a, x) => a + x, 0n);
    const nonZero = (arr) => arr.filter((x) => x > 0n).length;

    log.log(`\n🧾 Residual outcome tokens (stranded until the markets resolve):`);
    log.log(`   Market A : ${formatUnits(sum(balA), 18)} across ${nonZero(balA)}/${balA.length} outcomes`);
    log.log(`   Market B : ${formatUnits(sum(balB), 18)} across ${nonZero(balB)}/${balB.length} outcomes`);

    const susds = new ethers.Contract(collateral, erc20Abi, provider);
    log.log(`\n💰 sUSDS balance : ${formatUnits(await susds.balanceOf(owner), 18)}`);

    if (stillFunded.length === 0) {
      log.log(`\n🎉 All ${matched.length} L1 positions are fully drained.`);
    } else {
      log.log(`\n⚠️  ${stillFunded.length} position(s) still hold liquidity — re-run withdraw-l1-liquidity.js.`);
    }
    return { matched: matched.length, stillFunded: stillFunded.length, owedFees: owedFees.length };
  }
);
