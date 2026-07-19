import { logger, task } from "@trigger.dev/sdk";
import { runExploreSchema } from "@/lib/agent/explore";

/**
 * B2 — таска exploration: живое обнаружение таблиц + count + min/max дат +
 * топ-N/кардинальности ключевых колонок + сэмплы. Персистентного кэша нет —
 * таска показывает контекст, который агент соберёт на ближайшем ране.
 *
 * Запускается вручную из дашборда (payload {}) или триггером из кода;
 * тот же код локально без Trigger: `npm run explore:schema`.
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
    logger.info("explore-schema: контекст обновлён", { summary });
    return { tables: summary };
  },
});
