/**
 * Operational log of LLM calls in ClickHouse: every OpenRouter request
 * (including retries and model fallbacks) — one row in scratch.llm_log with the
 * full prompt, response, status, and timing. Single write point — chatComplete
 * (llm.ts) — so ALL calls land in the log: dashboard plan, SQL self-healing,
 * verdicts.
 *
 * Schema follows clickhouse-best-practices rules:
 *   - ORDER BY (purpose, ts): low cardinality first
 *     (schema-pk-cardinality-order);
 *   - LowCardinality for purpose/model/status (schema-types-lowcardinality);
 *   - no Nullable — DEFAULT '' (schema-types-avoid-nullable);
 *   - single inserts go through async_insert, server batches
 *     (insert-async-small-batches);
 *   - no partitioning (schema-partition-start-without), lifecycle — TTL.
 *
 * Logging must not break the pipeline: any ClickHouse error here is swallowed
 * with one console.warn per process.
 */
import type { ClickHouseClient } from "@clickhouse/client";
import { createScratchClient } from "@/lib/clickhouse";
import type { ChatMessage } from "./llm";

export const LLM_LOG_TABLE = "scratch.llm_log";

/** Size caps: prompt with schema context — kilobytes, not megabytes. */
const MAX_REQUEST_CHARS = 200_000;
const MAX_RESPONSE_CHARS = 100_000;

export type LlmLogEntry = {
  /** Call purpose: generate_plan | heal_sql | verdict_summary (+ :reparse). */
  purpose: string;
  model: string;
  /** Attempt number within chatComplete (transport/model retries). */
  attempt: number;
  status: "ok" | "error";
  /** Failure reason for the attempt (HTTP status, timeout, empty content…). */
  error?: string;
  /** Full dialog sent to the model. */
  messages: ChatMessage[];
  /** Raw model response content (for status=ok). */
  response?: string;
  elapsedMs: number;
};

const CREATE_LLM_LOG_SQL = `
  CREATE TABLE IF NOT EXISTS ${LLM_LOG_TABLE} (
    \`ts\` DateTime64(3) DEFAULT now64(3),
    \`purpose\` LowCardinality(String),
    \`model\` LowCardinality(String),
    \`attempt\` UInt8,
    \`status\` LowCardinality(String),
    \`error\` String DEFAULT '',
    \`request\` String,
    \`response\` String DEFAULT '',
    \`request_chars\` UInt32,
    \`response_chars\` UInt32,
    \`elapsed_ms\` UInt32
  )
  ENGINE = MergeTree
  ORDER BY (\`purpose\`, \`ts\`)
  TTL toDateTime(\`ts\`) + INTERVAL 30 DAY
`;

/** Lazy per-process singletons: client and one-time CREATE TABLE. */
let logClient: ClickHouseClient | undefined;
let ensureTablePromise: Promise<void> | undefined;
let warned = false;

function client(): ClickHouseClient {
  logClient ??= createScratchClient();
  return logClient;
}

function ensureTable(): Promise<void> {
  ensureTablePromise ??= client()
    .command({ query: CREATE_LLM_LOG_SQL })
    .then(() => undefined);
  return ensureTablePromise;
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
}

/**
 * Write one LLM call to the log. Never throws: logging failure — one
 * console.warn per process, pipeline continues.
 */
export async function logLlmCall(entry: LlmLogEntry): Promise<void> {
  try {
    await ensureTable();
    const request = JSON.stringify(entry.messages);
    const response = entry.response ?? "";
    await client().insert({
      table: LLM_LOG_TABLE,
      values: [
        {
          purpose: entry.purpose,
          model: entry.model,
          attempt: entry.attempt,
          status: entry.status,
          error: entry.error ?? "",
          request: cap(request, MAX_REQUEST_CHARS),
          response: cap(response, MAX_RESPONSE_CHARS),
          request_chars: request.length,
          response_chars: response.length,
          elapsed_ms: Math.round(entry.elapsedMs),
        },
      ],
      format: "JSONEachRow",
      clickhouse_settings: {
        // Server batches single rows (insert-async-small-batches);
        // wait=0 — insert confirmed from buffer, call does not block the pipeline.
        async_insert: 1,
        wait_for_async_insert: 0,
      },
    });
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn(
        `[llm-log] write to ${LLM_LOG_TABLE} failed (silencing further warnings): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    // On DDL failure, let the next call retry creating the promise.
    ensureTablePromise = undefined;
  }
}
