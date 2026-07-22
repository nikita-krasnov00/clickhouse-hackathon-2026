/**
 * ViewSpec — what the agent returns and the UI renders. Core contracts (J1, frozen).
 *
 * Serialization rules:
 *  - everything is JSON-serializable: dates/times are strings (ISO 8601: '2024-03-02' or
 *    '2024-03-02T14:00:00Z'; any string understood by Date.parse is accepted);
 *  - all objects are strict (.strictObject): extra keys fail validation.
 *    Intentional: LLM output is validated by these schemas, and "almost correct"
 *    JSON must enter the self-healing loop, not silently render incorrectly.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Card kinds
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

/** Date/time string. ISO 8601 preferred; criterion is that Date.parse succeeds. */
export const dateTimeStringSchema = z
  .string()
  .min(1)
  .refine((s) => !Number.isNaN(Date.parse(s)), {
    message: "expected a parseable date/time string (ISO 8601)",
  });

// ---------------------------------------------------------------------------
// ClickTarget — clickability declaration, part of ViewSpec.
//
// ClickTarget describes WHAT in a card is clickable and HOW to build
// ClickContext.selection from a click. Schema:
//
//   { on, selectionKeys, label? }
//
//  - `on` — element class the target applies to:
//      'point'  → series point in timeline, scatter point, or map point
//      'row'    → leaderboard row
//      'bucket' → histogram bucket or funnel stage
//      'cell'   → heatmap cell
//      'tile'   → treemap tile
//      'box'    → boxplot box (group)
//
//  - `selectionKeys` — field names from the clicked element that the UI copies into
//    ClickContext.selection UNDER THE SAME NAMES. Available fields are fixed
//    per element kind:
//      point  → in timeline: 't', 'v', and 'series' (series name with the point);
//               in scatter: 'x', 'y', 'label' (label may be absent —
//               then the key is omitted); in map: 'lat', 'lon', 'value', 'label'
//      row    → any `key` from the card's columns (value taken from row[key];
//               null values are omitted from selection — key is skipped)
//      bucket → 'label', 'count' (in funnel — stage name and count on it)
//      cell   → 'x', 'y', 'value'
//      tile   → 'label', 'value', 'group' (group may be absent)
//      box    → 'label', 'med' (group median)
//
//  - `label` — action label for tooltip/menu ("Investigate this point").
//
// v2: no fast-path drillId — any click triggers a new agent run
// (action: 'why') with ClickContext as context. Dataset-specific
// drill catalog removed together with /api/drill.
//
// Why graph and verdict have no clicks: fixed in the PLAN.md sketch.
// This does not block graph interactivity: ClickContext does not reference
// ClickTarget, so NetworkGraph can hardcode a node click as
// action:'why' with selection { node: id } — the contract already allows this.
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
// Card data primitives
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
  /** Value key in Row and in click-target selectionKeys. */
  key: z.string(),
  /** Column header for rendering. */
  label: z.string(),
});
export type Column = z.infer<typeof columnSchema>;

/**
 * Leaderboard row: values keyed by column keys. null is allowed (SQL loves
 * null) — renders as "—", not copied into ClickContext.selection.
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
  /** Suspicion score 0..1 — agent uses it to cut top-N under maxNodes. */
  score: z.number().optional(),
  /** Relative node size for rendering. */
  size: z.number().optional(),
});
export type GraphNode = z.infer<typeof graphNodeSchema>;

export const graphEdgeSchema = z.strictObject({
  source: z.string(),
  target: z.string(),
  weight: z.number().optional(),
});
export type GraphEdge = z.infer<typeof graphEdgeSchema>;

/** Heatmap cell; x/y are values from xLabels/yLabels. Sparse matrix is allowed. */
export const heatmapCellSchema = z.strictObject({
  x: z.string(),
  y: z.string(),
  value: z.number(),
});
export type HeatmapCell = z.infer<typeof heatmapCellSchema>;

/** Scatter point: numeric coordinates + optional entity name. */
export const scatterPointSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  /** Entity name behind the point (account, repo) — goes to tooltip and selection. */
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
 * Map point: geographic coordinates (WGS84, degrees) + optional
 * magnitude (marker size/intensity) and entity name.
 */
export const mapPointSchema = z.strictObject({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  /** Point magnitude (aggregate: count, sum…) — encoded as size/brightness. */
  value: z.number().optional(),
  /** Entity name behind the point (district, city) — tooltip and selection. */
  label: z.string().optional(),
});
export type MapPoint = z.infer<typeof mapPointSchema>;

/** Treemap tile: part of a whole. Area ∝ value, so value must be strictly > 0. */
export const treemapItemSchema = z.strictObject({
  label: z.string(),
  value: z.number().positive(),
  /** Top-level group — categorical tile color and legend. */
  group: z.string().optional(),
});
export type TreemapItem = z.infer<typeof treemapItemSchema>;

/**
 * Boxplot group: five distribution quantiles of a metric within a group.
 * Whisker convention is p05/p95 (SQL contract in generate-sql.ts), but the contract
 * only requires monotonicity: lo ≤ q1 ≤ med ≤ q3 ≤ hi.
 */
