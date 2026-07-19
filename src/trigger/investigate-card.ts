import { logger, metadata, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { createReadonlyClient } from "@/lib/clickhouse";
import { runStepSchema, clickContextSchema, type RunStep } from "@/lib/contracts";
import { plannedCardSchema } from "@/lib/agent/generate-sql";
import { cardTitle, runPlannedCard } from "@/lib/agent/pipeline";

/**
 * Дочерняя таска investigate-card: исполняет ОДНУ карточку плана (sql или
 * drill) на своём воркере. Родитель (src/trigger/investigate.ts) запускает
 * такие раны пачкой через batch.triggerByTaskAndWait — настоящий параллелизм
 * вместо Promise.all внутри одного рана.
 *
 * Прогресс: фронт подписан ТОЛЬКО на metadata родителя, поэтому каждый шаг
 * (executing → healing → card_ready) уходит через metadata.parent.append —
 * канонический способ SDK v4 писать в metadata родительского рана. Дублируем
 * шаги и в собственную metadata — удобно смотреть ран ребёнка в дашборде.
 *
 * Выход — всегда CardOutcome-совместимый объект: неудача карточки = ok:false,
 * НЕ исключение (ретраев нет, самопочинка SQL уже внутри runSqlCard). Родитель
 * при этом не падает: он собирает исходы и решает, что показать.
 */

/** Zod-копия SchemaContext (src/lib/agent/explore.ts) для валидации payload. */
const schemaContextSchema = z.object({
  table: z.string(),
  rowCount: z.number(),
  dateColumn: z.string(),
  dateRange: z.object({ min: z.string(), max: z.string() }),
  columns: z.array(z.object({ name: z.string(), type: z.string() })),
  keyColumns: z.array(
    z.object({
      column: z.string(),
      cardinality: z.number(),
      top: z.array(z.object({ v: z.string(), n: z.number() })),
    }),
  ),
  sampleRows: z.array(z.record(z.string(), z.unknown())),
});

export const investigateCardPayloadSchema = z.object({
  card: plannedCardSchema,
  question: z.string().min(1),
  clickContext: clickContextSchema.optional(),
  schemaContext: z.array(schemaContextSchema).min(1),
  /** Подпись карточки в сообщениях шагов; дефолт — её title. */
  label: z.string().optional(),
});

export const investigateCardTask = schemaTask({
  id: "investigate-card",
  schema: investigateCardPayloadSchema,
  // Одна карточка обязана укладываться с запасом внутрь родительских 300 c.
  maxDuration: 180,
  // Ретраи выключены: самопочинка (до 3 попыток healSql) уже внутри runSqlCard.
  retry: { maxAttempts: 1 },
  run: async (payload) => {
    const label = payload.label ?? cardTitle(payload.card);
    logger.info("investigate-card: старт", {
      tool: payload.card.tool,
      label,
    });

    const emit = (step: RunStep) => {
      // Строгая валидация контракта Realtime-прогресса перед каждым эмитом.
      const parsed = runStepSchema.parse(step);
      // Фронт слушает родителя — шаг уходит в его metadata…
      metadata.parent.append("steps", parsed);
      metadata.parent.set("lastStep", parsed);
      // …и дублируется в свою (дашборд Trigger.dev, отладка).
      metadata.append("steps", parsed);
    };

    const ro = createReadonlyClient();
    try {
      const outcome = await runPlannedCard(payload.card, {
        ro,
        emit,
        input: {
          question: payload.question,
          ...(payload.clickContext ? { context: payload.clickContext } : {}),
        },
        schemaContext: payload.schemaContext,
        label,
      });

      logger.info("investigate-card: готово", {
        ok: outcome.ok,
        attempts: outcome.attempts,
        ...(outcome.ok ? { kind: outcome.spec.kind } : { error: outcome.error }),
      });
      return outcome.ok
        ? {
            ok: true as const,
            spec: outcome.spec,
            ...(outcome.sql ? { sql: outcome.sql } : {}),
            attempts: outcome.attempts,
          }
        : { ok: false as const, error: outcome.error, attempts: outcome.attempts };
    } finally {
      await ro.close();
    }
  },
});
