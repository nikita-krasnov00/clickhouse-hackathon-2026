/**
 * VerdictCard (C4) — финал расследования: вердикт крупно, badge уверенности
 * (low/medium/high — цветовая шкала со значком, не только цвет), стат-тайлы
 * evidence (label/value/detail).
 */
import { useTranslations } from "next-intl";
import type { VerdictSpec } from "@/lib/contracts";
import { useNumberFormat } from "@/lib/i18n/formats";

/** Значок/цвета бейджа уверенности; подписи — в messages (confidence.*). */
const CONFIDENCE: Record<
  VerdictSpec["confidence"],
  { icon: string; color: string; bg: string }
> = {
  low: {
    icon: "○",
    color: "var(--muted)",
    bg: "rgba(139, 147, 167, 0.12)",
  },
  medium: {
    icon: "◐",
    color: "var(--viz-warning)",
    bg: "rgba(250, 178, 25, 0.12)",
  },
  high: {
    icon: "●",
    color: "var(--viz-good)",
    bg: "rgba(12, 163, 12, 0.12)",
  },
};

export function VerdictCard({ spec }: { spec: VerdictSpec }) {
  const t = useTranslations("confidence");
  const numFmt = useNumberFormat();
  const conf = CONFIDENCE[spec.confidence];
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
          style={{ color: conf.color, background: conf.bg }}
        >
          <span aria-hidden>{conf.icon}</span>
          {t(spec.confidence)}
        </span>
      </div>

      <p className="text-lg leading-snug font-semibold tracking-tight sm:text-xl">
        {spec.verdict}
      </p>

      {spec.evidence.length > 0 && (
        <dl className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {spec.evidence.map((stat) => (
            <div
              key={stat.label}
              className="rounded-lg border border-border bg-background/50 px-3 py-2.5"
            >
              <dt className="text-xs text-muted">{stat.label}</dt>
              <dd className="mt-0.5 text-2xl font-semibold">
                {typeof stat.value === "number"
                  ? numFmt.format(stat.value)
                  : stat.value}
              </dd>
              {stat.detail && (
                <dd className="mt-0.5 text-xs leading-tight text-muted">
                  {stat.detail}
                </dd>
              )}
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
