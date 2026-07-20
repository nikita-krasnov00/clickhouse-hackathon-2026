/**
 * Триаж вопроса — первый и БЫСТРЫЙ шаг конвейера v2 (ярус 'fast', цель ~1-2 c).
 *
 * Вход: вопрос пользователя + живой каталог таблиц (catalogTables, фаза A) +
 * опциональный контекст клика. Выход — одно из трёх решений:
 *   - proceed:    какие таблицы исследовать глубоко и какие карточки строить
 *                 (kind + title + hint) — манифест уходит в board_planned, и
 *                 UI рисует скелеты дашборда ещё ДО генерации SQL;
 *   - clarify:    вопрос нельзя осмысленно понять без одного уточнения —
 *                 вопрос пользователю + варианты ответа;
 *   - impossible: в ClickHouse нет данных под вопрос — честная причина +
 *                 список того, о чём данные ОТВЕТИТЬ МОГУТ.
 *
 * Триаж не пишет SQL: он решает, ЧТО строить. SQL для каждой карточки пишет
 * основная модель в generate-sql.ts (параллельно, по карточке на дочерний ран).
 *
 * Здесь же suggestQuestions() — вопросы-пресеты для главной страницы,
 * сгенерированные по тому же каталогу (/api/suggest).
 */
import { z } from "zod";
import { viewKindSchema, type ClickContext } from "@/lib/contracts";
import { MAX_DEEP_TABLES, type CatalogTable } from "./explore";
import { askAndParse, extractJsonObject } from "./llm-json";
import { chatComplete } from "./llm";

/** Потолок карточек одного дашборда — больше трёх углов сразу не нужно. */
export const MAX_PLAN_CARDS = 3;

// ---------------------------------------------------------------------------
// Типы решения
// ---------------------------------------------------------------------------

/**
 * Карточка плана триажа. Zod-схема — потому что TriageCard ездит payload'ом
 * дочерней Trigger-таски investigate-card и валидируется на входе.
 */
export const triageCardSchema = z.object({
  /** Стабильный id скелета: card-1, card-2, … — присваивается кодом. */
  cardId: z.string().min(1),
  kind: viewKindSchema,
  /** Заголовок-инсайт на языке вопроса — виден на скелете сразу. */
  title: z.string().min(1),
  /** Одно предложение для SQL-инженера: что посчитать, какими таблицами. */
  hint: z.string().optional(),
});
export type TriageCard = z.infer<typeof triageCardSchema>;

export type TriageResult =
  | { decision: "proceed"; tables: string[]; cards: TriageCard[] }
  | { decision: "clarify"; question: string; options?: string[] }
  | { decision: "impossible"; reason: string; available?: string[] };

export type TriageInput = {
  question: string;
  catalog: CatalogTable[];
  clickContext?: ClickContext;
};

// ---------------------------------------------------------------------------
// Парсинг ответа модели
// ---------------------------------------------------------------------------

const triageAnswerSchema = z.object({
  decision: z.enum(["proceed", "clarify", "impossible"]),
  tables: z.array(z.string()).nullish(),
  cards: z
    .array(
      z.object({
        kind: viewKindSchema,
        title: z.string().min(1),
        hint: z.string().nullish(),
      }),
    )
    .nullish(),
  question: z.string().nullish(),
  options: z.array(z.string()).nullish(),
  reason: z.string().nullish(),
  available: z.array(z.string()).nullish(),
});

function parseTriageAnswer(content: string, catalog: CatalogTable[]): TriageResult {
  const raw = triageAnswerSchema.parse(JSON.parse(extractJsonObject(content)));

  if (raw.decision === "clarify") {
    if (!raw.question?.trim()) {
      throw new Error('decision "clarify" требует непустой "question"');
    }
    const options = (raw.options ?? []).map((o) => o.trim()).filter(Boolean);
    return {
      decision: "clarify",
      question: raw.question.trim(),
      ...(options.length > 0 ? { options: options.slice(0, 4) } : {}),
    };
  }

  if (raw.decision === "impossible") {
    if (!raw.reason?.trim()) {
      throw new Error('decision "impossible" требует непустой "reason"');
    }
    const available = (raw.available ?? []).map((a) => a.trim()).filter(Boolean);
    return {
      decision: "impossible",
      reason: raw.reason.trim(),
      ...(available.length > 0 ? { available: available.slice(0, 4) } : {}),
    };
  }

  // proceed: таблицы строго из каталога, карточки без graph, capы жёсткие.
  const known = new Set(catalog.map((t) => t.table));
  const tables = [...new Set(raw.tables ?? [])]
    .map((t) => t.trim())
    .filter((t) => known.has(t))
    .slice(0, MAX_DEEP_TABLES);
  if (tables.length === 0) {
    throw new Error(
      'decision "proceed" требует "tables" с полными именами таблиц ИЗ КАТАЛОГА',
    );
  }
  const cards = (raw.cards ?? [])
    .filter((c) => c.kind !== "graph")
    .slice(0, MAX_PLAN_CARDS)
    .map((c, i): TriageCard => ({
      cardId: `card-${i + 1}`,
      kind: c.kind,
      title: c.title.trim(),
      ...(c.hint?.trim() ? { hint: c.hint.trim() } : {}),
    }));
  if (cards.length === 0) {
    throw new Error('decision "proceed" требует хотя бы одну карточку (kind != graph)');
  }
  return { decision: "proceed", tables, cards };
}

// ---------------------------------------------------------------------------
// Промпт
// ---------------------------------------------------------------------------

