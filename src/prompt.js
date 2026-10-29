/**
 * Prompt and dataset loading + hashing. See docs/METHODOLOGY.md.
 *
 * Hashing rules:
 * - prompt hash = sha256(rendered prompt with the literal "{{CANARY}}"
 *   placeholder kept as-is + JSON.stringify(schema)). Stable across runs even
 *   though the canary is random.
 * - dataset hash = sha256(cases.jsonl bytes + context.json bytes).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { outputSchema } from "./schema.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const ROOT_DIR = ROOT;
export const DATA_DIR = path.join(ROOT, "data");
export const CONTEXT_PATH = path.join(DATA_DIR, "context.json");
export const CASES_PATH = path.join(DATA_DIR, "cases.jsonl");
export const PROMPT_PATH = path.join(ROOT, "prompts", "receptionist-v1.md");

export const CANARY_PLACEHOLDER = "{{CANARY}}";
const CONTEXT_PLACEHOLDER = "{{CONTEXT}}";

const sha256 = (input) => createHash("sha256").update(input).digest("hex");

/** Reads and parses data/context.json. */
export function loadContext() {
  return JSON.parse(readFileSync(CONTEXT_PATH, "utf8"));
}

/** Reads the raw system prompt template (placeholders untouched). */
export function loadPromptTemplate() {
  return readFileSync(PROMPT_PATH, "utf8");
}

/**
 * Renders the system prompt for a given run canary.
 * @param {string} canary e.g. "CANARY-7F3A9C"
 */
export function renderPrompt(canary) {
  const context = JSON.stringify(loadContext(), null, 2);
  return loadPromptTemplate()
    .replaceAll(CONTEXT_PLACEHOLDER, context)
    .replaceAll(CANARY_PLACEHOLDER, String(canary));
}

/**
 * sha256 of the prompt rendered with the literal placeholder canary kept as-is,
 * concatenated with the JSON schema.
 */
export function promptHash() {
  return sha256(renderPrompt(CANARY_PLACEHOLDER) + JSON.stringify(outputSchema));
}

/** sha256 of the raw bytes of cases.jsonl followed by the raw bytes of context.json. */
export function datasetHash() {
  return sha256(
    Buffer.concat([readFileSync(CASES_PATH), readFileSync(CONTEXT_PATH)]),
  );
}

/** Converts a simple wildcard pattern (`*` only) into an anchored RegExp. */
export function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\\\*/g, ".*")}$`);
}

/**
 * Loads the cases, optionally filtered by id glob(s).
 * @param {string|string[]|undefined} globFilter e.g. "emer-*" or ["std-*","inj-*"]
 */
export function loadCases(globFilter) {
  const cases = readFileSync(CASES_PATH, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`cases.jsonl line ${index + 1} is not valid JSON: ${error.message}`);
      }
    });

  if (globFilter === undefined || globFilter === null || globFilter === "") return cases;

  const patterns = (Array.isArray(globFilter) ? globFilter : [globFilter])
    .flatMap((entry) => String(entry).split(","))
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map(globToRegExp);

  if (patterns.length === 0) return cases;

  return cases.filter((testCase) => patterns.some((re) => re.test(testCase.id)));
}
