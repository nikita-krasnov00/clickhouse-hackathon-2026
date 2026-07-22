/**
 * Tail of the operational LLM call log: `npm run llm:log` (last 20 by default)
 * or `npm run llm:log -- 50`. Full prompt/response for a specific row:
 * `npm run llm:log -- --full <N>` (N is the row number from the listing).
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
      console.log(`${LLM_LOG_TABLE} is empty — no LLM calls recorded yet.`);
      return;
    }

    if (fullRow !== undefined) {
      const row = rows[fullRow - 1];
      if (!row) throw new Error(`row #${fullRow} does not exist (total ${rows.length})`);
      console.log(`=== ${row.ts} · ${row.purpose} · ${row.model} · attempt ${row.attempt} · ${row.status} · ${row.elapsed_ms} ms`);
      if (row.error) console.log(`--- error\n${row.error}`);
      console.log("--- request (messages JSON)");
      console.log(JSON.stringify(JSON.parse(row.request), null, 2));
      console.log("--- response");
      console.log(row.response || "(empty)");
      return;
    }

    console.log(`Last ${rows.length} LLM calls (${LLM_LOG_TABLE}), newest first:\n`);
    rows.forEach((r, i) => {
      const head = [
        String(i + 1).padStart(2),
        r.ts,
        r.status === "ok" ? "ok " : "ERR",
        r.purpose.padEnd(22),
        r.model,
        `#${r.attempt}`,
        `${r.elapsed_ms} ms`,
        `${r.request_chars}→${r.response_chars} chars`,
      ].join("  ");
      console.log(head);
      console.log(`    ${r.status === "ok" ? short(r.response, 140) : short(r.error, 140)}`);
    });
    console.log("\nFull row: npm run llm:log -- --full <N>");
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("llm:log FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
