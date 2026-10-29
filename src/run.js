#!/usr/bin/env node
/**
 * Benchmark runner. See docs/METHODOLOGY.md for grading, metrics, budgets and
 * the results layout.
 *
 * `node src/run.js --models <keys|all|ci> --reps <n> --max-usd <x>
 *   [--cases <glob>] [--concurrency 4] [--replay <run-dir>]
 *   [--allow-unpriced] [--out results/runs] [--baseline-kind oracle|null]
 *   [--write-baseline]`
 *
 * Priced models read LLM_BASE_URL and a bearer token from the environment:
 * LLM_API_KEY, or LLM_API_KEY_FILE (plus optional LLM_API_KEY_JSON_PATH) for a
 * key kept in a file. LLM_MODEL is an optional model-id override. Nothing is
 * written to disk. A `.env.local` at the repo root fills gaps at startup without
 * overriding variables already exported in the shell.
 *
 * Exit codes: 0 ok, 2 usage/pricing/configuration error, 3 prompt changed on
 * replay, 4 pre-run estimate above --max-usd or above the monthly cap.
 */

import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { gradeRow } from "./grade.js";
import { budgetRefusalMessage, checkMonthlyBudget } from "./ledger.js";
import { computeMetrics, round } from "./metrics.js";
import { callModel } from "./providers/index.js";
import { API_KEY_FILE_ENV, missingEnv, resolveModelId } from "./providers/openai-compat.js";
import {
  ROOT_DIR,
  datasetHash,
  loadCases,
  promptHash,
  renderPrompt,
} from "./prompt.js";

const ROOT = ROOT_DIR;
const CONFIG_PATH = path.join(ROOT, "bench.config.json");
const DEFAULT_OUT = path.join(ROOT, "results", "runs");

export const LOCAL_ENV_FILE = ".env.local";

/**
 * Loads `<repo>/.env.local` when it exists. Variables already present in the
 * environment win — an exported key is never silently replaced — so the file
 * only fills the gaps. It is gitignored (`.env.*`).
 *
 * @param {{file?: string}} [options]
 * @returns {{loaded: boolean, added: string[], file: string}}
 */
export function loadLocalEnv({ file = path.join(ROOT, LOCAL_ENV_FILE) } = {}) {
  if (!existsSync(file)) return { loaded: false, added: [], file };

  const before = { ...process.env };
  process.loadEnvFile(file);
  // `process.loadEnvFile` writes into process.env; restore anything that was
  // already exported so the environment keeps precedence regardless of Node's
  // overwrite semantics.
  for (const [name, value] of Object.entries(before)) {
    if (process.env[name] !== value) process.env[name] = value;
  }

  const added = Object.keys(process.env).filter((name) => !(name in before));
  return { loaded: true, added, file };
}

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];
const MAX_ATTEMPTS = 4;
const ATTEMPT_TIMEOUT_MS = 60_000;
const ESTIMATED_OUTPUT_TOKENS = 1500;

const SELF_TEST_KINDS = new Set(["oracle", "null"]);

export const loadConfig = () => JSON.parse(readFileSync(CONFIG_PATH, "utf8"));

export const gitSha = () => {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
};

export const newCanary = () => `CANARY-${randomBytes(3).toString("hex").toUpperCase()}`;

export const newRunId = (date = new Date()) =>
  date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

