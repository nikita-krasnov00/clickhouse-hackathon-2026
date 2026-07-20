/**
 * B5 живьём: `npm run heal:smoke` — проверка самопочинки на реальном ClickHouse.
 *
 * Две части:
 *   1) юнит-прогон healSql() напрямую: искусственно битый SQL (несуществующая
 *      колонка) → реальная ошибка ClickHouse → модель возвращает исправленный
 *      SQL → исправленный SQL успешно исполняется;
 *   2) конвейер целиком через тест-швы triageImpl + cardSqlImpl: первая
 *      генерация намеренно битая — в логе видно executing → healing →
 *      executing → card_ready → done.
 */
import { createReadonlyClient } from "../src/lib/clickhouse";
import { exploreSchema } from "../src/lib/agent/explore";
import { healSql, sanitizeSql, type GeneratedSql } from "../src/lib/agent/generate-sql";
import { runInvestigatePipeline } from "../src/lib/agent/pipeline";
import type { RunStep } from "../src/lib/contracts";

const QUESTION = "top starred repos this year";

/** Битый SQL: колонки repo_nam и event_typ не существуют. */
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
      console.log(`  → healing (попытка ${step.attempt}): ${(step.error ?? "").slice(0, 200)}`);
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
    // -- Часть 1: healSql напрямую ------------------------------------------
    console.log("=== Часть 1: healSql() напрямую с битым SQL");
    const schemaContext = await exploreSchema(ro);

    let chError = "";
    try {
      await ro.query({ query: BROKEN.sql, format: "JSONEachRow" });
      throw new Error("битый SQL внезапно исполнился — тест невалиден");
    } catch (err) {
      chError = err instanceof Error ? err.message : String(err);
    }
    console.log(`  ошибка ClickHouse: ${chError.slice(0, 200)}…`);

    const healed = await healSql({
      question: QUESTION,
      schemaContext,
      card: { kind: BROKEN.kind, title: BROKEN.title },
      previous: BROKEN,
      error: chError,
      attempt: 1,
    });
    console.log(`  исправленный SQL: ${healed.sql}`);

    const rs = await ro.query({
      query: sanitizeSql(healed.sql),
      format: "JSONEachRow",
    });
    const rows = await rs.json<Record<string, unknown>>();
    if (rows.length === 0) {
      throw new Error("исправленный SQL вернул 0 строк");
    }
    console.log(`  исправленный SQL исполнился: ${rows.length} строк, первая: ${JSON.stringify(rows[0])}`);

    // -- Часть 2: конвейер с намеренно битой первой генерацией ---------------
    console.log("\n=== Часть 2: конвейер, первая генерация битая (швы triageImpl+cardSqlImpl)");
    const result = await runInvestigatePipeline(
      { question: QUESTION },
      {
        emit: printStep,
        // Триаж навязан: одна leaderboard-карточка по таблице битого SQL.
        triageImpl: async () => ({
          decision: "proceed",
          tables: ["github.github_events"],
          cards: [{ cardId: "card-1", kind: BROKEN.kind, title: BROKEN.title }],
        }),
        // Первая генерация — битый SQL; починку делает настоящая healSql.
        cardSqlImpl: async () => BROKEN,
      },
    );
    if (result.attempts < 2) {
      throw new Error("ожидалась минимум одна починка, а конвейер прошёл с первой попытки");
    }
    console.log(
      `  результат: ${result.viewSpecs.length} ViewSpec, попыток SQL: ${result.attempts}, итоговый SQL: ${result.sql}`,
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
