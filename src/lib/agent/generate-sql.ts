/**
 * SQL generation step v2 — ONE card at a time (B4) + self-healing (B5).
 *
 * Seam contract: generateCardSql({question, schemaContext, clickContext?, card})
 * → GeneratedSql. Card (kind + title + hint) is assigned by triage (triage.ts);
 * this model writes a ClickHouse SELECT for it exactly. Cards of one dashboard
 * are generated IN PARALLEL — each on its own investigate-card child run.
 *
 * Prompt is generic and dataset-agnostic: no domain knowledge in the text —
 * all facts about data (tables, sorting keys, real value distributions,
 * date ranges, samples) come from live schema context (explore.ts).
 *
 * DATA SHAPE CONVENTIONS (LLM SQL must follow them, buildViewSpec reads them):
 *   - kind: 'timeline'    → columns `t` (date/datetime), `v` (number),
 *                           optional `series` (string) for multiple lines;
 *   - kind: 'leaderboard' → any columns; first — entity, rest — metrics;
 *   - kind: 'histogram'   → columns `label` (string) and `count` (integer ≥ 0);
 *   - kind: 'heatmap'     → columns `x` (string), `y` (string), `value` (number);
 *   - kind: 'verdict'     → EXACTLY one row of aggregates; each column becomes
 *                           an evidence stat (aliases — readable snake_case);
 *   - kind: 'bignumber'   → EXACTLY one row; column `value` (number), opt.
 *                           `delta` (number, % vs baseline), `label`/`detail` (strings);
 *   - kind: 'scatter'     → columns `x` (number), `y` (number), opt. `label`
 *                           (string, entity name); at most 500 points;
 *   - kind: 'graph'       → columns `source`, `target` (strings — entity pair),
 *                           opt. `weight` (number); nodes and scores derived by code;
 *   - kind: 'treemap'     → columns `label` (string), `value` (number > 0),
 *                           opt. `group` (string — top-level group);
 *   - kind: 'funnel'      → columns `label`, `count` in funnel stage order;
 *   - kind: 'boxplot'     → columns `label`, `lo`, `q1`, `med`, `q3`, `hi` —
 *                           five quantiles of the metric per group (quantiles()).
 *
 * Also here: healSql() — fix failed SQL from ClickHouse error text (B5),
 * summarizeVerdict() — verdict + confidence from actual aggregates, and
 * sanitizeSql() — "SELECT only" safety on top of agent_ro rules.
 */
import { z } from "zod";
import {
  formatViewSpecCatalogForPrompt,
  viewKindSchema,
  type ClickContext,
  type ViewKind,
} from "@/lib/contracts";
import type { SchemaContext } from "./explore";
import type { TriageCard } from "./triage";
import { askAndParse, extractJsonObject } from "./llm-json";
import { languageDirective } from "./language";

/** Card assignment from triage — without cardId (stays with the pipeline). */
export type CardAssignment = Pick<TriageCard, "kind" | "title" | "hint">;

export type GenerateCardSqlInput = {
  question: string;
  schemaContext: SchemaContext[];
  clickContext?: ClickContext;
  card: CardAssignment;
};

export type GeneratedSql = {
  sql: string;
  kind: ViewKind;
  title: string;
  /** Timeline only: [from, to] anomaly window if the model sees one. */
  anomalyWindow?: [string, string];
  /** Histogram only: bucket axis label. */
  bucketLabel?: string;
  /** Scatter only: x-axis label. */
  xLabel?: string;
  /** Scatter only: y-axis label. */
  yLabel?: string;
  /** Scatter only: 'log' for quantities spanning orders of magnitude. */
  xScale?: "linear" | "log";
  yScale?: "linear" | "log";
  /** map/treemap/boxplot: value label ("landings", "revenue"). */
  valueLabel?: string;
};

// ---------------------------------------------------------------------------
// SQL sanitization — safety on top of agent_ro rules
// ---------------------------------------------------------------------------

const FORBIDDEN_SQL = /\b(insert|update|delete|drop|alter|create|truncate|rename|grant|revoke|attach|detach|optimize|system|kill|exchange|use)\b/i;

/** SQL copy without string literals and comments — for keyword checks. */
function stripLiteralsAndComments(sql: string): string {
  return sql
    .replace(/'(?:\\.|''|[^'\\])*'/g, "''") // '…' with \' and '' support
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

