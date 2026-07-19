/**
 * Хвост операционного лога LLM-вызовов: `npm run llm:log` (по умолчанию 20
 * последних) или `npm run llm:log -- 50`. Полный промпт/ответ конкретной
 * строки: `npm run llm:log -- --full <N>` (N — номер строки из выдачи).
 */
import { createScratchClient } from "../src/lib/clickhouse";
import { LLM_LOG_TABLE } from "../src/lib/agent/llm-log";

type LogRow = {
  ts: string;
  purpose: string;
  model: string;
  attempt: number;
  status: string;
  error: string;
  request: string;
  response: string;
  request_chars: number;
  response_chars: number;
  elapsed_ms: number;
};

function short(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a.trim().length > 0);
  const fullIdx = args.indexOf("--full");
  const fullRow = fullIdx >= 0 ? Number(args[fullIdx + 1] ?? 1) : undefined;
  const limit = Number(args.find((a) => /^\d+$/.test(a)) ?? 20);

  const client = createScratchClient();
  try {
    const rs = await client.query({
      query: `
        SELECT toString(ts) AS ts, purpose, model, attempt, status, error,
               request, response, request_chars, response_chars, elapsed_ms
        FROM ${LLM_LOG_TABLE}
        ORDER BY ts DESC
        LIMIT {limit:UInt32}
      `,
      query_params: { limit: Math.max(limit, fullRow ?? 0) },
      format: "JSONEachRow",
    });
    const rows = await rs.json<LogRow>();
    if (rows.length === 0) {
      console.log(`${LLM_LOG_TABLE} пуст — ни одного LLM-вызова ещё не записано.`);
      return;
    }

    if (fullRow !== undefined) {
      const row = rows[fullRow - 1];
      if (!row) throw new Error(`строки №${fullRow} нет (всего ${rows.length})`);
      console.log(`=== ${row.ts} · ${row.purpose} · ${row.model} · попытка ${row.attempt} · ${row.status} · ${row.elapsed_ms} мс`);
      if (row.error) console.log(`--- error\n${row.error}`);
      console.log("--- request (messages JSON)");
      console.log(JSON.stringify(JSON.parse(row.request), null, 2));
      console.log("--- response");
      console.log(row.response || "(пусто)");
      return;
    }

    console.log(`Последние ${rows.length} LLM-вызовов (${LLM_LOG_TABLE}), новые сверху:\n`);
    rows.forEach((r, i) => {
      const head = [
        String(i + 1).padStart(2),
        r.ts,
        r.status === "ok" ? "ok " : "ERR",
        r.purpose.padEnd(22),
        r.model,
        `#${r.attempt}`,
        `${r.elapsed_ms} мс`,
        `${r.request_chars}→${r.response_chars} симв.`,
      ].join("  ");
      console.log(head);
      console.log(`    ${r.status === "ok" ? short(r.response, 140) : short(r.error, 140)}`);
    });
    console.log("\nПолная строка: npm run llm:log -- --full <N>");
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("llm:log FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
