"use client";

/**
 * Funnel — process stages: centered bars, width ∝ count.
 *
 * Hand-written SVG in HistogramCard style. Between stages — transition percentage
 * (next count to previous); inside wide bar — share of first stage. Non-monotonic
 * step (> 100%) honestly highlighted with warning color, not hidden. Below chart —
 * end-to-end conversion: last stage to first. Stage click → ClickContext per
 * ClickTarget on:'bucket' semantics (stage is Bucket {label, count}).
 */
import { useMemo, useState } from "react";
import type { ClickContext, FunnelSpec } from "@/lib/contracts";
import { bucketElementFields, buildClickContext, findClickTarget } from "./click";

const VB_W = 640;
const PAD_Y = 6;
const BAR_H = 30;
const GAP = 24; // gap between bars — transition percentage lives here
const CAP_R = 4;
/** Space for stage label on the left and count on the right. */
const SIDE = 118;
/** Minimum visible bar width — zero stage doesn't disappear. */
const MIN_W = 3;

const numFmt = new Intl.NumberFormat("ru-RU");

/** Percentage: < 10 → one decimal, otherwise whole numbers ("9.5%", "47%"). */
function fmtPct(ratio: number): string {
  const pct = ratio * 100;
  const s = pct > 0 && pct < 10 ? +pct.toFixed(1) : Math.round(pct);
  return `${numFmt.format(s)}%`;
}

export function FunnelCard({
  spec,
  cardId,
  onClickContext,
}: {
  spec: FunnelSpec;
  cardId: string;
  onClickContext?: (ctx: ClickContext) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const bucketTarget = findClickTarget(spec.clicks, "bucket");
  const clickable = Boolean(bucketTarget && onClickContext);

  const layout = useMemo(() => {
    if (spec.stages.length < 2) return null;
    const maxCount = Math.max(...spec.stages.map((s) => s.count), 1);
    const maxBarW = VB_W - SIDE * 2;
    const rows = spec.stages.map((stage, i) => {
      const w = Math.max((stage.count / maxCount) * maxBarW, MIN_W);
      return {
        stage,
        w,
        x: (VB_W - w) / 2,
        y: PAD_Y + i * (BAR_H + GAP),
        /** Share of first stage (funnel base). */
        ofFirst: spec.stages[0].count > 0 ? stage.count / spec.stages[0].count : 0,
        /** Transition from previous stage; absent for the first. */
        step: i > 0 && spec.stages[i - 1].count > 0 ? stage.count / spec.stages[i - 1].count : null,
      };
    });
    const vbH = PAD_Y * 2 + spec.stages.length * BAR_H + (spec.stages.length - 1) * GAP;
    const overall =
      spec.stages[0].count > 0
        ? spec.stages[spec.stages.length - 1].count / spec.stages[0].count
        : null;
    return { rows, vbH, overall };
  }, [spec.stages]);

  if (!layout) {
    return <p className="px-1 py-6 text-center text-sm text-muted">Нет данных</p>;
  }
  const { rows, vbH, overall } = layout;
  const first = spec.stages[0];
  const last = spec.stages[spec.stages.length - 1];

  const fire = (i: number) => {
    if (!bucketTarget || !onClickContext) return;
    onClickContext(
      buildClickContext({
        cardId,
        componentKind: "funnel",
        target: bucketTarget,
        element: bucketElementFields(spec.stages[i]),
      }),
    );
  };

  const hovered = hover !== null ? rows[hover] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${VB_W} ${vbH}`}
        className="block w-full"
        role="img"
        aria-label={spec.title}
      >
        {rows.map((row, i) => {
          const isHovered = hover === i;
          const cy = row.y + BAR_H / 2;
          // Row hit target: to middle of gaps (edges — to frame border).
          const hitY0 = row.y - (i === 0 ? PAD_Y : GAP / 2);
          const hitY1 = row.y + BAR_H + (i === rows.length - 1 ? PAD_Y : GAP / 2);
          return (
            <g key={`${row.stage.label}-${i}`}>
              {/* Transition percentage — in gap above bar, at funnel axis */}
              {row.step !== null && (
                <text
                  x={VB_W / 2}
                  y={row.y - 8}
                  textAnchor="middle"
                  fontSize={10}
                  fontWeight={600}
                  fill={row.step > 1 ? "var(--viz-warning)" : "var(--muted)"}
                >
                  ↓ {fmtPct(row.step)}
                </text>
              )}
              <rect
                x={row.x}
                y={row.y}
                width={row.w}
                height={BAR_H}
                rx={CAP_R}
                fill="var(--viz-series-1)"
                fillOpacity={isHovered ? 1 : 0.85}
                pointerEvents="none"
              />
              {/* Share of first stage — inside bar when it fits */}
              {row.w >= 52 && i > 0 && (
                <text
                  x={VB_W / 2}
                  y={cy + 3.5}
                  textAnchor="middle"
                  fontSize={10}
                  fontWeight={600}
                  fill="var(--foreground)"
                  pointerEvents="none"
                >
                  {fmtPct(row.ofFirst)}
                </text>
              )}
              {/* Stage name left, count right — at fixed positions */}
              <text
                x={8}
                y={cy + 3.5}
                fontSize={11}
                fill="var(--foreground)"
                pointerEvents="none"
              >
                {row.stage.label}
              </text>
              <text
                x={VB_W - 8}
                y={cy + 3.5}
                textAnchor="end"
                fontSize={11}
                fontWeight={600}
                fill="var(--foreground)"
                pointerEvents="none"
              >
                {numFmt.format(row.stage.count)}
              </text>
              {/* Hit target — entire stage row */}
              <rect
                x={0}
                y={hitY0}
                width={VB_W}
                height={hitY1 - hitY0}
                fill="transparent"
                className={clickable ? "cursor-pointer" : undefined}
                role={clickable ? "button" : undefined}
                tabIndex={clickable ? 0 : undefined}
                aria-label={
                  clickable
                    ? `${row.stage.label} · ${numFmt.format(row.stage.count)}${bucketTarget?.label ? ` — ${bucketTarget.label}` : ""}`
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
      </svg>

      {/* End-to-end funnel conversion */}
      {overall !== null && (
        <p className="mt-2 text-[11px] text-muted">
          Сквозная конверсия:{" "}
          <span className="font-semibold text-foreground">{fmtPct(overall)}</span>{" "}
          — {numFmt.format(last.count)} из {numFmt.format(first.count)} ({first.label}
          {" → "}
          {last.label})
        </p>
      )}

      {/* Stage tooltip */}
      {hover !== null && hovered && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-background px-2.5 py-1.5 shadow-lg"
          style={{
            left: "50%",
            top: `${(hovered.y / vbH) * 100}%`,
            marginTop: "-6px",
          }}
        >
          <div className="text-sm font-semibold whitespace-nowrap">
            {numFmt.format(hovered.stage.count)}
          </div>
          <div className="text-xs whitespace-nowrap text-muted">
            {hovered.stage.label}
            {hover > 0 ? ` · ${fmtPct(hovered.ofFirst)} от «${first.label}»` : ""}
          </div>
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
