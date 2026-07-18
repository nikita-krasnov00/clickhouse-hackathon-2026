import { createClient, type ClickHouseClient } from "@clickhouse/client";

/**
 * Фабрики ClickHouse-клиентов (B1).
 *
 * Два юзера с разными правами (создаёт трек A, задача A1):
 *  - `agent_ro`      — read-only: SELECT по github_events. Все запросы агента
 *                      и drill API ходят только под ним.
 *  - `agent_scratch` — запись в базу `scratch`: temp tables с TTL,
 *                      кэш схемы (B2, B6).
 *
 * CLICKHOUSE_URL в env хранится без протокола (host:port),
 * https:// добавляем здесь.
 */

function chUrl(): string {
  const raw = process.env.CLICKHOUSE_URL;
  if (!raw) {
    throw new Error("CLICKHOUSE_URL не задан — см. .env.example");
  }
  return raw.startsWith("http://") || raw.startsWith("https://")
    ? raw
    : `https://${raw}`;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} не задан — см. .env.example`);
  }
  return value;
}

/** Read-only клиент (agent_ro) — SQL агента и drill-запросы. */
export function createReadonlyClient(): ClickHouseClient {
  return createClient({
    url: chUrl(),
    username: requireEnv("AGENT_RO_USER"),
    password: requireEnv("AGENT_RO_PASSWORD"),
    request_timeout: 30_000,
    clickhouse_settings: {
      // Страховка на клиенте; серверные лимиты для agent_ro задаёт трек A (A5).
      max_execution_time: 30,
    },
  });
}

/** Scratch-клиент (agent_scratch) — temp tables и кэш схемы в базе scratch. */
export function createScratchClient(): ClickHouseClient {
  return createClient({
    url: chUrl(),
    username: requireEnv("AGENT_SCRATCH_USER"),
    password: requireEnv("AGENT_SCRATCH_PASSWORD"),
    request_timeout: 60_000,
  });
}
