"use client";

/**
 * Histogram (C5) — vertical bucket bars {label, count}.
 *
 * Hand-written SVG in TimelineCard style: hairline grid, thin bars (≤24px)
 * with rounded top (4px) and square base on the baseline, direct labels only
 * at the extremum, hover tooltip, hit target — entire bucket band (wider than
 * visible bar). Bucket click → ClickContext strictly per ClickTarget on:'bucket'
 * semantics (selectionKeys from label/count).
 */
import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import type { ClickContext, HistogramSpec } from "@/lib/contracts";
import { useNumberFormat } from "@/lib/i18n/formats";
import { bucketElementFields, buildClickContext, findClickTarget } from "./click";

const VB_W = 640;
const VB_H = 260;
const M = { top: 22, right: 8, bottom: 48, left: 48 };
const BAR_W = 24; // bar thickness cap — "thin marks", air in the band
const CAP_R = 4; // rounded data end (top), square base

/** "Nice" value axis step: 1/2/5 × 10^n (like TimelineCard). */
function niceStep(rough: number): number {
  const pow = 10 ** Math.floor(Math.log10(Math.max(rough, 1e-9)));
  const unit = rough / pow;
  const factor = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10;
  return factor * pow;
}

/** Bar path: rounded top (r), square base. */
function barPath(x: number, yTop: number, w: number, yBase: number): string {
  const r = Math.min(CAP_R, Math.max(yBase - yTop, 0), w / 2);
  return [
    `M${x},${yBase}`,
    `L${x},${yTop + r}`,
    `Q${x},${yTop} ${x + r},${yTop}`,
    `L${x + w - r},${yTop}`,
    `Q${x + w},${yTop} ${x + w},${yTop + r}`,
    `L${x + w},${yBase}`,
    "Z",
  ].join(" ");
}

export function HistogramCard({
  spec,
  cardId,
  onClickContext,
}: {
  spec: HistogramSpec;
  cardId: string;
  onClickContext?: (ctx: ClickContext) => void;
}) {
  const tCards = useTranslations("cards");
  const numFmt = useNumberFormat();
  const [hover, setHover] = useState<number | null>(null);
  const bucketTarget = findClickTarget(spec.clicks, "bucket");
  const clickable = Boolean(bucketTarget && onClickContext);

  const layout = useMemo(() => {
    if (spec.buckets.length === 0) return null;
    const vMax = Math.max(...spec.buckets.map((b) => b.count), 1);
    const step = niceStep(vMax / 4);
    const yMax = Math.ceil(vMax / step) * step;

    const plotW = VB_W - M.left - M.right;
    const band = plotW / spec.buckets.length;
    const y = (v: number) =>
      VB_H - M.bottom - (v / yMax) * (VB_H - M.top - M.bottom);

    const yTicks: number[] = [];
    for (let v = 0; v <= yMax; v += step) yTicks.push(v);

    const maxIdx = spec.buckets.reduce(
      (best, b, i) => (b.count > spec.buckets[best].count ? i : best),
      0,
    );
    return { band, y, yTicks, maxIdx };
  }, [spec.buckets]);

  if (!layout) {
    return (
      <p className="px-1 py-6 text-center text-sm text-muted">{tCards("noData")}</p>
    );
  }
  const { band, y, yTicks, maxIdx } = layout;
  const yBase = VB_H - M.bottom;
  const barW = Math.min(BAR_W, band * 0.6);

  const fire = (i: number) => {
    if (!bucketTarget || !onClickContext) return;
    onClickContext(
      buildClickContext({
        cardId,
        componentKind: "histogram",
        target: bucketTarget,
        element: bucketElementFields(spec.buckets[i]),
      }),
    );
  };

  const hovered = hover !== null ? spec.buckets[hover] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        className="block w-full"
        role="img"
        aria-label={spec.title}
      >
        {/* Value grid — hairline, recessive */}
        {yTicks.map((v) => (
          <g key={v}>
            <line
              x1={M.left}
              x2={VB_W - M.right}
              y1={y(v)}
              y2={y(v)}
              stroke={v === 0 ? "var(--viz-axis)" : "var(--viz-grid)"}
              strokeWidth={1}
            />
            <text
              x={M.left - 8}
              y={y(v) + 3.5}
              textAnchor="end"
              fontSize={10}
              fill="var(--muted)"
            >
              {numFmt.format(v)}
            </text>
          </g>
        ))}

        {/* Bars + bucket labels + hit targets for entire band */}
        {spec.buckets.map((b, i) => {
          const cx = M.left + band * i + band / 2;
          const x0 = cx - barW / 2;
          const yTop = y(b.count);
          const isHovered = hover === i;
          return (
            <g key={b.label}>
              <path
                d={barPath(x0, yTop, barW, yBase)}
                fill="var(--viz-series-1)"
                fillOpacity={isHovered ? 1 : 0.85}
                pointerEvents="none"
              />
              {/* Direct label — only at extremum or on hover (selective) */}
              {(i === maxIdx || isHovered) && (
                <text
                  x={cx}
                  y={yTop - 6}
                  textAnchor="middle"
                  fontSize={10}
                  fontWeight={600}
                  fill="var(--foreground)"
                >
                  {numFmt.format(b.count)}
                </text>
              )}
              <text
                x={cx}
                y={yBase + 16}
                textAnchor="middle"
                fontSize={10}
                fill="var(--muted)"
              >
                {b.label}
              </text>
              {/* Hit target: entire bucket band, above visible bar */}
              <rect
                x={M.left + band * i}
                y={M.top}
                width={band}
                height={VB_H - M.top - M.bottom}
                fill="transparent"
                className={clickable ? "cursor-pointer" : undefined}
                role={clickable ? "button" : undefined}
                tabIndex={clickable ? 0 : undefined}
                aria-label={
                  clickable
                    ? `${b.label} · ${numFmt.format(b.count)}${bucketTarget?.label ? ` — ${bucketTarget.label}` : ""}`
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
            </g>
          );
        })}

        {/* Bucket axis label */}
        <text
          x={M.left + (VB_W - M.left - M.right) / 2}
          y={VB_H - 8}
          textAnchor="middle"
          fontSize={10}
          fill="var(--muted)"
          opacity={0.8}
        >
          {spec.bucketLabel}
        </text>
      </svg>

      {/* Tooltip: value — primary, label — secondary */}
      {hover !== null && hovered && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-background px-2.5 py-1.5 shadow-lg"
          style={{
            left: `${((M.left + band * hover + band / 2) / VB_W) * 100}%`,
            top: `${(y(hovered.count) / VB_H) * 100}%`,
            marginTop: "-10px",
          }}
        >
          <div className="text-sm font-semibold whitespace-nowrap">
            {numFmt.format(hovered.count)}
          </div>
          <div className="text-xs whitespace-nowrap text-muted">{hovered.label}</div>
          {clickable && bucketTarget?.label && (
            <div className="mt-0.5 text-[10px] whitespace-nowrap text-accent">
              {bucketTarget.label} →
            </div>
          )}
        </div>
      )}
    </div>
  );
}
