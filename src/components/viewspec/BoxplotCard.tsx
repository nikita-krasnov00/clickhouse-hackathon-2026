"use client";

/**
 * Boxplot — compare metric distributions across groups.
 *
 * Hand-written SVG in ScatterCard/HistogramCard style: horizontal boxes on a
 * shared numeric axis. Box — q1..q3, bold tick — median (accent), whiskers —
 * lo..hi (SQL convention: p05/p95). Linear axis; if values are strictly
 * positive and span ≥ 2.3 orders of magnitude — auto log10 with real value
 * labels (like scatter). Groups in spec order (SQL sorts by median). Group row
 * click → ClickContext per ClickTarget on:'box' semantics.
 */
import { useMemo, useState } from "react";
import type { BoxplotGroup, BoxplotSpec, ClickContext } from "@/lib/contracts";
import { boxElementFields, buildClickContext, findClickTarget } from "./click";

const VB_W = 640;
const M = { top: 10, right: 16, bottom: 42, left: 122 };
const ROW_H = 34;
const BOX_H = 16;
/** Auto-log threshold: max/min across all group values. */
const LOG_RATIO = 200;
/** Max group label characters — ellipsis beyond this. */
const LABEL_MAX = 17;

const numFmt = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });

/** Compact tick label: 50, 500, 5k, 50k, 1.2M (like ScatterCard). */
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

function truncateLabel(s: string): string {
  return s.length > LABEL_MAX ? `${s.slice(0, LABEL_MAX - 1)}…` : s;
}

type Axis = {
  pos: (v: number) => number;
  ticks: { v: number; label: string }[];
};

/** Value axis: linear or log10 (real tick labels). */
function buildAxis(lo: number, hi: number, useLog: boolean): Axis {
  const pxMin = M.left;
  const pxMax = VB_W - M.right;
  if (useLog) {
    const eLo = Math.floor(Math.log10(lo));
    let eHi = Math.ceil(Math.log10(hi));
    if (eLo === eHi) eHi = eLo + 1;
    const pos = (v: number) =>
      pxMin + ((Math.log10(Math.max(v, 1e-9)) - eLo) / (eHi - eLo)) * (pxMax - pxMin);
    const ticks: { v: number; label: string }[] = [];
    for (let e = eLo; e <= eHi; e++) {
      const base = 10 ** e;
      ticks.push({ v: base, label: fmtCompact(base) });
      if (eHi - eLo <= 2 && e < eHi) {
        ticks.push({ v: 3 * base, label: fmtCompact(3 * base) });
      }
    }
    return { pos, ticks };
  }
  let min = lo;
  let max = hi;
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const step = niceStep((max - min) / 5);
  min = Math.floor(min / step) * step;
  max = Math.ceil(max / step) * step;
  const pos = (v: number) => pxMin + ((v - min) / (max - min)) * (pxMax - pxMin);
  const ticks: { v: number; label: string }[] = [];
  const n = Math.round((max - min) / step);
  for (let i = 0; i <= n; i++) {
    const v = min + step * i;
    ticks.push({ v, label: fmtCompact(v) });
  }
  return { pos, ticks };
}

