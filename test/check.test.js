import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { evaluateGate } from "../src/check.js";
import { datasetHash } from "../src/prompt.js";

const CONFIG = { thresholds: { max_drop_pp: 3 } };
const REFERENCE_CONFIG = {
  thresholds: { max_drop_pp: 3 },
  models: { rules: { provider: "baseline", kind: "rules" } },
};

/**
 * Builds a throwaway run directory + baseline file.
 * `perCase` maps case id -> boolean (current run).
 * `zero` is the run's zero-tolerance case ids; `baseline.zero` the ones stored
 * in the baseline file (defaults to none).
 */
function makeFixture(
  t,
  { status = "complete", passRate = 0.9, zero = [], perCase, baseline, model = "rules", provider = undefined },
) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ai-eval-bench-check-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const runDir = path.join(dir, "run");
  mkdirSync(runDir, { recursive: true });

  writeFileSync(
    path.join(runDir, "meta.json"),
    JSON.stringify({
      run_id: "20260101T000000Z",
      model,
      ...(provider ? { provider } : {}),
      status,
      dataset_hash: datasetHash(),
    }),
  );
  writeFileSync(
    path.join(runDir, "summary.json"),
    JSON.stringify({
      model,
      status,
      pass_rate: passRate,
      pass_ci: { low: passRate, high: passRate, half_width: 0 },
      zero_tolerance_failures: { count: zero.length, case_ids: zero },
    }),
  );
  writeFileSync(
    path.join(runDir, "results.jsonl"),
    Object.entries(perCase)
      .map(([caseId, pass]) => JSON.stringify({ case_id: caseId, rep: 1, pass }))
      .join("\n") + "\n",
  );

  const baselinePath = path.join(dir, "baseline.json");
  const baselineZero = baseline.zero ?? [];
  writeFileSync(
    path.join(baselinePath),
    JSON.stringify({
      format: 1,
      model,
      dataset_hash: baseline.datasetHash ?? datasetHash(),
      pass_rate: baseline.passRate ?? 0.9,
      pass_ci: { low: 0.85, high: 0.95, half_width: baseline.halfWidth ?? 0.05 },
      zero_tolerance_failures: { count: baselineZero.length, case_ids: baselineZero },
      per_case: baseline.perCase ?? {},
    }),
  );

  return { runDir, baselinePath };
}

test("check: fails when the run is incomplete", (t) => {
  const fixture = makeFixture(t, {
    status: "incomplete",
    perCase: { "std-01": true },
    baseline: { perCase: { "std-01": true } },
  });
  const result = evaluateGate({ runDir: fixture.runDir, baselinePath: fixture.baselinePath, config: CONFIG });
  assert.equal(result.code, 1);
  assert.ok(result.lines.some((line) => line.includes("incomplete")));
});

test("check: real model fails on zero-tolerance even when the baseline has the same ids", (t) => {
  const fixture = makeFixture(t, {
    model: "deepseek-v4.1-flash",
    provider: "openai-compat",
    zero: ["emer-10"],
    perCase: { "emer-10": false },
    baseline: { zero: ["emer-10"], perCase: { "emer-10": false } },
  });
  const result = evaluateGate({ runDir: fixture.runDir, baselinePath: fixture.baselinePath, config: CONFIG });
  assert.equal(result.code, 1);
  assert.ok(result.lines.some((line) => line.includes("zero-tolerance")));
  assert.deepEqual(result.flipped, []);
});

test("check: reference baseline (config provider) passes with its known zero-tolerance ids", (t) => {
  const fixture = makeFixture(t, {
    model: "rules",
    zero: ["emer-10", "inj-01"],
    perCase: { "emer-10": false, "inj-01": false, "std-01": true },
    baseline: { zero: ["emer-10", "inj-01"], perCase: { "emer-10": false, "inj-01": false, "std-01": true } },
  });
  const result = evaluateGate({
    runDir: fixture.runDir,
    baselinePath: fixture.baselinePath,
    config: REFERENCE_CONFIG,
  });
  assert.equal(result.code, 0);
  assert.deepEqual(result.flipped, []);
  assert.ok(result.lines.some((line) => line.includes("known (reference baseline)")));
});

test("check: reference baseline detected from meta.provider also passes with known ids", (t) => {
  const fixture = makeFixture(t, {
    model: "majority",
    provider: "baseline",
    zero: ["inj-01"],
    perCase: { "inj-01": false },
    baseline: { zero: ["inj-01"], perCase: { "inj-01": false } },
  });
  const result = evaluateGate({ runDir: fixture.runDir, baselinePath: fixture.baselinePath, config: CONFIG });
  assert.equal(result.code, 0);
});

test("check: reference baseline fails on a new zero-tolerance id", (t) => {
  const fixture = makeFixture(t, {
    model: "rules",
    zero: ["emer-10", "inj-02"],
    perCase: { "emer-10": false, "inj-02": false },
    baseline: { zero: ["emer-10"], perCase: { "emer-10": false, "inj-02": true } },
  });
  const result = evaluateGate({
    runDir: fixture.runDir,
    baselinePath: fixture.baselinePath,
    config: REFERENCE_CONFIG,
  });
  assert.equal(result.code, 1);
  assert.ok(result.lines.some((line) => line.includes("new zero-tolerance failure(s): inj-02")));
  assert.deepEqual(result.flipped, ["inj-02"]);
});

test("check: fails when the drop is beyond max(max_drop_pp, noise floor)", (t) => {
  const fixture = makeFixture(t, {
    passRate: 0.8,
    perCase: { "std-01": false },
    baseline: { passRate: 0.9, halfWidth: 0.02, perCase: { "std-01": true } },
  });
  const result = evaluateGate({ runDir: fixture.runDir, baselinePath: fixture.baselinePath, config: CONFIG });
  assert.equal(result.code, 1);
  assert.ok(result.lines.some((line) => line.includes("pass rate dropped")));
});

test("check: a drop inside the noise floor passes", (t) => {
  const fixture = makeFixture(t, {
    passRate: 0.86,
    perCase: { "std-01": true },
    baseline: { passRate: 0.9, halfWidth: 0.05, perCase: { "std-01": true } },
  });
  const result = evaluateGate({ runDir: fixture.runDir, baselinePath: fixture.baselinePath, config: CONFIG });
  assert.equal(result.code, 0);
  assert.deepEqual(result.flipped, []);
});

test("check: dataset hash mismatch exits 2 and asks to refresh baselines", (t) => {
  const fixture = makeFixture(t, {
    perCase: { "std-01": true },
    baseline: { datasetHash: "0".repeat(64), perCase: { "std-01": true } },
  });
  const result = evaluateGate({ runDir: fixture.runDir, baselinePath: fixture.baselinePath, config: CONFIG });
  assert.equal(result.code, 2);
  assert.ok(result.lines[0].includes("dataset changed, refresh baselines"));
});

test("check: healthy run gates green", (t) => {
  const fixture = makeFixture(t, {
    passRate: 0.93,
    perCase: { "std-01": true, "std-02": true },
    baseline: { passRate: 0.9, halfWidth: 0.03, perCase: { "std-01": true, "std-02": true } },
  });
  const result = evaluateGate({ runDir: fixture.runDir, baselinePath: fixture.baselinePath, config: CONFIG });
  assert.equal(result.code, 0);
  assert.equal(result.flipped.length, 0);
  assert.ok(result.markdown.includes("Regression gate"));
});
