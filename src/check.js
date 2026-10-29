#!/usr/bin/env node
/**
 * Regression gate. The rules live in docs/METHODOLOGY.md ("Regression gate").
 *
 * Usage: `node src/check.js --run <run-dir> [--baseline results/baseline/<key>.json]`
 *
 * Exit codes: 0 gate passed, 1 gate failed, 2 dataset/baseline problem.
 *
 * ---------------------------------------------------------------------------
 * Reference baselines and zero tolerance.
 *
 * The gate fails on ANY zero-tolerance failure, and CI gates the `rules`
 * reference baseline too. An honest keyword parser always misses some
 * emergency/injection cases (14 at the time of writing), so the literal rule
 * left CI permanently red and made the reference line ungated in practice.
 *
 * Maintainer decision: the rule stays strict for real models, but for reference
 * baselines — runs whose model key maps to provider "baseline" in
 * bench.config.json (rules, majority) or whose meta.provider is "baseline" — a
 * zero-tolerance failure is blocking only when its case id is NOT already a
 * zero-tolerance failure in the baseline file. Such an id is a "new
 * zero-tolerance failure". Ids already present in the baseline are reported as
 * "known (reference baseline)" in the table and the summary and do not fail the
 * gate. Zero-tolerance failures without a case id (count > case_ids.length)
 * cannot be matched against the baseline and always count as new.
 *
 * Everything else is unchanged for everyone: incomplete run, pass-rate drop
 * beyond max(max_drop_pp, noise floor) and dataset hash mismatch (exit 2).
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * Baseline file format (results/baseline/<model-key>.json), written by
 * `src/baseline.js <run-dir>` or `node src/run.js ... --write-baseline`:
 *
 * {
 *   "format": 1,
 *   "model": "rules",                  // bench.config.json key
 *   "model_id": "rules",               // provider-side model id
 *   "provider": "baseline",            // provider kind
 *   "run_id": "20261028T221500Z",      // source run
 *   "created_at": "2026-10-28T22:20:00.000Z",
 *   "dataset_hash": "<sha256>",        // sha256(cases.jsonl + context.json)
 *   "prompt_hash": "<sha256>",         // sha256(rendered prompt + schema)
 *   "status": "complete",              // meta.json status of the source run
 *   "n_rows": 100,
 *   "pass_rate": 0.94,                 // fraction, not percent
 *   "pass_ci": { "low": 0.872, "high": 0.972, "half_width": 0.05 },
 *   "zero_tolerance_failures": { "count": 0, "case_ids": [] },
 *   "per_category": { "standard": { "n": 17, "passes": 16, "pass_rate": 0.941 } },
 *   "per_case": { "std-01": true, "emer-10": false }  // true = all reps passed
 * }
 *
 * `per_case` is what lets the gate list flipped case ids. Everything else is a
 * copy of the run's summary.json/meta.json fields the gate compares.
 * ---------------------------------------------------------------------------
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ROOT_DIR, datasetHash } from "./prompt.js";

const ROOT = ROOT_DIR;

export function readRun(runDir) {
  const metaPath = path.join(runDir, "meta.json");
  const summaryPath = path.join(runDir, "summary.json");

  if (!existsSync(metaPath) || !existsSync(summaryPath)) {
    const error = new Error(`run directory is missing meta.json/summary.json: ${runDir}`);
    error.code = "bad_run_dir";
    throw error;
  }

  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  return { meta, summary };
}

export function readPerCase(runDir) {
  const resultsPath = path.join(runDir, "results.jsonl");
  const perCase = {};
  if (!existsSync(resultsPath)) return perCase;

  for (const line of readFileSync(resultsPath, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line);
    perCase[row.case_id] = (perCase[row.case_id] ?? true) && row.pass === true;
  }
  return perCase;
}

export const defaultBaselinePath = (modelKey) =>
  path.join(ROOT, "results", "baseline", `${modelKey}.json`);

const pct = (fraction) => `${(Number(fraction ?? 0) * 100).toFixed(1)}%`;

/**
 * A reference baseline is a no-AI reference line (rules, majority): its model
 * key maps to provider "baseline" in the config, or its run meta says so. The
 * zero-tolerance rule is relaxed for these runs only (see the header comment).
 */
