// End-to-end: spawn a throwaway script through lib/run.js and check that every
// guard actually refuses.
//
// A guard that has never been observed refusing is a comment. These run the real
// harness in a real subprocess and assert on exit codes: 0 ok, 1 fatal,
// 2 refused-by-guard.
//
// The REFUSAL cases need no network: each one bails before the harness connects,
// which is the point — the cheap checks come first, so a bad invocation costs
// nothing. The cases that run to completion do assert the chain id, and so need
// RPC_URL and PRIVATE_KEY; those skip rather than fail when .env is absent.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");

// A dry run still asserts the chain id, so the cases that run to completion need
// credentials. Skip them rather than fail on a machine with no .env.
const hasEnv = (() => {
  try {
    const f = path.join(ROOT, ".env");
    if (!fs.existsSync(f)) return false;
    const t = fs.readFileSync(f, "utf8");
    return /^\s*PRIVATE_KEY\s*=\s*\S/m.test(t) && /^\s*RPC_URL\s*=\s*\S/m.test(t);
  } catch {
    return false;
  }
})();
const needsChain = { skip: hasEnv ? false : "needs RPC_URL and PRIVATE_KEY in .env" };

const MANIFEST = {
  $schema: "./schema.json",
  schemaVersion: 2,
  setSlug: "harness-selftest",
  mode: "launch",
  family: "other",
  status: "draft",
  chain: {
    id: 10,
    name: "optimism",
    collateral: { symbol: "sUSDS", address: "0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0", decimals: 18 },
  },
  amm: { kind: "uniswap-v3", feeTier: 100, tickSpacing: 1 },
  liquidity: { totalCollateral: 10, band: { minPrice: 0.02, maxPrice: 0.98 } },
  spendingCap: { collateral: 10, gasEth: 0.01 },
};

// On Windows an absolute path is not a valid ESM specifier — it must be a
// file:// URL, or Node rejects it with ERR_UNSUPPORTED_ESM_URL_SCHEME.
const SCRIPT = `
import { run } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "lib", "run.js")).href)};
await run(
  { name: "selftest", slug: "harness-selftest", stage: "selftest", mutating: true, needsGate: true },
  async (ctx) => { ctx.log.log("MAIN RAN dry=" + ctx.dry); }
);
`;

/** Spawn the harness; return {code, out}. */
function invoke(args, { dir, env = {} }) {
  try {
    const out = execFileSync(process.execPath, [path.join(dir, "selftest.mjs"), ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LIFECYCLE_DIR: dir, ...env },
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function fixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "liq-harness-"));
  fs.writeFileSync(path.join(dir, "harness-selftest.json"), JSON.stringify({ ...MANIFEST, ...overrides }, null, 2));
  fs.writeFileSync(path.join(dir, "selftest.mjs"), SCRIPT);
  return dir;
}

describe("lib/run.js guards", () => {
  it("with no flags: runs dry, sends nothing, exits 0", needsChain, () => {
    const dir = fixture();
    const { code, out } = invoke([`--progress=${path.join(dir, "p.json").replace(/\\/g, "/")}`], { dir });
    assert.equal(code, 0, out);
    assert.match(out, /DRY RUN \(nothing will be sent\)/);
    assert.match(out, /MAIN RAN dry=true/);
    assert.match(out, /nothing was sent/);
  });

  it("--live on an ungated manifest: REFUSED with exit 2", () => {
    const dir = fixture({ status: "draft" });
    const { code, out } = invoke(["--live", "--yes", `--progress=${path.join(dir, "p.json").replace(/\\/g, "/")}`], { dir });
    assert.equal(code, 2, out);
    assert.match(out, /REFUSED/);
    assert.match(out, /status "draft" with no approval/);
    assert.doesNotMatch(out, /MAIN RAN/, "the campaign body must not run");
  });

  it("--live with a stale gate hash: REFUSED with exit 2", () => {
    const dir = fixture({
      status: "gated",
      files: { seed: "package.json" }, // any real file in the repo
      gate: { approvedAt: "2026-01-01", approvedBy: "test", summaryHash: "sha256=" + "0".repeat(64) },
    });
    const { code, out } = invoke(["--live", "--yes", `--progress=${path.join(dir, "p.json").replace(/\\/g, "/")}`], { dir });
    assert.equal(code, 2, out);
    assert.match(out, /has changed since approval/);
    assert.doesNotMatch(out, /MAIN RAN/);
  });

  it("a non-empty progress file without --resume: REFUSED with exit 2", () => {
    const dir = fixture();
    const p = path.join(dir, "p.json");
    fs.writeFileSync(p, JSON.stringify([{ kind: "pool", key: "already-done" }], null, 2));
    const { code, out } = invoke([`--progress=${p.replace(/\\/g, "/")}`], { dir });
    assert.equal(code, 2, out);
    assert.match(out, /RESUME LOG, not a record/);
    assert.doesNotMatch(out, /MAIN RAN/);
  });

  it("the same file WITH --resume: proceeds, reporting what it will skip", needsChain, () => {
    const dir = fixture();
    const p = path.join(dir, "p.json");
    fs.writeFileSync(p, JSON.stringify([{ kind: "pool", key: "already-done" }], null, 2));
    const { code, out } = invoke([`--progress=${p.replace(/\\/g, "/")}`, "--resume"], { dir });
    assert.equal(code, 0, out);
    assert.match(out, /resuming: 1 item\(s\) already done will be skipped/);
    assert.match(out, /MAIN RAN dry=true/);
  });

  it("a missing manifest fails (exit 1), it does not invent one", () => {
    const dir = fixture();
    fs.rmSync(path.join(dir, "harness-selftest.json"));
    const { code, out } = invoke([`--progress=${path.join(dir, "p.json").replace(/\\/g, "/")}`], { dir });
    assert.equal(code, 1, out);
    assert.match(out, /no manifest at/);
  });

  it("writes its own transcript next to the progress file", needsChain, () => {
    const dir = fixture();
    invoke([`--progress=${path.join(dir, "p.json").replace(/\\/g, "/")}`], { dir });
    const logs = fs.readdirSync(dir).filter((f) => f.startsWith("dry-") && f.endsWith(".log"));
    assert.equal(logs.length, 1, `expected one dry-run transcript, got ${logs.join(", ")}`);
    assert.match(fs.readFileSync(path.join(dir, logs[0]), "utf8"), /MAIN RAN dry=true/);
  });
});
