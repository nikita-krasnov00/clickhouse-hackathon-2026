"use client";

/**
 * Timeline (C4) — линии серий по времени, зона аномалии, кликабельные точки,
 * навигация по временной шкале.
 *
 * Рукописный SVG: 2px линии, точки с 2px кольцом цвета поверхности,
 * hairline-сетка, полупрозрачная заливка anomalyWindow (статусный critical),
 * hover-тултип и увеличенный хит-таргет точки (r=14 против видимых r=4).
 *
 * Зум и панорама:
 *   - протяжка мышью по графику — выделение диапазона → зум в него;
 *   - pinch трекпада / Ctrl+колесо — зум вокруг курсора;
 *   - Shift+колесо или горизонтальный свайп трекпада — панорама (в зуме);
 *   - двойной клик или кнопка «сброс» — исходный масштаб.
 * Обычная вертикальная прокрутка НЕ перехватывается — лента скроллится как
 * обычно. Ось Y пересчитывается под видимые точки.
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

/** Порог протяжки (в координатах viewBox), после которого клик становится brush. */
const BRUSH_THRESHOLD = 6;
/** Минимальное окно зума — не даём схлопнуть диапазон в точку. */
const MIN_SPAN_MS = 60_000;

const SERIES_COLORS = [
  "var(--viz-series-1)",
  "var(--viz-series-2)",
  "var(--viz-series-3)",
  "var(--viz-series-4)",
];

/**
 * Палитра честно различает не больше стольких серий (валидатор dataviz: 8 hue
 * на нашей поверхности уже уходят в CVD-floor). Больше серий — это, как правило,
 * двумерный паттерн (час × день), которому место в heatmap, а не в timeline.
 */
const MAX_SERIES = SERIES_COLORS.length;

/**
 * Бюджет ВИДИМЫХ маркеров-точек: пока в окне их не больше — рисуем и точки, и
 * клик-таргеты; больше (десятки-сотни на плотном ряду) — только линии, иначе
 * маркеры сливаются в облако и прячут сами линии. При зуме окно сужается,
 * точек в нём становится мало — маркеры и клики возвращаются автоматически.
 */
const MARKER_BUDGET = 60;

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
  /** Видимое окно времени; null — весь диапазон данных. */
  const [view, setView] = useState<View | null>(null);
  const [brush, setBrush] = useState<{ x0: number; x1: number } | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; brushing: boolean } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const clipId = useId();

  const pointTarget = findClickTarget(spec.clicks, "point");
  const clickable = Boolean(pointTarget && onClickContext);

  // Серий не больше палитры: избыток НЕ раскрашиваем в повторяющиеся цвета
  // (это вводило бы в заблуждение — 03–06 и 18–21 одним цветом), а показываем
  // крупнейшие по объёму, честно подписав, сколько скрыто.
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

  // Полный диапазон данных — от него считаются границы зума и панорамы.
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
    // Ось Y — под видимые точки (при зуме график «дышит» по вертикали).
    const visible = parsed.flat().filter((p) => p.ts >= tMin && p.ts <= tMax);
    const forScale = visible.length > 0 ? visible : parsed.flat();
    const vMax = Math.max(...forScale.map((p) => p.v), 1);
    const step = niceStep(vMax / 4);
    const yMax = Math.ceil(vMax / step) * step;

    const x = (ts: number) => M.left + ((ts - tMin) / (tMax - tMin)) * PLOT_W;
    const y = (v: number) =>
      VB_H - M.bottom - (v / yMax) * (VB_H - M.top - M.bottom);
    /** Обратное преобразование: координата viewBox → таймстамп. */
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

    // Плотность видимого окна решает, рисовать ли точки-маркеры (см. MARKER_BUDGET).
    const showMarkers = visible.length <= MARKER_BUDGET;

    return { tMin, tMax, yMax, parsed, x, y, tAt, yTicks, xTicks, fmtT, showMarkers };
  }, [series, domain, view, dayFmt, timeFmt]);

  // ---- зум/панорама -------------------------------------------------------

  /** Устанавливает окно с клампом в полный диапазон; совпало с полным — сброс. */
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

  /** Координата события мыши → координата viewBox по X. */
  const vbX = (clientX: number): number => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return ((clientX - rect.left) / rect.width) * VB_W;
  };

  // Колесо: pinch/Ctrl — зум вокруг курсора; Shift или горизонтальный свайп —
  // панорама. Обычный вертикальный скролл отдаём странице. Нативный listener
  // с passive:false — React вешает wheel пассивно, preventDefault не сработал бы.
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  const handleWheel = (e: WheelEvent) => {
    if (!layout || !domain) return;
    const { tMin, tMax, tAt } = layout;
    const span = tMax - tMin;
    const zooming = e.ctrlKey || e.metaKey;
    // Панорама: Shift+колесо либо горизонтальный свайп трекпада.
    let panDelta = 0;
    if (!zooming) {
      if (e.shiftKey) panDelta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) panDelta = e.deltaX;
    }

    if (zooming) {
      e.preventDefault();
      const factor = Math.exp(e.deltaY * 0.002); // deltaY<0 (pinch-out) — зум внутрь
      const anchor = Math.min(Math.max(tAt(vbX(e.clientX)), tMin), tMax);
      const newSpan = Math.min(Math.max(span * factor, MIN_SPAN_MS), domain.max - domain.min);
      const ratio = (anchor - tMin) / span;
      applyView(anchor - newSpan * ratio, anchor + newSpan * (1 - ratio));
    } else if (panDelta !== 0 && view) {
      e.preventDefault();
      // Пиксели курсора → время: доля от CSS-ширины области графика.
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

  // Протяжка: до порога — обычный клик по точке; после — brush-выделение.
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
      // Захват указателя только с началом brush — иначе сломались бы клики точек.
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
        if (a1 < tMin || a0 > tMax) return null; // окно целиком вне зума
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
      {/* Легенда — только при ≥2 сериях (одна серия названа заголовком). */}
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
            {/* Клип области графика: при зуме линии не вылезают за оси. */}
            <clipPath id={clipId}>
              <rect
                x={M.left}
                y={M.top - 6}
                width={PLOT_W}
                height={VB_H - M.top - M.bottom + 6}
              />
            </clipPath>
          </defs>

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
                {t("anomalyZone")}
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

          {/* Линии серий: 2px, круглые стыки; клип по области графика */}
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

          {/* Точки: видимые r=4 с кольцом поверхности + хит-таргет r=14.
              Только точки видимого окна и только когда их не слишком много
              (showMarkers) — иначе плотный ряд превращается в облако и прячет
              линии; на зуме окно сужается и точки/клики возвращаются. */}
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

          {/* Brush-выделение диапазона будущего зума */}
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

        {/* Тултип: значение — главное, подпись — вторичная */}
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
