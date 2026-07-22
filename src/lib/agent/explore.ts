/**
 * B2 — exploration, two-phase and with no single hardcoded table name.
 *
 * Phase A — catalogTables(): cheap catalog of ALL tables visible to agent_ro
 * (system.tables + system.columns, no statistics or samples — hundreds of
 * milliseconds). Catalog goes to triage (triage.ts): WHICH tables relate to
 * the question is decided by the LLM at request time — no "priority table"
 * from config anymore. agent_ro grants = agent scope.
 *
 * Phase B — exploreTables(): deep exploration of ONLY triage-selected tables:
 *   - date column — heuristic: first Date/DateTime* column with
 *     preference for names created_at → *_at → date/time/day/ts;
 *   - key columns — up to MAX_KEY_COLUMNS: Enum* and LowCardinality(String)
 *     in schema order, fill — String with low uniq from sample; for each
 *     cardinality and top values are computed. Expensive uniq on tables
 *     >BIG_TABLE_ROWS rows — via LIMIT sample, top-N — only for
 *     low-cardinality columns; all with time budget (break, not error);
 *   - min/max dates and 3 sample rows.
 *
 * NO persistent cache: all information already lives in ClickHouse; only
 * short in-process catalog memoization (getCatalog), so parallel runs in
 * one worker do not duplicate identical queries.
 * Context is read by the investigate pipeline (pipeline.ts) and triage and
 * text-to-SQL prompts (triage.ts, generate-sql.ts).
 */
import type { ClickHouseClient } from "@clickhouse/client";
import { createReadonlyClient } from "@/lib/clickhouse";

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------

export type ColumnInfo = { name: string; type: string; comment?: string };

export type TopValue = { v: string; n: number };

export type KeyColumnStats = {
  column: string;
  cardinality: number;
  top: TopValue[];
};

/** Compact JSON context for one table — sent to the LLM prompt as-is. */
export type SchemaContext = {
  table: string;
  rowCount: number;
  /**
   * Table ORDER BY / primary key. CRITICAL for speed: MergeTree index
   * prunes granules only when filtering by a PREFIX of this key — LLM must
   * account for this (see performance rules in generate-sql.ts).
   */
  sortingKey: string[];
  /** Empty string if the table has no Date/DateTime* columns. */
  dateColumn: string;
  dateRange: { min: string; max: string };
  columns: ColumnInfo[];
  keyColumns: KeyColumnStats[];
  /** 3 sample rows; fields with default values omitted to save tokens. */
  sampleRows: Record<string, unknown>[];
};

// ---------------------------------------------------------------------------
// Discovery parameters
// ---------------------------------------------------------------------------

/** Max tables in legacy exploreSchema pass context. */
const MAX_TABLES = 5;
/** Phase A catalog cap — protects triage prompt from giant instances. */
const MAX_CATALOG_TABLES = 40;
/** Phase B deep exploration cap — triage must not select more. */
export const MAX_DEEP_TABLES = 4;
/** How many key (low-cardinality) columns per table. */
const MAX_KEY_COLUMNS = 3;
/** How many top values per key column. */
const KEY_TOP_N = 30;
/** How many tables to explore concurrently (see comment in exploreSchema). */
const EXPLORE_CONCURRENCY = 2;
/** From this size uniq is computed on a LIMIT sample, not the whole table. */
const BIG_TABLE_ROWS = 10_000_000;
/** LIMIT sample size for uniq estimates (SAMPLE requires a sampling key). */
const UNIQ_SAMPLE_ROWS = 500_000;
/** String column enters key columns if its sample uniq is at most this. */
const LOW_UNIQ_THRESHOLD = 200;
/**
 * Top-N with frequencies (GROUP BY) computed only for columns with cardinality
 * at most this threshold. GROUP BY on a high-cardinality column (repo_name —
 * 35M unique) on 150M rows scans the whole table for 10-13s and risks
 * timeout; such a column gets only a cardinality estimate, and the LLM sees
 * example values in sample rows.
 */
const TOPN_MAX_CARD = 1_000;
/**
 * Timeout safety: any exploration analytics query is time-limited and on
 * overflow returns a PARTIAL result (break), not an error. So live exploration
 * under load (e.g. during data ingestion) does not kill the run — at worst
 * statistics will be approximate.
 */
const EXPLORE_SETTINGS = {
  max_execution_time: 20,
  timeout_overflow_mode: "break",
} as const;

