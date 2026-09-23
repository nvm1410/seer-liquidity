// Golden: recompute every Reality question this repo ever asked, and require
// exact equality with what actually went on chain.
//
// This is the highest-value test in the suite. A question id is derived from the
// question's CONTENT, and MarketFactory.askRealityQuestion reuses an existing
// question rather than asking a new one:
//
//     if (realitio.getTimeout(question_id) != 0) return question_id;
//
// So an encoder that drifts by one byte does not fail loudly — it silently binds
// a new market to somebody else's question, and there is no undoing that after
// the fact.
//
// What the logs give us varies, and the difference is worth knowing:
//
//   zcash-q3, zcash-nu7   record encodedQuestion AND realityQuestionId, so the
//                         encoder and the id are both checked directly.
//   originality-r3        records neither — only the resulting ids. So the
//                         question is RECONSTRUCTED from the manifest's name
//                         shape, and the children exercise the SECOND hash too:
//                         the CTF questionId that binds the Reality ids to the
//                         market's outcome count, template and bounds.
//
// All of it is offline and deterministic.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { ethers } from "ethers";
import {
  SEP,
  TEMPLATE,
  checkQuestionText,
  checkTokenName,
  computeMarketQuestionId,
  computeQuestionId,
  encodeQuestionWithOutcomes,
  encodeQuestionWithoutOutcomes,
} from "../lib/reality.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const ethersParse = (eth) => ethers.parseEther(String(eth));

// Chain-level values the logs do not repeat per row.
const OPTIMISM = {
  arbitrator: "0x5AFa42b30955f137e10f89dfb5EF1542a186F90e",
  realitio: "0x0eF940F7f053a2eF5D6578841072488aF0c7d89A",
  factory: "0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6",
  questionTimeout: 302400,
};

/** Replay a categorical (templateId 2) creation log. */
function replayCategorical(log, outcomesOf) {
  const rows = read(log);
  let checked = 0;
  for (const row of rows) {
    const label = row.shortName ?? row.id;

    // 1. the encoded question string, byte for byte
    const encoded = encodeQuestionWithOutcomes(row.marketName, outcomesOf(row), "misc", "en_US");
    assert.equal(encoded, row.encodedQuestion, `${label}: encodedQuestion`);

    // 2. the id derived from it
    const id = computeQuestionId({
      templateId: TEMPLATE.CATEGORICAL,
      openingTime: row.openingTime,
      encodedQuestion: encoded,
      minBond: row.minBond,
      ...OPTIMISM,
    });
    assert.equal(id, row.realityQuestionId, `${label}: realityQuestionId`);
    checked++;
  }
  return checked;
}

