#!/usr/bin/env node
/**
 * Harness self-test. Runs the two reference baselines in-process:
 * `oracle` must score 100% and `null` must score 0% with every row
 * `invalid_output`. No files, no network.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

import { gradeRow } from "./grade.js";
import { computeMetrics } from "./metrics.js";
import { loadCases, renderPrompt } from "./prompt.js";
import { baselineCall } from "./providers/baselines.js";

const CANARY = "CANARY-SELFTEST";

export function runSelfTest() {
  const cases = loadCases();
  const results = {};

  for (const kind of ["oracle", "null"]) {
    const rows = cases.map((testCase) => {
      const response = baselineCall(kind, testCase);
      const grade = gradeRow({
        raw_text: response.text,
        expect: testCase.expect,
        category: testCase.category,
        canary: CANARY,
        stop_reason: response.stop_reason,
      });
      return {
        case_id: testCase.id,
        rep: 1,
        raw_text: response.text,
        parsed: grade.parsed,
        outcome: grade.outcome,
        checks: grade.checks,
        pass: grade.pass,
        usage: response.usage,
        cost_usd: 0,
        latency_ms: 0,
        attempts: 1,
        stop_reason: response.stop_reason,
        served_model: response.served_model,
      };
    });

    results[kind] = computeMetrics(rows, cases, { model: kind });
  }

  const failures = [];
  if (results.oracle.pass_rate !== 1) {
    failures.push(`oracle pass rate is ${(results.oracle.pass_rate * 100).toFixed(1)}%, expected 100%`);
  }
  if (results.null.pass_rate !== 0) {
    failures.push(`null pass rate is ${(results.null.pass_rate * 100).toFixed(1)}%, expected 0%`);
  }
  if (results.null.invalid_outputs !== results.null.n_rows) {
    failures.push(
      `null produced ${results.null.n_rows - results.null.invalid_outputs} non-invalid_output row(s)`,
    );
  }

  return { results, failures };
}

export function main() {
  // Render the prompt once so a broken template fails here, not in CI later.
  renderPrompt(CANARY);

  const { results, failures } = runSelfTest();
  console.log(
    `oracle: ${results.oracle.passes}/${results.oracle.n_rows} (${(results.oracle.pass_rate * 100).toFixed(1)}%)`,
  );
  console.log(
    `null:   ${results.null.passes}/${results.null.n_rows} (${(results.null.pass_rate * 100).toFixed(1)}%), all invalid_output: ${
      results.null.invalid_outputs === results.null.n_rows ? "yes" : "no"
    }`,
  );

  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL: ${failure}`);
    return 1;
  }

  console.log("selftest passed");
  return 0;
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