/** System databases — not data tables. */
const SYSTEM_DATABASES = ["system", "information_schema", "INFORMATION_SCHEMA"];
/** Project service databases (rollups, LLM log) — hidden from LLM. */
const HIDDEN_DATABASES = ["scratch"];

// ---------------------------------------------------------------------------
// Table discovery
// ---------------------------------------------------------------------------

type DiscoveredTable = {
  database: string;
  name: string;
  totalRows: number;
  /** ORDER BY / primary key columns (for prompt and LLM hints). */
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
 * Non-empty tables visible to agent_ro (grants = agent scope), excluding system
 * databases, scratch service DB, and Views. Filter total_rows > 0 also excludes
 * external engines like URL (total_rows NULL) — their count() would go over the network.
 * sorting_key fetched here — free from system.tables and critical for
 * LLM hints about index pruning.
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
// Phase A: catalog of all visible tables (cheap, for triage)
// ---------------------------------------------------------------------------

/** Compact catalog entry: enough for triage LLM to pick tables. */
export type CatalogTable = {
  /** Full name `db.table`. */
  table: string;
  rowCount: number;
  sortingKey: string[];
  /** Heuristic: best Date/DateTime* column; empty string — none. */
  dateColumn: string;
  columns: ColumnInfo[];
};

/** All columns of all visible tables in ONE query: `db.table` → columns. */
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
 * Phase A exploration: full catalog of visible tables WITHOUT expensive statistics —
 * only system.tables + system.columns (hundreds of ms on any instance).
 * Read by triage (triage.ts): LLM decides which tables relate to the question.
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
// Column type and name heuristics
// ---------------------------------------------------------------------------

/** Strip Nullable(...)/LowCardinality(...) wrappers down to base type. */
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

/** Enum* and LowCardinality(String): low cardinality by type construction. */
function isKeyCandidateByType(type: string): boolean {
  const base = unwrapType(type);
  if (/^Enum(8|16)?\b/.test(base)) return true;
  return base === "String" && type.includes("LowCardinality(");
}

/** Plain String column — key candidate only with low uniq. */
function isPlainString(type: string): boolean {
  return unwrapType(type) === "String" && !type.includes("LowCardinality(");
}

/** Lower score — better name for a date column role. */
function dateNameScore(name: string): number {
  const n = name.toLowerCase();
  if (n === "created_at") return 0;
  if (n.endsWith("_at")) return 1;
  if (/(date|time|day)/.test(n) || n === "ts" || n.endsWith("_ts")) return 2;
  return 3;
}

/**
 * Date column: best Date/DateTime* column by name, on tie — first in schema
 * order. Empty string if no temporal columns at all (e.g. star-schema fact
 * tables keep date as numeric *_sk key to dimension — LLM decides from catalog,
 * not heuristic).
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
// Context assembly
// ---------------------------------------------------------------------------

/** Compact type: `Enum8('a' = 1, 'b' = 2)` → `Enum8('a', 'b')` — LLM needs literals, not numbers. */
function compactType(type: string): string {
  return type.replace(/'\s*=\s*-?\d+/g, "'");
}

/** Sample row without default values; long strings truncated to 100 chars. */
function compactSampleRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === "" || value === 0 || value === "0") continue;
    if (value === "none" || value === "NONE") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === "string") {
      if (value.startsWith("1970-01-01")) continue; // empty DateTime
      out[key] = value.length > 100 ? `${value.slice(0, 100)}…` : value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Columns with types (and comment if present) from system.columns. */
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
 * Column uniq estimate: on large tables — via LIMIT sample (cheap and
 * bounded), on small — exact uniqCombined over the whole table. One query
 * for all columns. Number is approximate, but enough for the prompt and for
 * deciding "is this column low-cardinality".
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
 * Key columns: first Enum* and LowCardinality(String) in schema order,
 * fill to MAX_KEY_COLUMNS — String columns with low uniq (sample estimate).
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
      return u >= 2 && u <= LOW_UNIQ_THRESHOLD; // constants and "unique" not needed
    })
    .sort((a, b) => (uniq.get(a) ?? 0) - (uniq.get(b) ?? 0));
  return [...picked, ...lowUniq.slice(0, MAX_KEY_COLUMNS - picked.length)];
}

