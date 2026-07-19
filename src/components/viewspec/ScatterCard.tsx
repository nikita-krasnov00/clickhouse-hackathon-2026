"use client";

/**
 * Scatter — диаграмма рассеяния {x, y, label?}: кластеры ботов видны глазом
 * (возраст аккаунта × число звёзд и т.п.).
 *
 * Рукописный SVG в стиле TimelineCard: hairline-сетка по обеим осям, точки
 * r=4 с 2px кольцом цвета поверхности, hover-тултип, увеличенный хит-таргет
 * (r=12 против видимых r=4). Клик по точке → ClickContext строго по семантике
 * ClickTarget on:'point' (selectionKeys из x/y/label).
 */
import { useMemo, useState } from "react";
import type { ClickContext, ScatterSpec } from "@/lib/contracts";
import {
  buildClickContext,
  findClickTarget,
  scatterPointElementFields,
} from "./click";

const VB_W = 640;
const VB_H = 280;
const M = { top: 18, right: 16, bottom: 46, left: 52 };

const numFmt = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });

/** «Красивый» шаг оси значений: 1/2/5 × 10^n (как в TimelineCard). */
function niceStep(rough: number): number {
  const pow = 10 ** Math.floor(Math.log10(Math.max(rough, 1e-9)));
  const unit = rough / pow;
  const factor = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10;
  return factor * pow;
}

/** Домен оси: [floor(min), ceil(max)] по красивому шагу; вырожденный — раздвигаем. */
function niceDomain(values: number[]): { min: number; max: number; ticks: number[] } {
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const step = niceStep((hi - lo) / 4);
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  // Шаг по индексу, не накоплением — иначе дробные шаги плывут по float.
  const n = Math.round((max - min) / step);
  for (let i = 0; i <= n; i++) ticks.push(min + step * i);
  return { min, max, ticks };
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
  const pointTarget = findClickTarget(spec.clicks, "point");
  const clickable = Boolean(pointTarget && onClickContext);

  const layout = useMemo(() => {
    if (spec.points.length === 0) return null;
    const dx = niceDomain(spec.points.map((p) => p.x));
    const dy = niceDomain(spec.points.map((p) => p.y));
    const x = (v: number) =>
      M.left + ((v - dx.min) / (dx.max - dx.min)) * (VB_W - M.left - M.right);
    const y = (v: number) =>
      VB_H - M.bottom - ((v - dy.min) / (dy.max - dy.min)) * (VB_H - M.top - M.bottom);
    return { x, y, xTicks: dx.ticks, yTicks: dy.ticks };
  }, [spec.points]);

  if (!layout) {
    return (
      <p className="px-1 py-6 text-center text-sm text-muted">Нет точек для отображения</p>
    );
  }
  const { x, y, xTicks, yTicks } = layout;

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

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        className="block w-full"
        role="img"
        aria-label={spec.title}
      >
        {/* Сетка значений по y — hairline, рецессивная */}
        {yTicks.map((v) => (
          <g key={`y${v}`}>
            <line
              x1={M.left}
              x2={VB_W - M.right}
              y1={y(v)}
              y2={y(v)}
              stroke={v === yTicks[0] ? "var(--viz-axis)" : "var(--viz-grid)"}
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

        {/* Сетка по x + подписи тиков */}
        {xTicks.map((v) => (
          <g key={`x${v}`}>
            <line
              x1={x(v)}
              x2={x(v)}
              y1={M.top}
              y2={VB_H - M.bottom}
              stroke={v === xTicks[0] ? "var(--viz-axis)" : "var(--viz-grid)"}
              strokeWidth={1}
            />
            <text
              x={x(v)}
              y={VB_H - M.bottom + 16}
              textAnchor="middle"
              fontSize={10}
              fill="var(--muted)"
            >
              {numFmt.format(v)}
            </text>
          </g>
        ))}

        {/* Точки: видимые r=4 с кольцом поверхности + хит-таргет r=12 */}
        {spec.points.map((p, i) => {
          const cx = x(p.x);
          const cy = y(p.y);
          const isHovered = hover?.idx === i;
          return (
            <g key={i}>
              <circle
                cx={cx}
                cy={cy}
                r={isHovered ? 5.5 : 4}
                fill="var(--viz-series-1)"
                fillOpacity={isHovered ? 1 : 0.75}
                stroke="var(--surface)"
                strokeWidth={2}
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
                    ? `${p.label ?? `${numFmt.format(p.x)}; ${numFmt.format(p.y)}`}${pointTarget?.label ? ` — ${pointTarget.label}` : ""}`
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

        {/* Подписи осей */}
        <text
          x={M.left + (VB_W - M.left - M.right) / 2}
          y={VB_H - 6}
          textAnchor="middle"
          fontSize={10}
          fill="var(--muted)"
          opacity={0.8}
        >
          {spec.xLabel}
        </text>
        <text
          x={12}
          y={M.top + (VB_H - M.top - M.bottom) / 2}
          textAnchor="middle"
          fontSize={10}
          fill="var(--muted)"
          opacity={0.8}
          transform={`rotate(-90 12 ${M.top + (VB_H - M.top - M.bottom) / 2})`}
        >
          {spec.yLabel}
        </text>
      </svg>

      {/* Тултип: сущность — главное, координаты — вторичные */}
      {hover && hovered && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-background px-2.5 py-1.5 shadow-lg"
          style={{
            left: `${(hover.cx / VB_W) * 100}%`,
            top: `${(hover.cy / VB_H) * 100}%`,
            marginTop: "-10px",
          }}
        >
          <div className="text-sm font-semibold whitespace-nowrap">
            {hovered.label ?? `${numFmt.format(hovered.x)}; ${numFmt.format(hovered.y)}`}
          </div>
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
  );
}
