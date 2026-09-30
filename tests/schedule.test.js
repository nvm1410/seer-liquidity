// tools/schedule.js end to end, against a throwaway tree.
//
// SCHEDULE_ROOT and LIFECYCLE_DIR point the runner at a temp directory holding
// one manifest and a stub "withdraw" script. The stub records every invocation
// and prints a plan steered by env vars, so each case can make the fire-time dry
// run match, drift, or fail. No network, no chain, nothing sent.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const TOOL = path.join(ROOT, "tools", "schedule.js");
const SCRIPT = "campaigns/demo/withdraw-demo.js";

// The two comment lines satisfy lib/schedule.js's scope check; the stub itself
// runs without the harness so the test needs no chain.
const STUB = `// import { run } from "../../lib/run.js";
// stage: "unwind-withdraw"
import fs from "fs";
const live = process.argv.includes("--live");
fs.appendFileSync("calls.txt", process.argv.slice(2).join(" ") + "\\n");
console.log("Position 1001 liquidity 123456789012345 fees " + (process.env.STUB_FEES ?? "1.5") + " sUSDS");
console.log("Position " + (process.env.STUB_POS ?? "1002") + " in pool 0x00000000000000000000000000000000000000aa");
process.exit(Number((live ? process.env.STUB_LIVE_EXIT : process.env.STUB_DRY_EXIT) ?? 0));
`;

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "liq-schedule-"));
  fs.mkdirSync(path.join(dir, "campaigns", "demo"), { recursive: true });
  fs.mkdirSync(path.join(dir, "lifecycle"));
  fs.writeFileSync(path.join(dir, SCRIPT), STUB);
  fs.writeFileSync(path.join(dir, "campaigns", "demo", "answer-demo.js"), STUB);
  fs.writeFileSync(path.join(dir, "lifecycle", "demo.json"), JSON.stringify({ schemaVersion: 2, setSlug: "demo" }, null, 2));
  return dir;
}

function tool(dir, args, env = {}) {
  const r = spawnSync(process.execPath, [TOOL, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, SCHEDULE_ROOT: dir, LIFECYCLE_DIR: path.join(dir, "lifecycle"), NTFY_TOPIC: "", ...env },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const manifest = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "lifecycle", "demo.json"), "utf8"));
const entry = (dir) => manifest(dir).schedule[0];
const calls = (dir) => (fs.existsSync(path.join(dir, "calls.txt")) ? fs.readFileSync(path.join(dir, "calls.txt"), "utf8").replace(/\n$/, "").split("\n") : []);

/** Approve an entry an hour out, then (optionally) move time so it is due. */
function scheduled({ due = true, expired = false } = {}) {
  const dir = fixture();
  const at = new Date(Date.now() + 3600_000).toISOString();
  const r = tool(dir, ["add", "demo", SCRIPT, `--at=${at}`, "--yes"]);
  assert.equal(r.code, 0, r.out);
  if (due) {
    const m = manifest(dir);
    m.schedule[0].notBefore = new Date(Date.now() - (expired ? 72 : 1) * 3600_000).toISOString();
    m.schedule[0].notAfter = new Date(Date.now() + (expired ? -24 : 47) * 3600_000).toISOString();
    fs.writeFileSync(path.join(dir, "lifecycle", "demo.json"), JSON.stringify(m, null, 2));
  }
  fs.rmSync(path.join(dir, "calls.txt"), { force: true });
  return dir;
}

describe("schedule add", () => {
  it("records an approved entry with a plan hash and the approved transcript", () => {
    const dir = scheduled({ due: false });
    const e = entry(dir);
    assert.equal(e.status, "pending");
    assert.match(e.planHash, /^sha256=[0-9a-f]{64}$/);
    assert.ok(fs.existsSync(path.join(dir, e.approvedLog)));
  });

  it("refuses a script outside the withdraw scope", () => {
    const dir = fixture();
    const r = tool(dir, ["add", "demo", "campaigns/demo/answer-demo.js", `--at=${new Date(Date.now() + 3600_000).toISOString()}`, "--yes"]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /only withdraw\/remove or resolve\/redeem scripts/);
    assert.equal(manifest(dir).schedule, undefined);
  });

  it("refuses when the approval-time dry run fails", () => {
    const dir = fixture();
    const r = tool(dir, ["add", "demo", SCRIPT, `--at=${new Date(Date.now() + 3600_000).toISOString()}`, "--yes"], { STUB_DRY_EXIT: "2" });
    assert.equal(r.code, 2, r.out);
    assert.equal(manifest(dir).schedule, undefined);
  });

  it("refuses --live smuggled in through --args", () => {
    const dir = fixture();
    const r = tool(dir, ["add", "demo", SCRIPT, `--at=${new Date(Date.now() + 3600_000).toISOString()}`, "--args=--live", "--yes"]);
    assert.equal(r.code, 2, r.out);
    assert.equal(calls(dir).length, 0);
  });
});