/**
 * Top-N values with frequencies for one key column. Only for
 * low-cardinality columns (checked by caller) — their GROUP BY yields few
 * groups and fits the budget; break — timeout safety under load.
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
  /** Full name `db.table`. */
  table: string;
  database: string;
  name: string;
  /** Approximate size from system.tables — uniq strategy selection. */
  totalRows: number;
  /** ORDER BY / primary key (from discoverTables). */
  sortingKey: string[];
  /**
   * Deep exploration (cardinalities + top-N values) — most expensive
   * exploration queries. In v2 pipeline ALL triage-selected tables are
   * explored deeply (max MAX_DEEP_TABLES); in legacy exploreSchema pass —
   * only the largest.
   */
  deep: boolean;
};

async function exploreTable(
  client: ClickHouseClient,
  target: TableTarget,
): Promise<SchemaContext> {
  // Columns: name + type (+ comment) from system.columns.
  const columns = await fetchColumns(client, target.database, target.name);
  if (columns.length === 0) {
    throw new Error(`system.columns returned no columns for ${target.table}`);
  }
  const dateColumn = pickDateColumn(columns);

  // All independent stages — IN PARALLEL (latency = max, not sum):
  // min/max dates, sample rows, key column statistics. count() not needed —
  // total_rows from system.tables is free.
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

  // Key column statistics: cardinality — cheap (sample on large
  // tables), top-N with frequencies — ONLY for low-cardinality columns
  // (event_type, action…). High-cardinality (repo_name, actor_login: 35M/13M
  // unique) full GROUP BY would cost 10-13s and risk timeout — they get
  // cardinality only, and the LLM sees example values in sample rows.
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
 * Shared exploration pool: tables in parallel, but with LIMITED
 * concurrency — unlimited Promise.all spikes heavy queries on
 * one client, and ClickHouse Cloud under load drops connections (ECONNRESET).
 * Result order matches targets order; one table failure does not
 * kill the whole pass.
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
            `exploration: skipping ${fqName}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }),
  );
  const contexts = settled.filter((c): c is SchemaContext => c !== undefined);
  if (contexts.length === 0) {
    throw new Error("exploration: failed to explore any table");
  }
  return contexts;
}

/**
 * Phase B exploration: DEEP reconnaissance of triage-selected tables (samples,
 * cardinalities, top values, date range). Unknown names silently
 * skipped (LLM may have misspelled), triage order preserved.
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
      `exploreTables: none of the requested tables are visible to agent_ro: ${fqNames.join(", ")}`,
    );
  }
  return runExploration(client, targets, () => true);
}

/**
 * Legacy single-call pass (explore:schema script, Trigger task
 * explore-schema): top MAX_TABLES tables by size, deep — only the largest.
 * investigate pipeline does NOT use this — it goes through
 * catalogTables → triage → exploreTables.
 */
export async function exploreSchema(client: ClickHouseClient): Promise<SchemaContext[]> {
  const discovered = await discoverTables(client);
  const ordered = discovered.slice(0, MAX_TABLES);
  if (ordered.length === 0) {
    throw new Error(
      "exploreSchema: agent_ro sees no non-empty data tables — check grants (system.tables empty except service databases)",
    );
  }
  return runExploration(client, ordered, (i) => i === 0);
}

// ---------------------------------------------------------------------------
// In-process memoization
// ---------------------------------------------------------------------------

/**
 * ONLY exploration "cache" — short in-process CATALOG promise memoization:
 * parallel runs in one worker do not repeat identical system.* queries.
 * No stored state, so no invalidation ceremony: new tables/grants visible
 * no later than CATALOG_MEMO_TTL_MS even on a long-lived worker. Deep
 * exploration is not memoized: it runs only on 1–MAX_DEEP_TABLES selected tables.
 */
const CATALOG_MEMO_TTL_MS = 60_000;

let catalogMemo: { promise: Promise<CatalogTable[]>; at: number } | undefined;

export async function getCatalog(client: ClickHouseClient): Promise<CatalogTable[]> {
  if (!catalogMemo || Date.now() - catalogMemo.at >= CATALOG_MEMO_TTL_MS) {
    const promise = catalogTables(client);
    catalogMemo = { promise, at: Date.now() };
    // Failed catalog must not stick in memo until TTL ends.
    promise.catch(() => {
      if (catalogMemo?.promise === promise) catalogMemo = undefined;
    });
  }
  return catalogMemo.promise;
}

/**
 * Full live B2 pass under agent_ro — entry point for Trigger task
 * (src/trigger/explore-schema.ts) and local script (scripts/explore-schema.ts).
 */
export async function runExploreSchema(): Promise<{ contexts: SchemaContext[] }> {
  const ro = createReadonlyClient();
  try {
    return { contexts: await exploreSchema(ro) };
  } finally {
    await ro.close();
  }
}
