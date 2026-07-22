"use client";

/**
 * Scatter — диаграмма рассеяния {x, y, label?}: связь двух величин видна глазом.
 *
 * Читаемость (доработка тула):
 *  - ЛИНИЯ ТРЕНДА (МНК) + коэффициент Пирсона r с качественной подписью прямо
 *    на карточке — сразу отвечает «есть ли связь?», не требуя отдельного вердикта;
 *  - ЛОГ-ШКАЛА по осям (xScale/yScale='log') для величин на разные порядки:
 *    точки приходят СЫРЫМИ, лог делает рендер, а тики подписаны РЕАЛЬНЫМИ
 *    значениями (50/500/5k), не log-числами — прежде LLM логарифмировал в SQL
 *    и ось показывала нечитабельные 1.7/3.0;
 *  - подпись-инструкция «как читать» и полупрозрачные точки для плотности.
 *
 * Регрессия и r считаются в КООРДИНАТАХ ГРАФИКА (в лог-пространстве при лог-оси),
 * поэтому линия прямая на экране, а r совпадает с тем, что видно.
 *
 * Рукописный SVG в стиле TimelineCard: hairline-сетка, точки r=4 с кольцом
 * поверхности, hover-тултип, хит-таргет r=12. Клик по точке → ClickContext.
 */
import { useId, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import type { AxisScale, ClickContext, ScatterSpec } from "@/lib/contracts";
import { useNumberFormat } from "@/lib/i18n/formats";
import {
  buildClickContext,
  findClickTarget,
  scatterPointElementFields,
} from "./click";

const VB_W = 640;
const VB_H = 280;
const M = { top: 18, right: 16, bottom: 48, left: 56 };

/** Компактная подпись тика: 50, 500, 5k, 50k, 1.2M. */
function fmtCompact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${+(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${+(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  if (Number.isInteger(v)) return String(v);
  return String(+v.toFixed(2));
}

/** «Красивый» шаг оси: 1/2/5 × 10^n. */
function niceStep(rough: number): number {
  const pow = 10 ** Math.floor(Math.log10(Math.max(rough, 1e-9)));
  const unit = rough / pow;
  const factor = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10;
  return factor * pow;
}

type Axis = {
  /** value → координата viewBox (уже с учётом лог-преобразования). */
  pos: (v: number) => number;
  /** Тики: позиция t (в пространстве оси) + подпись реального значения. */
  ticks: { v: number; label: string }[];
  /** value → внутренняя координата оси (log10 для лог-шкалы, иначе сама v). */
  t: (v: number) => number;
  min: number;
  max: number;
};

/** Лог-шкала возможна только для строго положительных значений. */
function effectiveScale(scale: AxisScale | undefined, values: number[]): AxisScale {
  return scale === "log" && values.every((v) => v > 0) ? "log" : "linear";
}

/** Строит ось: домен, тики (реальные подписи) и функции преобразования. */
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
    // Тики — степени десятки; при узком диапазоне добавляем 3×10^k.
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

  // Линейная шкала.
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
  /** Линия в координатах viewBox: (x1,y1)-(x2,y2). */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Пирсон r в пространстве осей (лог, если ось логарифмическая). */
  r: number;
} | null;

/** МНК-регрессия и Пирсон r в пространстве осей (совпадает с картинкой). */
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
  if (sxx < 1e-9 || syy < 1e-9) return null; // нет вариации по оси
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r = sxy / Math.sqrt(sxx * syy);
  // Линия по краям видимого домена (в t-пространстве), затем в пиксели.
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
  const t = useTranslations("scatter");
  const tCards = useTranslations("cards");
  /** Точное значение в тултип (разделитель тысяч). */
  const numFmt = useNumberFormat({ maximumFractionDigits: 2 });
  const [hover, setHover] = useState<Hover>(null);
  const clipId = useId();
  const pointTarget = findClickTarget(spec.clicks, "point");
  const clickable = Boolean(pointTarget && onClickContext);

  /** Качественная подпись силы и направления связи по |r|. */
  const describeR = (r: number): string => {
    const a = Math.abs(r);
    if (a < 0.2) return t("noCorrelation");
    const strength = a >= 0.7 ? "strong" : a >= 0.4 ? "moderate" : "weak";
    return t("correlation", {
      strength,
      direction: r > 0 ? "direct" : "inverse",
    }).trim();
  };

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
      <p className="px-1 py-6 text-center text-sm text-muted">{tCards("noPoints")}</p>
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
      ? ` · ${t("logScaleNote")}`
      : "";

  return (
    <div>
      {/* Резюме связи — главное, что отвечает на вопрос «есть ли зависимость?» */}
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
          <span className="text-xs text-muted">{t("noTrend")}</span>
        )}
        <span className="text-[11px] text-muted/80">
          {t("points", { count: spec.points.length })}
          {logNote}
        </span>
      </div>

      <div className="relative">
        <svg
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          className="block w-full"
          role="img"
          aria-label={
            trend
              ? t("ariaWithTrend", {
                  title: spec.title,
                  r: trend.r.toFixed(2),
                  description: describeR(trend.r),
                })
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

          {/* Сетка + подписи по Y (реальные значения) */}
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

          {/* Сетка + подписи по X (реальные значения) */}
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

          {/* Линия тренда (МНК) — поверх сетки, под точками */}
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

          {/* Точки: видимые r=4 с кольцом + хит-таргет r=12 */}
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
            {xScale === "log" ? ` ${t("axisLog")}` : ""} →
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
            {yScale === "log" ? ` ${t("axisLog")}` : ""} →
          </text>
        </svg>

        {/* Тултип: сущность — главное, реальные координаты — вторичные */}
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

      {/* Как читать */}
      <p className="mt-1 px-1 text-[10px] text-muted/80">
        {t("howTo", { hasLabels: spec.points[0]?.label ? "yes" : "no" })}
      </p>
    </div>
  );
}
