/**
 * B2 живьём без Trigger: `npm run explore:schema`.
 * Динамическое обнаружение таблиц под agent_ro и живой сбор контекста схемы.
 * Персистентного кэша нет — скрипт показывает ровно то, что увидит агент
 * на ближайшем ране, и меряет, во что это обходится по времени.
 */
import { runExploreSchema } from "../src/lib/agent/explore";

async function main() {
  const t0 = Date.now();
  const { contexts } = await runExploreSchema();
  const elapsedMs = Date.now() - t0;

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

  console.log(
    `\nЖивое исследование: ${contexts.length} таблиц(ы) за ${elapsedMs} мс — столько заплатит ран без тёплой мемоизации`,
  );
  console.log("\nexplore:schema OK");
}

main().catch((err) => {
  console.error(
    "explore:schema FAILED:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
