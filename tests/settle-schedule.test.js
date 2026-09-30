// finalAnswerProblems (lib/settle.js) and the "~ " status lines of planShape
// (lib/transcript.js): the two pieces that let a resolve/redeem be approved
// before its questions finalize and fired after, unattended.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { finalAnswerProblems } from "../lib/settle.js";
import { planHash } from "../lib/transcript.js";

const YES = "0x" + "0".repeat(64);
const NO = "0x" + "0".repeat(63) + "1";
const T = 1_800_000_000;
const q = (over = {}) => ({ finalize_ts: BigInt(T), is_pending_arbitration: false, best_answer: NO, ...over });
const one = (question, expected = NO) => finalAnswerProblems([{ label: "M", questions: [question], expected: [expected] }], T + 1);

describe("finalAnswerProblems", () => {
  it("passes a final question carrying the approved answer", () => {
    assert.deepEqual(one(q()), []);
  });
  it("refuses a question that carries a different answer", () => {
    assert.match(one(q({ best_answer: YES }))[0], /best_answer/);
  });
  it("refuses an unanswered question", () => {
    assert.match(one(q({ finalize_ts: 0n, best_answer: YES }))[0], /unanswered/);
  });
  it("refuses at exactly finalize_ts — Reality's comparison is strict", () => {
    const p = finalAnswerProblems([{ label: "M", questions: [q()], expected: [NO] }], T);
    assert.match(p[0], /not final until/);
  });
  it("refuses a question under arbitration however old", () => {
    assert.match(one(q({ is_pending_arbitration: true }))[0], /arbitration/);
  });
  it("refuses a count mismatch between questions and approved answers", () => {
    const p = finalAnswerProblems([{ label: "M", questions: [q(), q()], expected: [NO] }], T + 1);
    assert.match(p[0], /2 question/);
  });
  it("reports every market, not just the first", () => {
    const p = finalAnswerProblems(
      [{ label: "A", questions: [q({ best_answer: YES })], expected: [NO] }, { label: "B", questions: [q()], expected: [YES] }],
      T + 1
    );
    assert.equal(p.length, 2);
  });
});

describe("planShape status lines", () => {
  const plan = "[11] BLINDVAULT  No  0x00000000000000000000000000000000000000aa  35.95   resolve, redeem";
  it("ignores a changed ~ line", () => {
    assert.equal(planHash(`${plan}\n~ 37 problem(s)\n~   not final`), planHash(`${plan}\n~ 0 problem(s)`));
  });
  it("still sees a changed plan line", () => {
    assert.notEqual(planHash(plan), planHash(plan.replace("resolve, redeem", "resolve, nothing to redeem")));
  });
  it("masks an 18-decimal amount whole, integer part included", () => {
    assert.equal(planHash("proceeds : 356.008243382696269196 sUSDS"), planHash("proceeds : 1.5 sUSDS"));
  });
  it("does not treat a ~ inside a line as a status line", () => {
    assert.notEqual(planHash(`${plan} ~ x`), planHash(`${plan} ~ y`));
  });
});
