/**
 * ViewSpec — что агент отдаёт, а UI рендерит. Ядро контрактов (J1, заморожено).
 *
 * Правила сериализации:
 *  - всё JSON-сериализуемо: даты/время — строки (ISO 8601: '2024-03-02' или
 *    '2024-03-02T14:00:00Z'; принимается любая строка, которую понимает Date.parse);
 *  - все объекты строгие (.strictObject): лишние ключи — ошибка валидации.
 *    Это осознанно: выход LLM валидируется этими схемами, и «почти правильный»
 *    JSON должен падать в цикл самопочинки, а не тихо рендериться криво.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Виды карточек
// ---------------------------------------------------------------------------

export const VIEW_KINDS = [
  "timeline",
  "leaderboard",
  "histogram",
  "graph",
  "heatmap",
  "verdict",
  "bignumber",
  "scatter",
  "map",
  "treemap",
  "funnel",
  "boxplot",
] as const;

export const viewKindSchema = z.enum(VIEW_KINDS);
export type ViewKind = z.infer<typeof viewKindSchema>;

/** Строка даты/времени. ISO 8601 предпочтительно; критерий — парсится Date.parse. */
export const dateTimeStringSchema = z
  .string()
  .min(1)
  .refine((s) => !Number.isNaN(Date.parse(s)), {
    message: "ожидается парсабельная строка даты/времени (ISO 8601)",
  });

// ---------------------------------------------------------------------------
// ClickTarget — декларация кликабельности, часть ViewSpec.
//
// ClickTarget описывает, ЧТО в карточке кликабельно и КАК из клика собрать
// ClickContext.selection. Схема:
//
//   { on, selectionKeys, label? }
//
//  - `on` — класс элемента, к которому применяется цель:
//      'point'  → точка серии в timeline, точка scatter или точка map
//      'row'    → строка leaderboard
//      'bucket' → корзина histogram или этап funnel
//      'cell'   → ячейка heatmap
//      'tile'   → плитка treemap
//      'box'    → бокс (группа) boxplot
//
//  - `selectionKeys` — имена полей кликнутого элемента, которые UI копирует в
//    ClickContext.selection ПОД ТЕМИ ЖЕ ИМЕНАМИ. Доступные поля фиксированы
//    по виду элемента:
//      point  → в timeline: 't', 'v', а также 'series' (имя серии с точкой);
//               в scatter: 'x', 'y', 'label' (label может отсутствовать —
//               тогда ключ опускается); в map: 'lat', 'lon', 'value', 'label'
//      row    → любой `key` из columns карточки (значение берётся из row[key];
//               null-значения в selection не попадают — ключ опускается)
//      bucket → 'label', 'count' (в funnel — имя этапа и счётчик на нём)
//      cell   → 'x', 'y', 'value'
//      tile   → 'label', 'value', 'group' (group может отсутствовать)
//      box    → 'label', 'med' (медиана группы)
//
//  - `label` — подпись действия для тултипа/меню («Разобраться с этой точкой»).
//
// v2: быстрого пути drillId больше нет — любой клик уходит новым раном агента
// (action: 'why') с ClickContext в качестве контекста. Датасет-специфичный
// каталог дриллов удалён вместе с /api/drill.
//
// Почему у graph и verdict нет clicks: так зафиксирован эскиз PLAN.md.
// Это не блокирует интерактивность графа: ClickContext не ссылается на
// ClickTarget, поэтому NetworkGraph может захардкодить клик по узлу как
// action:'why' с selection { node: id } — контракт это уже позволяет.
// ---------------------------------------------------------------------------

export const CLICK_TARGET_ELEMENTS = [
  "point",
  "row",
  "bucket",
  "cell",
  "tile",
  "box",
] as const;

export const clickTargetSchema = z.strictObject({
  on: z.enum(CLICK_TARGET_ELEMENTS),
  selectionKeys: z.array(z.string()).min(1),
  label: z.string().optional(),
});
export type ClickTarget = z.infer<typeof clickTargetSchema>;

// ---------------------------------------------------------------------------
// Примитивы данных карточек
// ---------------------------------------------------------------------------

export const seriesPointSchema = z.strictObject({
  t: dateTimeStringSchema,
  v: z.number(),
});
export type SeriesPoint = z.infer<typeof seriesPointSchema>;

