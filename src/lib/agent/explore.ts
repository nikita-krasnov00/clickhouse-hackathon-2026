/**
 * B2 — exploration: компактный JSON-контекст схемы для промпта LLM.
 *
 * Таблицы НЕ захардкожены: exploreSchema() сам обнаруживает их через
 * system.tables/system.columns под agent_ro — что видно грантам agent_ro,
 * то и есть скоуп агента. Правила:
 *   - список таблиц: все базы, кроме системных и служебной scratch
 *     (роллапы A4 и кэши — не для контекста LLM), только непустые
 *     не-View таблицы; берём топ-MAX_TABLES по total_rows;
 *   - приоритетная таблица (config.dataset.githubEventsTable) всегда
 *     идёт первой в контексте;
 *   - колонка даты — эвристика: первая колонка типа Date/DateTime* с
 *     предпочтением имён created_at → *_at → date/time/day/ts; для
 *     приоритетной таблицы переопределяется конфигом (GITHUB_EVENTS_DATE_COLUMN);
 *   - ключевые колонки — до MAX_KEY_COLUMNS: Enum* и LowCardinality(String)
 *     в порядке схемы, добор — String с малым uniq по сэмплу; для каждой
 *     считаются кардинальность и топ значений. Дорогие uniq на таблицах
 *     >BIG_TABLE_ROWS строк считаются uniqCombined по окну последних дней
 *     либо по LIMIT-сэмплу — чтобы уложиться в 30-сек таймаут agent_ro;
 *   - count()/min/max даты и 3 сэмпл-строки — как раньше.
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

export type ColumnInfo = { name: string; type: string; comment?: string };

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
  /** Пустая строка, если в таблице нет колонок Date/DateTime*. */
  dateColumn: string;
  dateRange: { min: string; max: string };
  columns: ColumnInfo[];
  keyColumns: KeyColumnStats[];
  /** 3 строки-примера; поля с дефолтными значениями опущены ради токенов. */
  sampleRows: Record<string, unknown>[];
};

// ---------------------------------------------------------------------------
// Параметры обнаружения
// ---------------------------------------------------------------------------

/** Сколько таблиц максимум попадает в контекст (не раздуваем промпт). */
const MAX_TABLES = 5;
/** Сколько ключевых (низкокардинальных) колонок берём на таблицу. */
const MAX_KEY_COLUMNS = 3;
/** Сколько топ-значений собираем по каждой ключевой колонке. */
const KEY_TOP_N = 30;
/** С этого размера uniq считаем не по всей таблице, а по окну/сэмплу. */
const BIG_TABLE_ROWS = 10_000_000;
/** Окно «последнего доступного периода» для uniq на больших таблицах. */
const UNIQ_WINDOW_DAYS = 30;
/** Размер LIMIT-сэмпла для оценок uniq (SAMPLE требует ключа сэмплирования). */
const UNIQ_SAMPLE_ROWS = 500_000;
/** String-колонка попадает в ключевые, если её uniq по сэмплу не больше этого. */
const LOW_UNIQ_THRESHOLD = 200;

/** Системные базы — не таблицы данных. */
const SYSTEM_DATABASES = ["system", "information_schema", "INFORMATION_SCHEMA"];
/** Служебные базы проекта (роллапы, кэши) — прячем от LLM. */
const HIDDEN_DATABASES = ["scratch"];

export const SCHEMA_CONTEXT_TABLE = "scratch.schema_context";

// ---------------------------------------------------------------------------
// Обнаружение таблиц
// ---------------------------------------------------------------------------

type DiscoveredTable = { database: string; name: string; totalRows: number };

/**
 * Непустые таблицы, видимые agent_ro (гранты = скоуп агента), без системных
 * баз, служебной scratch и View. Фильтр total_rows > 0 заодно отсекает
 * внешние движки вроде URL (total_rows NULL) — их count() ходил бы по сети.
 */
