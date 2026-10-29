import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  budgetRefusalMessage,
  checkMonthlyBudget,
  inMonth,
  monthKey,
  monthRuns,
  monthlySpent,
  runCost,
} from "../src/ledger.js";

const NOW = new Date("2026-10-29T12:00:00.000Z");

const tempRoot = (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ai-eval-bench-ledger-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/**
 * Writes `results/runs/<key>/<runId>/` under `root`.
 * `summary` may be null (no summary.json), `rows` may be null (no results.jsonl).
 */
const writeRun = (
  root,
  { key = "demo", runId, started_at, summary = undefined, rows = [] },
) => {
  const dir = path.join(root, key, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ run_id: runId, model: key, provider: "openai-compat", started_at }),
  );
  if (summary !== null) {
    writeFileSync(path.join(dir, "summary.json"), JSON.stringify(summary ?? {}));
  }
  if (rows !== null) {
    writeFileSync(
      path.join(dir, "results.jsonl"),
      rows.map((row) => `${JSON.stringify(row)}\n`).join(""),
    );
  }
  return dir;
};

test("ledger: monthKey is UTC and zero-padded", () => {
  assert.equal(monthKey(new Date("2026-01-05T23:59:59.000Z")), "2026-01");
  assert.equal(monthKey(new Date("2026-12-01T00:00:00.000Z")), "2026-12");
  assert.equal(monthKey(NOW), "2026-10");
});

test("ledger: inMonth ignores invalid timestamps and other months", () => {
  assert.equal(inMonth("2026-10-01T00:00:00.000Z", NOW), true);
  assert.equal(inMonth("2026-09-30T23:59:59.000Z", NOW), false);
  assert.equal(inMonth("2026-11-01T00:00:00.000Z", NOW), false);
  assert.equal(inMonth(undefined, NOW), false);
  assert.equal(inMonth("not a date", NOW), false);
});

test("ledger: a run costs its summary total when priced", (t) => {
  const root = tempRoot(t);
  const dir = writeRun(root, {
    runId: "20261028T000000Z",
    started_at: "2026-10-28T00:00:00.000Z",
    summary: { total_cost_usd: 0.123 },
    rows: [{ case_id: "a", cost_usd: 999 }],
  });
  assert.equal(runCost(dir), 0.123);
});

test("ledger: an unpriced summary falls back to the row costs", (t) => {
  const root = tempRoot(t);
  const dir = writeRun(root, {
    runId: "20261028T000000Z",
    started_at: "2026-10-28T00:00:00.000Z",
    summary: { total_cost_usd: null },
    rows: [
      { case_id: "a", cost_usd: 0.02 },
      { case_id: "b", cost_usd: 0.03 },
      { case_id: "c", cost_usd: null },
    ],
  });
  assert.ok(Math.abs(runCost(dir) - 0.05) < 1e-12);
});

test("ledger: only runs started in the current UTC month are summed", (t) => {
  const root = tempRoot(t);
  writeRun(root, {
    key: "demo",
    runId: "20261001T000000Z",
    started_at: "2026-10-01T00:00:00.000Z",
    summary: { total_cost_usd: 0.1 },
  });
  writeRun(root, {
    key: "demo",
    runId: "20261029T000000Z",
    started_at: "2026-10-29T08:00:00.000Z",
    summary: { total_cost_usd: 0.2 },
  });
  writeRun(root, {
    key: "rules",
    runId: "20260930T000000Z",
    started_at: "2026-09-30T23:59:00.000Z",
    summary: { total_cost_usd: 5 },
  });

  const runs = monthRuns({ runsRoot: root, now: NOW });
  assert.deepEqual(
    runs.map((run) => `${run.key}/${run.runId}`),
    ["demo/20261001T000000Z", "demo/20261029T000000Z"],
  );
  assert.ok(Math.abs(monthlySpent({ runsRoot: root, now: NOW }) - 0.3) < 1e-12);
});

test("ledger: directories without meta.json are ignored", (t) => {
  const root = tempRoot(t);
  const dir = path.join(root, "demo", "20261029T999999Z");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ total_cost_usd: 9 }));

  assert.deepEqual(monthRuns({ runsRoot: root, now: NOW }), []);
  assert.equal(monthlySpent({ runsRoot: root, now: NOW }), 0);
});

test("ledger: a missing runs root is zero spend", (t) => {
  const root = path.join(tempRoot(t), "does-not-exist");
  assert.equal(monthlySpent({ runsRoot: root, now: NOW }), 0);
});

test("ledger: the cap compares spent + estimate", (t) => {
  const root = tempRoot(t);
  writeRun(root, {
    runId: "20261020T000000Z",
    started_at: "2026-10-20T00:00:00.000Z",
    summary: { total_cost_usd: 0.4 },
  });

  const fits = checkMonthlyBudget({ estimate: 0.1, cap: 0.5, now: NOW, runsRoot: root });
  assert.equal(fits.spent, 0.4);
  assert.equal(fits.estimate, 0.1);
  assert.equal(fits.cap, 0.5);
  assert.equal(fits.month, "2026-10");
  assert.equal(fits.over, false);

  const over = checkMonthlyBudget({ estimate: 0.11, cap: 0.5, now: NOW, runsRoot: root });
  assert.equal(over.over, true);

  const noCap = checkMonthlyBudget({ estimate: 100, cap: null, now: NOW, runsRoot: root });
  assert.equal(noCap.cap, null);
  assert.equal(noCap.over, false);
});

test("ledger: the refusal message shows spent, estimate and cap", () => {
  const message = budgetRefusalMessage({
    spent: 0.4,
    estimate: 0.11,
    cap: 0.5,
    month: "2026-10",
  });
  assert.match(message, /spent \$0\.4000/);
  assert.match(message, /estimate \$0\.1100/);
  assert.match(message, /cap \$0\.50/);
  assert.match(message, /2026-10/);
  assert.match(message, /nothing was run/);
});
