"use client";

/**
 * Scatter — scatter plot {x, y, label?}: relationship between two variables visible at a glance.
 *
 * Readability (tool polish):
 *  - TREND LINE (OLS) + Pearson r coefficient with qualitative label directly
 *    on the card — immediately answers "is there a relationship?" without a separate verdict;
 *  - LOG SCALE on axes (xScale/yScale='log') for values spanning orders of magnitude:
 *    points arrive RAW, log is applied at render, ticks labeled with REAL
 *    values (50/500/5k), not log numbers — previously LLM log-transformed in SQL
 *    and the axis showed unreadable 1.7/3.0;
 *  - "how to read" instruction and semi-transparent points for density.
 *
 * Regression and r are computed in CHART COORDINATES (log space when axis is log),
 * so the line is straight on screen and r matches what's visible.
 *
 * Hand-written SVG in TimelineCard style: hairline grid, r=4 points with surface
 * ring, hover tooltip, hit target r=12. Point click → ClickContext.
 */
import { useId, useMemo, useState } from "react";
import type { AxisScale, ClickContext, ScatterSpec } from "@/lib/contracts";
import {
  buildClickContext,
  findClickTarget,
  scatterPointElementFields,
} from "./click";

const VB_W = 640;
const VB_H = 280;
const M = { top: 18, right: 16, bottom: 48, left: 56 };

/** Exact value in tooltip (thousands separator). */
const numFmt = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });

