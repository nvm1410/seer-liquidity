// The run harness for NEW campaign scripts.
//
// What it replaces, and why:
//
//   DRY_RUN         In the frozen scripts this is a constant you edit to go
//                   live — and then must remember to edit back. Sixteen were
//                   left committed at `false`, so `node <script>.js` typed from
//                   a guide sent real transactions with no prompt. Here the
//                   default is dry, always, and `--live` is the only way to
//                   send. There is no state to forget to reset.
//
//   PROGRESS_FILE   Also a constant. Pointing a new round at the previous
//                   round's log makes the script skip everything and report
//                   success. See lib/progress.js.
//
//   the gate        New. --live is refused unless the manifest records a human
//                   approval, and the seed file is re-hashed against what was
//                   approved.
//
//   the cap         New. manifest.spendingCap is enforced as the run proceeds
//                   rather than checked once at the top.
//
// Exit codes: 0 ok, 1 fatal, 2 refused by a guard. Distinct so a wrapper can
// tell "you invoked this wrong" from "it broke".

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import { loadEnv } from "./env.js";
import { createLogger } from "./log.js";
import { appendStage, loadManifest, resolveAddresses, resolveAmm } from "./manifest.js";
import { openProgress, ProgressReuseError } from "./progress.js";

const ROOT = path.resolve(import.meta.dirname, "..");
export const REFUSED = 2;

export function parseArgs(argv = process.argv.slice(2)) {
  const flags = new Set(argv.filter((a) => a.startsWith("--") && !a.includes("=")));
  const opts = Object.fromEntries(
    argv.filter((a) => a.startsWith("--") && a.includes("=")).map((a) => {
      const i = a.indexOf("=");
      return [a.slice(2, i), a.slice(i + 1)];
    })
  );
  return {
    live: flags.has("--live"),
    resume: flags.has("--resume"),
    yes: flags.has("--yes"),
    progress: opts.progress ?? null,
    rest: argv,
    flags,
    opts,
  };
}

