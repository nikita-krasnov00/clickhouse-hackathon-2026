/**
 * HTTP-контракты (/api/ask, /api/suggest) и Realtime-прогресс рана.
 *
 * v2 (dataset-agnostic): контракты /api/drill удалены — клик по карточке всегда
 * уходит НОВЫМ раном агента (action 'why' с ClickContext). Добавлены шаги
 * триажа: board_planned (манифест карточек — UI рисует скелеты мгновенно),
 * card_failed (скелет превращается в честную ошибку), clarify (агенту нужно
 * уточнение) и impossible (по данным в ClickHouse ответить нельзя).
 */
import { z } from "zod";
import { clickContextSchema } from "./click";
import { viewKindSchema, viewSpecSchema } from "./view-spec";

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
// Suggest API — вопросы-пресеты, сгенерированные по живому каталогу схем.
// GET /api/suggest → { questions } (пустой массив — валидный ответ-фоллбек).
// ---------------------------------------------------------------------------

export const suggestResponseSchema = z.strictObject({
  questions: z.array(z.string()),
});
export type SuggestResponse = z.infer<typeof suggestResponseSchema>;

// ---------------------------------------------------------------------------
// RunStep — прогресс конвейера investigate, стримится через Realtime.
//
// Дискриминатор — `step`; у всех шагов опциональный `message` (человекочитаемая
// строка для ленты). Порядок жизни рана v2:
//   exploring      → каталог таблиц, затем глубокая разведка выбранных;
//   generating_sql → триаж (выбор таблиц и карточек) и per-card генерация SQL;
//   board_planned  → манифест дашборда [{cardId, kind, title}] — UI сразу
//                    рисует СКЕЛЕТЫ карточек, не дожидаясь данных;
//   clarify        → агенту не хватает вводных: вопрос пользователю (+варианты);
//                    ран завершается пустым done — ответ приходит новым /api/ask;
//   impossible     → по данным в ClickHouse ответить нельзя: причина + что
//                    ЕСТЬ в данных (available); ран завершается пустым done;
//   reviewing / executing → несут sqlPreview (превью SQL в ленте);
//   healing        → номер попытки (1..3) и текст ошибки ClickHouse;
//   materializing  → имя temp-таблицы в scratch (B6, зарезервировано);
//   card_ready     → ОДНА готовая карточка (+ её SQL и cardId скелета);
//   card_failed    → карточка окончательно не удалась (cardId + error);
//   done           → итоговые viewSpecs;
//   error          → терминальная неудача всего рана, message обязателен.
// ---------------------------------------------------------------------------

/** Карточка манифеста дашборда: скелет рисуется до готовности данных. */
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
    /** Вопрос пользователю на языке его вопроса. */
    question: z.string().min(1),
    /** Короткие варианты ответа — UI рисует их чипами. */
    options: z.array(z.string()).optional(),
    message: z.string().optional(),
  }),
  z.strictObject({
    step: z.literal("impossible"),
    /** Почему по имеющимся данным ответить нельзя. */
    reason: z.string().min(1),
    /** Что в данных ЕСТЬ — 2–4 подсказки, о чём спрашивать. */
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
    /** cardId скелета из board_planned — UI гидратирует его на месте. */
    cardId: z.string().optional(),
    viewSpec: viewSpecSchema,
    /** SQL, которым получена карточка (для sql-карточек) — сэмпл в ленте шагов. */
    sql: z.string().optional(),
    message: z.string().optional(),
  }),
  z.strictObject({
    step: z.literal("card_failed"),
    /** cardId скелета из board_planned. */
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
 * Русские подписи шагов — справочник/фоллбек. UI берёт локализованные подписи
 * из messages/{en,ru,el}.json (неймспейс `steps`, ключи совпадают с RunStepName);
 * при добавлении шага обновить и словари.
 */
export const RUN_STEP_LABELS: Record<RunStepName, string> = {
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
};
