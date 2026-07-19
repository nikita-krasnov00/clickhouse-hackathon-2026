import { batch, logger, metadata, schemaTask } from "@trigger.dev/sdk";
import { askRequestSchema, viewSpecSchema, type RunStep } from "@/lib/contracts";
import {
  cardLabel,
  cardTitle,
  runCardsInProcess,
  runInvestigatePipeline,
  type CardOutcome,
  type CardRunner,
} from "@/lib/agent/pipeline";
import { investigateCardTask } from "./investigate-card";

/**
 * B3 — durable-таска investigate: вопрос (+ опциональный ClickContext из клика
 * «почему?») → конвейер exploring → generating_sql → planning → карточки →
 * done с ViewSpec[].
 *
 * Карточки плана исполняются ПАРАЛЛЕЛЬНЫМИ ДОЧЕРНИМИ РАНАМИ investigate-card
 * (batch.triggerByTaskAndWait — настоящий параллелизм на воркерах), а не
 * Promise.all в этом ране. «Мгновенный срез» (runInstantPreview) остаётся в
 * родителе. Прогресс детей виден фронту без изменений контракта: каждый
 * ребёнок пишет свои шаги в metadata ЭТОГО рана через metadata.parent.append.
 *
 * Прогресс стримится через metadata (Trigger.dev Realtime):
 *   - metadata.steps — массив всех RunStep рана по порядку (строго runStepSchema);
 *   - metadata.lastStep — последний шаг (удобно для индикатора C2).
 * Фронт подписывается на ран (useRealtimeRun / runs.subscribeToRun, токен выдаёт
 * /api/ask — B7) и читает run.metadata; финальные viewSpecs приходят прямо в
 * шаге done — отдельный fetch результата не нужен.
 *
 * Вход совместим с askRequestSchema — /api/ask (B7) прокидывает тело как есть.
 * Ретраи на уровне тасок выключены: самопочинка (до 3 попыток) живёт внутри
 * конвейера, а терминальный шаг error должен показаться пользователю один раз.
 * Падение/таймаут ребёнка НЕ роняет родителя — это CardOutcome {ok:false}.
 */

function childErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/**
 * Исполнитель карточек на дочерних ранах. Если сам batch не удался (например,
 * недоступен API) — фоллбек на in-process исполнение, чтобы ран выжил.
 */
const runCardsInChildRuns: CardRunner = async (cards, ctx) => {
  if (cards.length === 0) return [];
  const many = cards.length > 1;
  try {
    const { runs } = await batch.triggerByTaskAndWait(
      cards.map((card) => ({
        task: investigateCardTask,
        payload: {
          card,
          question: ctx.input.question,
          clickContext: ctx.input.context,
          schemaContext: ctx.schemaContext,
          label: cardLabel(card, many),
        },
      })),
    );
    return runs.map((run, i): CardOutcome => {
      if (!run.ok) {
        // Ребёнок упал/зависший таймаут — карточка не удалась, родитель живёт.
        return {
          ok: false,
          error: `${cardLabel(cards[i], many)}: дочерний ран ${run.id} не завершился — ${childErrorMessage(run.error)}`,
          attempts: 1,
        };
      }
      const out = run.output;
      // Контрольная валидация ViewSpec после сериализации через Trigger API.
      return out.ok
        ? {
            ok: true,
            spec: viewSpecSchema.parse(out.spec),
            ...(out.sql ? { sql: out.sql } : {}),
            attempts: out.attempts,
          }
        : { ok: false, error: out.error, attempts: out.attempts };
    });
  } catch (err) {
    logger.error("investigate: batch дочерних ранов не удался — фоллбек in-process", {
      error: childErrorMessage(err),
      cards: cards.map((c) => cardTitle(c)),
    });
    return runCardsInProcess(cards, ctx);
  }
};

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

    const result = await runInvestigatePipeline(payload, {
      emit,
      cardRunner: runCardsInChildRuns,
    });

    logger.info("investigate: готово", {
      attempts: result.attempts,
      viewSpecKinds: result.viewSpecs.map((v) => v.kind),
    });
    return { viewSpecs: result.viewSpecs, sql: result.sql };
  },
});
