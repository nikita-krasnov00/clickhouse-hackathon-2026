import { logger, metadata, schemaTask } from "@trigger.dev/sdk";
import { askRequestSchema, type RunStep } from "@/lib/contracts";
import { runInvestigatePipeline } from "@/lib/agent/pipeline";

/**
 * B3 — durable-таска investigate: вопрос (+ опциональный ClickContext из клика
 * «почему?») → конвейер exploring → generating_sql → executing (+ healing) →
 * done с ViewSpec[].
 *
 * Прогресс стримится через metadata (Trigger.dev Realtime):
 *   - metadata.steps — массив всех RunStep рана по порядку (строго runStepSchema);
 *   - metadata.lastStep — последний шаг (удобно для индикатора C2).
 * Фронт подписывается на ран (useRealtimeRun / runs.subscribeToRun, токен выдаёт
 * /api/ask — B7) и читает run.metadata; финальные viewSpecs приходят прямо в
 * шаге done — отдельный fetch результата не нужен.
 *
 * Вход совместим с askRequestSchema — /api/ask (B7) прокидывает тело как есть.
 * Ретраи на уровне таски выключены: самопочинка (до 3 попыток) живёт внутри
 * конвейера, а терминальный шаг error должен показаться пользователю один раз.
 */
export const investigateTask = schemaTask({
  id: "investigate",
  schema: askRequestSchema,
  maxDuration: 300,
  retry: { maxAttempts: 1 },
  run: async (payload) => {
    logger.info("investigate: старт", {
      question: payload.question,
      hasClickContext: Boolean(payload.context),
    });

    const emit = (step: RunStep) => {
      metadata.append("steps", step);
      metadata.set("lastStep", step);
    };

    const result = await runInvestigatePipeline(payload, { emit });

    logger.info("investigate: готово", {
      attempts: result.attempts,
      viewSpecKinds: result.viewSpecs.map((v) => v.kind),
    });
    return { viewSpecs: result.viewSpecs, sql: result.sql };
  },
});
