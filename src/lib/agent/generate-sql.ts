/**
 * Шаг generating_sql — планировщик дашборда через LLM (B4) + самопочинка (B5).
 *
 * Контракт шва: generateSql({question, schemaContext, clickContext?}) →
 * GeneratedPlan { cards: PlannedCard[] } — конвейер (pipeline.ts) зависит
 * только от него. Каждая карточка плана — один из двух инструментов:
 *   - tool 'sql'   → свой ClickHouse SELECT + kind + title (как раньше);
 *   - tool 'drill' → готовый параметризованный запрос каталога A4
 *                    (src/lib/drills) — быстрый путь без генерации SQL.
 *
 * Промпт = системные правила SQL + каталог карточек (formatViewSpecCatalogForPrompt)
 *        + каталог дриллов (formatDrillCatalogForPrompt) + JSON контекста схемы
 *        (B2) + вопрос + контекст клика (если есть).
 * Ответ модели — СТРОГИЙ JSON {"cards": [...]} (легаси-форма одного объекта
 * {sql, kind, title} тоже принимается и заворачивается в план из 1 карточки);
 * парсится устойчиво (срезание фенсов и <think>-блоков), валидируется zod;
 * при мусоре — один повторный запрос с текстом ошибки парсинга.
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
 *   - kind: 'graph'       → sql-карточкам запрещён (нет сборки из строк),
 *                           доступен через дрилл costar-graph.
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
import { formatDrillCatalogForPrompt } from "@/lib/drills";
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
  /** Только для scatter: 'log' для величин, разбросанных на порядки. */
  xScale?: "linear" | "log";
  yScale?: "linear" | "log";
};

/** Карточка плана: свой SQL либо готовый дрилл каталога A4. */
export type PlannedCard =
  | ({ tool: "sql" } & GeneratedSql)
  | {
      tool: "drill";
      drillId: string;
      params: Record<string, string | number>;
      title: string;
    };

/** План дашборда: 1..MAX_PLAN_CARDS карточек, исполняются параллельно. */
export type GeneratedPlan = { cards: PlannedCard[] };

export const MAX_PLAN_CARDS = 3;

/**
 * Строгая zod-схема PlannedCard — для payload дочерней таски investigate-card
 * (src/trigger/investigate-card.ts). В отличие от схем парсинга ответа LLM ниже
 * (где `tool` опционален и достраивается), здесь карточка уже нормализована
 * планировщиком: дискриминатор `tool` обязателен.
 */
export const plannedCardSchema = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("sql"),
    sql: z.string().min(1),
    kind: viewKindSchema,
    title: z.string().min(1),
    anomalyWindow: z.tuple([z.string(), z.string()]).optional(),
    bucketLabel: z.string().optional(),
  }),
  z.object({
    tool: z.literal("drill"),
    drillId: z.string().min(1),
    params: z.record(z.string(), z.union([z.string(), z.number()])),
    title: z.string(),
  }),
]);

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

const sqlCardSchema = z.object({
  tool: z.literal("sql").optional(),
  sql: z.string().min(1),
  kind: viewKindSchema,
  title: z.string().min(1),
  anomalyWindow: z.tuple([z.string().min(1), z.string().min(1)]).nullish(),
  bucketLabel: z.string().nullish(),
  xLabel: z.string().nullish(),
  yLabel: z.string().nullish(),
  xScale: z.enum(["linear", "log"]).nullish(),
  yScale: z.enum(["linear", "log"]).nullish(),
});

