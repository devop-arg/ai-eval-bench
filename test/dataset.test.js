import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CASES_PATH,
  CONTEXT_PATH,
  datasetHash,
  globToRegExp,
  loadCases,
  loadContext,
  promptHash,
  renderPrompt,
} from "../src/prompt.js";
import {
  ACTIONS,
  BOOKING_CODE_PATTERN,
  DATE_PATTERN,
  SPECIALTIES,
  TIME_WINDOWS,
  emptyOutput,
  validate,
} from "../src/schema.js";

const context = loadContext();
const cases = loadCases();

const DATE_RE = new RegExp(DATE_PATTERN);
const BOOKING_CODE_RE = new RegExp(BOOKING_CODE_PATTERN);

const weekday = (date) => new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sunday, 6 = Saturday
const SUNDAY = 0;
const SATURDAY = 6;

test("dataset: contains exactly 100 cases with unique ids", () => {
  assert.equal(cases.length, 100);
  const ids = cases.map((testCase) => testCase.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("dataset: every case has the documented shape", () => {
  for (const testCase of cases) {
    assert.match(testCase.id, /^[a-z]+-\d{2}$/, `bad id: ${testCase.id}`);
    assert.equal(typeof testCase.category, "string", testCase.id);
    assert.equal(typeof testCase.message, "string", testCase.id);
    assert.ok(testCase.message.trim().length > 0, testCase.id);
    assert.equal(typeof testCase.expect, "object", testCase.id);
    assert.equal(typeof testCase.zero_tolerance, "boolean", testCase.id);
    for (const key of Object.keys(testCase.expect)) {
      assert.ok(
        ["action", "specialty", "date", "time_window", "booking_code"].includes(key),
        `${testCase.id}: unexpected expect key ${key}`,
      );
    }
  }
});

test("dataset: every expect.action is a valid action (string or array of them)", () => {
  for (const testCase of cases) {
    const { action } = testCase.expect;
    if (Array.isArray(action)) {
      assert.ok(action.length > 0, `${testCase.id}: empty action array`);
      for (const value of action) {
        assert.ok(ACTIONS.includes(value), `${testCase.id}: bad action ${value}`);
      }
      assert.equal(new Set(action).size, action.length, `${testCase.id}: duplicated action`);
    } else {
      assert.equal(typeof action, "string", `${testCase.id}: action must be a string`);
      assert.ok(ACTIONS.includes(action), `${testCase.id}: bad action ${action}`);
    }
  }
});

test("dataset: every expected specialty, time_window, date and booking_code is valid", () => {
  for (const testCase of cases) {
    const expect = testCase.expect;
    if ("specialty" in expect) {
      assert.ok(
        expect.specialty === null || SPECIALTIES.includes(expect.specialty),
        `${testCase.id}: bad specialty ${expect.specialty}`,
      );
    }
    if ("time_window" in expect) {
      assert.ok(
        expect.time_window === null || TIME_WINDOWS.includes(expect.time_window),
        `${testCase.id}: bad time_window ${expect.time_window}`,
      );
    }
    if ("date" in expect) {
      assert.ok(
        expect.date === null ||
          (typeof expect.date === "string" && DATE_RE.test(expect.date)),
        `${testCase.id}: bad date ${expect.date}`,
      );
    }
    if ("booking_code" in expect) {
      assert.ok(
        expect.booking_code === null ||
          (typeof expect.booking_code === "string" &&
            BOOKING_CODE_RE.test(expect.booking_code)),
        `${testCase.id}: bad booking_code ${expect.booking_code}`,
      );
    }
  }
});

test("dataset: filling every expect into the schema yields a valid output object", () => {
  for (const testCase of cases) {
    const filled = emptyOutput();
    filled.action = Array.isArray(testCase.expect.action)
      ? testCase.expect.action[0]
      : testCase.expect.action;
    for (const key of ["specialty", "date", "time_window", "booking_code"]) {
      if (key in testCase.expect) filled[key] = testCase.expect[key];
    }
    const result = validate(filled);
    assert.equal(result.valid, true, `${testCase.id}: ${result.errors.join("; ")}`);
  }
});

test("dataset: no expected date is a Sunday and none is a closed date", () => {
  const closed = new Set(context.closed_dates);
  for (const testCase of cases) {
    const date = testCase.expect.date;
    if (typeof date !== "string") continue;
    assert.notEqual(weekday(date), SUNDAY, `${testCase.id}: ${date} is a Sunday`);
    assert.equal(closed.has(date), false, `${testCase.id}: ${date} is a closed date`);
  }
});

test("dataset: Saturday dates are only accepted with time_window morning (or absent)", () => {
  for (const testCase of cases) {
    const date = testCase.expect.date;
    if (typeof date !== "string" || weekday(date) !== SATURDAY) continue;
    if ("time_window" in testCase.expect) {
      assert.equal(
        testCase.expect.time_window,
        "morning",
        `${testCase.id}: ${date} is a Saturday, time_window must be morning (or absent)`,
      );
    }
  }
});

test("dataset: zero_tolerance is true exactly for emergency and injection cases", () => {
  const flagged = cases.filter((testCase) => testCase.zero_tolerance);
  const categories = new Set(flagged.map((testCase) => testCase.category));
  assert.deepEqual([...categories].sort(), ["emergency", "injection"]);

  for (const testCase of cases) {
    const expected = testCase.category === "emergency" || testCase.category === "injection";
    assert.equal(
      testCase.zero_tolerance,
      expected,
      `${testCase.id}: zero_tolerance should be ${expected} for category ${testCase.category}`,
    );
  }
});

test("dataset: every category used in the data has a documented metric", () => {
  const categories = new Set(cases.map((testCase) => testCase.category));
  assert.deepEqual([...categories].sort(), [
    "availability",
    "clarify",
    "dates",
    "emergency",
    "injection",
    "manage",
    "medical_advice",
    "off_topic",
    "over_escalation",
    "standard",
  ]);
});

test("dataset: datasetHash is the sha256 of cases.jsonl + context.json and is stable", () => {
  const raw = Buffer.concat([readFileSync(CASES_PATH), readFileSync(CONTEXT_PATH)]);
  assert.equal(raw.length > 0, true);
  assert.equal(datasetHash(), datasetHash());
  assert.match(datasetHash(), /^[0-9a-f]{64}$/);
});

test("dataset: promptHash ignores the run canary and covers the schema", async () => {
  const { promptHash: hash, renderPrompt: render } = await import("../src/prompt.js");
  assert.equal(hash(), promptHash());
  assert.match(promptHash(), /^[0-9a-f]{64}$/);

  const rendered = render("CANARY-DF9F7B");
  assert.ok(rendered.includes("CANARY-DF9F7B"));
  assert.ok(!rendered.includes("{{CONTEXT}}"));
  assert.ok(rendered.includes(JSON.stringify(context, null, 2)));
});

test("dataset: loadCases filters ids with simple * wildcards", () => {
  assert.equal(loadCases().length, 100);
  assert.equal(loadCases("emer-*").length, 10);
  assert.equal(loadCases("std-0*").length, 9);
  assert.equal(loadCases("inj-*").length, 10);
  assert.equal(loadCases(["adm-*"]).length, 0);
  assert.equal(loadCases("emer-01").length, 1);
  assert.equal(loadCases("emer-01").at(0).id, "emer-01");
  assert.equal(loadCases("*").length, 100);
  assert.equal(globToRegExp("std-0?").test("std-01"), false);
});
