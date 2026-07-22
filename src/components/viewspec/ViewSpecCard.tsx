"use client";

/**
 * ViewSpecCard (C3) — view-spec render dispatcher.
 *
 * Accepts an arbitrary spec (LLM output!), validates it with the contracts
 * schema `viewSpecSchema` and renders a component by kind via the registry.
 * Unknown or broken spec → fallback card with details, never a feed crash.
 *
 * Card wrapper is shared for all kinds: kind badge, title, border, dark theme.
 * onClickContext is forwarded to clickable components that build ClickContext
 * strictly per ClickTarget semantics (see click.ts).
 */
import type { ReactNode } from "react";
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
 * ViewSpecCard exposes click together with the validated spec (C6):
 * the feed handler needs the spec for a human-readable follow-up question title
 * and access to the clicks declaration.
 */
export type SpecClickHandler = (ctx: ClickContext, spec: ViewSpec) => void;

type RendererProps<K extends ViewKind> = CommonProps & {
  spec: Extract<ViewSpec, { kind: K }>;
};

/** kind → renderer registry. `satisfies` guarantees completeness for all kinds. */
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
  // Sole cast: TS doesn't infer spec.kind ↔ RENDERERS[kind] correlation,
  // but the registry is typed precisely via `satisfies`.
  const render = RENDERERS[spec.kind] as (
    p: CommonProps & { spec: ViewSpec },
  ) => ReactNode;
  return render({ ...common, spec });
}

/**
 * Shared card frame: kind badge + title + optional accent. Exported for
 * BoardGrid (C2) — board_planned skeletons use exactly the same frame so
 * hydration into a ready ViewSpecCard doesn't "jump" in layout.
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

/** Fallback: spec failed contract validation. */
function FallbackCard({ spec, error }: { spec: unknown; error: string }) {
  const kind =
    typeof spec === "object" && spec !== null && "kind" in spec
      ? String((spec as { kind: unknown }).kind)
      : "неизвестен";
  return (
    <article className="rounded-xl border border-dashed border-border bg-surface p-4">
      <header className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-muted">
          Не смог отрисовать карточку
        </h2>
        <span className="shrink-0 rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-muted">
          kind: {kind}
        </span>
      </header>
      <p className="text-xs text-muted">
        Спек не прошёл валидацию контрактом view-spec. Это фоллбек, а не пустой
        экран — сырые данные ниже.
      </p>
      <details className="mt-2 text-xs text-muted">
        <summary className="cursor-pointer select-none hover:text-foreground">
          Детали
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
 * Annotation footnote under the chart: insight from actual numbers (annotateCard)
 * and metric explanation. Rendered in the shared wrapper — same for all kinds.
 */
function CardInsight({ insight, metricNote }: { insight?: string; metricNote?: string }) {
  if (!insight && !metricNote) return null;
  return (
    <footer className="mt-3 flex flex-col gap-1 border-t border-border pt-2.5">
      {insight && (
        <p className="text-[13px] leading-snug">
          <span className="mr-1.5 font-semibold text-accent">Вывод:</span>
          {insight}
        </p>
      )}
      {metricNote && (
        <p className="text-[11px] leading-snug text-muted">
          <span className="mr-1">Метрика:</span>
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
  const parsed = viewSpecSchema.safeParse(spec);
  if (!parsed.success) {
    return <FallbackCard spec={spec} error={parsed.error.message} />;
  }
  const v = parsed.data;
  const isVerdict = v.kind === "verdict";
  return (
    <CardShell
      kind={v.kind}
      title={isVerdict ? "Вердикт расследования" : v.title}
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
