#!/usr/bin/env node
// Scheduled withdrawals: approve now, fire unattended later.
//
//   node tools/schedule.js add <slug> <script> --at=<ISO> [--window=48h] [--args="--market=0x…"]
//   node tools/schedule.js list
//   node tools/schedule.js cancel <id>
//   node tools/schedule.js tick [--dry-fire]      # what Task Scheduler / cron calls
//   node tools/schedule.js install [--interactive] | uninstall   # the Windows task (admin terminal for background mode); cron line elsewhere
//
// A live run from here skips the harness's y/N prompt (it passes --yes), so
// the prompt is replaced by two things:
//
//   1. `add` IS the approval. It runs the script dry, shows the whole plan,
//      records the plan's shape hash (lib/transcript.js planShape) and asks y/N.
//   2. `tick` re-runs the same dry run at fire time and refuses unless the
//      shape still matches. Amounts may move with price; which positions, in
//      which pools, in what order, may not.
//
// Every other harness guard still runs on the live invocation. Only
// withdraw/remove scripts on the harness may be scheduled (lib/schedule.js).
//
// A failed run is never retried: partial on-chain state needs a human. A run
// that crashes the runner itself stays "running" and is never re-fired either.
//
// Exit codes: 0 ok, 1 fatal, 2 refused.

