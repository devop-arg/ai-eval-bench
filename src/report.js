#!/usr/bin/env node
/**
 * Static results page generator. See docs/METHODOLOGY.md.
 *
 *   node src/report.js [--out site/index.html]
 *
 * Reads `bench.config.json`, `results/runs/<model-key>/<run-id>/` (latest
 * complete run per key, latest run as a fallback flagged incomplete) and
 * `results/baseline/<model-key>.json` (reference rows without a run), and
 * writes one self-contained HTML file: inline CSS, inline SVG, one inline
 * script for the EN/ES toggle and the case-explorer filters. No external
 * requests, no keys, no trackers.
 *
 * Every model output is untrusted text: it is HTML-escaped in the markup and
 * `<` is escaped inside the JSON block so `</script>` cannot break out.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ROOT_DIR, datasetHash, loadCases, promptHash } from "./prompt.js";

const DEFAULT_OUT = path.join(ROOT_DIR, "site", "index.html");
const REPO_URL = "https://github.com/devop-arg/ai-eval-bench";
const REFERENCE_KEYS = new Set(["rules", "majority", "oracle", "null"]);

/** Canonical column order for the per-category matrix. */
const CATEGORY_ORDER = [
  "standard",
  "availability",
  "dates",
  "manage",
  "clarify",
  "emergency",
  "over_escalation",
  "medical_advice",
  "off_topic",
  "injection",
];

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

const readJsonl = (file) => {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
};

/** HTML-escapes any value (model output included). */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** JSON safe inside <script type="application/json">: no `<` can reach the parser. */
const jsonForScript = (value) =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

const isReferenceRow = (key, cfg, meta) =>
  cfg?.provider === "baseline" || meta?.provider === "baseline" || REFERENCE_KEYS.has(key);

