#!/usr/bin/env node
/**
 * Writes a regression baseline from a finished run (see the format comment at
 * the top of src/check.js).
 *
 * Usage: `node src/baseline.js <run-dir> [--out <file>]`
 * Default output: `results/baseline/<model-key>.json`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readPerCase } from "./check.js";
import { ROOT_DIR, datasetHash } from "./prompt.js";

/**
 * @param {string} runDir
 * @param {{out?: string, now?: Date}} [options]
 * @returns {{outputPath: string, baseline: object}}
 */
export function writeBaselineFromRun(runDir, options = {}) {
  const meta = JSON.parse(readFileSync(path.join(runDir, "meta.json"), "utf8"));
  const summary = JSON.parse(readFileSync(path.join(runDir, "summary.json"), "utf8"));
  const perCase = readPerCase(runDir);

  const baseline = {
    format: 1,
    model: meta.model,
    model_id: meta.model_id ?? null,
    provider: meta.provider ?? null,
    run_id: meta.run_id ?? null,
    created_at: (options.now ?? new Date()).toISOString(),
    dataset_hash: meta.dataset_hash ?? datasetHash(),
    prompt_hash: meta.prompt_hash ?? null,
    status: meta.status,
    n_rows: summary.n_rows,
    pass_rate: summary.pass_rate,
    pass_ci: summary.pass_ci,
    zero_tolerance_failures: summary.zero_tolerance_failures,
    per_category: summary.per_category,
    per_case: perCase,
  };

  const outputPath = path.resolve(
    options.out ?? path.join(ROOT_DIR, "results", "baseline", `${meta.model}.json`),
  );
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(baseline, null, 2)}\n`);

  return { outputPath, baseline };
}

export function main(argv = []) {
  const positional = [];
  let out = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") {
      out = argv[i + 1];
      i += 1;
    } else {
      positional.push(argv[i]);
    }
  }

  const runDir = positional[0];
  if (!runDir) {
    console.error("usage: node src/baseline.js <run-dir> [--out <file>]");
    return 2;
  }

  try {
    const { outputPath, baseline } = writeBaselineFromRun(runDir, { out });
    console.log(
      `baseline ${baseline.model}: ${(baseline.pass_rate * 100).toFixed(1)}% -> ${outputPath}`,
    );
    return 0;
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 1;
  }
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main(process.argv.slice(2));
}
