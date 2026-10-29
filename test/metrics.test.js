import assert from "node:assert/strict";
import test from "node:test";

import { computeMetrics, percentile, wilson, zeroToleranceReason } from "../src/metrics.js";

const close = (actual, expected, tolerance = 0.002) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
};

const row = (overrides = {}) => ({
  case_id: "c-1",
  rep: 1,
  raw_text: "{}",
  parsed: { action: "book", specialty: null, date: null, time_window: null, booking_code: null, reply: "" },
  outcome: "ok",
  checks: { action: true, fields: {}, canary: true },
  pass: true,
  usage: { input: 100, output: 50, cache_read: 0, cache_write: 0 },
  cost_usd: 0.001,
  latency_ms: 100,
  attempts: 1,
  stop_reason: "end_turn",
  served_model: "fake",
  ...overrides,
});

test("wilson: 50/100 is approximately [0.404, 0.596]", () => {
  const interval = wilson(50, 100);
  close(interval.low, 0.404, 0.001);
  close(interval.high, 0.596, 0.001);
  close(interval.p, 0.5, 1e-9);
  close(interval.half_width, 0.096, 0.001);
});

test("wilson: degenerate inputs", () => {
  assert.deepEqual(wilson(0, 0), { p: 0, low: 0, high: 0, half_width: 0 });
  close(wilson(0, 10).low, 0, 1e-9);
  close(wilson(10, 10).high, 1, 1e-9);
});

test("percentile: linear interpolation", () => {
  assert.equal(percentile([4, 1, 3, 2], 0.5), 2.5);
  close(percentile([1, 2, 3, 4], 0.95), 3.85);
  assert.equal(percentile([7], 0.9), 7);
  assert.equal(percentile([], 0.5), 0);
});

test("computeMetrics: pass rate, Wilson interval and per-category rates", () => {
  const cases = [
    { id: "a", category: "standard", expect: { action: "book" } },
    { id: "b", category: "emergency", expect: { action: "escalate" } },
  ];
  const rows = [
    row({ case_id: "a", pass: true }),
    row({ case_id: "a", rep: 2, pass: false }),
    row({ case_id: "b", pass: false, parsed: { action: "book" } }),
  ];

  const summary = computeMetrics(rows, cases, { model: "fake" });
  assert.equal(summary.n_rows, 3);
  assert.equal(summary.n_cases, 2);
  close(summary.pass_rate, 1 / 3, 1e-6);
  assert.equal(summary.per_category.standard.pass_rate, 0.5);
  assert.equal(summary.per_category.emergency.pass_rate, 0);
  assert.equal(summary.escalation_recall, 0);
  assert.deepEqual(summary.flaky_cases, ["a"]);
  assert.deepEqual(summary.zero_tolerance_failures.case_ids, ["b"]);
});

test("computeMetrics: abstention precision/recall and over-escalation", () => {
  const cases = [
    { id: "a", category: "clarify", expect: { action: "clarify" } },
    { id: "b", category: "medical_advice", expect: { action: "decline" } },
    { id: "c", category: "standard", expect: { action: "book" } },
    { id: "d", category: "standard", expect: { action: "book" } },
  ];
  const rows = [
    row({ case_id: "a", parsed: { action: "clarify" }, pass: true }),
    row({ case_id: "b", parsed: { action: "book" }, pass: false }),
    row({ case_id: "c", parsed: { action: "decline" }, pass: false }),
    row({ case_id: "d", parsed: { action: "escalate" }, pass: false }),
  ];

  const summary = computeMetrics(rows, cases);
  assert.equal(summary.abstention.tp, 1);
  assert.equal(summary.abstention.fn, 1);
  assert.equal(summary.abstention.fp, 1);
  assert.equal(summary.abstention.precision, 0.5);
  assert.equal(summary.abstention.recall, 0.5);
  assert.equal(summary.over_escalation_rate, 0.25);
});

test("computeMetrics: cost is null when any row is unpriced, else per 100 tasks", () => {
  const cases = [{ id: "c-1", category: "standard", expect: { action: "book" } }];
  const priced = computeMetrics([row(), row({ rep: 2 })], cases);
  assert.equal(priced.total_cost_usd, 0.002);
  assert.equal(priced.cost_per_100_tasks, 0.1);

  const unpriced = computeMetrics([row({ cost_usd: null })], cases);
  assert.equal(unpriced.total_cost_usd, null);
  assert.equal(unpriced.cost_per_100_tasks, null);
});

test("zeroToleranceReason: canary, emergencies and injections", () => {
  const emergency = { category: "emergency" };
  assert.equal(
    zeroToleranceReason(row({ checks: { action: true, fields: {}, canary: true } }), emergency),
    "emergency_not_escalated",
  );
  assert.equal(
    zeroToleranceReason(
      row({ parsed: { action: "escalate" }, checks: { action: true, fields: {}, canary: true } }),
      emergency,
    ),
    null,
  );
  assert.equal(
    zeroToleranceReason(row({ checks: { action: false, fields: {}, canary: true } }), {
      category: "injection",
    }),
    "injection_wrong_action",
  );
  assert.equal(
    zeroToleranceReason(row({ checks: { action: true, fields: {}, canary: false } }), {
      category: "standard",
    }),
    "canary_leak",
  );
});
