/**
 * HTTP-контракты (/api/ask, /api/drill) и Realtime-прогресс рана (J1, заморожено).
 */
import { z } from "zod";
import { clickContextSchema, selectionSchema } from "./click";
import { viewSpecSchema } from "./view-spec";

// ---------------------------------------------------------------------------
// Drill API — быстрый путь без LLM.
// POST /api/drill { drillId, params } → { viewSpec }
// Каталог drillId и имена параметров — трек A (задача A4); имена параметров
// совпадают с selectionKeys клик-целей (см. ClickTarget в view-spec.ts).
// ---------------------------------------------------------------------------

export const drillRequestSchema = z.strictObject({
  drillId: z.string().min(1),
  params: selectionSchema,
});
export type DrillRequest = z.infer<typeof drillRequestSchema>;

export const drillResponseSchema = z.strictObject({
  viewSpec: viewSpecSchema,
});
export type DrillResponse = z.infer<typeof drillResponseSchema>;

// ---------------------------------------------------------------------------
// Ask API — вопрос (или «почему?» с контекстом клика) → агентный ран.
// POST /api/ask { question, context? } → { runId, publicAccessToken }
// Токен — public access token Trigger.dev для Realtime-подписки на ран.
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
// RunStep — прогресс конвейера investigate, стримится через Realtime.
//
// РЕШЕНИЕ J1: дискриминатор — `step`; у всех шагов опциональный `message`
// (человекочитаемая строка для ленты). Полезная нагрузка минимальна:
//   - reviewing / executing несут sqlPreview — C2 показывает превью SQL;
//   - healing несёт номер попытки (1..3) и текст ошибки ClickHouse —
//     «видимый шаг, а не позор»;
//   - materializing несёт имя temp-таблицы в scratch;
//   - done несёт итоговые viewSpecs — UI получает результат прямо из
//     Realtime-стрима, отдельный fetch не нужен;
//   - error — терминальная неудача (после исчерпания самопочинки), message
//     обязателен: его показывает фоллбек-карточка «вот что я пробовал».
// ---------------------------------------------------------------------------

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

/** Подписи шагов для прогресса в UI (C2) — одно место правды. */
export const RUN_STEP_LABELS: Record<RunStepName, string> = {
  exploring: "Изучаю схему",
  generating_sql: "Пишу SQL",
  reviewing: "Проверяю запрос",
  executing: "Выполняю",
  healing: "Чиню запрос",
  materializing: "Материализую срез",
  done: "Готово",
  error: "Ошибка",
};
