/**
 * HTTP contracts (/api/ask, /api/suggest) and Realtime run progress.
 *
 * v2 (dataset-agnostic): /api/drill contracts removed — card clicks always
 * trigger a NEW agent run (action 'why' with ClickContext). Triage steps added:
 * board_planned (card manifest — UI renders skeletons instantly),
 * card_failed (skeleton becomes an honest error), clarify (agent needs
 * clarification) and impossible (ClickHouse data cannot answer the question).
 */
import { z } from "zod";
import { clickContextSchema } from "./click";
import { viewKindSchema, viewSpecSchema } from "./view-spec";
import type { AnswerLanguage } from "./language";

// ---------------------------------------------------------------------------
// Ask API — question (or "why?" with click context) → agent run.
// POST /api/ask { question, context? } → { runId, publicAccessToken }
// Token is a Trigger.dev public access token for Realtime run subscription.
// ---------------------------------------------------------------------------

export const askRequestSchema = z.strictObject({
  question: z.string().min(1),
  context: clickContextSchema.optional(),
});
export type AskRequest = z.infer<typeof askRequestSchema>;

export const askResponseSchema = z.strictObject({
  runId: z.string(),
  publicAccessToken: z.string(),
});
export type AskResponse = z.infer<typeof askResponseSchema>;

// ---------------------------------------------------------------------------
// Suggest API — preset questions generated from the live schema catalog.
// GET /api/suggest → { questions } (empty array is a valid fallback response).
// ---------------------------------------------------------------------------

export const suggestResponseSchema = z.strictObject({
  questions: z.array(z.string()),
});
export type SuggestResponse = z.infer<typeof suggestResponseSchema>;

// ---------------------------------------------------------------------------
// RunStep — investigate pipeline progress, streamed via Realtime.
//
// Discriminator is `step`; all steps have an optional `message` (human-readable
// string for the feed). v2 run lifecycle order:
//   exploring      → table catalog, then deep exploration of selected tables;
//   generating_sql → triage (table and card selection) and per-card SQL generation;
//   board_planned  → dashboard manifest [{cardId, kind, title}] — UI immediately
//                    renders card SKELETONS without waiting for data;
//   clarify        → agent lacks inputs: question for the user (+ options);
//                    run ends with empty done — answer comes via a new /api/ask;
//   impossible     → ClickHouse data cannot answer: reason + what IS
//                    available in the data; run ends with empty done;
//   reviewing / executing → carry sqlPreview (SQL preview in the feed);
//   healing        → attempt number (1..3) and ClickHouse error text;
//   materializing  → temp table name in scratch (B6, reserved);
//   card_ready     → ONE ready card (+ its SQL and skeleton cardId);
//   card_failed    → card ultimately failed (cardId + error);
//   done           → final viewSpecs;
//   error          → terminal failure of the entire run, message required.
// ---------------------------------------------------------------------------

/** Dashboard manifest card: skeleton is rendered before data is ready. */
export const plannedBoardCardSchema = z.strictObject({
  cardId: z.string().min(1),
  kind: viewKindSchema,
  title: z.string(),
});
export type PlannedBoardCard = z.infer<typeof plannedBoardCardSchema>;

export const runStepSchema = z.discriminatedUnion("step", [
  z.strictObject({
    step: z.literal("exploring"),
    message: z.string().optional(),
  }),
  z.strictObject({
    step: z.literal("generating_sql"),
    message: z.string().optional(),
  }),
  z.strictObject({
    step: z.literal("board_planned"),
    cards: z.array(plannedBoardCardSchema).min(1),
    message: z.string().optional(),
  }),
  z.strictObject({
    step: z.literal("clarify"),
    /** Question for the user in the language of their question. */
    question: z.string().min(1),
    /** Short answer options — UI renders them as chips. */
    options: z.array(z.string()).optional(),
    message: z.string().optional(),
  }),
  z.strictObject({
    step: z.literal("impossible"),
    /** Why the available data cannot answer the question. */
    reason: z.string().min(1),
    /** What IS in the data — 2–4 hints about what to ask instead. */
    available: z.array(z.string()).optional(),
    message: z.string().optional(),
  }),
  z.strictObject({
    step: z.literal("reviewing"),
    sqlPreview: z.string().optional(),
    message: z.string().optional(),
  }),
  z.strictObject({
    step: z.literal("executing"),
    sqlPreview: z.string().optional(),
    message: z.string().optional(),
  }),
  z.strictObject({
    step: z.literal("healing"),
    attempt: z.number().int().min(1),
    error: z.string().optional(),
    message: z.string().optional(),
  }),
  z.strictObject({
    step: z.literal("materializing"),
    table: z.string().optional(),
    message: z.string().optional(),
  }),
  z.strictObject({
    step: z.literal("card_ready"),
    /** Skeleton cardId from board_planned — UI hydrates it in place. */
    cardId: z.string().optional(),
    viewSpec: viewSpecSchema,
    /** SQL that produced the card (for sql-based cards) — sample in the step feed. */
    sql: z.string().optional(),
    message: z.string().optional(),
  }),
  z.strictObject({
    step: z.literal("card_failed"),
    /** Skeleton cardId from board_planned. */
    cardId: z.string().optional(),
    error: z.string(),
    message: z.string().optional(),
  }),
  z.strictObject({
    step: z.literal("done"),
    viewSpecs: z.array(viewSpecSchema),
    message: z.string().optional(),
  }),
  z.strictObject({
    step: z.literal("error"),
    message: z.string(),
  }),
]);
export type RunStep = z.infer<typeof runStepSchema>;
export type RunStepName = RunStep["step"];

/**
 * Step labels for UI progress (C2) — single source of truth, bilingual.
 * Run language comes from the question (detectAnswerLanguage), see language.ts:
 * reasoning must speak in the answer language.
 */
export const RUN_STEP_LABELS_BY_LANGUAGE: Record<
  AnswerLanguage,
  Record<RunStepName, string>
> = {
  Russian: {
    exploring: "Изучаю схему",
    generating_sql: "Продумываю запросы",
    board_planned: "План дашборда",
    clarify: "Нужно уточнение",
    impossible: "Данных не хватает",
    reviewing: "Проверяю запрос",
    executing: "Выполняю",
    healing: "Чиню запрос",
    materializing: "Материализую срез",
    card_ready: "Карточка готова",
    card_failed: "Карточка не удалась",
    done: "Готово",
    error: "Ошибка",
  },
  English: {
    exploring: "Exploring schema",
    generating_sql: "Planning queries",
    board_planned: "Dashboard plan",
    clarify: "Need a clarification",
    impossible: "Not enough data",
    reviewing: "Reviewing query",
    executing: "Running",
    healing: "Fixing query",
    materializing: "Materializing slice",
    card_ready: "Card ready",
    card_failed: "Card failed",
    done: "Done",
    error: "Error",
  },
};

/** Step label in the run language. */
export function runStepLabel(step: RunStepName, language: AnswerLanguage): string {
  return RUN_STEP_LABELS_BY_LANGUAGE[language][step];
}

/**
 * Russian labels as before — backward compatibility for code that has not yet
 * received the run language. New code should call runStepLabel(step, language).
 */
export const RUN_STEP_LABELS: Record<RunStepName, string> =
  RUN_STEP_LABELS_BY_LANGUAGE.Russian;