/**
 * Strip trailing `;`, forbid multi-statements and anything that is not SELECT.
 * Throws a clear error — in the pipeline it goes into the self-healing loop.
 */
export function sanitizeSql(rawSql: string): string {
  const sql = rawSql.trim().replace(/;+\s*$/g, "").trim();
  if (!sql) throw new Error("empty SQL");

  const shadow = stripLiteralsAndComments(sql);
  if (shadow.includes(";")) {
    throw new Error("forbidden: multiple SQL statements in one query");
  }
  if (!/^\s*(select|with)\b/i.test(shadow)) {
    throw new Error("forbidden: only SELECT (or WITH … SELECT) is allowed");
  }
  const forbidden = shadow.match(FORBIDDEN_SQL);
  if (forbidden) {
    throw new Error(`forbidden: ${forbidden[0].toUpperCase()} operator — read-only SELECT only`);
  }
  return sql;
}

// ---------------------------------------------------------------------------
// Strict JSON parsing for a single sql card
// ---------------------------------------------------------------------------

const sqlCardSchema = z.object({
  sql: z.string().min(1),
  kind: viewKindSchema,
  title: z.string().min(1),
  anomalyWindow: z.tuple([z.string().min(1), z.string().min(1)]).nullish(),
  bucketLabel: z.string().nullish(),
  xLabel: z.string().nullish(),
  yLabel: z.string().nullish(),
  xScale: z.enum(["linear", "log"]).nullish(),
  yScale: z.enum(["linear", "log"]).nullish(),
  valueLabel: z.string().nullish(),
});

function parseSqlCard(raw: unknown): GeneratedSql {
  const parsed = sqlCardSchema.parse(raw);
  return {
    sql: parsed.sql.trim(),
    kind: parsed.kind,
    title: parsed.title.trim(),
    ...(parsed.anomalyWindow ? { anomalyWindow: parsed.anomalyWindow } : {}),
    ...(parsed.bucketLabel ? { bucketLabel: parsed.bucketLabel } : {}),
    ...(parsed.xLabel ? { xLabel: parsed.xLabel } : {}),
    ...(parsed.yLabel ? { yLabel: parsed.yLabel } : {}),
    ...(parsed.xScale ? { xScale: parsed.xScale } : {}),
    ...(parsed.yScale ? { yScale: parsed.yScale } : {}),
    ...(parsed.valueLabel ? { valueLabel: parsed.valueLabel } : {}),
  };
}

/** One sql card; {"cards": [...]} wrappers and legacy shapes also accepted. */
function parseSingleSqlAnswer(content: string): GeneratedSql {
  const raw: unknown = JSON.parse(extractJsonObject(content));
  const inner =
    raw && typeof raw === "object" && "cards" in raw && Array.isArray((raw as { cards: unknown }).cards)
      ? ((raw as { cards: unknown[] }).cards[0] ?? raw)
      : raw;
  return parseSqlCard(inner);
}

// ---------------------------------------------------------------------------
// Prompt — generic, all data knowledge comes from schema context
// ---------------------------------------------------------------------------

