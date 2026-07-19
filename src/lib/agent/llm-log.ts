/**
 * Операционный лог LLM-вызовов в ClickHouse: каждый запрос к OpenRouter
 * (включая ретраи и фоллбеки моделей) — строка в scratch.llm_log с полным
 * промптом, ответом, статусом и таймингом. Единственная точка записи —
 * chatComplete (llm.ts), поэтому в лог попадают ВСЕ вызовы: план дашборда,
 * самопочинка SQL, вердикты.
 *
 * Схема — по правилам clickhouse-best-practices:
 *   - ORDER BY (purpose, ts): низкая кардинальность вперёд
 *     (schema-pk-cardinality-order);
 *   - LowCardinality для purpose/model/status (schema-types-lowcardinality);
 *   - без Nullable — DEFAULT '' (schema-types-avoid-nullable);
 *   - одиночные вставки идут через async_insert, батчит сервер
 *     (insert-async-small-batches);
 *   - без партиционирования (schema-partition-start-without), лайфцикл — TTL.
 *
 * Логирование не имеет права ломать конвейер: любая ошибка ClickHouse здесь
 * гасится с одним console.warn на процесс.
 */
import type { ClickHouseClient } from "@clickhouse/client";
import { createScratchClient } from "@/lib/clickhouse";
import type { ChatMessage } from "./llm";

export const LLM_LOG_TABLE = "scratch.llm_log";

/** Капы на размер: промпт с контекстом схемы — килобайты, но не мегабайты. */
const MAX_REQUEST_CHARS = 200_000;
const MAX_RESPONSE_CHARS = 100_000;

export type LlmLogEntry = {
  /** Назначение вызова: generate_plan | heal_sql | verdict_summary (+ :reparse). */
  purpose: string;
  model: string;
  /** Номер попытки внутри chatComplete (ретраи транспорта/модели). */
  attempt: number;
  status: "ok" | "error";
  /** Причина неудачи попытки (HTTP-статус, таймаут, пустой content…). */
  error?: string;
  /** Полный диалог, ушедший в модель. */
  messages: ChatMessage[];
  /** Сырой content ответа модели (для status=ok). */
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

/** Ленивые синглтоны на процесс: клиент и однократный CREATE TABLE. */
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
  return text.length > max ? `${text.slice(0, max)}…[обрезано]` : text;
}

/**
 * Пишет один вызов LLM в лог. Никогда не кидает: сбой логирования — один
 * console.warn на процесс, конвейер продолжает работать.
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
        // Одиночные строки батчит сервер (insert-async-small-batches);
        // wait=0 — вставка подтверждается буфером, вызов не тормозит конвейер.
        async_insert: 1,
        wait_for_async_insert: 0,
      },
    });
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn(
        `[llm-log] запись в ${LLM_LOG_TABLE} не удалась (дальше молчу): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    // При сбое DDL даём следующему вызову шанс пересоздать промис.
    ensureTablePromise = undefined;
  }
}
