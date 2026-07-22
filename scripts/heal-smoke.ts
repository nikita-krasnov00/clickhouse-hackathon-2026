/**
 * B5 live: `npm run heal:smoke` — self-healing check against real ClickHouse.
 *
 * Two parts:
 *   1) unit run of healSql() directly: artificially broken SQL (nonexistent
 *      column) → real ClickHouse error → model returns fixed SQL → fixed SQL
 *      executes successfully;
 *   2) full pipeline via test seams triageImpl + cardSqlImpl: first generation
 *      is intentionally broken — log shows executing → healing →
 *      executing → card_ready → done.
 */
import { createReadonlyClient } from "../src/lib/clickhouse";
import { exploreSchema } from "../src/lib/agent/explore";
import { healSql, sanitizeSql, type GeneratedSql } from "../src/lib/agent/generate-sql";
import { runInvestigatePipeline } from "../src/lib/agent/pipeline";
import type { RunStep } from "../src/lib/contracts";

const QUESTION = "top starred repos this year";

/** Broken SQL: columns repo_nam and event_typ do not exist. */
const BROKEN: GeneratedSql = {
  kind: "leaderboard",
  title: "Топ репозиториев по звёздам за год",
  sql:
    "SELECT repo_nam AS repo, count() AS stars FROM github.github_events " +
    "WHERE event_typ = 'WatchEvent' AND created_at >= now() - INTERVAL 1 YEAR " +
    "GROUP BY repo ORDER BY stars DESC LIMIT 10",
};

function printStep(step: RunStep) {
  switch (step.step) {
    case "executing":
      console.log(`  → executing${step.message ? ` (${step.message})` : ""}`);
      break;
    case "healing":
      console.log(`  → healing (attempt ${step.attempt}): ${(step.error ?? "").slice(0, 200)}`);
      break;
    case "done":
      console.log(`  → done: ${step.message ?? ""}`);
      break;
    default:
      console.log(`  → ${step.step}${step.message ? `: ${step.message}` : ""}`);
  }
}

async function main() {
  const ro = createReadonlyClient();
  try {
    // -- Part 1: healSql directly ------------------------------------------
    console.log("=== Part 1: healSql() directly with broken SQL");
    const schemaContext = await exploreSchema(ro);

    let chError = "";
    try {
      await ro.query({ query: BROKEN.sql, format: "JSONEachRow" });
      throw new Error("broken SQL unexpectedly executed — test is invalid");
    } catch (err) {
      chError = err instanceof Error ? err.message : String(err);
    }
    console.log(`  ClickHouse error: ${chError.slice(0, 200)}…`);

    const healed = await healSql({
      question: QUESTION,
      schemaContext,
      card: { kind: BROKEN.kind, title: BROKEN.title },
      previous: BROKEN,
      error: chError,
      attempt: 1,
    });
    console.log(`  healed SQL: ${healed.sql}`);

    const rs = await ro.query({
      query: sanitizeSql(healed.sql),
      format: "JSONEachRow",
    });
    const rows = await rs.json<Record<string, unknown>>();
    if (rows.length === 0) {
      throw new Error("healed SQL returned 0 rows");
    }
    console.log(`  healed SQL executed: ${rows.length} rows, first: ${JSON.stringify(rows[0])}`);

    // -- Part 2: pipeline with intentionally broken first generation -------
    console.log("\n=== Part 2: pipeline, first generation broken (triageImpl+cardSqlImpl seams)");
    const result = await runInvestigatePipeline(
      { question: QUESTION },
      {
        emit: printStep,
        // Forced triage: one leaderboard card on the broken SQL table.
        triageImpl: async () => ({
          decision: "proceed",
          tables: ["github.github_events"],
          cards: [{ cardId: "card-1", kind: BROKEN.kind, title: BROKEN.title }],
        }),
        // First generation is broken SQL; real healSql does the repair.
        cardSqlImpl: async () => BROKEN,
      },
    );
    if (result.attempts < 2) {
      throw new Error("expected at least one heal, but pipeline succeeded on first attempt");
    }
    console.log(
      `  result: ${result.viewSpecs.length} ViewSpec, SQL attempts: ${result.attempts}, final SQL: ${result.sql}`,
    );
    console.log("\nheal:smoke OK");
  } finally {
    await ro.close();
  }
}

main().catch((err) => {
  console.error("heal:smoke FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
