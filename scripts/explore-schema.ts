/**
 * B2 живьём без Trigger: `npm run explore:schema`.
 * Исследует целевые таблицы под agent_ro, кэширует контекст в
 * scratch.schema_context под agent_scratch и показывает, что кэш наполнился.
 */
import { loadSchemaContext, runExploreSchema } from "../src/lib/agent/explore";
import { createScratchClient } from "../src/lib/clickhouse";

async function main() {
  const { contexts } = await runExploreSchema();

  for (const ctx of contexts) {
    console.log(`\n=== ${ctx.table}`);
    console.log(`  строк: ${ctx.rowCount.toLocaleString("ru-RU")}`);
    console.log(
      `  ${ctx.dateColumn}: ${ctx.dateRange.min} … ${ctx.dateRange.max}`,
    );
    console.log(`  колонок: ${ctx.columns.length}`);
    for (const key of ctx.keyColumns) {
      const top3 = key.top
        .slice(0, 3)
        .map((t) => `${t.v} (${t.n})`)
        .join(", ");
      console.log(
        `  ${key.column}: uniq=${key.cardinality}, топ-${key.top.length}: ${top3}, …`,
      );
    }
    console.log(`  сэмплов: ${ctx.sampleRows.length}`);
    console.log(`  размер JSON-контекста: ${JSON.stringify(ctx).length} байт`);
  }

  // Контрольное чтение кэша — убеждаемся, что персист сработал.
  const scratch = createScratchClient();
  try {
    const persisted = await loadSchemaContext(scratch);
    console.log(`\nscratch.schema_context: ${persisted.length} таблиц(ы) в кэше`);
    for (const ctx of persisted) {
      console.log(
        `  ${ctx.table} — rowCount=${ctx.rowCount}, columns=${ctx.columns.length}, keyColumns=${ctx.keyColumns.length}`,
      );
    }
    if (persisted.length === 0) {
      throw new Error("кэш пуст после персиста");
    }
  } finally {
    await scratch.close();
  }

  console.log("\nexplore:schema OK");
}

main().catch((err) => {
  console.error(
    "explore:schema FAILED:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
