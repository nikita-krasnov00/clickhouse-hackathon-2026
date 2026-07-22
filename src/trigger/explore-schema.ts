import { logger, task } from "@trigger.dev/sdk";
import { runExploreSchema } from "@/lib/agent/explore";

/**
 * B2 — exploration task: live table discovery + count + min/max dates +
 * top-N/cardinalities of key columns + samples. No persistent cache —
 * the task shows the context the agent will gather on the next run.
 *
 * Trigger manually from the dashboard (payload {}) or from code;
 * same code locally without Trigger: `npm run explore:schema`.
 */
export const exploreSchemaTask = task({
  id: "explore-schema",
  maxDuration: 120,
  run: async () => {
    const { contexts } = await runExploreSchema();
    const summary = contexts.map((ctx) => ({
      table: ctx.table,
      rowCount: ctx.rowCount,
      dateRange: ctx.dateRange,
      columns: ctx.columns.length,
      keyColumns: ctx.keyColumns.map((k) => `${k.column} (uniq ${k.cardinality})`),
      contextBytes: JSON.stringify(ctx).length,
    }));
    logger.info("explore-schema: context refreshed", { summary });
    return { tables: summary };
  },
});
