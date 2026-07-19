/**
 * BigNumber — крупный KPI: значение во всю карточку, подпись метрики,
 * опциональная дельта в % (рост — зелёный ▲, падение — красный ▼, ноль —
 * приглушённый, не только цвет) и вторичная подпись detail.
 *
 * Без кликов и без SVG — типографика делает всю работу (в стиле стат-тайлов
 * VerdictCard, но одно значение и крупнее).
 */
import type { BigNumberSpec } from "@/lib/contracts";

const numFmt = new Intl.NumberFormat("ru-RU");
const deltaFmt = new Intl.NumberFormat("ru-RU", {
  maximumFractionDigits: 1,
  signDisplay: "always",
});

/** Цвет/значок/фон дельты: не полагаемся на один только цвет. */
function deltaBadge(delta: number): { icon: string; color: string; bg: string } {
  if (delta > 0) {
    return { icon: "▲", color: "var(--viz-good)", bg: "rgba(12, 163, 12, 0.12)" };
  }
  if (delta < 0) {
    return { icon: "▼", color: "var(--viz-critical)", bg: "rgba(208, 59, 59, 0.12)" };
  }
  return { icon: "＝", color: "var(--muted)", bg: "rgba(139, 147, 167, 0.12)" };
}

export function BigNumberCard({ spec }: { spec: BigNumberSpec }) {
  const badge = spec.delta !== undefined ? deltaBadge(spec.delta) : null;
  return (
    <div className="px-1 py-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl">
          {typeof spec.value === "number" ? numFmt.format(spec.value) : spec.value}
        </span>
        {badge && spec.delta !== undefined && (
          <span
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums"
            style={{ color: badge.color, background: badge.bg }}
            title="Изменение к базе сравнения, %"
          >
            <span aria-hidden>{badge.icon}</span>
            {deltaFmt.format(spec.delta)}%
          </span>
        )}
      </div>
      <div className="mt-1 text-sm text-muted">{spec.label}</div>
      {spec.detail && (
        <div className="mt-0.5 text-xs leading-tight text-muted opacity-80">
          {spec.detail}
        </div>
      )}
    </div>
  );
}
