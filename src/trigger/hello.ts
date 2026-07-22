import { logger, task, wait } from "@trigger.dev/sdk";

/**
 * Example durable task (B1) — verifies the Trigger.dev setup works.
 *
 * Durable means: the run survives worker restarts. `wait.for` creates a
 * checkpoint — the process may die during the wait, and the run resumes
 * from that point. Real project tasks (explore-schema — B2,
 * investigate — B3) will live alongside this one in this folder.
 *
 * Run: `npx trigger.dev@latest dev`, then the Test tab in the dashboard,
 * payload like {"name": "ClickHouse"}.
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
    logger.info("hello: start", { name, runId: ctx.run.id });

    // Checkpoint: durable wait that survives a worker restart.
    await wait.for({ seconds: 5 });

    logger.info("hello: woke up after wait.for — run is durable");
    return {
      greeting: `Привет, ${name}!`,
      runId: ctx.run.id,
      attempt: ctx.attempt.number,
    };
  },
});
