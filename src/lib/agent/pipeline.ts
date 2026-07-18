/**
 * B3/B4/B5 — конвейер investigate, отвязанный от Trigger-рантайма.
 *
 * Шаги (RunStep из контрактов, строгая валидация перед каждым эмитом):
 *   exploring      → читаем кэш схемы из scratch.schema_context (пустой кэш —
 *                    исследуем схему живьём и кэшируем);
 *   generating_sql → generateSql() — text-to-SQL через LLM (B4);
 *   executing      → санитайз (только SELECT) + SQL под agent_ro, JSONEachRow;
 *   healing        → до 3 попыток; ошибка ClickHouse/валидации уходит модели
 *                    контекстом, healSql() возвращает исправленный SQL (B5);
 *   done           → ViewSpec[], проверенные viewSpecSchema.parse;
 *   error          → терминальная неудача после исчерпания попыток, со списком
 *                    всех попыток в message (фоллбек-карточку рисует UI).
 *
 * Trigger-таска (src/trigger/investigate.ts) передаёт emit, пишущий шаги в
 * metadata рана (Realtime); смоук-скрипт печатает их в stdout. Логика одна.
 */
import type { ClickHouseClient } from "@clickhouse/client";
import { createReadonlyClient, createScratchClient } from "@/lib/clickhouse";
import {
  runStepSchema,
  viewSpecSchema,
  type AskRequest,
  type ClickTarget,
  type RunStep,
  type ViewSpec,
} from "@/lib/contracts";
import {
  exploreSchema,
  loadSchemaContext,
  persistSchemaContext,
  type SchemaContext,
} from "./explore";
import {
  generateSql,
  healSql,
  sanitizeSql,
  summarizeVerdict,
  type GeneratedSql,
  type VerdictSummary,
} from "./generate-sql";

export type StepEmitter = (step: RunStep) => void | Promise<void>;

export type PipelineOptions = {
  emit: StepEmitter;
  /** Инъекция клиентов для тестов; по умолчанию создаются и закрываются внутри. */
  readonlyClient?: ClickHouseClient;
  scratchClient?: ClickHouseClient;
  /** Тест-шов: подмена генерации SQL (heal-smoke подсовывает битый SQL). */
  generateSqlImpl?: typeof generateSql;
};

export type PipelineResult = {
  viewSpecs: ViewSpec[];
  sql: string;
  attempts: number;
};

/** Максимум попыток исполнения SQL (шаг healing между ними). */
export const MAX_SQL_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Исполнение SQL
// ---------------------------------------------------------------------------

type ResultRow = Record<string, unknown>;

async function executeSql(client: ClickHouseClient, sql: string): Promise<ResultRow[]> {
  const rs = await client.query({
    query: sql,
    format: "JSONEachRow",
    clickhouse_settings: {
      // Страховка поверх серверных лимитов agent_ro (A5) и max_execution_time из фабрики.
      max_result_rows: "10000",
      result_overflow_mode: "break",
    },
  });
  return rs.json<ResultRow>();
}

// ---------------------------------------------------------------------------
// Сборка ViewSpec из строк результата
// ---------------------------------------------------------------------------

/** UInt64 и Decimal приходят из JSONEachRow строками — числовые строки коэрсим. */
function toCell(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    if (/^-?\d+(\.\d+)?$/.test(value)) {
      const n = Number(value);
      if (Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER) return n;
    }
    return value;
  }
  return JSON.stringify(value);
}

