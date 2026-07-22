/**
 * Question triage — first FAST step of the v2 pipeline (tier 'fast', target ~1-2 s).
 *
 * Input: user question + live table catalog (catalogTables, phase A) +
 * optional click context. Output — one of three decisions:
 *   - proceed:    which tables to explore deeply and which cards to build
 *                 (kind + title + hint) — manifest goes to board_planned, and
 *                 UI draws dashboard skeletons BEFORE SQL generation;
 *   - clarify:    question cannot be understood without one clarification —
 *                 question to user + answer options;
 *   - impossible: ClickHouse has no data for the question — honest reason +
 *                 list of what the data CAN answer.
 *
 * Triage does not write SQL: it decides WHAT to build. SQL for each card is
 * written by the main model in generate-sql.ts (in parallel, one child run per card).
 *
 * Also suggestQuestions() — preset questions for the home page,
 * generated from the same catalog (/api/suggest).
 */
import { z } from "zod";
import { viewKindSchema, type ClickContext } from "@/lib/contracts";
import { MAX_DEEP_TABLES, type CatalogTable } from "./explore";
import { askAndParse, extractJsonObject } from "./llm-json";
import { chatComplete } from "./llm";
import { languageDirective } from "./language";

/** Cap on cards per dashboard — more than three angles at once is unnecessary. */
export const MAX_PLAN_CARDS = 3;

// ---------------------------------------------------------------------------
// Decision types
// ---------------------------------------------------------------------------

/**
 * Triage plan card. Zod schema — because TriageCard travels as payload of
 * the child Trigger task investigate-card and is validated on entry.
 */
export const triageCardSchema = z.object({
  /** Stable skeleton id: card-1, card-2, … — assigned by code. */
  cardId: z.string().min(1),
  kind: viewKindSchema,
  /** Insight headline in the question language — visible on skeleton immediately. */
  title: z.string().min(1),
  /** One sentence for the SQL engineer: what to compute, which tables. */
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
// Model response parsing
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
      throw new Error('decision "clarify" requires a non-empty "question"');
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
      throw new Error('decision "impossible" requires a non-empty "reason"');
    }
    const available = (raw.available ?? []).map((a) => a.trim()).filter(Boolean);
    return {
      decision: "impossible",
      reason: raw.reason.trim(),
      ...(available.length > 0 ? { available: available.slice(0, 4) } : {}),
    };
  }

  // proceed: tables strictly from catalog, hard caps.
  const known = new Set(catalog.map((t) => t.table));
  const tables = [...new Set(raw.tables ?? [])]
    .map((t) => t.trim())
    .filter((t) => known.has(t))
    .slice(0, MAX_DEEP_TABLES);
  if (tables.length === 0) {
    throw new Error(
      'decision "proceed" requires "tables" with full table names FROM THE CATALOG',
    );
  }
  const cards = (raw.cards ?? [])
    .slice(0, MAX_PLAN_CARDS)
    .map((c, i): TriageCard => ({
      cardId: `card-${i + 1}`,
      kind: c.kind,
      title: c.title.trim(),
      ...(c.hint?.trim() ? { hint: c.hint.trim() } : {}),
    }));
  if (cards.length === 0) {
    throw new Error('decision "proceed" requires at least one card');
  }
  return { decision: "proceed", tables, cards };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/** Catalog in compact form: columns as "name Type" strings to save tokens. */
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
  - timeline — a metric over ONE continuous time axis, at most ~4 series. A breakdown by time-of-day / weekday / many categories is NOT a timeline.
  - leaderboard — top-N entities with metric columns.
  - histogram — distribution of a value across buckets.
  - heatmap — intensity across two categorical/time axes; use it (NOT a multi-series timeline) for hour-of-day × day-of-week, date × category, «динамика по дням и часам», or any «when/at what times» pattern.
  - scatter — relationship between two numeric properties of many entities.
  - treemap — composition / share of a whole («из чего состоит», «что доминирует», «какая доля»): parts sized by their share. Prefer over leaderboard when shares of the total matter more than exact ranks.
  - funnel — a staged process with drop-off: conversion, «воронка», «где теряем». Only when the data really carries ordered stages (statuses, event sequences).
  - boxplot — compare the DISTRIBUTION of one numeric metric across groups (median, quartiles, whiskers): «как отличается X по группам», spread, typical values. Prefer over histogram when there are 2+ groups to compare.
  - graph — relationships between entity PAIRS: who is linked/co-occurs with whom, clusters around hubs. Only when a pair of entity columns lives in one table (or a self-join makes sense). Not for rankings or time.
  - map — geographic points; ONLY when a chosen table really has coordinate columns (latitude/longitude in degrees). Never geocode place names. When the question is about city districts / neighborhoods / areas / zones / «где …» / «в каких районах …» AND the table has coordinates, ALWAYS include a map card (the asked metric over locations) — pair it with a leaderboard of the named areas when the question also asks «какие/top»; the map shows WHERE, the leaderboard names them.
  - verdict — final judgment with evidence stats; plan it LAST and only when the user asks for a judgment («накручен ли…», «is X suspicious/anomalous?»).
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
// Public functions
// ---------------------------------------------------------------------------

/** Question triage on the fast model; parsing errors — one reparse retry. */
export async function triageQuestion(input: TriageInput): Promise<TriageResult> {
  return askAndParse(
    [
      {
        role: "system",
        content: `${TRIAGE_SYSTEM_PROMPT}\n\n${languageDirective(input.question)}`,
      },
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
 * Home page preset questions: 4 short questions from the live table catalog
 * (different databases — different questions). Fast model, no reparse safety:
 * presets are non-critical, failure handled by caller (/api/suggest → []).
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
