/**
 * Provider dispatch. `callModel` is the only entry point the runner uses, so
 * adding a provider means adding one branch here.
 */

import { baselineCall } from "./baselines.js";
import { openaiCompatCall } from "./openai-compat.js";

/**
 * @param {{provider: string, kind?: string, [key: string]: unknown}} modelCfg
 * @param {string} system rendered system prompt
 * @param {string} message patient message
 * @param {object} testCase the dataset row (only baselines read it)
 * @param {object} [options] provider options (injected fetch/env, signal)
 * @returns {Promise<{text: string, usage: object, served_model: string|null, stop_reason: string, latency_ms: number}>}
 */
export async function callModel(modelCfg, system, message, testCase, options = {}) {
  const provider = modelCfg?.provider;

  if (provider === "baseline") {
    return baselineCall(modelCfg.kind, testCase, options);
  }
  if (provider === "openai-compat") {
    return openaiCompatCall(modelCfg, system, message, options);
  }

  const error = new Error(`unknown provider: ${String(provider)}`);
  error.code = "unknown_provider";
  throw error;
}

export { baselineCall, openaiCompatCall };