async function discoverTables(client: ClickHouseClient): Promise<DiscoveredTable[]> {
  const rs = await client.query({
    query: `
      SELECT database, name, coalesce(total_rows, 0) AS total_rows
      FROM system.tables
      WHERE database NOT IN {hidden:Array(String)}
        AND engine NOT LIKE '%View%'
        AND total_rows > 0
      ORDER BY total_rows DESC
    `,
    query_params: { hidden: [...SYSTEM_DATABASES, ...HIDDEN_DATABASES] },
    format: "JSONEachRow",
  });
  const rows = await rs.json<{ database: string; name: string; total_rows: string | number }>();
  return rows.map((r) => ({
    database: r.database,
    name: r.name,
    totalRows: Number(r.total_rows),
  }));
}

// ---------------------------------------------------------------------------
// Эвристики по типам и именам колонок
// ---------------------------------------------------------------------------

/** Снимает обёртки Nullable(...)/LowCardinality(...) до базового типа. */
function unwrapType(type: string): string {
  let t = type;
  for (;;) {
    const m = /^(?:Nullable|LowCardinality)\((.*)\)$/.exec(t);
    if (!m) return t;
    t = m[1];
  }
}

function isDateType(type: string): boolean {
  return /^(Date|Date32|DateTime|DateTime64)\b/.test(unwrapType(type));
}

/** Enum* и LowCardinality(String): низкая кардинальность по конструкции типа. */
function isKeyCandidateByType(type: string): boolean {
  const base = unwrapType(type);
  if (/^Enum(8|16)?\b/.test(base)) return true;
  return base === "String" && type.includes("LowCardinality(");
}

/** Обычная String-колонка — кандидат в ключевые только при малом uniq. */
function isPlainString(type: string): boolean {
  return unwrapType(type) === "String" && !type.includes("LowCardinality(");
}

/** Чем меньше — тем лучше имя подходит на роль колонки даты. */
function dateNameScore(name: string): number {
  const n = name.toLowerCase();
  if (n === "created_at") return 0;
  if (n.endsWith("_at")) return 1;
  if (/(date|time|day)/.test(n) || n === "ts" || n.endsWith("_ts")) return 2;
  return 3;
}

/**
 * Колонка даты: конфигное переопределение (если такая колонка есть и она
 * временнáя), иначе лучшая Date/DateTime*-колонка по имени, при равенстве —
 * первая по порядку схемы.
 */