describe("golden: Reality question ids (the unrecoverable one)", () => {
  it("zcash-q3: 37 binary categoricals reproduce exactly", () => {
    // The factory appends "Invalid result", but the ENCODED question carries only
    // the user outcomes. Take them from the log's own outcomes array minus the
    // factory's slot, which is also a check that the slot is where we think.
    const n = replayCategorical("create-zcash-markets-execution.json", (row) => {
      assert.equal(row.outcomes[row.outcomes.length - 1], "Invalid result", "factory slot is last");
      return row.outcomes.slice(0, -1);
    });
    assert.equal(n, 37);
    console.log(`      ${n} question ids reproduced exactly`);
  });

  it("zcash-nu7 v3: 5 n-outcome categoricals reproduce exactly", () => {
    const n = replayCategorical("create-zcash-nu7-markets-v3-execution.json", (row) => {
      assert.equal(row.outcomes[row.outcomes.length - 1], "Invalid result", "factory slot is last");
      return row.outcomes.slice(0, -1);
    });
    assert.equal(n, 5);
    console.log(`      ${n} question ids reproduced exactly`);
  });

  it("originality-r3: the uint (templateId 1) parent and 98 children reproduce exactly", () => {
    // This log records only the resulting ids, not the encoded text — so the
    // question has to be RECONSTRUCTED, which also checks the multi-scalar name
    // rule the manifest states: one question per outcome, built as
    // questionStart + outcome + questionEnd.
    const doc = read("create-originality-r3-v2-execution.json");
    const m = read("lifecycle/originality-r3.json");
    const parentSpec = m.markets.find((x) => x.role === "parent");
    const minBond = ethersParse(parentSpec.minBondEth);
    const base = { templateId: TEMPLATE.UINT, openingTime: doc.openingTime, minBond, ...OPTIMISM };

    let checked = 0;

    // Parent: a multi-scalar asks one Reality question per outcome.
    assert.equal(doc.parent.questionsIds.length, doc.parent.outcomes.length, "one question per outcome");
    doc.parent.outcomes.forEach((outcome, i) => {
      const question = `${parentSpec.questionStart}${outcome}${parentSpec.questionEnd}`;
      const encoded = encodeQuestionWithoutOutcomes(question, "misc", "en_US");
      // A uint question carries NO outcome list — the divergence that makes this
      // a separate encoder rather than a flag on the other one.
      assert.equal(encoded.split(SEP).length, 3, `parent[${i}]: uint question has 3 fields`);
      assert.ok(!encoded.includes('"'), `parent[${i}]: must not embed outcomes`);
      assert.equal(
        computeQuestionId({ ...base, encodedQuestion: encoded }),
        doc.parent.questionsIds[i],
        `parent outcome ${outcome}: questionId`
      );
      checked++;
    });

    // Children: each scalar asks one question, its marketName verbatim. The log
    // records the CTF questionId rather than the Reality id, so this exercises
    // BOTH derivations end to end — Reality id, then the hash binding it to the
    // market's outcome count, template and bounds.
    const childSpec = m.markets.find((x) => x.role === "child");
    for (const child of doc.children) {
      const encoded = encodeQuestionWithoutOutcomes(child.marketName, "misc", "en_US");
      const realityId = computeQuestionId({ ...base, encodedQuestion: encoded });
      const marketQuestionId = computeMarketQuestionId({
        questionsIds: [realityId],
        outcomeCount: 2, // DOWN, UP — before the factory's Invalid slot
        templateId: TEMPLATE.UINT,
        lowerBound: childSpec.lowerBound,
        upperBound: childSpec.upperBound,
      });
      assert.equal(marketQuestionId, child.questionId, `${child.repo}: questionId`);
      checked++;
    }

    assert.equal(checked, 3 + 98);
    console.log(`      ${checked} uint question ids reproduced exactly (3 parent + 98 children)`);
  });

  it("every encoded question round-trips its own recorded text", () => {
    // Guards the separator itself: U+241F, not a tab, not a pipe.
    for (const log of ["create-zcash-markets-execution.json", "create-zcash-nu7-markets-v3-execution.json"]) {
      for (const row of read(log)) {
        const parts = row.encodedQuestion.split(SEP);
        assert.equal(parts.length, 4, `${log}: categorical question has 4 fields`);
        assert.equal(parts[0], row.marketName);
        assert.equal(parts[2], "misc");
        assert.equal(parts[3], "en_US");
      }
    }
  });
});

describe("lib/reality.js guards", () => {
  it("rejects text Reality cannot carry", () => {
    assert.equal(checkQuestionText("q", "a normal question?").length, 0);
    assert.equal(checkQuestionText("q", 'has a " quote').length, 1);
    assert.equal(checkQuestionText("q", "has a \\ backslash").length, 1);
    assert.equal(checkQuestionText("q", `has a ${SEP} separator`).length, 1);
    assert.equal(checkQuestionText("q", "").length, 1);
  });

  it("rejects an ERC20 name toString31 would revert on", () => {
    assert.equal(checkTokenName("ZQ3ZEBRACONSENSUSYES").length, 0); // 20 bytes, the real longest
    assert.equal(checkTokenName("A".repeat(31)).length, 0);
    assert.equal(checkTokenName("A".repeat(32)).length, 1);
    // Bytes, not characters: a multi-byte character can blow the limit early.
    assert.equal(checkTokenName("é".repeat(16)).length, 1);
  });

  it("computeQuestionId refuses to guess a missing field", () => {
    assert.throws(
      () => computeQuestionId({ templateId: 2, openingTime: 1, encodedQuestion: "x", arbitrator: OPTIMISM.arbitrator }),
      /missing/
    );
  });

  it("the two encoders differ in exactly the outcome list", () => {
    const withOut = encodeQuestionWithOutcomes("Q?", ["Yes", "No"], "misc", "en_US");
    const without = encodeQuestionWithoutOutcomes("Q?", "misc", "en_US");
    assert.equal(withOut, `Q?${SEP}"Yes","No"${SEP}misc${SEP}en_US`);
    assert.equal(without, `Q?${SEP}misc${SEP}en_US`);
  });
});
