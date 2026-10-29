import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildReport, escapeHtml, latestRun } from "../src/report.js";
import { ROOT_DIR, loadCases } from "../src/prompt.js";

const tempDir = (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ai-eval-bench-report-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const SUMMARY = (overrides = {}) => ({
  model: "fixture",
  pass_rate: 0.44,
  pass_ci: { low: 0.35, high: 0.54, half_width: 0.096 },
  n_rows: 1,
  status: "complete",
  zero_tolerance_failures: { count: 0, case_ids: [] },
  per_category: { standard: { n: 1, passes: 1, pass_rate: 1 } },
  abstention: { precision: 0.5, recall: 0.9 },
  escalation_recall: 0.3,
  over_escalation_rate: 0.02,
  injection_resistance: 0.3,
  latency_ms: { p50: 120, p95: 300 },
  cost_per_100_tasks: 0.25,
  ...overrides,
});

/** Writes results/runs/<key>/<runId>/{meta,summary,results}.jsonl under `root`. */
const writeRun = (root, { key, runId, status = "complete", summary = {}, rows = [] }) => {
  const dir = path.join(root, "results", "runs", key, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({
      run_id: runId,
      model: key,
      model_id: key,
      provider: "openai-compat",
      status,
      finished_at: "2026-11-02T13:00:00.000Z",
      dataset_hash: "a".repeat(64),
      prompt_hash: "b".repeat(64),
    }),
  );
  writeFileSync(
    path.join(dir, "summary.json"),
    JSON.stringify(SUMMARY({ model: key, status, n_rows: rows.length, ...summary })),
  );
  writeFileSync(
    path.join(dir, "results.jsonl"),
    rows.map((row) => `${JSON.stringify(row)}\n`).join(""),
  );
  return dir;
};

const row = (caseId, rawText, { pass = false, category = "standard" } = {}) => ({
  case_id: caseId,
  rep: 1,
  raw_text: rawText,
  parsed: null,
  outcome: pass ? "ok" : "invalid_output",
  checks: { action: pass, fields: {}, canary: true },
  pass,
  usage: { input: 10, output: 10 },
  cost_usd: 0.0001,
  latency_ms: 120,
  attempts: 1,
  stop_reason: "end_turn",
  served_model: "fixture",
});

test("report: builds the seven sections from the committed rules run", (t) => {
  const dir = tempDir(t);
  const outFile = path.join(dir, "site", "index.html");
  const { html, models } = buildReport({ outFile });

  assert.ok(models.length >= 1, "expected at least one model row");
  assert.ok(models.some((model) => model.key === "rules" && model.reference));

  for (const id of [
    "header",
    "leaderboard",
    "scatter",
    "matrix",
    "explorer",
    "methodology",
    "footer",
  ]) {
    assert.ok(html.includes(`id="${id}"`), `missing section #${id}`);
  }

  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes("Front-desk intake benchmark"));
  assert.ok(html.includes("Benchmark de recepción médica"));
  assert.ok(html.includes("https://github.com/devop-arg/ai-eval-bench"));
  assert.ok(html.includes("https://dev0p.com"));
  assert.ok(html.includes("bench-lang"));
  assert.ok(html.includes('type="application/json"'));
  assert.ok(!html.includes("<script src"), "no external scripts allowed");
  assert.ok(!html.includes("../src"), "no repository internals leaked");
  assert.ok(!/\bsk-/.test(html), "no API keys may appear in the report");
  assert.ok(!/LLM_API_KEY|LLM_BASE_URL/.test(html), "env var names must not leak");

  // The embedded explorer payload must stay parseable JSON.
  const payload = html.match(
    /<script id="explorer-data" type="application\/json">([\s\S]*?)<\/script>/,
  );
  assert.ok(payload, "explorer JSON block missing");
  const parsed = JSON.parse(payload[1]);
  assert.ok(Array.isArray(parsed.rows) && parsed.rows.length > 0);
  assert.ok(Array.isArray(parsed.cases) && parsed.cases.length > 0);

  // Written file matches the returned markup.
  assert.equal(readFileSync(outFile, "utf8"), html);
});

test("report: picks the latest complete run and falls back to older complete ones", (t) => {
  const root = tempDir(t);
  const newer = "20261103T000000Z";
  const older = "20261102T000000Z";
  writeRun(root, { key: "demo", runId: older, status: "complete", rows: [row("std-01", "{}")] });
  writeRun(root, { key: "demo", runId: newer, status: "incomplete", rows: [] });

  const run = latestRun(path.join(root, "results", "runs"), "demo");
  assert.equal(run.runId, older);
  assert.equal(run.meta.status, "complete");
});

test("report: escapes malicious model output in markup and in the JSON block", (t) => {
  const root = tempDir(t);
  const payload = '<img src=x onerror=alert(1)> </script><script>alert("x")</script>';
  const [firstCase] = loadCases();
  writeRun(root, {
    key: "evil",
    runId: "20261102T000000Z",
    summary: { cost_per_100_tasks: null, per_category: { [firstCase.category]: { n: 1, passes: 0, pass_rate: 0 } } },
    rows: [row(firstCase.id, payload)],
  });

  const outFile = path.join(root, "site", "index.html");
  const { html } = buildReport({
    rootDir: root,
    outFile,
    config: { models: { evil: { provider: "openai-compat", model: "evil" } } },
  });

  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"), "raw_text must be HTML-escaped");
  assert.ok(!html.includes(payload), "raw untrusted text must never reach the markup");
  assert.ok(!html.includes("<img src=x"), "no injected element may survive");
  assert.equal(
    html.match(/<\/script>/g)?.length,
    html.match(/<script/g)?.length,
    "script tags must stay balanced (no breakout from the JSON block)",
  );

  const json = html.match(
    /<script id="explorer-data" type="application\/json">([\s\S]*?)<\/script>/,
  )[1];
  assert.ok(!json.includes("</script"), "JSON block must escape `</`");
  assert.ok(json.includes("\\u003c"), "JSON block must escape `<`");
  assert.equal(JSON.parse(json).rows[0].reps[0].raw, payload);

  // Models without a configured price show n/a for cost.
  assert.ok(html.includes("n/a"));
});

test("report: only models with a run or a reference baseline are listed", (t) => {
  const root = tempDir(t);
  writeRun(root, { key: "demo", runId: "20261102T000000Z", rows: [row("std-01", "{}", { pass: true })] });

  const { html, models } = buildReport({
    rootDir: root,
    config: {
      models: {
        demo: { provider: "openai-compat", model: "demo" },
        "never-run": { provider: "openai-compat", model: "never-run" },
      },
    },
  });

  assert.deepEqual(
    models.map((model) => model.key),
    ["demo"],
  );
  assert.ok(html.includes("never-run"), "configured but unrun models are named in the note");
  assert.ok(!html.includes('data-model="never-run"'));
});

test("escapeHtml: covers the five markup characters", () => {
  assert.equal(
    escapeHtml(`<a href="x">'&'</a>`),
    "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
  );
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(42), "42");
});

test("report: committed rules run is the reference row in every section", () => {
  const { html } = buildReport({ rootDir: ROOT_DIR });
  assert.ok(html.includes('class="ref-tag"'), "reference rows must be tagged");
  assert.ok(html.includes("44.0% ±9.6"), "pass rate with Wilson half-width");
  assert.ok(html.includes("Cost vs. pass rate"));
});
