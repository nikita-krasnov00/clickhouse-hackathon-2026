"use client";

/**
 * Timeline (C4) — линии серий по времени, зона аномалии, кликабельные точки.
 *
 * Рукописный SVG: 2px линии, точки с 2px кольцом цвета поверхности,
 * hairline-сетка, полупрозрачная заливка anomalyWindow (статусный critical),
 * hover-тултип и увеличенный хит-таргет точки (r=14 против видимых r=4).
 */
import { useMemo, useState } from "react";
import type { ClickContext, TimelineSpec } from "@/lib/contracts";
import { buildClickContext, findClickTarget, pointElementFields } from "./click";

const VB_W = 640;
const VB_H = 280;
const M = { top: 18, right: 16, bottom: 30, left: 48 };

const SERIES_COLORS = [
  "var(--viz-series-1)",
  "var(--viz-series-2)",
  "var(--viz-series-3)",
  "var(--viz-series-4)",
];

const numFmt = new Intl.NumberFormat("ru-RU");
const dayFmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
const timeFmt = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** «Красивый» шаг оси значений: 1/2/5 × 10^n. */
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

export function TimelineCard({
  spec,
  cardId,
  onClickContext,
}: {
  spec: TimelineSpec;
  cardId: string;
  onClickContext?: (ctx: ClickContext) => void;
}) {
  const [hover, setHover] = useState<Hover>(null);
  const pointTarget = findClickTarget(spec.clicks, "point");
  const clickable = Boolean(pointTarget && onClickContext);

  const layout = useMemo(() => {
    const all = spec.series.flatMap((s) =>
      s.points.map((p) => ({ ...p, ts: Date.parse(p.t) })),
    );
    if (all.length === 0) return null;

    let tMin = Math.min(...all.map((p) => p.ts));
    let tMax = Math.max(...all.map((p) => p.ts));
    if (tMin === tMax) {
      tMin -= 12 * 3600_000;
      tMax += 12 * 3600_000;
    }
    const vMax = Math.max(...all.map((p) => p.v), 1);
    const step = niceStep(vMax / 4);
    const yMax = Math.ceil(vMax / step) * step;

    const x = (ts: number) =>
      M.left + ((ts - tMin) / (tMax - tMin)) * (VB_W - M.left - M.right);
    const y = (v: number) =>
      VB_H - M.bottom - (v / yMax) * (VB_H - M.top - M.bottom);

    const yTicks: number[] = [];
    for (let v = 0; v <= yMax; v += step) yTicks.push(v);

    const xTickCount = 5;
    const xTicks = Array.from({ length: xTickCount }, (_, i) =>
      tMin + ((tMax - tMin) * i) / (xTickCount - 1),
    );
    const spanDays = (tMax - tMin) / 86_400_000;
    const fmtT = (ts: number) =>
      spanDays < 3 ? timeFmt.format(ts) : dayFmt.format(ts);

    return { tMin, tMax, yMax, x, y, yTicks, xTicks, fmtT };
  }, [spec.series]);

  if (!layout) {
    return (
      <p className="px-1 py-6 text-center text-sm text-muted">
        Нет точек для отображения
      </p>
    );
  }
  const { x, y, yTicks, xTicks, fmtT } = layout;

  const anomaly = spec.anomalyWindow
    ? {
        x0: x(Date.parse(spec.anomalyWindow[0])),
        x1: x(Date.parse(spec.anomalyWindow[1])),
      }
    : null;

  const fire = (seriesIdx: number, pointIdx: number) => {
    if (!pointTarget || !onClickContext) return;
    const s = spec.series[seriesIdx];
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
      ? spec.series[hover.seriesIdx]?.points[hover.pointIdx]
      : null;

  return (
    <div>
      {/* Легенда — только при ≥2 сериях (одна серия названа заголовком). */}
      {spec.series.length >= 2 && (
        <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 px-1">
          {spec.series.map((s, i) => (
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
        <svg
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          className="block w-full"
          role="img"
          aria-label={spec.title}
        >
          {/* Сетка значений — hairline, рецессивная */}
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

          {/* Зона аномалии — полупрозрачная подсветка диапазона */}
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
                зона аномалии
              </text>
            </g>
          )}

          {/* Ось времени */}
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

          {/* Линии серий: 2px, круглые стыки */}
          {spec.series.map((s, si) => {
            const color = SERIES_COLORS[si % SERIES_COLORS.length];
            const d = s.points
              .map((p, i) => `${i === 0 ? "M" : "L"}${x(Date.parse(p.t))},${y(p.v)}`)
              .join(" ");
            return (
              <path
                key={s.name}
                d={d}
                fill="none"
                stroke={color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            );
          })}

          {/* Точки: видимые r=4 с кольцом поверхности + хит-таргет r=14 */}
          {spec.series.map((s, si) => {
            const color = SERIES_COLORS[si % SERIES_COLORS.length];
            return s.points.map((p, pi) => {
              const cx = x(Date.parse(p.t));
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
        </svg>

        {/* Тултип: значение — главное, подпись — вторичная */}
        {hover && hoveredPoint && (
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
              {spec.series[hover.seriesIdx].name} · {fmtT(Date.parse(hoveredPoint.t))}
            </div>
            {clickable && pointTarget?.label && (
              <div className="mt-0.5 text-[10px] whitespace-nowrap text-accent">
                {pointTarget.label} →
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
