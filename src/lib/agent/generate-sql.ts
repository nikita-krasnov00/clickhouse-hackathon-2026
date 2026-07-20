/**
 * Шаг генерации SQL v2 — ПО ОДНОЙ карточке (B4) + самопочинка (B5).
 *
 * Контракт шва: generateCardSql({question, schemaContext, clickContext?, card})
 * → GeneratedSql. Карточку (kind + title + hint) назначает триаж (triage.ts);
 * эта модель пишет ClickHouse SELECT ровно под неё. Карточки одного дашборда
 * генерятся ПАРАЛЛЕЛЬНО — каждая на своём дочернем ране investigate-card.
 *
 * Промпт generic и dataset-agnostic: никакого доменного знания в тексте —
 * все факты о данных (таблицы, sorting keys, реальные распределения значений,
 * диапазоны дат, сэмплы) приходят из живого schema context (explore.ts).
 *
 * КОНВЕНЦИИ ФОРМЫ ДАННЫХ (их обязан соблюдать LLM-SQL, их читает buildViewSpec):
 *   - kind: 'timeline'    → колонки `t` (дата/датавремя), `v` (число),
 *                           опционально `series` (строка) для нескольких линий;
 *   - kind: 'leaderboard' → любые колонки; первая — сущность, остальные — метрики;
 *   - kind: 'histogram'   → колонки `label` (строка) и `count` (целое ≥ 0);
 *   - kind: 'heatmap'     → колонки `x` (строка), `y` (строка), `value` (число);
 *   - kind: 'verdict'     → РОВНО одна строка агрегатов; каждая колонка станет
 *                           стат-фактом evidence (алиасы — читабельный snake_case);
 *   - kind: 'bignumber'   → РОВНО одна строка; колонка `value` (число), опц.
 *                           `delta` (число, % к базе), `label`/`detail` (строки);
 *   - kind: 'scatter'     → колонки `x` (число), `y` (число), опц. `label`
 *                           (строка, имя сущности); не больше 500 точек;
 *   - kind: 'graph'       → sql-карточкам запрещён (нет сборки из строк).
 *
 * Здесь же: healSql() — починка упавшего SQL по тексту ошибки ClickHouse (B5),
 * summarizeVerdict() — вердикт+уверенность по фактическим агрегатам, и
 * sanitizeSql() — страховка «только SELECT» поверх прав agent_ro.
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

/** Назначение карточки от триажа — без cardId (он остаётся у конвейера). */
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
  /** Только для timeline: [от, до] окна аномалии, если модель его видит. */
  anomalyWindow?: [string, string];
  /** Только для histogram: подпись оси корзин. */
  bucketLabel?: string;
  /** Только для scatter: подпись оси x. */
  xLabel?: string;
  /** Только для scatter: подпись оси y. */
  yLabel?: string;
  /** Только для scatter: 'log' для величин, разбросанных на порядки. */
  xScale?: "linear" | "log";
  yScale?: "linear" | "log";
  /** Только для map: подпись величины value (легенда — «посадки», «выручка»). */
  valueLabel?: string;
};

// ---------------------------------------------------------------------------
// Санитайз SQL — страховка поверх прав agent_ro
// ---------------------------------------------------------------------------

const FORBIDDEN_SQL = /\b(insert|update|delete|drop|alter|create|truncate|rename|grant|revoke|attach|detach|optimize|system|kill|exchange|use)\b/i;

/** Копия SQL без строковых литералов и комментариев — для проверки ключевых слов. */
function stripLiteralsAndComments(sql: string): string {
  return sql
    .replace(/'(?:\\.|''|[^'\\])*'/g, "''") // '…' с учётом \' и ''
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

/**
 * Отрезает хвостовые `;`, запрещает мульти-стейтменты и всё, что не SELECT.
 * Кидает понятную ошибку — в конвейере она уходит в цикл самопочинки.
 */
export function sanitizeSql(rawSql: string): string {
  const sql = rawSql.trim().replace(/;+\s*$/g, "").trim();
  if (!sql) throw new Error("пустой SQL");

  const shadow = stripLiteralsAndComments(sql);
  if (shadow.includes(";")) {
    throw new Error("запрещено: несколько SQL-стейтментов в одном запросе");
  }
  if (!/^\s*(select|with)\b/i.test(shadow)) {
    throw new Error("запрещено: разрешён только SELECT (или WITH … SELECT)");
  }
  const forbidden = shadow.match(FORBIDDEN_SQL);
  if (forbidden) {
    throw new Error(`запрещено: оператор ${forbidden[0].toUpperCase()} — только read-only SELECT`);
  }
  return sql;
}

