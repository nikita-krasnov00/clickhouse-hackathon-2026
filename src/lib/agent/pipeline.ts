/**
 * B3/B4/B5 — конвейер investigate, отвязанный от Trigger-рантайма.
 *
 * Шаги (RunStep из контрактов, строгая валидация перед каждым эмитом):
 *   exploring      → кэш схемы: процесс → scratch.schema_context → живое
 *                    исследование (что первым найдётся);
 *   generating_sql → generateSql() — LLM-планировщик дашборда (B4): 1–3
 *                    карточки, каждая — свой SQL либо готовый дрилл A4;
 *   planning       → план готов, список карточек уходит в ленту прогресса;
 *   card_ready     → карточки исполняются ПАРАЛЛЕЛЬНО и эмитятся по мере
 *                    готовности — UI рендерит их, не дожидаясь конца рана.
 *                    Исполнитель карточек — шов cardRunner: по умолчанию
 *                    Promise.all в этом процессе (runCardsInProcess), в
 *                    Trigger-ране — параллельные дочерние раны investigate-card.
 *                    Плюс «мгновенный срез»: если вопрос называет репозиторий,
 *                    первая timeline-карточка строится дриллом по роллапам ещё
 *                    до ответа LLM;
 *   executing      → санитайз (только SELECT) + SQL под agent_ro, JSONEachRow;
 *   healing        → до 3 попыток на sql-карточку; ошибка ClickHouse/валидации
 *                    уходит модели контекстом, healSql() чинит SQL (B5);
 *   done           → все успешные ViewSpec (проверены viewSpecSchema.parse);
 *   error          → терминальная неудача: НИ ОДНА карточка плана не удалась.
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
import { resolveDrill } from "@/lib/drills";
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
  type GeneratedPlan,
  type GeneratedSql,
  type GenerateSqlInput,
  type PlannedCard,
  type VerdictSummary,
} from "./generate-sql";

export type StepEmitter = (step: RunStep) => void | Promise<void>;

export type PipelineOptions = {
  emit: StepEmitter;
  /** Инъекция клиентов для тестов; по умолчанию создаются и закрываются внутри. */
  readonlyClient?: ClickHouseClient;
  scratchClient?: ClickHouseClient;
  /**
   * Тест-шов: подмена генерации (heal-smoke подсовывает битый SQL). Принимает
   * и легаси-форму одной sql-карточки — она заворачивается в план из 1 карточки.
   */
  generateSqlImpl?: (input: GenerateSqlInput) => Promise<GeneratedSql | GeneratedPlan>;
  /**
   * Шов исполнения карточек плана. Дефолт — runCardsInProcess (Promise.all в
   * текущем процессе): его используют смоук-скрипты, он же фоллбек. Trigger-таска
   * investigate подставляет исполнитель на параллельных дочерних ранах
   * (batch.triggerByTaskAndWait → investigate-card, см. src/trigger/investigate.ts).
   */
  cardRunner?: CardRunner;
};

export type PipelineResult = {
  viewSpecs: ViewSpec[];
  /** Финальные SQL успешных sql-карточек (с заголовками-комментариями). */
  sql: string;
  /** Суммарные попытки исполнения по всем карточкам. */
  attempts: number;
};

/** Максимум попыток исполнения SQL (шаг healing между ними). */
export const MAX_SQL_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Исполнение SQL
// ---------------------------------------------------------------------------

type ResultRow = Record<string, unknown>;