function requireColumns(row: ResultRow, kind: string, columns: string[]): void {
  const missing = columns.filter((c) => !(c in row));
  if (missing.length > 0) {
    throw new Error(
      `${kind}-SQL обязан возвращать колонки ${columns.map((c) => `\`${c}\``).join(", ")} — нет: ${missing.join(", ")}`,
    );
  }
}

/**
 * Строит ViewSpec выбранного вида из строк результата. Конвенции формы данных —
 * см. generate-sql.ts. Валидацию viewSpecSchema.parse делает вызывающий.
 *
 * Клик-цели: разумные ClickTarget без drillId (каталог drill-запросов появится
 * в A4) — до тех пор клик может только запустить новый ран агента (action 'why').
 */
function buildViewSpec(
  generated: GeneratedSql,
  rows: ResultRow[],
  verdictSummary?: VerdictSummary,
): unknown {
  if (rows.length === 0) {
    throw new Error("SQL вернул 0 строк — карточку не из чего собрать");
  }
  switch (generated.kind) {
    case "timeline": {
      // Опциональная колонка `series` разводит точки по нескольким линиям.
      const bySeries = new Map<string, { t: string; v: number }[]>();
      for (const row of rows) {
        requireColumns(row, "timeline", ["t", "v"]);
        const name =
          "series" in row && row.series != null && row.series !== ""
            ? String(row.series)
            : generated.title;
        const points = bySeries.get(name) ?? [];
        points.push({ t: String(row.t), v: Number(row.v) });
        bySeries.set(name, points);
      }
      const clicks: ClickTarget[] = [
        {
          on: "point",
          selectionKeys: ["t", "series"],
          label: "Почему всплеск в этот момент?",
        },
      ];
      return {
        kind: "timeline",
        title: generated.title,
        series: [...bySeries].map(([name, points]) => ({ name, points })),
        ...(generated.anomalyWindow ? { anomalyWindow: generated.anomalyWindow } : {}),
        clicks,
      };
    }
    case "leaderboard": {
      const keys = Object.keys(rows[0]);
      // Первая колонка — сущность (конвенция generate-sql.ts): клик по строке
      // уносит её значение в selection нового рана «почему?».
      const clicks: ClickTarget[] = [
        {
          on: "row",
          selectionKeys: [keys[0]],
          label: "Разобраться, что здесь происходит",
        },
      ];
      return {
        kind: "leaderboard",
        title: generated.title,
        columns: keys.map((key) => ({ key, label: key })),
        rows: rows.map((row) =>
          Object.fromEntries(keys.map((key) => [key, toCell(row[key])])),
        ),
        clicks,
      };
    }
    case "histogram": {
      const buckets = rows.map((row) => {
        requireColumns(row, "histogram", ["label", "count"]);
        return { label: String(row.label), count: Math.round(Number(row.count)) };
      });
      const clicks: ClickTarget[] = [
        {
          on: "bucket",
          selectionKeys: ["label"],
          label: "Кто попал в эту корзину?",
        },
      ];
      return {
        kind: "histogram",
        title: generated.title,
        bucketLabel: generated.bucketLabel ?? generated.title,
        buckets,
        clicks,
      };
    }
    case "heatmap": {
      const xLabels: string[] = [];
      const yLabels: string[] = [];
      const cells = rows.map((row) => {
        requireColumns(row, "heatmap", ["x", "y", "value"]);
        const x = String(row.x);
        const y = String(row.y);
        if (!xLabels.includes(x)) xLabels.push(x);
        if (!yLabels.includes(y)) yLabels.push(y);
        return { x, y, value: Number(row.value) };
      });
      const clicks: ClickTarget[] = [
        {
          on: "cell",
          selectionKeys: ["x", "y"],
          label: "События в этом слоте",
        },
      ];
      return {
        kind: "heatmap",
        title: generated.title,
        xLabels,
        yLabels,
        cells,
        clicks,
      };
    }
    case "verdict": {
      // Конвенция: одна строка агрегатов, каждая колонка — стат-факт evidence.
      const evidence = Object.entries(rows[0]).map(([label, value]) => ({
        label: label.replace(/_/g, " "),
        value: toCell(value) ?? "—",
      }));
      // Вердикт и уверенность пишет второй LLM-вызов по фактическим цифрам;
      // при его сбое — title как вердикт с уверенностью low.
      return {
        kind: "verdict",
        verdict: verdictSummary?.verdict ?? generated.title,
        confidence: verdictSummary?.confidence ?? "low",
        evidence,
      };
    }
    default:
      // graph — до C5 (рендер) и B6 (temp tables под ко-старинг) не поддержан.
      throw new Error(
        `вид карточки '${generated.kind}' не поддержан до C5/B6 — выбери другой kind`,
      );
  }
}

// ---------------------------------------------------------------------------
// Конвейер
// ---------------------------------------------------------------------------

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runInvestigatePipeline(
  input: AskRequest,
  options: PipelineOptions,
): Promise<PipelineResult> {
  const emit: StepEmitter = async (step) => {
    // Строгая валидация контракта Realtime-прогресса перед каждым эмитом.
    await options.emit(runStepSchema.parse(step));
  };

  const ro = options.readonlyClient ?? createReadonlyClient();
  const scratch = options.scratchClient ?? createScratchClient();
  const ownsClients = !options.readonlyClient && !options.scratchClient;
  let errorEmitted = false;

  try {
    // -- exploring ----------------------------------------------------------
    await emit({ step: "exploring", message: "Читаю кэш схемы из scratch" });
    let schemaContext: SchemaContext[];
    try {
      schemaContext = await loadSchemaContext(scratch);
    } catch {
      schemaContext = []; // кэш-таблицы ещё нет — исследуем живьём
    }
    if (schemaContext.length === 0) {
      await emit({
        step: "exploring",
        message: "Кэш пуст — исследую схему живьём",
      });
      schemaContext = await exploreSchema(ro);
      await persistSchemaContext(scratch, schemaContext);
    }

    // -- generating_sql -----------------------------------------------------
    await emit({
      step: "generating_sql",
      message: `Пишу SQL по таблице ${schemaContext[0].table}`,
    });
    let generated = await (options.generateSqlImpl ?? generateSql)({
      question: input.question,
      schemaContext,
      clickContext: input.context,
    });

    // -- executing + healing (до MAX_SQL_ATTEMPTS попыток) -------------------
    const attemptErrors: string[] = [];
    for (let attempt = 1; attempt <= MAX_SQL_ATTEMPTS; attempt++) {
      await emit({
        step: "executing",
        sqlPreview: generated.sql,
        message:
          attempt === 1 ? undefined : `Попытка ${attempt} из ${MAX_SQL_ATTEMPTS}`,
      });
      try {
        // Санитайз (только SELECT, один стейтмент) — страховка поверх agent_ro;
        // его ошибка тоже уходит в самопочинку.
        const sql = sanitizeSql(generated.sql);
        const rows = await executeSql(ro, sql);

        // Для verdict — второй короткий LLM-вызов: вывод по фактическим цифрам.
        // Сбой вызова не роняет ран: buildViewSpec подставит title + low.
        let verdictSummary: VerdictSummary | undefined;
        if (generated.kind === "verdict") {
          try {
            verdictSummary = await summarizeVerdict({
              question: input.question,
              title: generated.title,
              rows,
            });
          } catch {
            verdictSummary = undefined;
          }
        }

        const viewSpec = viewSpecSchema.parse(
          buildViewSpec(generated, rows, verdictSummary),
        );
        await emit({
          step: "done",
          viewSpecs: [viewSpec],
          message: `${rows.length} строк → карточка ${viewSpec.kind}`,
        });
        return { viewSpecs: [viewSpec], sql, attempts: attempt };
      } catch (err) {
        const lastError = errorMessage(err);
        attemptErrors.push(lastError);
        if (attempt < MAX_SQL_ATTEMPTS) {
          // B5: ошибка уходит модели контекстом — healSql возвращает
          // исправленный SQL в том же строгом JSON-формате.
          await emit({
            step: "healing",
            attempt,
            error: lastError,
            message: "Отдаю ошибку модели на починку",
          });
          try {
            generated = await healSql({
              question: input.question,
              schemaContext,
              clickContext: input.context,
              previous: generated,
              error: lastError,
              attempt,
            });
          } catch {
            // LLM недоступна — оставляем прежний SQL, попытка станет простым ретраем.
          }
        }
      }
    }

    // -- error (самопочинка исчерпана) --------------------------------------
    const attemptsSummary = attemptErrors
      .map((e, i) => `Попытка ${i + 1}: ${e.length > 300 ? `${e.slice(0, 300)}…` : e}`)
      .join(" | ");
    const message = `SQL не удался после ${MAX_SQL_ATTEMPTS} попыток. ${attemptsSummary}`;
    errorEmitted = true;
    await emit({ step: "error", message });
    throw new Error(message);
  } catch (err) {
    // Неожиданный сбой вне цикла исполнения (exploring/generating_sql/эмит) —
    // тоже завершаем терминальным шагом error, чтобы фронт увидел фоллбек.
    if (!errorEmitted) {
      try {
        await options.emit(
          runStepSchema.parse({ step: "error", message: errorMessage(err) }),
        );
      } catch {
        // эмит не должен затирать исходную ошибку
      }
    }
    throw err;
  } finally {
    if (ownsClients) {
      await Promise.all([ro.close(), scratch.close()]);
    }
  }
}
