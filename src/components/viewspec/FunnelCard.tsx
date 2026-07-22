"use client";

/**
 * Funnel — этапы процесса: центрированные полосы, ширина ∝ count.
 *
 * Рукописный SVG в стиле HistogramCard. Между этапами — процент перехода
 * (count следующего к предыдущему); внутри широкой полосы — доля от первого
 * этапа. Немонотонный шаг (> 100%) честно подсвечивается предупреждающим
 * цветом, а не прячется. Под чартом — сквозная конверсия: последний этап к
 * первому. Клик по этапу → ClickContext по семантике ClickTarget on:'bucket'
 * (этап и есть Bucket {label, count}).
 */
import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import type { ClickContext, FunnelSpec } from "@/lib/contracts";
import { useNumberFormat } from "@/lib/i18n/formats";
import { bucketElementFields, buildClickContext, findClickTarget } from "./click";

const VB_W = 640;
const PAD_Y = 6;
const BAR_H = 30;
const GAP = 24; // зазор между полосами — здесь живёт процент перехода
const CAP_R = 4;
/** Поле для подписи этапа слева и счётчика справа. */
const SIDE = 118;
/** Минимальная видимая ширина полосы — нулевой этап не исчезает. */
const MIN_W = 3;

export function FunnelCard({
  spec,
  cardId,
  onClickContext,
}: {
  spec: FunnelSpec;
  cardId: string;
  onClickContext?: (ctx: ClickContext) => void;
}) {
  const t = useTranslations("funnel");
  const tCards = useTranslations("cards");
  const numFmt = useNumberFormat();
  const [hover, setHover] = useState<number | null>(null);
  const bucketTarget = findClickTarget(spec.clicks, "bucket");
  const clickable = Boolean(bucketTarget && onClickContext);

  /** Процент: < 10 → одна десятая, иначе целые («9,5%», «47%»). */
  const fmtPct = (ratio: number): string => {
    const pct = ratio * 100;
    const s = pct > 0 && pct < 10 ? +pct.toFixed(1) : Math.round(pct);
    return `${numFmt.format(s)}%`;
  };

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
        /** Доля от первого этапа (база воронки). */
        ofFirst: spec.stages[0].count > 0 ? stage.count / spec.stages[0].count : 0,
        /** Переход с предыдущего этапа; у первого отсутствует. */
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
    return <p className="px-1 py-6 text-center text-sm text-muted">{tCards("noData")}</p>;
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
          // Хит-таргет строки: до середины зазоров (краевые — до кромки кадра).
          const hitY0 = row.y - (i === 0 ? PAD_Y : GAP / 2);
          const hitY1 = row.y + BAR_H + (i === rows.length - 1 ? PAD_Y : GAP / 2);
          return (
            <g key={`${row.stage.label}-${i}`}>
              {/* Процент перехода — в зазоре над полосой, у оси воронки */}
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
              {/* Доля от первого этапа — внутри полосы, когда влезает */}
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
              {/* Имя этапа слева, счётчик справа — на постоянных местах */}
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
              {/* Хит-таргет — вся строка этапа */}
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

      {/* Сквозная конверсия воронки */}
      {overall !== null && (
        <p className="mt-2 text-[11px] text-muted">
          {t("overallLabel")}{" "}
          <span className="font-semibold text-foreground">{fmtPct(overall)}</span>{" "}
          {t("overallDetail", {
            last: numFmt.format(last.count),
            first: numFmt.format(first.count),
            firstLabel: first.label,
            lastLabel: last.label,
          })}
        </p>
      )}

      {/* Тултип этапа */}
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
            {hover > 0
              ? ` · ${t("ofFirst", { pct: fmtPct(hovered.ofFirst), label: first.label })}`
              : ""}
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
