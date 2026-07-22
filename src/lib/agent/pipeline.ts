/**
 * investigate v2 pipeline — dataset-agnostic, decoupled from Trigger runtime.
 *
 * Steps (RunStep from contracts, strict validation before each emit):
 *   exploring      → phase A: cheap catalog of ALL visible tables (explore.ts);
 *   generating_sql → triage on fast model (triage.ts): decision
 *                    proceed/clarify/impossible, table and card selection;
 *   clarify        → agent needs clarification: question+options go to UI,
 *                    run ends with empty done (answer comes via new /api/ask);
 *   impossible     → data cannot answer: reason + what data CAN answer;
 *   board_planned  → card manifest [{cardId, kind, title}] — UI draws
 *                    dashboard SKELETONS immediately, before any SQL (fast preview);
 *   exploring      → phase B: deep exploration of ONLY selected tables;
 *   card_ready /   → cards execute IN PARALLEL (cardRunner seam: default
 *   card_failed      Promise.all in-process, in Trigger run — child runs
 *                    investigate-card); each card generates its own SQL
 *                    (executing → healing up to 3 attempts → card_ready|card_failed);
 *   done           → all successful ViewSpecs (validated viewSpecSchema.parse);
 *   error          → terminal failure: NOT ONE card of the plan succeeded.
 *
 * Trigger task (src/trigger/investigate.ts) passes emit writing steps to
 * run metadata (Realtime); smoke script prints them to stdout. Same logic.
 */
import type { ClickHouseClient } from "@clickhouse/client";
import { createReadonlyClient } from "@/lib/clickhouse";
import {
  detectAnswerLanguage,
  runStepSchema,
  viewSpecSchema,
  type AnswerLanguage,
  type AskRequest,
  type ClickTarget,
  type RunStep,
  type ViewSpec,
} from "@/lib/contracts";
import { exploreTables, getCatalog, type SchemaContext } from "./explore";
import {
  triageQuestion,
  type TriageCard,
  type TriageInput,
  type TriageResult,
} from "./triage";
import {
  annotateCard,
  generateCardSql,
  healSql,
  sanitizeSql,
  summarizeVerdict,
  type CardAnnotation,
  type GenerateCardSqlInput,
  type GeneratedSql,
  type VerdictSummary,
} from "./generate-sql";

export type StepEmitter = (step: RunStep) => void | Promise<void>;

export type PipelineOptions = {
  emit: StepEmitter;
  /** Client injection for tests; by default created and closed internally. */
  readonlyClient?: ClickHouseClient;
  /** Test seam: triage override (smokes force plan without fast model). */
  triageImpl?: (input: TriageInput) => Promise<TriageResult>;
  /**
   * Test seam: per-card SQL generation override (heal-smoke injects broken
   * SQL). Works only for in-process card execution: do not serialize the
   * function into child Trigger runs.
   */
  cardSqlImpl?: (input: GenerateCardSqlInput) => Promise<GeneratedSql>;
  /**
   * Plan card execution seam. Default — runCardsInProcess (Promise.all in
   * current process): used by smoke scripts, also fallback. Trigger task
   * investigate substitutes executor on parallel child runs
   * (batch.triggerByTaskAndWait → investigate-card, see src/trigger/investigate.ts).
   */
  cardRunner?: CardRunner;
};

export type PipelineResult = {
  viewSpecs: ViewSpec[];
  /** Final SQL of successful cards (with header comments). */
  sql: string;
  /** Total execution attempts across all cards. */
  attempts: number;
};

/** Max SQL execution attempts (healing step between them). */
export const MAX_SQL_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// SQL execution
// ---------------------------------------------------------------------------

type ResultRow = Record<string, unknown>;

async function executeSql(client: ClickHouseClient, sql: string): Promise<ResultRow[]> {
  const rs = await client.query({
    query: sql,
    format: "JSONEachRow",
    clickhouse_settings: {
      // Safety on top of server agent_ro limits (A5) and max_execution_time from factory.
      max_result_rows: "10000",
      result_overflow_mode: "break",
    },
  });
  return rs.json<ResultRow>();
}