describe("schedule tick", () => {
  it("does not fire an entry that is not yet due, but sends one heartbeat", () => {
    const dir = scheduled({ due: false });
    assert.equal(tool(dir, ["tick"]).code, 0);
    assert.deepEqual(calls(dir), []);
    assert.equal(entry(dir).status, "pending");
    assert.ok(entry(dir).heartbeatAt);
  });

  it("fires a due entry whose plan still matches, with --live --yes", () => {
    const dir = scheduled();
    const r = tool(dir, ["tick"]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(calls(dir), ["", "--live --yes"]);
    assert.equal(entry(dir).status, "fired");
    assert.ok(fs.existsSync(path.join(dir, entry(dir).runLog)));
  });

  it("fires when only amounts moved", () => {
    const dir = scheduled();
    tool(dir, ["tick"], { STUB_FEES: "7.25" });
    assert.equal(entry(dir).status, "fired");
  });

  it("refuses when the plan's shape drifted, and sends nothing", () => {
    const dir = scheduled();
    tool(dir, ["tick"], { STUB_POS: "9999" });
    assert.deepEqual(calls(dir), [""]);
    assert.equal(entry(dir).status, "refused");
    assert.match(entry(dir).notes, /plan changed/);
  });

  it("refuses a missed window rather than firing late", () => {
    const dir = scheduled({ expired: true });
    tool(dir, ["tick"]);
    assert.deepEqual(calls(dir), []);
    assert.equal(entry(dir).status, "refused");
    assert.match(entry(dir).notes, /missed window/);
  });

  it("marks a failed live run and never retries it", () => {
    const dir = scheduled();
    tool(dir, ["tick"], { STUB_LIVE_EXIT: "1" });
    assert.equal(entry(dir).status, "failed");
    assert.equal(entry(dir).exitCode, 1);
    tool(dir, ["tick"]);
    assert.equal(calls(dir).filter((c) => c.includes("--live")).length, 1);
  });

  it("--dry-fire checks everything and stops before the live run", () => {
    const dir = scheduled();
    tool(dir, ["tick", "--dry-fire"]);
    assert.deepEqual(calls(dir), [""]);
    assert.equal(entry(dir).status, "pending");
  });

  it("cancel stops a pending entry from firing", () => {
    const dir = scheduled();
    assert.equal(tool(dir, ["cancel", entry(dir).id]).code, 0);
    tool(dir, ["tick"]);
    assert.deepEqual(calls(dir), []);
    assert.equal(entry(dir).status, "cancelled");
  });
});

describe("validate-manifest", () => {
  it("rejects a hand-written entry that schedules an ungated script", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "liq-schedule-lint-"));
    const file = path.join(dir, "l1-deepfunding.json");
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, "lifecycle", "l1-deepfunding.json"), "utf8"));
    m.schedule = [{
      id: "x",
      script: "campaigns/l1-deepfunding/superseded/index.js",
      notBefore: "2030-01-01T00:00:00Z",
      notAfter: "2030-01-02T00:00:00Z",
      status: "pending",
    }];
    fs.writeFileSync(file, JSON.stringify(m));
    const r = spawnSync(process.execPath, [path.join(ROOT, "tools", "validate-manifest.js"), file], { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /superseded\/ is not schedulable/);
    assert.match(r.stderr, /needs approvedAt and planHash/);
  });
});

// Settle scripts became schedulable on 2026-09-30 (zcash-q3), but only ones that
// import finalAnswerProblems — the check that refuses to resolve on anything but
// the approved, final answers. Answers themselves stay unschedulable.
describe("schedule scope: settle", () => {
  const settleStub = (importLine) => `// import { run } from "../../lib/run.js";
${importLine}
// stage: "settle-resolve-redeem"
import fs from "fs";
fs.appendFileSync("calls.txt", process.argv.slice(2).join(" ") + "\\n");
console.log("Market 0x00000000000000000000000000000000000000bb redeem 12.5");
console.log("~ " + (process.env.STUB_STATUS ?? "3 problem(s), not final until 2026-10-03T20:59:19Z"));
`;
  const GOOD = "campaigns/demo/resolve-redeem-demo.js";
  const BAD = "campaigns/demo/redeem-unguarded-demo.js";

  function settleFixture() {
    const dir = fixture();
    fs.writeFileSync(path.join(dir, GOOD), settleStub(`// import { finalAnswerProblems } from "../../lib/settle.js";`));
    fs.writeFileSync(path.join(dir, BAD), settleStub(`// import { planRedemption } from "../../lib/settle.js";`));
    return dir;
  }
  const at = () => `--at=${new Date(Date.now() + 3600_000).toISOString()}`;

  it("accepts a resolve/redeem script that imports finalAnswerProblems", () => {
    const dir = settleFixture();
    const r = tool(dir, ["add", "demo", GOOD, at(), "--yes"]);
    assert.equal(r.code, 0, r.out);
    assert.equal(entry(dir).status, "pending");
  });

  it("refuses a redeem script without the final-answer check", () => {
    const dir = settleFixture();
    const r = tool(dir, ["add", "demo", BAD, at(), "--yes"]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /must import finalAnswerProblems/);
  });

  it("still refuses an answer script", () => {
    const dir = settleFixture();
    const r = tool(dir, ["add", "demo", "campaigns/demo/answer-demo.js", at(), "--yes"]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /Reality answers are never scheduled/);
  });

  it("fires when only the ~ status lines changed between approval and fire", () => {
    const dir = settleFixture();
    assert.equal(tool(dir, ["add", "demo", GOOD, at(), "--yes"]).code, 0);
    const m = manifest(dir);
    m.schedule[0].notBefore = new Date(Date.now() - 3600_000).toISOString();
    m.schedule[0].notAfter = new Date(Date.now() + 47 * 3600_000).toISOString();
    fs.writeFileSync(path.join(dir, "lifecycle", "demo.json"), JSON.stringify(m, null, 2));
    tool(dir, ["tick"], { STUB_STATUS: "0 problem(s); every answer is final and matches" });
    assert.equal(entry(dir).status, "fired", entry(dir).notes);
  });
});