export function BoxplotCard({
  spec,
  cardId,
  onClickContext,
}: {
  spec: BoxplotSpec;
  cardId: string;
  onClickContext?: (ctx: ClickContext) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const boxTarget = findClickTarget(spec.clicks, "box");
  const clickable = Boolean(boxTarget && onClickContext);

  const layout = useMemo(() => {
    if (spec.groups.length === 0) return null;
    const lo = Math.min(...spec.groups.map((g) => g.lo));
    const hi = Math.max(...spec.groups.map((g) => g.hi));
    const useLog = lo > 0 && hi / lo >= LOG_RATIO;
    const axis = buildAxis(lo, hi, useLog);
    const vbH = M.top + spec.groups.length * ROW_H + M.bottom;
    return { axis, vbH, useLog };
  }, [spec.groups]);

  if (!layout) {
    return <p className="px-1 py-6 text-center text-sm text-muted">Нет данных</p>;
  }
  const { axis, vbH } = layout;
  const plotBottom = vbH - M.bottom;

  const fire = (i: number) => {
    if (!boxTarget || !onClickContext) return;
    onClickContext(
      buildClickContext({
        cardId,
        componentKind: "boxplot",
        target: boxTarget,
        element: boxElementFields(spec.groups[i]),
      }),
    );
  };

  const rowY = (i: number) => M.top + i * ROW_H;
  const hovered: BoxplotGroup | null = hover !== null ? spec.groups[hover] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${VB_W} ${vbH}`}
        className="block w-full"
        role="img"
        aria-label={spec.title}
      >
        {/* Vertical value grid */}
        {axis.ticks.map((tick) => (
          <g key={tick.v}>
            <line
              x1={axis.pos(tick.v)}
              x2={axis.pos(tick.v)}
              y1={M.top}
              y2={plotBottom}
              stroke="var(--viz-grid)"
              strokeWidth={1}
            />
            <text
              x={axis.pos(tick.v)}
              y={plotBottom + 14}
              textAnchor="middle"
              fontSize={10}
              fill="var(--muted)"
            >
              {tick.label}
            </text>
          </g>
        ))}

        {/* Group boxes */}
        {spec.groups.map((g, i) => {
          const y = rowY(i);
          const cy = y + ROW_H / 2;
          const isHovered = hover === i;
          const xLo = axis.pos(g.lo);
          const xHi = axis.pos(g.hi);
          const xQ1 = axis.pos(g.q1);
          const xQ3 = axis.pos(g.q3);
          const xMed = axis.pos(g.med);
          return (
            <g key={`${g.label}-${i}`}>
              {isHovered && (
                <rect
                  x={0}
                  y={y}
                  width={VB_W}
                  height={ROW_H}
                  fill="var(--viz-grid)"
                  fillOpacity={0.55}
                />
              )}
              {/* Whisker lo..hi with end caps */}
              <line x1={xLo} x2={xHi} y1={cy} y2={cy} stroke="var(--muted)" strokeWidth={1} />
              <line x1={xLo} x2={xLo} y1={cy - 5} y2={cy + 5} stroke="var(--muted)" strokeWidth={1} />
              <line x1={xHi} x2={xHi} y1={cy - 5} y2={cy + 5} stroke="var(--muted)" strokeWidth={1} />
              {/* Box q1..q3 */}
              <rect
                x={xQ1}
                y={cy - BOX_H / 2}
                width={Math.max(xQ3 - xQ1, 1)}
                height={BOX_H}
                rx={2}
                fill="var(--viz-series-1)"
                fillOpacity={isHovered ? 0.55 : 0.35}
                stroke="var(--viz-series-1)"
                strokeWidth={1}
              />
              {/* Median — primary tick */}
              <line
                x1={xMed}
                x2={xMed}
                y1={cy - BOX_H / 2 - 2}
                y2={cy + BOX_H / 2 + 2}
                stroke="var(--accent)"
                strokeWidth={2}
              />
              {/* Group label */}
              <text
                x={M.left - 10}
                y={cy + 3.5}
                textAnchor="end"
                fontSize={11}
                fill="var(--foreground)"
              >
                {truncateLabel(g.label)}
              </text>
              {/* Hit target — entire group row */}
              <rect
                x={0}
                y={y}
                width={VB_W}
                height={ROW_H}
                fill="transparent"
                className={clickable ? "cursor-pointer" : undefined}
                role={clickable ? "button" : undefined}
                tabIndex={clickable ? 0 : undefined}
                aria-label={
                  clickable
                    ? `${g.label} · медиана ${numFmt.format(g.med)}${boxTarget?.label ? ` — ${boxTarget.label}` : ""}`
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

        {/* Value axis label */}
        {spec.valueLabel && (
          <text
            x={M.left + (VB_W - M.left - M.right) / 2}
            y={vbH - 8}
            textAnchor="middle"
            fontSize={10}
            fill="var(--muted)"
            opacity={0.8}
          >
            {spec.valueLabel}
            {layout.useLog ? " (лог-шкала)" : ""}
          </text>
        )}

        {/* Log scale note when axis label is absent */}
        {!spec.valueLabel && layout.useLog && (
          <text
            x={VB_W - M.right}
            y={vbH - 8}
            textAnchor="end"
            fontSize={10}
            fill="var(--muted)"
            opacity={0.8}
          >
            лог-шкала
          </text>
        )}
      </svg>

      {/* Tooltip: median — primary, quantiles — secondary */}
      {hover !== null && hovered && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-background px-2.5 py-1.5 shadow-lg"
          style={{
            left: `${(axis.pos(hovered.med) / VB_W) * 100}%`,
            top: `${(rowY(hover) / vbH) * 100}%`,
            marginTop: "-6px",
          }}
        >
          <div className="text-sm font-semibold whitespace-nowrap">
            {hovered.label}: медиана {numFmt.format(hovered.med)}
          </div>
          <div className="text-xs whitespace-nowrap text-muted">
            p05 {numFmt.format(hovered.lo)} · q1 {numFmt.format(hovered.q1)} · q3{" "}
            {numFmt.format(hovered.q3)} · p95 {numFmt.format(hovered.hi)}
          </div>
          {clickable && boxTarget?.label && (
            <div className="mt-0.5 text-[10px] whitespace-nowrap text-accent">
              {boxTarget.label} →
            </div>
          )}
        </div>
      )}
    </div>
  );
}