export const boxplotGroupSchema = z
  .strictObject({
    label: z.string(),
    /** Lower whisker (usually p05). */
    lo: z.number(),
    q1: z.number(),
    med: z.number(),
    q3: z.number(),
    /** Upper whisker (usually p95). */
    hi: z.number(),
  })
  .refine((g) => g.lo <= g.q1 && g.q1 <= g.med && g.med <= g.q3 && g.q3 <= g.hi, {
    message: "quantiles must be monotonic: lo ≤ q1 ≤ med ≤ q3 ≤ hi",
  });
export type BoxplotGroup = z.infer<typeof boxplotGroupSchema>;

// ---------------------------------------------------------------------------
// ViewSpec variants
// ---------------------------------------------------------------------------

/**
 * Card annotation — written by a SEPARATE fast LLM call AFTER SQL execution,
 * from actual result rows (annotateCard, generate-sql.ts):
 *   - insight: analyst takeaway — 1–2 sentences with key numbers;
 *   - metricNote: what was computed (aggregation, filters, period, units).
 * Fields are optional on all chart kinds: annotator failure must not break the card.
 */
const cardAnnotationFields = {
  insight: z.string().optional(),
  metricNote: z.string().optional(),
};

export const timelineSpecSchema = z.strictObject({
  kind: z.literal("timeline"),
  title: z.string(),
  series: z.array(seriesSchema),
  /** [from, to] — shaded anomaly window. */
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
  /** Bucket axis label ("Account age"). */
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
  /** Hard node cap — render protection, see risks in PLAN.md. */
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
  /** The verdict itself — one or two sentences, investigation conclusion. */
  verdict: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
  evidence: z.array(statSchema),
});
export type VerdictSpec = z.infer<typeof verdictSpecSchema>;

export const bigNumberSpecSchema = z.strictObject({
  kind: z.literal("bignumber"),
  title: z.string(),
  /** The KPI value itself — number or pre-formatted string ("84%", "×70"). */
  value: z.union([z.string(), z.number()]),
  /** Metric label below the value. */
  label: z.string(),
  /** Percent change vs baseline: > 0 — growth (green), < 0 — decline (red). */
  delta: z.number().optional(),
  /** Secondary context caption ("vs median 87 per week"). */
  detail: z.string().optional(),
  ...cardAnnotationFields,
});
export type BigNumberSpec = z.infer<typeof bigNumberSpecSchema>;

/**
 * Scatter axis scale. 'log' — for magnitudes spanning orders of magnitude (stars,
 * commits): points are RAW, rendering applies log scaling and tick labels
 * (ticks show real values 50/500/5k, not log numbers). Default — 'linear'.
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
 * Map: geo points {lat, lon} with optional magnitude. Rendered as SVG with
 * CARTO tile basemap (Web Mercator): auto-fit to point bounding box,
 * interactive zoom/pan, clustering of nearby points; offline fallback —
 * degree grid. Dense raw SQL coordinates must be aggregated
 * (round + count), not millions of raw rows.
 */
export const mapSpecSchema = z.strictObject({
  kind: z.literal("map"),
  title: z.string(),
  points: z.array(mapPointSchema),
  /** Label for the value magnitude in the legend ("landings", "revenue"). */
  valueLabel: z.string().optional(),
  clicks: z.array(clickTargetSchema),
  ...cardAnnotationFields,
});
export type MapSpec = z.infer<typeof mapSpecSchema>;

/**
 * Treemap: parts of a whole. Tile area ∝ value; optional groups provide
 * categorical color and legend. Share of total among shown tiles is computed
 * by the renderer. Many small categories must be folded into "other" in SQL.
 */
export const treemapSpecSchema = z.strictObject({
  kind: z.literal("treemap"),
  title: z.string(),
  items: z.array(treemapItemSchema).min(1),
  /** Label for the value magnitude in tooltip/legend ("revenue", "questions"). */
  valueLabel: z.string().optional(),
  clicks: z.array(clickTargetSchema),
  ...cardAnnotationFields,
});
export type TreemapSpec = z.infer<typeof treemapSpecSchema>;

/**
 * Funnel: process stages in traversal order (wide → narrow). Bar width
 * ∝ count; stage-to-stage percentages are computed by the renderer.
 * Stage is the same Bucket {label, count}, clicks — on:'bucket'.
 */
export const funnelSpecSchema = z.strictObject({
  kind: z.literal("funnel"),
  title: z.string(),
  stages: z.array(bucketSchema).min(2),
  clicks: z.array(clickTargetSchema),
  ...cardAnnotationFields,
});
export type FunnelSpec = z.infer<typeof funnelSpecSchema>;

/** Boxplot: compare metric distributions across groups (5 quantiles per box). */
export const boxplotSpecSchema = z.strictObject({
  kind: z.literal("boxplot"),
  title: z.string(),
  /** Metric label on the numeric axis ("order total", "hours to reply"). */
  valueLabel: z.string().optional(),
  groups: z.array(boxplotGroupSchema).min(1),
  clicks: z.array(clickTargetSchema),
  ...cardAnnotationFields,
});
export type BoxplotSpec = z.infer<typeof boxplotSpecSchema>;

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

/**
 * Schema per kind keyed by kind — for targeted validation and render registry.
 * `satisfies Record<ViewKind, …>` guarantees: all kinds present, none missing.
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
