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
// РЕШЕНИЕ J1 (зафиксировано): ClickTarget описывает, ЧТО в карточке кликабельно
// и КАК из клика собрать ClickContext.selection. Схема:
//
//   { on, selectionKeys, drillId?, label? }
//
//  - `on` — класс элемента, к которому применяется цель:
//      'point'  → точка серии в timeline
//      'row'    → строка leaderboard
//      'bucket' → корзина histogram
//      'cell'   → ячейка heatmap
//
//  - `selectionKeys` — имена полей кликнутого элемента, которые UI копирует в
//    ClickContext.selection ПОД ТЕМИ ЖЕ ИМЕНАМИ. Доступные поля фиксированы
//    по виду элемента:
//      point  → 't', 'v', а также 'series' (имя серии, содержащей точку)
//      row    → любой `key` из columns карточки (значение берётся из row[key];
//               null-значения в selection не попадают — ключ опускается)
//      bucket → 'label', 'count'
//      cell   → 'x', 'y', 'value'
//
//  - `drillId` — если задан, у клика есть быстрый путь без LLM:
//    POST /api/drill { drillId, params: selection }. Каталог drill-запросов
//    (трек A, задача A4) объявляет параметры ровно под эти имена ключей.
//    Если drillId нет — клик может только запустить новый ран агента
//    (action: 'why') с ClickContext в качестве контекста.
//
//  - `label` — подпись действия для тултипа/меню («Кто ставил звёзды в этот день?»).
//
// Почему у graph и verdict нет clicks: так зафиксирован эскиз PLAN.md.
// Это не блокирует интерактивность графа: ClickContext не ссылается на
// ClickTarget, поэтому NetworkGraph может захардкодить клик по узлу как
// action:'why' с selection { node: id } — контракт это уже позволяет.
// ---------------------------------------------------------------------------

export const CLICK_TARGET_ELEMENTS = ["point", "row", "bucket", "cell"] as const;

export const clickTargetSchema = z.strictObject({
  on: z.enum(CLICK_TARGET_ELEMENTS),
  selectionKeys: z.array(z.string()).min(1),
  drillId: z.string().optional(),
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

export const statSchema = z.strictObject({
  label: z.string(),
  value: z.union([z.string(), z.number()]),
  detail: z.string().optional(),
});
export type Stat = z.infer<typeof statSchema>;

// ---------------------------------------------------------------------------
// Варианты ViewSpec
// ---------------------------------------------------------------------------

export const timelineSpecSchema = z.strictObject({
  kind: z.literal("timeline"),
  title: z.string(),
  series: z.array(seriesSchema),
  /** [от, до] — закрашиваемое окно аномалии. */
  anomalyWindow: z.tuple([dateTimeStringSchema, dateTimeStringSchema]).optional(),
  clicks: z.array(clickTargetSchema),
});
export type TimelineSpec = z.infer<typeof timelineSpecSchema>;

export const leaderboardSpecSchema = z.strictObject({
  kind: z.literal("leaderboard"),
  title: z.string(),
  columns: z.array(columnSchema),
  rows: z.array(rowSchema),
  clicks: z.array(clickTargetSchema),
});
export type LeaderboardSpec = z.infer<typeof leaderboardSpecSchema>;

export const histogramSpecSchema = z.strictObject({
  kind: z.literal("histogram"),
  title: z.string(),
  /** Подпись оси корзин («Возраст аккаунта»). */
  bucketLabel: z.string(),
  buckets: z.array(bucketSchema),
  clicks: z.array(clickTargetSchema),
});
export type HistogramSpec = z.infer<typeof histogramSpecSchema>;

export const graphSpecSchema = z.strictObject({
  kind: z.literal("graph"),
  title: z.string(),
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
  /** Жёсткий cap узлов — защита рендера, см. риски в PLAN.md. */
  maxNodes: z.number().int().positive(),
});
export type GraphSpec = z.infer<typeof graphSpecSchema>;

export const heatmapSpecSchema = z.strictObject({
  kind: z.literal("heatmap"),
  title: z.string(),
  xLabels: z.array(z.string()),
  yLabels: z.array(z.string()),
  cells: z.array(heatmapCellSchema),
  clicks: z.array(clickTargetSchema),
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

// ---------------------------------------------------------------------------
// Дискриминированное объединение
// ---------------------------------------------------------------------------

/**
 * Схема каждого вида по ключу — для точечной валидации и рендер-реестра.
 * `satisfies Record<ViewKind, …>` гарантирует: ровно шесть видов, без пропусков.
 */
export const viewSpecSchemaByKind = {
  timeline: timelineSpecSchema,
  leaderboard: leaderboardSpecSchema,
  histogram: histogramSpecSchema,
  graph: graphSpecSchema,
  heatmap: heatmapSpecSchema,
  verdict: verdictSpecSchema,
} as const satisfies Record<ViewKind, z.ZodType>;

export const viewSpecSchema = z.discriminatedUnion("kind", [
  timelineSpecSchema,
  leaderboardSpecSchema,
  histogramSpecSchema,
  graphSpecSchema,
  heatmapSpecSchema,
  verdictSpecSchema,
]);
export type ViewSpec = z.infer<typeof viewSpecSchema>;