// ---------------------------------------------------------------------------
// Парсинг строгого JSON одной sql-карточки
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
  if (parsed.kind === "graph") {
    throw new Error("kind 'graph' недоступен sql-карточкам — выбери другой kind");
  }
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

/** Одна sql-карточка; обёртки {"cards": [...]} и легаси-формы тоже принимаются. */
function parseSingleSqlAnswer(content: string): GeneratedSql {
  const raw: unknown = JSON.parse(extractJsonObject(content));
  const inner =
    raw && typeof raw === "object" && "cards" in raw && Array.isArray((raw as { cards: unknown }).cards)
      ? ((raw as { cards: unknown[] }).cards[0] ?? raw)
      : raw;
  return parseSqlCard(inner);
}

// ---------------------------------------------------------------------------
// Промпт — generic, всё знание о данных приходит из schema context
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
- graph     → never available for sql cards.`;

const OUTPUT_FORMAT = `## Output format
Reply with ONLY ONE strict JSON object — no markdown fences, no explanations, no "cards" wrapper:
{"sql": "…", "kind": "timeline|leaderboard|histogram|heatmap|verdict|bignumber|scatter|map", "title": "…", "anomalyWindow": ["fromISO", "toISO"], "bucketLabel": "…", "xLabel": "…", "yLabel": "…", "xScale": "log", "yScale": "log", "valueLabel": "…"}
- "kind": KEEP the assigned kind. Change it only when the data genuinely cannot fill that kind — then pick the closest kind that fits.
- "title": short insight headline in the language of the user's question (start from the assigned title; sharpen it if the data suggests better).
- "anomalyWindow": optional, timeline only — include it only when the question points at a window you can already name.
- "bucketLabel": histogram only. "xLabel"/"yLabel"/"xScale"/"yScale": scatter only. "valueLabel": map only.`;

function buildSystemPrompt(): string {
  return [
    "You are a senior ClickHouse data engineer on «Insight Desk» — a live-dashboard agent that answers analytical questions over WHATEVER data exists in the connected ClickHouse instance.",
    "You are given ONE dashboard card to fill: its kind, working title and a hint from the triage planner. Write ONE ClickHouse SELECT whose result rows fill exactly that card. The pipeline builds the card JSON from your rows — you return only sql + kind + title (+ per-kind extras).",
    SQL_RULES,
    "## View card catalog (what each kind looks like)",
    formatViewSpecCatalogForPrompt(),
    OUTPUT_FORMAT,
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
// Публичные функции: генерация, починка, вердикт
// ---------------------------------------------------------------------------

/** SQL для ОДНОЙ назначенной карточки (основная модель, ярус main). */
export async function generateCardSql(
  input: GenerateCardSqlInput,
): Promise<GeneratedSql> {
  return askAndParse(
    [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: buildUserPrompt(input) },
    ],
    parseSingleSqlAnswer,
    { purpose: "card_sql" },
  );
}

export type HealSqlInput = GenerateCardSqlInput & {
  /** Предыдущая генерация, чей SQL упал. */
  previous: GeneratedSql;
  /** Полный текст ошибки ClickHouse (или валидации ViewSpec). */
  error: string;
  /** Номер неудачной попытки (1..MAX_SQL_ATTEMPTS-1). */
  attempt: number;
};

/**
 * B5 — самопочинка: исходный вопрос + прежний SQL + полный текст ошибки →
 * исправленный SQL в том же строгом JSON-формате.
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
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: buildUserPrompt(input) },
      { role: "user", content: healMessage },
    ],
    parseSingleSqlAnswer,
    { purpose: "heal_sql" },
  );
}

const verdictSummarySchema = z.object({
  verdict: z.string().min(1),
  confidence: z.enum(["low", "medium", "high"]),
});

export type VerdictSummary = z.infer<typeof verdictSummarySchema>;

/**
 * Второй короткий LLM-вызов для kind=verdict: по фактическим агрегатам из
 * ClickHouse пишет вывод и уверенность. Фоллбек при сбое — на вызывающем
 * (title + confidence 'low'), конвейер из-за вердикта не падает.
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
          "- verdict: 1–2 sentences grounded in the numbers (quote the key ones). Write it in the language the question is written in — English question → English verdict, Russian question → Russian verdict. Never use any other language.\n" +
          "- confidence: how strongly the evidence supports the verdict. If the evidence is empty or degenerate (all zeros), say plainly that the data is insufficient and set confidence to 'low'.",
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
