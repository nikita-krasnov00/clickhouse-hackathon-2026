"use client";

/**
 * Treemap — parts of a whole: tiles with area ∝ value.
 *
 * Hand-written SVG without dependencies. Layout — squarified (Bruls et al.):
 * deterministic greedy algorithm keeps tiles close to square. Order — by
 * descending value (algorithm requirement), "other" goes in the corner.
 *
 * Color: with groups — categorical (series-1..4 by group, legend below chart;
 * tiles without group — neutral); without groups — single series-1 hue with
 * opacity gradient by rank (larger brighter). Labels — only in tiles where they
 * fit (label + share), rest revealed by hover tooltip. Tile click → ClickContext
 * per ClickTarget on:'tile' semantics.
 */
import { useMemo, useState } from "react";
import type { ClickContext, TreemapItem, TreemapSpec } from "@/lib/contracts";
import { buildClickContext, findClickTarget, tileElementFields } from "./click";

const VB_W = 640;
const VB_H = 300;
/** Text width estimate: ~6.2px per character at fontSize 11. */
const CHAR_W = 6.2;

const numFmt = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });

/** Compact label: 50, 500, 5k, 50k, 1.2M (like ScatterCard). */
function fmtCompact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${+(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${+(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  if (Number.isInteger(v)) return String(v);
  return String(+v.toFixed(2));
}

/** Share as percentage: < 1% → tenths, otherwise whole numbers. */
function fmtShare(share: number): string {
  const pct = share * 100;
  if (pct < 1) return `${+pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

type Rect = { x: number; y: number; w: number; h: number };

/**
 * Squarified treemap: values (descending, scaled so sum = rect area) →
 * rectangles. Row grows while worst aspect ratio in it improves, laid along
 * the short side.
 */
function squarify(values: number[], rect: Rect): Rect[] {
  const out: Rect[] = new Array(values.length);
  let { x, y, w, h } = rect;
  let i = 0;
  while (i < values.length) {
    const side = Math.min(w, h);
    let rowSum = 0;
    let rowMax = 0;
    let rowMin = Infinity;
    let worst = Infinity;
    let j = i;
    while (j < values.length) {
      const v = values[j];
      const sum = rowSum + v;
      const mx = Math.max(rowMax, v);
      const mn = Math.min(rowMin, v);
      const s2 = side * side;
      const cand = Math.max((s2 * mx) / (sum * sum), (sum * sum) / (s2 * mn));
      if (cand > worst) break;
      worst = cand;
      rowSum = sum;
      rowMax = mx;
      rowMin = mn;
      j++;
    }
    // Row thickness along long side; elements stacked along short side.
    const across = rowSum / Math.max(side, 1e-9);
    let offset = 0;
    for (let k = i; k < j; k++) {
      const len = values[k] / Math.max(across, 1e-9);
      out[k] =
        w >= h
          ? { x, y: y + offset, w: across, h: len }
          : { x: x + offset, y, w: len, h: across };
      offset += len;
    }
    if (w >= h) {
      x += across;
      w -= across;
    } else {
      y += across;
      h -= across;
    }
    i = j;
  }
  return out;
}

const GROUP_COLORS = [
  "var(--viz-series-1)",
  "var(--viz-series-2)",
  "var(--viz-series-3)",
  "var(--viz-series-4)",
];

type Tile = {
  item: TreemapItem;
  rect: Rect;
  share: number;
  fill: string;
  fillOpacity: number;
};

export function TreemapCard({
  spec,
  cardId,
  onClickContext,
}: {
  spec: TreemapSpec;
  cardId: string;
  onClickContext?: (ctx: ClickContext) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const tileTarget = findClickTarget(spec.clicks, "tile");
  const clickable = Boolean(tileTarget && onClickContext);

  const layout = useMemo(() => {
    if (spec.items.length === 0) return null;
    const sorted = [...spec.items].sort((a, b) => b.value - a.value);
    const total = sorted.reduce((s, it) => s + it.value, 0);
    const scaled = sorted.map((it) => (it.value / total) * VB_W * VB_H);
    const rects = squarify(scaled, { x: 0, y: 0, w: VB_W, h: VB_H });

    // Group color — by order of appearance in sorted tiles.
    const groupColor = new Map<string, string>();
    for (const it of sorted) {
      if (it.group !== undefined && !groupColor.has(it.group)) {
        groupColor.set(it.group, GROUP_COLORS[groupColor.size % GROUP_COLORS.length]);
      }
    }
    const hasGroups = groupColor.size > 0;

    const tiles: Tile[] = sorted.map((item, i) => ({
      item,
      rect: rects[i],
      share: item.value / total,
      fill: hasGroups
        ? item.group !== undefined
          ? groupColor.get(item.group)!
          : "var(--muted)"
        : "var(--viz-series-1)",
      // Without groups — single hue gradient by rank: larger brighter.
      fillOpacity: hasGroups
        ? 0.82
        : 0.88 - 0.5 * (sorted.length > 1 ? i / (sorted.length - 1) : 0),
    }));
    return { tiles, total, legend: [...groupColor.entries()] };
  }, [spec.items]);

  if (!layout) {
    return <p className="px-1 py-6 text-center text-sm text-muted">Нет данных</p>;
  }
  const { tiles, legend } = layout;

  const fire = (i: number) => {
    if (!tileTarget || !onClickContext) return;
    onClickContext(
      buildClickContext({
        cardId,
        componentKind: "treemap",
        target: tileTarget,
        element: tileElementFields(tiles[i].item),
      }),
    );
  };

  const hovered = hover !== null ? tiles[hover] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        className="block w-full"
        role="img"
        aria-label={spec.title}
      >
        {tiles.map((tile, i) => {
          const { x, y, w, h } = tile.rect;
          const isHovered = hover === i;
          const label = tile.item.label;
          // Labels only where they fit; rest — tooltip.
          const fitsLabel = w >= label.length * CHAR_W + 10 && h >= 18;
          const fitsShare = fitsLabel && h >= 34 && w >= 44;
          return (
            <g key={`${label}-${i}`}>
              <rect
                x={x}
                y={y}
                width={Math.max(w, 0.5)}
                height={Math.max(h, 0.5)}
                fill={tile.fill}
                fillOpacity={isHovered ? 1 : tile.fillOpacity}
                stroke="var(--surface)"
                strokeWidth={1.5}
                className={clickable ? "cursor-pointer" : undefined}
                role={clickable ? "button" : undefined}
                tabIndex={clickable ? 0 : undefined}
                aria-label={
                  clickable
                    ? `${label} · ${numFmt.format(tile.item.value)} (${fmtShare(tile.share)})${tileTarget?.label ? ` — ${tileTarget.label}` : ""}`
                    : undefined
                }
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                onClick={() => fire(i)}
                onKeyDown={(e) => {
                  if (clickable && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    fire(i);
                  }
                }}
              />
              {fitsLabel && (
                <text
                  x={x + 7}
                  y={y + 15}
                  fontSize={11}
                  fontWeight={600}
                  fill="var(--foreground)"
                  pointerEvents="none"
                >
                  {label}
                </text>
              )}
              {fitsShare && (
                <text
                  x={x + 7}
                  y={y + 29}
                  fontSize={10}
                  fill="var(--foreground)"
                  fillOpacity={0.75}
                  pointerEvents="none"
                >
                  {fmtShare(tile.share)} · {fmtCompact(tile.item.value)}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Group legend — only when groups exist */}
      {legend.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {legend.map(([group, color]) => (
            <span key={group} className="inline-flex items-center gap-1.5 text-[11px] text-muted">
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-[2px]"
                style={{ background: color }}
              />
              {group}
            </span>
          ))}
        </div>
      )}

      {/* Tooltip: value and share — primary; value label — secondary */}
      {hover !== null && hovered && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-background px-2.5 py-1.5 shadow-lg"
          style={{
            left: `${((hovered.rect.x + hovered.rect.w / 2) / VB_W) * 100}%`,
            top: `${(Math.max(hovered.rect.y, 14) / VB_H) * 100}%`,
            marginTop: "-8px",
          }}
        >
          <div className="text-sm font-semibold whitespace-nowrap">
            {hovered.item.label}
          </div>
          <div className="text-xs whitespace-nowrap text-muted">
            {numFmt.format(hovered.item.value)}
            {spec.valueLabel ? ` ${spec.valueLabel}` : ""} · {fmtShare(hovered.share)}
            {hovered.item.group ? ` · ${hovered.item.group}` : ""}
          </div>
          {clickable && tileTarget?.label && (
            <div className="mt-0.5 text-[10px] whitespace-nowrap text-accent">
              {tileTarget.label} →
            </div>
          )}
        </div>
      )}
    </div>
  );
}
