/**
 * ClickHouse connection smoke test under agent_ro: `npm run ch:ping`.
 * Reads env from .env (--env-file flag in the npm script).
 */
import { createReadonlyClient } from "../src/lib/clickhouse";

async function main() {
  const client = createReadonlyClient();
  try {
    const rs = await client.query({
      query: "SELECT 1 AS ok, version() AS version, currentUser() AS user",
      format: "JSONEachRow",
    });
    const rows = await rs.json<{ ok: number; version: string; user: string }>();
    const row = rows[0];
    if (!row || row.ok !== 1) {
      throw new Error(`unexpected response: ${JSON.stringify(rows)}`);
    }
    console.log(
      `ch:ping OK — ClickHouse ${row.version}, user=${row.user}, SELECT 1 → ${row.ok}`,
    );
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("ch:ping FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
