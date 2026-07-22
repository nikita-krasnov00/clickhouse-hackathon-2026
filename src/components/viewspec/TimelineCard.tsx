"use client";

/**
 * Timeline (C4) — time series lines, anomaly zone, clickable points,
 * time axis navigation.
 *
 * Hand-written SVG: 2px lines, points with 2px surface-colored ring,
 * hairline grid, semi-transparent anomalyWindow fill (critical status),
 * hover tooltip and enlarged point hit target (r=14 vs visible r=4).
 *
 * Zoom and pan:
 *   - mouse drag on chart — range selection → zoom into it;
 *   - trackpad pinch / Ctrl+wheel — zoom around cursor;
 *   - Shift+wheel or horizontal trackpad swipe — pan (when zoomed);
 *   - double-click or reset button — original scale.
 * Normal vertical scroll is NOT captured — the feed scrolls as usual.
 * Y axis is recomputed for visible points.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { ClickContext, TimelineSpec } from "@/lib/contracts";
import { useDateTimeFormat, useNumberFormat } from "@/lib/i18n/formats";
import { buildClickContext, findClickTarget, pointElementFields } from "./click";

const VB_W = 640;
const VB_H = 280;
const M = { top: 18, right: 16, bottom: 30, left: 48 };
const PLOT_W = VB_W - M.left - M.right;

/** Drag threshold (viewBox coords) after which click becomes brush. */
const BRUSH_THRESHOLD = 6;
/** Minimum zoom window — don't collapse range to a point. */
const MIN_SPAN_MS = 60_000;

const SERIES_COLORS = [
  "var(--viz-series-1)",
  "var(--viz-series-2)",
  "var(--viz-series-3)",
  "var(--viz-series-4)",
];

/**
 * Palette honestly distinguishes at most this many series (dataviz validator: 8 hues
 * on our surface already hit CVD floor). More series — usually a two-dimensional
 * pattern (hour × day), which belongs in heatmap, not timeline.
 */
const MAX_SERIES = SERIES_COLORS.length;

/**
 * Budget of VISIBLE point markers: while the window has no more — draw both points
 * and click targets; more (dozens-hundreds on a dense series) — lines only, otherwise
 * markers merge into a cloud and hide the lines. On zoom the window narrows,
 * fewer points — markers and clicks return automatically.
 */
const MARKER_BUDGET = 60;

/** "Nice" value axis step: 1/2/5 × 10^n. */
function niceStep(rough: number): number {
  const pow = 10 ** Math.floor(Math.log10(Math.max(rough, 1e-9)));
  const unit = rough / pow;
  const factor = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10;
  return factor * pow;
}

type Hover = {
  seriesIdx: number;
  pointIdx: number;
  cx: number;
  cy: number;
} | null;

type View = { min: number; max: number };