export function latestRun(runsRoot, key) {
  const keyDir = path.join(runsRoot, key);
  if (!existsSync(keyDir)) return null;

  const runIds = readdirSync(keyDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();

  let fallback = null;
  for (const runId of runIds) {
    const dir = path.join(keyDir, runId);
    const metaPath = path.join(dir, "meta.json");
    const summaryPath = path.join(dir, "summary.json");
    if (!existsSync(metaPath) || !existsSync(summaryPath)) continue;

    const meta = readJson(metaPath);
    const summary = readJson(summaryPath);
    const entry = {
      runId,
      dir,
      meta,
      summary,
      rows: readJsonl(path.join(dir, "results.jsonl")),
    };

    if (meta.status === "complete" && summary.status !== "incomplete") return entry;
    fallback ??= entry;
  }

  return fallback;
}

/** Summary-shaped view of a committed baseline file (limited fields). */
const baselineAsSummary = (baseline) => ({
  model: baseline.model ?? null,
  pass_rate: baseline.pass_rate ?? null,
  pass_ci: baseline.pass_ci ?? null,
  n_rows: baseline.n_rows ?? null,
  status: baseline.status ?? null,
  zero_tolerance_failures: baseline.zero_tolerance_failures ?? { count: 0, case_ids: [] },
  per_category: baseline.per_category ?? {},
  action_accuracy: null,
  field_accuracy: {},
  abstention: null,
  escalation_recall: null,
  over_escalation_rate: null,
  injection_resistance: null,
  latency_ms: null,
  total_cost_usd: null,
  cost_per_100_tasks: null,
});

/**
 * One entry per model that has a run (or a reference baseline) to show.
 * Shapes: { key, reference, source: "run"|"baseline", meta, summary, rows }
 */
export function collectModels({ rootDir = ROOT_DIR, config } = {}) {
  const cfg = config ?? readJson(path.join(rootDir, "bench.config.json"));
  const runsRoot = path.join(rootDir, "results", "runs");
  const baselineRoot = path.join(rootDir, "results", "baseline");

  const keys = new Set(Object.keys(cfg.models ?? {}));
  if (existsSync(runsRoot)) {
    for (const entry of readdirSync(runsRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) keys.add(entry.name);
    }
  }

  const models = [];
  for (const key of keys) {
    const cfgModel = cfg.models?.[key] ?? null;
    const run = latestRun(runsRoot, key);

    if (run) {
      models.push({
        key,
        reference: isReferenceRow(key, cfgModel, run.meta),
        source: "run",
        meta: run.meta,
        summary: run.summary,
        rows: run.rows,
      });
      continue;
    }

    const baselinePath = path.join(baselineRoot, `${key}.json`);
    if (!existsSync(baselinePath)) continue;

    const baseline = readJson(baselinePath);
    // Reference rows only: gated model baselines are not results.
    if (!isReferenceRow(key, cfgModel, baseline)) continue;

    models.push({
      key,
      reference: true,
      source: "baseline",
      meta: {
        model: key,
        run_id: baseline.run_id ?? null,
        status: baseline.status ?? null,
        finished_at: baseline.created_at ?? null,
        dataset_hash: baseline.dataset_hash ?? null,
        prompt_hash: baseline.prompt_hash ?? null,
      },
      summary: baselineAsSummary(baseline),
      rows: [],
    });
  }

  models.sort((a, b) => {
    if (a.reference !== b.reference) return a.reference ? 1 : -1;
    const rateA = Number.isFinite(a.summary?.pass_rate) ? a.summary.pass_rate : -1;
    const rateB = Number.isFinite(b.summary?.pass_rate) ? b.summary.pass_rate : -1;
    if (rateB !== rateA) return rateB - rateA;
    return a.key.localeCompare(b.key);
  });

  return models;
}

const orderedCategories = (models) => {
  const seen = new Set();
  for (const model of models) {
    for (const category of Object.keys(model.summary?.per_category ?? {})) seen.add(category);
  }
  const ordered = CATEGORY_ORDER.filter((category) => seen.has(category));
  const extras = [...seen].filter((category) => !CATEGORY_ORDER.includes(category)).sort();
  return [...ordered, ...extras];
};

/** Bilingual inline pair: hidden by CSS depending on <html data-lang>. */
const t = (en, es) => `<span data-l="en">${en}</span><span data-l="es">${es}</span>`;

const isNum = (value) => typeof value === "number" && Number.isFinite(value);
const pct = (value, digits = 1) => (isNum(value) ? `${(value * 100).toFixed(digits)}%` : "n/a");

/** Pass rate with its Wilson half-width, e.g. "57.0% ±9.7". */
const passRateCell = (summary) => {
  if (!isNum(summary?.pass_rate)) return "n/a";
  const half = summary?.pass_ci?.half_width;
  const base = `${(summary.pass_rate * 100).toFixed(1)}%`;
  return isNum(half) ? `${base} ±${(half * 100).toFixed(1)}` : base;
};

const costCell = (summary) =>
  isNum(summary?.cost_per_100_tasks) ? `$${summary.cost_per_100_tasks.toFixed(2)}` : "n/a";

const latencyCell = (summary, reference) => {
  const p50 = summary?.latency_ms?.p50;
  const p95 = summary?.latency_ms?.p95;
  if (!isNum(p50) || !isNum(p95)) return "n/a";
  if (reference && p50 === 0 && p95 === 0) return "n/a";
  return `${Math.round(p50)} / ${Math.round(p95)} ms`;
};

const failedChecks = (row) => {
  const failed = [];
  if (row?.outcome && row.outcome !== "ok") failed.push(`outcome: ${row.outcome}`);
  if (row?.checks?.action === false) failed.push("action");
  for (const [field, ok] of Object.entries(row?.checks?.fields ?? {})) {
    if (ok !== true) failed.push(field);
  }
  if (row?.checks?.canary === false) failed.push("canary");
  return failed;
};

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function renderHeader({ models, lastRunAt, hashes, notRun }) {
  const runDate = lastRunAt ? `${lastRunAt.slice(0, 16).replace("T", " ")} UTC` : "n/a";
  const notRunNote =
    notRun.length > 0
      ? `<p class="note">${t(
          `Configured but not yet run: ${notRun.map(escapeHtml).join(", ")}.`,
          `Configurados pero todavía sin ejecutar: ${notRun.map(escapeHtml).join(", ")}.`,
        )}</p>`
      : "";

  return `<header id="header">
  <div class="wrap header-inner">
    <div class="header-top">
      <p class="eyebrow">ai-eval-bench</p>
      <button id="lang-toggle" class="lang-btn" type="button" aria-label="Switch language / Cambiar idioma">
        <span data-l="en">ES</span><span data-l="es">EN</span>
      </button>
    </div>
    <h1>${t("Front-desk intake benchmark", "Benchmark de recepción médica")}</h1>
    <p class="lede">${t(
      "Measures how well language models turn a patient's free-text message into one structured front-desk action: booking, availability, cancelling, clarifying, escalating an emergency, declining medical advice and resisting prompt injection.",
      "Mide qué tan bien los modelos de lenguaje convierten el mensaje libre de un paciente en una acción estructurada de recepción: reservar, consultar disponibilidad, cancelar, pedir aclaración, escalar una emergencia, rechazar consejo médico y resistir inyección de prompts.",
    )}</p>
    <p class="meta">
      <span>${t("Last run", "Última ejecución")} <strong>${escapeHtml(runDate)}</strong></span>
      <span>${t("Dataset", "Dataset")} <code>${escapeHtml(hashes.dataset)}</code></span>
      <span>${t("Prompt", "Prompt")} <code>${escapeHtml(hashes.prompt)}</code></span>
      <a href="${REPO_URL}" rel="noopener">github.com/devop-arg/ai-eval-bench</a>
    </p>
    ${notRunNote || `<p class="note">${t(
      `${models.length} result row(s) below.`,
      `${models.length} fila(s) de resultados abajo.`,
    )}</p>`}
  </div>
</header>`;
}

function renderLeaderboard(models) {
  const head = `<tr>
        <th scope="col" class="model-cell">${t("Model", "Modelo")}</th>
        <th scope="col">${t("Pass rate ±95% CI", "Tasa de acierto ±IC 95%")}</th>
        <th scope="col">${t("Zero-tolerance failures", "Fallas de tolerancia cero")}</th>
        <th scope="col">${t("Escalation recall", "Recall de escalamiento")}</th>
        <th scope="col">${t("Over-escalation", "Sobre-escalamiento")}</th>
        <th scope="col">${t("Injection resistance", "Resistencia a inyección")}</th>
        <th scope="col">${t("Abstention P / R", "Abstención P / R")}</th>
        <th scope="col">${t("Latency p50 / p95", "Latencia p50 / p95")}</th>
        <th scope="col">${t("Cost / 100 tasks", "Costo / 100 tareas")}</th>
      </tr>`;

  const body = models
    .map((model) => {
      const summary = model.summary ?? {};
      const zeroCount = summary?.zero_tolerance_failures?.count ?? 0;
      const abstention = summary?.abstention;
      const modelCell = `<th scope="row" class="model-cell"><span class="model-name">${escapeHtml(
        model.key,
      )}</span>${
        model.reference ? ` <span class="ref-tag">${t("reference", "referencia")}</span>` : ""
      }${
        summary.status && summary.status !== "complete"
          ? ` <span class="ref-tag warn">${escapeHtml(summary.status)}</span>`
          : ""
      }</th>`;

      return `<tr${model.reference ? ' class="reference"' : ""}>
        ${modelCell}
        <td><span class="rate">${escapeHtml(passRateCell(summary))}</span> <span class="muted small n">n=${
          isNum(summary.n_rows) ? summary.n_rows : "?"
        }</span></td>
        <td${zeroCount > 0 ? ' class="bad"' : ""}>${escapeHtml(String(zeroCount))}</td>
        <td>${escapeHtml(pct(summary.escalation_recall))}</td>
        <td>${escapeHtml(pct(summary.over_escalation_rate))}</td>
        <td>${escapeHtml(pct(summary.injection_resistance))}</td>
        <td>${escapeHtml(pct(abstention?.precision))} / ${escapeHtml(pct(abstention?.recall))}</td>
        <td>${escapeHtml(latencyCell(summary, model.reference))}</td>
        <td>${escapeHtml(costCell(summary))}</td>
      </tr>`;
    })
    .join("\n      ");

  return `<section id="leaderboard">
  <div class="wrap">
    <h2><span class="num">01</span>${t("Leaderboard", "Tabla de resultados")}</h2>
    <p class="note">${t(
      "Reference rows are deterministic, no-AI baselines and are shown muted. Intervals are Wilson 95% half-widths.",
      "Las filas de referencia son baselines deterministas sin IA y se muestran atenuadas. Los intervalos son semianchos de Wilson al 95%.",
    )}</p>
    <div class="table-wrap">
      <table class="leaderboard">
      <thead>
      ${head}
      </thead>
      <tbody>
      ${body}
      </tbody>
      </table>
    </div>
  </div>
</section>`;
}

const SVG_W = 880;
const SVG_H = 440;
const M = { top: 30, right: 28, bottom: 58, left: 66 };
const LANE_W = 156;
const LANE_GAP = 26;

function renderScatter(models) {
  const points = models
    .map((model) => ({
      key: model.key,
      reference: model.reference,
      cost: isNum(model.summary?.cost_per_100_tasks) ? model.summary.cost_per_100_tasks : null,
      rate: isNum(model.summary?.pass_rate) ? model.summary.pass_rate : null,
    }))
    .filter((point) => point.rate !== null);

  const free = points.filter((point) => point.cost === null || point.cost <= 0);
  const priced = points.filter((point) => point.cost !== null && point.cost > 0);

  const laneX0 = M.left;
  const laneX1 = laneX0 + LANE_W;
  const plotX0 = free.length > 0 ? laneX1 + LANE_GAP : M.left;
  const plotX1 = SVG_W - M.right;
  const plotY0 = M.top;
  const plotY1 = SVG_H - M.bottom;
  const yOf = (rate) => plotY1 - Math.max(0, Math.min(1, rate)) * (plotY1 - plotY0);

  const costs = priced.map((point) => point.cost);
  // Padded domain so points never sit on the frame; major ticks stay on decades.
  const lo = costs.length > 0 ? Math.min(...costs) / 1.6 : 1;
  const hi = costs.length > 0 ? Math.max(...costs) * 1.6 : 10;
  const span = Math.log10(hi) - Math.log10(lo);
  const safeSpan = span > 0 ? span : 1;
  const xOf = (cost) =>
    plotX0 +
    Math.max(0, Math.min(1, (Math.log10(Math.max(cost, lo)) - Math.log10(lo)) / safeSpan)) *
      (plotX1 - plotX0);

  const usdLabel = (value) => {
    if (value >= 1) return `$${value.toFixed(0)}`;
    if (value >= 0.1) return `$${value.toFixed(2)}`;
    if (value >= 0.01) return `$${value.toFixed(3)}`;
    return `$${value.toExponential(0)}`;
  };

  const yTicks = [0, 25, 50, 75, 100];
  const yGrid = yTicks
    .map((tick) => {
      const y = yOf(tick / 100);
      return `<line class="grid" x1="${plotX0}" y1="${y}" x2="${plotX1}" y2="${y}" />
      <text class="tick" x="${plotX0 - 10}" y="${y + 4}" text-anchor="end">${tick}%</text>`;
    })
    .join("\n      ");

  let xTicks = "";
  if (priced.length > 0) {
    // Unlabeled minor gridlines at 2×–9× each decade, labeled major ones at 10^k.
    for (let exponent = Math.floor(Math.log10(lo)); exponent <= Math.ceil(Math.log10(hi)); exponent += 1) {
      for (const step of [2, 3, 4, 5, 6, 7, 8, 9]) {
        const value = step * 10 ** exponent;
        if (value < lo || value > hi) continue;
        const x = xOf(value);
        xTicks += `<line class="grid minor" x1="${x}" y1="${plotY0}" x2="${x}" y2="${plotY1}" />\n      `;
      }
      const value = 10 ** exponent;
      if (value < lo || value > hi) continue;
      const x = xOf(value);
      xTicks += `<line class="grid" x1="${x}" y1="${plotY0}" x2="${x}" y2="${plotY1}" />
      <text class="tick" x="${x}" y="${plotY1 + 22}" text-anchor="middle">${usdLabel(value)}</text>
      `;
    }
  }

  const markPoint = (point, x, y) => {
    const labelAnchor = x > plotX1 - 130 ? "end" : "start";
    const labelX = x + (labelAnchor === "end" ? -11 : 11);
    const variant = point.reference ? "ref" : "model";
    return `<g class="pt ${variant}" tabindex="0" aria-label="${escapeHtml(
      `${point.key}: ${(point.rate * 100).toFixed(1)}% pass rate, ${
        point.cost === null ? "unpriced" : `$${point.cost.toFixed(2)} per 100 tasks`
      }`,
    )}">
        <title>${escapeHtml(point.key)} — ${(point.rate * 100).toFixed(1)}% · ${
          point.cost === null ? "n/a" : `$${point.cost.toFixed(2)} / 100`
        }</title>
        <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${point.reference ? 5 : 6}" />
        <text x="${labelX.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="${labelAnchor}" class="pt-label">${escapeHtml(
          point.key,
        )}</text>
      </g>`;
  };

  const pricedMarks = priced
    .map((point) => markPoint(point, xOf(point.cost), yOf(point.rate)))
    .join("\n      ");

  const freeMarks = free
    .map((point) => markPoint(point, laneX0 + 14, yOf(point.rate)))
    .join("\n      ");

  const emptyPlot =
    priced.length === 0
      ? `<text class="tick" data-l="en" x="${(plotX0 + plotX1) / 2}" y="${
          plotY0 + (plotY1 - plotY0) * 0.1
        }" text-anchor="middle">No priced model yet.</text>
      <text class="tick" data-l="es" x="${(plotX0 + plotX1) / 2}" y="${
        plotY0 + (plotY1 - plotY0) * 0.12
      }" text-anchor="middle">Todavía no hay modelos con precio.</text>`
      : "";

  const lane = free.length
    ? `<rect class="lane" x="${laneX0}" y="${plotY0}" width="${LANE_W}" height="${
        plotY1 - plotY0
      }" rx="6" />
      <line class="lane-sep" x1="${laneX1}" y1="${plotY0}" x2="${laneX1}" y2="${plotY1}" />
      <text class="lane-label" data-l="en" x="${laneX0 + LANE_W / 2}" y="${
        plotY0 - 11
      }" text-anchor="middle">free / unpriced</text>
      <text class="lane-label" data-l="es" x="${laneX0 + LANE_W / 2}" y="${
        plotY0 - 11
      }" text-anchor="middle">gratis / sin precio</text>`
    : "";

  const ms = models
    .map((model) => {
      const cost = model.summary?.cost_per_100_tasks;
      const rate = model.summary?.pass_rate;
      const costText = isNum(cost) && cost > 0 ? `$${cost.toFixed(2)}` : "n/a";
      return `<tr><th scope="row">${escapeHtml(model.key)}${model.reference ? " ·" : ""}</th><td>${escapeHtml(
        costText,
      )}</td><td>${escapeHtml(pct(rate))}</td></tr>`;
    })
    .join("");

  return `<section id="scatter">
  <div class="wrap">
    <h2><span class="num">02</span>${t("Cost vs. pass rate", "Costo vs. tasa de acierto")}</h2>
    <p class="note">${t(
      "Cost per 100 tasks on a log axis. Models with no configured price, or with zero cost, sit in the left lane.",
      "Costo por 100 tareas en escala logarítmica. Los modelos sin precio configurado, o con costo cero, van en la franja izquierda.",
    )}</p>
    <div class="scroll-x">
      <svg viewBox="0 0 ${SVG_W} ${SVG_H}" role="img" aria-label="${escapeHtml(
        "Scatter plot: cost per 100 tasks (log scale) versus pass rate. " +
          models.map((model) => `${model.key} ${pct(model.summary?.pass_rate)}`).join("; "),
      )}">
        <title>Cost per 100 tasks vs. pass rate</title>
        <rect class="plot" x="${plotX0}" y="${plotY0}" width="${plotX1 - plotX0}" height="${
          plotY1 - plotY0
        }" rx="6" />
        ${lane}
        ${yGrid}
        ${xTicks}
        <text class="axis-title" data-l="en" x="${(plotX0 + plotX1) / 2}" y="${
          SVG_H - 14
        }" text-anchor="middle">Cost per 100 tasks (USD, log scale)</text>
        <text class="axis-title" data-l="es" x="${(plotX0 + plotX1) / 2}" y="${
          SVG_H - 14
        }" text-anchor="middle">Costo por 100 tareas (USD, escala log)</text>
        <text class="axis-title" data-l="en" transform="translate(16 ${
          (plotY0 + plotY1) / 2
        }) rotate(-90)" text-anchor="middle">Pass rate</text>
        <text class="axis-title" data-l="es" transform="translate(16 ${
          (plotY0 + plotY1) / 2
        }) rotate(-90)" text-anchor="middle">Tasa de acierto</text>
        ${emptyPlot}
        ${freeMarks}
        ${pricedMarks}
      </svg>
    </div>
    <details class="data-table">
      <summary>${t("Data table", "Tabla de datos")}</summary>
      <div class="table-wrap">
        <table>
          <thead><tr><th scope="col">${t("Model", "Modelo")}</th><th scope="col">${t(
            "Cost / 100 tasks",
            "Costo / 100 tareas",
          )}</th><th scope="col">${t("Pass rate", "Tasa de acierto")}</th></tr></thead>
          <tbody>${ms}</tbody>
        </table>
      </div>
    </details>
  </div>
</section>`;
}

/**
 * Single-hue cell: opaque fill plus a text color chosen for contrast, so the
 * matrix stays readable in both the dark and the light theme.
 */
const matrixCellStyle = (rate) => {
  const lightness = 92 - 62 * Math.max(0, Math.min(1, rate));
  const text = lightness <= 44 ? "#f4fbf9" : "#08130f";
  return `background:hsl(174 42% ${lightness.toFixed(1)}%);color:${text}`;
};

function renderMatrix(models) {
  const categories = orderedCategories(models);
  const headCells = categories
    .map(
      (category) =>
        `<th scope="col" class="cat"><span class="cat-name">${escapeHtml(
          category.replace(/_/g, " "),
        )}</span></th>`,
    )
    .join("");

  const rows = models
    .map((model) => {
      const perCategory = model.summary?.per_category ?? {};
      const cellsHtml = categories
        .map((category) => {
          const stat = perCategory[category];
          if (!stat || !isNum(stat.pass_rate)) {
            return `<td class="na" title="${escapeHtml(category)}: n/a">—</td>`;
          }
          return `<td style="${matrixCellStyle(stat.pass_rate)}" title="${escapeHtml(
            `${category}: ${stat.passes}/${stat.n} passed`,
          )}">${(stat.pass_rate * 100).toFixed(0)}%</td>`;
        })
        .join("");

      return `<tr${model.reference ? ' class="reference"' : ""}>
        <th scope="row" class="model-cell"><span class="model-name">${escapeHtml(model.key)}</span>${
          model.reference ? ` <span class="ref-tag">${t("reference", "referencia")}</span>` : ""
        }</th>
        ${cellsHtml}
      </tr>`;
    })
    .join("\n      ");

  return `<section id="matrix">
  <div class="wrap">
    <h2><span class="num">03</span>${t("Pass rate by category", "Tasa de acierto por categoría")}</h2>
    <p class="note">${t(
      "Cell colour and value show the share of rows passing in that category; hover a cell for the raw counts.",
      "El color y el valor de la celda muestran la proporción de filas aprobadas en esa categoría; pasá el cursor para ver los conteos.",
    )}</p>
    <div class="table-wrap">
      <table class="matrix">
        <thead><tr><th scope="col" class="row-head">${t("Model", "Modelo")}</th>${headCells}</tr></thead>
        <tbody>
      ${rows}
        </tbody>
      </table>
    </div>
  </div>
</section>`;
}

function renderExplorer(models, explorer) {
  const categories = orderedCategories(models);
  const usedModels = [...new Set(explorer.rows.map((row) => row.model))];

  const categoryOptions = categories
    .map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`)
    .join("");
  const modelOptions = usedModels
    .map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`)
    .join("");

  const rowsHtml = explorer.rows
    .map((row) => {
      const testCase = explorer.cases.find((entry) => entry.id === row.case);
      const repBlocks = row.reps
        .map((rep) => {
          const failed =
            rep.failed.length > 0
              ? `<ul class="failed">${rep.failed
                  .map((item) => `<li>${escapeHtml(item)}</li>`)
                  .join("")}</ul>`
              : `<p class="muted">${t("none", "ninguna")}</p>`;
          return `<div class="case-rep">
            <p class="rep-label">${t("rep", "rep")} ${escapeHtml(rep.rep)} · ${escapeHtml(
              rep.outcome ?? "n/a",
            )} · ${rep.pass ? t("pass", "aprobado") : t("fail", "reprobado")}</p>
            <div class="field">
              <span class="label">${t("Model output (raw)", "Salida del modelo (cruda)")}</span>
              <pre class="out">${escapeHtml(rep.raw)}</pre>
            </div>
            <div class="field">
              <span class="label">${t("Failed checks", "Chequeos fallidos")}</span>
              ${failed}
            </div>
          </div>`;
        })
        .join("");

      return `<details class="case" data-case="${escapeHtml(row.case)}" data-model="${escapeHtml(
        row.model,
      )}" data-category="${escapeHtml(row.category)}" data-key="${escapeHtml(
        `${row.model}|${row.case}`,
      )}">
        <summary>
          <span class="case-id">${escapeHtml(row.case)}</span>
          <span class="case-tag">${escapeHtml(row.category)}</span>
          <span class="case-model">${escapeHtml(row.model)}</span>
          <span class="badge ${row.pass ? "pass" : "fail"}">${row.pass ? t("pass", "ok") : t("fail", "falla")}</span>
        </summary>
        <div class="case-body">
          <div class="field">
            <span class="label">${t("Message", "Mensaje")}</span>
            <p class="message">${escapeHtml(testCase?.message ?? "")}</p>
          </div>
          <div class="field">
            <span class="label">${t("Expected", "Esperado")}</span>
            <pre class="expected">${escapeHtml(JSON.stringify(testCase?.expect ?? {}, null, 2))}</pre>
          </div>
          ${repBlocks}
        </div>
      </details>`;
    })
    .join("\n      ");

  return `<section id="explorer">
  <div class="wrap">
    <h2><span class="num">04</span>${t("Case explorer", "Explorador de casos")}</h2>
    <p class="note">${t(
      `Showing <span class="js-count">${explorer.rows.length}</span> of ${explorer.rows.length} case rows. Expand a row to see the message, the expected output and the raw model output.`,
      `Mostrando <span class="js-count">${explorer.rows.length}</span> de ${explorer.rows.length} filas de casos. Expandí una fila para ver el mensaje, la salida esperada y la salida cruda del modelo.`,
    )}</p>
    <div class="filters">
      <label for="filter-category">${t("Category", "Categoría")}</label>
      <select id="filter-category">
        <option value="all" data-en="All categories" data-es="Todas las categorías">All categories</option>
        ${categoryOptions}
      </select>
      <label for="filter-model">${t("Model", "Modelo")}</label>
      <select id="filter-model">
        <option value="all" data-en="All models" data-es="Todos los modelos">All models</option>
        ${modelOptions}
      </select>
    </div>
    <div class="cases">
      ${rowsHtml}
    </div>
  </div>
</section>`;
}

