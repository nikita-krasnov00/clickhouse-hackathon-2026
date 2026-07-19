/**
 * Шаг generating_sql — text-to-SQL через LLM (B4) + самопочинка (B5).
 *
 * Контракт шва: generateSql({question, schemaContext, clickContext?}) →
 * { sql, kind, title, … } — конвейер (pipeline.ts) зависит только от него.
 *
 * Промпт = системные правила SQL + каталог карточек (formatViewSpecCatalogForPrompt)
 *        + JSON контекста схемы (B2) + вопрос + контекст клика (если есть).
 * Ответ модели — СТРОГИЙ JSON {sql, kind, title} (+ опц. anomalyWindow для
 * timeline, bucketLabel для histogram); парсится устойчиво (срезание фенсов и
 * <think>-блоков), валидируется zod; при мусоре — один повторный запрос с
 * текстом ошибки парсинга.
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
 *   - kind: 'graph'       → не поддержан до C5/B6, модели запрещён.
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
import { chatComplete, type ChatMessage } from "./llm";

export type GenerateSqlInput = {
  question: string;
  schemaContext: SchemaContext[];
  clickContext?: ClickContext;
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
// Устойчивый парсинг строгого JSON из ответа модели
// ---------------------------------------------------------------------------

const llmAnswerSchema = z.object({
  sql: z.string().min(1),
  kind: viewKindSchema,
  title: z.string().min(1),
  anomalyWindow: z.tuple([z.string().min(1), z.string().min(1)]).nullish(),
  bucketLabel: z.string().nullish(),
  xLabel: z.string().nullish(),
  yLabel: z.string().nullish(),
});

/** Срезает reasoning-блоки и markdown-фенсы, выделяет JSON-объект. */
function extractJsonObject(content: string): string {
  let text = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  text = text.replace(/```(?:json)?/gi, "").trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last <= first) {
    throw new Error("в ответе модели нет JSON-объекта");
  }
  return text.slice(first, last + 1);
}

function parseLlmAnswer(content: string): GeneratedSql {
  const parsed = llmAnswerSchema.parse(JSON.parse(extractJsonObject(content)));
  if (parsed.kind === "graph") {
    throw new Error("kind 'graph' не поддержан до C5/B6 — выбери другой вид карточки");
  }
  return {
    sql: parsed.sql.trim(),
    kind: parsed.kind,
    title: parsed.title.trim(),
    ...(parsed.anomalyWindow ? { anomalyWindow: parsed.anomalyWindow } : {}),
    ...(parsed.bucketLabel ? { bucketLabel: parsed.bucketLabel } : {}),
    ...(parsed.xLabel ? { xLabel: parsed.xLabel } : {}),
    ...(parsed.yLabel ? { yLabel: parsed.yLabel } : {}),
  };
}

/**
 * Диалог с моделью со страховкой парсинга: при невалидном JSON — один повторный
 * запрос с текстом ошибки, дальше — исключение (его ловит цикл самопочинки).
 */
async function askForGeneratedSql(messages: ChatMessage[]): Promise<GeneratedSql> {
  const { content } = await chatComplete(messages);
  try {
    return parseLlmAnswer(content);
  } catch (err) {
    const parseError = err instanceof Error ? err.message : String(err);
    const retry = await chatComplete([
      ...messages,
      { role: "assistant", content },
      {
        role: "user",
        content:
          `Your previous reply could not be used: ${parseError}\n` +
          `Reply again with ONLY the strict JSON object described in the system prompt — no markdown, no prose.`,
      },
    ]);
    return parseLlmAnswer(retry.content);
  }
}

// ---------------------------------------------------------------------------
// Промпт
// ---------------------------------------------------------------------------

const SQL_RULES = `## SQL rules (mandatory)
- ClickHouse SQL dialect only.
- Exactly ONE read-only SELECT statement (WITH … SELECT is fine). Never INSERT/CREATE/ALTER/DROP/etc. No semicolons, no multiple statements.
- ALWAYS end with a LIMIT: at most 1000 rows for time series, 10–50 for leaderboards/histograms.
- The table has tens of millions of rows. Add a filter on the date column whenever the question allows one (a mentioned period, "this year", recent activity). Only scan all time when the question explicitly asks for all time.
- Star events are rows with event_type = 'WatchEvent'. Fork = 'ForkEvent', issues = 'IssuesEvent', PRs = 'PullRequestEvent'.
- Use only tables and columns present in the schema context. Mind the actual date range of the data.

## Result-shape conventions by kind (column aliases are a hard contract)
- timeline  → columns: t (Date/DateTime, ORDER BY t), v (number); optional series (string) to draw several lines.
- leaderboard → any columns; the FIRST column is the entity (repo, account, …), the rest are metrics. Readable snake_case aliases.
- histogram → columns: label (string, bucket name), count (non-negative integer), rows already in display order. Also set "bucketLabel" (axis name) in your JSON answer.
- heatmap   → columns: x (string), y (string), value (number).
- verdict   → EXACTLY ONE row of aggregate metrics; every column becomes an evidence stat, so alias each with a readable snake_case name. Good evidence for star-fraud: burst size vs median, share of accounts with a single event ever, concentration of stars in a few days/hours, top-day share.
- bignumber → EXACTLY ONE row; column: value (number). Optional columns: delta (number, % change vs a baseline period, positive = growth), label (string, short caption of what value means), detail (string, secondary context line).
- scatter   → columns: x (number), y (number); optional label (string, entity name — account/repo). LIMIT at most 500 points. Also set "xLabel" and "yLabel" (axis names) in your JSON answer.
- graph     → NOT supported yet, never choose it.`;

const OUTPUT_FORMAT = `## Output format
Reply with ONLY a strict JSON object — no markdown fences, no explanations:
{"sql": "…", "kind": "timeline|leaderboard|histogram|heatmap|verdict|bignumber|scatter", "title": "…", "anomalyWindow": ["fromISO", "toISO"], "bucketLabel": "…", "xLabel": "…", "yLabel": "…"}
- "title": a short insight headline in the same language as the user's question.
- "anomalyWindow": optional, timeline only — include it only when the question points at a suspicious window you can already name.
- "bucketLabel": histogram only — the axis name for the buckets.
- "xLabel"/"yLabel": scatter only — the axis names, in the language of the question.`;

function buildSystemPrompt(): string {
  return [
    "You are a senior ClickHouse data engineer on «Insight Desk», investigating GitHub star-fraud (fake star campaigns) over the github_events dataset.",
    "Given the user's question, choose exactly ONE view card kind and write ONE ClickHouse SQL query whose result rows fill that card. The pipeline builds the card JSON from your rows — you only return sql + kind + title.",
    SQL_RULES,
    "## Choosing the kind\nWhen the user asks for a judgment — «is X suspicious?», «is this fraud/fake?», «are these stars real?» — choose `verdict` and write ONE query with the aggregate evidence. Otherwise pick the card that matches the shape of the answer (see catalog).",
    "## View card catalog (when to choose which kind)",
    formatViewSpecCatalogForPrompt(),
    OUTPUT_FORMAT,
  ].join("\n\n");
}

function buildUserPrompt(input: GenerateSqlInput): string {
  const parts = [
    "## Schema context (JSON, collected live from ClickHouse)",
    JSON.stringify(input.schemaContext),
  ];
  if (input.clickContext) {
    parts.push(
      "## Click context (the user clicked an element of a previous card — treat `selection` as filters for this question)",
      JSON.stringify(input.clickContext),
    );
  }
  parts.push("## Question", input.question);
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Публичные функции: генерация, починка, вердикт
// ---------------------------------------------------------------------------

export async function generateSql(input: GenerateSqlInput): Promise<GeneratedSql> {
  return askForGeneratedSql([
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: buildUserPrompt(input) },
  ]);
}

export type HealSqlInput = GenerateSqlInput & {
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
    "Fix the query. Keep the same kind and title unless they are the actual problem. Follow every SQL rule and the result-shape convention for the chosen kind. Reply with ONLY the strict JSON object.",
  ].join("\n\n");

  return askForGeneratedSql([
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: buildUserPrompt(input) },
    { role: "user", content: healMessage },
  ]);
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
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are finishing a GitHub star-fraud investigation. Given the user's question and aggregate evidence computed from real data, deliver the verdict.\n" +
        'Reply with ONLY strict JSON: {"verdict": "…", "confidence": "low|medium|high"}.\n' +
        "- verdict: 1–2 sentences grounded in the numbers (quote the key ones). Write it in the language the question is written in — English question → English verdict, Russian question → Russian verdict. Never use any other language.\n" +
        "- confidence: how strongly the evidence supports the verdict.",
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
  ];

  const { content } = await chatComplete(messages);
  try {
    return verdictSummarySchema.parse(JSON.parse(extractJsonObject(content)));
  } catch (err) {
    const parseError = err instanceof Error ? err.message : String(err);
    const retry = await chatComplete([
      ...messages,
      { role: "assistant", content },
      {
        role: "user",
        content: `Your previous reply could not be used: ${parseError}\nReply again with ONLY the strict JSON object {"verdict": "…", "confidence": "low|medium|high"}.`,
      },
    ]);
    return verdictSummarySchema.parse(JSON.parse(extractJsonObject(retry.content)));
  }
}
