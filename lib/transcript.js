// Comparing two transcripts of the same script.
//
// normalize() is what tools/refactor-diff.js uses to decide "same plan": it
// strips what legitimately differs between two runs of anything (timestamps,
// tx hashes, block numbers, the harness's own banner lines).
//
// planShape() goes one step further for tools/schedule.js, which compares a dry
// run taken when a withdrawal was APPROVED against one taken when it FIRES, days
// later. Between those two moments token amounts move with price and fees
// accrue, so every decimal and every wei-sized integer is masked. What is left —
// position ids, pool and market addresses, how many of each, the order of steps
// — must not have moved. If it has, the plan is not the one that was approved.
//
// A line starting "~ " (after indentation) is a STATUS line: it reports chain
// state at run time — "not final until …", "already resolved" — which is exactly
// what is expected to differ between approval and fire. A settle run approved
// before its questions finalize must still hash the same after. Status lines are
// dropped from the shape only; normalize() keeps them, so refactor-diff still
// compares them. Never put a step of the plan on one.

import crypto from "crypto";

// Normalize away what legitimately differs between two runs of anything.
export function normalize(text) {
  return text
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<ts>")
        .replace(/0x[0-9a-fA-F]{64}/g, "<hash>")
        .replace(/block \d+/gi, "block <n>")
        // openingTime is Date.now() in some creators, so it differs between two
        // runs of the same script — that is not a behaviour change.
        .replace(/openingTime=\d{9,11}/g, "openingTime=<ts>")
        .replace(/\s+$/, "")
        // "./x" and "x" are the same path: the frozen scripts wrote relative
        // literals with the prefix, the manifest stores them without.
        .replace(/(^|[\s(])\.\//g, "$1")
    )
    // Lines the harness adds that the old script never printed.
    .filter(
      (l) =>
        l.trim() !== "" &&
        !/^[\w-]+ — (DRY RUN|LIVE)/.test(l) &&
        !/^\s{2}campaign /.test(l) &&
        !/^\s{2}chain \d+ ok/.test(l) &&
        !/^\s{2}gate: /.test(l) &&
        !/^\s{2}resuming: /.test(l) &&
        !/Dry run complete/.test(l) &&
        !/^Done\./.test(l) &&
        // The old scripts printed their own mode banner; the harness prints one.
        !/^(📋 )?DRY_RUN\s*:/.test(l)
    )
    .join("\n");
}

export function planShape(text) {
  return normalize(text)
    .split("\n")
    .filter((l) => !/^\s*~ /.test(l))
    .map((l) =>
      l
        .replace(/0x[0-9a-fA-F]{40}/g, (a) => a.toLowerCase())
        // human-readable amounts, prices, percentages. BEFORE the wei mask: an
        // 18-decimal formatUnits fraction is itself 13+ digits, and masking it
        // first left "59251.<n>" — the integer part leaking into the shape.
        .replace(/\d[\d,]*\.\d+(e[-+]?\d+)?/g, "<x>")
        // wei amounts, liquidity, millisecond timestamps
        .replace(/(?<![0-9a-fA-Fx])\d{13,}(?![0-9a-fA-F])/g, "<n>")
    )
    .join("\n");
}

export const planHash = (text) => "sha256=" + crypto.createHash("sha256").update(planShape(text)).digest("hex");
