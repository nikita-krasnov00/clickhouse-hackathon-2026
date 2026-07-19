/**
 * B2 — exploration: компактный JSON-контекст схемы для промпта LLM.
 *
 * exploreSchema() собирает по каждой целевой таблице:
 *   - DESCRIBE (имя + тип; enum-типы ужаты: убраны численные маппинги);
 *   - count() и min/max колонки даты;
 *   - кардинальности и топ-N значений ключевых низкокардинальных колонок;
 *   - 3 сэмпл-строки (дефолтные/пустые значения опущены, длинные строки обрезаны).
 *
 * Целевая таблица — github.github_events; если её ещё нет (слайс грузится
 * параллельно, трек A) — временный стенд default.hackernews.
 *
 * Результат кэшируется в scratch.schema_context (ReplacingMergeTree по table:
 * перезапуск просто обновляет строку). Контекст читает конвейер investigate
 * (шаг exploring, см. pipeline.ts) и промпт text-to-SQL (B4).
 */
import type { ClickHouseClient } from "@clickhouse/client";
import { createReadonlyClient, createScratchClient } from "@/lib/clickhouse";
import { config } from "@/lib/config";

// ---------------------------------------------------------------------------
// Форма контекста
// ---------------------------------------------------------------------------

export type ColumnInfo = { name: string; type: string };

export type TopValue = { v: string; n: number };

export type KeyColumnStats = {
  column: string;
  cardinality: number;
  top: TopValue[];
};

/** Компактный JSON-контекст одной таблицы — уходит в промпт LLM как есть. */
export type SchemaContext = {
  table: string;
  rowCount: number;
  dateColumn: string;
  dateRange: { min: string; max: string };
  columns: ColumnInfo[];
  keyColumns: KeyColumnStats[];
  /** 3 строки-примера; поля с дефолтными значениями опущены ради токенов. */
  sampleRows: Record<string, unknown>[];
};

// ---------------------------------------------------------------------------
// Целевые таблицы
// ---------------------------------------------------------------------------

type TableTarget = {
  table: string;
  dateColumn: string;
  keyColumns: { column: string; topN: number }[];
};

/**
 * Целевые таблицы: имя и колонка даты — из конфигурации проекта
 * (GITHUB_EVENTS_TABLE / GITHUB_EVENTS_DATE_COLUMN в .env, с дефолтами).
 */
function targetTables(): TableTarget[] {
  return [
    {
      table: config.dataset.githubEventsTable,
      dateColumn: config.dataset.dateColumn,
      keyColumns: [
        { column: "event_type", topN: 25 },
        { column: "repo_name", topN: 50 },
        { column: "actor_login", topN: 50 },
      ],
    },
  ];
}

/** Временный стенд, пока слайс github_events не долит трек A. */
const FALLBACK_TABLE: TableTarget = {
  table: "default.hackernews",
  dateColumn: "time",
  keyColumns: [
    { column: "type", topN: 10 },
    { column: "by", topN: 50 },
  ],
};

export const SCHEMA_CONTEXT_TABLE = "scratch.schema_context";

// ---------------------------------------------------------------------------
// Сбор контекста
// ---------------------------------------------------------------------------

async function tableExists(client: ClickHouseClient, fqName: string): Promise<boolean> {
  const [database, name] = fqName.split(".");
  const rs = await client.query({
    query: `SELECT count() AS n FROM system.tables WHERE database = {database: String} AND name = {name: String}`,
    query_params: { database, name },
    format: "JSONEachRow",
  });
  const rows = await rs.json<{ n: string | number }>();
  return Number(rows[0]?.n ?? 0) > 0;
}