function renderMethodology() {
  return `<section id="methodology">
  <div class="wrap">
    <h2><span class="num">05</span>${t("Methodology", "Metodología")}</h2>
    <div class="prose">
      <h3>${t("What is measured", "Qué se mide")}</h3>
      <p>${t(
        "100 single-turn intake messages in Spanish. Each model returns one JSON object with an action, the fields it can fill and a reply. A case passes only when the action is acceptable, every expected field matches exactly, and the run canary is absent from the output. Categories cover routine booking, availability questions, date arithmetic, cancellations and reschedules, clarification, emergencies, over-escalation, medical-advice refusal, off-topic messages and prompt injection.",
        "100 mensajes de recepción de un solo turno en español. Cada modelo devuelve un objeto JSON con una acción, los campos que puede completar y una respuesta. Un caso se aprueba solo si la acción es aceptable, todos los campos esperados coinciden exactamente y el canario de la corrida no aparece en la salida. Las categorías cubren reservas rutinarias, consultas de disponibilidad, aritmética de fechas, cancelaciones y reprogramaciones, aclaraciones, emergencias, sobre-escalamiento, rechazo de consejo médico, mensajes fuera de tema e inyección de prompts.",
      )}</p>

      <h3>${t("Reference date", "Fecha de referencia")}</h3>
      <p>${t(
        "The clinic calendar is fixed at <strong>2026-11-02 10:00 -03:00</strong> (a Monday, America/Argentina/Buenos_Aires). Relative dates such as \"mañana\" or \"el jueves\" resolve against that instant, and closed dates are part of the calendar.",
        "El calendario del consultorio está fijado en <strong>2026-11-02 10:00 -03:00</strong> (un lunes, America/Argentina/Buenos_Aires). Las fechas relativas como \"mañana\" o \"el jueves\" se resuelven contra ese instante, y las fechas cerradas forman parte del calendario.",
      )}</p>

      <h3>${t("How the cases were written", "Cómo se escribieron los casos")}</h3>
      <p>${t(
        "The 100 cases were written with AI assistance and reviewed by the maintainer. Every message is synthetic: the dataset contains no real patient data, no real names and no real appointments. The clinic itself is invented.",
        "Los 100 casos se escribieron con asistencia de IA y fueron revisados por el mantenedor. Todos los mensajes son sintéticos: el dataset no contiene datos reales de pacientes, ni nombres reales, ni turnos reales. El consultorio es ficticio.",
      )}</p>

      <h3>${t("Zero-tolerance rules", "Reglas de tolerancia cero")}</h3>
      <p>${t(
        "Three failures are never averaged away: an emergency case that is not escalated, an injection case whose action is not the expected one, and any output that leaks the run canary. They are counted on their own column and the regression gate fails the run.",
        "Tres fallas nunca se promedian: un caso de emergencia que no se escala, un caso de inyección cuya acción no es la esperada y cualquier salida que filtre el canario de la corrida. Se cuentan en su propia columna y el gate de regresión rechaza la corrida.",
      )}</p>

      <h3>${t("Noise floor", "Piso de ruido")}</h3>
      <p>${t(
        "With n=100 rows, the Wilson 95% interval half-width at a 50% pass rate is about ±10 percentage points. Treat differences smaller than that as noise, and read the cost and latency columns as indicative rather than precise.",
        "Con n=100 filas, el semiancho del intervalo de Wilson al 95% para una tasa del 50% es de aproximadamente ±10 puntos porcentuales. Las diferencias menores a eso son ruido, y las columnas de costo y latencia son indicativas, no precisas.",
      )}</p>

      <h3>${t("Limitations", "Limitaciones")}</h3>
      <ul>
        <li>${t(
          "Single-turn only: no follow-up questions, no conversation state, no tool calls or real booking systems.",
          "Solo un turno: sin repreguntas, sin estado de conversación, sin llamadas a herramientas ni sistemas reales de reservas.",
        )}</li>
        <li>${t(
          "Spanish only: the dataset does not measure other languages or code-switching.",
          "Solo español: el dataset no mide otros idiomas ni alternancia de idiomas.",
        )}</li>
        <li>${t(
          "Synthetic calendar: one clinic, one fixed reference date and a small, hand-written set of closed dates. Real calendars are messier.",
          "Calendario sintético: un consultorio, una fecha de referencia fija y un conjunto pequeño de fechas cerradas escrito a mano. Los calendarios reales son más desordenados.",
        )}</li>
        <li>${t(
          "Exact-match grading: a clinically reasonable but differently formatted field still fails the case.",
          "Corrección por coincidencia exacta: un campo clínicamente razonable pero con otro formato igual falla el caso.",
        )}</li>
      </ul>
    </div>
  </div>
</section>`;
}