/** owner/name — признак, что строка выглядит как имя репозитория. */
const REPO_NAME_RE = /^[^\s/]+\/[^\s/]+$/;

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
  question?: string,
): unknown {
  if (rows.length === 0) {
    throw new Error("SQL вернул 0 строк — карточку не из чего собрать");
  }
  // Репо из текста вопроса: если серия одна и без имени, называем её репо —
  // тогда клик по точке получает drillId (drill резолвит repo из series).
  const questionRepo = question?.match(/[\w.-]+\/[\w.-]+/)?.[0];
  switch (generated.kind) {
    case "timeline": {
      // Опциональная колонка `series` разводит точки по нескольким линиям.
      const bySeries = new Map<string, { t: string; v: number }[]>();
      for (const row of rows) {
        requireColumns(row, "timeline", ["t", "v"]);
        const name =
          "series" in row && row.series != null && row.series !== ""
            ? String(row.series)
            : (questionRepo ?? generated.title);
        const points = bySeries.get(name) ?? [];
        points.push({ t: String(row.t), v: Number(row.v) });
        bySeries.set(name, points);
      }
      // A4/C6: если имена серий — репозитории, точка дриллится в «акторы дня»
      // (drill резолвит repo из selection.series); иначе остаётся путь «почему?».
      const seriesAreRepos = [...bySeries.keys()].every((n) => REPO_NAME_RE.test(n));
      const clicks: ClickTarget[] = [
        {
          on: "point",
          selectionKeys: ["t", "series"],
          ...(seriesAreRepos ? { drillId: "actors-of-day" } : {}),
          label: seriesAreRepos
            ? "Кто ставил звёзды в этот день?"
            : "Почему всплеск в этот момент?",
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
      // Первая колонка — сущность (конвенция generate-sql.ts). A4/C6: колонка
      // репозитория дриллится в таймлайн звёзд; иначе клик идёт в «почему?».
      const repoKey = keys.find((k) => k === "repo" || k === "repo_name");
      const clicks: ClickTarget[] = [
        repoKey
          ? {
              on: "row",
              selectionKeys: [repoKey],
              drillId: "stars-by-day",
              label: "Таймлайн звёзд этого репо",
            }
          : {
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
    case "bignumber": {
      // Конвенция: РОВНО одна строка, колонка `value` (+ опц. delta/label/detail).
      if (rows.length !== 1) {
        throw new Error(
          `bignumber-SQL обязан возвращать РОВНО одну строку — получено ${rows.length}`,
        );
      }
      const row = rows[0];
      requireColumns(row, "bignumber", ["value"]);
      const value = toCell(row.value);
      if (value === null) {
        throw new Error("bignumber-SQL: колонка `value` не должна быть NULL");
      }
      const delta = row.delta != null ? Number(row.delta) : undefined;
      if (delta !== undefined && !Number.isFinite(delta)) {
        throw new Error(
          "bignumber-SQL: колонка `delta` обязана быть числом — процент изменения к базе",
        );
      }
      return {
        kind: "bignumber",
        title: generated.title,
        value,
        // Подпись метрики — из колонки `label`, иначе титул карточки.
        label:
          row.label != null && row.label !== "" ? String(row.label) : generated.title,
        ...(delta !== undefined ? { delta } : {}),
        ...(row.detail != null && row.detail !== ""
          ? { detail: String(row.detail) }
          : {}),
      };
    }
    case "scatter": {
      // Конвенция: колонки `x`, `y` — числа, опц. `label` — имя сущности.
      const points = rows.map((row) => {
        requireColumns(row, "scatter", ["x", "y"]);
        const px = Number(row.x);
        const py = Number(row.y);
        if (!Number.isFinite(px) || !Number.isFinite(py)) {
          throw new Error(
            "scatter-SQL: колонки `x` и `y` обязаны быть числами (числовые метрики точки)",
          );
        }
        return {
          x: px,
          y: py,
          ...(row.label != null && row.label !== ""
            ? { label: String(row.label) }
            : {}),
        };
      });
      const hasLabels = points.some((p) => "label" in p);
      // Без drillId: клик по точке уходит в новый ран агента (action 'why').
      const clicks: ClickTarget[] = [
        {
          on: "point",
          selectionKeys: hasLabels ? ["label", "x", "y"] : ["x", "y"],
          label: "Разобраться с этой точкой",
        },
      ];
      return {
        kind: "scatter",
        title: generated.title,
        points,
        xLabel: generated.xLabel ?? "x",
        yLabel: generated.yLabel ?? "y",
        clicks,
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
// Кэш контекста схемы на процесс
// ---------------------------------------------------------------------------

/**
 * Тёплый процесс (Trigger-воркер, dev-сервер) отвечает на раны подряд —
 * контекст схемы не меняется, круговой запрос в scratch на каждый ран лишний.
 */
let schemaContextCache: { contexts: SchemaContext[]; at: number } | undefined;
const SCHEMA_CACHE_TTL_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// Конвейер
// ---------------------------------------------------------------------------

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Легаси-форма одной sql-карточки (тест-шов) заворачивается в план. */
function normalizePlan(result: GeneratedSql | GeneratedPlan): GeneratedPlan {
  if ("cards" in result) return result;
  return { cards: [{ tool: "sql", ...result }] };
}

export function cardTitle(card: PlannedCard): string {
  return card.tool === "sql" ? card.title : card.title || card.drillId;
}

/** Подпись карточки в сообщениях шагов: в плане из >1 карточки — в «ёлочках». */
export function cardLabel(card: PlannedCard, manyCards: boolean): string {
  const title = cardTitle(card);
  return manyCards ? `«${title}»` : title;
}

function cardSource(card: PlannedCard): string {
  return card.tool === "sql" ? `sql · ${card.kind}` : `drill:${card.drillId}`;
}

/**
 * Мгновенный срез: вопрос называет репозиторий → timeline звёзд по роллапам
 * (дрилл stars-by-day, сотни миллисекунд) эмитится ещё до ответа LLM.
 * Любой сбой — тихий пропуск: превью не имеет права ронять ран.
 */
async function runInstantPreview(
  ro: ClickHouseClient,
  repo: string,
  emit: StepEmitter,
): Promise<ViewSpec | undefined> {
  try {
    const def = resolveDrill("stars-by-day");
    const spec = viewSpecSchema.parse(
      await def.execute(ro, def.params.parse({ repo })),
    );
    await emit({
      step: "card_ready",
      viewSpec: spec,
      message: `Мгновенный срез по роллапам: «${
        spec.kind === "verdict" ? "вердикт" : spec.title
      }» — агент продолжает копать`,
    });
    return spec;
  } catch {
    return undefined;
  }
}

export type CardOutcome =
  | { ok: true; spec: ViewSpec; sql?: string; attempts: number }
  | { ok: false; error: string; attempts: number };

/** Контекст исполнителя карточек — всё, что нужно и sql-, и drill-карточке. */
export type CardRunnerContext = {
  ro: ClickHouseClient;
  emit: StepEmitter;
  input: AskRequest;
  schemaContext: SchemaContext[];
};

/**
 * Исполнитель карточек плана (шов PipelineOptions.cardRunner): получает все
 * карточки разом и обязан вернуть исход КАЖДОЙ (падение одной карточки —
 * CardOutcome {ok:false}, не исключение).
 */
export type CardRunner = (
  cards: PlannedCard[],
  ctx: CardRunnerContext,
) => Promise<CardOutcome[]>;

/** sql-карточка: executing → (healing → executing)* → card_ready. */
export async function runSqlCard(
  card: { tool: "sql" } & GeneratedSql,
  ctx: {
    ro: ClickHouseClient;
    emit: StepEmitter;
    input: AskRequest;
    schemaContext: SchemaContext[];
    /** Подпись карточки в сообщениях шагов (план из >1 карточки). */
    label: string;
  },
): Promise<CardOutcome> {
  const { ro, emit, input, schemaContext, label } = ctx;
  let generated: GeneratedSql = card;
  const attemptErrors: string[] = [];

  for (let attempt = 1; attempt <= MAX_SQL_ATTEMPTS; attempt++) {
    await emit({
      step: "executing",
      sqlPreview: generated.sql,
      message:
        attempt === 1
          ? label
          : `${label} — попытка ${attempt} из ${MAX_SQL_ATTEMPTS}`,
    });
    try {
      // Санитайз (только SELECT, один стейтмент) — страховка поверх agent_ro;
      // его ошибка тоже уходит в самопочинку.
      const sql = sanitizeSql(generated.sql);
      const rows = await executeSql(ro, sql);

      // Для verdict — второй короткий LLM-вызов: вывод по фактическим цифрам.
      // Сбой вызова не роняет карточку: buildViewSpec подставит title + low.
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
        buildViewSpec(generated, rows, verdictSummary, input.question),
      );
      await emit({
        step: "card_ready",
        viewSpec,
        sql,
        message: `${label}: ${rows.length} строк → карточка ${viewSpec.kind}`,
      });
      return { ok: true, spec: viewSpec, sql, attempts: attempt };
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
          message: `${label} — отдаю ошибку модели на починку`,
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

  const summary = attemptErrors
    .map((e, i) => `Попытка ${i + 1}: ${truncate(e)}`)
    .join(" | ");
  return {
    ok: false,
    error: `${label}: SQL не удался после ${MAX_SQL_ATTEMPTS} попыток. ${summary}`,
    attempts: MAX_SQL_ATTEMPTS,
  };
}

/** drill-карточка: готовый параметризованный запрос каталога A4, без healing. */
export async function runDrillCard(
  card: Extract<PlannedCard, { tool: "drill" }>,
  ctx: { ro: ClickHouseClient; emit: StepEmitter; label: string },
): Promise<CardOutcome> {
  const { ro, emit, label } = ctx;
  await emit({
    step: "executing",
    message: `${label} — дрилл ${card.drillId}`,
  });
  try {
    const def = resolveDrill(card.drillId);
    const params = def.params.parse(card.params);
    const spec = viewSpecSchema.parse(await def.execute(ro, params));
    await emit({
      step: "card_ready",
      viewSpec: spec,
      message: `${label}: дрилл ${card.drillId} → карточка ${spec.kind}`,
    });
    return { ok: true, spec, attempts: 1 };
  } catch (err) {
    return {
      ok: false,
      error: `${label}: дрилл ${card.drillId} не выполнился — ${truncate(errorMessage(err))}`,
      attempts: 1,
    };
  }
}

/**
 * Одна карточка плана любого инструмента — общая точка входа default-раннера
 * и дочерней Trigger-таски investigate-card. Никогда не бросает: любой исход —
 * CardOutcome.
 */
export async function runPlannedCard(
  card: PlannedCard,
  ctx: CardRunnerContext & { label: string },
): Promise<CardOutcome> {
  return card.tool === "sql"
    ? runSqlCard(card, ctx)
    : runDrillCard(card, ctx);
}

/** Дефолтный исполнитель карточек: параллельный Promise.all в текущем процессе. */
export const runCardsInProcess: CardRunner = (cards, ctx) => {
  const many = cards.length > 1;
  return Promise.all(
    cards.map((card) =>
      runPlannedCard(card, { ...ctx, label: cardLabel(card, many) }),
    ),
  );
};

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
    let schemaContext: SchemaContext[];
    if (
      schemaContextCache &&
      Date.now() - schemaContextCache.at < SCHEMA_CACHE_TTL_MS
    ) {
      schemaContext = schemaContextCache.contexts;
      await emit({ step: "exploring", message: "Схема уже в памяти процесса" });
    } else {
      await emit({ step: "exploring", message: "Читаю кэш схемы из scratch" });
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
      schemaContextCache = { contexts: schemaContext, at: Date.now() };
    }

    // -- мгновенный срез (параллельно с LLM) --------------------------------
    // Только для свежих вопросов: у кликов «почему?» дриллы уже были на экране.
    const questionRepo = input.context
      ? undefined
      : input.question.match(/[\w.-]+\/[\w.-]+/)?.[0];
    const previewPromise: Promise<ViewSpec | undefined> =
      questionRepo && REPO_NAME_RE.test(questionRepo)
        ? runInstantPreview(ro, questionRepo, emit)
        : Promise.resolve(undefined);

    // -- generating_sql → planning ------------------------------------------
    await emit({
      step: "generating_sql",
      message: `Планирую карточки по таблице ${schemaContext[0].table}`,
    });
    const plan = normalizePlan(
      await (options.generateSqlImpl ?? generateSql)({
        question: input.question,
        schemaContext,
        clickContext: input.context,
      }),
    );

    const previewSpec = await previewPromise;
    // Дедуп: план часто повторяет мгновенный срез (stars-by-day того же репо).
    const cards = plan.cards.filter(
      (c) =>
        !(
          previewSpec &&
          c.tool === "drill" &&
          c.drillId === "stars-by-day" &&
          String(c.params.repo ?? c.params.series ?? "") === questionRepo
        ),
    );

    await emit({
      step: "planning",
      cards: cards.map((c) => ({ title: cardTitle(c), source: cardSource(c) })),
      message:
        cards.length === 0
          ? "План совпал с мгновенным срезом — он уже на экране"
          : cards.length === 1
            ? `Одна карточка: «${cardTitle(cards[0])}»`
            : `Карточек: ${cards.length}, параллельно — ${cards
                .map((c) => `«${cardTitle(c)}»`)
                .join(", ")}`,
    });

    // -- параллельное исполнение карточек (шов cardRunner) -------------------
    // Дефолт — Promise.all в этом же процессе; Trigger-таска investigate
    // подставляет исполнитель на параллельных дочерних ранах.
    const runCards = options.cardRunner ?? runCardsInProcess;
    const outcomes = await runCards(cards, { ro, emit, input, schemaContext });

    const succeeded = outcomes.filter((o) => o.ok);
    const failed = outcomes.filter((o) => !o.ok);
    const attempts = outcomes.reduce((s, o) => s + o.attempts, 0);

    // -- error: ни одна карточка плана не удалась ----------------------------
    if (succeeded.length === 0 && cards.length > 0) {
      const message = failed.map((f) => f.error).join(" || ");
      errorEmitted = true;
      await emit({ step: "error", message });
      throw new Error(message);
    }

    // -- done ---------------------------------------------------------------
    const viewSpecs = [
      ...(previewSpec ? [previewSpec] : []),
      ...succeeded.map((o) => o.spec),
    ];
    const sql = succeeded
      .filter((o) => o.sql)
      .map((o) => o.sql as string)
      .join("\n\n");
    await emit({
      step: "done",
      viewSpecs,
      message:
        failed.length === 0
          ? `${viewSpecs.length} ${viewSpecs.length === 1 ? "карточка" : "карточек"} готово`
          : `${viewSpecs.length} из ${viewSpecs.length + failed.length} карточек готово; не удалось: ${failed
              .map((f) => truncate(f.error, 160))
              .join(" | ")}`,
    });
    return { viewSpecs, sql, attempts };
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