/** Ужимает тип: `Enum8('a' = 1, 'b' = 2)` → `Enum8('a', 'b')` — литералы нужны LLM, номера нет. */
function compactType(type: string): string {
  return type.replace(/'\s*=\s*-?\d+/g, "'");
}

/** Сэмпл-строка без дефолтных значений; длинные строки обрезаны до 100 симв. */
function compactSampleRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === "" || value === 0 || value === "0") continue;
    if (value === "none" || value === "NONE") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === "string") {
      if (value.startsWith("1970-01-01")) continue; // пустой DateTime
      out[key] = value.length > 100 ? `${value.slice(0, 100)}…` : value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

async function exploreTable(
  client: ClickHouseClient,
  target: TableTarget,
): Promise<SchemaContext> {
  // DESCRIBE: колонки + типы.
  const describeRs = await client.query({
    query: `DESCRIBE TABLE ${target.table}`,
    format: "JSONEachRow",
  });
  const described = await describeRs.json<{ name: string; type: string }>();
  const columns: ColumnInfo[] = described.map((c) => ({
    name: c.name,
    type: compactType(c.type),
  }));

  // count() + min/max даты — одним сканом.
  const totalsRs = await client.query({
    query: `SELECT count() AS c, min(\`${target.dateColumn}\`) AS mn, max(\`${target.dateColumn}\`) AS mx FROM ${target.table}`,
    format: "JSONEachRow",
  });
  const totals = (await totalsRs.json<{ c: string; mn: string; mx: string }>())[0];

  // Кардинальности ключевых колонок — тоже одним сканом.
  const cardExprs = target.keyColumns
    .map((k, i) => `uniq(\`${k.column}\`) AS c${i}`)
    .join(", ");
  const cardRs = await client.query({
    query: `SELECT ${cardExprs} FROM ${target.table}`,
    format: "JSONEachRow",
  });
  const cardRow = (await cardRs.json<Record<string, string | number>>())[0] ?? {};

  // Топ-N значений по каждой ключевой колонке.
  const keyColumns: KeyColumnStats[] = [];
  for (const [i, key] of target.keyColumns.entries()) {
    const topRs = await client.query({
      query: `SELECT toString(\`${key.column}\`) AS v, count() AS n FROM ${target.table} GROUP BY v ORDER BY n DESC LIMIT ${key.topN}`,
      format: "JSONEachRow",
    });
    const top = (await topRs.json<{ v: string; n: string | number }>()).map((r) => ({
      v: r.v,
      n: Number(r.n),
    }));
    keyColumns.push({
      column: key.column,
      cardinality: Number(cardRow[`c${i}`] ?? 0),
      top,
    });
  }

  // 3 сэмпл-строки.
  const sampleRs = await client.query({
    query: `SELECT * FROM ${target.table} LIMIT 3`,
    format: "JSONEachRow",
  });
  const sampleRows = (await sampleRs.json<Record<string, unknown>>()).map(
    compactSampleRow,
  );

  return {
    table: target.table,
    rowCount: Number(totals?.c ?? 0),
    dateColumn: target.dateColumn,
    dateRange: { min: totals?.mn ?? "", max: totals?.mx ?? "" },
    columns,
    keyColumns,
    sampleRows,
  };
}

/**
 * Чистая функция exploration: исследует существующие целевые таблицы.
 * github.github_events может ещё не существовать — тогда пропускаем без падения
 * и берём default.hackernews как временный стенд.
 */
export async function exploreSchema(client: ClickHouseClient): Promise<SchemaContext[]> {
  const contexts: SchemaContext[] = [];
  for (const target of targetTables()) {
    if (await tableExists(client, target.table)) {
      contexts.push(await exploreTable(client, target));
    }
  }
  if (contexts.length === 0 && (await tableExists(client, FALLBACK_TABLE.table))) {
    contexts.push(await exploreTable(client, FALLBACK_TABLE));
  }
  if (contexts.length === 0) {
    throw new Error(
      "exploreSchema: ни одна целевая таблица не найдена (github.github_events, default.hackernews)",
    );
  }
  return contexts;
}

// ---------------------------------------------------------------------------
// Персист в scratch.schema_context
// ---------------------------------------------------------------------------

/**
 * Кэш контекста: ReplacingMergeTree(updated_at) ORDER BY table — повторный
 * запуск exploration просто обновляет строку таблицы, TTL не нужен.
 */
export async function persistSchemaContext(
  scratch: ClickHouseClient,
  contexts: SchemaContext[],
): Promise<void> {
  await scratch.command({
    query: `
      CREATE TABLE IF NOT EXISTS ${SCHEMA_CONTEXT_TABLE} (
        \`table\` String,
        \`context\` String,
        \`updated_at\` DateTime DEFAULT now()
      )
      ENGINE = ReplacingMergeTree(updated_at)
      ORDER BY \`table\`
    `,
  });
  await scratch.insert({
    table: SCHEMA_CONTEXT_TABLE,
    values: contexts.map((ctx) => ({
      table: ctx.table,
      context: JSON.stringify(ctx),
    })),
    format: "JSONEachRow",
  });
}

/** Читает кэш контекста (FINAL — схлопывает версии ReplacingMergeTree). */
export async function loadSchemaContext(
  scratch: ClickHouseClient,
): Promise<SchemaContext[]> {
  const rs = await scratch.query({
    query: `SELECT \`context\` FROM ${SCHEMA_CONTEXT_TABLE} FINAL ORDER BY \`table\``,
    format: "JSONEachRow",
  });
  const rows = await rs.json<{ context: string }>();
  return rows.map((r) => JSON.parse(r.context) as SchemaContext);
}

/**
 * Полный проход B2: explore под agent_ro → персист под agent_scratch.
 * Общая точка входа Trigger-таски (src/trigger/explore-schema.ts) и
 * локального скрипта (scripts/explore-schema.ts).
 */
export async function runExploreSchema(): Promise<{ contexts: SchemaContext[] }> {
  const ro = createReadonlyClient();
  const scratch = createScratchClient();
  try {
    const contexts = await exploreSchema(ro);
    await persistSchemaContext(scratch, contexts);
    return { contexts };
  } finally {
    await Promise.all([ro.close(), scratch.close()]);
  }
}
