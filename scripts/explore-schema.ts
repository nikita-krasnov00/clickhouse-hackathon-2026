/**
 * B2 live without Trigger: `npm run explore:schema`.
 * Dynamic table discovery under agent_ro and live schema context collection.
 * No persistent cache — the script shows exactly what the agent will see on
 * the next run, and measures how long that costs.
 */
import { runExploreSchema } from "../src/lib/agent/explore";

async function main() {
  const t0 = Date.now();
  const { contexts } = await runExploreSchema();
  const elapsedMs = Date.now() - t0;

  for (const ctx of contexts) {
    console.log(`\n=== ${ctx.table}`);
    console.log(`  rows: ${ctx.rowCount.toLocaleString("ru-RU")}`);
    console.log(
      `  ${ctx.dateColumn}: ${ctx.dateRange.min} … ${ctx.dateRange.max}`,
    );
    console.log(`  columns: ${ctx.columns.length}`);
    for (const key of ctx.keyColumns) {
      const top3 = key.top
        .slice(0, 3)
        .map((t) => `${t.v} (${t.n})`)
        .join(", ");
      console.log(
        `  ${key.column}: uniq=${key.cardinality}, top-${key.top.length}: ${top3}, …`,
      );
    }
    console.log(`  samples: ${ctx.sampleRows.length}`);
    console.log(`  JSON context size: ${JSON.stringify(ctx).length} bytes`);
  }

  console.log(
    `\nLive exploration: ${contexts.length} table(s) in ${elapsedMs} ms — what a run pays without warm memoization`,
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