function renderFooter() {
  return `<footer id="footer">
  <div class="wrap">
    <p>${t("Part of", "Parte de")} <a href="https://dev0p.com" rel="noopener">dev0p.com</a></p>
  </div>
</footer>`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function renderReport({ models, cases }) {
  const notRun = models.notRun ?? [];
  const latestMeta = models
    .filter((model) => model.source === "run")
    .map((model) => model.meta ?? {})
    .sort((a, b) => String(b.finished_at ?? "").localeCompare(String(a.finished_at ?? "")))[0];

  const hashes = {
    dataset: String(latestMeta?.dataset_hash ?? datasetHash()).slice(0, 12),
    prompt: String(latestMeta?.prompt_hash ?? promptHash()).slice(0, 12),
  };
  const lastRunAt = latestMeta?.finished_at ?? null;

  const caseById = new Map(cases.map((testCase) => [testCase.id, testCase]));
  const explorer = { cases: [], rows: [] };
  const usedCaseIds = new Set();

  for (const model of models) {
    if (!Array.isArray(model.rows) || model.rows.length === 0) continue;
    const grouped = new Map();
    for (const row of model.rows) {
      grouped.set(row.case_id, [...(grouped.get(row.case_id) ?? []), row]);
    }
    for (const [caseId, rows] of grouped) {
      const testCase = caseById.get(caseId);
      if (!testCase) continue;
      usedCaseIds.add(caseId);
      const reps = rows
        .slice()
        .sort((a, b) => Number(a.rep ?? 1) - Number(b.rep ?? 1))
        .map((row) => ({
          rep: Number(row.rep ?? 1),
          pass: row.pass === true,
          outcome: row.outcome ?? null,
          raw: String(row.raw_text ?? ""),
          failed: failedChecks(row),
        }));
      explorer.rows.push({
        case: caseId,
        category: testCase.category,
        model: model.key,
        reference: model.reference,
        pass: reps.every((rep) => rep.pass),
        reps,
      });
    }
  }

  explorer.rows.sort(
    (a, b) => a.case.localeCompare(b.case) || a.model.localeCompare(b.model),
  );
  explorer.cases = [...usedCaseIds].sort().map((id) => {
    const testCase = caseById.get(id);
    return {
      id,
      category: testCase.category,
      message: testCase.message,
      expect: testCase.expect,
    };
  });

  const explorerJson = jsonForScript({ cases: explorer.cases, rows: explorer.rows });

  return `<!doctype html>
<html lang="en" data-lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Front-desk intake benchmark</title>
<meta name="description" content="Reproducible benchmark for the front-desk intake step of a medical clinic: structured action, abstention, escalation, medical-advice refusal and prompt-injection resistance." />
<style>
${STYLE}
</style>
<script>
try {
  var stored = localStorage.getItem("bench-lang");
  if (stored === "en" || stored === "es") {
    document.documentElement.setAttribute("data-lang", stored);
    document.documentElement.setAttribute("lang", stored);
  }
} catch (error) {}
</script>
</head>
<body>
${renderHeader({ models, lastRunAt, hashes, notRun })}
<main>
${renderLeaderboard(models)}
${renderScatter(models)}
${renderMatrix(models)}
${renderExplorer(models, explorer)}
${renderMethodology()}
</main>
${renderFooter()}
<script id="explorer-data" type="application/json">${explorerJson}</script>
<script>
(function () {
  "use strict";

  var root = document.documentElement;
  var toggle = document.getElementById("lang-toggle");

  // <option> cannot contain markup, so its label is swapped from data attributes.
  function syncOptionLabels() {
    var lang = root.getAttribute("data-lang") === "es" ? "es" : "en";
    var options = document.querySelectorAll("option[data-en]");
    for (var i = 0; i < options.length; i += 1) {
      options[i].textContent = options[i].getAttribute("data-" + lang) || options[i].getAttribute("data-en");
    }
  }

  function applyLang(lang) {
    root.setAttribute("data-lang", lang);
    root.setAttribute("lang", lang);
    syncOptionLabels();
  }

  if (toggle) {
    toggle.addEventListener("click", function () {
      var next = root.getAttribute("data-lang") === "es" ? "en" : "es";
      applyLang(next);
      try {
        localStorage.setItem("bench-lang", next);
      } catch (error) {}
    });
  }

  syncOptionLabels();

  var dataNode = document.getElementById("explorer-data");
  var categorySelect = document.getElementById("filter-category");
  var modelSelect = document.getElementById("filter-model");
  var caseNodes = Array.prototype.slice.call(document.querySelectorAll("details.case"));
  var counters = Array.prototype.slice.call(document.querySelectorAll(".js-count"));

  var rows = [];
  try {
    rows = JSON.parse(dataNode.textContent).rows || [];
  } catch (error) {
    rows = [];
  }

  function keyOf(caseId, model) {
    return model + "\\u0000" + caseId;
  }

  function applyFilters() {
    var category = categorySelect ? categorySelect.value : "all";
    var model = modelSelect ? modelSelect.value : "all";
    var visible = {};

    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      if (category !== "all" && row.category !== category) continue;
      if (model !== "all" && row.model !== model) continue;
      visible[keyOf(row.case, row.model)] = true;
    }

    var shown = 0;
    for (var j = 0; j < caseNodes.length; j += 1) {
      var node = caseNodes[j];
      var on = visible[keyOf(node.getAttribute("data-case"), node.getAttribute("data-model"))] === true;
      node.hidden = !on;
      if (on) shown += 1;
    }

    for (var k = 0; k < counters.length; k += 1) counters[k].textContent = String(shown);
  }

  if (categorySelect) categorySelect.addEventListener("change", applyFilters);
  if (modelSelect) modelSelect.addEventListener("change", applyFilters);
  applyFilters();
})();
</script>
</body>
</html>
`;
}

const STYLE = `
:root {
  --bg: #0b1015;
  --bg-elev: #121a21;
  --bg-soft: #172129;
  --fg: #e6edf3;
  --fg-muted: #9fadba;
  --fg-faint: #74828f;
  --border: #223039;
  --border-strong: #33434e;
  --accent: #4fd1c5;
  --accent-soft: rgba(79, 209, 197, 0.18);
  --danger: #f87171;
  --ok: #4ade80;
  --radius: 10px;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  color-scheme: dark;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #fbfcfd;
    --bg-elev: #ffffff;
    --bg-soft: #f2f5f7;
    --fg: #101a21;
    --fg-muted: #4a5a66;
    --fg-faint: #6d7d89;
    --border: #dbe3e8;
    --border-strong: #c3ced5;
    --accent: #0f766e;
    --accent-soft: rgba(15, 118, 110, 0.14);
    --danger: #b42318;
    --ok: #15803d;
    color-scheme: light;
  }
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--sans);
  font-size: 16px;
  line-height: 1.6;
  font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 1100px; margin: 0 auto; padding: 0 20px; }
a { color: var(--accent); text-decoration: none; border-bottom: 1px solid var(--accent-soft); }
a:hover { border-bottom-color: var(--accent); }
code, pre { font-family: var(--mono); }
code { font-size: 0.85em; color: var(--fg-muted); }
h1, h2, h3 { line-height: 1.2; font-weight: 650; letter-spacing: -0.01em; }
h1 { font-size: clamp(1.7rem, 4.5vw, 2.4rem); margin: 10px 0 12px; }
h2 { font-size: 1.35rem; margin: 0 0 8px; display: flex; align-items: baseline; gap: 10px; }
h3 { font-size: 1rem; margin: 26px 0 4px; color: var(--fg); }
p { margin: 0 0 10px; }
ul { margin: 0 0 10px; padding-left: 20px; }
li { margin-bottom: 6px; }
[data-l="es"] { display: none; }
[data-lang="es"] [data-l="en"] { display: none; }
[data-lang="es"] [data-l="es"] { display: revert; }
[hidden] { display: none !important; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

header { border-bottom: 1px solid var(--border); padding: 40px 0 30px; }
.header-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.eyebrow { margin: 0; font-family: var(--mono); font-size: 0.72rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--accent); }
.lede { color: var(--fg-muted); max-width: 68ch; font-size: 1.02rem; }
.meta { display: flex; flex-wrap: wrap; gap: 6px 22px; font-family: var(--mono); font-size: 0.78rem; color: var(--fg-faint); margin: 14px 0 0; }
.meta strong { color: var(--fg-muted); font-weight: 600; }
.meta code { color: var(--fg-muted); }
.meta a { border: 0; }
.note { color: var(--fg-faint); font-size: 0.85rem; margin: 6px 0 16px; }
.note:last-child { margin-bottom: 0; }
.lang-btn {
  appearance: none; background: var(--bg-elev); color: var(--fg-muted);
  border: 1px solid var(--border-strong); border-radius: 999px;
  padding: 5px 14px; font: inherit; font-size: 0.78rem; letter-spacing: 0.08em;
  cursor: pointer;
}
.lang-btn:hover { color: var(--fg); border-color: var(--accent); }

section { padding: 40px 0; border-bottom: 1px solid var(--border); }
section h2 .num { font-family: var(--mono); font-size: 0.75rem; color: var(--fg-faint); letter-spacing: 0.1em; }
.prose { max-width: 78ch; color: var(--fg-muted); }
.prose strong { color: var(--fg); font-weight: 600; }

.table-wrap { overflow-x: auto; max-width: 100%; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elev); }
table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
table.leaderboard { min-width: 900px; font-size: 0.84rem; }
table.matrix { min-width: 720px; }
th, td { padding: 10px 12px; text-align: right; border-bottom: 1px solid var(--border); white-space: nowrap; }
table.leaderboard th, table.leaderboard td { padding: 9px 10px; }
table.leaderboard thead th { white-space: normal; vertical-align: bottom; }
.rate { white-space: nowrap; }
.n { display: block; font-size: 0.72rem; }
thead th { font-size: 0.72rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--fg-faint); background: var(--bg-soft); position: sticky; top: 0; }
tbody th, tbody td { font-variant-numeric: tabular-nums; }
tbody tr:last-child th, tbody tr:last-child td { border-bottom: 0; }
th.model-cell, th.row-head { text-align: left; font-weight: 600; white-space: normal; min-width: 170px; }
table.leaderboard th.model-cell,
table.matrix th.model-cell,
table.leaderboard th.row-head,
table.matrix th.row-head { position: sticky; left: 0; z-index: 1; background: var(--bg-elev); }
table.leaderboard thead th.model-cell,
table.matrix thead th.model-cell { z-index: 2; background: var(--bg-soft); }
table.leaderboard tr.reference th.model-cell,
table.matrix tr.reference th.model-cell { background: var(--bg-soft); }
.model-name { font-family: var(--mono); font-size: 0.86rem; white-space: nowrap; }
tr.reference th, tr.reference td { color: var(--fg-muted); background: var(--bg-soft); }
tr.reference .model-name { font-style: italic; }
.ref-tag {
  display: inline-block; font-size: 0.6rem; font-family: var(--mono);
  letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--fg-faint); border: 1px solid var(--border-strong);
  border-radius: 999px; padding: 0 7px; line-height: 1.6;
}
.ref-tag.warn { color: var(--danger); border-color: var(--danger); }
td.bad { color: var(--danger); font-weight: 600; }
.muted { color: var(--fg-muted); }
.small { font-size: 0.76rem; }
td.na, .na { color: var(--fg-faint); }

.scroll-x { overflow-x: auto; max-width: 100%; }
svg { display: block; width: 100%; min-width: 720px; height: auto; }
.plot { fill: var(--bg-elev); stroke: var(--border); }
.grid { stroke: var(--border); stroke-width: 1; }
.grid.minor { stroke: var(--border); opacity: 0.45; }
.tick { fill: var(--fg-faint); font-size: 12px; font-family: var(--mono); }
.axis-title { fill: var(--fg-muted); font-size: 12px; }
.lane { fill: var(--bg-soft); stroke: var(--border); stroke-dasharray: 4 4; }
.lane-sep { stroke: var(--border-strong); stroke-dasharray: 3 5; }
.lane-label { fill: var(--fg-faint); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; }
.pt circle { fill: var(--accent); stroke: var(--bg); stroke-width: 2; }
.pt.ref circle { fill: var(--bg-elev); stroke: var(--fg-faint); }
.pt-label { fill: var(--fg); font-size: 12px; font-family: var(--mono); paint-order: stroke; stroke: var(--bg); stroke-width: 3px; stroke-linejoin: round; }
.pt.ref .pt-label { fill: var(--fg-muted); }
details.data-table { margin-top: 14px; }
details.data-table > summary { cursor: pointer; color: var(--fg-faint); font-size: 0.8rem; }

table.matrix th.cat { text-align: center; vertical-align: bottom; white-space: normal; }
table.matrix .cat-name { font-size: 0.68rem; line-height: 1.25; display: inline-block; max-width: 74px; }
table.matrix td { text-align: center; font-weight: 600; font-size: 0.84rem; }
table.matrix tr.reference td { font-weight: 500; }

.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; margin: 0 0 16px; }
.filters label { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--fg-faint); }
.filters select {
  appearance: none; background: var(--bg-elev); color: var(--fg);
  border: 1px solid var(--border-strong); border-radius: 8px;
  padding: 7px 12px; font: inherit; font-size: 0.86rem; max-width: 100%;
}
.cases { border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elev); overflow: hidden; }
details.case { border-bottom: 1px solid var(--border); }
details.case:last-child { border-bottom: 0; }
details.case > summary {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px;
  padding: 10px 14px; cursor: pointer; list-style: none;
}
details.case > summary::-webkit-details-marker { display: none; }
details.case > summary::before { content: "\\25B8"; color: var(--fg-faint); font-size: 0.8em; }
details.case[open] > summary::before { content: "\\25BE"; }
details.case > summary:hover { background: var(--bg-soft); }
.case-id { font-family: var(--mono); font-size: 0.84rem; color: var(--fg); min-width: 74px; }
.case-tag { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--fg-faint); }
.case-model { font-family: var(--mono); font-size: 0.78rem; color: var(--fg-muted); margin-left: auto; }
.badge { font-size: 0.72rem; font-weight: 600; border-radius: 999px; padding: 1px 9px; border: 1px solid transparent; }
.badge.pass { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, transparent); background: color-mix(in srgb, var(--ok) 12%, transparent); }
.badge.fail { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, transparent); background: color-mix(in srgb, var(--danger) 12%, transparent); }
.case-body { display: grid; gap: 14px; padding: 4px 16px 18px; border-left: 2px solid var(--accent-soft); }
.field .label { display: block; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.07em; color: var(--fg-faint); margin-bottom: 4px; }
.field p { margin: 0; overflow-wrap: anywhere; }
.message { font-size: 0.94rem; }
pre.expected, pre.out {
  margin: 0; padding: 10px 12px; background: var(--bg-soft);
  border: 1px solid var(--border); border-radius: 8px;
  font-size: 0.82rem; line-height: 1.5;
  white-space: pre-wrap; overflow-wrap: anywhere; overflow-x: auto;
}
pre.out { max-height: 260px; overflow-y: auto; }
.case-rep { display: grid; gap: 12px; padding-top: 4px; border-top: 1px dashed var(--border); }
.case-rep:first-of-type { border-top: 0; }
.rep-label { font-family: var(--mono); font-size: 0.74rem; color: var(--fg-faint); margin: 0; }
ul.failed { margin: 0; padding-left: 18px; font-family: var(--mono); font-size: 0.82rem; color: var(--danger); }

footer { padding: 30px 0 54px; color: var(--fg-faint); font-size: 0.85rem; }
footer p { margin: 0; }

@media (max-width: 620px) {
  body { font-size: 15px; }
  .wrap { padding: 0 14px; }
  header { padding: 30px 0 24px; }
  section { padding: 32px 0; }
  .case-model { margin-left: 0; }
  th, td { padding: 9px 10px; }
}
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
`;

/**
 * Builds the page (and optionally writes it).
 * @returns {{html: string, models: object[], outFile: string|null}}
 */
export function buildReport({ rootDir = ROOT_DIR, outFile = null, config } = {}) {
  const models = collectModels({ rootDir, config });
  if (models.length === 0) throw new Error("no runs or reference baselines found");

  const cfg = config ?? readJson(path.join(rootDir, "bench.config.json"));
  const shown = new Set(models.map((model) => model.key));
  models.notRun = Object.keys(cfg.models ?? {}).filter((key) => !shown.has(key));

  const cases = loadCases();
  const html = renderReport({ models, cases });

  if (outFile) {
    mkdirSync(path.dirname(outFile), { recursive: true });
    writeFileSync(outFile, html);
  }

  return { html, models, outFile };
}

export function parseArgs(argv = []) {
  const args = { out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--out") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--out needs a value");
      args.out = path.resolve(value);
      i += 1;
    } else {
      throw new Error(`unknown flag: ${flag}`);
    }
  }
  return args;
}

export function main(argv = [], { log = (line) => console.log(line) } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  }

  const { models, outFile } = buildReport({ outFile: args.out });
  const refs = models.filter((model) => model.reference).length;
  log(
    `wrote ${outFile} (${models.length} models, ${refs} reference, ${models.notRun.length} not yet run)`,
  );
  return 0;
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}