const SQL_RULES = `## SQL rules (mandatory)
- ClickHouse SQL dialect only.
- Exactly ONE read-only SELECT statement (WITH … SELECT is fine). Never INSERT/CREATE/ALTER/DROP/etc. No semicolons, no multiple statements.
- ALWAYS end with a LIMIT: at most 1000 rows for time series, 10–50 for leaderboards/histograms, 500 for scatter.
- Use ONLY tables and columns present in the schema context — it was collected from the live instance seconds ago and is the single source of truth. Mind each table's actual dateRange.

## Data reality — trust the collected statistics, not assumptions
- Each table's keyColumns carry REAL value distributions (top values with row counts). Before building a card on a specific column value, check that it is actually populated: a value with a handful of rows in a huge table is effectively ABSENT — never make it the main signal of a card.
- If the signal the question needs is absent from the data, do not draw an empty chart: return a verdict card that says so plainly, grounded in what IS there.
- An empty result set fails the card. Prefer aggregates that always return a row (count() returns 0, not zero rows), and state zeros explicitly.

## Performance — tables can hold hundreds of millions of rows; write index-friendly SQL
- Each table's "sortingKey" (ORDER BY / primary key) is in the schema context. The primary index prunes data only when WHERE filters a PREFIX of that key: an equality on the 1st key column, then the 2nd, etc. Filtering a non-prefix column forces a full scan — acceptable only when the question genuinely spans the whole table.
- Star schemas: a big fact table references dimensions via *_sk/*_id keys — join the dimension for human-readable dates and names, filter the fact by its own key prefix where possible, and aggregate BEFORE joining when you can.
- Never SELECT * in an aggregation — project only the columns you use.

## Result-shape conventions by kind (column aliases are a hard contract)
- timeline  → columns: t (Date/DateTime, ORDER BY t), v (number); optional series (string) to draw several lines. AT MOST 4 series — the chart renders more as a noisy tangle. If a categorical breakdown needs more than 4 groups, take the top-4 by volume (fold the rest or drop them), coarsen the bucket, or — when the split is really a SECOND dimension (hour-of-day, day-of-week, category) — use a heatmap instead. Timeline is a metric over ONE continuous time axis, not a day×time-of-day grid.
- leaderboard → any columns; the FIRST column is the entity, the rest are metrics. Readable snake_case aliases.
- histogram → columns: label (string, bucket name), count (non-negative integer), rows already in display order. Also set "bucketLabel" (axis name) in your JSON answer.
- heatmap   → columns: x (string), y (string), value (number). THE form for a pattern across two cyclic/categorical dimensions: hour-of-day × day-of-week (24×7), date × category, region × month. Prefer it over a multi-series timeline whenever the question is «when/at what times», «динамика по … и …», or breaks a metric down by time-of-day — the two axes stay readable where 8 overlaid lines do not. Keep each axis small (≤ ~24 x-values, ≤ ~31 y-values); bucket finer granularity.
- verdict   → EXACTLY ONE row of aggregate metrics; every column becomes an evidence stat, so alias each with a readable snake_case name. Good evidence: extreme ratios vs a baseline/median, concentration shares, counts of affected entities.
- bignumber → EXACTLY ONE row; column: value (number). Optional columns: delta (number, % change vs a baseline period, positive = growth), label (string, short caption of what value means), detail (string, secondary context line).
- scatter   → columns: x (number), y (number); optional label (string, entity name). LIMIT at most 500 points. Return RAW numbers — do NOT log-transform x/y inside the SQL. If a quantity spans orders of magnitude, set "xScale"/"yScale": "log" in your JSON answer and the chart handles the log axis with real tick labels; otherwise omit them (linear). Set "xLabel"/"yLabel" to plain quantity names WITHOUT "(log)". The chart draws the trend line and Pearson r itself — one scatter answers «is there a relationship?».
- map       → columns: lat (number, -90..90), lon (number, -180..180); optional value (number, aggregated weight → marker size/intensity), label (string, entity name). ONLY when the table really has coordinate columns — never geocode names. AGGREGATE dense coordinates: value is count()/sum()/avg() of the asked metric over GROUP BY round(lat, 3), round(lon, 3); filter out NULL/zero (0, 0) coordinates. BETTER: if the table also has a human-readable place-name column (district/neighborhood/area), GROUP BY that name with avg(lat) AS lat, avg(lon) AS lon and the name as label — named points beat anonymous grid cells. LIMIT at most 1000 points. Also set "valueLabel" (what value means) in your JSON answer.
- graph     → columns: source (string), target (string); optional weight (number > 0, tie strength). ONE row per entity PAIR — aggregate first: SELECT least(a, b) AS source, greatest(a, b) AS target, count() AS weight … GROUP BY source, target ORDER BY weight DESC LIMIT 200 (each undirected pair once; self-pairs are dropped). The pipeline derives nodes, sizes and anomaly scores from weighted degree automatically. Keep pairs meaningful: filter weight ≥ 2 when the raw pair count is huge.
- treemap   → columns: label (string), value (number > 0); optional group (string, top-level category → tile color/legend). Composition of a whole: value is the size of the part (sum()/count()). AT MOST 40 rows, ORDER BY value DESC; fold the long tail into an «прочее» row in SQL (e.g. rank the parts and GROUP BY if(rank <= 20, name, 'прочее')) so the tiles sum to the TRUE total. Also set "valueLabel" (what value means) in your JSON answer.
- funnel    → columns: label (string, stage name), count (non-negative number); rows in FUNNEL ORDER, widest stage first, 2–8 rows. Stages of ONE process. For strict per-user event sequences use windowFunnel(window)(timestamp, cond1, cond2, …) per user, then countIf(level >= k) per stage; independent countIf() cascades over statuses are fine too.
- boxplot   → columns: label (string, group name), lo, q1, med, q3, hi (numbers, ascending quantiles of the metric within the group). Use quantiles(0.05, 0.25, 0.5, 0.75, 0.95)(metric) AS q and project q[1] AS lo, q[2] AS q1, q[3] AS med, q[4] AS q3, q[5] AS hi. 2–15 groups, ORDER BY med DESC. Also set "valueLabel" (the metric name) in your JSON answer.`;