export const seriesSchema = z.strictObject({
  name: z.string(),
  points: z.array(seriesPointSchema),
});
export type Series = z.infer<typeof seriesSchema>;

export const columnSchema = z.strictObject({
  /** Ключ значения в Row и в selectionKeys клик-целей. */
  key: z.string(),
  /** Заголовок колонки для рендера. */
  label: z.string(),
});
export type Column = z.infer<typeof columnSchema>;

/**
 * Строка leaderboard: значения по ключам колонок. null допустим (SQL любит
 * null) — рендерится как «—», в ClickContext.selection не копируется.
 */
export const rowSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.null()]),
);
export type Row = z.infer<typeof rowSchema>;

export const bucketSchema = z.strictObject({
  label: z.string(),
  count: z.number().int().nonnegative(),
});
export type Bucket = z.infer<typeof bucketSchema>;

export const graphNodeSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  /** Скор подозрительности 0..1 — по нему агент режет top-N под maxNodes. */
  score: z.number().optional(),
  /** Относительный размер узла для рендера. */
  size: z.number().optional(),
});
export type GraphNode = z.infer<typeof graphNodeSchema>;

export const graphEdgeSchema = z.strictObject({
  source: z.string(),
  target: z.string(),
  weight: z.number().optional(),
});
export type GraphEdge = z.infer<typeof graphEdgeSchema>;

/** Ячейка heatmap; x/y — значения из xLabels/yLabels. Разреженная матрица допустима. */
export const heatmapCellSchema = z.strictObject({
  x: z.string(),
  y: z.string(),
  value: z.number(),
});
export type HeatmapCell = z.infer<typeof heatmapCellSchema>;

/** Точка scatter: числовые координаты + опциональное имя сущности. */
export const scatterPointSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  /** Имя сущности за точкой (аккаунт, репо) — уходит в тултип и selection. */
  label: z.string().optional(),
});
export type ScatterPoint = z.infer<typeof scatterPointSchema>;

export const statSchema = z.strictObject({
  label: z.string(),
  value: z.union([z.string(), z.number()]),
  detail: z.string().optional(),
});
export type Stat = z.infer<typeof statSchema>;

/**
 * Точка карты: географические координаты (WGS84, градусы) + опциональные
 * величина (размер/интенсивность маркера) и имя сущности.
 */
export const mapPointSchema = z.strictObject({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  /** Величина точки (агрегат: count, сумма…) — кодируется размером/яркостью. */
  value: z.number().optional(),
  /** Имя сущности за точкой (район, город) — тултип и selection. */
  label: z.string().optional(),
});
export type MapPoint = z.infer<typeof mapPointSchema>;

/** Плитка treemap: часть целого. Площадь ∝ value, поэтому value строго > 0. */
export const treemapItemSchema = z.strictObject({
  label: z.string(),
  value: z.number().positive(),
  /** Группа верхнего уровня — категориальный цвет плитки и легенда. */
  group: z.string().optional(),
});
export type TreemapItem = z.infer<typeof treemapItemSchema>;

/**
 * Группа boxplot: пять квантилей распределения метрики внутри группы.
 * Конвенция усов — p05/p95 (SQL-контракт generate-sql.ts), но контракт
 * требует только монотонность: lo ≤ q1 ≤ med ≤ q3 ≤ hi.
 */
export const boxplotGroupSchema = z
  .strictObject({
    label: z.string(),
    /** Нижний ус (обычно p05). */
    lo: z.number(),
    q1: z.number(),
    med: z.number(),
    q3: z.number(),
    /** Верхний ус (обычно p95). */
    hi: z.number(),
  })
  .refine((g) => g.lo <= g.q1 && g.q1 <= g.med && g.med <= g.q3 && g.q3 <= g.hi, {
    message: "квантили обязаны быть монотонны: lo ≤ q1 ≤ med ≤ q3 ≤ hi",
  });
export type BoxplotGroup = z.infer<typeof boxplotGroupSchema>;

// ---------------------------------------------------------------------------
// Варианты ViewSpec
// ---------------------------------------------------------------------------

