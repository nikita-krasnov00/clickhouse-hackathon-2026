import { logger, task, wait } from "@trigger.dev/sdk";

/**
 * Пример durable-таски (B1) — проверка, что связка Trigger.dev работает.
 *
 * Durable означает: ран переживает рестарты воркера. `wait.for` создаёт
 * checkpoint — процесс может умереть во время ожидания, ран продолжится
 * с этого места. Настоящие таски проекта (explore-schema — B2,
 * investigate — B3) появятся рядом в этой папке.
 *
 * Запуск: `npx trigger.dev@latest dev`, затем таб Test в дашборде,
 * payload вида {"name": "ClickHouse"}.
 */
export const helloTask = task({
  id: "hello",
  maxDuration: 60,
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 5000,
    factor: 2,
  },
  run: async (payload: { name?: string }, { ctx }) => {
    const name = payload.name ?? "мир";
    logger.info("hello: старт", { name, runId: ctx.run.id });

    // Checkpoint: durable-ожидание, переживает рестарт воркера.
    await wait.for({ seconds: 5 });

    logger.info("hello: проснулись после wait.for — ран durable");
    return {
      greeting: `Привет, ${name}!`,
      runId: ctx.run.id,
      attempt: ctx.attempt.number,
    };
  },
});