function pickDateColumn(columns: ColumnInfo[], preferred?: string): string {
  if (preferred && columns.some((c) => c.name === preferred && isDateType(c.type))) {
    return preferred;
  }
  let best = "";
  let bestScore = Infinity;
  for (const c of columns) {
    if (!isDateType(c.type)) continue;
    const score = dateNameScore(c.name);
    if (score < bestScore) {
      best = c.name;
      bestScore = score;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Сбор контекста
// ---------------------------------------------------------------------------

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

/** Колонки с типами (и комментарием, если он есть) из system.columns. */
async function fetchColumns(
  client: ClickHouseClient,
  database: string,
  table: string,
): Promise<ColumnInfo[]> {
  const rs = await client.query({
    query: `
      SELECT name, type, comment FROM system.columns
      WHERE database = {database:String} AND table = {table:String}
      ORDER BY position
    `,
    query_params: { database, table },
    format: "JSONEachRow",
  });
  const rows = await rs.json<{ name: string; type: string; comment: string }>();
  return rows.map((c) => ({
    name: c.name,
    type: compactType(c.type),
    ...(c.comment ? { comment: c.comment } : {}),
  }));
}

/** Оценка uniq String-колонок по LIMIT-сэмплу — дёшево даже на больших таблицах. */
async function estimateStringUniq(
  client: ClickHouseClient,
  table: string,
  columns: string[],
): Promise<Map<string, number>> {
  if (columns.length === 0) return new Map();
  const inner = columns.map((c) => `\`${c}\``).join(", ");
  const exprs = columns.map((c, i) => `uniqCombined(\`${c}\`) AS u${i}`).join(", ");
  const rs = await client.query({
    query: `SELECT ${exprs} FROM (SELECT ${inner} FROM ${table} LIMIT ${UNIQ_SAMPLE_ROWS})`,
    format: "JSONEachRow",
  });
  const row = (await rs.json<Record<string, string | number>>())[0] ?? {};
  return new Map(columns.map((c, i) => [c, Number(row[`u${i}`] ?? 0)]));
}

/**
 * Ключевые колонки: сперва Enum* и LowCardinality(String) в порядке схемы,
 * добор до MAX_KEY_COLUMNS — String-колонки с малым uniq (оценка по сэмплу).
 */
async function pickKeyColumns(
  client: ClickHouseClient,
  table: string,
  columns: ColumnInfo[],
): Promise<string[]> {
  const picked = columns
    .filter((c) => isKeyCandidateByType(c.type))
    .slice(0, MAX_KEY_COLUMNS)
    .map((c) => c.name);
  if (picked.length >= MAX_KEY_COLUMNS) return picked;

  const plain = columns.filter((c) => isPlainString(c.type)).map((c) => c.name);
  const uniq = await estimateStringUniq(client, table, plain);
  const lowUniq = plain
    .filter((c) => {
      const u = uniq.get(c) ?? Infinity;
      return u >= 2 && u <= LOW_UNIQ_THRESHOLD; // константы и «уникальные» не нужны
    })
    .sort((a, b) => (uniq.get(a) ?? 0) - (uniq.get(b) ?? 0));
  return [...picked, ...lowUniq.slice(0, MAX_KEY_COLUMNS - picked.length)];
}

/**
 * Кардинальности ключевых колонок одним сканом. На больших таблицах полный
 * uniq дорог и может не влезть в 30-сек таймаут agent_ro, поэтому оценка:
 * uniqCombined по окну последних UNIQ_WINDOW_DAYS дней данных (если есть
 * колонка даты) либо по LIMIT-сэмплу.
 */
async function keyColumnCardinalities(
  client: ClickHouseClient,
  target: { table: string; totalRows: number; dateColumn: string; dateMax: string },
  keyColumns: string[],
): Promise<number[]> {
  if (keyColumns.length === 0) return [];
  const exprs = keyColumns.map((c, i) => `uniqCombined(\`${c}\`) AS c${i}`).join(", ");
  let query: string;
  const query_params: Record<string, unknown> = {};
  if (target.totalRows <= BIG_TABLE_ROWS) {
    query = `SELECT ${exprs} FROM ${target.table}`;
  } else if (target.dateColumn && target.dateMax) {
    query = `
      SELECT ${exprs} FROM ${target.table}
      WHERE \`${target.dateColumn}\` >= parseDateTimeBestEffort({mx:String}) - INTERVAL ${UNIQ_WINDOW_DAYS} DAY
    `;
    query_params.mx = target.dateMax;
  } else {
    const inner = keyColumns.map((c) => `\`${c}\``).join(", ");
    query = `SELECT ${exprs} FROM (SELECT ${inner} FROM ${target.table} LIMIT ${UNIQ_SAMPLE_ROWS})`;
  }
  const rs = await client.query({ query, query_params, format: "JSONEachRow" });
  const row = (await rs.json<Record<string, string | number>>())[0] ?? {};
  return keyColumns.map((_, i) => Number(row[`c${i}`] ?? 0));
}

type TableTarget = {
  /** Полное имя `db.table`. */
  table: string;
  database: string;
  name: string;
  /** Приблизительный размер из system.tables — выбор стратегии uniq. */
  totalRows: number;
  /** Переопределение колонки даты (конфиг приоритетной таблицы). */
  preferredDateColumn?: string;
};

async function exploreTable(
  client: ClickHouseClient,
  target: TableTarget,
): Promise<SchemaContext> {
  // Колонки: имя + тип (+ comment) из system.columns.
  const columns = await fetchColumns(client, target.database, target.name);
  if (columns.length === 0) {
    throw new Error(`system.columns не вернул колонок для ${target.table}`);
  }
  const dateColumn = pickDateColumn(columns, target.preferredDateColumn);

  // count() + min/max даты — одним сканом (если колонки даты нет — только count).
  const totalsRs = await client.query({
    query: dateColumn
      ? `SELECT count() AS c, min(\`${dateColumn}\`) AS mn, max(\`${dateColumn}\`) AS mx FROM ${target.table}`
      : `SELECT count() AS c FROM ${target.table}`,
    format: "JSONEachRow",
  });
  const totals = (await totalsRs.json<{ c: string; mn?: string; mx?: string }>())[0];

  // Ключевые низкокардинальные колонки; сначала топ-N значений (полный скан,
  // как раньше), затем кардинальности — оценки по окну/сэмплу на больших
  // таблицах занижают, поэтому поднимаем их минимум до числа топ-значений.
  const keyColumnNames = await pickKeyColumns(client, target.table, columns);
  const tops: TopValue[][] = [];
  for (const column of keyColumnNames) {
    const topRs = await client.query({
      query: `SELECT toString(\`${column}\`) AS v, count() AS n FROM ${target.table} GROUP BY v ORDER BY n DESC LIMIT ${KEY_TOP_N}`,
      format: "JSONEachRow",
    });
    tops.push(
      (await topRs.json<{ v: string; n: string | number }>()).map((r) => ({
        v: r.v,
        n: Number(r.n),
      })),
    );
  }
  const cardinalities = await keyColumnCardinalities(
    client,
    {
      table: target.table,
      totalRows: target.totalRows,
      dateColumn,
      dateMax: totals?.mx ?? "",
    },
    keyColumnNames,
  );
  const keyColumns: KeyColumnStats[] = keyColumnNames.map((column, i) => ({
    column,
    cardinality: Math.max(cardinalities[i] ?? 0, tops[i].length),
    top: tops[i],
  }));

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
    dateColumn,
    dateRange: { min: totals?.mn ?? "", max: totals?.mx ?? "" },
    columns,
    keyColumns,
    sampleRows,
  };
}

/** Приоритетная таблица конфига — первой, остальные по убыванию строк. */
function sortContexts(contexts: SchemaContext[]): SchemaContext[] {
  const priority = config.dataset.githubEventsTable;
  return [...contexts].sort(
    (a, b) =>
      Number(b.table === priority) - Number(a.table === priority) ||
      b.rowCount - a.rowCount,
  );
}

/**
 * Exploration без захардкоженных имён: обнаруживает таблицы динамически,
 * приоритетную (config.dataset.githubEventsTable) ставит первой, берёт
 * топ-MAX_TABLES по размеру. Проблема одной таблицы не валит весь проход.
 */
export async function exploreSchema(client: ClickHouseClient): Promise<SchemaContext[]> {
  const discovered = await discoverTables(client);
  const priority = config.dataset.githubEventsTable;
  const ordered = [
    ...discovered.filter((d) => `${d.database}.${d.name}` === priority),
    ...discovered.filter((d) => `${d.database}.${d.name}` !== priority),
  ].slice(0, MAX_TABLES);
  if (ordered.length === 0) {
    throw new Error(
      "exploreSchema: agent_ro не видит ни одной непустой таблицы данных — проверь гранты (system.tables пуст за вычетом служебных баз)",
    );
  }

  const contexts: SchemaContext[] = [];
  for (const d of ordered) {
    const fqName = `${d.database}.${d.name}`;
    try {
      contexts.push(
        await exploreTable(client, {
          table: fqName,
          database: d.database,
          name: d.name,
          totalRows: d.totalRows,
          preferredDateColumn:
            fqName === priority ? config.dataset.dateColumn : undefined,
        }),
      );
    } catch (err) {
      console.warn(
        `exploreSchema: пропускаю ${fqName}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (contexts.length === 0) {
    throw new Error("exploreSchema: не удалось исследовать ни одну обнаруженную таблицу");
  }
  return sortContexts(contexts);
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

/**
 * Читает кэш контекста (FINAL — схлопывает версии ReplacingMergeTree).
 * Порядок — как в exploreSchema: приоритетная таблица первой.
 */
export async function loadSchemaContext(
  scratch: ClickHouseClient,
): Promise<SchemaContext[]> {
  const rs = await scratch.query({
    query: `SELECT \`context\` FROM ${SCHEMA_CONTEXT_TABLE} FINAL ORDER BY \`table\``,
    format: "JSONEachRow",
  });
  const rows = await rs.json<{ context: string }>();
  return sortContexts(rows.map((r) => JSON.parse(r.context) as SchemaContext));
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
