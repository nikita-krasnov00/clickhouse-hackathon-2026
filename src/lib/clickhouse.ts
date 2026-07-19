import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { config } from "@/lib/config";

/**
 * Фабрики ClickHouse-клиентов (B1).
 *
 * Два юзера с разными правами (создаёт трек A, задача A1):
 *  - `agent_ro`      — read-only: SELECT по github_events. Все запросы агента
 *                      и drill API ходят только под ним.
 *  - `agent_scratch` — запись в базу `scratch`: temp tables с TTL,
 *                      кэш схемы (B2, B6), операционный лог LLM.
 *
 * Значения — из конфигурации проекта (src/lib/config.ts, источник .env):
 * URL и креды валидируются лениво при первом создании клиента.
 */

/** Read-only клиент (agent_ro) — SQL агента и drill-запросы. */
export function createReadonlyClient(): ClickHouseClient {
  const { url, readonly } = config.clickhouse;
  return createClient({
    url,
    username: readonly.username,
    password: readonly.password,
    request_timeout: 30_000,
    clickhouse_settings: {
      // Страховка на клиенте; серверные лимиты для agent_ro задаёт трек A (A5).
      max_execution_time: 30,
    },
  });
}

/** Scratch-клиент (agent_scratch) — temp tables и кэш схемы в базе scratch. */
export function createScratchClient(): ClickHouseClient {
  const { url, scratch } = config.clickhouse;
  return createClient({
    url,
    username: scratch.username,
    password: scratch.password,
    request_timeout: 60_000,
  });
}