import "dotenv/config";
import { spawnSync, execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { confirm, parseArgs } from "../lib/run.js";
import { createLogger } from "../lib/log.js";
import { manifestPath } from "../lib/manifest.js";
import { notify } from "../lib/notify.js";
import { entryProblems, scriptProblems } from "../lib/schedule.js";
import { planHash, planShape } from "../lib/transcript.js";

// SCHEDULE_ROOT: test seam, see lib/schedule.js.
const ROOT = process.env.SCHEDULE_ROOT ?? path.resolve(import.meta.dirname, "..");
const LIFECYCLE = () => process.env.LIFECYCLE_DIR ?? path.join(ROOT, "lifecycle");
const RUNS = () => path.join(ROOT, "runs");
const TASK = "liquidity-scheduler";
const DRY_TIMEOUT = 15 * 60 * 1000;
const LIVE_TIMEOUT = 2 * 60 * 60 * 1000;
const HEARTBEAT_MS = 24 * 60 * 60 * 1000;

const args = parseArgs();
const [cmd, ...pos] = args.rest.filter((a) => !a.startsWith("--"));

// ── Manifest I/O ────────────────────────────────────────────────────────────
const readManifest = (slug) => JSON.parse(fs.readFileSync(manifestPath(slug), "utf8"));
const writeManifest = (slug, m) => fs.writeFileSync(manifestPath(slug), JSON.stringify(m, null, 2) + "\n");

/** Read-modify-write one entry, so a long run never writes back a stale manifest. */
function updateEntry(slug, id, patch) {
  const m = readManifest(slug);
  const e = m.schedule.find((x) => x.id === id);
  Object.assign(e, patch);
  writeManifest(slug, m);
  return e;
}

function allEntries() {
  return fs
    .readdirSync(LIFECYCLE())
    .filter((f) => f.endsWith(".json") && f !== "schema.json")
    .flatMap((f) => {
      const slug = f.slice(0, -5);
      return (readManifest(slug).schedule ?? []).map((e) => ({ slug, e }));
    });
}

// ── Running the script ──────────────────────────────────────────────────────
// stdin is closed: a prompt the runner did not anticipate reads EOF and the
// harness treats that as "not confirmed" instead of hanging until the timeout.
function runScript(script, extra, timeout) {
  const r = spawnSync(process.execPath, [script, ...extra], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    maxBuffer: 256 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const code = r.status ?? (r.error?.code === "ETIMEDOUT" ? "timeout" : 1);
  return { out, code };
}

const tail = (text, n = 20) => text.trimEnd().split(/\r?\n/).slice(-n).join("\n");

/** Lines in one plan shape but not the other — enough to say what moved. */
function shapeDiff(a, b, max = 20) {
  const A = planShape(a).split("\n");
  const B = planShape(b).split("\n");
  const inA = new Set(A);
  const inB = new Set(B);
  const out = [...A.filter((l) => !inB.has(l)).map((l) => `- ${l}`), ...B.filter((l) => !inA.has(l)).map((l) => `+ ${l}`)];
  if (!out.length) out.push("(same lines, different order or count)");
  return out.slice(0, max).join("\n") + (out.length > max ? `\n… ${out.length - max} more` : "");
}

function parseWindow(s) {
  const m = /^(\d+)(h|d)$/.exec(s);
  if (!m) throw new Error(`--window=${s}: use e.g. 48h or 3d`);
  return Number(m[1]) * (m[2] === "d" ? 24 : 1) * 3600 * 1000;
}

const fail = (msg, code = 2) => {
  console.error(`REFUSED: ${msg}`);
  process.exit(code);
};

// ── add ─────────────────────────────────────────────────────────────────────
async function add() {
  const [slug, rawScript] = pos;
  if (!slug || !rawScript || !args.opts.at) {
    fail(`usage: node tools/schedule.js add <slug> <script> --at=<ISO> [--window=48h] [--args="..."]`);
  }
  const script = rawScript.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!fs.existsSync(manifestPath(slug))) fail(`no manifest for ${slug}`);
  const probs = scriptProblems(script);
  if (probs.length) fail(probs.join("\n  "));
  if (!script.startsWith(`campaigns/${slug}/`)) fail(`${script} does not belong to campaign ${slug}`);

  const notBefore = new Date(args.opts.at);
  if (Number.isNaN(notBefore.getTime())) fail(`--at=${args.opts.at} is not a date`);
  if (notBefore.getTime() <= Date.now()) fail(`--at=${notBefore.toISOString()} is in the past`);
  const notAfter = new Date(notBefore.getTime() + parseWindow(args.opts.window ?? "48h"));
  const extra = (args.opts.args ?? "").split(" ").filter(Boolean);

  const entry = {
    id: `${slug}-${path.basename(script, ".js")}-${notBefore.toISOString().slice(0, 16).replace(/[-:T]/g, "")}`,
    script,
    args: extra,
    notBefore: notBefore.toISOString(),
    notAfter: notAfter.toISOString(),
    status: "pending",
  };
  const m = readManifest(slug);
  if ((m.schedule ?? []).some((e) => e.id === entry.id)) fail(`${entry.id} already exists`);
  const argProbs = entryProblems({ ...entry, approvedAt: "x", planHash: "x" }).filter((p) => p.includes(".args"));
  if (argProbs.length) fail(argProbs.join("\n  "));

  console.log(`dry run: node ${[script, ...extra].join(" ")}\n`);
  const dry = runScript(script, extra, DRY_TIMEOUT);
  console.log(dry.out);
  if (dry.code !== 0) fail(`the dry run exited ${dry.code}; nothing scheduled. Fix the invocation (e.g. --args="--resume") and add again.`);

  const hash = planHash(dry.out);
  const approvedLog = path.join(RUNS(), slug, "scheduled", `${entry.id}.approved.log`);
  console.log(`─────────────────────────────────────────────`);
  console.log(`  ${entry.id}`);
  console.log(`  fires   ${entry.notBefore} (${notBefore.toString()})`);
  console.log(`  expires ${entry.notAfter} — not fired after this`);
  console.log(`  plan    ${hash}`);
  console.log(`  At fire time the dry run is repeated; if its shape differs from the plan above, nothing is sent.`);
  if (!(await confirm(`Approve this plan to run LIVE, unattended, at that time?`, { yes: args.yes, dry: false }))) {
    fail("not approved; nothing scheduled");
  }

  fs.mkdirSync(path.dirname(approvedLog), { recursive: true });
  fs.writeFileSync(approvedLog, dry.out);
  const fresh = readManifest(slug);
  fresh.schedule = [
    ...(fresh.schedule ?? []),
    {
      ...entry,
      approvedAt: new Date().toISOString(),
      approvedBy: gitUser(),
      planHash: hash,
      approvedLog: path.relative(ROOT, approvedLog).replace(/\\/g, "/"),
    },
  ];
  writeManifest(slug, fresh);
  console.log(`\nScheduled ${entry.id}. Is the runner installed? \`node tools/schedule.js install\``);
}

function gitUser() {
  try {
    return execFileSync("git", ["config", "user.name"], { cwd: ROOT, encoding: "utf8" }).trim() || os.userInfo().username;
  } catch {
    return os.userInfo().username;
  }
}

// ── list / cancel ───────────────────────────────────────────────────────────
function list() {
  const rows = allEntries();
  if (!rows.length) return console.log("nothing scheduled");
  for (const { slug, e } of rows) {
    console.log(`${e.status.padEnd(9)} ${e.id}\n          ${slug}: ${e.script} ${e.args?.join(" ") ?? ""}\n          ${e.notBefore} → ${e.notAfter}${e.notes ? `\n          ${e.notes}` : ""}`);
  }
}

function cancel() {
  const id = pos[0];
  const hit = allEntries().find(({ e }) => e.id === id);
  if (!hit) fail(`no entry ${id}`);
  if (hit.e.status !== "pending") fail(`${id} is ${hit.e.status}, only a pending entry can be cancelled`);
  updateEntry(hit.slug, id, { status: "cancelled", notes: `cancelled ${new Date().toISOString()}` });
  console.log(`cancelled ${id}`);
}

// ── tick ────────────────────────────────────────────────────────────────────
async function tick() {
  const dryFire = args.flags.has("--dry-fire");
  fs.mkdirSync(RUNS(), { recursive: true });
  const log = createLogger({ file: path.join(RUNS(), "scheduler.log") });
  const lock = path.join(RUNS(), "scheduler.lock");

  // One tick at a time. A lock older than the longest live run is a crashed
  // tick, not a running one.
  if (fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs < LIVE_TIMEOUT + DRY_TIMEOUT) {
    log.log(`${new Date().toISOString()} tick: locked (${fs.readFileSync(lock, "utf8").trim()}), skipping`);
    return await log.close();
  }
  fs.writeFileSync(lock, `pid ${process.pid} since ${new Date().toISOString()}`);

  try {
    const now = Date.now();
    // One line per tick even when nothing is due: a silent log cannot tell
    // "ran, nothing to do" from "never ran" (2026-09-28, the first install).
    const pending = allEntries().filter(({ e }) => e.status === "pending");
    const next = pending.map(({ e }) => e.notBefore).sort()[0];
    log.log(`${new Date().toISOString()} tick: ${pending.length} pending${next ? `, next due ${next}` : ""}${dryFire ? " (--dry-fire)" : ""}`);
    for (const { slug, e } of allEntries()) {
      if (e.status !== "pending") continue;
      const at = `${new Date().toISOString()} ${e.id}`;
      const nb = Date.parse(e.notBefore);

      if (nb > now) {
        if (nb - now <= HEARTBEAT_MS && !e.heartbeatAt) {
          log.log(`${at}: due within 24h, heartbeat`);
          await notify({ title: `[liquidity] ${e.id}: due ${e.notBefore}`, body: `Scheduled ${e.script} fires in ${((nb - now) / 3600000).toFixed(1)}h. If no further message arrives after that, the runner did not run.`, tags: ["alarm_clock"] }, { log });
          updateEntry(slug, e.id, { heartbeatAt: new Date().toISOString() });
        }
        continue;
      }

      const probs = entryProblems(e);
      if (probs.length) {
        await finish(slug, e, log, "refused", `entry invalid: ${probs.join("; ")}`);
        continue;
      }
      if (now > Date.parse(e.notAfter)) {
        await finish(slug, e, log, "refused", `missed window: expired ${e.notAfter}. Not fired late — re-approve with \`schedule add\` if still wanted.`);
        continue;
      }

      log.log(`${at}: due — dry run`);
      const dry = runScript(e.script, e.args ?? [], DRY_TIMEOUT);
      if (dry.code !== 0) {
        await finish(slug, e, log, "refused", `the fire-time dry run exited ${dry.code}; nothing sent.\n${tail(dry.out)}`);
        continue;
      }
      const hash = planHash(dry.out);
      if (hash !== e.planHash) {
        const approved = e.approvedLog && fs.existsSync(path.join(ROOT, e.approvedLog)) ? fs.readFileSync(path.join(ROOT, e.approvedLog), "utf8") : "";
        await finish(slug, e, log, "refused", `plan changed since approval; nothing sent.\n  approved ${e.planHash}\n  now      ${hash}\n${approved ? shapeDiff(approved, dry.out) : "(approved transcript missing)"}`);
        continue;
      }
      log.log(`${at}: plan matches ${hash}`);

      if (dryFire) {
        log.log(`${at}: --dry-fire, stopping before the live run`);
        await notify({ title: `[liquidity] ${e.id}: dry-fire ok`, body: `Plan matches the approval. A real tick would now run:\nnode ${[e.script, ...(e.args ?? []), "--live", "--yes"].join(" ")}`, tags: ["test_tube"] }, { log });
        continue;
      }

      updateEntry(slug, e.id, { status: "running", firedAt: new Date().toISOString() });
      log.log(`${at}: LIVE — node ${[e.script, ...(e.args ?? []), "--live", "--yes"].join(" ")}`);
      const live = runScript(e.script, [...(e.args ?? []), "--live", "--yes"], LIVE_TIMEOUT);
      const runLog = path.join(RUNS(), slug, "scheduled", `${e.id}.log`);
      fs.mkdirSync(path.dirname(runLog), { recursive: true });
      fs.writeFileSync(runLog, live.out);
      const status = live.code === 0 ? "fired" : live.code === 2 ? "refused" : "failed";
      const advice = status === "failed" ? `\nNOT retried. Inspect, then run by hand: node ${e.script} ${[...(e.args ?? []), "--live", "--resume"].join(" ")}` : "";
      await finish(slug, e, log, status, `live run exited ${live.code}.${advice}\n${tail(live.out)}`, {
        exitCode: typeof live.code === "number" ? live.code : null,
        runLog: path.relative(ROOT, runLog).replace(/\\/g, "/"),
      });
    }
  } finally {
    fs.rmSync(lock, { force: true });
    await log.close();
  }
}

async function finish(slug, e, log, status, detail, extra = {}) {
  const firstLine = detail.split("\n")[0];
  log.log(`${new Date().toISOString()} ${e.id}: ${status.toUpperCase()} — ${detail}`);
  updateEntry(slug, e.id, { status, finishedAt: new Date().toISOString(), notes: firstLine.slice(0, 300), ...extra });
  await notify(
    {
      title: `[liquidity] ${e.id}: ${status}`,
      body: detail.slice(0, 3500),
      priority: status === "fired" ? "default" : "high",
      tags: [status === "fired" ? "white_check_mark" : "warning"],
    },
    { log }
  );
}

// ── install / uninstall ─────────────────────────────────────────────────────
// Every 15 minutes, wakes the machine from sleep (not from shutdown), and runs
// a missed start as soon as it can — the entry's notAfter window bounds how
// late that may be.
//
// Two ways to run it, tried in this order:
//   background  S4U logon ("run whether user is logged on or not", no password
//               stored). No window ever, and it runs after a reboot before
//               anyone logs in. Registering it needs an elevated terminal.
//   interactive Runs only while the user is logged on, and node's console
//               flashes up every tick. Wrapping node in `conhost --headless` to
//               hide it was tried and dropped: run by hand, it exited without
//               starting node (2026-09-28). Used when background is refused,
//               or with --interactive.
function taskXml(background) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const start = new Date(Date.now() + 60_000).toISOString().slice(0, 19);
  const principal = background
    ? `<UserId>${esc(os.userInfo().username)}</UserId><LogonType>S4U</LogonType>`
    : `<LogonType>InteractiveToken</LogonType>`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Fires approved withdrawals recorded in lifecycle/*.json (tools/schedule.js).</Description></RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition><Interval>PT15M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
      <StartBoundary>${start}</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals><Principal id="Author">${principal}<RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <WakeToRun>true</WakeToRun>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <ExecutionTimeLimit>PT3H</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${esc(process.execPath)}</Command>
      <Arguments>tools\schedule.js tick</Arguments>
      <WorkingDirectory>${esc(ROOT)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

function registerTask(background) {
  const xml = path.join(RUNS(), "scheduler-task.xml");
  fs.mkdirSync(RUNS(), { recursive: true });
  // schtasks reads the definition as UTF-16 LE; the BOM is what tells it so.
  fs.writeFileSync(xml, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml(background), "utf16le")]));
  const r = spawnSync("schtasks", ["/Create", "/TN", TASK, "/XML", xml, "/F"], { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function install() {
  if (process.platform !== "win32") {
    console.log(`Add to crontab (crontab -e):\n\n*/15 * * * * cd ${ROOT} && ${process.execPath} tools/schedule.js tick >/dev/null 2>&1\n`);
    console.log(`The key in .env, and the LP positions it owns, then live on this machine. Use a dedicated campaign wallet.`);
    return;
  }
  let mode = "background";
  let r = args.flags.has("--interactive") ? { ok: false, out: "--interactive" } : registerTask(true);
  if (!r.ok) {
    if (!args.flags.has("--interactive")) {
      console.log(`Background mode refused (${r.out.split("\n").pop()}).`);
      if (/access is denied/i.test(r.out)) {
        console.log(`It needs an elevated terminal: open PowerShell as Administrator, cd ${ROOT}, and run this again.`);
      }
      console.log(`The existing task, if any, is unchanged. Pass --interactive to install the logged-on-only`);
      console.log(`mode instead: it works, but a console flashes up every 15 minutes.`);
      process.exit(2);
    }
    mode = "interactive";
    r = registerTask(false);
    if (!r.ok) throw new Error(r.out);
  }
  console.log(r.out);
  console.log(`\nInstalled "${TASK}" (${mode}): every 15 min, wakes from sleep.`);
  console.log(mode === "background"
    ? `No window, and it runs after a reboot even before you log in.`
    : `Runs only while you are logged in; a console flashes up each tick.`);
  console.log(`Prove it runs: schtasks /Run /TN ${TASK}, then read runs\scheduler.log — every tick writes a line.`);
  console.log(`Wake timers must be allowed: Power Options → Sleep → Allow wake timers → Enable.`);
  if (!process.env.NTFY_TOPIC) console.log(`NTFY_TOPIC is not set in .env — runs will fire but nobody will be told.`);
}

function uninstall() {
  if (process.platform !== "win32") return console.log("Remove the line from your crontab.");
  execFileSync("schtasks", ["/Delete", "/TN", TASK, "/F"], { stdio: "inherit" });
}

// ── main ────────────────────────────────────────────────────────────────────
const commands = { add, list, cancel, tick, install, uninstall };
if (!commands[cmd]) fail(`usage: node tools/schedule.js <${Object.keys(commands).join("|")}> …`);
try {
  await commands[cmd]();
} catch (e) {
  console.error(`FAILED: ${e.message}`);
  process.exit(1);
}
