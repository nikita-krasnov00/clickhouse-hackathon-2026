/**
 * B2 — exploration, двухфазная и без единого захардкоженного имени таблицы.
 *
 * Фаза A — catalogTables(): дешёвый каталог ВСЕХ таблиц, видимых agent_ro
 * (system.tables + system.columns, без статистики и сэмплов — сотни
 * миллисекунд). Каталог уходит в триаж (triage.ts): КАКИЕ таблицы относятся
 * к вопросу, решает LLM в момент запроса — никакой «приоритетной таблицы»
 * из конфига больше нет. Гранты agent_ro = скоуп агента.
 *
 * Фаза B — exploreTables(): глубокая разведка ТОЛЬКО выбранных триажем таблиц:
 *   - колонка даты — эвристика: первая колонка типа Date/DateTime* с
 *     предпочтением имён created_at → *_at → date/time/day/ts;
 *   - ключевые колонки — до MAX_KEY_COLUMNS: Enum* и LowCardinality(String)
 *     в порядке схемы, добор — String с малым uniq по сэмплу; для каждой
 *     считаются кардинальность и топ значений. Дорогие uniq на таблицах
 *     >BIG_TABLE_ROWS строк — по LIMIT-сэмплу, топ-N — только для
 *     низкокардинальных колонок; всё с бюджетом времени (break, не ошибка);
 *   - min/max даты и 3 сэмпл-строки.
 *
 * Персистентного кэша НЕТ: вся информация и так живёт в ClickHouse; только
 * короткая мемоизация каталога в памяти процесса (getCatalog), чтобы
 * параллельные раны в одном воркере не дублировали одинаковые запросы.
 * Контекст читают конвейер investigate (pipeline.ts) и промпты триажа и
 * text-to-SQL (triage.ts, generate-sql.ts).
 */
import type { ClickHouseClient } from "@clickhouse/client";
import { createReadonlyClient } from "@/lib/clickhouse";

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
  /**
   * ORDER BY / первичный ключ таблицы. КРИТИЧНО для скорости: индекс MergeTree
   * прунит гранулы только при фильтре по ПРЕФИКСУ этого ключа — LLM обязан это
   * учитывать (см. правила перформанса в generate-sql.ts).
   */
  sortingKey: string[];
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

/** Сколько таблиц максимум попадает в контекст legacy-прохода exploreSchema. */
const MAX_TABLES = 5;
/** Потолок каталога фазы A — защита промпта триажа от гигантских инстансов. */
const MAX_CATALOG_TABLES = 40;
/** Потолок глубокой разведки фазы B — триаж не должен выбирать больше. */
export const MAX_DEEP_TABLES = 4;
/** Сколько ключевых (низкокардинальных) колонок берём на таблицу. */
const MAX_KEY_COLUMNS = 3;
/** Сколько топ-значений собираем по каждой ключевой колонке. */
const KEY_TOP_N = 30;
/** Сколько таблиц исследуем одновременно (см. комментарий в exploreSchema). */
const EXPLORE_CONCURRENCY = 2;
/** С этого размера uniq считаем не по всей таблице, а по LIMIT-сэмплу. */
const BIG_TABLE_ROWS = 10_000_000;
/** Размер LIMIT-сэмпла для оценок uniq (SAMPLE требует ключа сэмплирования). */
const UNIQ_SAMPLE_ROWS = 500_000;
/** String-колонка попадает в ключевые, если её uniq по сэмплу не больше этого. */
const LOW_UNIQ_THRESHOLD = 200;
/**
 * Топ-N с частотами (GROUP BY) считаем только для колонок с кардинальностью
 * не выше этого порога. GROUP BY по высококардинальной колонке (repo_name —
 * 35M уникальных) на 150M строк сканирует всю таблицу за 10-13с и рискует
 * таймаутом; такой колонке отдаём только оценку кардинальности, а примеры
 * значений LLM видит в сэмпл-строках.
 */
