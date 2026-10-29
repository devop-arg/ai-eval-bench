#!/usr/bin/env node
/**
 * Replays every committed run under `results/runs/<model-key>/<run-id>/` with
 * the current grader and gates each re-graded copy against
 * `results/baseline/<model-key>.json`. See docs/METHODOLOGY.md.
 *
 *   node src/replay-all.js
 *
 * No network, no writes inside `results/`: `replayRun` writes the re-graded
 * summary to a temporary directory (see `src/run.js`) and that copy is what
 * `src/check.js` reads. Exit codes: 0 all gates passed, 1 at least one gate or
 * replay failed.
 *
 * Special cases:
 * - replay exits 3 when the prompt hash differs from the recorded one. That is
 *   not a regression: it means the stored outputs are stale and a live run is
 *   required. It is reported as a `::notice::` and does not fail the job.
 * - A run whose model key has no baseline is replayed but its gate is skipped
 *   with a `::notice::`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ROOT_DIR } from "./prompt.js";
import { replayRun } from "./run.js";

const RUNS_DIR = path.join(ROOT_DIR, "results", "runs");
const BASELINE_DIR = path.join(ROOT_DIR, "results", "baseline");
const CHECK_SCRIPT = path.join(ROOT_DIR, "src", "check.js");

/** Lists committed runs, oldest first (run ids are sortable ISO timestamps). */
export function listRuns(runsDir = RUNS_DIR) {
  if (!existsSync(runsDir)) return [];

  const subdirs = (dir) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

  const runs = [];
  for (const key of subdirs(runsDir)) {
    const keyDir = path.join(runsDir, key);
    for (const runId of subdirs(keyDir)) {
      const dir = path.join(keyDir, runId);
      // A run directory is only usable once the runner wrote its meta.json.
      if (!existsSync(path.join(dir, "meta.json"))) continue;
      runs.push({ key, runId, dir });
    }
  }
  return runs;
}

const notice = (message) => console.log(`::notice::${message}`);

/**
 * Replays and gates every committed run.
 *
 * @param {{runsDir?: string, baselineDir?: string, log?: Function}} [options]
 * @returns {{code: number, replayed: number, skipped: number, failed: number}}
 */
export function replayAll({ runsDir = RUNS_DIR, baselineDir = BASELINE_DIR, log = console.log } = {}) {
  const runs = listRuns(runsDir);
  if (runs.length === 0) {
    log("::notice::no committed runs under results/runs; nothing to replay");
    return { code: 0, replayed: 0, skipped: 0, failed: 0 };
  }

  let replayed = 0;
  let skipped = 0;
  let failed = 0;

  for (const run of runs) {
    log(`replay ${run.key}/${run.runId}`);

    let replayedRun;
    try {
      replayedRun = replayRun(run.dir, { log: (line) => log(`  ${line}`) });
    } catch (error) {
      if (error.code === "prompt_changed") {
        // Stale outputs, not a regression: a live run has to refresh them.
        notice(`prompt changed since ${run.key}/${run.runId}; a live run is required (see live.yml)`);
        skipped += 1;
        continue;
      }
      log(`::error::replay failed for ${run.key}/${run.runId}: ${error.message}`);
      failed += 1;
      continue;
    }

    replayed += 1;
    const baseline = path.join(baselineDir, `${run.key}.json`);
    if (!existsSync(baseline)) {
      notice(`no baseline for ${run.key}; gate skipped for ${run.runId}`);
      skipped += 1;
      rmSync(replayedRun.outDir, { recursive: true, force: true });
      continue;
    }

    const gate = spawnSync(
      process.execPath,
      [CHECK_SCRIPT, "--run", replayedRun.outDir, "--baseline", baseline],
      { cwd: ROOT_DIR, stdio: "inherit" },
    );
    rmSync(replayedRun.outDir, { recursive: true, force: true });

    if (gate.status !== 0) {
      log(`::error::gate failed for ${run.key}/${run.runId} (exit ${gate.status ?? "signal"})`);
      failed += 1;
    }
  }

  log(`replayed ${replayed} run(s), gate failed for ${failed}, skipped ${skipped}`);
  return { code: failed === 0 ? 0 : 1, replayed, skipped, failed };
}

export function main() {
  return replayAll().code;
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = main();
}
