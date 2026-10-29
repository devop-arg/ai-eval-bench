/**
 * Monthly spending ledger.
 *
 * Priced runs cost real money, so the runner refuses to start when the current
 * UTC calendar month is already close to `budgets.monthly_max_usd`.
 *
 * The ledger reads every run under `results/runs/<model-key>/<run-id>/` and
 * keeps the ones whose `meta.json` `started_at` falls in the current UTC month.
 * A run's cost is `summary.json` `total_cost_usd` when it is a finite number
 * (the priced case) and the sum of `results.jsonl` `cost_usd` rows otherwise.
 * Only committed runs feed the ledger; runs written elsewhere (`--out`) do not,
 * which is why CI-only runs are published as artifacts instead.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { ROOT_DIR } from "./prompt.js";

export const LEDGER_ROOT = path.join(ROOT_DIR, "results", "runs");

/** `YYYY-MM` in UTC. */
export const monthKey = (date = new Date()) =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;

/** True when an ISO timestamp belongs to the same UTC calendar month as `now`. */
export function inMonth(isoTimestamp, now = new Date()) {
  const date = new Date(isoTimestamp ?? "");
  if (Number.isNaN(date.getTime())) return false;
  return monthKey(date) === monthKey(now);
}

const readJson = (file) => {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

const isCost = (value) => typeof value === "number" && Number.isFinite(value);

/** Cost in USD of one run directory, never negative. */
export function runCost(runDir) {
  const summary = readJson(path.join(runDir, "summary.json"));
  if (isCost(summary?.total_cost_usd)) return summary.total_cost_usd;

  const resultsPath = path.join(runDir, "results.jsonl");
  if (!existsSync(resultsPath)) return 0;

  let sum = 0;
  for (const line of readFileSync(resultsPath, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let row = null;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (isCost(row?.cost_usd)) sum += row.cost_usd;
  }
  return sum;
}

const subdirs = (dir) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
};

/**
 * Runs started in the UTC month of `now`.
 * @param {{runsRoot?: string, now?: Date}} [options]
 * @returns {{key: string, runId: string, dir: string, meta: object, cost_usd: number}[]}
 */
export function monthRuns({ runsRoot = LEDGER_ROOT, now = new Date() } = {}) {
  const runs = [];
  for (const key of subdirs(runsRoot)) {
    const keyDir = path.join(runsRoot, key);
    for (const runId of subdirs(keyDir)) {
      const dir = path.join(keyDir, runId);
      const meta = readJson(path.join(dir, "meta.json"));
      if (!meta || !inMonth(meta.started_at, now)) continue;
      runs.push({ key, runId, dir, meta, cost_usd: runCost(dir) });
    }
  }
  return runs;
}

/** Total USD spent on runs started in the UTC month of `now`. */
export function monthlySpent(options = {}) {
  return monthRuns(options).reduce((sum, run) => sum + run.cost_usd, 0);
}

const round = (value) => Number(value.toFixed(6));

/**
 * Decides whether one more priced run fits in the monthly cap.
 *
 * @param {{estimate?: number, cap?: number, now?: Date, runsRoot?: string}} [options]
 * @returns {{spent: number, estimate: number, cap: number|null, month: string, over: boolean}}
 */
export function checkMonthlyBudget({
  estimate = 0,
  cap = null,
  now = new Date(),
  runsRoot = LEDGER_ROOT,
} = {}) {
  const spent = round(monthlySpent({ runsRoot, now }));
  const projected = round(spent + (Number(estimate) || 0));
  const numericCap = Number(cap);
  const limit =
    cap === null || cap === undefined || !Number.isFinite(numericCap) ? null : numericCap;

  return {
    spent,
    estimate: round(Number(estimate) || 0),
    cap: limit,
    month: monthKey(now),
    over: limit !== null && projected > limit + 1e-9,
  };
}

/** One-line refusal message that always shows spent / estimate / cap. */
export function budgetRefusalMessage({ spent, estimate, cap, month }) {
  return `monthly budget exceeded (${month}, UTC): spent $${spent.toFixed(4)} + estimate $${estimate.toFixed(4)} > cap $${Number(cap).toFixed(2)}; nothing was run. Raise budgets.monthly_max_usd or wait for the next month.`;
}
