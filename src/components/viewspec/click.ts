/**
 * Build ClickContext from ClickTarget — strictly per contract semantics
 * (see src/lib/contracts/view-spec.ts, ClickTarget block):
 *
 *  - selection = fields of the clicked element listed in target.selectionKeys,
 *    under the same names; null/undefined values are omitted;
 *  - action    = always 'why' (v2: drills removed, click — new agent run).
 *
 * Available element fields are fixed per kind:
 *   point  → timeline: { t, v, series }; scatter: { x, y, label? };
 *            map: { lat, lon, value?, label? }
 *   row    → card column keys (values row[key])
 *   bucket → { label, count } (histogram and funnel stages)
 *   cell   → { x, y, value }
 *   tile   → { label, value, group? } (treemap)
 *   box    → { label, med } (boxplot group)
 *
 * Pure function without React — used by all C4/C5 components and covered by
 * unit logic tests.
 */
import type {
  BoxplotGroup,
  Bucket,
  ClickContext,
  ClickTarget,
  HeatmapCell,
  MapPoint,
  Row,
  ScatterPoint,
  SeriesPoint,
  TreemapItem,
  ViewKind,
} from "@/lib/contracts";

/** Flat fields of the clicked element before filtering by selectionKeys. */
export type ClickableElementFields = Record<
  string,
  string | number | null | undefined
>;

export function buildClickContext(args: {
  cardId: string;
  componentKind: ViewKind;
  target: ClickTarget;
  element: ClickableElementFields;
}): ClickContext {
  const { cardId, componentKind, target, element } = args;
  const selection: Record<string, string | number> = {};
  for (const key of target.selectionKeys) {
    const value = element[key];
    if (value !== null && value !== undefined) {
      selection[key] = value;
    }
  }
  return {
    cardId,
    componentKind,
    selection,
    action: "why",
  };
}

/** point → t, v, series (name of the series containing the point). */
export function pointElementFields(
  point: SeriesPoint,
  seriesName: string,
): ClickableElementFields {
  return { t: point.t, v: point.v, series: seriesName };
}

/** row → any key from columns; the row is already a flat record by those keys. */
export function rowElementFields(row: Row): ClickableElementFields {
  return row;
}

/** scatter point → x, y, label (label may be absent — key is omitted). */
export function scatterPointElementFields(
  point: ScatterPoint,
): ClickableElementFields {
  return { x: point.x, y: point.y, label: point.label };
}

/** map point → lat, lon, value, label (missing keys are omitted). */
export function mapPointElementFields(point: MapPoint): ClickableElementFields {
  return { lat: point.lat, lon: point.lon, value: point.value, label: point.label };
}

/** bucket → label, count. */
export function bucketElementFields(bucket: Bucket): ClickableElementFields {
  return { label: bucket.label, count: bucket.count };
}

/** cell → x, y, value. */
export function cellElementFields(cell: HeatmapCell): ClickableElementFields {
  return { x: cell.x, y: cell.y, value: cell.value };
}

/** tile → label, value, group (group may be absent — key is omitted). */
export function tileElementFields(item: TreemapItem): ClickableElementFields {
  return { label: item.label, value: item.value, group: item.group };
}

/** box → label, med (median — the most informative number for the group). */
export function boxElementFields(group: BoxplotGroup): ClickableElementFields {
  return { label: group.label, med: group.med };
}

/** First click target of the given element class, if declared in the spec. */
export function findClickTarget(
  clicks: ClickTarget[],
  on: ClickTarget["on"],
): ClickTarget | undefined {
  return clicks.find((c) => c.on === on);
}