// ---------------------------------------------------------------------------
// ViewSpec assembly from result rows
// ---------------------------------------------------------------------------

/** UInt64 and Decimal come from JSONEachRow as strings — coerce numeric strings. */
function toCell(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    if (/^-?\d+(\.\d+)?$/.test(value)) {
      const n = Number(value);
      if (Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER) return n;
    }
    return value;
  }
  return JSON.stringify(value);
}

function requireColumns(row: ResultRow, kind: string, columns: string[]): void {
  const missing = columns.filter((c) => !(c in row));
  if (missing.length > 0) {
    throw new Error(
      `${kind}-SQL must return columns ${columns.map((c) => `\`${c}\``).join(", ")} — missing: ${missing.join(", ")}`,
    );
  }
}

/**
 * Build ViewSpec of the chosen kind from result rows. Data shape conventions —
 * see generate-sql.ts. viewSpecSchema.parse validation done by caller.
 *
 * Click targets are generic: any click follows one path — new agent run (action
 * 'why') with ClickContext; labels are neutral, no dataset-specific drilldowns.
 * annotation (insight/metricNote) — from annotateCard on actual rows;
 * added to all chart kinds (verdict — self-contained conclusion).
 */
function buildViewSpec(
  generated: GeneratedSql,
  rows: ResultRow[],
  verdictSummary?: VerdictSummary,
  annotation?: CardAnnotation,
): unknown {
  if (rows.length === 0) {
    throw new Error("SQL returned 0 rows — nothing to build the card from");
  }
  /** Optional annotation fields — in spread-ready form for the spec. */
  const note = annotation
    ? {
        insight: annotation.insight,
        ...(annotation.metricNote ? { metricNote: annotation.metricNote } : {}),
      }
    : {};
  switch (generated.kind) {
    case "timeline": {
      // Optional `series` column splits points across multiple lines.
      const bySeries = new Map<string, { t: string; v: number }[]>();
      for (const row of rows) {
        requireColumns(row, "timeline", ["t", "v"]);
        const name =
          "series" in row && row.series != null && row.series !== ""
            ? String(row.series)
            : generated.title;
        const points = bySeries.get(name) ?? [];
        points.push({ t: String(row.t), v: Number(row.v) });
        bySeries.set(name, points);
      }
      const clicks: ClickTarget[] = [
        {
          on: "point",
          selectionKeys: ["t", "series"],
          label: "Разобраться с этим моментом",
        },
      ];
      return {
        kind: "timeline",
        title: generated.title,
        series: [...bySeries].map(([name, points]) => ({ name, points })),
        ...(generated.anomalyWindow ? { anomalyWindow: generated.anomalyWindow } : {}),
        clicks,
        ...note,
      };
    }
    case "leaderboard": {
      const keys = Object.keys(rows[0]);
      // First column — entity (generate-sql.ts convention); row click
      // carries its value as context into a new agent run.
      const clicks: ClickTarget[] = [
        {
          on: "row",
          selectionKeys: [keys[0]],
          label: "Разобраться с этой строкой",
        },
      ];
      return {
        kind: "leaderboard",
        title: generated.title,
        columns: keys.map((key) => ({ key, label: key })),
        rows: rows.map((row) =>
          Object.fromEntries(keys.map((key) => [key, toCell(row[key])])),
        ),
        clicks,
        ...note,
      };
    }
    case "histogram": {
      const buckets = rows.map((row) => {
        requireColumns(row, "histogram", ["label", "count"]);
        return { label: String(row.label), count: Math.round(Number(row.count)) };
      });
      const clicks: ClickTarget[] = [
        {
          on: "bucket",
          selectionKeys: ["label"],
          label: "Что попало в эту корзину?",
        },
      ];
      return {
        kind: "histogram",
        title: generated.title,
        bucketLabel: generated.bucketLabel ?? generated.title,
        buckets,
        clicks,
        ...note,
      };
    }
    case "heatmap": {
      const xLabels: string[] = [];
      const yLabels: string[] = [];
      const cells = rows.map((row) => {
        requireColumns(row, "heatmap", ["x", "y", "value"]);
        const x = String(row.x);
        const y = String(row.y);
        if (!xLabels.includes(x)) xLabels.push(x);
        if (!yLabels.includes(y)) yLabels.push(y);
        return { x, y, value: Number(row.value) };
      });
      const clicks: ClickTarget[] = [
        {
          on: "cell",
          selectionKeys: ["x", "y"],
          label: "Разобраться с этим слотом",
        },
      ];
      return {
        kind: "heatmap",
        title: generated.title,
        xLabels,
        yLabels,
        cells,
        clicks,
        ...note,
      };
    }
    case "verdict": {
      // Convention: one aggregate row, each column — evidence stat.
      const evidence = Object.entries(rows[0]).map(([label, value]) => ({
        label: label.replace(/_/g, " "),
        value: toCell(value) ?? "—",
      }));
      // Verdict and confidence written by second LLM call on actual numbers;
      // on its failure — title as verdict with low confidence.
      return {
        kind: "verdict",
        verdict: verdictSummary?.verdict ?? generated.title,
        confidence: verdictSummary?.confidence ?? "low",
        evidence,
      };
    }
    case "bignumber": {
      // Convention: EXACTLY one row, column `value` (+ opt. delta/label/detail).
      if (rows.length !== 1) {
        throw new Error(
          `bignumber-SQL must return EXACTLY one row — got ${rows.length}`,
        );
      }
      const row = rows[0];
      requireColumns(row, "bignumber", ["value"]);
      const value = toCell(row.value);
      if (value === null) {
        throw new Error("bignumber-SQL: column `value` must not be NULL");
      }
      const delta = row.delta != null ? Number(row.delta) : undefined;
      if (delta !== undefined && !Number.isFinite(delta)) {
        throw new Error(
          "bignumber-SQL: column `delta` must be a number — percent change vs baseline",
        );
      }
      return {
        kind: "bignumber",
        title: generated.title,
        value,
        // Metric label — from `label` column, else card title.
        label:
          row.label != null && row.label !== "" ? String(row.label) : generated.title,
        ...(delta !== undefined ? { delta } : {}),
        ...(row.detail != null && row.detail !== ""
          ? { detail: String(row.detail) }
          : {}),
        ...note,
      };
    }
    case "scatter": {
      // Convention: columns `x`, `y` — numbers, opt. `label` — entity name.
      const points = rows.map((row) => {
        requireColumns(row, "scatter", ["x", "y"]);
        const px = Number(row.x);
        const py = Number(row.y);
        if (!Number.isFinite(px) || !Number.isFinite(py)) {
          throw new Error(
            "scatter-SQL: columns `x` and `y` must be numbers (numeric point metrics)",
          );
        }
        return {
          x: px,
          y: py,
          ...(row.label != null && row.label !== ""
            ? { label: String(row.label) }
            : {}),
        };
      });
      const hasLabels = points.some((p) => "label" in p);
      const clicks: ClickTarget[] = [
        {
          on: "point",
          selectionKeys: hasLabels ? ["label", "x", "y"] : ["x", "y"],
          label: "Разобраться с этой точкой",
        },
      ];
      return {
        kind: "scatter",
        title: generated.title,
        points,
        xLabel: generated.xLabel ?? "x",
        yLabel: generated.yLabel ?? "y",
        ...(generated.xScale ? { xScale: generated.xScale } : {}),
        ...(generated.yScale ? { yScale: generated.yScale } : {}),
        clicks,
        ...note,
      };
    }
    case "map": {
      // Convention: `lat`/`lon` — WGS84 degrees; opt. `value` (aggregate) and `label`.
      if (rows.length > 1000) {
        throw new Error(
          `map-SQL returned ${rows.length} points — aggregate coordinates (round + count) and add LIMIT 1000`,
        );
      }
      const points = rows.map((row) => {
        requireColumns(row, "map", ["lat", "lon"]);
        const lat = Number(row.lat);
        const lon = Number(row.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          throw new Error("map-SQL: columns `lat` and `lon` must be numbers (degrees)");
        }
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
          throw new Error(
            `map-SQL: coordinates out of range (lat=${lat}, lon=${lon}) — filter junk values in WHERE`,
          );
        }
        const value = row.value != null ? Number(row.value) : undefined;
        if (value !== undefined && !Number.isFinite(value)) {
          throw new Error("map-SQL: column `value` must be a number (point weight)");
        }
        return {
          lat,
          lon,
          ...(value !== undefined ? { value } : {}),
          ...(row.label != null && row.label !== "" ? { label: String(row.label) } : {}),
        };
      });
      const hasLabels = points.some((p) => "label" in p);
      const clicks: ClickTarget[] = [
        {
          on: "point",
          selectionKeys: hasLabels ? ["label", "lat", "lon"] : ["lat", "lon"],
          label: "Разобраться с этой точкой",
        },
      ];
      return {
        kind: "map",
        title: generated.title,
        points,
        ...(generated.valueLabel ? { valueLabel: generated.valueLabel } : {}),
        clicks,
        ...note,
      };
    }
    case "graph": {
      // Convention: `source`/`target` pairs (+ opt. `weight`). Nodes, sizes and
      // anomaly scores derived by code from weighted node degree.
      if (rows.length > 500) {
        throw new Error(
          `graph-SQL returned ${rows.length} pairs — aggregate pairs (GROUP BY + count() AS weight) and add LIMIT 200`,
        );
      }
      // Dedup undirected pairs: weight summed, self-loops dropped.
      const byPair = new Map<string, { source: string; target: string; weight: number }>();
      for (const row of rows) {
        requireColumns(row, "graph", ["source", "target"]);
        const source = String(row.source).trim();
        const target = String(row.target).trim();
        if (!source || !target) {
          throw new Error(
            "graph-SQL: `source` and `target` must be non-empty strings (entity names)",
          );
        }
        if (source === target) continue;
        const weight = row.weight != null ? Number(row.weight) : 1;
        if (!Number.isFinite(weight) || weight < 0) {
          throw new Error("graph-SQL: column `weight` must be a number ≥ 0 (edge strength)");
        }
        const [a, b] = source < target ? [source, target] : [target, source];
        const key = `${a}\u0000${b}`;
        const prev = byPair.get(key);
        if (prev) prev.weight += weight;
        else byPair.set(key, { source: a, target: b, weight });
      }
      const edges = [...byPair.values()];
      if (edges.length === 0) {
        throw new Error(
          "graph-SQL: no pairs left after dropping self-loops — return edges between DIFFERENT entities",
        );
      }
      // Weighted node degree → size (area) and score (color "heat").
      const degree = new Map<string, number>();
      for (const e of edges) {
        degree.set(e.source, (degree.get(e.source) ?? 0) + e.weight);
        degree.set(e.target, (degree.get(e.target) ?? 0) + e.weight);
      }
      const maxDegree = Math.max(...degree.values(), 1);
      const nodes = [...degree.entries()].map(([id, deg]) => {
        const norm = deg / maxDegree;
        return {
          id,
          label: id,
          score: Math.round(norm * 100) / 100,
          size: 4 + Math.sqrt(norm) * 28,
        };
      });
      return {
        kind: "graph",
        title: generated.title,
        nodes,
        edges: edges.map((e) => ({ source: e.source, target: e.target, weight: e.weight })),
        maxNodes: 50,
        ...note,
      };
    }
    case "treemap": {
      // Convention: `label`, `value` (> 0), opt. `group`; tail collapsed in SQL.
      if (rows.length > 60) {
        throw new Error(
          `treemap-SQL returned ${rows.length} rows — collapse tail into "other" and add LIMIT 40`,
        );
      }
      const items = rows
        .map((row) => {
          requireColumns(row, "treemap", ["label", "value"]);
          const value = Number(row.value);
          if (!Number.isFinite(value)) {
            throw new Error("treemap-SQL: column `value` must be a number (tile size)");
          }
          return {
            label: String(row.label),
            value,
            ...(row.group != null && row.group !== "" ? { group: String(row.group) } : {}),
          };
        })
        .filter((it) => it.value > 0);
      if (items.length === 0) {
        throw new Error(
          "treemap-SQL: all `value` ≤ 0 — tile area is built only from positive magnitudes",
        );
      }
      const hasGroups = items.some((it) => "group" in it);
      const clicks: ClickTarget[] = [
        {
          on: "tile",
          selectionKeys: hasGroups ? ["label", "group"] : ["label"],
          label: "Разобраться с этой частью",
        },
      ];
      return {
        kind: "treemap",
        title: generated.title,
        items,
        ...(generated.valueLabel ? { valueLabel: generated.valueLabel } : {}),
        clicks,
        ...note,
      };
    }
    case "funnel": {
      // Convention: `label`, `count` in stage order (wide → narrow).
      if (rows.length < 2) {
        throw new Error("funnel-SQL must return at least 2 stages (rows)");
      }
      if (rows.length > 12) {
        throw new Error(
          `funnel-SQL returned ${rows.length} stages — funnel readable up to ~8, merge steps`,
        );
      }
      const stages = rows.map((row) => {
        requireColumns(row, "funnel", ["label", "count"]);
        const count = Number(row.count);
        if (!Number.isFinite(count) || count < 0) {
          throw new Error("funnel-SQL: column `count` must be a number ≥ 0 (stage counter)");
        }
        return { label: String(row.label), count: Math.round(count) };
      });
      const clicks: ClickTarget[] = [
        {
          on: "bucket",
          selectionKeys: ["label"],
          label: "Кто отвалился на этом этапе?",
        },
      ];
      return {
        kind: "funnel",
        title: generated.title,
        stages,
        clicks,
        ...note,
      };
    }
    case "boxplot": {
      // Convention: `label` + five ascending quantiles lo/q1/med/q3/hi per group.
      if (rows.length > 30) {
        throw new Error(
          `boxplot-SQL returned ${rows.length} groups — boxplot readable up to ~15, coarsen groups`,
        );
      }
      const groups = rows.map((row) => {
        requireColumns(row, "boxplot", ["label", "lo", "q1", "med", "q3", "hi"]);
        const nums = (["lo", "q1", "med", "q3", "hi"] as const).map((k) => Number(row[k]));
        if (nums.some((n) => !Number.isFinite(n))) {
          throw new Error(
            "boxplot-SQL: columns `lo`, `q1`, `med`, `q3`, `hi` must be numbers (metric quantiles)",
          );
        }
        const [lo, q1, med, q3, hi] = nums;
        if (!(lo <= q1 && q1 <= med && med <= q3 && q3 <= hi)) {
          throw new Error(
            "boxplot-SQL: quantiles non-monotonic (need lo ≤ q1 ≤ med ≤ q3 ≤ hi) — check order in quantiles(0.05, 0.25, 0.5, 0.75, 0.95)",
          );
        }
        return { label: String(row.label), lo, q1, med, q3, hi };
      });
      const clicks: ClickTarget[] = [
        {
          on: "box",
          selectionKeys: ["label"],
          label: "Разобраться с этой группой",
        },
      ];
      return {
        kind: "boxplot",
        title: generated.title,
        ...(generated.valueLabel ? { valueLabel: generated.valueLabel } : {}),
        groups,
        clicks,
        ...note,
      };
    }
    default: {
      // Compiler guarantees: all kinds handled above.
      const unreachable: never = generated.kind;
      throw new Error(`unknown card kind: ${String(unreachable)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Bilingual progress string picker by run language. Reasoning must speak in
 * answer language (same detectAnswerLanguage from question text). Technical
 * step fields (cardId, sqlPreview, table names) are not translated.
 */
function pickText(language: AnswerLanguage): (ru: string, en: string) => string {
  return (ru, en) => (language === "Russian" ? ru : en);
}

export function cardTitle(card: TriageCard): string {
  return card.title;
}

/** Card label in step messages: in a plan with >1 card — in «guillemets». */
export function cardLabel(card: TriageCard, manyCards: boolean): string {
  return manyCards ? `«${card.title}»` : card.title;
}

export type CardOutcome =
  | { ok: true; spec: ViewSpec; sql?: string; attempts: number }
  | { ok: false; error: string; attempts: number };

/** Card executor context. */
export type CardRunnerContext = {
  ro: ClickHouseClient;
  emit: StepEmitter;
  input: AskRequest;
  schemaContext: SchemaContext[];
  /** Test seam for per-card generation (in-process only). */
  cardSqlImpl?: (input: GenerateCardSqlInput) => Promise<GeneratedSql>;
};

/**
 * Plan card executor (PipelineOptions.cardRunner seam): receives all
 * cards at once and must return outcome for EACH (one card failure —
 * CardOutcome {ok:false}, not an exception).
 */
export type CardRunner = (
  cards: TriageCard[],
  ctx: CardRunnerContext,
) => Promise<CardOutcome[]>;

/**
 * Single card: SQL generation → executing → (healing → executing)* →
 * card_ready | card_failed. Never throws: any outcome — CardOutcome.
 * Shared entry point for default runner and child Trigger task investigate-card.
 */
export async function runPlannedCard(
  card: TriageCard,
  ctx: CardRunnerContext & { label: string },
): Promise<CardOutcome> {
  const { ro, emit, input, schemaContext, label } = ctx;
  const t = pickText(detectAnswerLanguage(input.question));

  // This card's SQL is written here (on child worker) — cards of one
  // plan generate and execute in parallel.
  await emit({
    step: "generating_sql",
    message: t(
      `${label} — пишу SQL под карточку ${card.kind}`,
      `${label} — writing SQL for the ${card.kind} card`,
    ),
  });
  let generated: GeneratedSql;
  try {
    generated = await (ctx.cardSqlImpl ?? generateCardSql)({
      question: input.question,
      schemaContext,
      clickContext: input.context,
      card: { kind: card.kind, title: card.title, ...(card.hint ? { hint: card.hint } : {}) },
    });
  } catch (err) {
    const error = t(
      `${label}: не удалось сгенерировать SQL — ${truncate(errorMessage(err))}`,
      `${label}: failed to generate SQL — ${truncate(errorMessage(err))}`,
    );
    await emit({ step: "card_failed", cardId: card.cardId, error, message: error });
    return { ok: false, error, attempts: 0 };
  }

  const attemptErrors: string[] = [];
  for (let attempt = 1; attempt <= MAX_SQL_ATTEMPTS; attempt++) {
    await emit({
      step: "executing",
      sqlPreview: generated.sql,
      message:
        attempt === 1
          ? label
          : t(
              `${label} — попытка ${attempt} из ${MAX_SQL_ATTEMPTS}`,
              `${label} — attempt ${attempt} of ${MAX_SQL_ATTEMPTS}`,
            ),
    });
    try {
      // Sanitize (SELECT only, one statement) — safety on top of agent_ro;
      // its error also goes into self-healing.
      const sql = sanitizeSql(generated.sql);
      const rows = await executeSql(ro, sql);

      // Second short LLM call on actual numbers (fast tier):
      //   - verdict → conclusion + confidence (summarizeVerdict);
      //   - other kinds → insight/metricNote annotation (annotateCard) —
      //     "conclusion and metric explanation" under each chart.
      // Failure does not kill the card: verdict falls back to title+low, chart — no footnote.
      let verdictSummary: VerdictSummary | undefined;
      let annotation: CardAnnotation | undefined;
      if (generated.kind === "verdict") {
        try {
          verdictSummary = await summarizeVerdict({
            question: input.question,
            title: generated.title,
            rows,
          });
        } catch {
          verdictSummary = undefined;
        }
      } else {
        try {
          annotation = await annotateCard({
            question: input.question,
            card: { kind: generated.kind, title: generated.title },
            sql,
            rows,
          });
        } catch {
          annotation = undefined;
        }
      }

      const viewSpec = viewSpecSchema.parse(
        buildViewSpec(generated, rows, verdictSummary, annotation),
      );
      await emit({
        step: "card_ready",
        cardId: card.cardId,
        viewSpec,
        sql,
        message: t(
          `${label}: ${rows.length} строк → карточка ${viewSpec.kind}`,
          `${label}: ${rows.length} rows → ${viewSpec.kind} card`,
        ),
      });
      return { ok: true, spec: viewSpec, sql, attempts: attempt };
    } catch (err) {
      const lastError = errorMessage(err);
      attemptErrors.push(lastError);
      if (attempt < MAX_SQL_ATTEMPTS) {
        // B5: error goes to model with context — healSql returns
        // fixed SQL in the same strict JSON format.
        await emit({
          step: "healing",
          attempt,
          error: lastError,
          message: t(
            `${label} — отдаю ошибку модели на починку`,
            `${label} — handing the error back to the model to fix`,
          ),
        });
        try {
          generated = await healSql({
            question: input.question,
            schemaContext,
            clickContext: input.context,
            card: { kind: card.kind, title: card.title, ...(card.hint ? { hint: card.hint } : {}) },
            previous: generated,
            error: lastError,
            attempt,
          });
        } catch {
          // LLM unavailable — keep previous SQL, attempt becomes a plain retry.
        }
      }
    }
  }

  const summary = attemptErrors
    .map((e, i) => t(`Попытка ${i + 1}: ${truncate(e)}`, `Attempt ${i + 1}: ${truncate(e)}`))
    .join(" | ");
  const error = t(
    `${label}: SQL не удался после ${MAX_SQL_ATTEMPTS} попыток. ${summary}`,
    `${label}: SQL failed after ${MAX_SQL_ATTEMPTS} attempts. ${summary}`,
  );
  await emit({ step: "card_failed", cardId: card.cardId, error: truncate(error, 600) });
  return { ok: false, error, attempts: MAX_SQL_ATTEMPTS };
}

/** Default card executor: parallel Promise.all in the current process. */
export const runCardsInProcess: CardRunner = (cards, ctx) => {
  const many = cards.length > 1;
  return Promise.all(
    cards.map((card) =>
      runPlannedCard(card, { ...ctx, label: cardLabel(card, many) }),
    ),
  );
};

export async function runInvestigatePipeline(
  input: AskRequest,
  options: PipelineOptions,
): Promise<PipelineResult> {
  const emit: StepEmitter = async (step) => {
    // Strict Realtime progress contract validation before each emit.
    await options.emit(runStepSchema.parse(step));
  };

  const ro = options.readonlyClient ?? createReadonlyClient();
  const ownsClients = !options.readonlyClient;
  const t = pickText(detectAnswerLanguage(input.question));
  let errorEmitted = false;

  try {
    // -- phase A: catalog of all visible tables (cheap) -------------------------
    await emit({
      step: "exploring",
      message: t(
        "Смотрю каталог таблиц (system.tables/columns)",
        "Reading the table catalog (system.tables/columns)",
      ),
    });
    const catalog = await getCatalog(ro);

    // -- triage on fast model ---------------------------------------------
    await emit({
      step: "generating_sql",
      message: t(
        "Триаж: понимаю вопрос, выбираю таблицы и карточки",
        "Triage: understanding the question, picking tables and cards",
      ),
    });
    const triage = await (options.triageImpl ?? triageQuestion)({
      question: input.question,
      catalog,
      clickContext: input.context,
    });

    // -- clarify / impossible: honest early exit ---------------------------
    if (triage.decision === "clarify") {
      await emit({
        step: "clarify",
        question: triage.question,
        ...(triage.options ? { options: triage.options } : {}),
        message: t(
          `Нужно уточнение: ${triage.question}`,
          `Need a clarification: ${triage.question}`,
        ),
      });
      await emit({
        step: "done",
        viewSpecs: [],
        message: t(
          "Жду уточнения — задайте вопрос ещё раз с ответом",
          "Waiting for your clarification — ask again with the answer",
        ),
      });
      return { viewSpecs: [], sql: "", attempts: 0 };
    }
    if (triage.decision === "impossible") {
      await emit({
        step: "impossible",
        reason: triage.reason,
        ...(triage.available ? { available: triage.available } : {}),
        message: t(
          `По имеющимся данным ответить нельзя: ${truncate(triage.reason, 200)}`,
          `The available data can't answer this: ${truncate(triage.reason, 200)}`,
        ),
      });
      await emit({
        step: "done",
        viewSpecs: [],
        message: t(
          "Данных под вопрос нет — см. подсказки, о чём спросить",
          "No data for this question — see the hints on what to ask",
        ),
      });
      return { viewSpecs: [], sql: "", attempts: 0 };
    }

    // -- board_planned: dashboard skeletons on screen before SQL ------------------
    const cards = triage.cards;
    await emit({
      step: "board_planned",
      cards: cards.map(({ cardId, kind, title }) => ({ cardId, kind, title })),
      message:
        cards.length === 1
          ? t(`Одна карточка: «${cards[0].title}»`, `One card: “${cards[0].title}”`)
          : t(
              `Карточек: ${cards.length} — ${cards.map((c) => `«${c.title}»`).join(", ")}`,
              `${cards.length} cards — ${cards.map((c) => `“${c.title}”`).join(", ")}`,
            ),
    });

    // -- phase B: deep exploration of selected tables only --------------------
    await emit({
      step: "exploring",
      message: t(
        `Глубокая разведка: ${triage.tables.join(", ")}`,
        `Deep exploration: ${triage.tables.join(", ")}`,
      ),
    });
    const schemaContext = await exploreTables(ro, triage.tables);

    // -- parallel card execution (cardRunner seam) -------------------
    // Default — Promise.all in this process; Trigger task investigate
    // substitutes executor on parallel child runs.
    const runCards = options.cardRunner ?? runCardsInProcess;
    const outcomes = await runCards(cards, {
      ro,
      emit,
      input,
      schemaContext,
      ...(options.cardSqlImpl ? { cardSqlImpl: options.cardSqlImpl } : {}),
    });

    const succeeded = outcomes.filter((o) => o.ok);
    const failed = outcomes.filter((o) => !o.ok);
    const attempts = outcomes.reduce((s, o) => s + o.attempts, 0);

    // -- error: not one card of the plan succeeded ----------------------------
    if (succeeded.length === 0 && cards.length > 0) {
      const message = failed.map((f) => f.error).join(" || ");
      errorEmitted = true;
      await emit({ step: "error", message });
      throw new Error(message);
    }

    // -- done ---------------------------------------------------------------
    const viewSpecs = succeeded.map((o) => o.spec);
    const sql = succeeded
      .filter((o) => o.sql)
      .map((o) => o.sql as string)
      .join("\n\n");
    await emit({
      step: "done",
      viewSpecs,
      message:
        failed.length === 0
          ? t(
              `${viewSpecs.length} ${viewSpecs.length === 1 ? "карточка" : "карточек"} готово`,
              `${viewSpecs.length} ${viewSpecs.length === 1 ? "card" : "cards"} ready`,
            )
          : t(
              `${viewSpecs.length} из ${viewSpecs.length + failed.length} карточек готово; не удалось: ${failed
                .map((f) => truncate(f.error, 160))
                .join(" | ")}`,
              `${viewSpecs.length} of ${viewSpecs.length + failed.length} cards ready; failed: ${failed
                .map((f) => truncate(f.error, 160))
                .join(" | ")}`,
            ),
    });
    return { viewSpecs, sql, attempts };
  } catch (err) {
    // Unexpected failure outside execution loop (catalog/triage/exploration/emit) —
    // also finish with terminal error step so frontend sees fallback.
    if (!errorEmitted) {
      try {
        await options.emit(
          runStepSchema.parse({ step: "error", message: errorMessage(err) }),
        );
      } catch {
        // emit must not overwrite the original error
      }
    }
    throw err;
  } finally {
    if (ownsClients) {
      await ro.close();
    }
  }
}