/**
 * Аннотация карточки — пишется ОТДЕЛЬНЫМ быстрым LLM-вызовом ПОСЛЕ исполнения
 * SQL, по фактическим строкам результата (annotateCard, generate-sql.ts):
 *   - insight: вывод аналитика — 1–2 предложения с ключевыми цифрами;
 *   - metricNote: что именно посчитано (агрегация, фильтры, период, единицы).
 * Поля опциональны у всех видов-чартов: сбой аннотатора не роняет карточку.
 */
const cardAnnotationFields = {
  insight: z.string().optional(),
  metricNote: z.string().optional(),
};

export const timelineSpecSchema = z.strictObject({
  kind: z.literal("timeline"),
  title: z.string(),
  series: z.array(seriesSchema),
  /** [от, до] — закрашиваемое окно аномалии. */
  anomalyWindow: z.tuple([dateTimeStringSchema, dateTimeStringSchema]).optional(),
  clicks: z.array(clickTargetSchema),
  ...cardAnnotationFields,
});
export type TimelineSpec = z.infer<typeof timelineSpecSchema>;

export const leaderboardSpecSchema = z.strictObject({
  kind: z.literal("leaderboard"),
  title: z.string(),
  columns: z.array(columnSchema),
  rows: z.array(rowSchema),
  clicks: z.array(clickTargetSchema),
  ...cardAnnotationFields,
});
export type LeaderboardSpec = z.infer<typeof leaderboardSpecSchema>;

export const histogramSpecSchema = z.strictObject({
  kind: z.literal("histogram"),
  title: z.string(),
  /** Подпись оси корзин («Возраст аккаунта»). */
  bucketLabel: z.string(),
  buckets: z.array(bucketSchema),
  clicks: z.array(clickTargetSchema),
  ...cardAnnotationFields,
});
export type HistogramSpec = z.infer<typeof histogramSpecSchema>;

export const graphSpecSchema = z.strictObject({
  kind: z.literal("graph"),
  title: z.string(),
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
  /** Жёсткий cap узлов — защита рендера, см. риски в PLAN.md. */
  maxNodes: z.number().int().positive(),
  ...cardAnnotationFields,
});
export type GraphSpec = z.infer<typeof graphSpecSchema>;

export const heatmapSpecSchema = z.strictObject({
  kind: z.literal("heatmap"),
  title: z.string(),
  xLabels: z.array(z.string()),
  yLabels: z.array(z.string()),
  cells: z.array(heatmapCellSchema),
  clicks: z.array(clickTargetSchema),
  ...cardAnnotationFields,
});
export type HeatmapSpec = z.infer<typeof heatmapSpecSchema>;

export const verdictSpecSchema = z.strictObject({
  kind: z.literal("verdict"),
  /** Сам вердикт — одно-два предложения, вывод расследования. */
  verdict: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
  evidence: z.array(statSchema),
});
export type VerdictSpec = z.infer<typeof verdictSpecSchema>;

export const bigNumberSpecSchema = z.strictObject({
  kind: z.literal("bignumber"),
  title: z.string(),
  /** Само значение KPI — число или готовая строка («84%», «×70»). */
  value: z.union([z.string(), z.number()]),
  /** Подпись метрики под значением. */
  label: z.string(),
  /** Изменение в % к базе: > 0 — рост (зелёный), < 0 — падение (красный). */
  delta: z.number().optional(),
  /** Вторичная подпись-контекст («против медианы 87 в неделю»). */
  detail: z.string().optional(),
  ...cardAnnotationFields,
});
export type BigNumberSpec = z.infer<typeof bigNumberSpecSchema>;

/**
 * Шкала оси scatter. 'log' — для величин, разбросанных на порядки (звёзды,
 * коммиты): точки берутся СЫРЫМИ, логарифмирование и подписи делает рендер
 * (тики — реальные значения 50/500/5k, не log-числа). Дефолт — 'linear'.
 */
export const axisScaleSchema = z.enum(["linear", "log"]);
export type AxisScale = z.infer<typeof axisScaleSchema>;

export const scatterSpecSchema = z.strictObject({
  kind: z.literal("scatter"),
  title: z.string(),
  points: z.array(scatterPointSchema),
  xLabel: z.string(),
  yLabel: z.string(),
  xScale: axisScaleSchema.optional(),
  yScale: axisScaleSchema.optional(),
  clicks: z.array(clickTargetSchema),
  ...cardAnnotationFields,
});
export type ScatterSpec = z.infer<typeof scatterSpecSchema>;

