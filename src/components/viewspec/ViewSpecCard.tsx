"use client";

/**
 * ViewSpecCard (C3) — диспетчер рендера view-spec.
 *
 * Принимает произвольный спек (выход LLM!), валидирует его схемой контрактов
 * `viewSpecSchema` и рендерит компонент по kind через реестр. Неизвестный или
 * сломанный спек → фоллбек-карточка с деталями, никогда не падение ленты.
 *
 * Обёртка-карточка едина для всех видов: kind-бейдж, заголовок, рамка,
 * тёмная тема. onClickContext прокидывается в кликабельные компоненты,
 * которые собирают ClickContext строго по семантике ClickTarget (см. click.ts).
 */
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import {
  viewSpecSchema,
  type ClickContext,
  type ViewKind,
  type ViewSpec,
} from "@/lib/contracts";
import { TimelineCard } from "./TimelineCard";
import { LeaderboardCard } from "./LeaderboardCard";
import { VerdictCard } from "./VerdictCard";
import { HistogramCard } from "./HistogramCard";
import { NetworkGraphCard } from "./NetworkGraphCard";
import { CalendarHeatmapCard } from "./CalendarHeatmapCard";
import { BigNumberCard } from "./BigNumberCard";
import { ScatterCard } from "./ScatterCard";
import { MapCard } from "./MapCard";
import { TreemapCard } from "./TreemapCard";
import { FunnelCard } from "./FunnelCard";
import { BoxplotCard } from "./BoxplotCard";

type CommonProps = {
  cardId: string;
  onClickContext?: (ctx: ClickContext) => void;
};

/**
 * Наружу ViewSpecCard отдаёт клик вместе с провалидированным спеком (C6):
 * обработчику ленты спек нужен для человекочитаемого заголовка follow-up
 * вопроса и доступа к clicks-декларации.
 */
export type SpecClickHandler = (ctx: ClickContext, spec: ViewSpec) => void;

type RendererProps<K extends ViewKind> = CommonProps & {
  spec: Extract<ViewSpec, { kind: K }>;
};

/** Реестр kind → рендерер. `satisfies` гарантирует полноту по всем видам. */
const RENDERERS = {
  timeline: (p: RendererProps<"timeline">) => <TimelineCard {...p} />,
  leaderboard: (p: RendererProps<"leaderboard">) => <LeaderboardCard {...p} />,
  histogram: (p: RendererProps<"histogram">) => <HistogramCard {...p} />,
  graph: (p: RendererProps<"graph">) => <NetworkGraphCard {...p} />,
  heatmap: (p: RendererProps<"heatmap">) => <CalendarHeatmapCard {...p} />,
  verdict: (p: RendererProps<"verdict">) => <VerdictCard spec={p.spec} />,
  bignumber: (p: RendererProps<"bignumber">) => <BigNumberCard spec={p.spec} />,
  scatter: (p: RendererProps<"scatter">) => <ScatterCard {...p} />,
  map: (p: RendererProps<"map">) => <MapCard {...p} />,
  treemap: (p: RendererProps<"treemap">) => <TreemapCard {...p} />,
  funnel: (p: RendererProps<"funnel">) => <FunnelCard {...p} />,
  boxplot: (p: RendererProps<"boxplot">) => <BoxplotCard {...p} />,
} satisfies { [K in ViewKind]: (p: RendererProps<K>) => ReactNode };

function renderByKind(spec: ViewSpec, common: CommonProps): ReactNode {
  // Единственный каст: TS не выводит корреляцию spec.kind ↔ RENDERERS[kind],
  // реестр же типизирован точно через `satisfies`.
  const render = RENDERERS[spec.kind] as (
    p: CommonProps & { spec: ViewSpec },
  ) => ReactNode;
  return render({ ...common, spec });
}

/**
 * Общая рамка карточки: kind-бейдж + title + опциональный акцент. Экспортится
 * для BoardGrid (C2) — скелеты board_planned используют ровно ту же рамку,
 * чтобы гидратация в готовую ViewSpecCard не «прыгала» по вёрстке.
 */
export function CardShell({
  kind,
  title,
  accent = false,
  children,
}: {
  kind: string;
  title: string;
  accent?: boolean;
  children: ReactNode;
}) {
  return (
    <article
      className={`rounded-xl border bg-surface p-4 ${
        accent ? "border-accent/40 shadow-[0_0_24px_rgba(242,176,53,0.06)]" : "border-border"
      }`}
    >
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium tracking-tight">{title}</h2>
        <span className="shrink-0 rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-muted">
          {kind}
        </span>
      </header>
      {children}
    </article>
  );
}

/** Фоллбек: спек не прошёл валидацию контрактом. */
function FallbackCard({ spec, error }: { spec: unknown; error: string }) {
  const t = useTranslations("cards");
  const kind =
    typeof spec === "object" && spec !== null && "kind" in spec
      ? String((spec as { kind: unknown }).kind)
      : t("fallbackKindUnknown");
  return (
    <article className="rounded-xl border border-dashed border-border bg-surface p-4">
      <header className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-muted">{t("fallbackTitle")}</h2>
        <span className="shrink-0 rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-muted">
          kind: {kind}
        </span>
      </header>
      <p className="text-xs text-muted">{t("fallbackBody")}</p>
      <details className="mt-2 text-xs text-muted">
        <summary className="cursor-pointer select-none hover:text-foreground">
          {t("details")}
        </summary>
        <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-background p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap">
          {error}
          {"\n\n"}
          {JSON.stringify(spec, null, 2)}
        </pre>
      </details>
    </article>
  );
}

/**
 * Сноска аннотации под чартом: вывод по фактическим цифрам (annotateCard) и
 * объяснение метрики. Рендерится в общей обёртке — одинаково у всех видов.
 */
function CardInsight({ insight, metricNote }: { insight?: string; metricNote?: string }) {
  const t = useTranslations("cards");
  if (!insight && !metricNote) return null;
  return (
    <footer className="mt-3 flex flex-col gap-1 border-t border-border pt-2.5">
      {insight && (
        <p className="text-[13px] leading-snug">
          <span className="mr-1.5 font-semibold text-accent">{t("insight")}</span>
          {insight}
        </p>
      )}
      {metricNote && (
        <p className="text-[11px] leading-snug text-muted">
          <span className="mr-1">{t("metric")}</span>
          {metricNote}
        </p>
      )}
    </footer>
  );
}

export function ViewSpecCard({
  cardId,
  spec,
  onClickContext,
}: {
  cardId: string;
  spec: unknown;
  onClickContext?: SpecClickHandler;
}) {
  const tCommon = useTranslations("common");
  const parsed = viewSpecSchema.safeParse(spec);
  if (!parsed.success) {
    return <FallbackCard spec={spec} error={parsed.error.message} />;
  }
  const v = parsed.data;
  const isVerdict = v.kind === "verdict";
  return (
    <CardShell
      kind={v.kind}
      title={isVerdict ? tCommon("verdictTitle") : v.title}
      accent={isVerdict}
    >
      {renderByKind(v, {
        cardId,
        onClickContext: onClickContext ? (ctx) => onClickContext(ctx, v) : undefined,
      })}
      <CardInsight
        insight={"insight" in v ? v.insight : undefined}
        metricNote={"metricNote" in v ? v.metricNote : undefined}
      />
    </CardShell>
  );
}