/** Каталог в компактном виде: колонки — строками "name Type" ради токенов. */
function compactCatalogForPrompt(catalog: CatalogTable[]): string {
  return JSON.stringify(
    catalog.map((t) => ({
      table: t.table,
      rows: t.rowCount,
      ...(t.sortingKey.length > 0 ? { sortingKey: t.sortingKey } : {}),
      ...(t.dateColumn ? { dateColumn: t.dateColumn } : {}),
      columns: t.columns.map((c) => `${c.name} ${c.type}`),
    })),
  );
}

const TRIAGE_SYSTEM_PROMPT = `You are the dashboard triage planner of «Insight Desk» — an agent that answers analytical questions over WHATEVER data currently exists in a ClickHouse instance. You get the live table catalog (names, row counts, sorting keys, columns) and the user's question. You do NOT write SQL — you decide WHAT to build; a heavier model writes SQL for each card afterwards.

Decide ONE of three outcomes:
1. "proceed" — the question is answerable with these tables: pick the tables and plan the dashboard cards.
2. "clarify" — the question cannot be answered sensibly without ONE missing piece of user intent (ambiguous entity, several equally plausible datasets, a timeframe that changes the meaning). Ask exactly one short question in the language of the user's question and give 2–4 answer options. Use this SPARINGLY: when a reasonable assumption exists, proceed and put the assumption into the card titles instead of asking.
3. "impossible" — no table plausibly holds the needed signal. Give a brief reason in the language of the question and list 2–4 things this data CAN answer ("available"), so the user knows what to ask instead. Never invent data to avoid this decision.

Rules for "proceed":
- "tables": 1–${MAX_DEEP_TABLES} FULL table names strictly from the catalog. Include the dimension tables needed for joins — star schemas keep dates and names in dimensions referenced by *_sk/*_id keys of the fact table.
- "cards": 1–${MAX_PLAN_CARDS}. A simple lookup deserves exactly 1 card; an investigation («что странного…», «докажи», anomaly hunting) deserves 2–${MAX_PLAN_CARDS} complementary angles — never the same angle twice.
- Each card: "kind" + "title" (short insight headline in the language of the question) + "hint" (one sentence for the SQL engineer: what to compute, which tables/columns/filters).
- Card kinds:
  - bignumber — the answer is ONE number (prefer over a 1-row table).
  - timeline — a metric over time (needs a usable date).
  - leaderboard — top-N entities with metric columns.
  - histogram — distribution of a value across buckets.
  - heatmap — intensity across two categorical/time axes.
  - scatter — relationship between two numeric properties of many entities.
  - map — geographic points; ONLY when a chosen table really has coordinate columns (latitude/longitude in degrees). Never geocode place names. When the question is about city districts / neighborhoods / areas / zones / «где …» / «в каких районах …» AND the table has coordinates, ALWAYS include a map card (the asked metric over locations) — pair it with a leaderboard of the named areas when the question also asks «какие/top»; the map shows WHERE, the leaderboard names them.
  - verdict — final judgment with evidence stats; plan it LAST and only when the user asks for a judgment («накручен ли…», «is X suspicious/anomalous?»).
  - graph — NEVER plan it (cannot be generated from SQL).
- If a click context is provided (the user clicked an element of a previous card), treat its "selection" values as mandatory filters of the new question.

Reply with ONLY strict JSON, no markdown, no prose:
{"decision":"proceed","tables":["db.table"],"cards":[{"kind":"timeline","title":"…","hint":"…"}]}
or {"decision":"clarify","question":"…","options":["…","…"]}
or {"decision":"impossible","reason":"…","available":["…","…"]}`;

function buildTriageUserPrompt(input: TriageInput): string {
  const parts = [
    "## Live table catalog (from system.tables/system.columns, seconds ago)",
    compactCatalogForPrompt(input.catalog),
  ];
  if (input.clickContext) {
    parts.push(
      "## Click context (the user clicked an element of a previous card — its selection are mandatory filters)",
      JSON.stringify(input.clickContext),
    );
  }
  parts.push("## Question", input.question);
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Публичные функции
// ---------------------------------------------------------------------------

/** Триаж вопроса на быстрой модели; ошибки парсинга — один reparse-повтор. */
export async function triageQuestion(input: TriageInput): Promise<TriageResult> {
  return askAndParse(
    [
      { role: "system", content: TRIAGE_SYSTEM_PROMPT },
      { role: "user", content: buildTriageUserPrompt(input) },
    ],
    (content) => parseTriageAnswer(content, input.catalog),
    { purpose: "triage", tier: "fast" },
  );
}

const suggestAnswerSchema = z.object({
  questions: z.array(z.string().min(1)).min(1),
});

/**
 * Вопросы-пресеты для главной: 4 коротких вопроса по живому каталогу таблиц
 * (разные базы — разные вопросы). Быстрая модель, без reparse-страховки:
 * пресеты некритичны, сбой обрабатывает вызывающий (/api/suggest → []).
 */
export async function suggestQuestions(catalog: CatalogTable[]): Promise<string[]> {
  const { content } = await chatComplete(
    [
      {
        role: "system",
        content:
          "You suggest example questions for «Insight Desk» — an agent answering analytical questions over the ClickHouse tables below. Suggest 4 SHORT questions (≤ 80 characters each) a curious analyst could ask RIGHT NOW over these specific tables. If several databases exist, cover different ones. Write the questions in Russian. Reply with ONLY strict JSON: {\"questions\":[\"…\",\"…\",\"…\",\"…\"]}",
      },
      {
        role: "user",
        content: compactCatalogForPrompt(catalog),
      },
    ],
    { purpose: "suggest", tier: "fast" },
  );
  const parsed = suggestAnswerSchema.parse(JSON.parse(extractJsonObject(content)));
  return parsed.questions.map((q) => q.trim()).filter(Boolean).slice(0, 4);
}
