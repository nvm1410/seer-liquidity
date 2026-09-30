// What may be scheduled, stated as checks rather than remembered.
//
// Shared by tools/schedule.js (refuses to add a bad entry) and
// tools/validate-manifest.js (refuses a hand-edited one). See
// lifecycle/README.md "Scheduled runs".
//
// A scheduled run skips the harness's y/N prompt, so the only scripts allowed
// here are ones whose effect is fixed once the approval is recorded:
//
//   withdraw/remove, unwind stage   — what it pulls is fixed by the positions.
//   resolve/redeem,  settle stage   — ONLY if it imports finalAnswerProblems
//                                     (lib/settle.js) and so refuses to send
//                                     unless every answer is final and equals
//                                     the approved one. Added 2026-09-30 for
//                                     zcash-q3; before that, settle was manual.
//
// Reality ANSWERS are never schedulable: an answer is the judgment itself and
// posts a bond.

import fs from "fs";
import path from "path";

// SCHEDULE_ROOT is a test seam, like LIFECYCLE_DIR: it lets tests/schedule.test.js
// point the runner at a throwaway tree of stub scripts.
const ROOT = process.env.SCHEDULE_ROOT ?? path.resolve(import.meta.dirname, "..");

export const STATUSES = ["pending", "running", "fired", "refused", "failed", "cancelled"];

/** Problems with scheduling this script, or [] if it may be scheduled. */
export function scriptProblems(script) {
  const errs = [];
  if (!/^campaigns\/[^/]+\/[^/]+\.js$/.test(script)) {
    errs.push(`${script}: must be a campaigns/<slug>/<script>.js path, relative, forward slashes (superseded/ is not schedulable)`);
    return errs;
  }
  const abs = path.join(ROOT, script);
  if (!fs.existsSync(abs)) return [`${script}: does not exist`];
  const base = path.basename(script);
  const src = fs.readFileSync(abs, "utf8");
  // Without the harness there is no dry mode to compare and no --live gate:
  // the gated scripts (index.js and friends) would send on a bare invocation.
  if (!/from\s+["'][./]*lib\/run\.js["']/.test(src)) errs.push(`${script}: does not run on lib/run.js`);
  if (/answer/.test(base)) {
    errs.push(`${script}: Reality answers are never scheduled — only withdraw/remove or resolve/redeem scripts`);
  } else if (/(withdraw|remove)/.test(base)) {
    if (!/stage:\s*["']unwind/.test(src)) errs.push(`${script}: its harness stage is not an unwind stage`);
  } else if (/(resolve|redeem)/.test(base)) {
    if (!/stage:\s*["']settle/.test(src)) errs.push(`${script}: its harness stage is not a settle stage`);
    if (!/\bfinalAnswerProblems\b[^;]*from\s+["'][./]*lib\/settle\.js["']/s.test(src)) {
      errs.push(`${script}: a scheduled settle script must import finalAnswerProblems from lib/settle.js`);
    }
  } else {
    errs.push(`${script}: only withdraw/remove or resolve/redeem scripts may be scheduled`);
  }
  return errs;
}

/** Problems with one manifest schedule entry. */
export function entryProblems(e, at = "schedule") {
  const errs = scriptProblems(e.script ?? "").map((m) => `${at}: ${m}`);
  const nb = Date.parse(e.notBefore);
  const na = Date.parse(e.notAfter);
  if (Number.isNaN(nb)) errs.push(`${at}.notBefore: not an ISO date`);
  if (Number.isNaN(na)) errs.push(`${at}.notAfter: not an ISO date`);
  if (!Number.isNaN(nb) && !Number.isNaN(na) && nb >= na) errs.push(`${at}: notBefore must be before notAfter`);
  if (e.status === "pending" && !(e.approvedAt && e.planHash)) {
    errs.push(`${at}: a pending entry needs approvedAt and planHash — add it with tools/schedule.js, not by hand`);
  }
  if ((e.args ?? []).some((a) => a === "--live" || a === "--yes")) {
    errs.push(`${at}.args: --live and --yes are added by the runner, never recorded`);
  }
  return errs;
}