const drillCardSchema = z.object({
  tool: z.literal("drill").optional(),
  drillId: z.string().min(1),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
  title: z.string().nullish(),
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

function parseSqlCard(raw: unknown): PlannedCard {
  const parsed = sqlCardSchema.parse(raw);
  if (parsed.kind === "graph") {
    throw new Error(
      "kind 'graph' недоступен sql-карточкам — используй дрилл costar-graph",
    );
  }
  return {
    tool: "sql",
    sql: parsed.sql.trim(),
    kind: parsed.kind,
    title: parsed.title.trim(),
    ...(parsed.anomalyWindow ? { anomalyWindow: parsed.anomalyWindow } : {}),
    ...(parsed.bucketLabel ? { bucketLabel: parsed.bucketLabel } : {}),
    ...(parsed.xLabel ? { xLabel: parsed.xLabel } : {}),
    ...(parsed.yLabel ? { yLabel: parsed.yLabel } : {}),
    ...(parsed.xScale ? { xScale: parsed.xScale } : {}),
    ...(parsed.yScale ? { yScale: parsed.yScale } : {}),
  };
}

function parseCard(raw: unknown): PlannedCard {
  // Дискриминация по содержимому: drillId → дрилл, иначе sql-карточка.
  if (raw && typeof raw === "object" && "drillId" in raw) {
    const parsed = drillCardSchema.parse(raw);
    return {
      tool: "drill",
      drillId: parsed.drillId,
      params: parsed.params,
      title: parsed.title?.trim() || parsed.drillId,
    };
  }
  return parseSqlCard(raw);
}

/** План дашборда; легаси-ответ одним объектом {sql, kind, title} заворачивается. */
function parsePlanAnswer(content: string): GeneratedPlan {
  const raw: unknown = JSON.parse(extractJsonObject(content));
  const cardsRaw =
    raw && typeof raw === "object" && "cards" in raw && Array.isArray((raw as { cards: unknown }).cards)
      ? ((raw as { cards: unknown[] }).cards)
      : [raw];
  if (cardsRaw.length === 0) {
    throw new Error("план пуст — нужна хотя бы одна карточка");
  }
  return { cards: cardsRaw.slice(0, MAX_PLAN_CARDS).map(parseCard) };
}

/** Одна sql-карточка (ответ healSql); план из одной карточки тоже принимается. */
function parseSingleSqlAnswer(content: string): GeneratedSql {
  const raw: unknown = JSON.parse(extractJsonObject(content));
  const inner =
    raw && typeof raw === "object" && "cards" in raw && Array.isArray((raw as { cards: unknown }).cards)
      ? ((raw as { cards: unknown[] }).cards[0] ?? raw)
      : raw;
  const card = parseSqlCard(inner);
  if (card.tool !== "sql") throw new Error("ожидалась sql-карточка");
  return {
    sql: card.sql,
    kind: card.kind,
    title: card.title,
    ...(card.anomalyWindow ? { anomalyWindow: card.anomalyWindow } : {}),
    ...(card.bucketLabel ? { bucketLabel: card.bucketLabel } : {}),
    ...(card.xLabel ? { xLabel: card.xLabel } : {}),
    ...(card.yLabel ? { yLabel: card.yLabel } : {}),
    ...(card.xScale ? { xScale: card.xScale } : {}),
    ...(card.yScale ? { yScale: card.yScale } : {}),
  };
}

/**
 * Диалог с моделью со страховкой парсинга: при невалидном JSON — один повторный
 * запрос с текстом ошибки, дальше — исключение (его ловит цикл самопочинки).
 */
async function askAndParse<T>(
  messages: ChatMessage[],
  parse: (content: string) => T,
  purpose: string,
): Promise<T> {
  const { content } = await chatComplete(messages, { purpose });
  try {
    return parse(content);
  } catch (err) {
    const parseError = err instanceof Error ? err.message : String(err);
    const retry = await chatComplete(
      [
        ...messages,
        { role: "assistant", content },
        {
          role: "user",
          content:
            `Your previous reply could not be used: ${parseError}\n` +
            `Reply again with ONLY the strict JSON described in the system prompt — no markdown, no prose.`,
        },
      ],
      { purpose: `${purpose}:reparse` },
    );
    return parse(retry.content);
  }
}

// ---------------------------------------------------------------------------
// Промпт
// ---------------------------------------------------------------------------

const SQL_RULES = `## SQL rules (mandatory)
- ClickHouse SQL dialect only.
- Exactly ONE read-only SELECT statement (WITH … SELECT is fine). Never INSERT/CREATE/ALTER/DROP/etc. No semicolons, no multiple statements.
- ALWAYS end with a LIMIT: at most 1000 rows for time series, 10–50 for leaderboards/histograms.
- Star events are rows with event_type = 'WatchEvent'. Fork = 'ForkEvent', issues = 'IssuesEvent', PRs = 'PullRequestEvent'.
- Use only tables and columns present in the schema context. Mind the actual date range of the data.

## Performance — these tables have tens/hundreds of millions of rows, write index-friendly SQL
- Each table's "sortingKey" (ORDER BY / primary key) is in the schema context. ClickHouse's primary index only skips data when your WHERE filters a PREFIX of that key: an equality on the 1st key column, then the 2nd, etc. Filtering a column that is NOT a key prefix, or skipping over an earlier key column, forces a full scan.
- For github_events the sortingKey is (event_type, repo_name, created_at). ALWAYS filter \`event_type\` (e.g. = 'WatchEvent') — it is the leading key and cheap. When the question is about a specific repo, ALSO filter \`repo_name = 'owner/name'\`: that hits the index directly and is near-instant.
- A date range on \`created_at\` does NOT prune on its own here (created_at comes after repo_name in the key), so a cross-repo "top N over a period" query scans all events of that type. That is acceptable when the question genuinely spans all repos, but do not add a date filter expecting it to speed things up — filter event_type (and repo_name if given) for speed, and add the date range only because the question asks for that period.
- Never SELECT * in an aggregation — project only the columns you use.
- Prefer a prebuilt drill over your own SQL whenever one fits: drills run on small precomputed rollups and are instant, your SQL scans the raw fact table.

## Result-shape conventions by kind (column aliases are a hard contract)
- timeline  → columns: t (Date/DateTime, ORDER BY t), v (number); optional series (string) to draw several lines.
- leaderboard → any columns; the FIRST column is the entity (repo, account, …), the rest are metrics. Readable snake_case aliases.
- histogram → columns: label (string, bucket name), count (non-negative integer), rows already in display order. Also set "bucketLabel" (axis name) in your JSON answer.
- heatmap   → columns: x (string), y (string), value (number).
- verdict   → EXACTLY ONE row of aggregate metrics; every column becomes an evidence stat, so alias each with a readable snake_case name. Good evidence for star-fraud: burst size vs median, share of accounts with a single event ever, concentration of stars in a few days/hours, top-day share.
- bignumber → EXACTLY ONE row; column: value (number). Optional columns: delta (number, % change vs a baseline period, positive = growth), label (string, short caption of what value means), detail (string, secondary context line).
- scatter   → columns: x (number), y (number); optional label (string, entity name — account/repo). LIMIT at most 500 points. Return RAW numbers — do NOT log-transform x/y inside the SQL. If a quantity spans orders of magnitude (stars, commits, followers), set "xScale"/"yScale": "log" in your JSON answer and the chart handles the log axis with real tick labels; otherwise omit them (linear). Set "xLabel"/"yLabel" to plain quantity names WITHOUT "(log)". The chart draws the trend line and Pearson r itself, so you do NOT need a separate correlation query just to visualize the relationship — one scatter answers "is there a relationship?".
- graph     → only available via the costar-graph drill, never as a "sql" card.`;

const OUTPUT_FORMAT = `## Output format
Reply with ONLY a strict JSON object — no markdown fences, no explanations:
{"cards": [
  {"tool": "drill", "drillId": "…", "params": {"repo": "owner/name"}, "title": "…"},
  {"tool": "sql", "sql": "…", "kind": "timeline|leaderboard|histogram|heatmap|verdict|bignumber|scatter", "title": "…", "anomalyWindow": ["fromISO", "toISO"], "bucketLabel": "…", "xLabel": "…", "yLabel": "…", "xScale": "log", "yScale": "log"}
]}
- "cards": 1 to ${MAX_PLAN_CARDS} cards. A simple lookup question deserves exactly 1 card; an investigation («что странного…», «накручен ли…», «докажи») deserves 2–${MAX_PLAN_CARDS} complementary angles.
- "title": a short insight headline in the same language as the user's question (also for drill cards).
- "anomalyWindow": optional, timeline only — include it only when the question points at a suspicious window you can already name.
- "bucketLabel": histogram only — the axis name for the buckets.
- "xLabel"/"yLabel": scatter only — the axis names (plain quantities, no "(log)"), in the language of the question.
- "xScale"/"yScale": scatter only — "log" for order-of-magnitude quantities, otherwise omit.`;

function buildSystemPrompt(): string {
  // TODO: hardcoded system promt
  return [
    "You are a senior ClickHouse data engineer on «Insight Desk», investigating GitHub star-fraud (fake star campaigns) over the github_events dataset.",
    "Given the user's question, plan a small dashboard: 1–" +
      MAX_PLAN_CARDS +
      " view cards that together answer it. Each card is either a prebuilt parameterized drill (tool 'drill' — fast, tested, preferred when it fits) or your own ClickHouse SQL query (tool 'sql') whose result rows fill the card. The pipeline builds card JSON from rows — for sql cards you only return sql + kind + title.",
    SQL_RULES,
    "## Choosing cards\n- When the user asks for a judgment — «is X suspicious?», «is this fraud/fake?», «are these stars real?» — include a `verdict` card (drill burst-metrics / one-and-done, or your own single-row aggregate query) as the LAST card, and back it with 1–2 evidence cards (timeline with anomalyWindow, histogram of account age, …).\n- When the question names a specific repo (owner/name), prefer drills — they run on precomputed rollups and are instant.\n- For anything the drill catalog does not cover (top-N across all repos, custom filters, unusual groupings), write a sql card.\n- Never duplicate the same angle twice; each card must add information.",
    "## Prebuilt drill catalog (tool 'drill')",
    formatDrillCatalogForPrompt(),
    "## View card catalog (kinds for sql cards)",
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

export async function generateSql(input: GenerateSqlInput): Promise<GeneratedPlan> {
  return askAndParse(
    [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: buildUserPrompt(input) },
    ],
    parsePlanAnswer,
    "generate_plan",
  );
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
    "Fix the query. Keep the same kind and title unless they are the actual problem. Follow every SQL rule and the result-shape convention for the chosen kind. Reply with ONLY ONE strict JSON object for this single card — {\"sql\": \"…\", \"kind\": \"…\", \"title\": \"…\"} — no \"cards\" wrapper.",
  ].join("\n\n");

  return askAndParse(
    [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: buildUserPrompt(input) },
      { role: "user", content: healMessage },
    ],
    parseSingleSqlAnswer,
    "heal_sql",
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

  const { content } = await chatComplete(messages, { purpose: "verdict_summary" });
  try {
    return verdictSummarySchema.parse(JSON.parse(extractJsonObject(content)));
  } catch (err) {
    const parseError = err instanceof Error ? err.message : String(err);
    const retry = await chatComplete(
      [
        ...messages,
        { role: "assistant", content },
        {
          role: "user",
          content: `Your previous reply could not be used: ${parseError}\nReply again with ONLY the strict JSON object {"verdict": "…", "confidence": "low|medium|high"}.`,
        },
      ],
      { purpose: "verdict_summary:reparse" },
    );
    return verdictSummarySchema.parse(JSON.parse(extractJsonObject(retry.content)));
  }
}