const TOPN_MAX_CARD = 1_000;
/**
 * Страховка от таймаута: любой аналитический запрос exploration ограничен по
 * времени и при переполнении возвращает ЧАСТИЧНЫЙ результат (break), а не
 * ошибку. Так живое исследование под нагрузкой (например, во время заливки
 * данных) не роняет ран — в худшем случае статистика будет приблизительной.
 */
const EXPLORE_SETTINGS = {
  max_execution_time: 20,
  timeout_overflow_mode: "break",
} as const;

/** Системные базы — не таблицы данных. */
const SYSTEM_DATABASES = ["system", "information_schema", "INFORMATION_SCHEMA"];
/** Служебные базы проекта (роллапы, лог LLM) — прячем от LLM. */
const HIDDEN_DATABASES = ["scratch"];

// ---------------------------------------------------------------------------
// Обнаружение таблиц
// ---------------------------------------------------------------------------

type DiscoveredTable = {
  database: string;
  name: string;
  totalRows: number;
  /** Колонки ORDER BY / первичного ключа (для промпта и подсказок LLM). */
  sortingKey: string[];
};

/** `event_type, repo_name, created_at` → ['event_type','repo_name','created_at']. */
function parseSortingKey(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Непустые таблицы, видимые agent_ro (гранты = скоуп агента), без системных
 * баз, служебной scratch и View. Фильтр total_rows > 0 заодно отсекает
 * внешние движки вроде URL (total_rows NULL) — их count() ходил бы по сети.
 * sorting_key берём тут же — он бесплатен из system.tables и критичен для
 * подсказок LLM о прунинге по индексу.
 */
async function discoverTables(client: ClickHouseClient): Promise<DiscoveredTable[]> {
  const rs = await client.query({
    query: `
      SELECT database, name, coalesce(total_rows, 0) AS total_rows, sorting_key
      FROM system.tables
      WHERE database NOT IN {hidden:Array(String)}
        AND engine NOT LIKE '%View%'
        AND total_rows > 0
      ORDER BY total_rows DESC
    `,
    query_params: { hidden: [...SYSTEM_DATABASES, ...HIDDEN_DATABASES] },
    format: "JSONEachRow",
  });
  const rows = await rs.json<{
    database: string;
    name: string;
    total_rows: string | number;
    sorting_key: string;
  }>();
  return rows.map((r) => ({
    database: r.database,
    name: r.name,
    totalRows: Number(r.total_rows),
    sortingKey: parseSortingKey(r.sorting_key ?? ""),
  }));
}

// ---------------------------------------------------------------------------
// Фаза A: каталог всех видимых таблиц (дёшево, для триажа)
// ---------------------------------------------------------------------------

/** Компактная запись каталога: триажу LLM хватает, чтобы выбрать таблицы. */
export type CatalogTable = {
  /** Полное имя `db.table`. */
  table: string;
  rowCount: number;
  sortingKey: string[];
  /** Эвристика: лучшая Date/DateTime*-колонка; пустая строка — нет такой. */
  dateColumn: string;
  columns: ColumnInfo[];
};

/** Все колонки всех видимых таблиц ОДНИМ запросом: `db.table` → колонки. */
async function fetchAllColumns(
  client: ClickHouseClient,
): Promise<Map<string, ColumnInfo[]>> {
  const rs = await client.query({
    query: `
      SELECT database, table, name, type, comment
      FROM system.columns
      WHERE database NOT IN {hidden:Array(String)}
      ORDER BY database, table, position
    `,
    query_params: { hidden: [...SYSTEM_DATABASES, ...HIDDEN_DATABASES] },
    format: "JSONEachRow",
  });
  const rows = await rs.json<{
    database: string;
    table: string;
    name: string;
    type: string;
    comment: string;
  }>();
  const byTable = new Map<string, ColumnInfo[]>();
  for (const r of rows) {
    const key = `${r.database}.${r.table}`;
    const list = byTable.get(key) ?? [];
    list.push({
      name: r.name,
      type: compactType(r.type),
      ...(r.comment ? { comment: r.comment } : {}),
    });
    byTable.set(key, list);
  }
  return byTable;
}

/**
 * Фаза A exploration: полный каталог видимых таблиц БЕЗ дорогой статистики —
 * только system.tables + system.columns (сотни миллисекунд на любом инстансе).
 * Читает триаж (triage.ts): LLM сам решает, какие таблицы относятся к вопросу.
 */
export async function catalogTables(
  client: ClickHouseClient,
): Promise<CatalogTable[]> {
  const [discovered, columnsByTable] = await Promise.all([
    discoverTables(client),
    fetchAllColumns(client),
  ]);
  return discovered
    .slice(0, MAX_CATALOG_TABLES)
    .map((d) => {
      const table = `${d.database}.${d.name}`;
      const columns = columnsByTable.get(table) ?? [];
      return {
        table,
        rowCount: d.totalRows,
        sortingKey: d.sortingKey,
        dateColumn: pickDateColumn(columns),
        columns,
      };
    })
    .filter((t) => t.columns.length > 0);
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
 * Колонка даты: лучшая Date/DateTime*-колонка по имени, при равенстве — первая
 * по порядку схемы. Пустая строка, если временнЫх колонок нет вовсе (например,
 * факт-таблицы звёздных схем держат дату числовым ключом *_sk на измерение —
 * это решает LLM по каталогу, не эвристика).
 */
function pickDateColumn(columns: ColumnInfo[]): string {
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

/**
 * Оценка uniq колонок: на больших таблицах — по LIMIT-сэмплу (дёшево и
 * ограниченно), на малых — точный uniqCombined по всей таблице. Одним запросом
 * на все колонки. Число приблизительное, но для промпта и для решения
 * «низкокардинальная ли колонка» этого достаточно.
 */
async function estimateColumnUniq(
  client: ClickHouseClient,
  table: string,
  totalRows: number,
  columns: string[],
): Promise<Map<string, number>> {
  if (columns.length === 0) return new Map();
  const exprs = columns.map((c, i) => `uniqCombined(\`${c}\`) AS u${i}`).join(", ");
  const inner = columns.map((c) => `\`${c}\``).join(", ");
  const from =
    totalRows > BIG_TABLE_ROWS
      ? `(SELECT ${inner} FROM ${table} LIMIT ${UNIQ_SAMPLE_ROWS})`
      : table;
  const rs = await client.query({
    query: `SELECT ${exprs} FROM ${from}`,
    format: "JSONEachRow",
    clickhouse_settings: EXPLORE_SETTINGS,
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
  totalRows: number,
  columns: ColumnInfo[],
): Promise<string[]> {
  const picked = columns
    .filter((c) => isKeyCandidateByType(c.type))
    .slice(0, MAX_KEY_COLUMNS)
    .map((c) => c.name);
  if (picked.length >= MAX_KEY_COLUMNS) return picked;

  const plain = columns.filter((c) => isPlainString(c.type)).map((c) => c.name);
  const uniq = await estimateColumnUniq(client, table, totalRows, plain);
  const lowUniq = plain
    .filter((c) => {
      const u = uniq.get(c) ?? Infinity;
      return u >= 2 && u <= LOW_UNIQ_THRESHOLD; // константы и «уникальные» не нужны
    })
    .sort((a, b) => (uniq.get(a) ?? 0) - (uniq.get(b) ?? 0));
  return [...picked, ...lowUniq.slice(0, MAX_KEY_COLUMNS - picked.length)];
}

/**
 * Топ-N значений с частотами для одной ключевой колонки. Только для
 * низкокардинальных колонок (проверка вызывающим) — их GROUP BY даёт мало
 * групп и укладывается в бюджет; break — страховка от таймаута под нагрузкой.
 */
async function keyColumnTop(
  client: ClickHouseClient,
  table: string,
  column: string,
): Promise<TopValue[]> {
  const rs = await client.query({
    query: `SELECT toString(\`${column}\`) AS v, count() AS n FROM ${table} GROUP BY v ORDER BY n DESC LIMIT ${KEY_TOP_N}`,
    format: "JSONEachRow",
    clickhouse_settings: EXPLORE_SETTINGS,
  });
  return (await rs.json<{ v: string; n: string | number }>()).map((r) => ({
    v: r.v,
    n: Number(r.n),
  }));
}

type TableTarget = {
  /** Полное имя `db.table`. */
  table: string;
  database: string;
  name: string;
  /** Приблизительный размер из system.tables — выбор стратегии uniq. */
  totalRows: number;
  /** ORDER BY / первичный ключ (из discoverTables). */
  sortingKey: string[];
  /**
   * Глубокое исследование (кардинальности + топ-N значений) — самые дорогие
   * запросы exploration. В конвейере v2 глубоко исследуются ВСЕ выбранные
   * триажем таблицы (их максимум MAX_DEEP_TABLES); в legacy-проходе
   * exploreSchema — только самая большая.
   */
  deep: boolean;
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
  const dateColumn = pickDateColumn(columns);

  // Все независимые стадии — ПАРАЛЛЕЛЬНО (латентность = максимум, не сумма):
  // min/max даты, сэмпл-строки, статистика ключевых колонок. count() не нужен —
  // total_rows из system.tables бесплатен.
  const minMaxPromise: Promise<{ mn?: string; mx?: string } | undefined> = dateColumn
    ? client
        .query({
          query: `SELECT min(\`${dateColumn}\`) AS mn, max(\`${dateColumn}\`) AS mx FROM ${target.table}`,
          format: "JSONEachRow",
          clickhouse_settings: EXPLORE_SETTINGS,
        })
        .then(async (rs) => (await rs.json<{ mn?: string; mx?: string }>())[0])
    : Promise.resolve(undefined);

  const samplesPromise = client
    .query({ query: `SELECT * FROM ${target.table} LIMIT 3`, format: "JSONEachRow" })
    .then(async (rs) => (await rs.json<Record<string, unknown>>()).map(compactSampleRow));

  // Статистика ключевых колонок: кардинальность — дёшево (сэмпл на больших
  // таблицах), топ-N с частотами — ТОЛЬКО для низкокардинальных колонок
  // (event_type, action…). Высококардинальным (repo_name, actor_login: 35M/13M
  // уникальных) полный GROUP BY стоил бы 10-13с и грозил таймаутом — им отдаём
  // одну кардинальность, а примеры значений LLM видит в сэмпл-строках.
  const keyColumnsPromise: Promise<KeyColumnStats[]> = target.deep
    ? (async () => {
        const names = await pickKeyColumns(client, target.table, target.totalRows, columns);
        const card = await estimateColumnUniq(client, target.table, target.totalRows, names);
        return Promise.all(
          names.map(async (column) => {
            const cardinality = card.get(column) ?? 0;
            const top =
              cardinality > 0 && cardinality <= TOPN_MAX_CARD
                ? await keyColumnTop(client, target.table, column)
                : [];
            return { column, cardinality: Math.max(cardinality, top.length), top };
          }),
        );
      })()
    : Promise.resolve([]);

  const [totals, sampleRows, keyColumns] = await Promise.all([
    minMaxPromise,
    samplesPromise,
    keyColumnsPromise,
  ]);

  return {
    table: target.table,
    rowCount: target.totalRows,
    sortingKey: target.sortingKey,
    dateColumn,
    dateRange: { min: totals?.mn ?? "", max: totals?.mx ?? "" },
    columns,
    keyColumns,
    sampleRows,
  };
}

/**
 * Общий пул исследования: таблицы параллельно, но с ОГРАНИЧЕННОЙ
 * конкурентностью — безлимитный Promise.all даёт всплеск тяжёлых запросов на
 * один клиент, и ClickHouse Cloud под нагрузкой рвёт соединения (ECONNRESET).
 * Порядок результата повторяет порядок targets; проблема одной таблицы не
 * валит весь проход.
 */
async function runExploration(
  client: ClickHouseClient,
  targets: DiscoveredTable[],
  deepFor: (index: number) => boolean,
): Promise<SchemaContext[]> {
  const settled: (SchemaContext | undefined)[] = new Array(targets.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(EXPLORE_CONCURRENCY, targets.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= targets.length) return;
        const d = targets[i];
        const fqName = `${d.database}.${d.name}`;
        try {
          settled[i] = await exploreTable(client, {
            table: fqName,
            database: d.database,
            name: d.name,
            totalRows: d.totalRows,
            sortingKey: d.sortingKey,
            deep: deepFor(i),
          });
        } catch (err) {
          console.warn(
            `exploration: пропускаю ${fqName}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }),
  );
  const contexts = settled.filter((c): c is SchemaContext => c !== undefined);
  if (contexts.length === 0) {
    throw new Error("exploration: не удалось исследовать ни одну таблицу");
  }
  return contexts;
}

/**
 * Фаза B exploration: ГЛУБОКАЯ разведка выбранных триажем таблиц (сэмплы,
 * кардинальности, топ значений, диапазон дат). Неизвестные имена молча
 * пропускаются (LLM мог ошибиться в имени), порядок triage сохраняется.
 */
export async function exploreTables(
  client: ClickHouseClient,
  fqNames: string[],
): Promise<SchemaContext[]> {
  const discovered = await discoverTables(client);
  const byName = new Map(discovered.map((d) => [`${d.database}.${d.name}`, d]));
  const targets = [...new Set(fqNames)]
    .map((n) => byName.get(n))
    .filter((d): d is DiscoveredTable => d !== undefined)
    .slice(0, MAX_DEEP_TABLES);
  if (targets.length === 0) {
    throw new Error(
      `exploreTables: ни одна из запрошенных таблиц не видна agent_ro: ${fqNames.join(", ")}`,
    );
  }
  return runExploration(client, targets, () => true);
}

/**
 * Legacy-проход одним вызовом (скрипт explore:schema, Trigger-таска
 * explore-schema): топ-MAX_TABLES таблиц по размеру, глубоко — только самая
 * большая. Конвейер investigate этим НЕ пользуется — он идёт через
 * catalogTables → триаж → exploreTables.
 */
export async function exploreSchema(client: ClickHouseClient): Promise<SchemaContext[]> {
  const discovered = await discoverTables(client);
  const ordered = discovered.slice(0, MAX_TABLES);
  if (ordered.length === 0) {
    throw new Error(
      "exploreSchema: agent_ro не видит ни одной непустой таблицы данных — проверь гранты (system.tables пуст за вычетом служебных баз)",
    );
  }
  return runExploration(client, ordered, (i) => i === 0);
}

// ---------------------------------------------------------------------------
// Мемоизация в процессе
// ---------------------------------------------------------------------------

/**
 * ЕДИНСТВЕННЫЙ «кэш» exploration — короткая мемоизация промиса КАТАЛОГА в
 * памяти процесса: параллельные раны в одном воркере не гоняют одинаковые
 * запросы к system.*. Никакого хранимого состояния, поэтому нет и церемонии
 * инвалидации: новые таблицы/гранты видны не позже, чем через
 * CATALOG_MEMO_TTL_MS даже на долгоживущем воркере. Глубокая разведка не
 * мемоизируется: она и так идёт только по 1–MAX_DEEP_TABLES выбранным таблицам.
 */
const CATALOG_MEMO_TTL_MS = 60_000;

let catalogMemo: { promise: Promise<CatalogTable[]>; at: number } | undefined;

export async function getCatalog(client: ClickHouseClient): Promise<CatalogTable[]> {
  if (!catalogMemo || Date.now() - catalogMemo.at >= CATALOG_MEMO_TTL_MS) {
    const promise = catalogTables(client);
    catalogMemo = { promise, at: Date.now() };
    // Неудачный каталог не должен залипать в мемо до конца TTL.
    promise.catch(() => {
      if (catalogMemo?.promise === promise) catalogMemo = undefined;
    });
  }
  return catalogMemo.promise;
}

/**
 * Полный живой проход B2 под agent_ro — точка входа Trigger-таски
 * (src/trigger/explore-schema.ts) и локального скрипта (scripts/explore-schema.ts).
 */
export async function runExploreSchema(): Promise<{ contexts: SchemaContext[] }> {
  const ro = createReadonlyClient();
  try {
    return { contexts: await exploreSchema(ro) };
  } finally {
    await ro.close();
  }
}