/**
 * Карта: гео-точки {lat, lon} с опциональной величиной. Рендер — самописный
 * SVG без тайлов и внешних зависимостей: equirect-проекция, вьюпорт по
 * bounding box точек, градусная сетка. Плотные сырые координаты SQL обязан
 * агрегировать (round + count), не сливать миллионы строк.
 */
export const mapSpecSchema = z.strictObject({
  kind: z.literal("map"),
  title: z.string(),
  points: z.array(mapPointSchema),
  /** Подпись величины value для легенды («посадки», «выручка»). */
  valueLabel: z.string().optional(),
  clicks: z.array(clickTargetSchema),
  ...cardAnnotationFields,
});
export type MapSpec = z.infer<typeof mapSpecSchema>;

/**
 * Treemap: части целого. Площадь плитки ∝ value; опциональные группы дают
 * категориальный цвет и легенду. Долю от суммы показанных плиток считает
 * рендер. Много мелких категорий SQL обязан сворачивать в «прочее» сам.
 */
export const treemapSpecSchema = z.strictObject({
  kind: z.literal("treemap"),
  title: z.string(),
  items: z.array(treemapItemSchema).min(1),
  /** Подпись величины value для тултипа/легенды («выручка», «вопросы»). */
  valueLabel: z.string().optional(),
  clicks: z.array(clickTargetSchema),
  ...cardAnnotationFields,
});
export type TreemapSpec = z.infer<typeof treemapSpecSchema>;

/**
 * Funnel: этапы процесса в порядке прохождения (широкий → узкий). Ширина
 * полосы ∝ count; проценты переходов между этапами считает рендер.
 * Этап — тот же Bucket {label, count}, клики — on:'bucket'.
 */
export const funnelSpecSchema = z.strictObject({
  kind: z.literal("funnel"),
  title: z.string(),
  stages: z.array(bucketSchema).min(2),
  clicks: z.array(clickTargetSchema),
  ...cardAnnotationFields,
});
export type FunnelSpec = z.infer<typeof funnelSpecSchema>;

/** Boxplot: сравнение распределений метрики по группам (5 квантилей на бокс). */
export const boxplotSpecSchema = z.strictObject({
  kind: z.literal("boxplot"),
  title: z.string(),
  /** Подпись метрики на числовой оси («сумма чека», «часы до ответа»). */
  valueLabel: z.string().optional(),
  groups: z.array(boxplotGroupSchema).min(1),
  clicks: z.array(clickTargetSchema),
  ...cardAnnotationFields,
});
export type BoxplotSpec = z.infer<typeof boxplotSpecSchema>;

// ---------------------------------------------------------------------------
// Дискриминированное объединение
// ---------------------------------------------------------------------------

/**
 * Схема каждого вида по ключу — для точечной валидации и рендер-реестра.
 * `satisfies Record<ViewKind, …>` гарантирует: все виды на месте, без пропусков.
 */
export const viewSpecSchemaByKind = {
  timeline: timelineSpecSchema,
  leaderboard: leaderboardSpecSchema,
  histogram: histogramSpecSchema,
  graph: graphSpecSchema,
  heatmap: heatmapSpecSchema,
  verdict: verdictSpecSchema,
  bignumber: bigNumberSpecSchema,
  scatter: scatterSpecSchema,
  map: mapSpecSchema,
  treemap: treemapSpecSchema,
  funnel: funnelSpecSchema,
  boxplot: boxplotSpecSchema,
} as const satisfies Record<ViewKind, z.ZodType>;

export const viewSpecSchema = z.discriminatedUnion("kind", [
  timelineSpecSchema,
  leaderboardSpecSchema,
  histogramSpecSchema,
  graphSpecSchema,
  heatmapSpecSchema,
  verdictSpecSchema,
  bigNumberSpecSchema,
  scatterSpecSchema,
  mapSpecSchema,
  treemapSpecSchema,
  funnelSpecSchema,
  boxplotSpecSchema,
]);
export type ViewSpec = z.infer<typeof viewSpecSchema>;
