/**
 * Сборка ClickContext из ClickTarget — строго по семантике контрактов
 * (см. src/lib/contracts/view-spec.ts, блок ClickTarget):
 *
 *  - selection = поля кликнутого элемента, перечисленные в target.selectionKeys,
 *    под теми же именами; null/undefined-значения опускаются;
 *  - action    = target.drillId есть → 'drill', нет → 'why'.
 *
 * Доступные поля элемента фиксированы по виду:
 *   point  → timeline: { t, v, series }; scatter: { x, y, label? }
 *   row    → ключи columns карточки (значения row[key])
 *   bucket → { label, count }
 *   cell   → { x, y, value }
 *
 * Чистая функция без React — используется всеми компонентами C4/C5 и
 * проверяется юнит-логикой.
 */
import type {
  Bucket,
  ClickContext,
  ClickTarget,
  HeatmapCell,
  Row,
  ScatterPoint,
  SeriesPoint,
  ViewKind,
} from "@/lib/contracts";

/** Плоские поля кликнутого элемента до фильтрации по selectionKeys. */
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
    action: target.drillId ? "drill" : "why",
  };
}

/** point → t, v, series (имя серии, содержащей точку). */
export function pointElementFields(
  point: SeriesPoint,
  seriesName: string,
): ClickableElementFields {
  return { t: point.t, v: point.v, series: seriesName };
}

/** row → любой key из columns; строка и так плоская запись по этим ключам. */
export function rowElementFields(row: Row): ClickableElementFields {
  return row;
}

/** point в scatter → x, y, label (label может отсутствовать — ключ опустится). */
export function scatterPointElementFields(
  point: ScatterPoint,
): ClickableElementFields {
  return { x: point.x, y: point.y, label: point.label };
}

/** bucket → label, count. */
export function bucketElementFields(bucket: Bucket): ClickableElementFields {
  return { label: bucket.label, count: bucket.count };
}

/** cell → x, y, value. */
export function cellElementFields(cell: HeatmapCell): ClickableElementFields {
  return { x: cell.x, y: cell.y, value: cell.value };
}

/** Первая клик-цель данного класса элементов, если объявлена в спеке. */
export function findClickTarget(
  clicks: ClickTarget[],
  on: ClickTarget["on"],
): ClickTarget | undefined {
  return clicks.find((c) => c.on === on);
}