const OUTPUT_FORMAT = `## Output format
Reply with ONLY ONE strict JSON object — no markdown fences, no explanations, no "cards" wrapper:
{"sql": "…", "kind": "timeline|leaderboard|histogram|heatmap|verdict|bignumber|scatter|map|graph|treemap|funnel|boxplot", "title": "…", "anomalyWindow": ["fromISO", "toISO"], "bucketLabel": "…", "xLabel": "…", "yLabel": "…", "xScale": "log", "yScale": "log", "valueLabel": "…"}
- "kind": KEEP the assigned kind. Change it only when the data genuinely cannot fill that kind — then pick the closest kind that fits.
- "title": short insight headline in the language of the user's question (start from the assigned title; sharpen it if the data suggests better).
- "anomalyWindow": optional, timeline only — include it only when the question points at a window you can already name.
- "bucketLabel": histogram only. "xLabel"/"yLabel"/"xScale"/"yScale": scatter only. "valueLabel": map, treemap and boxplot.`;

function buildSystemPrompt(question: string): string {
  return [
    "You are a senior ClickHouse data engineer on «Insight Desk» — a live-dashboard agent that answers analytical questions over WHATEVER data exists in the connected ClickHouse instance.",
    "You are given ONE dashboard card to fill: its kind, working title and a hint from the triage planner. Write ONE ClickHouse SELECT whose result rows fill exactly that card. The pipeline builds the card JSON from your rows — you return only sql + kind + title (+ per-kind extras).",
    SQL_RULES,
    "## View card catalog (what each kind looks like)",
    formatViewSpecCatalogForPrompt(),
    OUTPUT_FORMAT,
    languageDirective(question),
  ].join("\n\n");
}

