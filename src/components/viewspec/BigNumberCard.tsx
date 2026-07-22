/**
 * BigNumber — large KPI: value fills the card, metric label, optional delta in
 * % (up — green ▲, down — red ▼, zero — muted, not color alone) and secondary
 * detail caption.
 *
 * No clicks and no SVG — typography does all the work (stat-tile style like
 * VerdictCard, but a single value and larger).
 */
import { useTranslations } from "next-intl";
import type { BigNumberSpec } from "@/lib/contracts";
import { useNumberFormat } from "@/lib/i18n/formats";

/** Delta color/icon/background: don't rely on color alone. */
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
  const t = useTranslations("bignumber");
  const numFmt = useNumberFormat();
  const deltaFmt = useNumberFormat({
    maximumFractionDigits: 1,
    signDisplay: "always",
  });
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
            title={t("deltaTitle")}
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
