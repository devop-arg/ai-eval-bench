import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertPricing,
  estimateRunCost,
  loadLocalEnv,
  missingConnectionEnv,
  parseArgs,
  resolveModels,
} from "../src/run.js";
import { API_KEY_ENV, API_KEY_FILE_ENV, BASE_URL_ENV } from "../src/providers/openai-compat.js";

const tempDir = () => mkdtempSync(path.join(os.tmpdir(), "ai-eval-bench-env-"));

const config = {
  models: {
    priced: { provider: "openai-compat", model: "m", price_in: 1, price_out: 2, ci: true },
    unpriced: { provider: "openai-compat", model: "d", price_in: null, price_out: null, ci: true },
    rules: { provider: "baseline", kind: "rules" },
  },
  thresholds: { max_drop_pp: 3 },
  budgets: { run_max_usd: 0.5, monthly_max_usd: 0.5 },
};

test("run: budget estimate follows cases × reps × (ceil(chars/3) in + 1500 out)", () => {
  const estimate = estimateRunCost({
    models: [{ key: "priced", cfg: config.models.priced }],
    nCases: 10,
    reps: 2,
    promptChars: 3001,
  });

  // ceil(3001/3) = 1001 input tokens; (1001*1 + 1500*2) / 1e6 per call; 20 calls.
  const expected = (20 * (1001 + 3000)) / 1_000_000;
  assert.ok(Math.abs(estimate.total - expected) < 1e-12, `${estimate.total} != ${expected}`);
  assert.equal(estimate.unpriced.length, 0);
});

test("run: baselines cost nothing and unpriced models are reported", () => {
  const estimate = estimateRunCost({
    models: [
      { key: "rules", cfg: config.models.rules },
      { key: "unpriced", cfg: config.models.unpriced },
    ],
    nCases: 100,
    reps: 1,
    promptChars: 5000,
  });

  assert.equal(estimate.perModel.rules, 0);
  assert.equal(estimate.perModel.unpriced, null);
  assert.equal(estimate.total, 0);
  assert.deepEqual(estimate.unpriced, ["unpriced"]);
});

test("run: an unpriced model is refused unless --allow-unpriced", () => {
  const models = resolveModels({ models: "unpriced" }, config);
  assert.throws(
    () => assertPricing(models, false),
    (error) => error.code === "unpriced_model" && /--allow-unpriced/.test(error.message),
  );
  assert.deepEqual(assertPricing(models, true), ["unpriced"]);
});

test("run: --models all and ci expand from the config", () => {
  assert.deepEqual(
    resolveModels({ models: "all" }, config).map((entry) => entry.key),
    ["priced", "unpriced", "rules"],
  );
  assert.deepEqual(
    resolveModels({ models: "ci" }, config).map((entry) => entry.key),
    ["priced", "unpriced"],
  );
});

test("run: --baseline-kind exposes oracle/null outside the config", () => {
  const models = resolveModels({ models: null, baselineKind: "oracle" }, config);
  assert.deepEqual(models, [{ key: "oracle", cfg: { provider: "baseline", kind: "oracle", model: "oracle" } }]);
  assert.throws(() => resolveModels({ models: "gpt-x" }, config), /unknown model key/);
});

test("run: priced models need LLM_BASE_URL and LLM_API_KEY before any request", () => {
  const priced = resolveModels({ models: "priced" }, config);
  assert.deepEqual(missingConnectionEnv(priced, {}), [BASE_URL_ENV, API_KEY_ENV]);
  assert.deepEqual(missingConnectionEnv(priced, { [BASE_URL_ENV]: "https://x.test" }), [API_KEY_ENV]);
  assert.deepEqual(
    missingConnectionEnv(priced, { [BASE_URL_ENV]: "https://x.test", [API_KEY_ENV]: "k" }),
    [],
  );

  const baselines = resolveModels({ models: "rules" }, config);
  assert.deepEqual(missingConnectionEnv(baselines, {}), [], "free baselines need no connection");
});

test("run: a key file satisfies the connection pre-flight without being read", () => {
  const dir = tempDir();
  try {
    const keyFile = path.join(dir, "key.txt");
    // Deliberately not parseable: the pre-flight only checks the variable and
    // that the file exists, it never opens it.
    writeFileSync(keyFile, "not valid json {\n");
    const priced = resolveModels({ models: "priced" }, config);

    assert.deepEqual(
      missingConnectionEnv(priced, { [BASE_URL_ENV]: "https://x.test", [API_KEY_FILE_ENV]: keyFile }),
      [],
      "LLM_API_KEY_FILE pointing at an existing file is enough",
    );
    assert.deepEqual(
      missingConnectionEnv(priced, {
        [BASE_URL_ENV]: "https://x.test",
        [API_KEY_FILE_ENV]: path.join(dir, "absent.txt"),
      }),
      [API_KEY_FILE_ENV],
      "a path that does not exist is reported against the file variable",
    );
    assert.deepEqual(
      missingConnectionEnv(priced, { [BASE_URL_ENV]: "https://x.test", [API_KEY_ENV]: "k" }),
      [],
      "LLM_API_KEY still satisfies the check on its own",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: .env.local fills gaps but never overrides the environment", () => {
  const dir = tempDir();
  const file = path.join(dir, ".env.local");
  const addedName = "AI_EVAL_BENCH_TEST_FROM_FILE";
  const saved = { ...process.env };
  try {
    writeFileSync(file, `${BASE_URL_ENV}=https://from-file.test\n${addedName}=from-file\n`);

    process.env[BASE_URL_ENV] = "https://from-env.test";
    delete process.env[addedName];

    const result = loadLocalEnv({ file });
    assert.equal(result.loaded, true);
    assert.equal(process.env[BASE_URL_ENV], "https://from-env.test", "the environment wins");
    assert.equal(process.env[addedName], "from-file", "missing variables are filled from the file");
    assert.ok(result.added.includes(addedName));
    assert.ok(!result.added.includes(BASE_URL_ENV), "existing variables are not reported as added");

    const absent = loadLocalEnv({ file: path.join(dir, "absent.env.local") });
    assert.equal(absent.loaded, false, "an absent file is not an error");
  } finally {
    for (const name of Object.keys(process.env)) {
      if (!(name in saved)) delete process.env[name];
    }
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: CLI defaults and validation", () => {
  const args = parseArgs(["--models", "rules", "--reps", "2", "--max-usd", "0"]);
  assert.equal(args.models, "rules");
  assert.equal(args.reps, 2);
  assert.equal(args.maxUsd, 0);
  assert.equal(args.concurrency, 4);
  assert.equal(args.allowUnpriced, false);

  assert.throws(() => parseArgs(["--reps", "0"]), /--reps/);
  assert.throws(() => parseArgs(["--nope"]), /unknown flag/);
  assert.throws(() => parseArgs(["--models"]), /needs a value/);
});