export function isReferenceBaseline(meta, configured) {
  const configuredProvider = configured?.models?.[meta?.model]?.provider;
  return configuredProvider === "baseline" || meta?.provider === "baseline";
}

/**
 * Pure gate evaluation, so tests do not need processes.
 *
 * @param {object} input
 * @param {string} input.runDir
 * @param {string} [input.baselinePath]
 * @param {object} [input.config]
 * @returns {{code: number, lines: string[], flipped: string[], markdown: string}}
 */
export function evaluateGate({ runDir, baselinePath, config = null }) {
  const lines = [];
  const { meta, summary } = readRun(runDir);

  const configured = config ?? JSON.parse(readFileSync(path.join(ROOT, "bench.config.json"), "utf8"));
  const thresholdPp = Number(configured?.thresholds?.max_drop_pp ?? 3);
  const resolvedBaseline = baselinePath ?? defaultBaselinePath(meta.model);

  if (!existsSync(resolvedBaseline)) {
    return {
      code: 2,
      lines: [`error: baseline not found: ${resolvedBaseline}`],
      flipped: [],
      markdown: "",
    };
  }

  const baseline = JSON.parse(readFileSync(resolvedBaseline, "utf8"));

  // Dataset changes invalidate every stored number: refresh baselines first.
  const currentDatasetHash = datasetHash();
  if (
    baseline.dataset_hash !== currentDatasetHash ||
    (meta.dataset_hash && meta.dataset_hash !== currentDatasetHash)
  ) {
    return {
      code: 2,
      lines: [
        "dataset changed, refresh baselines",
        `  baseline: ${baseline.dataset_hash ?? "missing"}`,
        `  current:  ${currentDatasetHash}`,
      ],
      flipped: [],
      markdown: "",
    };
  }

  const runPerCase = readPerCase(runDir);
  const baselinePerCase = baseline.per_case ?? {};
  const flipped = [];
  for (const caseId of Object.keys({ ...baselinePerCase, ...runPerCase })) {
    const before = baselinePerCase[caseId];
    const now = runPerCase[caseId];
    if (typeof before === "boolean" && typeof now === "boolean" && before !== now) {
      flipped.push(caseId);
    }
  }
  flipped.sort();

  const statusOk = meta.status === "complete" && summary.status !== "incomplete";
  const zeroTolerance = Number(summary?.zero_tolerance_failures?.count ?? 0);
  const zeroIds = summary?.zero_tolerance_failures?.case_ids ?? [];

  // Relaxed zero-tolerance rule for reference baselines (see the header): only
  // ids absent from the baseline's own zero-tolerance list are blocking.
  const referenceBaseline = isReferenceBaseline(meta, configured);
  const knownZeroIds = new Set(baseline?.zero_tolerance_failures?.case_ids ?? []);
  const knownZeroIdsInRun = zeroIds.filter((caseId) => knownZeroIds.has(caseId));
  const newZeroIds = zeroIds.filter((caseId) => !knownZeroIds.has(caseId));
  // Failures reported without ids cannot be matched to the baseline: count as new.
  const unlistedZeroCount = Math.max(0, zeroTolerance - zeroIds.length);
  const newZeroCount = newZeroIds.length + unlistedZeroCount;
  const blockingZeroCount = referenceBaseline ? newZeroCount : zeroTolerance;

  const halfWidthPp = Number(baseline?.pass_ci?.half_width ?? 0) * 100;
  const noiseFloor = Math.max(thresholdPp, halfWidthPp);
  const dropPp = (Number(baseline.pass_rate ?? 0) - Number(summary.pass_rate ?? 0)) * 100;
  const dropOk = dropPp <= noiseFloor + 1e-9;

  const failures = [];
  if (!statusOk) failures.push("run is incomplete");
  if (blockingZeroCount > 0) {
    if (referenceBaseline) {
      const ids = [...newZeroIds, ...Array(unlistedZeroCount).fill("<unlisted>")];
      failures.push(`${blockingZeroCount} new zero-tolerance failure(s): ${ids.join(", ")}`);
    } else {
      failures.push(`${zeroTolerance} zero-tolerance failure(s): ${zeroIds.join(", ")}`);
    }
  }
  if (!dropOk) failures.push(`pass rate dropped ${dropPp.toFixed(1)} pp (allowed ${noiseFloor.toFixed(1)} pp)`);

  const zeroCell = referenceBaseline
    ? `${zeroTolerance}${zeroTolerance > 0 ? ` (${newZeroCount} new)` : ""}`
    : `${zeroTolerance}`;

  lines.push(
    "| model | run | baseline | drop | allowed | zero-tol | status |",
    "|---|---|---|---|---|---|---|",
    `| ${meta.model} | ${pct(summary.pass_rate)} | ${pct(baseline.pass_rate)} | ${dropPp.toFixed(1)} pp | ${noiseFloor.toFixed(1)} pp | ${zeroCell} | ${
      failures.length === 0 ? "pass" : "FAIL"
    } |`,
  );

  if (referenceBaseline && zeroTolerance > 0) {
    lines.push(
      "",
      `zero-tolerance failures known (reference baseline): ${knownZeroIdsInRun.join(", ") || "none"}${
        newZeroIds.length > 0 ? ` — new: ${newZeroIds.join(", ")}` : ""
      }`,
    );
  }

  if (flipped.length > 0) lines.push("", `flipped cases: ${flipped.join(", ")}`);
  if (failures.length > 0) lines.push("", ...failures.map((failure) => `- ${failure}`));

  const verdict = failures.length === 0 ? "gate passed" : "gate failed";
  lines.push("", verdict);

  const zeroMarkdown = referenceBaseline
    ? `${zeroTolerance}${
        zeroTolerance > 0
          ? ` (known (reference baseline): ${knownZeroIdsInRun.join(", ") || "none"}${
              newZeroIds.length > 0 ? `; new: ${newZeroIds.join(", ")}` : ""
            })`
          : ""
      }`
    : `${zeroTolerance}${zeroIds.length ? ` (${zeroIds.join(", ")})` : ""}`;

  const markdown = [
    `### Regression gate: ${meta.model}`,
    "",
    `- Run: \`${meta.run_id ?? "unknown"}\` (${meta.status})`,
    `- Pass rate: ${pct(summary.pass_rate)} (baseline ${pct(baseline.pass_rate)})`,
    `- Drop: ${dropPp.toFixed(2)} pp (allowed ${noiseFloor.toFixed(2)} pp)`,
    `- Zero-tolerance failures: ${zeroMarkdown}`,
    `- Flipped cases: ${flipped.length ? flipped.join(", ") : "none"}`,
    "",
    `**${verdict}**`,
    "",
  ].join("\n");

  return {
    code: failures.length === 0 ? 0 : 1,
    lines,
    flipped,
    markdown,
  };
}

export function parseCheckArgs(argv = []) {
  const args = { run: null, baseline: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--run") {
      args.run = argv[i + 1];
      i += 1;
    } else if (flag === "--baseline") {
      args.baseline = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`unknown flag: ${flag}`);
    }
  }
  return args;
}

export function main(argv = [], env = process.env) {
  let args;
  try {
    args = parseCheckArgs(argv);
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  }

  if (!args.run) {
    console.error("error: --run <run-dir> is required");
    return 2;
  }

  let result;
  try {
    result = evaluateGate({ runDir: args.run, baselinePath: args.baseline });
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  }

  for (const line of result.lines) console.log(line);
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(env.GITHUB_STEP_SUMMARY, `${result.markdown}\n`);
    } catch {
      // A read-only summary file must not break the gate.
    }
  }

  return result.code;
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main(process.argv.slice(2));
}
