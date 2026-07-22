import { logger, metadata, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { createReadonlyClient } from "@/lib/clickhouse";
import { runStepSchema, clickContextSchema, type RunStep } from "@/lib/contracts";
import { triageCardSchema } from "@/lib/agent/triage";
import { cardTitle, runPlannedCard } from "@/lib/agent/pipeline";

/**
 * Child investigate-card task: runs ONE triage plan card on its own worker —
 * generates SQL for the assigned kind/title/hint, executes and heals it.
 * The parent (src/trigger/investigate.ts) launches these runs in a batch via
 * batch.triggerByTaskAndWait — real parallelism instead of Promise.all
 * inside a single run.
 *
 * Progress: the frontend subscribes ONLY to parent metadata, so each step
 * (generating_sql → executing → healing → card_ready|card_failed) goes out via
 * metadata.parent.append — the canonical SDK v4 way to write parent run
 * metadata. Steps are also duplicated in this run's metadata — handy for
 * inspecting the child run in the dashboard.
 *
 * Output is always a CardOutcome-compatible object: card failure = ok:false,
 * NOT an exception (no retries; SQL self-healing is already inside runPlannedCard).
 * The parent does not crash: it collects outcomes and decides what to show.
 */

/** Zod copy of SchemaContext (src/lib/agent/explore.ts) for payload validation. */
const schemaContextSchema = z.object({
  table: z.string(),
  rowCount: z.number(),
  sortingKey: z.array(z.string()),
  dateColumn: z.string(),
  dateRange: z.object({ min: z.string(), max: z.string() }),
  columns: z.array(
    z.object({ name: z.string(), type: z.string(), comment: z.string().optional() }),
  ),
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
  card: triageCardSchema,
  question: z.string().min(1),
  clickContext: clickContextSchema.optional(),
  schemaContext: z.array(schemaContextSchema).min(1),
  /** Card label in step messages; defaults to its title. */
  label: z.string().optional(),
});

export const investigateCardTask = schemaTask({
  id: "investigate-card",
  schema: investigateCardPayloadSchema,
  // One card must finish with headroom inside the parent's 300 s limit.
  maxDuration: 180,
  // Retries off: self-healing (up to 3 healSql attempts) is already inside runSqlCard.
  retry: { maxAttempts: 1 },
  run: async (payload) => {
    const label = payload.label ?? cardTitle(payload.card);
    logger.info("investigate-card: start", {
      cardId: payload.card.cardId,
      kind: payload.card.kind,
      label,
    });

    const emit = (step: RunStep) => {
      // Strict Realtime progress contract validation before each emit.
      const parsed = runStepSchema.parse(step);
      // Frontend listens to the parent — step goes to its metadata…
      metadata.parent.append("steps", parsed);
      metadata.parent.set("lastStep", parsed);
      // …and is duplicated locally (Trigger.dev dashboard, debugging).
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

      logger.info("investigate-card: done", {
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
