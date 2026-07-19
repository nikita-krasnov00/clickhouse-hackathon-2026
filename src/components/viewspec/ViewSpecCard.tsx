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

type CommonProps = {
  cardId: string;
  onClickContext?: (ctx: ClickContext) => void;
};

/**
 * Наружу ViewSpecCard отдаёт клик вместе с провалидированным спеком (C6):
 * обработчику ленты нужен ClickTarget.drillId, а ClickContext его не несёт —
 * лента находит цель в spec.clicks по виду элемента.
 */
export type SpecClickHandler = (ctx: ClickContext, spec: ViewSpec) => void;

type RendererProps<K extends ViewKind> = CommonProps & {
  spec: Extract<ViewSpec, { kind: K }>;
};

/** Реестр kind → рендерер. `satisfies` гарантирует ровно шесть видов. */
const RENDERERS = {
  timeline: (p: RendererProps<"timeline">) => <TimelineCard {...p} />,
  leaderboard: (p: RendererProps<"leaderboard">) => <LeaderboardCard {...p} />,
  histogram: (p: RendererProps<"histogram">) => <HistogramCard {...p} />,
  graph: (p: RendererProps<"graph">) => <NetworkGraphCard {...p} />,
  heatmap: (p: RendererProps<"heatmap">) => <CalendarHeatmapCard {...p} />,
  verdict: (p: RendererProps<"verdict">) => <VerdictCard spec={p.spec} />,
} satisfies { [K in ViewKind]: (p: RendererProps<K>) => ReactNode };

function renderByKind(spec: ViewSpec, common: CommonProps): ReactNode {
  // Единственный каст: TS не выводит корреляцию spec.kind ↔ RENDERERS[kind],
  // реестр же типизирован точно через `satisfies`.
  const render = RENDERERS[spec.kind] as (
    p: CommonProps & { spec: ViewSpec },
  ) => ReactNode;
  return render({ ...common, spec });
}

function CardShell({
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
    </CardShell>
  );
}
