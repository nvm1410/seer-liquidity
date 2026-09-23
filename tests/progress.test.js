// The resume-log guard and the argument parsing behind --live.
//
// These two defaults are the whole safety argument for the harness, so they get
// tested directly rather than assumed.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { openProgress, ProgressReuseError } from "../lib/progress.js";
import { parseArgs } from "../lib/run.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "liq-progress-"));

describe("lib/progress.js — the trap from commit 95bdd69", () => {
  it("opens a fresh file and records what is done", () => {
    const dir = tmp();
    const file = path.join(dir, "progress.json");
    const p = openProgress(file);
    assert.equal(p.count, 0);
    assert.equal(p.has("pool", "Q1:YES"), false);

    p.append({ kind: "pool", key: "Q1:YES", amount: "1" });
    assert.equal(p.has("pool", "Q1:YES"), true);
    // Same key, different kind, is a different item.
    assert.equal(p.has("split", "Q1:YES"), false);
    assert.equal(p.count, 1);

    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(onDisk.length, 1);
    assert.ok(onDisk[0].timestamp, "entries are stamped");
  });

  it("REFUSES to reopen a non-empty log without --resume", () => {
    const dir = tmp();
    const file = path.join(dir, "progress.json");
    openProgress(file).append({ kind: "pool", key: "Q1:YES" });

    // This is the failure that seeded nothing: every item would be skipped and
    // the run would report success.
    assert.throws(() => openProgress(file), ProgressReuseError);
    assert.throws(() => openProgress(file), /RESUME LOG, not a record/);
    assert.throws(() => openProgress(file), /--resume/);
  });

  it("allows it with --resume, and still skips what is done", () => {
    const dir = tmp();
    const file = path.join(dir, "progress.json");
    openProgress(file).append({ kind: "pool", key: "Q1:YES" });

    const p = openProgress(file, { allowResume: true });
    assert.equal(p.count, 1);
    assert.equal(p.has("pool", "Q1:YES"), true);
    assert.equal(p.has("pool", "Q1:NO"), false);
  });

  it("rejects a corrupt log rather than silently starting over", () => {
    const dir = tmp();
    const file = path.join(dir, "progress.json");
    fs.writeFileSync(file, "{ this is not json");
    assert.throws(() => openProgress(file), /not valid JSON/);

    const file2 = path.join(dir, "p2.json");
    fs.writeFileSync(file2, '{"kind":"pool"}');
    assert.throws(() => openProgress(file2), /not a JSON array/);
  });

  it("treats an empty file as fresh", () => {
    const dir = tmp();
    const file = path.join(dir, "progress.json");
    fs.writeFileSync(file, "   \n");
    assert.equal(openProgress(file).count, 0);
  });

  it("writes atomically, leaving no partial JSON behind", () => {
    const dir = tmp();
    const file = path.join(dir, "progress.json");
    const p = openProgress(file);
    for (let i = 0; i < 25; i++) p.append({ kind: "pool", key: `k${i}` });
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).length, 25);
    assert.equal(fs.existsSync(`${file}.tmp`), false, "temp file cleaned up");
  });

  it("requires a kind, since that is half the skip key", () => {
    const dir = tmp();
    assert.throws(() => openProgress(path.join(dir, "p.json")).append({ key: "x" }), /needs a `kind`/);
  });
});

describe("lib/run.js argument parsing — dry is the default", () => {
  it("is dry with no flags", () => {
    const a = parseArgs([]);
    assert.equal(a.live, false);
    assert.equal(a.resume, false);
    assert.equal(a.yes, false);
  });

  it("only --live opts in", () => {
    assert.equal(parseArgs(["--live"]).live, true);
    // Near misses must NOT arm it.
    for (const near of ["live", "-live", "--LIVE", "--live=true", "--livex"]) {
      assert.equal(parseArgs([near]).live, false, `${near} must not enable live`);
    }
  });

  it("reads --progress= and passes other flags through", () => {
    const a = parseArgs(["--live", "--resume", "--progress=runs/x/p.json", "--markets-only"]);
    assert.equal(a.live, true);
    assert.equal(a.resume, true);
    assert.equal(a.progress, "runs/x/p.json");
    assert.ok(a.flags.has("--markets-only"), "unknown flags stay available to the script");
  });
});
