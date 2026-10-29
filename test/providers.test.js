import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  API_KEY_ENV,
  API_KEY_FILE_ENV,
  API_KEY_JSON_PATH_ENV,
  BASE_URL_ENV,
  MODEL_ENV,
  missingEnv,
  openaiCompatCall,
  resolveApiKey,
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

/** Temp dir for fake key files; never points at a real credential. */
const tempDir = () => mkdtempSync(path.join(os.tmpdir(), "ai-eval-bench-key-"));

const withTempDir = (fn) => async () => {
  const dir = tempDir();
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Captures the bearer token the provider sends for one call. */
const authFor = async (callEnv) => {
  let authorization = null;
  const fakeFetch = async (url, init) => {
    authorization = init.headers.authorization;
    return okResponse();
  };
  await openaiCompatCall({ model: "fake-model" }, SYSTEM, MESSAGE, { fetch: fakeFetch, env: callEnv });
  return authorization;
};

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

test(
  "openai-compat: LLM_API_KEY wins over LLM_API_KEY_FILE when both are set",
  withTempDir(async (dir) => {
    const file = path.join(dir, "key.txt");
    writeFileSync(file, "key-from-file\n");

    const authorization = await authFor(
      env({ [API_KEY_ENV]: "key-from-env", [API_KEY_FILE_ENV]: file }),
    );
    assert.equal(authorization, "Bearer key-from-env");
  }),
);

test(
  "openai-compat: a plain key file is trimmed and read on every call, never cached",
  withTempDir(async (dir) => {
    const file = path.join(dir, "key.txt");
    const callEnv = { [BASE_URL_ENV]: BASE_URL, [API_KEY_FILE_ENV]: file };

    writeFileSync(file, "  key-one  \n");
    assert.equal(await authFor(callEnv), "Bearer key-one", "surrounding whitespace is dropped");
    assert.deepEqual(missingEnv(callEnv), [], "the file route satisfies the connection check");

    writeFileSync(file, "key-two\n");
    assert.equal(await authFor(callEnv), "Bearer key-two", "the file is re-read on each call");
  }),
);

test(
  "openai-compat: LLM_API_KEY_JSON_PATH reads a dotted path inside a JSON key file",
  withTempDir(async (dir) => {
    const file = path.join(dir, "key.json");
    writeFileSync(file, JSON.stringify({ provider: { key: "key-from-json" }, note: "fake" }));

    const callEnv = {
      [BASE_URL_ENV]: BASE_URL,
      [API_KEY_FILE_ENV]: file,
      [API_KEY_JSON_PATH_ENV]: "provider.key",
    };
    assert.equal(await authFor(callEnv), "Bearer key-from-json");
    assert.deepEqual(missingEnv(callEnv), []);
  }),
);

test(
  "openai-compat: broken key files fail with missing_connection_env and never echo the value",
  withTempDir(async (dir) => {
    const secret = "fake-secret-should-never-appear";
    const missingFile = path.join(dir, "absent.txt");
    const directoryAsFile = path.join(dir, "a-directory");
    mkdirSync(directoryAsFile);
    const invalidJson = path.join(dir, "invalid.json");
    writeFileSync(invalidJson, `{ ${secret}: 1 `);
    const unknownPath = path.join(dir, "unknown-path.json");
    writeFileSync(unknownPath, JSON.stringify({ provider: { other: secret } }));
    const emptyFile = path.join(dir, "empty.txt");
    writeFileSync(emptyFile, "  \n\t");
    const emptyValue = path.join(dir, "empty-value.json");
    writeFileSync(emptyValue, JSON.stringify({ provider: { key: "" } }));
    const nonString = path.join(dir, "non-string.json");
    writeFileSync(nonString, JSON.stringify({ provider: { key: 42 } }));

    const cases = [
      { name: "missing file", env: { [API_KEY_FILE_ENV]: missingFile }, names: [API_KEY_FILE_ENV] },
      {
        name: "unreadable file",
        env: { [API_KEY_FILE_ENV]: directoryAsFile },
        names: [API_KEY_FILE_ENV, directoryAsFile],
      },
      {
        name: "invalid JSON",
        env: { [API_KEY_FILE_ENV]: invalidJson, [API_KEY_JSON_PATH_ENV]: "provider.key" },
        names: [API_KEY_FILE_ENV, invalidJson],
      },
      {
        name: "unknown JSON path",
        env: { [API_KEY_FILE_ENV]: unknownPath, [API_KEY_JSON_PATH_ENV]: "provider.key" },
        names: [API_KEY_JSON_PATH_ENV, '"provider.key"', unknownPath],
      },
      { name: "empty file", env: { [API_KEY_FILE_ENV]: emptyFile }, names: [API_KEY_FILE_ENV, emptyFile] },
      {
        name: "empty value",
        env: { [API_KEY_FILE_ENV]: emptyValue, [API_KEY_JSON_PATH_ENV]: "provider.key" },
        names: [API_KEY_JSON_PATH_ENV, emptyValue],
      },
      {
        name: "non-string value",
        env: { [API_KEY_FILE_ENV]: nonString, [API_KEY_JSON_PATH_ENV]: "provider.key" },
        names: [API_KEY_JSON_PATH_ENV, nonString],
      },
    ];

    for (const testCase of cases) {
      await assert.rejects(
        openaiCompatCall({ model: "fake-model" }, SYSTEM, MESSAGE, {
          fetch: async () => okResponse(),
          env: { [BASE_URL_ENV]: BASE_URL, ...testCase.env },
        }),
        (error) => {
          assert.equal(error.code, "missing_connection_env", testCase.name);
          for (const needle of testCase.names) {
            assert.ok(error.message.includes(needle), `${testCase.name}: message names ${needle}`);
          }
          assert.ok(
            !error.message.includes(secret),
            `${testCase.name}: the message must not quote the file content`,
          );
          return true;
        },
      );
    }

    // The pre-flight check short-circuits the missing file; the call-time
    // resolver still names the path it could not read.
    assert.throws(
      () => resolveApiKey({ [API_KEY_FILE_ENV]: missingFile }),
      (error) =>
        error.code === "missing_connection_env" &&
        error.message.includes(API_KEY_FILE_ENV) &&
        error.message.includes(missingFile) &&
        !error.message.includes(secret),
    );
  }),
);
