/**
 * OpenAI-compatible provider.
 *
 * Works with any endpoint that speaks `POST {base}/chat/completions` with JSON
 * mode. There is exactly one client: connection details come from the
 * environment, never from `bench.config.json`.
 *
 *   LLM_BASE_URL  base URL, e.g. https://api.example.com/v1
 *   LLM_API_KEY   bearer token; read at call time and never written anywhere
 *   LLM_MODEL     optional override of the model id configured per entry
 */

export const BASE_URL_ENV = "LLM_BASE_URL";
export const API_KEY_ENV = "LLM_API_KEY";
export const MODEL_ENV = "LLM_MODEL";

const clean = (value) => String(value ?? "").trim();

/** Strips trailing slashes so `/v1/` and `/v1` behave the same. */
export const joinUrl = (baseUrl) => `${clean(baseUrl).replace(/\/+$/, "")}/chat/completions`;

/** Model id to send: LLM_MODEL wins over the configured id. */
export const resolveModelId = (modelCfg, env = process.env) =>
  clean(env?.[MODEL_ENV]) || clean(modelCfg?.model);

/** Names of the connection variables that are not set. */
export const missingEnv = (env = process.env) =>
  [BASE_URL_ENV, API_KEY_ENV].filter((name) => clean(env?.[name]) === "");

const connectionError = (names) => {
  const error = new Error(`${names.join(" and ")} must be set before calling a priced model`);
  error.code = "missing_connection_env";
  return error;
};

const mismatchError = (requested, served) => {
  const error = new Error(
    `served model ${JSON.stringify(served)} does not match requested ${JSON.stringify(requested)}`,
  );
  error.code = "served_model_mismatch";
  return error;
};

const mapFinishReason = (reason) => {
  if (reason === "length") return "max_tokens";
  if (reason === "refusal" || reason === "content_filter") return "refusal";
  if (reason === "stop" || reason === undefined || reason === null) return "end_turn";
  return reason;
};

const contentFrom = (content) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
      .join("");
  }
  return "";
};

/**
 * @param {object} modelCfg  entry from bench.config.json
 * @param {string} system    rendered system prompt
 * @param {string} message   patient message
 * @param {{fetch?: Function, signal?: AbortSignal, env?: object}} [options]
 */
export async function openaiCompatCall(modelCfg, system, message, options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const missing = missingEnv(env);
  if (missing.length > 0) throw connectionError(missing);

  const baseUrl = clean(env[BASE_URL_ENV]);
  const apiKey = clean(env[API_KEY_ENV]);
  const model = resolveModelId(modelCfg, env);

  const body = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: message },
    ],
    response_format: { type: "json_object" },
  };

  const url = joinUrl(baseUrl);
  const started = performance.now();
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const latencyMs = Math.round(performance.now() - started);

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const error = new Error(
      `HTTP ${response.status} from ${url}${detail ? `: ${detail.slice(0, 500)}` : ""}`,
    );
    error.status = response.status;
    throw error;
  }

  const data = await response.json();
  const choice = data?.choices?.[0] ?? {};
  const usage = data?.usage ?? {};

  // Endpoints may answer with the requested id or a dated variant of it, so a
  // prefix match is enough. Endpoints that omit `model` fall back to the
  // requested id; anything else is an infrastructure error.
  const servedModel = typeof data?.model === "string" && data.model ? data.model : model;
  if (!String(servedModel).startsWith(model)) {
    throw mismatchError(model, servedModel);
  }

  return {
    text: contentFrom(choice?.message?.content),
    usage: {
      input: usage.prompt_tokens ?? 0,
      output: usage.completion_tokens ?? 0,
      cache_read: usage.prompt_cache_hit_tokens ?? 0,
      cache_write: 0,
    },
    served_model: servedModel,
    stop_reason: mapFinishReason(choice?.finish_reason),
    latency_ms: latencyMs,
  };
}

export const provider = "openai-compat";