export function TimelineCard({
  spec,
  cardId,
  onClickContext,
}: {
  spec: TimelineSpec;
  cardId: string;
  onClickContext?: (ctx: ClickContext) => void;
}) {
  const t = useTranslations("timeline");
  const tCards = useTranslations("cards");
  const numFmt = useNumberFormat();
  const dayFmt = useDateTimeFormat({ day: "numeric", month: "short" });
  const timeFmt = useDateTimeFormat({
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const [hover, setHover] = useState<Hover>(null);
  /** Visible time window; null — full data range. */
  const [view, setView] = useState<View | null>(null);
  const [brush, setBrush] = useState<{ x0: number; x1: number } | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; brushing: boolean } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const clipId = useId();

  const pointTarget = findClickTarget(spec.clicks, "point");
  const clickable = Boolean(pointTarget && onClickContext);

  // No more series than palette: excess is NOT colored with repeating colors
  // (that would mislead — 03–06 and 18–21 same color), show largest by volume,
  // honestly noting how many are hidden.
  const { series, hiddenSeries } = useMemo(() => {
    if (spec.series.length <= MAX_SERIES) {
      return { series: spec.series, hiddenSeries: 0 };
    }
    const total = (s: TimelineSpec["series"][number]) =>
      s.points.reduce((acc, p) => acc + p.v, 0);
    const byVolume = [...spec.series].sort((a, b) => total(b) - total(a));
    return {
      series: byVolume.slice(0, MAX_SERIES),
      hiddenSeries: spec.series.length - MAX_SERIES,
    };
  }, [spec.series]);

  // Full data range — zoom and pan bounds computed from it.
  const domain = useMemo(() => {
    const all = series.flatMap((s) => s.points.map((p) => Date.parse(p.t)));
    if (all.length === 0) return null;
    let min = Math.min(...all);
    let max = Math.max(...all);
    if (min === max) {
      min -= 12 * 3600_000;
      max += 12 * 3600_000;
    }
    return { min, max };
  }, [series]);

  const layout = useMemo(() => {
    if (!domain) return null;
    const tMin = view?.min ?? domain.min;
    const tMax = view?.max ?? domain.max;

    const parsed = series.map((s) =>
      s.points.map((p) => ({ ...p, ts: Date.parse(p.t) })),
    );
    // Y axis — for visible points (chart "breathes" vertically on zoom).
    const visible = parsed.flat().filter((p) => p.ts >= tMin && p.ts <= tMax);
    const forScale = visible.length > 0 ? visible : parsed.flat();
    const vMax = Math.max(...forScale.map((p) => p.v), 1);
    const step = niceStep(vMax / 4);
    const yMax = Math.ceil(vMax / step) * step;

    const x = (ts: number) => M.left + ((ts - tMin) / (tMax - tMin)) * PLOT_W;
    const y = (v: number) =>
      VB_H - M.bottom - (v / yMax) * (VB_H - M.top - M.bottom);
    /** Inverse transform: viewBox coordinate → timestamp. */
    const tAt = (vx: number) => tMin + ((vx - M.left) / PLOT_W) * (tMax - tMin);

    const yTicks: number[] = [];
    for (let v = 0; v <= yMax; v += step) yTicks.push(v);

    const xTickCount = 5;
    const xTicks = Array.from({ length: xTickCount }, (_, i) =>
      tMin + ((tMax - tMin) * i) / (xTickCount - 1),
    );
    const spanDays = (tMax - tMin) / 86_400_000;
    const fmtT = (ts: number) =>
      spanDays < 3 ? timeFmt.format(ts) : dayFmt.format(ts);

    // Visible window density decides whether to draw point markers (see MARKER_BUDGET).
    const showMarkers = visible.length <= MARKER_BUDGET;

    return { tMin, tMax, yMax, parsed, x, y, tAt, yTicks, xTicks, fmtT, showMarkers };
  }, [series, domain, view, dayFmt, timeFmt]);

  // ---- zoom/pan -------------------------------------------------------

  /** Sets window clamped to full range; matches full range — reset. */
  const applyView = (min: number, max: number) => {
    if (!domain) return;
    const span = Math.max(max - min, MIN_SPAN_MS);
    let lo = min;
    let hi = lo + span;
    if (lo < domain.min) {
      lo = domain.min;
      hi = Math.min(lo + span, domain.max);
    }
    if (hi > domain.max) {
      hi = domain.max;
      lo = Math.max(hi - span, domain.min);
    }
    if (lo <= domain.min && hi >= domain.max) setView(null);
    else setView({ min: lo, max: hi });
  };

  /** Mouse event coordinate → viewBox X coordinate. */
  const vbX = (clientX: number): number => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return ((clientX - rect.left) / rect.width) * VB_W;
  };

  // Wheel: pinch/Ctrl — zoom around cursor; Shift or horizontal swipe —
  // pan. Normal vertical scroll goes to the page. Native listener
  // with passive:false — React attaches wheel passively, preventDefault wouldn't work.
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  const handleWheel = (e: WheelEvent) => {
    if (!layout || !domain) return;
    const { tMin, tMax, tAt } = layout;
    const span = tMax - tMin;
    const zooming = e.ctrlKey || e.metaKey;
    // Pan: Shift+wheel or horizontal trackpad swipe.
    let panDelta = 0;
    if (!zooming) {
      if (e.shiftKey) panDelta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) panDelta = e.deltaX;
    }

    if (zooming) {
      e.preventDefault();
      const factor = Math.exp(e.deltaY * 0.002); // deltaY<0 (pinch-out) — zoom in
      const anchor = Math.min(Math.max(tAt(vbX(e.clientX)), tMin), tMax);
      const newSpan = Math.min(Math.max(span * factor, MIN_SPAN_MS), domain.max - domain.min);
      const ratio = (anchor - tMin) / span;
      applyView(anchor - newSpan * ratio, anchor + newSpan * (1 - ratio));
    } else if (panDelta !== 0 && view) {
      e.preventDefault();
      // Cursor pixels → time: fraction of plot CSS width.
      const rect = svgRef.current?.getBoundingClientRect();
      const plotCssW = (rect?.width ?? VB_W) * (PLOT_W / VB_W);
      const shift = (panDelta / plotCssW) * span;
      applyView(tMin + shift, tMax + shift);
    }
  };

  useEffect(() => {
    wheelRef.current = handleWheel;
  });

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => wheelRef.current(e);
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  // Drag: below threshold — normal point click; after — brush selection.
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || !layout) return;
    dragRef.current = { pointerId: e.pointerId, startX: vbX(e.clientX), brushing: false };
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const x = vbX(e.clientX);
    if (!drag.brushing && Math.abs(x - drag.startX) > BRUSH_THRESHOLD) {
      drag.brushing = true;
      // Pointer capture only when brush starts — otherwise point clicks break.
      svgRef.current?.setPointerCapture(drag.pointerId);
      setHover(null);
    }
    if (drag.brushing) setBrush({ x0: drag.startX, x1: x });
  };

  const endBrush = (e: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    if (drag.brushing && brush && layout) {
      const [lo, hi] = [Math.min(brush.x0, brush.x1), Math.max(brush.x0, brush.x1)];
      applyView(layout.tAt(lo), layout.tAt(hi));
    }
    setBrush(null);
  };

  if (!layout || !domain) {
    return (
      <p className="px-1 py-6 text-center text-sm text-muted">
        {tCards("noPoints")}
      </p>
    );
  }
  const { tMin, tMax, parsed, x, y, yTicks, xTicks, fmtT, showMarkers } = layout;
  const zoomed = view !== null;

  const anomaly = spec.anomalyWindow
    ? (() => {
        const a0 = Date.parse(spec.anomalyWindow[0]);
        const a1 = Date.parse(spec.anomalyWindow[1]);
        if (a1 < tMin || a0 > tMax) return null; // window entirely outside zoom
        return {
          x0: Math.max(x(a0), M.left),
          x1: Math.min(x(a1), VB_W - M.right),
        };
      })()
    : null;

  const fire = (seriesIdx: number, pointIdx: number) => {
    if (!pointTarget || !onClickContext) return;
    const s = series[seriesIdx];
    onClickContext(
      buildClickContext({
        cardId,
        componentKind: "timeline",
        target: pointTarget,
        element: pointElementFields(s.points[pointIdx], s.name),
      }),
    );
  };

  const hoveredPoint =
    hover !== null
      ? series[hover.seriesIdx]?.points[hover.pointIdx]
      : null;

  return (
    <div>
      {/* Legend — only with ≥2 series (single series named by title). */}
      {series.length >= 2 && (
        <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 px-1">
          {series.map((s, i) => (
            <span key={s.name} className="flex items-center gap-1.5 text-xs text-muted">
              <span
                aria-hidden
                className="inline-block h-0.5 w-4 rounded-full"
                style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }}
              />
              {s.name}
            </span>
          ))}
        </div>
      )}

      <div className="relative">
        {zoomed && (
          <button
            type="button"
            onClick={() => setView(null)}
            className="absolute top-0 right-0 z-10 rounded-full border border-border bg-background/90 px-2 py-0.5 font-mono text-[10px] text-muted transition-colors hover:border-accent/60 hover:text-foreground"
          >
            {fmtT(tMin)} — {fmtT(tMax)} · {t("reset")} ✕
          </button>
        )}
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          className="block w-full select-none"
          style={{ touchAction: "pan-y", cursor: brush ? "col-resize" : "crosshair" }}
          role="img"
          aria-label={spec.title}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endBrush}
          onPointerCancel={endBrush}
          onDoubleClick={() => setView(null)}
        >
          <defs>
            {/* Plot area clip: on zoom lines don't spill past axes. */}
            <clipPath id={clipId}>
              <rect
                x={M.left}
                y={M.top - 6}
                width={PLOT_W}
                height={VB_H - M.top - M.bottom + 6}
              />
            </clipPath>
          </defs>

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

          {/* Anomaly zone — semi-transparent range highlight */}
          {anomaly && (
            <g>
              <rect
                x={anomaly.x0}
                y={M.top}
                width={Math.max(anomaly.x1 - anomaly.x0, 2)}
                height={VB_H - M.top - M.bottom}
                fill="var(--viz-anomaly-fill)"
              />
              <line
                x1={anomaly.x0}
                x2={anomaly.x0}
                y1={M.top}
                y2={VB_H - M.bottom}
                stroke="var(--viz-anomaly-edge)"
                strokeWidth={1}
              />
              <line
                x1={anomaly.x1}
                x2={anomaly.x1}
                y1={M.top}
                y2={VB_H - M.bottom}
                stroke="var(--viz-anomaly-edge)"
                strokeWidth={1}
              />
              <text
                x={(anomaly.x0 + anomaly.x1) / 2}
                y={M.top - 5}
                textAnchor="middle"
                fontSize={10}
                fill="var(--viz-critical)"
              >
                {t("anomalyZone")}
              </text>
            </g>
          )}

          {/* Time axis */}
          {xTicks.map((ts, i) => (
            <text
              key={i}
              x={x(ts)}
              y={VB_H - M.bottom + 16}
              textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
              fontSize={10}
              fill="var(--muted)"
            >
              {fmtT(ts)}
            </text>
          ))}

          {/* Series lines: 2px, round joins; clipped to plot area */}
          <g clipPath={`url(#${clipId})`}>
            {parsed.map((points, si) => {
              const color = SERIES_COLORS[si % SERIES_COLORS.length];
              const d = points
                .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.ts)},${y(p.v)}`)
                .join(" ");
              return (
                <path
                  key={series[si].name}
                  d={d}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              );
            })}
          </g>

          {/* Points: visible r=4 with surface ring + hit target r=14.
              Only points in visible window and only when not too many
              (showMarkers) — otherwise dense series becomes a cloud hiding
              lines; on zoom window narrows and points/clicks return. */}
          {showMarkers &&
            parsed.map((points, si) => {
            const color = SERIES_COLORS[si % SERIES_COLORS.length];
            const s = series[si];
            return points.map((p, pi) => {
              if (p.ts < tMin || p.ts > tMax) return null;
              const cx = x(p.ts);
              const cy = y(p.v);
              const isHovered =
                hover?.seriesIdx === si && hover?.pointIdx === pi;
              return (
                <g key={`${s.name}-${p.t}`}>
                  <circle
                    cx={cx}
                    cy={cy}
                    r={isHovered ? 5.5 : 4}
                    fill={color}
                    stroke="var(--surface)"
                    strokeWidth={2}
                    pointerEvents="none"
                  />
                  <circle
                    cx={cx}
                    cy={cy}
                    r={14}
                    fill="transparent"
                    className={clickable ? "cursor-pointer" : undefined}
                    role={clickable ? "button" : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    aria-label={
                      clickable
                        ? `${s.name} · ${p.t} · ${numFmt.format(p.v)}${pointTarget?.label ? ` — ${pointTarget.label}` : ""}`
                        : undefined
                    }
                    onMouseEnter={() =>
                      setHover({ seriesIdx: si, pointIdx: pi, cx, cy })
                    }
                    onMouseLeave={() => setHover(null)}
                    onFocus={() =>
                      setHover({ seriesIdx: si, pointIdx: pi, cx, cy })
                    }
                    onBlur={() => setHover(null)}
                    onClick={() => fire(si, pi)}
                    onKeyDown={(e) => {
                      if (clickable && (e.key === "Enter" || e.key === " ")) {
                        e.preventDefault();
                        fire(si, pi);
                      }
                    }}
                  />
                </g>
              );
            });
          })}

          {/* Brush selection for upcoming zoom range */}
          {brush && (
            <g pointerEvents="none">
              <rect
                x={Math.min(brush.x0, brush.x1)}
                y={M.top}
                width={Math.abs(brush.x1 - brush.x0)}
                height={VB_H - M.top - M.bottom}
                fill="var(--viz-anomaly-fill)"
                opacity={0.7}
              />
              <line
                x1={brush.x0}
                x2={brush.x0}
                y1={M.top}
                y2={VB_H - M.bottom}
                stroke="var(--accent)"
                strokeWidth={1}
              />
              <line
                x1={brush.x1}
                x2={brush.x1}
                y1={M.top}
                y2={VB_H - M.bottom}
                stroke="var(--accent)"
                strokeWidth={1}
              />
            </g>
          )}
        </svg>

        {/* Tooltip: value — primary, label — secondary */}
        {hover && hoveredPoint && !brush && (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-background px-2.5 py-1.5 shadow-lg"
            style={{
              left: `${(hover.cx / VB_W) * 100}%`,
              top: `${(hover.cy / VB_H) * 100}%`,
              marginTop: "-10px",
            }}
          >
            <div className="text-sm font-semibold whitespace-nowrap">
              {numFmt.format(hoveredPoint.v)}
            </div>
            <div className="flex items-center gap-1.5 text-xs whitespace-nowrap text-muted">
              <span
                aria-hidden
                className="inline-block h-0.5 w-3 rounded-full"
                style={{
                  background:
                    SERIES_COLORS[hover.seriesIdx % SERIES_COLORS.length],
                }}
              />
              {series[hover.seriesIdx].name} · {fmtT(Date.parse(hoveredPoint.t))}
            </div>
            {clickable && pointTarget?.label && (
              <div className="mt-0.5 text-[10px] whitespace-nowrap text-accent">
                {pointTarget.label} →
              </div>
            )}
          </div>
        )}
      </div>

      <p className="mt-1 px-1 text-[10px] text-muted/80">
        {hiddenSeries > 0 && (
          <span style={{ color: "var(--viz-warning)" }}>
            {t("hiddenSeries", {
              shown: MAX_SERIES,
              total: MAX_SERIES + hiddenSeries,
            })}
            {" · "}
          </span>
        )}
        {!showMarkers && `${t("markersHidden")} · `}
        {t("howTo")}
      </p>
    </div>
  );
}