/** Compact tick label: 50, 500, 5k, 50k, 1.2M. */
function fmtCompact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${+(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${+(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  if (Number.isInteger(v)) return String(v);
  return String(+v.toFixed(2));
}

/** "Nice" axis step: 1/2/5 × 10^n. */
function niceStep(rough: number): number {
  const pow = 10 ** Math.floor(Math.log10(Math.max(rough, 1e-9)));
  const unit = rough / pow;
  const factor = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10;
  return factor * pow;
}

type Axis = {
  /** value → viewBox coordinate (already with log transform). */
  pos: (v: number) => number;
  /** Ticks: position t (in axis space) + real value label. */
  ticks: { v: number; label: string }[];
  /** value → internal axis coordinate (log10 for log scale, otherwise v itself). */
  t: (v: number) => number;
  min: number;
  max: number;
};

/** Log scale only possible for strictly positive values. */
function effectiveScale(scale: AxisScale | undefined, values: number[]): AxisScale {
  return scale === "log" && values.every((v) => v > 0) ? "log" : "linear";
}

/** Builds axis: domain, ticks (real labels) and transform functions. */
function buildAxis(
  values: number[],
  scale: AxisScale,
  pxMin: number,
  pxMax: number,
): Axis {
  if (scale === "log") {
    const logs = values.map((v) => Math.log10(v));
    const lo = Math.floor(Math.min(...logs));
    let hi = Math.ceil(Math.max(...logs));
    if (lo === hi) hi = lo + 1;
    const t = (v: number) => Math.log10(Math.max(v, 1e-9));
    const pos = (v: number) => pxMin + ((t(v) - lo) / (hi - lo)) * (pxMax - pxMin);
    // Ticks — powers of ten; in narrow range add 3×10^k.
    const decades = hi - lo;
    const ticks: { v: number; label: string }[] = [];
    for (let e = lo; e <= hi; e++) {
      const base = 10 ** e;
      ticks.push({ v: base, label: fmtCompact(base) });
      if (decades <= 2 && e < hi) {
        const mid = 3 * base;
        ticks.push({ v: mid, label: fmtCompact(mid) });
      }
    }
    return { pos, ticks, t, min: 10 ** lo, max: 10 ** hi };
  }

  // Linear scale.
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const step = niceStep((hi - lo) / 4);
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const t = (v: number) => v;
  const pos = (v: number) => pxMin + ((v - min) / (max - min)) * (pxMax - pxMin);
  const ticks: { v: number; label: string }[] = [];
  const n = Math.round((max - min) / step);
  for (let i = 0; i <= n; i++) {
    const v = min + step * i;
    ticks.push({ v, label: fmtCompact(v) });
  }
  return { pos, ticks, t, min, max };
}

type Trend = {
  /** Line in viewBox coordinates: (x1,y1)-(x2,y2). */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Pearson r in axis space (log if axis is logarithmic). */
  r: number;
} | null;

/** OLS regression and Pearson r in axis space (matches the picture). */
function computeTrend(
  points: { x: number; y: number }[],
  ax: Axis,
  ay: Axis,
): Trend {
  const pts = points.map((p) => ({ tx: ax.t(p.x), ty: ay.t(p.y) }));
  const n = pts.length;
  if (n < 3) return null;
  const mx = pts.reduce((s, p) => s + p.tx, 0) / n;
  const my = pts.reduce((s, p) => s + p.ty, 0) / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of pts) {
    sxx += (p.tx - mx) ** 2;
    syy += (p.ty - my) ** 2;
    sxy += (p.tx - mx) * (p.ty - my);
  }
  if (sxx < 1e-9 || syy < 1e-9) return null; // no variation along axis
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r = sxy / Math.sqrt(sxx * syy);
  // Line along visible domain edges (in t-space), then to pixels.
  const tMin = ax.t(ax.min);
  const tMax = ax.t(ax.max);
  const posY = (ty: number) =>
    ay.pos(ay.min) +
    ((ty - ay.t(ay.min)) / (ay.t(ay.max) - ay.t(ay.min))) *
      (ay.pos(ay.max) - ay.pos(ay.min));
  return {
    x1: ax.pos(ax.min),
    y1: posY(slope * tMin + intercept),
    x2: ax.pos(ax.max),
    y2: posY(slope * tMax + intercept),
    r,
  };
}

/** Qualitative label for strength and direction of correlation by |r|. */
function describeR(r: number): string {
  const a = Math.abs(r);
  const strength =
    a >= 0.7 ? "сильная" : a >= 0.4 ? "умеренная" : a >= 0.2 ? "слабая" : "почти нет";
  if (a < 0.2) return "связи почти нет";
  return `${strength} ${r > 0 ? "прямая" : "обратная"} связь`;
}

type Hover = { idx: number; cx: number; cy: number } | null;

export function ScatterCard({
  spec,
  cardId,
  onClickContext,
}: {
  spec: ScatterSpec;
  cardId: string;
  onClickContext?: (ctx: ClickContext) => void;
}) {
  const [hover, setHover] = useState<Hover>(null);
  const clipId = useId();
  const pointTarget = findClickTarget(spec.clicks, "point");
  const clickable = Boolean(pointTarget && onClickContext);

  const layout = useMemo(() => {
    if (spec.points.length === 0) return null;
    const xs = spec.points.map((p) => p.x);
    const ys = spec.points.map((p) => p.y);
    const xScale = effectiveScale(spec.xScale, xs);
    const yScale = effectiveScale(spec.yScale, ys);
    const ax = buildAxis(xs, xScale, M.left, VB_W - M.right);
    const ay = buildAxis(ys, yScale, VB_H - M.bottom, M.top);
    const trend = computeTrend(spec.points, ax, ay);
    return { ax, ay, xScale, yScale, trend };
  }, [spec.points, spec.xScale, spec.yScale]);

  if (!layout) {
    return (
      <p className="px-1 py-6 text-center text-sm text-muted">Нет точек для отображения</p>
    );
  }
  const { ax, ay, xScale, yScale, trend } = layout;

  const fire = (idx: number) => {
    if (!pointTarget || !onClickContext) return;
    onClickContext(
      buildClickContext({
        cardId,
        componentKind: "scatter",
        target: pointTarget,
        element: scatterPointElementFields(spec.points[idx]),
      }),
    );
  };

  const hovered = hover !== null ? spec.points[hover.idx] : null;
  const logNote =
    (xScale === "log" ? 1 : 0) + (yScale === "log" ? 1 : 0) > 0
      ? " · лог-шкала"
      : "";

  return (
    <div>
      {/* Correlation summary — main answer to "is there a dependency?" */}
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1">
        {trend ? (
          <span className="flex items-center gap-1.5 text-xs">
            <span
              aria-hidden
              className="inline-block h-0.5 w-4 rounded-full"
              style={{ background: "var(--viz-series-2)" }}
            />
            <span className="font-semibold" style={{ color: "var(--viz-series-2)" }}>
              r = {trend.r.toFixed(2)}
            </span>
            <span className="text-muted">· {describeR(trend.r)}</span>
          </span>
        ) : (
          <span className="text-xs text-muted">точек мало для линии тренда</span>
        )}
        <span className="text-[11px] text-muted/80">
          {spec.points.length} точек{logNote}
        </span>
      </div>

      <div className="relative">
        <svg
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          className="block w-full"
          role="img"
          aria-label={
            trend
              ? `${spec.title}. Корреляция r=${trend.r.toFixed(2)}, ${describeR(trend.r)}`
              : spec.title
          }
        >
          <defs>
            <clipPath id={clipId}>
              <rect
                x={M.left}
                y={M.top}
                width={VB_W - M.left - M.right}
                height={VB_H - M.top - M.bottom}
              />
            </clipPath>
          </defs>

          {/* Grid + Y labels (real values) */}
          {ay.ticks.map((tick, i) => (
            <g key={`y${i}`}>
              <line
                x1={M.left}
                x2={VB_W - M.right}
                y1={ay.pos(tick.v)}
                y2={ay.pos(tick.v)}
                stroke={i === 0 ? "var(--viz-axis)" : "var(--viz-grid)"}
                strokeWidth={1}
              />
              <text
                x={M.left - 8}
                y={ay.pos(tick.v) + 3.5}
                textAnchor="end"
                fontSize={10}
                fill="var(--muted)"
              >
                {tick.label}
              </text>
            </g>
          ))}

          {/* Grid + X labels (real values) */}
          {ax.ticks.map((tick, i) => (
            <g key={`x${i}`}>
              <line
                x1={ax.pos(tick.v)}
                x2={ax.pos(tick.v)}
                y1={M.top}
                y2={VB_H - M.bottom}
                stroke={i === 0 ? "var(--viz-axis)" : "var(--viz-grid)"}
                strokeWidth={1}
              />
              <text
                x={ax.pos(tick.v)}
                y={VB_H - M.bottom + 16}
                textAnchor="middle"
                fontSize={10}
                fill="var(--muted)"
              >
                {tick.label}
              </text>
            </g>
          ))}

          {/* Trend line (OLS) — over grid, under points */}
          {trend && (
            <line
              x1={trend.x1}
              y1={trend.y1}
              x2={trend.x2}
              y2={trend.y2}
              stroke="var(--viz-series-2)"
              strokeWidth={2}
              strokeDasharray="6 4"
              clipPath={`url(#${clipId})`}
            />
          )}

          {/* Points: visible r=4 with ring + hit target r=12 */}
          <g clipPath={`url(#${clipId})`}>
            {spec.points.map((p, i) => {
              const cx = ax.pos(p.x);
              const cy = ay.pos(p.y);
              const isHovered = hover?.idx === i;
              return (
                <g key={i}>
                  <circle
                    cx={cx}
                    cy={cy}
                    r={isHovered ? 5.5 : 4}
                    fill="var(--viz-series-1)"
                    fillOpacity={isHovered ? 1 : 0.55}
                    stroke="var(--surface)"
                    strokeWidth={1.5}
                    pointerEvents="none"
                  />
                  <circle
                    cx={cx}
                    cy={cy}
                    r={12}
                    fill="transparent"
                    className={clickable ? "cursor-pointer" : undefined}
                    role={clickable ? "button" : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    aria-label={
                      clickable
                        ? `${p.label ?? `${spec.xLabel} ${numFmt.format(p.x)}, ${spec.yLabel} ${numFmt.format(p.y)}`}${pointTarget?.label ? ` — ${pointTarget.label}` : ""}`
                        : undefined
                    }
                    onMouseEnter={() => setHover({ idx: i, cx, cy })}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover({ idx: i, cx, cy })}
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
          </g>

          {/* Axis labels */}
          <text
            x={M.left + (VB_W - M.left - M.right) / 2}
            y={VB_H - 6}
            textAnchor="middle"
            fontSize={10}
            fill="var(--muted)"
            opacity={0.8}
          >
            {spec.xLabel}
            {xScale === "log" ? " (лог)" : ""} →
          </text>
          <text
            x={13}
            y={M.top + (VB_H - M.top - M.bottom) / 2}
            textAnchor="middle"
            fontSize={10}
            fill="var(--muted)"
            opacity={0.8}
            transform={`rotate(-90 13 ${M.top + (VB_H - M.top - M.bottom) / 2})`}
          >
            {spec.yLabel}
            {yScale === "log" ? " (лог)" : ""} →
          </text>
        </svg>

        {/* Tooltip: entity — primary, real coordinates — secondary */}
        {hover && hovered && (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-background px-2.5 py-1.5 shadow-lg"
            style={{
              left: `${(hover.cx / VB_W) * 100}%`,
              top: `${(hover.cy / VB_H) * 100}%`,
              marginTop: "-10px",
            }}
          >
            {hovered.label && (
              <div className="text-sm font-semibold whitespace-nowrap">
                {hovered.label}
              </div>
            )}
            <div className="text-xs whitespace-nowrap text-muted">
              {spec.xLabel}: {numFmt.format(hovered.x)} · {spec.yLabel}:{" "}
              {numFmt.format(hovered.y)}
            </div>
            {clickable && pointTarget?.label && (
              <div className="mt-0.5 text-[10px] whitespace-nowrap text-accent">
                {pointTarget.label} →
              </div>
            )}
          </div>
        )}
      </div>

      {/* How to read */}
      <p className="mt-1 px-1 text-[10px] text-muted/80">
        каждая точка — одна сущность{spec.points[0]?.label ? " (наведите — имя и точные значения)" : ""};
        пунктир — линия тренда: наклон вверх ↗ = связь прямая, вниз ↘ = обратная,
        плоская = связи нет
      </p>
    </div>
  );
}
