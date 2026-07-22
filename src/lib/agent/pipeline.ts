/**
 * Конвейер investigate v2 — dataset-agnostic, отвязан от Trigger-рантайма.
 *
 * Шаги (RunStep из контрактов, строгая валидация перед каждым эмитом):
 *   exploring      → фаза A: дешёвый каталог ВСЕХ видимых таблиц (explore.ts);
 *   generating_sql → триаж на быстрой модели (triage.ts): решение
 *                    proceed/clarify/impossible, выбор таблиц и карточек;
 *   clarify        → агенту нужно уточнение: вопрос+варианты уходят в UI,
 *                    ран завершается пустым done (ответ придёт новым /api/ask);
 *   impossible     → по данным ответить нельзя: причина + что данные МОГУТ;
 *   board_planned  → манифест карточек [{cardId, kind, title}] — UI рисует
 *                    СКЕЛЕТЫ дашборда сразу, до всякого SQL (быстрое превью);
 *   exploring      → фаза B: глубокая разведка ТОЛЬКО выбранных таблиц;
 *   card_ready /   → карточки исполняются ПАРАЛЛЕЛЬНО (шов cardRunner: дефолт
 *   card_failed      Promise.all в процессе, в Trigger-ране — дочерние раны
 *                    investigate-card); каждая карточка сама генерит свой SQL
 *                    (executing → healing до 3 попыток → card_ready|card_failed);
 *   done           → все успешные ViewSpec (проверены viewSpecSchema.parse);
 *   error          → терминальная неудача: НИ ОДНА карточка плана не удалась.
 *
 * Trigger-таска (src/trigger/investigate.ts) передаёт emit, пишущий шаги в
 * metadata рана (Realtime); смоук-скрипт печатает их в stdout. Логика одна.
 */
import type { ClickHouseClient } from "@clickhouse/client";
import { createReadonlyClient } from "@/lib/clickhouse";
import {
  detectAnswerLanguage,
  runStepSchema,
  viewSpecSchema,
  type AnswerLanguage,
  type AskRequest,
  type ClickTarget,
  type RunStep,
  type ViewSpec,
} from "@/lib/contracts";
import { exploreTables, getCatalog, type SchemaContext } from "./explore";
import {
  triageQuestion,
  type TriageCard,
  type TriageInput,
  type TriageResult,
} from "./triage";
import {
  annotateCard,
  generateCardSql,
  healSql,
  sanitizeSql,
  summarizeVerdict,
  type CardAnnotation,
  type GenerateCardSqlInput,
  type GeneratedSql,
  type VerdictSummary,
} from "./generate-sql";

export type StepEmitter = (step: RunStep) => void | Promise<void>;

