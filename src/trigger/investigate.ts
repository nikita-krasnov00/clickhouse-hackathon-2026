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
 * B3 — durable investigate task: question (+ optional ClickContext from a
 * "why?" click) → v2 pipeline: catalog → triage (clarify/impossible/board_planned)
 * → deep reconnaissance of selected tables → cards → done with ViewSpec[].
 *
 * Plan cards run in PARALLEL CHILD investigate-card RUNS
 * (batch.triggerByTaskAndWait — real worker parallelism), not Promise.all
 * in this run; each child generates SQL for its own card.
 * Child progress is visible to the frontend without contract changes: each
 * child writes its steps to THIS run's metadata via metadata.parent.append.
 *
 * Progress streams via metadata (Trigger.dev Realtime):
 *   - metadata.steps — ordered array of all RunStep values (strict runStepSchema);
 *   - metadata.lastStep — latest step (handy for the C2 indicator).
 * The frontend subscribes to the run (useRealtimeRun / runs.subscribeToRun,
 * token from /api/ask — B7) and reads run.metadata; final viewSpecs arrive
 * directly in the done step — no separate result fetch needed.
 *
 * Input is compatible with askRequestSchema — /api/ask (B7) forwards the
 * body as-is. Task-level retries are off: self-healing (up to 3 attempts)
 * lives inside the pipeline, and the terminal error step must be shown once.
 * A child failure/timeout does NOT crash the parent — it becomes CardOutcome {ok:false}.
 */

function childErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/**
 * Card runner on child runs. If the batch itself fails (e.g. API unavailable),
 * fall back to in-process execution so the parent run survives.
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
        // Child crashed/timed out — card failed, parent survives.
        return {
          ok: false,
          error: `${cardLabel(cards[i], many)}: дочерний ран ${run.id} не завершился — ${childErrorMessage(run.error)}`,
          attempts: 1,
        };
      }
      const out = run.output;
      // Sanity-check ViewSpec after serialization through the Trigger API.
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
    logger.error("investigate: child-run batch failed — falling back to in-process", {
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
    logger.info("investigate: start", {
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

    logger.info("investigate: done", {
      attempts: result.attempts,
      viewSpecKinds: result.viewSpecs.map((v) => v.kind),
    });
    return { viewSpecs: result.viewSpecs, sql: result.sql };
  },
});