/** y/N on stdin. Auto-true under --yes, auto-false in a dry run. */
export async function confirm(question, { yes = false, dry = true } = {}) {
  if (dry) return false;
  if (yes) return true;
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** A running total that refuses to exceed the manifest's cap. */
function makeSpend(cap, log) {
  let collateral = 0;
  return {
    get collateral() {
      return collateral;
    },
    charge(amount) {
      const next = collateral + Number(amount);
      if (cap != null && next > cap) {
        throw new Error(
          `spending cap exceeded: this step would bring the run to ${next.toFixed(6)} ` +
            `against a cap of ${cap}. Nothing further will be sent.`
        );
      }
      collateral = next;
      log.log(`    spent so far: ${collateral.toFixed(6)}${cap != null ? ` / ${cap}` : ""}`);
      return collateral;
    },
  };
}

/**
 * Run a campaign step.
 *
 * @param spec.name      script identity; names the default log file
 * @param spec.slug      campaign -> lifecycle/<slug>.json
 * @param spec.stage     stage name recorded in the manifest
 * @param spec.chain     expected chain id, asserted against the RPC
 * @param spec.mutating  false for a read-only verifier (no --live gate, no wallet)
 * @param spec.needsGate refuse --live unless the manifest records an approval
 * @param spec.progress  optional progress-file path, or (manifest) => path, for
 *                       scripts whose resume log is also their output file
 */
export async function run(spec, mainFn) {
  const args = parseArgs();
  const dry = !args.live || spec.mutating === false;

  const manifest = loadManifest(spec.slug);
  const stageName = spec.stage ?? spec.name;
  // --progress relocates the whole run: the transcript belongs beside the log
  // it describes, not in the default tree.
  const stampedDir = args.progress
    ? path.dirname(path.resolve(args.progress))
    : path.join(ROOT, "runs", spec.slug, stageName);
  const logFile = path.join(stampedDir, `${dry ? "dry" : "run"}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  const log = createLogger({ file: logFile });

  const bail = async (msg) => {
    log.error(`\nREFUSED: ${msg}`);
    await log.close();
    process.exit(REFUSED);
  };

  try {
    log.log(`${spec.name} — ${dry ? "DRY RUN (nothing will be sent)" : "LIVE"}`);
    log.log(`  campaign ${spec.slug} (${manifest.mode}/${manifest.family}), stage ${stageName}`);

    // ── Guards, in the order that fails cheapest first ──────────────────────
    if (!dry && spec.needsGate) {
      const gate = manifest.gate ?? {};
      if (!gate.approvedAt || manifest.status !== "gated") {
        return await bail(
          `lifecycle/${spec.slug}.json is status "${manifest.status}" with no approval. ` +
            `Set status to "gated" and fill gate.approvedAt / approvedBy / summaryHash first.`
        );
      }
      // The hash is re-read here, not just recorded: it proves the seed file is
      // the one that was approved, not a later edit.
      const seed = manifest.files?.seed;
      if (seed && gate.summaryHash) {
        const abs = path.join(ROOT, seed);
        const digest = fs.existsSync(abs) ? sha256(abs) : null;
        if (digest && !gate.summaryHash.includes(digest)) {
          return await bail(
            `${seed} has changed since approval.\n  approved: ${gate.summaryHash}\n  now:      sha256=${digest}`
          );
        }
      }
      log.log(`  gate: approved ${gate.approvedAt} by ${gate.approvedBy}`);
    }

    // A creator's progress file IS its output file: the markets log is the
    // authoritative record of which markets exist, and creation is NOT
    // idempotent, so resuming against a fresh empty log would create DUPLICATE
    // markets. Such a script sets spec.progress to point at it, and the reuse
    // guard then forces --resume — which is exactly the acknowledgement wanted.
    const specProgress = typeof spec.progress === "function" ? spec.progress(manifest) : spec.progress;
    const progressPath = args.progress ?? (specProgress ? path.resolve(ROOT, specProgress) : path.join(stampedDir, "progress.json"));
    let progress;
    try {
      progress = openProgress(progressPath, { allowResume: args.resume });
    } catch (e) {
      if (e instanceof ProgressReuseError) return await bail(e.message);
      throw e;
    }
    if (progress.count) log.log(`  resuming: ${progress.count} item(s) already done will be skipped`);

    // ── Chain ───────────────────────────────────────────────────────────────
    const { provider, wallet, chainId } = await loadEnv({
      chainId: manifest.chain.id,
      requires: spec.requires ?? ["PRIVATE_KEY"],
      needsSigner: spec.mutating !== false,
    });
    log.log(`  chain ${chainId} ok${wallet ? `, wallet ${await wallet.getAddress()}` : " (read-only)"}`);

    const ctx = {
      dry,
      live: !dry,
      args,
      provider,
      wallet,
      chainId,
      manifest,
      addr: resolveAddresses(manifest),
      amm: resolveAmm(manifest),
      progress,
      log,
      spend: makeSpend(manifest.spendingCap?.collateral, log),
      confirm: (q) => confirm(q, { yes: args.yes, dry }),
    };

    // ── Balance and confirmation, live only ─────────────────────────────────
    if (!dry) {
      const erc20 = new ethers.Contract(
        manifest.chain.collateral.address,
        ["function balanceOf(address) view returns (uint256)"],
        provider
      );
      const bal = await erc20.balanceOf(await wallet.getAddress());
      const have = Number(ethers.formatUnits(bal, manifest.chain.collateral.decimals));
      const need = manifest.liquidity?.totalCollateral ?? 0;
      log.log(`  balance ${have} ${manifest.chain.collateral.symbol}, plan needs ${need}`);
      // A hard abort, matching add-zcash-nu7-liquidity.js:445 — not the warning
      // that add-originality-r3-liquidity.js:512 settles for.
      if (need && have < need) return await bail(`insufficient collateral: have ${have}, need ${need}`);

      if (!(await ctx.confirm(`Send live transactions for ${spec.slug}/${stageName}?`))) {
        return await bail("not confirmed");
      }
      await appendStage(spec.slug, { name: stageName, status: "running", startedAt: new Date().toISOString() });
    }

    const result = await mainFn(ctx);

    if (!dry) {
      await appendStage(spec.slug, {
        name: stageName,
        status: "done",
        finishedAt: new Date().toISOString(),
        artifacts: [path.relative(ROOT, progress.path).replace(/\\/g, "/"), path.relative(ROOT, logFile).replace(/\\/g, "/")],
        txCount: progress.count,
      });
    }
    log.log(`\n${dry ? "Dry run complete — nothing was sent." : "Done."}`);
    await log.close();
    return result;
  } catch (err) {
    log.error(`\nFAILED: ${err.shortMessage || err.message}`);
    if (!dry) {
      try {
        await appendStage(spec.slug, { name: stageName, status: "failed", finishedAt: new Date().toISOString(), notes: String(err.shortMessage || err.message).slice(0, 300) });
      } catch { /* the original error matters more */ }
    }
    await log.close();
    process.exit(1);
  }
}
