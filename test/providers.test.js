import assert from "node:assert/strict";
import test from "node:test";

import {
  API_KEY_ENV,
  BASE_URL_ENV,
  MODEL_ENV,
  missingEnv,
  openaiCompatCall,
  resolveModelId,
} from "../src/providers/openai-compat.js";
import { isRetryable } from "../src/run.js";

const SYSTEM = "system prompt";
const MESSAGE = "quiero un turno con cardiología";
const BASE_URL = "https://example.invalid/v1/";

const env = (overrides = {}) => ({
  [BASE_URL_ENV]: BASE_URL,
  [API_KEY_ENV]: "test-key-not-real",
  ...overrides,
});

const okResponse = (overrides = {}) => ({
  ok: true,
  status: 200,
  async json() {
    return {
      model: "fake-model",
      choices: [{ message: { content: '{"action":"book"}' }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 900,
        completion_tokens: 60,
        prompt_cache_hit_tokens: 200,
      },
      ...overrides,
    };
  },
});

test("openai-compat: posts to /chat/completions with bearer auth from the environment", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return okResponse();
  };

  const result = await openaiCompatCall(
    { provider: "openai-compat", model: "fake-model" },
    SYSTEM,
    MESSAGE,
    { fetch: fakeFetch, env: env() },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.invalid/v1/chat/completions");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer test-key-not-real");
  assert.equal(calls[0].init.headers["content-type"], "application/json");

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "fake-model");
  assert.deepEqual(body.messages, [
    { role: "system", content: SYSTEM },
    { role: "user", content: MESSAGE },
  ]);
  assert.deepEqual(body.response_format, { type: "json_object" });

  assert.equal(result.text, '{"action":"book"}');
  assert.deepEqual(result.usage, { input: 900, output: 60, cache_read: 200, cache_write: 0 });
  assert.equal(result.stop_reason, "end_turn");
  assert.equal(result.served_model, "fake-model");
});

test("openai-compat: no provider-specific headers are added", async () => {
  let headers = null;
  const fakeFetch = async (url, init) => {
    headers = init.headers;
    return okResponse();
  };

  await openaiCompatCall(
    { provider: "openai-compat", model: "fake-model" },
    SYSTEM,
    MESSAGE,
    { fetch: fakeFetch, env: env() },
  );

  assert.deepEqual(Object.keys(headers).sort(), ["authorization", "content-type"]);
});

test("openai-compat: LLM_MODEL overrides the configured model id", async () => {
  let body = null;
  const fakeFetch = async (url, init) => {
    body = JSON.parse(init.body);
    return okResponse({ model: "override-model" });
  };

  const result = await openaiCompatCall(
    { provider: "openai-compat", model: "configured-model" },
    SYSTEM,
    MESSAGE,
    { fetch: fakeFetch, env: env({ [MODEL_ENV]: "override-model" }) },
  );

  assert.equal(body.model, "override-model");
  assert.equal(result.served_model, "override-model");
  assert.equal(resolveModelId({ model: "configured-model" }, {}), "configured-model");
});

test("openai-compat: missing connection variables are a configuration error", async () => {
  assert.deepEqual(missingEnv({}), [BASE_URL_ENV, API_KEY_ENV]);
  assert.deepEqual(missingEnv(env({ [API_KEY_ENV]: "  " })), [API_KEY_ENV]);
  assert.deepEqual(missingEnv(env()), []);

  await assert.rejects(
    openaiCompatCall({ model: "fake-model" }, SYSTEM, MESSAGE, { env: {} }),
    (error) => error.code === "missing_connection_env",
  );
});

test("openai-compat: a served model that does not match the request is an infra error", async () => {
  const fakeFetch = async () => okResponse({ model: "some-other-model" });

  await assert.rejects(
    openaiCompatCall({ model: "fake-model" }, SYSTEM, MESSAGE, { fetch: fakeFetch, env: env() }),
    (error) => error.code === "served_model_mismatch",
  );
});

test("openai-compat: length and refusal finish reasons map to graded outcomes", async () => {
  for (const [reason, expected] of [
    ["length", "max_tokens"],
    ["content_filter", "refusal"],
    ["refusal", "refusal"],
    ["stop", "end_turn"],
  ]) {
    const fakeFetch = async () =>
      okResponse({
        choices: [{ message: { content: "{}" }, finish_reason: reason }],
      });
    const result = await openaiCompatCall({ model: "fake-model" }, SYSTEM, MESSAGE, {
      fetch: fakeFetch,
      env: env(),
    });
    assert.equal(result.stop_reason, expected, reason);
  }
});

test("openai-compat: HTTP 429 carries the status and is retryable", async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 429,
    async text() {
      return "slow down";
    },
  });

  await assert.rejects(
    openaiCompatCall({ model: "fake-model" }, SYSTEM, MESSAGE, { fetch: fakeFetch, env: env() }),
    (error) => {
      assert.equal(error.status, 429);
      assert.equal(isRetryable(error), true);
      return true;
    },
  );
});
