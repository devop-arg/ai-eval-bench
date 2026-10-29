import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPricing,
  estimateRunCost,
  missingConnectionEnv,
  parseArgs,
  resolveModels,
} from "../src/run.js";
import { API_KEY_ENV, BASE_URL_ENV } from "../src/providers/openai-compat.js";

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