function buildUserPrompt(input: GenerateCardSqlInput): string {
  const parts = [
    "## Schema context (JSON, collected live from ClickHouse)",
    JSON.stringify(input.schemaContext),
  ];
  if (input.clickContext) {
    parts.push(
      "## Click context (the user clicked an element of a previous card — treat `selection` as mandatory filters)",
      JSON.stringify(input.clickContext),
    );
  }
  parts.push(
    "## Card to build (assigned by the triage planner)",
    JSON.stringify(input.card),
    "## Question",
    input.question,
  );
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Public functions: generation, healing, verdict
// ---------------------------------------------------------------------------

/** SQL for ONE assigned card (main model, main tier). */
export async function generateCardSql(
  input: GenerateCardSqlInput,
): Promise<GeneratedSql> {
  return askAndParse(
    [
      { role: "system", content: buildSystemPrompt(input.question) },
      { role: "user", content: buildUserPrompt(input) },
    ],
    parseSingleSqlAnswer,
    { purpose: "card_sql" },
  );
}

export type HealSqlInput = GenerateCardSqlInput & {
  /** Previous generation whose SQL failed. */
  previous: GeneratedSql;
  /** Full ClickHouse error text (or ViewSpec validation error). */
  error: string;
  /** Failed attempt number (1..MAX_SQL_ATTEMPTS-1). */
  attempt: number;
};

/**
 * B5 — self-healing: original question + previous SQL + full error text →
 * fixed SQL in the same strict JSON format.
 */
export async function healSql(input: HealSqlInput): Promise<GeneratedSql> {
  const healMessage = [
    `The SQL you produced earlier FAILED (healing attempt ${input.attempt}).`,
    "## Previous answer",
    JSON.stringify({ sql: input.previous.sql, kind: input.previous.kind, title: input.previous.title }),
    "## Error",
    input.error,
    "## Task",
    "Fix the query. Keep the same kind and title unless they are the actual problem. Follow every SQL rule and the result-shape convention for the chosen kind. Reply with ONLY ONE strict JSON object for this single card — {\"sql\": \"…\", \"kind\": \"…\", \"title\": \"…\"}.",
  ].join("\n\n");

  return askAndParse(
    [
      { role: "system", content: buildSystemPrompt(input.question) },
      { role: "user", content: buildUserPrompt(input) },
      { role: "user", content: healMessage },
    ],
    parseSingleSqlAnswer,
    { purpose: "heal_sql" },
  );
}

const cardAnnotationSchema = z.object({
  insight: z.string().min(1),
  metricNote: z.string().nullish(),
});

export type CardAnnotation = {
  insight: string;
  metricNote?: string;
};

/**
 * Card annotation AFTER SQL execution: short fast-tier call on
 * ACTUAL result rows. insight — analyst takeaway with numbers,
 * metricNote — what was computed (aggregation/filters/period — from SQL).
 * Failure — on caller: card without annotation is valid.
 */
export async function annotateCard(input: {
  question: string;
  card: { kind: ViewKind; title: string };
  sql: string;
  rows: Record<string, unknown>[];
}): Promise<CardAnnotation> {
  // Sample is enough for the model: first rows + honest total count.
  const sample = input.rows.slice(0, 40);
  const parsed = await askAndParse(
    [
      {
        role: "system",
        content:
          "You are annotating ONE dashboard card of «Insight Desk» AFTER its SQL has already run against ClickHouse. You get the user's question, the card (kind + title), the SQL and a sample of the ACTUAL result rows.\n" +
          'Reply with ONLY strict JSON: {"insight": "…", "metricNote": "…"}.\n' +
          "- insight: 1–2 sentences — the takeaway a sharp analyst would say out loud, grounded ONLY in the provided rows. Quote 1–2 key numbers; name the leader / spike / shape of the distribution. If the rows are too flat or the sample too small to conclude anything, say exactly that, plainly.\n" +
          "- metricNote: ONE sentence for a non-analyst explaining what the metric IS: what was counted/summed/averaged, over which filters and time window, in what units — read it from the SQL. No speculation, no marketing.\n\n" +
          languageDirective(input.question),
      },
      {
        role: "user",
        content: [
          "## Question",
          input.question,
          "## Card",
          JSON.stringify(input.card),
          "## SQL that produced the rows",
          input.sql,
          `## Result rows (first ${sample.length} of ${input.rows.length})`,
          JSON.stringify(sample),
        ].join("\n\n"),
      },
    ],
    (content) => cardAnnotationSchema.parse(JSON.parse(extractJsonObject(content))),
    { purpose: "card_insight", tier: "fast" },
  );
  return {
    insight: parsed.insight.trim(),
    ...(parsed.metricNote?.trim() ? { metricNote: parsed.metricNote.trim() } : {}),
  };
}

const verdictSummarySchema = z.object({
  verdict: z.string().min(1),
  confidence: z.enum(["low", "medium", "high"]),
});

export type VerdictSummary = z.infer<typeof verdictSummarySchema>;

/**
 * Second short LLM call for kind=verdict: from actual ClickHouse aggregates
 * writes verdict and confidence. Fallback on failure — on caller
 * (title + confidence 'low'), pipeline does not fail because of verdict.
 */
export async function summarizeVerdict(input: {
  question: string;
  title: string;
  rows: Record<string, unknown>[];
}): Promise<VerdictSummary> {
  return askAndParse(
    [
      {
        role: "system",
        content:
          "You are finishing a data investigation on «Insight Desk». Given the user's question and aggregate evidence computed from the live data, deliver the verdict.\n" +
          'Reply with ONLY strict JSON: {"verdict": "…", "confidence": "low|medium|high"}.\n' +
          "- verdict: 1–2 sentences grounded in the numbers (quote the key ones).\n" +
          "- confidence: how strongly the evidence supports the verdict. If the evidence is empty or degenerate (all zeros), say plainly that the data is insufficient and set confidence to 'low'.\n\n" +
          languageDirective(input.question),
      },
      {
        role: "user",
        content: [
          "## Question",
          input.question,
          "## Working title",
          input.title,
          "## Evidence (aggregates from ClickHouse)",
          JSON.stringify(input.rows),
        ].join("\n\n"),
      },
    ],
    (content) => verdictSummarySchema.parse(JSON.parse(extractJsonObject(content))),
    { purpose: "verdict_summary" },
  );
}
