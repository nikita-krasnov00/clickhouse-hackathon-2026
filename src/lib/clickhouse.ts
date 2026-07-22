import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { config } from "@/lib/config";

/**
 * ClickHouse client factories (B1).
 *
 * Two users with different permissions (created by track A, task A1):
 *  - `agent_ro`      — read-only: SELECT on all databases granted
 *                      (github, tpcds, …). All agent queries run
 *                      under this user; grants = agent scope.
 *  - `agent_scratch` — write access to the `scratch` database: temp tables with TTL,
 *                      operational LLM log.
 *
 * Values come from project config (src/lib/config.ts, sourced from .env):
 * URL and credentials are validated lazily on first client creation.
 */

/** Read-only client (agent_ro) — all agent SQL queries. */
export function createReadonlyClient(): ClickHouseClient {
  const { url, readonly } = config.clickhouse;
  return createClient({
    url,
    username: readonly.username,
    password: readonly.password,
    request_timeout: 30_000,
    clickhouse_settings: {
      // Client-side safeguard; server limits for agent_ro are set by track A (A5).
      max_execution_time: 30,
    },
  });
}

/** Scratch client (agent_scratch) — temp tables and schema cache in the scratch database. */
export function createScratchClient(): ClickHouseClient {
  const { url, scratch } = config.clickhouse;
  return createClient({
    url,
    username: scratch.username,
    password: scratch.password,
    request_timeout: 60_000,
  });
}