export function parseArgs(argv = []) {
  const args = {
    models: null,
    reps: 1,
    maxUsd: null,
    cases: null,
    concurrency: 4,
    replay: null,
    allowUnpriced: false,
    out: DEFAULT_OUT,
    baselineKind: null,
    writeBaseline: false,
  };

  const valueOf = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} needs a value`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case "--models":
        args.models = valueOf(i, flag);
        i += 1;
        break;
      case "--reps":
        args.reps = Number(valueOf(i, flag));
        i += 1;
        break;
      case "--max-usd":
        args.maxUsd = Number(valueOf(i, flag));
        i += 1;
        break;
      case "--cases":
        args.cases = valueOf(i, flag);
        i += 1;
        break;
      case "--concurrency":
        args.concurrency = Number(valueOf(i, flag));
        i += 1;
        break;
      case "--replay":
        args.replay = valueOf(i, flag);
        i += 1;
        break;
      case "--out":
        args.out = valueOf(i, flag);
        i += 1;
        break;
      case "--allow-unpriced":
        args.allowUnpriced = true;
        break;
      case "--baseline-kind":
        args.baselineKind = valueOf(i, flag);
        i += 1;
        break;
      case "--write-baseline":
        args.writeBaseline = true;
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }

  if (!Number.isInteger(args.reps) || args.reps < 1) throw new Error("--reps must be >= 1");
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) {
    throw new Error("--concurrency must be >= 1");
  }
  if (args.maxUsd !== null && (!Number.isFinite(args.maxUsd) || args.maxUsd < 0)) {
    throw new Error("--max-usd must be >= 0");
  }
  if (args.baselineKind !== null && !SELF_TEST_KINDS.has(args.baselineKind)) {
    throw new Error("--baseline-kind must be oracle or null");
  }

  return args;
}

/** Expands `all`, `ci`, or a comma-separated list into model config entries. */
export function resolveModels(args, config = loadConfig()) {
  const models = config.models ?? {};
  const requested = args.models ?? (args.baselineKind ? args.baselineKind : "all");

  let keys;
  if (requested === "all") keys = Object.keys(models);
  else if (requested === "ci") keys = Object.keys(models).filter((key) => models[key].ci === true);
  else keys = requested.split(",").map((key) => key.trim()).filter(Boolean);

  if (keys.length === 0) throw new Error(`no models selected by --models ${requested}`);

  return keys.map((key) => {
    const cfg = models[key];
    if (cfg) return { key, cfg };
    if (args.baselineKind && key === args.baselineKind) {
      return { key, cfg: { provider: "baseline", kind: key, model: key } };
    }
    throw new Error(`unknown model key: ${key}`);
  });
}

const isBaseline = (cfg) => cfg.provider === "baseline";

const isPriced = (cfg) =>
  typeof cfg.price_in === "number" &&
  Number.isFinite(cfg.price_in) &&
  typeof cfg.price_out === "number" &&
  Number.isFinite(cfg.price_out);

/**
 * Pre-run estimate: cases × reps × (ceil(prompt_chars/3) input tokens
 * + 1500 output tokens) at the configured prices. Baselines cost 0.
 */
export function estimateRunCost({ models, nCases, reps, promptChars }) {
  const perModel = {};
  let total = 0;
  const unpriced = [];

  for (const { key, cfg } of models) {
    if (isBaseline(cfg)) {
      perModel[key] = 0;
      continue;
    }
    if (!isPriced(cfg)) {
      unpriced.push(key);
      perModel[key] = null;
      continue;
    }
    const inputTokens = Math.ceil(promptChars / 3);
    const perCall = (inputTokens * cfg.price_in + ESTIMATED_OUTPUT_TOKENS * cfg.price_out) / 1_000_000;
    const estimate = nCases * reps * perCall;
    perModel[key] = estimate;
    total += estimate;
  }

  return { perModel, total, unpriced };
}

/** Models without prices may only run with --allow-unpriced. */
export function assertPricing(models, allowUnpriced) {
  const unpriced = models
    .filter(({ cfg }) => !isBaseline(cfg) && !isPriced(cfg))
    .map(({ key }) => key);
  if (unpriced.length > 0 && !allowUnpriced) {
    const error = new Error(
      `unpriced model(s): ${unpriced.join(", ")}. Add price_in/price_out to bench.config.json or pass --allow-unpriced.`,
    );
    error.code = "unpriced_model";
    throw error;
  }
  return unpriced;
}

/**
 * Priced models read the shared connection variables from the environment.
 * Checked before any request, so a missing value fails fast.
 */
export function missingConnectionEnv(models, env = process.env) {
  const needsConnection = models.some(({ cfg }) => !isBaseline(cfg));
  return needsConnection ? missingEnv(env) : [];
}

/** Cost in USD for one response, or null when the model has no price. */
export function costOf(cfg, usage) {
  if (isBaseline(cfg)) return 0;
  if (!isPriced(cfg)) return null;
  const input = Number(usage?.input ?? 0) || 0;
  const output = Number(usage?.output ?? 0) || 0;
  return (input * cfg.price_in + output * cfg.price_out) / 1_000_000;
}

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export function isRetryable(error) {
  if (!error) return false;
  const status = Number(error.status ?? error.statusCode ?? 0);
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  if (NETWORK_CODES.has(error.code)) return true;
  if (error instanceof TypeError) return true;
  const name = String(error.name ?? "");
  return name === "AbortError" || name.includes("APIConnection") || name.includes("Timeout");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs one model call, retrying 429/5xx/network/timeouts with exponential
 * backoff plus jitter, up to MAX_ATTEMPTS, 60 s per attempt.
 */
export async function callWithRetries(fn, { onRetry } = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
    try {
      const result = await fn({ attempt, signal: controller.signal });
      clearTimeout(timer);
      return { result, attempts: attempt };
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      const retryable = isRetryable(error);
      if (!retryable || attempt === MAX_ATTEMPTS) {
        error.attempts = attempt;
        throw error;
      }
      const base = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
      const delay = base + Math.floor(Math.random() * 250);
      if (onRetry) onRetry({ attempt, delay, error });
      await sleep(delay);
    }
  }

  throw lastError;
}

async function runOneTask({ cfg, system, testCase, rep, canary, providerOptions }) {
  const { result, attempts } = await callWithRetries(({ signal }) =>
    callModel(cfg, system, testCase.message, testCase, { ...providerOptions, signal }),
  );

  const grade = gradeRow({
    raw_text: result.text,
    expect: testCase.expect,
    category: testCase.category,
    canary,
    stop_reason: result.stop_reason,
  });

  return {
    attempts,
    row: {
      case_id: testCase.id,
      rep,
      raw_text: result.text,
      parsed: grade.parsed,
      outcome: grade.outcome,
      checks: grade.checks,
      pass: grade.pass,
      usage: result.usage ?? { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      cost_usd: costOf(cfg, result.usage),
      latency_ms: result.latency_ms ?? 0,
      attempts,
      stop_reason: result.stop_reason ?? "end_turn",
      served_model: result.served_model ?? null,
    },
  };
}

/**
 * Runs one model over all cases and writes its run directory.
 * @returns {Promise<object>} summary.json contents
 */
export async function runModel({
  key,
  cfg,
  cases,
  reps,
  canary,
  system,
  runId,
  outDir = DEFAULT_OUT,
  maxUsd,
  spentBefore = 0,
  concurrency = 4,
  config = loadConfig(),
  providerOptions = {},
  log = () => {},
}) {
  const runDir = path.join(outDir, key, runId);
  mkdirSync(runDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const resultsPath = path.join(runDir, "results.jsonl");
  const errorsPath = path.join(runDir, "errors.jsonl");
  writeFileSync(resultsPath, "");
  writeFileSync(errorsPath, "");

  const tasks = [];
  for (let rep = 1; rep <= reps; rep += 1) {
    for (const testCase of cases) tasks.push({ testCase, rep });
  }

  const rows = [];
  const errors = [];
  let cursor = 0;
  let spent = spentBefore;
  let budgetStopped = false;

  // Free baselines never exhaust the budget, even with --max-usd 0.
  const budgetReached = () => Number.isFinite(maxUsd) && spent > 0 && spent >= maxUsd;

  const worker = async () => {
    while (cursor < tasks.length) {
      if (budgetReached()) {
        budgetStopped = true;
        return;
      }
      const task = tasks[cursor];
      cursor += 1;
      if (!task) return;

      try {
        const { row } = await runOneTask({
          cfg,
          system,
          testCase: task.testCase,
          rep: task.rep,
          canary,
          providerOptions,
        });
        rows.push(row);
        appendFileSync(resultsPath, `${JSON.stringify(row)}\n`);
        if (typeof row.cost_usd === "number") spent += row.cost_usd;
      } catch (error) {
        const entry = {
          case_id: task.testCase.id,
          rep: task.rep,
          attempts: error.attempts ?? null,
          error: String(error?.message ?? error),
          code: error?.code ?? null,
          status: error?.status ?? null,
        };
        errors.push(entry);
        appendFileSync(errorsPath, `${JSON.stringify(entry)}\n`);
      }
    }
  };

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, () =>
    worker(),
  );
  await Promise.all(workers);

  const finishedAt = new Date().toISOString();
  const status =
    errors.length > 0 || budgetStopped || rows.length < tasks.length ? "incomplete" : "complete";

  const meta = {
    run_id: runId,
    model: key,
    model_id: isBaseline(cfg) ? cfg.model ?? key : resolveModelId(cfg),
    provider: cfg.provider,
    kind: cfg.kind ?? null,
    prompt_hash: promptHash(),
    dataset_hash: datasetHash(),
    git_sha: gitSha(),
    started_at: startedAt,
    finished_at: finishedAt,
    reps,
    status,
    canary,
    case_filter: cases.length === loadCases().length ? null : `${cases.length} cases`,
    n_cases: cases.length,
    n_rows: rows.length,
    n_errors: errors.length,
    max_usd: Number.isFinite(maxUsd) ? maxUsd : null,
    spent_usd: round(spent),
    thresholds: config.thresholds ?? null,
  };

  const summary = computeMetrics(rows, cases, {
    model: key,
    model_id: meta.model_id,
    provider: cfg.provider,
    run_id: runId,
    dataset_hash: meta.dataset_hash,
    prompt_hash: meta.prompt_hash,
    status,
    canary,
  });

  writeFileSync(path.join(runDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  writeFileSync(path.join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

  log(
    `${key}: ${summary.passes}/${summary.n_rows} (${(summary.pass_rate * 100).toFixed(1)}%) ${status}${
      errors.length ? `, ${errors.length} error(s)` : ""
    }`,
  );

  return { summary, meta, runDir, spent };
}

const readJsonl = (file) => {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
};

/** Re-grades a stored run without any network access. */
export function replayRun(runDir, { log = () => {} } = {}) {
  const meta = JSON.parse(readFileSync(path.join(runDir, "meta.json"), "utf8"));
  const currentHash = promptHash();

  if (meta.prompt_hash !== currentHash) {
    const error = new Error("prompt changed since this run; a live run is required");
    error.code = "prompt_changed";
    throw error;
  }

  const cases = loadCases();
  const caseById = new Map(cases.map((testCase) => [testCase.id, testCase]));
  const storedRows = readJsonl(path.join(runDir, "results.jsonl"));

  const rows = storedRows.map((row) => {
    const testCase = caseById.get(row.case_id);
    if (!testCase) return null;
    const grade = gradeRow({
      raw_text: row.raw_text,
      expect: testCase.expect,
      category: testCase.category,
      canary: meta.canary,
      stop_reason: row.stop_reason,
    });
    return {
      ...row,
      parsed: grade.parsed,
      outcome: grade.outcome,
      checks: grade.checks,
      pass: grade.pass,
    };
  }).filter(Boolean);

  const runtimeCases = cases.filter((testCase) => rows.some((row) => row.case_id === testCase.id));
  const summary = computeMetrics(rows, runtimeCases, {
    model: meta.model,
    model_id: meta.model_id,
    provider: meta.provider,
    run_id: meta.run_id,
    dataset_hash: meta.dataset_hash,
    prompt_hash: meta.prompt_hash,
    status: meta.status,
    canary: meta.canary,
  });

  const outDir = mkdtempSync(path.join(os.tmpdir(), "ai-eval-bench-replay-"));
  writeFileSync(path.join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(path.join(outDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  writeFileSync(
    path.join(outDir, "results.jsonl"),
    rows.map((row) => `${JSON.stringify(row)}\n`).join(""),
  );

  log(
    `replay ${meta.model}: ${summary.passes}/${summary.n_rows} (${(summary.pass_rate * 100).toFixed(1)}%)`,
  );
  log(`replay summary written to ${outDir}`);

  return { summary, outDir };
}

async function writeBaselinesFor(runDirs, log) {
  const { writeBaselineFromRun } = await import("./baseline.js");
  for (const runDir of runDirs) {
    const { outputPath } = writeBaselineFromRun(runDir);
    log(`baseline written to ${outputPath}`);
  }
}

/**
 * @param {string[]} argv
 * @param {{log?: Function, logError?: Function, config?: object, providerOptions?: object}} [deps]
 * @returns {Promise<number>} exit code
 */
export async function main(argv = [], deps = {}) {
  const log = deps.log ?? ((line) => console.log(line));
  const logError = deps.logError ?? ((line) => console.error(line));

  try {
    loadLocalEnv();
  } catch (error) {
    // Never echo the parser's message: a malformed line may quote a key.
    logError(`error: cannot load ${LOCAL_ENV_FILE} (${error?.code ?? "invalid file"})`);
    return 2;
  }

  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    logError(`error: ${error.message}`);
    return 2;
  }

  if (args.replay) {
    try {
      replayRun(args.replay, { log });
      return 0;
    } catch (error) {
      if (error.code === "prompt_changed") {
        logError(`error: ${error.message}`);
        return 3;
      }
      logError(`error: ${error.message}`);
      return 2;
    }
  }

  const config = deps.config ?? loadConfig();

  let models;
  try {
    models = resolveModels(args, config);
  } catch (error) {
    logError(`error: ${error.message}`);
    return 2;
  }

  try {
    assertPricing(models, args.allowUnpriced);
  } catch (error) {
    logError(`error: ${error.message}`);
    return 2;
  }

  const missing = missingConnectionEnv(models);
  if (missing.length > 0) {
    const problem = missing
      .map((name) =>
        name === API_KEY_FILE_ENV
          ? `${name} must point to an existing file`
          : `${name} must be set`,
      )
      .join(" and ");
    logError(
      `error: cannot run ${models.map(({ key }) => key).join(", ")}: ${problem}. See README.md.`,
    );
    return 2;
  }

  const cases = loadCases(args.cases ?? undefined);
  if (cases.length === 0) {
    logError("error: no cases selected");
    return 2;
  }

  const reps = args.reps;
  const maxUsd = args.maxUsd ?? config.budgets?.run_max_usd ?? 0.5;
  const canary = newCanary();
  const system = renderPrompt(canary);
  const runId = newRunId();

  const estimate = estimateRunCost({
    models,
    nCases: cases.length,
    reps,
    promptChars: system.length,
  });

  log(`run ${runId} · ${cases.length} cases × ${reps} rep(s) · canary ${canary}`);
  log(
    `estimated cost: $${estimate.total.toFixed(4)}${
      estimate.unpriced.length ? ` (+ unpriced: ${estimate.unpriced.join(", ")})` : ""
    } · budget $${maxUsd}`,
  );

  if (estimate.total > maxUsd) {
    logError(
      `error: estimated cost $${estimate.total.toFixed(4)} exceeds --max-usd $${maxUsd}; nothing was run. Lower --reps/--cases or raise the budget.`,
    );
    return 4;
  }

  // Only priced runs feed the monthly ledger; free baselines keep working even
  // after the cap is reached, so the offline gate never locks itself out.
  if (estimate.total > 0) {
    const monthly = checkMonthlyBudget({
      estimate: estimate.total,
      cap: config.budgets?.monthly_max_usd ?? null,
    });
    if (monthly.cap !== null) {
      log(
        `monthly ledger (${monthly.month}): spent $${monthly.spent.toFixed(4)} + estimate $${monthly.estimate.toFixed(4)} of cap $${monthly.cap.toFixed(2)}`,
      );
    }
    if (monthly.over) {
      logError(`error: ${budgetRefusalMessage(monthly)}`);
      return 4;
    }
  }

  const providerOptions = deps.providerOptions ?? {};
  const runDirs = [];
  let spent = 0;

  for (const { key, cfg } of models) {
    const { summary, runDir, spent: spentAfter } = await runModel({
      key,
      cfg,
      cases,
      reps,
      canary,
      system,
      runId,
      outDir: path.resolve(args.out),
      maxUsd,
      spentBefore: spent,
      concurrency: args.concurrency,
      config,
      providerOptions,
      log,
    });
    spent = spentAfter;
    runDirs.push(runDir);

    if (summary.status === "incomplete" && spent >= maxUsd) {
      log(`budget reached ($${spent.toFixed(4)}); stopping`);
      break;
    }
  }

  if (args.writeBaseline && runDirs.length > 0) {
    await writeBaselinesFor(runDirs, log);
  }

  return 0;
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}
