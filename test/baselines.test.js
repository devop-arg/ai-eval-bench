import assert from "node:assert/strict";
import test from "node:test";

import { gradeRow } from "../src/grade.js";
import { baselineCall } from "../src/providers/baselines.js";
import { loadCases } from "../src/prompt.js";
import { validate } from "../src/schema.js";

const CANARY = "CANARY-BASE01";

const gradeBaseline = (kind, testCase) => {
  const response = baselineCall(kind, testCase);
  return {
    response,
    grade: gradeRow({
      raw_text: response.text,
      expect: testCase.expect,
      category: testCase.category,
      canary: CANARY,
      stop_reason: response.stop_reason,
    }),
  };
};

test("baselines: every baseline returns the provider response shape with zero usage", () => {
  const testCase = loadCases().find((entry) => entry.id === "std-01");
  for (const kind of ["oracle", "null", "majority"]) {
    const response = baselineCall(kind, testCase);
    assert.equal(typeof response.text, "string", kind);
    assert.deepEqual(response.usage, { input: 0, output: 0, cache_read: 0, cache_write: 0 }, kind);
    assert.equal(response.served_model, `baseline/${kind}`, kind);
    assert.equal(response.stop_reason, "end_turn", kind);
    assert.equal(response.latency_ms, 0, kind);
    assert.equal("text" in response, true);
  }
});

test("baselines: oracle over all 100 cases scores 100%", () => {
  const cases = loadCases();
  assert.equal(cases.length, 100);

  const failures = [];
  for (const testCase of cases) {
    const { grade } = gradeBaseline("oracle", testCase);
    if (!grade.pass) {
      failures.push({ id: testCase.id, outcome: grade.outcome, checks: grade.checks });
    }
  }

  assert.deepEqual(failures, []);
});

test("baselines: oracle never trips zero tolerance", () => {
  for (const testCase of loadCases()) {
    const { grade } = gradeBaseline("oracle", testCase);
    assert.equal(grade.zero_tolerance_fail, false, testCase.id);
  }
});

test("baselines: null scores 0% with every row invalid_output", () => {
  const cases = loadCases();
  const outcomes = new Set();
  let passed = 0;

  for (const testCase of cases) {
    const { response, grade } = gradeBaseline("null", testCase);
    assert.equal(response.text, "");
    if (grade.pass) passed += 1;
    outcomes.add(grade.outcome);
  }

  assert.equal(passed, 0);
  assert.deepEqual([...outcomes], ["invalid_output"]);
});

test("baselines: majority always books with empty fields", () => {
  const parsed = JSON.parse(baselineCall("majority", loadCases()[0]).text);
  assert.deepEqual(parsed, {
    action: "book",
    specialty: null,
    date: null,
    time_window: null,
    booking_code: null,
    reply: "",
  });
});

test("baselines: rules returns a schema-valid object for every case", () => {
  for (const testCase of loadCases()) {
    const response = baselineCall("rules", testCase);
    const parsed = JSON.parse(response.text);
    const { valid, errors } = validate(parsed);
    assert.equal(valid, true, `${testCase.id}: ${errors.join("; ")}`);
    assert.equal(parsed.reply.length > 0, true, testCase.id);
  }
});

test("baselines: rules is a useful but imperfect reference line", () => {
  const cases = loadCases();
  let passed = 0;

  for (const testCase of cases) {
    const { grade } = gradeBaseline("rules", testCase);
    if (grade.pass) passed += 1;
  }

  const rate = passed / cases.length;
  assert.ok(rate > 0.3, `rules scored ${(rate * 100).toFixed(1)}%, expected more than 30%`);
  assert.ok(rate < 1, "rules must not score 100%: it is a keyword baseline, not the oracle");
});

test("baselines: unknown kinds throw", () => {
  assert.throws(() => baselineCall("gpt", loadCases()[0]), /unknown baseline kind/);
});