export type PipelineOptions = {
  emit: StepEmitter;
  /** Инъекция клиента для тестов; по умолчанию создаётся и закрывается внутри. */
  readonlyClient?: ClickHouseClient;
  /** Тест-шов: подмена триажа (смоуки навязывают план без быстрой модели). */
  triageImpl?: (input: TriageInput) => Promise<TriageResult>;
  /**
   * Тест-шов: подмена per-card генерации SQL (heal-smoke подсовывает битый
   * SQL). Работает только для in-process исполнения карточек: в дочерние
   * Trigger-раны функцию не сериализовать.
   */
  cardSqlImpl?: (input: GenerateCardSqlInput) => Promise<GeneratedSql>;
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
  /** Финальные SQL успешных карточек (с заголовками-комментариями). */
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
 * Клик-цели generic: у любого клика один путь — новый ран агента (action
 * 'why') с ClickContext; подписи нейтральные, датасет-специфичных дриллов нет.
 * annotation (insight/metricNote) — от annotateCard по фактическим строкам;
 * добавляется всем видам-чартам (verdict — сам себе вывод).
 */
function buildViewSpec(
  generated: GeneratedSql,
  rows: ResultRow[],
  verdictSummary?: VerdictSummary,
  annotation?: CardAnnotation,
): unknown {
  if (rows.length === 0) {
    throw new Error("SQL вернул 0 строк — карточку не из чего собрать");
  }
  /** Опциональные поля аннотации — в форме, готовой к спреду в спек. */
  const note = annotation
    ? {
        insight: annotation.insight,
        ...(annotation.metricNote ? { metricNote: annotation.metricNote } : {}),
      }
    : {};
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
          label: "Разобраться с этим моментом",
        },
      ];
      return {
        kind: "timeline",
        title: generated.title,
        series: [...bySeries].map(([name, points]) => ({ name, points })),
        ...(generated.anomalyWindow ? { anomalyWindow: generated.anomalyWindow } : {}),
        clicks,
        ...note,
      };
    }
    case "leaderboard": {
      const keys = Object.keys(rows[0]);
      // Первая колонка — сущность (конвенция generate-sql.ts); клик по строке
      // уносит её значение контекстом в новый ран агента.
      const clicks: ClickTarget[] = [
        {
          on: "row",
          selectionKeys: [keys[0]],
          label: "Разобраться с этой строкой",
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
        ...note,
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
          label: "Что попало в эту корзину?",
        },
      ];
      return {
        kind: "histogram",
        title: generated.title,
        bucketLabel: generated.bucketLabel ?? generated.title,
        buckets,
        clicks,
        ...note,
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
          label: "Разобраться с этим слотом",
        },
      ];
      return {
        kind: "heatmap",
        title: generated.title,
        xLabels,
        yLabels,
        cells,
        clicks,
        ...note,
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
        ...note,
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
        ...(generated.xScale ? { xScale: generated.xScale } : {}),
        ...(generated.yScale ? { yScale: generated.yScale } : {}),
        clicks,
        ...note,
      };
    }
    case "map": {
      // Конвенция: `lat`/`lon` — градусы WGS84; опц. `value` (агрегат) и `label`.
      if (rows.length > 1000) {
        throw new Error(
          `map-SQL вернул ${rows.length} точек — агрегируй координаты (round + count) и поставь LIMIT 1000`,
        );
      }
      const points = rows.map((row) => {
        requireColumns(row, "map", ["lat", "lon"]);
        const lat = Number(row.lat);
        const lon = Number(row.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          throw new Error("map-SQL: колонки `lat` и `lon` обязаны быть числами (градусы)");
        }
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
          throw new Error(
            `map-SQL: координаты вне диапазона (lat=${lat}, lon=${lon}) — фильтруй мусорные значения в WHERE`,
          );
        }
        const value = row.value != null ? Number(row.value) : undefined;
        if (value !== undefined && !Number.isFinite(value)) {
          throw new Error("map-SQL: колонка `value` обязана быть числом (вес точки)");
        }
        return {
          lat,
          lon,
          ...(value !== undefined ? { value } : {}),
          ...(row.label != null && row.label !== "" ? { label: String(row.label) } : {}),
        };
      });
      const hasLabels = points.some((p) => "label" in p);
      const clicks: ClickTarget[] = [
        {
          on: "point",
          selectionKeys: hasLabels ? ["label", "lat", "lon"] : ["lat", "lon"],
          label: "Разобраться с этой точкой",
        },
      ];
      return {
        kind: "map",
        title: generated.title,
        points,
        ...(generated.valueLabel ? { valueLabel: generated.valueLabel } : {}),
        clicks,
        ...note,
      };
    }
    case "graph": {
      // Конвенция: пары `source`/`target` (+ опц. `weight`). Узлы, размеры и
      // скоры аномальности выводятся кодом из взвешенной степени узла.
      if (rows.length > 500) {
        throw new Error(
          `graph-SQL вернул ${rows.length} пар — агрегируй пары (GROUP BY + count() AS weight) и поставь LIMIT 200`,
        );
      }
      // Дедуп ненаправленных пар: weight суммируется, самопетли выбрасываются.
      const byPair = new Map<string, { source: string; target: string; weight: number }>();
      for (const row of rows) {
        requireColumns(row, "graph", ["source", "target"]);
        const source = String(row.source).trim();
        const target = String(row.target).trim();
        if (!source || !target) {
          throw new Error(
            "graph-SQL: `source` и `target` обязаны быть непустыми строками (имена сущностей)",
          );
        }
        if (source === target) continue;
        const weight = row.weight != null ? Number(row.weight) : 1;
        if (!Number.isFinite(weight) || weight < 0) {
          throw new Error("graph-SQL: колонка `weight` обязана быть числом ≥ 0 (сила связи)");
        }
        const [a, b] = source < target ? [source, target] : [target, source];
        const key = `${a}\u0000${b}`;
        const prev = byPair.get(key);
        if (prev) prev.weight += weight;
        else byPair.set(key, { source: a, target: b, weight });
      }
      const edges = [...byPair.values()];
      if (edges.length === 0) {
        throw new Error(
          "graph-SQL: после выброса самопетель не осталось ни одной пары — верни связи РАЗНЫХ сущностей",
        );
      }
      // Взвешенная степень узла → size (площадь) и score (цвет-«теплота»).
      const degree = new Map<string, number>();
      for (const e of edges) {
        degree.set(e.source, (degree.get(e.source) ?? 0) + e.weight);
        degree.set(e.target, (degree.get(e.target) ?? 0) + e.weight);
      }
      const maxDegree = Math.max(...degree.values(), 1);
      const nodes = [...degree.entries()].map(([id, deg]) => {
        const norm = deg / maxDegree;
        return {
          id,
          label: id,
          score: Math.round(norm * 100) / 100,
          size: 4 + Math.sqrt(norm) * 28,
        };
      });
      return {
        kind: "graph",
        title: generated.title,
        nodes,
        edges: edges.map((e) => ({ source: e.source, target: e.target, weight: e.weight })),
        maxNodes: 50,
        ...note,
      };
    }
    case "treemap": {
      // Конвенция: `label`, `value` (> 0), опц. `group`; хвост свёрнут в SQL.
      if (rows.length > 60) {
        throw new Error(
          `treemap-SQL вернул ${rows.length} строк — сверни хвост в «прочее» и поставь LIMIT 40`,
        );
      }
      const items = rows
        .map((row) => {
          requireColumns(row, "treemap", ["label", "value"]);
          const value = Number(row.value);
          if (!Number.isFinite(value)) {
            throw new Error("treemap-SQL: колонка `value` обязана быть числом (размер части)");
          }
          return {
            label: String(row.label),
            value,
            ...(row.group != null && row.group !== "" ? { group: String(row.group) } : {}),
          };
        })
        .filter((it) => it.value > 0);
      if (items.length === 0) {
        throw new Error(
          "treemap-SQL: все `value` ≤ 0 — площадь плитки строится только из положительных величин",
        );
      }
      const hasGroups = items.some((it) => "group" in it);
      const clicks: ClickTarget[] = [
        {
          on: "tile",
          selectionKeys: hasGroups ? ["label", "group"] : ["label"],
          label: "Разобраться с этой частью",
        },
      ];
      return {
        kind: "treemap",
        title: generated.title,
        items,
        ...(generated.valueLabel ? { valueLabel: generated.valueLabel } : {}),
        clicks,
        ...note,
      };
    }
    case "funnel": {
      // Конвенция: `label`, `count` в порядке этапов (широкий → узкий).
      if (rows.length < 2) {
        throw new Error("funnel-SQL обязан вернуть не меньше 2 этапов (строк)");
      }
      if (rows.length > 12) {
        throw new Error(
          `funnel-SQL вернул ${rows.length} этапов — воронка читаема до ~8, объедини шаги`,
        );
      }
      const stages = rows.map((row) => {
        requireColumns(row, "funnel", ["label", "count"]);
        const count = Number(row.count);
        if (!Number.isFinite(count) || count < 0) {
          throw new Error("funnel-SQL: колонка `count` обязана быть числом ≥ 0 (счётчик этапа)");
        }
        return { label: String(row.label), count: Math.round(count) };
      });
      const clicks: ClickTarget[] = [
        {
          on: "bucket",
          selectionKeys: ["label"],
          label: "Кто отвалился на этом этапе?",
        },
      ];
      return {
        kind: "funnel",
        title: generated.title,
        stages,
        clicks,
        ...note,
      };
    }
    case "boxplot": {
      // Конвенция: `label` + пять восходящих квантилей lo/q1/med/q3/hi на группу.
      if (rows.length > 30) {
        throw new Error(
          `boxplot-SQL вернул ${rows.length} групп — боксплот читаем до ~15, укрупни группы`,
        );
      }
      const groups = rows.map((row) => {
        requireColumns(row, "boxplot", ["label", "lo", "q1", "med", "q3", "hi"]);
        const nums = (["lo", "q1", "med", "q3", "hi"] as const).map((k) => Number(row[k]));
        if (nums.some((n) => !Number.isFinite(n))) {
          throw new Error(
            "boxplot-SQL: колонки `lo`, `q1`, `med`, `q3`, `hi` обязаны быть числами (квантили метрики)",
          );
        }
        const [lo, q1, med, q3, hi] = nums;
        if (!(lo <= q1 && q1 <= med && med <= q3 && q3 <= hi)) {
          throw new Error(
            "boxplot-SQL: квантили немонотонны (нужно lo ≤ q1 ≤ med ≤ q3 ≤ hi) — проверь порядок в quantiles(0.05, 0.25, 0.5, 0.75, 0.95)",
          );
        }
        return { label: String(row.label), lo, q1, med, q3, hi };
      });
      const clicks: ClickTarget[] = [
        {
          on: "box",
          selectionKeys: ["label"],
          label: "Разобраться с этой группой",
        },
      ];
      return {
        kind: "boxplot",
        title: generated.title,
        ...(generated.valueLabel ? { valueLabel: generated.valueLabel } : {}),
        groups,
        clicks,
        ...note,
      };
    }
    default: {
      // Компилятор гарантирует: все виды разобраны выше.
      const unreachable: never = generated.kind;
      throw new Error(`неизвестный вид карточки: ${String(unreachable)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Конвейер
// ---------------------------------------------------------------------------

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Двуязычный выбор строки прогресса по языку рана. Ризонинг обязан говорить на
 * языке ответа (тот же detectAnswerLanguage по тексту вопроса). Технические
 * поля шагов (cardId, sqlPreview, имена таблиц) не переводятся.
 */
function pickText(language: AnswerLanguage): (ru: string, en: string) => string {
  return (ru, en) => (language === "Russian" ? ru : en);
}

export function cardTitle(card: TriageCard): string {
  return card.title;
}

/** Подпись карточки в сообщениях шагов: в плане из >1 карточки — в «ёлочках». */
export function cardLabel(card: TriageCard, manyCards: boolean): string {
  return manyCards ? `«${card.title}»` : card.title;
}

export type CardOutcome =
  | { ok: true; spec: ViewSpec; sql?: string; attempts: number }
  | { ok: false; error: string; attempts: number };

/** Контекст исполнителя карточек. */
export type CardRunnerContext = {
  ro: ClickHouseClient;
  emit: StepEmitter;
  input: AskRequest;
  schemaContext: SchemaContext[];
  /** Тест-шов per-card генерации (только in-process). */
  cardSqlImpl?: (input: GenerateCardSqlInput) => Promise<GeneratedSql>;
};

/**
 * Исполнитель карточек плана (шов PipelineOptions.cardRunner): получает все
 * карточки разом и обязан вернуть исход КАЖДОЙ (падение одной карточки —
 * CardOutcome {ok:false}, не исключение).
 */
export type CardRunner = (
  cards: TriageCard[],
  ctx: CardRunnerContext,
) => Promise<CardOutcome[]>;

/**
 * Одна карточка: генерация SQL → executing → (healing → executing)* →
 * card_ready | card_failed. Никогда не бросает: любой исход — CardOutcome.
 * Общая точка входа default-раннера и дочерней Trigger-таски investigate-card.
 */
export async function runPlannedCard(
  card: TriageCard,
  ctx: CardRunnerContext & { label: string },
): Promise<CardOutcome> {
  const { ro, emit, input, schemaContext, label } = ctx;
  const t = pickText(detectAnswerLanguage(input.question));

  // SQL этой карточки пишется здесь же (на дочернем воркере) — карточки
  // одного плана генерятся и исполняются параллельно.
  await emit({
    step: "generating_sql",
    message: t(
      `${label} — пишу SQL под карточку ${card.kind}`,
      `${label} — writing SQL for the ${card.kind} card`,
    ),
  });
  let generated: GeneratedSql;
  try {
    generated = await (ctx.cardSqlImpl ?? generateCardSql)({
      question: input.question,
      schemaContext,
      clickContext: input.context,
      card: { kind: card.kind, title: card.title, ...(card.hint ? { hint: card.hint } : {}) },
    });
  } catch (err) {
    const error = t(
      `${label}: не удалось сгенерировать SQL — ${truncate(errorMessage(err))}`,
      `${label}: failed to generate SQL — ${truncate(errorMessage(err))}`,
    );
    await emit({ step: "card_failed", cardId: card.cardId, error, message: error });
    return { ok: false, error, attempts: 0 };
  }

  const attemptErrors: string[] = [];
  for (let attempt = 1; attempt <= MAX_SQL_ATTEMPTS; attempt++) {
    await emit({
      step: "executing",
      sqlPreview: generated.sql,
      message:
        attempt === 1
          ? label
          : t(
              `${label} — попытка ${attempt} из ${MAX_SQL_ATTEMPTS}`,
              `${label} — attempt ${attempt} of ${MAX_SQL_ATTEMPTS}`,
            ),
    });
    try {
      // Санитайз (только SELECT, один стейтмент) — страховка поверх agent_ro;
      // его ошибка тоже уходит в самопочинку.
      const sql = sanitizeSql(generated.sql);
      const rows = await executeSql(ro, sql);

      // Второй короткий LLM-вызов по фактическим цифрам (быстрый ярус):
      //   - verdict → вывод + уверенность (summarizeVerdict);
      //   - остальные виды → аннотация insight/metricNote (annotateCard) —
      //     «вывод и объяснение метрики» под каждым чартом.
      // Сбой не роняет карточку: verdict падает в title+low, чарт — без сноски.
      let verdictSummary: VerdictSummary | undefined;
      let annotation: CardAnnotation | undefined;
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
      } else {
        try {
          annotation = await annotateCard({
            question: input.question,
            card: { kind: generated.kind, title: generated.title },
            sql,
            rows,
          });
        } catch {
          annotation = undefined;
        }
      }

      const viewSpec = viewSpecSchema.parse(
        buildViewSpec(generated, rows, verdictSummary, annotation),
      );
      await emit({
        step: "card_ready",
        cardId: card.cardId,
        viewSpec,
        sql,
        message: t(
          `${label}: ${rows.length} строк → карточка ${viewSpec.kind}`,
          `${label}: ${rows.length} rows → ${viewSpec.kind} card`,
        ),
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
          message: t(
            `${label} — отдаю ошибку модели на починку`,
            `${label} — handing the error back to the model to fix`,
          ),
        });
        try {
          generated = await healSql({
            question: input.question,
            schemaContext,
            clickContext: input.context,
            card: { kind: card.kind, title: card.title, ...(card.hint ? { hint: card.hint } : {}) },
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
    .map((e, i) => t(`Попытка ${i + 1}: ${truncate(e)}`, `Attempt ${i + 1}: ${truncate(e)}`))
    .join(" | ");
  const error = t(
    `${label}: SQL не удался после ${MAX_SQL_ATTEMPTS} попыток. ${summary}`,
    `${label}: SQL failed after ${MAX_SQL_ATTEMPTS} attempts. ${summary}`,
  );
  await emit({ step: "card_failed", cardId: card.cardId, error: truncate(error, 600) });
  return { ok: false, error, attempts: MAX_SQL_ATTEMPTS };
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
  const ownsClients = !options.readonlyClient;
  const t = pickText(detectAnswerLanguage(input.question));
  let errorEmitted = false;

  try {
    // -- фаза A: каталог всех видимых таблиц (дёшево) -------------------------
    await emit({
      step: "exploring",
      message: t(
        "Смотрю каталог таблиц (system.tables/columns)",
        "Reading the table catalog (system.tables/columns)",
      ),
    });
    const catalog = await getCatalog(ro);

    // -- триаж на быстрой модели ---------------------------------------------
    await emit({
      step: "generating_sql",
      message: t(
        "Триаж: понимаю вопрос, выбираю таблицы и карточки",
        "Triage: understanding the question, picking tables and cards",
      ),
    });
    const triage = await (options.triageImpl ?? triageQuestion)({
      question: input.question,
      catalog,
      clickContext: input.context,
    });

    // -- clarify / impossible: честный ранний выход ---------------------------
    if (triage.decision === "clarify") {
      await emit({
        step: "clarify",
        question: triage.question,
        ...(triage.options ? { options: triage.options } : {}),
        message: t(
          `Нужно уточнение: ${triage.question}`,
          `Need a clarification: ${triage.question}`,
        ),
      });
      await emit({
        step: "done",
        viewSpecs: [],
        message: t(
          "Жду уточнения — задайте вопрос ещё раз с ответом",
          "Waiting for your clarification — ask again with the answer",
        ),
      });
      return { viewSpecs: [], sql: "", attempts: 0 };
    }
    if (triage.decision === "impossible") {
      await emit({
        step: "impossible",
        reason: triage.reason,
        ...(triage.available ? { available: triage.available } : {}),
        message: t(
          `По имеющимся данным ответить нельзя: ${truncate(triage.reason, 200)}`,
          `The available data can't answer this: ${truncate(triage.reason, 200)}`,
        ),
      });
      await emit({
        step: "done",
        viewSpecs: [],
        message: t(
          "Данных под вопрос нет — см. подсказки, о чём спросить",
          "No data for this question — see the hints on what to ask",
        ),
      });
      return { viewSpecs: [], sql: "", attempts: 0 };
    }

    // -- board_planned: скелеты дашборда на экран ещё до SQL ------------------
    const cards = triage.cards;
    await emit({
      step: "board_planned",
      cards: cards.map(({ cardId, kind, title }) => ({ cardId, kind, title })),
      message:
        cards.length === 1
          ? t(`Одна карточка: «${cards[0].title}»`, `One card: “${cards[0].title}”`)
          : t(
              `Карточек: ${cards.length} — ${cards.map((c) => `«${c.title}»`).join(", ")}`,
              `${cards.length} cards — ${cards.map((c) => `“${c.title}”`).join(", ")}`,
            ),
    });

    // -- фаза B: глубокая разведка только выбранных таблиц --------------------
    await emit({
      step: "exploring",
      message: t(
        `Глубокая разведка: ${triage.tables.join(", ")}`,
        `Deep exploration: ${triage.tables.join(", ")}`,
      ),
    });
    const schemaContext = await exploreTables(ro, triage.tables);

    // -- параллельное исполнение карточек (шов cardRunner) -------------------
    // Дефолт — Promise.all в этом же процессе; Trigger-таска investigate
    // подставляет исполнитель на параллельных дочерних ранах.
    const runCards = options.cardRunner ?? runCardsInProcess;
    const outcomes = await runCards(cards, {
      ro,
      emit,
      input,
      schemaContext,
      ...(options.cardSqlImpl ? { cardSqlImpl: options.cardSqlImpl } : {}),
    });

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
    const viewSpecs = succeeded.map((o) => o.spec);
    const sql = succeeded
      .filter((o) => o.sql)
      .map((o) => o.sql as string)
      .join("\n\n");
    await emit({
      step: "done",
      viewSpecs,
      message:
        failed.length === 0
          ? t(
              `${viewSpecs.length} ${viewSpecs.length === 1 ? "карточка" : "карточек"} готово`,
              `${viewSpecs.length} ${viewSpecs.length === 1 ? "card" : "cards"} ready`,
            )
          : t(
              `${viewSpecs.length} из ${viewSpecs.length + failed.length} карточек готово; не удалось: ${failed
                .map((f) => truncate(f.error, 160))
                .join(" | ")}`,
              `${viewSpecs.length} of ${viewSpecs.length + failed.length} cards ready; failed: ${failed
                .map((f) => truncate(f.error, 160))
                .join(" | ")}`,
            ),
    });
    return { viewSpecs, sql, attempts };
  } catch (err) {
    // Неожиданный сбой вне цикла исполнения (каталог/триаж/разведка/эмит) —
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
      await ro.close();
    }
  }
}
